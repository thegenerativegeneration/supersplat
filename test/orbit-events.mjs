import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { inlineTransport } from './.build/src/compute/inline-transport.js';
import { createSceneCompute } from './.build/src/compute/scene-compute.js';
import { Events } from './.build/src/events.js';
import { registerOrbitEvents } from './.build/src/orbit-events.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';
import { i18n } from './.build/src/ui/localization.js';

const EYE = 1.6;
const BOX = { min: { x: -20, y: -1, z: -20 }, max: { x: 20, y: 6, z: 20 } };

// points every 0.1 over [x0, x1] x [y0, y1] x [z0, z1]
const block = (x0, x1, y0, y1, z0, z1) => {
    const out = [];
    for (let x = x0; x <= x1 + 1e-9; x += 0.1) {
        for (let y = y0; y <= y1 + 1e-9; y += 0.1) {
            for (let z = z0; z <= z1 + 1e-9; z += 0.1) out.push(x, y, z);
        }
    }
    return out;
};

// a small far-away cluster, so the scene has splats but the orbits are free
const FAR = block(15, 15.2, 0, 0.2, 15, 15.2);
// a wall at x = 3 for |z| <= 5
const WALL = block(3, 3.15, -1, 5, -5, 5);

const SPEC = { centre: { x: 0, y: 0, z: 0 }, radius: 2, height: EYE, startDeg: 0, spanDeg: 360, dir: 1, fov: 60 };

const pose = (name, frame, x, extra = {}) => ({
    name,
    frame,
    position: new Vec3(x, EYE, 0),
    target: new Vec3(x, EYE, -1),
    fov: 60,
    ...extra
});

const setup = (points, poses = [], opts = {}) => {
    const events = new Events();
    events.function('timeline.frames', () => opts.frames ?? 900);
    events.function('timeline.frameRate', () => 30);
    events.function('timeline.smoothness', () => 1);
    events.function('timeline.loop', () => opts.loop ?? false);
    events.function('timeline.frame', () => 0);
    events.function('timeline.rotationWeight', () => 1);
    events.function('camera.fov', () => 60);
    events.function('camera.getPose', () => ({ position: { x: 3, y: 2, z: 4 }, target: { x: 0, y: 0.4, z: 0 }, fov: 60 }));
    events.function('camera.sampleDistances', list => Promise.resolve(list.map(() => 2)));
    const cloud = { points: new Float32Array(points), extents: undefined };
    events.function('candidates.cloud', () => Promise.resolve(cloud));
    events.function('candidates.prepare', () => Promise.resolve({ box: BOX, eyeHeight: EYE, points: points.length / 3 }));
    const popups = [];
    events.function('showPopup', (args) => {
        popups.push(args);
        return Promise.resolve({ action: 'ok' });
    });

    if (opts.onRun) {
        // the inline compute, calling onRun once each run is on its way
        const base = createSceneCompute([() => inlineTransport()]);
        const compute = {
            pointsVersion: cloud => base.pointsVersion(cloud),
            run: (op, args, runOpts) => {
                const pending = base.run(op, args, runOpts);
                opts.onRun(op, events);
                return pending;
            }
        };
        events.function('compute', () => compute);
    }

    registerCameraPosesEvents(events);
    registerTrackManagerEvents(events);
    registerOrbitEvents(events);

    const ops = [];
    events.on('edit.add', op => ops.push(op));
    events.fire('camera.loadPoses', poses);
    return { events, ops, popups };
};

// counts of progressStart and progressEnd
const progressCounts = (events) => {
    const counts = { start: 0, end: 0 };
    events.on('progressStart', () => counts.start++);
    events.on('progressEnd', () => counts.end++);
    return counts;
};

const byFrame = events => events.invoke('camera.poses').slice().sort((a, b) => a.frame - b.frame);
const summary = events => byFrame(events).map(p => `${p.name}@${p.frame}`);

