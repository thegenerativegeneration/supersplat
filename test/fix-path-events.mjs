import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { Events } from './.build/src/events.js';
import { registerFixPathEvents } from './.build/src/fix-path-events.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';

const V = 0.4;

// wall at x = 6 for z < 2; everything else is free
const occupied = p => Math.abs(p.x - 6) < 0.2 && p.z < 2;
const fakeGrid = {
    voxel: V,
    pointFree: p => !occupied(p),
    lineFree: (a, b) => {
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / (0.25 * V)));
        for (let i = 0; i <= n; i++) {
            const t = i / n;
            if (occupied({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })) return false;
        }
        return true;
    }
};

// points every voxel along a polyline, without the corners' duplicates
const polyline = (corners) => {
    const out = [];
    for (let i = 1; i < corners.length; i++) {
        const a = corners[i - 1], b = corners[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / V));
        for (let k = i === 1 ? 0 : 1; k <= n; k++) {
            const t = k / n;
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
        }
    }
    return out;
};

// straight routes, or around the wall end at z = 3; keys at x >= 20 are cut off
const fakeRoute = (grid, from, to) => {
    if (from.x >= 20 || to.x >= 20) return null;
    const crosses = (from.x - 6) * (to.x - 6) < 0;
    const points = polyline(crosses ? [from, { x: 6, y: from.y, z: 3 }, to] : [from, to]);
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    return { points, length, fromSnapped: false, toSnapped: false };
};

const pose = (name, frame, x, auto) => ({
    name,
    frame,
    position: new Vec3(x, 1, 0),
    target: new Vec3(x, 1, -1),
    fov: 60,
    ...(auto ? { auto: true } : {})
});

const setup = (poses, opts = {}) => {
    const events = new Events();
    events.function('timeline.frames', () => 181);
    events.function('timeline.frameRate', () => 30);
    events.function('timeline.smoothness', () => 1);
    events.function('timeline.loop', () => false);
    events.function('timeline.frame', () => 0);
    events.function('timeline.rotationWeight', () => 1);
    events.function('camera.fov', () => 60);
    events.function('camera.getPose', () => ({ position: new Vec3(1, 1, 1), target: new Vec3(1, 1, 0), fov: 60 }));
    events.function('camera.sampleDistances', async (list) => {
        await opts.onSample?.(events);
        return list.map(() => 1);
    });
    const popups = [];
    events.function('showPopup', async (args) => {
        popups.push(args);
        return { action: 'ok' };
    });

    registerCameraPosesEvents(events);
    registerTrackManagerEvents(events);
    registerFixPathEvents(events, opts.deps ?? {
        sceneGrid: async () => ({ grid: fakeGrid, eyeHeight: 1.6 }),
        route: fakeRoute
    });

    const ops = [];
    events.on('edit.add', op => ops.push(op));
    const markers = [];
    events.on('path.markers', m => markers.push(m));

    events.fire('camera.loadPoses', poses);
    return { events, ops, popups, markers };
};

const summary = events => events.invoke('camera.poses')
.slice()
.sort((a, b) => a.frame - b.frame)
.map(p => `${p.name}@${p.frame}${p.auto ? '*' : ''}`);

const FIX = { keepOrder: false, allowFlying: true };

