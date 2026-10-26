import { createComputeHandler } from './handler';

const handle = createComputeHandler();
self.onmessage = e => handle(e.data, r => self.postMessage(r));
