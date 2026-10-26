import { inlineTransport } from './inline-transport';
import type { ComputeOps, ProgressFn, Reply, Request } from './protocol';
import type { SplatExtents } from '../candidates/extent';
import type { Events } from '../events';

type RunOptions = { signal?: AbortSignal, onProgress?: ProgressFn, lane?: 'preview' };

type Cloud = { points: Float32Array, extents?: SplatExtents };

type SceneCompute = {
    // version for this points array (by identity), sending it on first use
    pointsVersion(cloud: Cloud): number,
    run<K extends keyof ComputeOps>(op: K, args: ComputeOps[K]['args'], opts?: RunOptions): Promise<ComputeOps[K]['result']>
};

// interruptible: restart() stops the work in progress, which is then lost
type Transport = {
    send(req: Request): void,
    onReply(cb: (reply: Reply) => void): void,
    onFailure(cb: (error: Error) => void): void,
    restart(): void,
    readonly interruptible: boolean
};

type Pending = {
    req: Request,
    preview: boolean,
    onProgress?: ProgressFn,
    resolve: (result: unknown) => void,
    reject: (error: Error) => void
};

const abortError = (message: 'cancelled' | 'superseded') => new DOMException(message, 'AbortError');

// whether error is the rejection of a cancelled or superseded run
const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

// promise, or a cancelled rejection once signal aborts; the work behind
// promise goes on either way
const untilAborted = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError('cancelled'));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError('cancelled'));
        signal.addEventListener('abort', onAbort);
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
};

// The main-thread side of scene compute. Requests go to the first transport
// that starts; when it fails, the next one takes over every pending request.
// The handler keeps only the latest points, so the client remembers them
// and sends them again to a fresh or restarted transport.
// Preview requests share one lane: one on the transport and one queued, a
// newer one superseding the queued. Aborting a preview never restarts the
// transport, so work it already started (a slow occupancy build) still
// finishes and stays cached.
class SceneComputeClient implements SceneCompute {
    private transports: (() => Transport)[];

    private next = 0;

    private transport: Transport | null = null;

    private warned = false;

    private lastId = 0;

    private lastVersion = 0;

    private versions = new WeakMap<Float32Array, number>();

    private scene: { version: number, cloud: Cloud } | null = null;

    // requests on the transport whose caller still waits, in id order
    private pending = new Map<number, Pending>();

    // the preview on the transport, whether or not its caller still waits
    private previewSent: number | null = null;

    private previewQueued: Pending | null = null;

    constructor(transports: (() => Transport)[]) {
        this.transports = transports;
    }

    pointsVersion({ points, extents }: Cloud) {
        let version = this.versions.get(points);
        if (version === undefined) {
            version = ++this.lastVersion;
            this.versions.set(points, version);
        }
        if (this.scene?.version !== version) {
            this.scene = { version, cloud: { points, extents } };
            this.current().send(this.pointsRequest());
        }
        return version;
    }

    run<K extends keyof ComputeOps>(op: K, args: ComputeOps[K]['args'], opts: RunOptions = {}) {
        const { signal, onProgress, lane } = opts;
        return new Promise<ComputeOps[K]['result']>((resolve, reject) => {
            if (signal?.aborted) {
                reject(abortError('cancelled'));
                return;
            }
            const p = { req: { id: ++this.lastId, op, args }, preview: lane === 'preview', onProgress } as Pending;
            const onAbort = () => this.cancel(p);
            p.resolve = (result) => {
                signal?.removeEventListener('abort', onAbort);
                resolve(result as ComputeOps[K]['result']);
            };
            p.reject = (error) => {
                signal?.removeEventListener('abort', onAbort);
                reject(error);
            };
            signal?.addEventListener('abort', onAbort);
            if (p.preview && this.previewSent !== null) {
                this.previewQueued?.reject(abortError('superseded'));
                this.previewQueued = p;
            } else {
                this.dispatch(p);
            }
        });
    }

    // the current transport, starting the next one that constructs
    private current(): Transport {
        while (!this.transport) {
            const factory = this.transports[this.next++];
            if (!factory) throw new Error('no scene compute transport could start');
            this.start(factory);
        }
        return this.transport;
    }

    private start(factory: () => Transport) {
        try {
            const t = factory();
            t.onReply(reply => t === this.transport && this.settle(reply));
            t.onFailure(error => t === this.transport && this.fail(error));
            this.transport = t;
        } catch (error) {
            this.warnOnce(error);
        }
    }

    private fail(error: Error) {
        this.warnOnce(error);
        this.transport = null;
        try {
            this.current();
            this.resume();
        } catch (lastError) {
            this.rejectAll(lastError);
        }
    }

    private warnOnce(error: Error) {
        if (this.warned) return;
        this.warned = true;
        console.warn(`scene compute: ${error.message}; using the fallback`);
    }

    private pointsRequest(): Request {
        const { version, cloud: { points, extents } } = this.scene;
        return { id: ++this.lastId, op: 'points', args: { version, points, extents } };
    }

    // the transport lost its work: free the preview slot if nobody waits on
    // it, send the points and every pending request again, then the queue
    private resume() {
        if (this.previewSent !== null && !this.pending.has(this.previewSent)) this.previewSent = null;
        if (this.scene) this.transport.send(this.pointsRequest());
        this.pending.forEach(p => this.transport.send(p.req));
        this.pump();
    }

    private rejectAll(error: Error) {
        const all = [...this.pending.values(), this.previewQueued].filter(Boolean);
        this.pending.clear();
        this.previewSent = null;
        this.previewQueued = null;
        all.forEach(p => p.reject(error));
    }

    private dispatch(p: Pending) {
        this.pending.set(p.req.id, p);
        if (p.preview) this.previewSent = p.req.id;
        this.current().send(p.req);
    }

    private pump() {
        if (this.previewSent !== null || !this.previewQueued) return;
        const p = this.previewQueued;
        this.previewQueued = null;
        this.dispatch(p);
    }

    private settle(reply: Reply) {
        const p = this.pending.get(reply.id);
        if ('progress' in reply) {
            const { stage, done, total } = reply.progress;
            p?.onProgress?.(stage, done, total);
            return;
        }
        if (reply.id === this.previewSent) this.previewSent = null;
        if (p) {
            this.pending.delete(reply.id);
            if ('error' in reply) p.reject(new Error(reply.error));
            else p.resolve(reply.result);
        }
        this.pump();
    }

    private cancel(p: Pending) {
        if (this.previewQueued === p) {
            this.previewQueued = null;
        } else if (!this.pending.delete(p.req.id)) {
            return;
        }
        p.reject(abortError('cancelled'));
        if (!p.preview && this.transport?.interruptible) this.restart();
    }

    private restart() {
        this.transport.restart();
        this.resume();
    }
}

const createSceneCompute = (transports: (() => Transport)[]): SceneCompute => new SceneComputeClient(transports);

// the compute registered on events, else an inline one registered now
const computeOf = (events: Events): SceneCompute => {
    if (!events.functions.has('compute')) {
        const compute = createSceneCompute([() => inlineTransport()]);
        events.function('compute', () => compute);
    }
    return events.invoke('compute');
};

export { computeOf, createSceneCompute, isAbortError, untilAborted };
export type { RunOptions, SceneCompute, Transport };