const fixPathEventsChecks = {
    async 'path: fix path is one undo step and removes old auto keys'() {
        const { events, ops, popups } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4), pose('old', 45, 5, true), pose('camera_2', 60, 8)]);
        const original = summary(events);

        const first = await events.invoke('path.fix', FIX);
        assert.equal(first.ok, true);
        assert.ok(first.detours > 0, 'detours around the wall');
        assert.equal(ops.length, 1);
        assert.equal(ops[0].name, 'fixPath');
        const after = events.invoke('camera.poses');
        assert.ok(!after.some(p => p.name === 'old'), 'old auto key removed');
        assert.equal(after.filter(p => p.auto).length, first.detours);
        assert.deepEqual(after.filter(p => !p.auto).map(p => p.name).sort(), ['camera_0', 'camera_1', 'camera_2']);
        assert.ok(after.every(p => p.frame >= 0 && p.frame < 181));
        assert.equal(Math.min(...after.map(p => p.frame)), after.find(p => p.name === 'camera_0').frame);

        const second = await events.invoke('path.fix', FIX);
        assert.equal(second.detours, first.detours);
        assert.equal(events.invoke('camera.poses').filter(p => p.auto).length, first.detours);
        assert.equal(ops.length, 2);
        assert.equal(popups.length, 0);

        ops[1].undo();
        ops[0].undo();
        assert.deepEqual(summary(events), original);
    },

    async 'path: fix path aborts when keys change meanwhile'() {
        const { events, ops, popups } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4), pose('camera_2', 60, 8)], {
            onSample: ev => ev.fire('track.moveKey', 60, 70)
        });
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'keysChanged');
        assert.ok(ops.every(op => op.name !== 'fixPath'));
        assert.deepEqual(summary(events), ['camera_0@0', 'camera_1@30', 'camera_2@70']);
        assert.equal(popups.length, 1);
    },

    async 'path: too few keys does nothing'() {
        const { events, ops } = setup([pose('camera_0', 0, 0), pose('a', 30, 4, true)]);
        const few = await events.invoke('path.fix', FIX);
        assert.equal(few.ok, false);
        assert.equal(few.reason, 'tooFewKeys');
        assert.equal(ops.length, 0);

        // the default grid layer reads the scene points; none means no splats
        const empty = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4)], { deps: {} });
        empty.events.function('candidates.points', async () => new Float32Array(0));
        const none = await empty.events.invoke('path.fix', FIX);
        assert.equal(none.ok, false);
        assert.equal(none.reason, 'noSplats');
        assert.equal(empty.ops.length, 0);
    },

    async 'path: markers clear on the next track edit'() {
        const { events, markers } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 20), pose('camera_2', 60, 4)]);
        await events.invoke('path.fix', FIX);
        const shown = markers[markers.length - 1];
        assert.deepEqual(shown.unreachable, ['camera_1']);
        assert.ok(shown.blocked.length > 0);

        events.fire('track.addKey', 100);
        assert.deepEqual(markers[markers.length - 1], { blocked: [], unreachable: [], insideGeometry: [] });

        await events.invoke('path.fix', FIX);
        assert.ok(markers[markers.length - 1].blocked.length > 0);
        events.fire('timeline.loop', false);
        assert.deepEqual(markers[markers.length - 1], { blocked: [], unreachable: [], insideGeometry: [] });
    },

    async 'path: unreachable key ends up last and is reported'() {
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 20), pose('camera_2', 60, 8), pose('camera_3', 90, 4)]);
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, true);
        assert.deepEqual(result.unreachable, ['camera_1']);
        const poses = events.invoke('camera.poses');
        const frameOf = name => poses.find(p => p.name === name).frame;
        assert.equal(frameOf('camera_1'), Math.max(...poses.map(p => p.frame)));
        // shortest order: 0 -> 4 -> 8, then the unreachable key
        assert.ok(frameOf('camera_3') < frameOf('camera_2'));
        assert.deepEqual(result.blocked, [frameOf('camera_2')]);
        assert.deepEqual(result.insideGeometry, []);
    },

    async 'path: balance failure applies evenly spaced keys and tells why'() {
        const long = { ...pose('camera_1', 30, 4), linger: 10 };
        const { events, ops, popups } = setup([pose('camera_0', 0, 0), long, pose('camera_2', 60, 8)]);
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, true);
        assert.equal(result.balance.reason, 'lingerTooLong');
        assert.equal(ops.length, 1);
        assert.equal(popups.length, 1);
        const frames = events.invoke('camera.poses').map(p => p.frame).sort((a, b) => a - b);
        assert.equal(frames[0], 0);
        assert.equal(frames[frames.length - 1], 180);
        assert.ok(frames.every((f, i) => Number.isInteger(f) && (i === 0 || f > frames[i - 1])));
        assert.equal(events.invoke('camera.poses').find(p => p.name === 'camera_1').linger, 10);
    },

    async 'path: settings default to reorder and flying'() {
        const { events } = setup([]);
        assert.deepEqual(events.invoke('path.settings'), { keepOrder: false, allowFlying: true });
        events.fire('path.setSettings', { keepOrder: true });
        assert.deepEqual(events.invoke('path.settings'), { keepOrder: true, allowFlying: true });
    }
};

export { fixPathEventsChecks };
