import type { Reply, Request } from './protocol';
import type { Transport } from './scene-compute';

// Runs the handler in a module worker. restart terminates the worker, which
// stops a running job, and starts a fresh one without caches. An error event
// (the script failed to load or threw outside a job) or a failed restart
// ends the transport and reports the failure.
const workerTransport = (url: URL, WorkerCtor: typeof Worker = Worker): Transport => {
    let replyTo: (reply: Reply) => void = () => {};
    let failTo: (error: Error) => void = () => {};
    let worker: Worker | null = null;

    const stop = () => {
        worker?.terminate();
        worker = null;
    };

    const start = () => {
        const w = new WorkerCtor(url, { type: 'module' });
        w.addEventListener('message', (event: MessageEvent<Reply>) => {
            if (w === worker) replyTo(event.data);
        });
        w.addEventListener('error', (event: Event) => {
            if (w !== worker) return;
            stop();
            failTo(new Error((event as ErrorEvent).message || 'the scene compute worker failed'));
        });
        worker = w;
    };

    start();

    return {
        interruptible: true,
        send: (req: Request) => worker?.postMessage(req),
        onReply: (cb) => {
            replyTo = cb;
        },
        onFailure: (cb) => {
            failTo = cb;
        },
        restart: () => {
            stop();
            try {
                start();
            } catch (error) {
                // the caller is still inside restart; report once it returns
                setTimeout(() => failTo(error), 0);
            }
        }
    };
};

export { workerTransport };
