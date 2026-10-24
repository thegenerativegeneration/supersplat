import assert from 'node:assert/strict';

import { detourPoses } from './.build/src/path/detours.js';
import { lookOptions } from './.build/src/path/fix-plan.js';
import { FIX, fakeGrid, fakeRoute, pose, setup } from './fix-path-events.mjs';

const EYE = 1.6;
const LOOK = { ahead: 2 * EYE, maxOffsetDeg: 35, ease: 2 * EYE };
const P = (x, z) => ({ x, y: EYE, z });

// L-shaped route every 0.4: 8 along +x, then 8 along +z
const lRoute = () => {
    const out = [];
    for (let i = 0; i <= 20; i++) out.push(P(i * 0.4, 0));
    for (let i = 1; i <= 20; i++) out.push(P(8, i * 0.4));
    return out;
};

const unit = (a) => {
    const len = Math.hypot(a.x, a.y, a.z);
    return { x: a.x / len, y: a.y / len, z: a.z / len };
};
const viewOf = p => unit({ x: p.target.x - p.position.x, y: p.target.y - p.position.y, z: p.target.z - p.position.z });
const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180 / Math.PI;
const tangentAt = (route, i) => unit({ x: route[i + 1].x - route[i - 1].x, y: 0, z: route[i + 1].z - route[i - 1].z });

const arcs = (route) => {
    const s = [0];
    for (let i = 1; i < route.length; i++) s.push(s[i - 1] + Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z));
    return s;
};

const endKeys = (route, toTarget) => ({
    from: { position: route[0], target: { x: route[0].x, y: EYE, z: -1 }, fov: 50 },
    to: { position: route[route.length - 1], target: toTarget, fov: 70 }
});

const detourLookChecks = {
    'detours: look-ahead views stay within 35° of travel between the ease zones'() {
        const route = lRoute();
        const { from, to } = endKeys(route, P(9, 8));
        const poses = detourPoses(route, from, to, EYE, LOOK);
        const s = arcs(route);
        const total = s[s.length - 1];
        let checked = 0;
        poses.forEach((p, k) => {
            const i = k + 1;
            if (s[i] < LOOK.ease || total - s[i] < LOOK.ease) return;
            assert.ok(angleDeg(viewOf(p), tangentAt(route, i)) <= 35 + 1e-6, `pose ${i}`);
            checked++;
        });
        assert.ok(checked > 10);
        // the corner turns the view before the camera gets there
        const before = viewOf(poses[16]);
        assert.ok(before.z > 0.3, 'looks round the corner');
    },

    'detours: narrow passages face along travel'() {
        const route = lRoute();
        const { from, to } = endKeys(route, P(9, 8));
        const narrow = p => p.x > 3 && p.x < 7;
        const poses = detourPoses(route, from, to, EYE, { ...LOOK, narrow });
        poses.forEach((p, k) => {
            if (narrow(route[k + 1])) assert.ok(angleDeg(viewOf(p), tangentAt(route, k + 1)) < 1e-6, `pose ${k + 1}`);
        });
    },

    'detours: a next key looking back along travel gives finite unit views'() {
        const route = [];
        for (let i = 0; i <= 20; i++) route.push(P(i * 0.4, 0));
        const { from, to } = endKeys(route, P(5, 0));
        // from looks back too, so both ease zones turn half a circle
        from.target = P(-3, 0);
        for (const p of detourPoses(route, from, to, EYE, LOOK)) {
            const d = { x: p.target.x - p.position.x, y: p.target.y - p.position.y, z: p.target.z - p.position.z };
            assert.ok([d.x, d.y, d.z].every(Number.isFinite));
            const len = Math.hypot(d.x, d.y, d.z);
            assert.ok(len > 0);
            assert.ok(Math.abs(Math.hypot(...[d.x, d.y, d.z].map(c => c / len)) - 1) < 1e-9);
        }
    },

    'detours: without look the views are unchanged'() {
        const route = [P(0, 0), P(1, 0), P(2, 0), P(3, 0), P(3, 1), P(3, 2), P(3, 3)];
        const from = { position: route[0], target: P(0, -1), fov: 50 };
        const to = { position: route[6], target: P(4, 3), fov: 70 };
        const got = detourPoses(route, from, to, EYE).map(p => [p.target.x, p.target.y, p.target.z, p.fov]);
        const want = [
            [2.6, 1.6, 0, 53.333333333],
            [3.371988681, 1.6, 0.823193209, 56.666666667],
            [3.034136285, 1.6, 1.697299112, 60],
            [3.318052356, 1.6, 2.810806086, 63.333333333],
            [3.822564391, 1.6, 3.372365776, 66.666666667]
        ];
        got.flat().forEach((v, i) => assert.ok(Math.abs(v - want.flat()[i]) < 1e-8, `value ${i}: ${v}`));
    },

    'detours: look-ahead distance follows the planned speed'() {
        const key = (x, linger = 0) => ({ position: P(x, 0), target: P(x, -1), fov: 60, name: `k${x}`, linger, distance: NaN });
        const grid = { voxel: 0.4, clearance: p => Math.abs(p.x - 5) };
        const timeline = { frames: 300, frameRate: 30 };
        // 20 units over 10 s: 2 units/s, 4 ahead
        const keys = [key(0), key(10), key(20)];
        assert.equal(lookOptions(keys, [[P(5, 0)], [P(15, 0)]], grid, EYE, timeline).ahead, 4);
        // lingers leave 5 s: 4 units/s, capped at four eye heights
        const lingering = [key(0, 2), key(10, 3), key(20)];
        assert.equal(lookOptions(lingering, [[P(5, 0)], [P(15, 0)]], grid, EYE, timeline).ahead, 4 * EYE);
        // an unrouted segment adds nothing; slow travel looks one eye height ahead
        const slow = lookOptions(keys, [[P(5, 0)], null], grid, EYE, { frames: 900, frameRate: 30 });
        assert.equal(slow.ahead, EYE);
        assert.equal(slow.maxOffsetDeg, 35);
        assert.equal(slow.ease, 2 * EYE);
        assert.equal(slow.narrow(P(5.2, 0)), true);
        assert.equal(slow.narrow(P(6, 0)), false);
    },

    async 'path: look ahead changes detour views and resets with the scene'() {
        const grid = { ...fakeGrid, clearance: () => Infinity };
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 12)], {
            deps: { sceneGrid: () => Promise.resolve({ grid, eyeHeight: 1.6 }), route: fakeRoute }
        });
        const detourTargets = () => events.invoke('camera.poses').filter(p => p.auto).map(p => p.target.toString()).join('|');
        assert.equal(events.invoke('path.settings').lookAhead, false);
        await events.invoke('path.fix', FIX);
        const plain = detourTargets();
        assert.ok(plain.length > 0, 'has detours');
        events.fire('path.setSettings', { lookAhead: true });
        assert.equal(events.invoke('path.settings').lookAhead, true);
        await events.invoke('path.fix', FIX);
        assert.notEqual(detourTargets(), plain);
        events.fire('scene.clear');
        assert.equal(events.invoke('path.settings').lookAhead, false);
    }
};

export { detourLookChecks };
