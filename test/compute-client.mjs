import assert from 'node:assert/strict';

import { createComputeHandler } from './.build/src/compute/handler.js';
import { inlineTransport } from './.build/src/compute/inline-transport.js';
import { createSceneCompute } from './.build/src/compute/scene-compute.js';
import { workerTransport } from './.build/src/compute/worker-transport.js';
import { BAND, fixRequest } from './compute-handler.mjs';
import { BOX, EYE, FAR, SPEC } from './orbit-events.mjs';

const URL_ = new URL('file:///scene-compute-worker.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// A Worker stand-in that runs the compute handler on setTimeout(0) with
// structured-cloned messages. log counts constructions and terminations,
// and records the ops each live worker ran; fail() makes a worker emit error.
const fakeWorkers = () => {
    const log = { created: 0, terminated: 0, ops: [], workers: [] };
    class FakeWorker {
        constructor() {
            log.created++;
            log.workers.push(this);
            this.listeners = { message: [], error: [] };
            this.handle = createComputeHandler();
            this.dead = false;
        }

        addEventListener(type, fn) {
            this.listeners[type]?.push(fn);
        }

        emit(type, event) {
            this.listeners[type].forEach(fn => fn(event));
        }

        postMessage(data) {
            const req = structuredClone(data);
            setTimeout(() => {
                if (this.dead) return;
                log.ops.push(req.op);
                this.handle(req, reply => this.emit('message', { data: structuredClone(reply) }));
            }, 0);
        }

        terminate() {
            this.dead = true;
            log.terminated++;
        }

        fail() {
            this.dead = true;
            this.emit('error', { message: 'worker failed to load' });
        }
    }
    return { FakeWorker, log };
};

const bandCloud = () => ({ points: BAND.points, extents: undefined });

const isAbort = message => error => error instanceof DOMException && error.name === 'AbortError' && error.message === message;

// the replies of one request sent straight to a fresh handler
const direct = (cloud, op, args) => {
    const handle = createComputeHandler();
    const replies = [];
    handle({ id: 1, op: 'points', args: { version: args.version, ...cloud } }, () => {});
    handle(structuredClone({ id: 2, op, args }), reply => replies.push(structuredClone(reply)));
    return replies;
};
const directResult = (cloud, op, args) => direct(cloud, op, args).find(r => 'result' in r).result;

// stage names in order, each run of one stage once
const stagesOf = progress => progress.map(p => p.stage).filter((s, i, all) => i === 0 || s !== all[i - 1]);

// counts console.warn calls while fn runs
const counting = async (fn) => {
    const warn = console.warn;
    let warns = 0;
    console.warn = () => warns++;
    try {
        await fn();
    } finally {
        console.warn = warn;
    }
    return warns;
};

const computeClientChecks = {
    async 'client: run resolves with the handler result and forwards progress'() {
        const { FakeWorker } = fakeWorkers();
        const compute = createSceneCompute([() => workerTransport(URL_, FakeWorker)]);
        const version = compute.pointsVersion(bandCloud());
        const progress = [];
        const onProgress = (stage, done, total) => progress.push({ stage, done, total });
        const reply = await compute.run('fixPlan', fixRequest(version), { onProgress });

        const expected = direct(bandCloud(), 'fixPlan', fixRequest(version));
        const untimed = ({ times, ...plan }) => plan;
        assert.deepEqual(untimed(reply), untimed(expected.find(r => 'result' in r).result));
        assert.deepEqual(stagesOf(progress), stagesOf(expected.filter(r => 'progress' in r).map(r => r.progress)));
        assert.ok(progress.some(p => p.stage === 'routes' && p.done === p.total && p.total > 0), 'routes reach their total');
    },

    async 'client: abort restarts the worker, re-sends points and the other pending request'() {
        const { FakeWorker, log } = fakeWorkers();
        const compute = createSceneCompute([() => workerTransport(URL_, FakeWorker)]);
        const version = compute.pointsVersion(bandCloud());
        const estimate = compute.run('estimate', { version });
        const abort = new AbortController();
        const fix = compute.run('fixPlan', fixRequest(version), { signal: abort.signal });
        abort.abort();

        await assert.rejects(fix, isAbort('cancelled'));
        assert.deepEqual(await estimate, directResult(bandCloud(), 'estimate', { version }));
        assert.equal(log.terminated, 1);
        assert.equal(log.created, 2);
        assert.deepEqual(log.ops, ['points', 'estimate'], 'the fresh worker got the points and the estimate only');
    },

    async 'client: preview lane keeps only the newest request and never terminates'() {
        const { FakeWorker, log } = fakeWorkers();
        const compute = createSceneCompute([() => workerTransport(URL_, FakeWorker)]);
        const cloud = { points: new Float32Array(FAR), extents: undefined };
        const version = compute.pointsVersion(cloud);
        const request = radius => ({ version, box: BOX, eyeHeight: EYE, spec: { ...SPEC, radius } });
        const runs = [1, 2, 3, 4, 5].map(radius => compute.run('orbitPlan', request(radius), { lane: 'preview' }));
        const settled = await Promise.allSettled(runs);

        assert.equal(log.ops.filter(op => op === 'orbitPlan').length, 2, `ops ${log.ops}`);
        assert.deepEqual(settled.map(s => s.status), ['fulfilled', 'rejected', 'rejected', 'rejected', 'fulfilled']);
        settled.slice(1, 4).forEach(s => assert.ok(isAbort('superseded')(s.reason), String(s.reason)));
        assert.deepEqual(settled[0].value, directResult(cloud, 'orbitPlan', request(1)));
        assert.deepEqual(settled[4].value, directResult(cloud, 'orbitPlan', request(5)));

        const abort = new AbortController();
        const aborted = compute.run('orbitPlan', request(6), { lane: 'preview', signal: abort.signal });
        abort.abort();
        await assert.rejects(aborted, isAbort('cancelled'));
        assert.deepEqual(await compute.run('orbitPlan', request(7), { lane: 'preview' }), directResult(cloud, 'orbitPlan', request(7)));
        assert.equal(log.terminated, 0);
    },

    async 'client: a worker error falls back to inline and warns once'() {
        const { FakeWorker, log } = fakeWorkers();
        const expected = directResult(bandCloud(), 'estimate', { version: 1 });
        const warns = await counting(async () => {
            const compute = createSceneCompute([() => workerTransport(URL_, FakeWorker), () => inlineTransport()]);
            const version = compute.pointsVersion(bandCloud());
            const estimate = compute.run('estimate', { version });
            log.workers[0].fail();
            assert.deepEqual(await estimate, expected);
            assert.deepEqual(await compute.run('estimate', { version }), expected);
        });
        assert.equal(warns, 1);
        assert.deepEqual(log.ops, [], 'the failed worker ran nothing');
    },

    async 'client: a worker that cannot be constructed falls back to inline'() {
        class Blocked {
            constructor() {
                throw new Error('blocked');
            }
        }
        const warns = await counting(async () => {
            const compute = createSceneCompute([() => workerTransport(URL_, Blocked), () => inlineTransport()]);
            const version = compute.pointsVersion(bandCloud());
            assert.deepEqual(await compute.run('estimate', { version }), directResult(bandCloud(), 'estimate', { version }));
        });
        assert.equal(warns, 1);
    },

    async 'client: the same points array keeps its version; a new array gets a new one'() {
        const compute = createSceneCompute([() => inlineTransport()]);
        const a = { points: new Float32Array([0, 0, 0, 1, 1, 1]), extents: undefined };
        const b = { points: new Float32Array([0, 0, 0, 1, 1, 1]), extents: undefined };
        const va = compute.pointsVersion(a);
        assert.equal(compute.pointsVersion(a), va);
        const vb = compute.pointsVersion(b);
        assert.notEqual(vb, va);
        assert.equal(compute.pointsVersion({ ...a }), va, 'identity of the points array, not the cloud object');
        // a returns to the handler, which kept only b
        assert.equal((await compute.run('estimate', { version: va })).points, 2);
        await assert.rejects(compute.run('estimate', { version: vb }), /unknown points version/);
    },

    async 'client: inline abort drops the late result'() {
        const order = [];
        const handle = createComputeHandler();
        const handler = (req, post) => {
            order.push(`handled ${req.op}`);
            handle(req, post);
        };
        const uncaught = [];
        const onUncaught = error => uncaught.push(error);
        process.on('uncaughtException', onUncaught);
        try {
            const compute = createSceneCompute([() => inlineTransport(handler)]);
            const version = compute.pointsVersion(bandCloud());
            const abort = new AbortController();
            const run = compute.run('estimate', { version }, { signal: abort.signal });
            const settled = run.then(() => order.push('resolved'), (error) => {
                order.push('rejected');
                assert.ok(isAbort('cancelled')(error), String(error));
            });
            abort.abort();
            await tick();
            await tick();
            await settled;
            assert.deepEqual(order, ['rejected', 'handled points', 'handled estimate']);
            assert.equal((await compute.run('estimate', { version })).points, BAND.points.length / 3);
        } finally {
            process.off('uncaughtException', onUncaught);
        }
        assert.deepEqual(uncaught, []);
    }
};

export { computeClientChecks };
