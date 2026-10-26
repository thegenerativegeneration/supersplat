import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { createThumbnailQueue } from './.build/src/key-thumbnails.js';

const pose = (id, x, { frame = 0, fov = 60 } = {}) => ({
    id, name: id, frame, position: new Vec3(x, 1, 0), target: new Vec3(x, 1, -1), fov
});

// a queue on a fake clock; render resolves at once unless `held`, and
// answers null (stepped aside) while `yielding`
const harness = () => {
    const state = { t: 1000, busy: false, yielding: false, renders: [], tiles: [] };
    const queue = createThumbnailQueue({
        now: () => state.t,
        busy: () => state.busy,
        render: async (p, ready) => {
            state.renders.push(p.id);
            if (state.yielding || !ready()) return null;
            return { id: p.id, x: p.position.x };
        },
        onTile: (id, canvas) => state.tiles.push([id, canvas.x])
    });
    return { state, queue };
};

// ticks the queue n times, one per frame
const frames = async (queue, n) => {
    for (let i = 0; i < n; i++) await queue.tick();
};

const keyThumbnailsChecks = {
    async 'thumbs: nothing renders within 500 ms of input'() {
        const { state, queue } = harness();
        queue.invalidate([pose('a', 0)]);
        queue.input();
        state.t += 499;
        await frames(queue, 3);
        assert.deepEqual(state.renders, []);
        state.t += 1;
        await frames(queue, 1);
        assert.deepEqual(state.tiles, [['a', 0]]);
    },

    async 'thumbs: one tile per tick, newest edit first'() {
        const { state, queue } = harness();
        const keys = [pose('a', 0), pose('b', 1), pose('c', 2)];
        queue.invalidate(keys);
        await frames(queue, 1);
        assert.deepEqual(state.tiles, [['a', 0]]);
        // c is edited while b and c wait: c goes first
        keys[2] = pose('c', 5);
        queue.invalidate(keys);
        await frames(queue, 1);
        assert.deepEqual(state.tiles, [['a', 0], ['c', 5]]);
        await frames(queue, 3);
        assert.deepEqual(state.tiles, [['a', 0], ['c', 5], ['b', 1]]);
        assert.equal(state.renders.length, 3);
    },

    async 'thumbs: busy stops rendering'() {
        const { state, queue } = harness();
        queue.invalidate([pose('a', 0), pose('b', 1)]);
        state.busy = true;
        await frames(queue, 5);
        assert.deepEqual(state.renders, []);
        state.busy = false;
        await frames(queue, 1);
        assert.deepEqual(state.renders, ['a']);
    },

    async 'thumbs: a key re-renders only when its view changes'() {
        const { state, queue } = harness();
        queue.invalidate([pose('a', 0, { frame: 0 })]);
        await frames(queue, 2);
        // retimed: same view
        queue.invalidate([pose('a', 0, { frame: 30 })]);
        await frames(queue, 2);
        assert.deepEqual(state.renders, ['a']);
        queue.invalidate([pose('a', 0, { fov: 40 })]);
        await frames(queue, 2);
        queue.invalidate([pose('a', 3, { fov: 40 })]);
        await frames(queue, 2);
        assert.deepEqual(state.tiles, [['a', 0], ['a', 0], ['a', 3]]);
        // undone back to a view the tile already shows while queued: dropped
        queue.invalidate([pose('a', 4, { fov: 40 })]);
        queue.invalidate([pose('a', 3, { fov: 40 })]);
        await frames(queue, 2);
        assert.equal(state.renders.length, 3);
    },

    async 'thumbs: removed keys drop out of the queue'() {
        const { state, queue } = harness();
        queue.invalidate([pose('a', 0), pose('b', 1), pose('c', 2)]);
        queue.invalidate([pose('a', 0), pose('c', 2)]);
        await frames(queue, 4);
        assert.deepEqual(state.renders, ['a', 'c']);
        // a key that comes back renders again
        queue.invalidate([pose('a', 0), pose('b', 1), pose('c', 2)]);
        await frames(queue, 2);
        assert.deepEqual(state.renders, ['a', 'c', 'b']);
    },

    async 'thumbs: input between two tiles stops the queue before the next render'() {
        const { state, queue } = harness();
        queue.invalidate([pose('a', 0), pose('b', 1)]);
        await frames(queue, 1);
        queue.input();
        await frames(queue, 3);
        assert.deepEqual(state.renders, ['a']);
        state.t += 500;
        await frames(queue, 1);
        assert.deepEqual(state.renders, ['a', 'b']);
    },

    async 'thumbs: a capture that steps aside keeps its key first in line'() {
        const { state, queue } = harness();
        queue.invalidate([pose('a', 0), pose('b', 1)]);
        state.yielding = true;
        await frames(queue, 2);
        assert.deepEqual(state.tiles, []);
        state.yielding = false;
        await frames(queue, 1);
        assert.deepEqual(state.tiles, [['a', 0]]);
    },

    async 'thumbs: a tile whose key changed while it rendered is dropped and rendered again'() {
        let release;
        const tiles = [];
        let current = [pose('a', 0)];
        const queue = createThumbnailQueue({
            now: () => 1000,
            busy: () => false,
            render: p => new Promise((resolve) => {
                release = () => resolve({ x: p.position.x });
            }),
            onTile: (id, canvas) => tiles.push([id, canvas.x])
        });
        queue.invalidate(current);
        const first = queue.tick();
        // one tile at a time: a tick while rendering starts nothing
        await queue.tick();
        current = [pose('a', 7)];
        queue.invalidate(current);
        release();
        await first;
        assert.deepEqual(tiles, []);
        const second = queue.tick();
        release();
        await second;
        assert.deepEqual(tiles, [['a', 7]]);
    },

    async 'thumbs: forget renders every key again'() {
        const { state, queue } = harness();
        const keys = [pose('a', 0), pose('b', 1)];
        queue.invalidate(keys);
        await frames(queue, 2);
        queue.forget();
        queue.invalidate(keys);
        await frames(queue, 2);
        assert.deepEqual(state.renders, ['a', 'b', 'a', 'b']);
    }
};

export { keyThumbnailsChecks };
