import { createComputeHandler } from './handler';
import type { Reply, Request } from './protocol';
import type { Transport } from './scene-compute';

// Runs the handler on the main thread, one request per task. Messages are
// structured-cloned both ways, as postMessage would. A request in progress
// cannot be stopped, so restart does nothing.
const inlineTransport = (handler = createComputeHandler()): Transport => {
    let replyTo: (reply: Reply) => void = () => {};
    return {
        interruptible: false,
        send: (req: Request) => {
            const message = structuredClone(req);
            setTimeout(() => handler(message, reply => replyTo(structuredClone(reply))), 0);
        },
        onReply: (cb) => {
            replyTo = cb;
        },
        onFailure: () => {},
        restart: () => {}
    };
};

export { inlineTransport };
