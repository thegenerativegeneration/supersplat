import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { buildCameraCurve } from './.build/src/anim/camera-curve.js';
import { poseColors, samplePathLine } from './.build/src/path-line.js';
import { AUTO_KEY_COLOR, BLOCKED_COLOR } from './.build/src/path/colors.js';

const keys = [0, 40, 80].map(x => ({ position: new Vec3(x, 1, 0), target: new Vec3(x, 1, -1), fov: 60 }));
const frames = [0, 40, 80];
const curve = buildCameraCurve(keys, frames, { duration: 120, smoothness: 1, loop: false });
const base = { samplesPerSegment: 8, blocked: [], auto: [false, false, false] };
const colorAt = (colors, v) => colors.slice(v * 3, v * 3 + 3);

const pathLineChecks = {
    'path: line follows the curve': async () => {
        const { positions, colors } = samplePathLine(curve, frames, base);
        assert.equal(positions.length / 6, 16);
        assert.equal(colors.length, positions.length);
        // keys sit on the x axis at their frame, y stays 1
        assert.deepEqual(positions.slice(0, 3), [0, 1, 0]);
        assert.ok(Math.abs(positions[positions.length - 3] - 80) < 1e-6);
        for (let v = 0; v < positions.length / 3; v++) assert.ok(Math.abs(positions[v * 3 + 1] - 1) < 1e-6);
        // consecutive lines share their joint
        assert.deepEqual(positions.slice(3, 6), positions.slice(6, 9));
    },

    'path: blocked segment is red': async () => {
        const { colors } = samplePathLine(curve, frames, { ...base, blocked: [40] });
        assert.deepEqual(colorAt(colors, 0), [0, 1, 1]);
        assert.deepEqual(colorAt(colors, 16), [...BLOCKED_COLOR]);
        assert.deepEqual(colorAt(colors, 31), [...BLOCKED_COLOR]);
    },

    'path: segments touching an auto key are auto coloured': async () => {
        const { colors } = samplePathLine(curve, frames, { ...base, auto: [false, true, false] });
        assert.deepEqual(colorAt(colors, 0), [...AUTO_KEY_COLOR]);
        assert.deepEqual(colorAt(colors, 16), [...AUTO_KEY_COLOR]);
    },

    'path: a blocked segment stays red through its detour keys': async () => {
        const { colors } = samplePathLine(curve, frames, { ...base, auto: [false, true, false], blocked: [0] });
        assert.deepEqual(colorAt(colors, 0), [...BLOCKED_COLOR]);
        assert.deepEqual(colorAt(colors, 31), [...BLOCKED_COLOR]);
        // with looping, the closing segment's detours stay red up to the first key
        const looped = buildCameraCurve(keys, frames, { duration: 120, smoothness: 1, loop: true });
        const wrap = samplePathLine(looped, frames, { ...base, auto: [false, false, true], blocked: [40], loop: true, duration: 120 });
        assert.deepEqual(colorAt(wrap.colors, 0), [0, 1, 1]);
        assert.deepEqual(colorAt(wrap.colors, 16), [...BLOCKED_COLOR]);
        assert.deepEqual(colorAt(wrap.colors, 47), [...BLOCKED_COLOR]);
    },

    'path: frustums show unreachable keys red and detour keys in the auto colour': async () => {
        const colors = poseColors([{ name: 'a' }, { name: 'b', auto: true }, { name: 'c' }], ['c']);
        assert.deepEqual(colors, [[0, 1, 1], AUTO_KEY_COLOR, BLOCKED_COLOR]);
    },

    'path: frustums show parked keys after the shot red': async () => {
        const colors = poseColors([{ name: 'a', frame: 0 }, { name: 'b', frame: 200, parked: true }, { name: 'c', frame: 50, parked: true }], [], 181);
        assert.deepEqual(colors, [[0, 1, 1], BLOCKED_COLOR, [0, 1, 1]]);
    },

    'path: loop adds the closing segment': async () => {
        const looped = buildCameraCurve(keys, frames, { duration: 120, smoothness: 1, loop: true });
        const { positions } = samplePathLine(looped, frames, { ...base, loop: true, duration: 120 });
        assert.equal(positions.length / 6, 24);
    },

    'path: fewer than two keys give no lines': async () => {
        const { positions } = samplePathLine(curve, [0], { ...base, auto: [false] });
        assert.equal(positions.length, 0);
    }
};

export { pathLineChecks };
