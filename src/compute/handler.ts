import { runFixPlan } from './fix-path-job';
import { orbitCheck, orbitOccupancy, orbitPlan } from './orbit-job';
import type { ComputeOps, Estimate, ProgressFn, Reply, Request, Stage } from './protocol';
import { balanceTiming } from '../anim/balance-timing';
import { estimateEyeHeight, estimateTiltDeg, proposeBox } from '../candidates/estimate';
import type { SplatExtents } from '../candidates/extent';

type Scene = { version: number, points: Float32Array, extents?: SplatExtents, estimate?: Estimate };

type Progress = { stage: Stage, done?: number, total?: number };

type Job<K extends keyof ComputeOps> = (args: ComputeOps[K]['args'], onProgress: ProgressFn) => ComputeOps[K]['result'];

// shortest time between two progress posts of one request
const PROGRESS_MS = 50;

const estimateOf = (points: Float32Array): Estimate => {
    const box = proposeBox(points);
    return { box, eyeHeight: estimateEyeHeight(points, box), tiltDeg: estimateTiltDeg(points), points: points.length / 3 };
};

// Progress posts at most every PROGRESS_MS, except that the first and the
// last post of each stage always go out: a post held back is sent when the
// stage changes or on flush, and a post with done === total goes out at once.
const throttled = (post: (progress: Progress) => void) => {
    let stage: Stage | null = null;
    let sentAt = -Infinity;
    let held: Progress | null = null;
    const send = (progress: Progress) => {
        held = null;
        sentAt = performance.now();
        post(progress);
    };
    const onProgress: ProgressFn = (next, done, total) => {
        const progress: Progress = { stage: next };
        if (done !== undefined) progress.done = done;
        if (total !== undefined) progress.total = total;
        if (next !== stage) {
            if (held) send(held);
            stage = next;
            send(progress);
        } else if ((total !== undefined && done === total) || performance.now() - sentAt >= PROGRESS_MS) {
            send(progress);
        } else {
            held = progress;
        }
    };
    const flush = () => held && send(held);
    return { onProgress, flush };
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)) || 'compute job failed';

// Runs scene compute requests synchronously and posts their replies. It keeps
// the points of the latest points request; the other requests name the
// version they were made for. Estimate and Balance post no progress (one
// stage each); the orbit jobs post grid when they build the occupancy.
const createComputeHandler = () => {
    let scene: Scene | null = null;

    const sceneOf = (version: number) => {
        if (scene?.version !== version) throw new Error(`unknown points version ${version}`);
        return scene;
    };

    const jobs: { [K in keyof ComputeOps]: Job<K> } = {
        estimate: ({ version }) => {
            const s = sceneOf(version);
            s.estimate ??= estimateOf(s.points);
            return s.estimate;
        },
        fixPlan: (req, onProgress) => {
            const s = sceneOf(req.version);
            return runFixPlan(s.points, s.extents, req, onProgress);
        },
        orbitPlan: (req, onProgress) => {
            const s = sceneOf(req.version);
            const occ = orbitOccupancy(s.points, s.extents, req.box, req.eyeHeight, onProgress);
            onProgress('orbit');
            return orbitPlan(occ, req.box, req.spec);
        },
        orbitCheck: (req, onProgress) => {
            const s = sceneOf(req.version);
            const occ = orbitOccupancy(s.points, s.extents, req.box, req.eyeHeight, onProgress);
            onProgress('checking');
            return orbitCheck(occ, req);
        },
        balance: input => balanceTiming(input)
    };

    return (req: Request, post: (reply: Reply) => void) => {
        const { id } = req;
        try {
            if (req.op === 'points') {
                const { version, points, extents } = req.args;
                scene = { version, points, extents };
                post({ id, result: null });
                return;
            }
            if (!Object.hasOwn(jobs, req.op)) throw new Error(`unknown compute op ${String(req.op)}`);
            const job = jobs[req.op] as Job<keyof ComputeOps>;
            const { onProgress, flush } = throttled(progress => post({ id, progress }));
            const result = job(req.args as never, onProgress);
            flush();
            post({ id, result });
        } catch (error) {
            post({ id, error: messageOf(error) });
        }
    };
};

export { createComputeHandler };
