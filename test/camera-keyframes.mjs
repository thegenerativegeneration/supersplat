import assert from 'node:assert/strict';

import { buildCameraCurve } from './.build/src/anim/camera-curve.js';
import { cameraKeyframes } from './.build/src/camera-keyframes.js';
import { CubicSpline } from './.build/src/anim/spline.js';

const v3 = (x, y, z) => ({ x, y, z });
const pose = (frame, p, t, extra = {}) => ({ id: `k${frame}`, name: `k${frame}`, frame, position: v3(...p), target: v3(...t), ...extra });

const poses = [
    pose(0, [0, 1, 0], [5, 1, 0], { fov: 50 }),
    pose(61, [10, 1, 0], [10, 1, 5]),
    pose(120, [10, 1, 10], [0, 1, 10], { lookAhead: true, turnIn: 1 }),
    pose(181, [0, 1, 10], [0, 1, 0], { fov: 70 })
];
const opts = { frames: 250, frameRate: 30, smoothness: 1, loop: false, fov: 60 };

const cameraKeyframesChecks = {
    'export: no look ahead gives exactly today\'s keyframes'() {
        const plain = poses.map(({ lookAhead, turnIn, ...rest }) => rest);
        for (const loop of [false, true]) {
            const kf = cameraKeyframes(plain, { ...opts, loop });
            assert.deepEqual(kf.times, [0, 61, 120, 181]);
            assert.deepEqual(kf.values.position, [0, 1, 0, 10, 1, 0, 10, 1, 10, 0, 1, 10]);
            assert.deepEqual(kf.values.target, [5, 1, 0, 10, 1, 5, 0, 1, 10, 0, 1, 0]);
            assert.deepEqual(kf.values.fov, [50, 60, 60, 70]);
        }
    },

    'export: with look ahead, samples every 2 frames match the curve'() {
        const kf = cameraKeyframes(poses, opts);
        assert.equal(kf.times[0], 0);
        assert.equal(kf.times.at(-1), 181);
        for (let i = 1; i < kf.times.length - 1; ++i) assert.equal(kf.times[i] - kf.times[i - 1], 2);

        const curve = buildCameraCurve(poses.map(p => ({ ...p, fov: p.fov ?? 60 })), poses.map(p => p.frame), { duration: 250, smoothness: 1, loop: false, frameRate: 30 });
        const out = { position: v3(0, 0, 0), target: v3(0, 0, 0), fov: 0 };
        kf.times.forEach((t, i) => {
            curve(t, out);
            const got = kf.values.position.slice(i * 3, i * 3 + 6 - 3).concat(kf.values.target.slice(i * 3, i * 3 + 3));
            const want = [out.position.x, out.position.y, out.position.z, out.target.x, out.target.y, out.target.z];
            want.forEach((w, j) => assert.ok(Math.abs(got[j] - w) < 1e-9, `frame ${t} component ${j}`));
            assert.ok(Math.abs(kf.values.fov[i] - out.fov) < 1e-9);
        });

        // the viewer's spline through the baked keys stays close to the curve between samples
        const points = kf.times.flatMap((_, i) => [...kf.values.position.slice(i * 3, i * 3 + 3), ...kf.values.target.slice(i * 3, i * 3 + 3), kf.values.fov[i]]);
        const viewer = CubicSpline.fromPoints(kf.times, points, 1);
        const res = [];
        for (let f = 0; f <= 181; f += 1) {
            viewer.evaluate(f, res);
            curve(f, out);
            assert.ok(Math.abs(res[3] - out.target.x) < 0.3 && Math.abs(res[5] - out.target.z) < 0.3, `frame ${f}`);
        }
    },

    'export: looping look ahead also bakes the stretch back to the first key'() {
        const kf = cameraKeyframes(poses, { ...opts, loop: true });
        assert.equal(kf.times.at(-1) < 250, true);
        assert.equal(kf.times.at(-1) >= 248, true);
        assert.equal(kf.times.includes(181), true);
    }
};

export { cameraKeyframesChecks };
