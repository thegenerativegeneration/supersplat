import assert from 'node:assert/strict';

import { balanceTiming } from './.build/src/anim/balance-timing.js';
import { loopModeMatchesTimeline } from './.build/src/anim/loop-mode.js';

const key = (px, py, pz, tx, ty, tz, { fov = 60, linger = 0, distance = 1 } = {}) => ({
    position: { x: px, y: py, z: pz },
    target: { x: tx, y: ty, z: tz },
    fov,
    linger,
    distance
});

// a key at x looking along -z
const at = (x, opts, z = 0) => key(x, 0, z, x, 0, z - 1, opts);

const run = (keys, overrides = {}) => balanceTiming({
    keys,
    frames: 181,
    frameRate: 30,
    smoothness: 1,
    loop: false,
    rotationWeight: 1,
    ...overrides
});

const near = (actual, expected, tol) => {
    assert.equal(actual.length, expected.length, `length ${actual.length} vs ${expected.length}`);
    actual.forEach((a, i) => {
        assert.ok(Math.abs(a - expected[i]) <= tol, `[${i}] ${a} vs ${expected[i]} (tol ${tol}): ${actual}`);
    });
};

const strictlyIncreasing = (frames) => {
    for (let i = 1; i < frames.length; i++) {
        assert.ok(frames[i] > frames[i - 1], `not increasing: ${frames}`);
    }
};

const balanceTimingChecks = {
    async 'balance: straight evenly spaced path is uniform'() {
        const result = run([0, 1, 2, 3, 4].map(x => at(x)));
        assert.equal(result.ok, true);
        assert.deepEqual(result.frames, [0, 45, 90, 135, 180]);
    },

    async 'balance: uneven spacing gets proportional time'() {
        const result = run([0, 1, 3].map(x => at(x)), { smoothness: 0 });
        assert.equal(result.ok, true);
        near(result.frames, [0, 60, 180], 1);
    },

    async 'balance: rotation-only segment balances against translation'() {
        const result = run([
            key(0, 0, 0, 0, 0, -1),
            key(0, 0, 0, 1, 0, 0),
            key(Math.PI / 2, 0, 0, 1 + Math.PI / 2, 0, 0)
        ], { smoothness: 0 });
        assert.equal(result.ok, true);
        near([result.frames[1]], [90], 3);
    },

    async 'balance: closer geometry gets more time'() {
        const result = run([
            at(0, { distance: 1 }),
            at(1, { distance: 1 }),
            at(2, { distance: 4 })
        ], { smoothness: 0 });
        assert.equal(result.ok, true);
        near([result.frames[1]], [117], 2);
    },

    async 'balance: middle linger adds to both neighbours'() {
        const result = run([at(0), at(1, { linger: 1 }), at(2), at(3)]);
        assert.equal(result.ok, true);
        near(result.frames, [0, 65, 130, 180], 1);
    },

    async 'balance: end lingers become holds with loop off'() {
        const result = run([at(0, { linger: 1 }), at(1), at(2, { linger: 0.5 })]);
        assert.equal(result.ok, true);
        assert.equal(result.frames[0], 30);
        assert.equal(result.frames[2], 165);
        near([result.frames[1]], [97.5], 1);
    },

    async 'balance: loop wraps last to first'() {
        const result = run([
            at(0, {}, 0),
            at(1, {}, 0),
            at(1, {}, 1),
            at(0, {}, 1)
        ], { loop: true, frames: 200 });
        assert.equal(result.ok, true);
        near(result.frames, [0, 50, 100, 150], 1);
    },

    async 'balance: loop with a linger'() {
        // 200 frames, key 1 lingers 30 frames: 170 left, 42.5 per segment, and
        // key 1's 30 frames split 15/15 onto segments 0 and 1 -> 57.5, 57.5, 42.5, 42.5
        const result = run([
            at(0, {}, 0),
            at(1, { linger: 1 }, 0),
            at(1, {}, 1),
            at(0, {}, 1)
        ], { loop: true, frames: 200 });
        assert.equal(result.ok, true);
        near(result.frames, [0, 58, 115, 158], 2);
    },

    async 'balance: loop with two keys'() {
        const result = run([at(0), at(1)], { loop: true, frames: 200 });
        assert.equal(result.ok, true);
        assert.deepEqual(result.frames, [0, 100]);
    },

    async 'balance: zero-cost keys still get frames'() {
        const result = run([at(0), at(0), at(0)]);
        assert.equal(result.ok, true);
        assert.deepEqual(result.frames, [0, 90, 180]);
    },

    async 'balance: non-finite distances are clamped'() {
        const result = run([
            at(0, { distance: 0 }),
            at(1, { distance: NaN }),
            at(2, { distance: Infinity })
        ]);
        assert.equal(result.ok, true);
        assert.ok(result.frames.every(Number.isInteger));
        strictlyIncreasing(result.frames);
        assert.equal(result.frames[2], 180);
    },

    async 'balance: tight timeline keeps keys distinct'() {
        const result = run(Array.from({ length: 10 }, (_, x) => at(x)), { frames: 12 });
        assert.equal(result.ok, true);
        strictlyIncreasing(result.frames);
        assert.equal(result.frames[0], 0);
        assert.equal(result.frames[9], 11);
    },

    async 'balance: too few frames is refused'() {
        const result = run(Array.from({ length: 10 }, (_, x) => at(x)), { frames: 5 });
        assert.deepEqual(result, { ok: false, reason: 'tooFewFrames' });
    },

    async 'balance: linger too long is refused'() {
        const result = run([at(0), at(1, { linger: 10 }), at(2)]);
        assert.deepEqual(result, { ok: false, reason: 'lingerTooLong' });
    },

    async 'balance: fewer than two keys is refused'() {
        const result = run([at(0)]);
        assert.deepEqual(result, { ok: false, reason: 'tooFewKeys' });
    },

    async 'balance: converges and is deterministic'() {
        const keys = [0, 1, 2, 3, 4].map((x, i) => at(x, {}, i % 2 ? 2 : 0));
        const a = run(keys);
        const b = run(keys);
        assert.deepEqual(a, b);
        assert.equal(a.ok, true);
        strictlyIncreasing(a.frames);
    },

    async 'loop: mode matching'() {
        assert.equal(loopModeMatchesTimeline('repeat', true), true);
        assert.equal(loopModeMatchesTimeline('none', false), true);
        assert.equal(loopModeMatchesTimeline('pingpong', false), true);
        assert.equal(loopModeMatchesTimeline('repeat', false), false);
        assert.equal(loopModeMatchesTimeline('none', true), false);
        assert.equal(loopModeMatchesTimeline('pingpong', true), false);
    }
};

export { balanceTimingChecks };