const orbitEventsChecks = {
    async 'orbit: defaults come from the focal point and the camera'() {
        const { events } = setup(FAR);
        const d = await events.invoke('orbit.defaults');
        assert.deepEqual(d.centre, { x: 0, y: 0.4, z: 0 });
        assert.ok(Math.abs(d.radius - 5) < 1e-9);
        assert.ok(Math.abs(d.height - 1.6) < 1e-9);
        assert.ok(Math.abs(d.startDeg - Math.atan2(4, 3) * 180 / Math.PI) < 1e-9);
        assert.equal(d.fov, 60);
        assert.equal(d.metric, true);
        assert.equal(d.shotSeconds, 30);
        assert.equal(d.turnSeconds, 18);
        assert.equal((await events.invoke('orbit.defaults', 180)).turnSeconds, 9);
    },

    async 'orbit: plan on a free scene keeps the radius'() {
        const { events } = setup(FAR);
        const plan = await events.invoke('orbit.plan', { ...SPEC, radius: 4 });
        assert.equal(plan.keys.length, 17);
        assert.equal(plan.radius, 4);
        assert.equal(plan.reduced, false);
        assert.deepEqual(plan.blockedRanges, []);
        assert.ok(plan.keys.every(k => Math.abs(Math.hypot(k.position.x, k.position.z) - 4) < 1e-9));
    },

    async 'orbit: plan near a wall reduces the radius'() {
        const { events } = setup(WALL);
        const plan = await events.invoke('orbit.plan', { ...SPEC, radius: 4 });
        assert.equal(plan.keys.length, 17);
        assert.equal(plan.reduced, true);
        assert.ok(plan.radius <= 2.8 && plan.radius >= 2.4, `radius ${plan.radius}`);
    },

    async 'orbit: plan inside a wall is blocked with ranges in -180..180'() {
        const { events } = setup(WALL);
        const plan = await events.invoke('orbit.plan', { ...SPEC, centre: { x: 3.1, y: 0, z: 0 }, radius: 0.4 });
        assert.equal(plan.blocked, true);
        assert.deepEqual(plan.keys, []);
        assert.ok(plan.blockedRanges.length > 0);
        assert.ok(plan.blockedRanges.every(([a, b]) => a >= -180 && b <= 180 && a <= b));
        // the radius the ranges were found at, for the preview
        assert.equal(plan.radius, 0.4);
        const tiny = await events.invoke('orbit.plan', { ...SPEC, centre: { x: 3.1, y: 0, z: 0 }, radius: 0 });
        assert.ok(tiny.radius > 0, `radius ${tiny.radius}`);
    },

    async 'orbit: add on an empty timeline gives one balanced orbit'() {
        const { events, ops, popups } = setup(FAR);
        const result = await events.invoke('orbit.add', SPEC);
        assert.equal(result.ok, true);
        assert.equal(result.added, 17);
        assert.equal(result.balance.ok, true);
        assert.equal(result.orbitBlocked, false);
        assert.equal(result.joinBlocked, false);
        assert.equal(ops.length, 1);
        assert.equal(popups.length, 0);
        const poses = byFrame(events);
        assert.equal(poses.length, 17);
        assert.ok(poses.every(p => p.orbit === 'orbit_0'));
        assert.equal(poses[0].frame, 0);
    },

    async 'orbit: add appends after existing keys in one undo step'() {
        const { events, ops } = setup(FAR, [pose('camera_0', 0, -10, { orbit: 'orbit_0' }), pose('camera_1', 30, -8)]);
        const before = summary(events);
        const result = await events.invoke('orbit.add', SPEC);
        assert.equal(result.ok, true);
        assert.equal(ops.length, 1);
        const poses = byFrame(events);
        assert.deepEqual(poses.slice(0, 2).map(p => p.name), ['camera_0', 'camera_1']);
        assert.ok(poses.slice(2).every(p => p.orbit === 'orbit_1'));
        assert.equal(poses.length, 19);
        ops[0].undo();
        assert.deepEqual(summary(events), before);
    },

    async 'orbit: a join through a wall is reported'() {
        const { events } = setup(WALL, [pose('camera_0', 0, 6), pose('camera_1', 30, 5)]);
        const result = await events.invoke('orbit.add', SPEC);
        assert.equal(result.ok, true);
        assert.equal(result.reduced, false);
        assert.equal(result.joinBlocked, true);
        assert.equal(result.orbitBlocked, false);
    },

    async 'orbit: a lone full turn in a loop leaves out the closing key'() {
        const { events } = setup(FAR, [], { loop: true, frames: 960 });
        const result = await events.invoke('orbit.add', SPEC);
        assert.equal(result.ok, true);
        assert.equal(result.added, 16);
        const poses = byFrame(events);
        const frames = poses.map(p => p.frame);
        const gaps = frames.slice(1).map((f, i) => f - frames[i]).concat(960 - frames[15] + frames[0]);
        assert.ok(gaps.every(g => g === 60), `gaps ${gaps}`);
        const at = i => poses[i % 16].position;
        for (let i = 0; i < 16; i++) assert.ok(at(i).distance(at(i + 1)) > 0.5, `keys ${i} and ${i + 1} coincide`);
    },

    async 'orbit: a full turn after other keys in a loop keeps the closing key'() {
        const { events } = setup(FAR, [pose('camera_0', 0, -10)], { loop: true });
        const result = await events.invoke('orbit.add', SPEC);
        assert.equal(result.added, 17);
    },

    async 'orbit: the circle stays inside the area box'() {
        const { events } = setup(FAR);
        const near = await events.invoke('orbit.plan', { ...SPEC, centre: { x: 18, y: 0, z: 0 }, radius: 4 });
        assert.equal(near.reduced, true);
        assert.ok(near.radius <= 2, `radius ${near.radius}`);
        const outside = await events.invoke('orbit.plan', { ...SPEC, centre: { x: 25, y: 0, z: 0 } });
        assert.equal(outside.blocked, true);
        assert.ok(outside.blockedRanges.length > 0);
        const high = await events.invoke('orbit.plan', { ...SPEC, height: 10 });
        assert.equal(high.blocked, true);
    },

    async 'orbit: a huge typed radius is capped at the box diagonal'() {
        const { events } = setup(FAR);
        const plan = await events.invoke('orbit.plan', { ...SPEC, radius: 1e9 });
        assert.equal(plan.reduced, true);
        assert.ok(plan.radius <= 20, `radius ${plan.radius}`);
        const blocked = await events.invoke('orbit.plan', { ...SPEC, centre: { x: 25, y: 0, z: 0 }, radius: 1e9 });
        assert.ok(blocked.radius <= Math.hypot(40, 7, 40), `radius ${blocked.radius}`);
    },

    async 'orbit: a blocked orbit adds nothing'() {
        const { events, ops } = setup(WALL);
        const result = await events.invoke('orbit.add', { ...SPEC, centre: { x: 3.1, y: 0, z: 0 }, radius: 0.4 });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'blocked');
        assert.equal(result.added, 0);
        assert.equal(ops.length, 0);
    },

    async 'orbit: add cancelled during planning adds nothing and no undo op'() {
        const { events, ops, popups } = setup(FAR, [pose('camera_0', 0, -10)], {
            onRun: (op, ev) => op === 'orbitPlan' && ev.fire('progressCancel')
        });
        const counts = progressCounts(events);
        const before = summary(events);
        const result = await events.invoke('orbit.add', SPEC);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'cancelled');
        assert.equal(result.added, 0);
        assert.deepEqual(summary(events), before);
        assert.equal(ops.length, 0);
        assert.equal(popups.length, 0);
        assert.deepEqual(counts, { start: 1, end: 1 });
    },

    async 'orbit: cancel is locked once the keys are appended'() {
        const { events, ops, popups } = setup(FAR);
        const counts = progressCounts(events);
        const updates = [];
        events.on('progressUpdate', update => updates.push(update));
        events.on('track.appendPoses', () => events.fire('progressCancel'));
        const result = await events.invoke('orbit.add', SPEC);
        assert.equal(result.ok, true);
        assert.equal(result.added, 17);
        assert.equal(result.orbitBlocked, false);
        assert.equal(byFrame(events).length, 17);
        assert.equal(ops.length, 1);
        assert.equal(popups.length, 0);
        const locked = updates.filter(u => u.cancellable === false);
        assert.deepEqual(locked, [{ text: i18n.t('progress.checking'), cancellable: false }]);
        assert.deepEqual(counts, { start: 1, end: 1 });
    },

    async 'orbit: previews superseded while dragging return only the newest plan'() {
        const { events } = setup(FAR);
        const runs = [1, 2, 3, 4].map(radius => events.invoke('orbit.plan', { ...SPEC, radius }));
        const settled = await Promise.allSettled(runs);
        assert.deepEqual(settled.map(s => s.status), ['fulfilled', 'rejected', 'rejected', 'fulfilled']);
        settled.filter(s => s.status === 'rejected').forEach(({ reason }) => {
            assert.equal(reason.name, 'AbortError');
            assert.equal(reason.message, 'superseded');
        });
        assert.equal(settled[0].value.radius, 1);
        assert.equal(settled[3].value.radius, 4);
    }
};

export { BOX, EYE, FAR, orbitEventsChecks, SPEC };
