import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCandidateEvents } from './.build/src/candidate-events.js';
import { buildDensityOccupancy } from './.build/src/candidates/density.js';
import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { Events } from './.build/src/events.js';
import { registerFixPathEvents } from './.build/src/fix-path-events.js';
import { CAMERA_RADIUS_VOXELS } from './.build/src/path/clearance.js';
import { registerTimingEvents } from './.build/src/timing-events.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';
import { fakeSlab } from './candidates.mjs';
import { bandRoom } from './nav-doors.mjs';

const V = 0.4;

// wall at x = 6 for z < 2; everything else is free
const occupied = p => Math.abs(p.x - 6) < 0.2 && p.z < 2;
const fakeGrid = {
    voxel: V,
    pointFree: p => !occupied(p),
    sphereFree: p => !occupied(p),
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

// straight routes, or around the wall end at z = 3; keys at x >= cut form a
// group of their own
const routeWithCut = cut => (grid, from, to) => {
    if ((from.x >= cut.x) !== (to.x >= cut.x)) return null;
    const crosses = (from.x - 6) * (to.x - 6) < 0;
    const points = polyline(crosses ? [from, { x: 6, y: from.y, z: 3 }, to] : [from, to]);
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    return { points, length, fromSnapped: false, toSnapped: false };
};
const fakeRoute = routeWithCut({ x: 20 });

const pose = (name, frame, x, auto) => ({
    name,
    frame,
    position: new Vec3(x, 1, 0),
    target: new Vec3(x, 1, -1),
    fov: 60,
    ...(auto ? { auto: true } : {})
});

// keys at eye height above the slab of fakeSlab
const high = (name, frame, x) => ({ ...pose(name, frame, x), position: new Vec3(x, 2, 1), target: new Vec3(x, 2, 0) });

const parkedOf = events => events.invoke('camera.poses').filter(p => p.parked).sort((a, b) => a.frame - b.frame);

const setup = (poses, opts = {}) => {
    const events = new Events();
    events.function('timeline.frames', () => opts.frames ?? 181);
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
        empty.events.function('candidates.cloud', async () => ({ points: new Float32Array(0), extents: new Float32Array(0) }));
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
        // the parked key has no segment in the shot
        assert.deepEqual(shown.blocked, []);

        events.fire('track.addKey', 100);
        assert.deepEqual(markers[markers.length - 1], { blocked: [], unreachable: [], insideGeometry: [] });

        for (const [name, value] of [['timeline.loop', false], ['timeline.frames', 240]]) {
            await events.invoke('path.fix', FIX);
            assert.ok(markers[markers.length - 1].unreachable.length > 0);
            events.fire(name, value);
            assert.deepEqual(markers[markers.length - 1], { blocked: [], unreachable: [], insideGeometry: [] }, name);
        }
    },

    async 'path: unreachable key is parked after the shot and reported'() {
        const { events, markers } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 20), pose('camera_2', 60, 8), pose('camera_3', 90, 4)]);
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, true);
        assert.deepEqual(result.unreachable, ['camera_1']);
        assert.deepEqual(markers[markers.length - 1].unreachable, ['camera_1']);
        const poses = events.invoke('camera.poses');
        const frameOf = name => poses.find(p => p.name === name).frame;
        assert.deepEqual(parkedOf(events).map(p => `${p.name}@${p.frame}`), ['camera_1@181']);
        assert.ok(poses.filter(p => !p.parked).every(p => p.frame < 181));
        // shortest order: 0 -> 4 -> 8
        assert.ok(frameOf('camera_3') < frameOf('camera_2'));
        assert.deepEqual(result.blocked, []);
        assert.deepEqual(result.insideGeometry, []);
    },

    async 'path: an isolated first key is parked and the main group starts the shot'() {
        const { events } = setup([pose('camera_0', 0, 25), pose('camera_1', 30, 8), pose('camera_2', 60, 0), pose('camera_3', 90, 4)]);
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, true);
        assert.deepEqual(result.unreachable, ['camera_0']);
        assert.deepEqual(parkedOf(events).map(p => `${p.name}@${p.frame}`), ['camera_0@181']);
        const shot = summary(events).filter(n => !n.endsWith('*') && Number(n.split('@')[1]) < 181);
        assert.equal(shot[0], 'camera_1@0');
    },

    async 'path: the smaller group is parked in its frame order and does not play'() {
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 22), pose('camera_2', 60, 4), pose('camera_3', 90, 20), pose('camera_4', 120, 2)]);
        const seen = [];
        events.on('camera.setPose', p => seen.push(p.position.x));
        const result = await events.invoke('path.fix', FIX);
        assert.deepEqual(result.unreachable, ['camera_1', 'camera_3']);
        assert.deepEqual(parkedOf(events).map(p => `${p.name}@${p.frame}`), ['camera_1@181', 'camera_3@182']);
        const kept = events.invoke('camera.poses').find(p => p.name === 'camera_1');
        assert.equal(kept.position.x, 22);
        seen.length = 0;
        for (let f = 0; f <= 180; f += 10) events.fire('timeline.frame', f);
        assert.ok(seen.length > 0 && seen.every(x => x < 20), 'parked keys do not play');
    },

    async 'path: two keys that cannot meet keep the first in the shot'() {
        const { events, popups } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 25)]);
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, true);
        assert.deepEqual(result.unreachable, ['camera_1']);
        assert.deepEqual(summary(events), ['camera_0@0', 'camera_1@181']);
        assert.equal(popups.length, 0);
    },

    async 'path: rerun retries parked keys, undo restores in one step'() {
        const cut = { x: 20 };
        const { events, ops } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 20), pose('camera_2', 60, 4)], {
            deps: { sceneGrid: async () => ({ grid: fakeGrid, eyeHeight: 1.6 }), route: routeWithCut(cut) }
        });
        const original = summary(events);
        await events.invoke('path.fix', FIX);
        assert.equal(parkedOf(events).length, 1);
        assert.equal(ops.length, 1);
        cut.x = 100;
        const again = await events.invoke('path.fix', FIX);
        assert.deepEqual(again.unreachable, []);
        assert.equal(parkedOf(events).length, 0);
        assert.ok(events.invoke('camera.poses').every(p => p.frame < 181));
        ops[1].undo();
        assert.equal(parkedOf(events).length, 1);
        ops[0].undo();
        assert.deepEqual(summary(events), original);
        assert.equal(parkedOf(events).length, 0);
    },

    async 'path: moving a parked key into the shot clears parked'() {
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 20), pose('camera_2', 60, 4)]);
        await events.invoke('path.fix', FIX);
        events.fire('track.moveKey', 181, 190);
        assert.equal(parkedOf(events)[0]?.frame, 190, 'still out of the shot');
        events.fire('track.copyKey', 190, 200);
        assert.equal(events.invoke('camera.poses').find(p => p.frame === 200).parked, undefined);
        events.fire('track.moveKey', 190, 150);
        assert.equal(events.invoke('camera.poses').find(p => p.frame === 150).parked, undefined);
    },

    async 'path: Balance leaves parked keys alone'() {
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 20), pose('camera_2', 60, 8), pose('camera_3', 90, 4)]);
        registerTimingEvents(events);
        await events.invoke('path.fix', FIX);
        const before = summary(events);
        assert.ok('frames' in await events.invoke('timing.balance'));
        assert.deepEqual(summary(events), before);

        // an unbalanced track with a parked key in the middle of the frame order
        const raw = setup([pose('camera_0', 0, 0), pose('camera_1', 200, 20), { ...pose('camera_2', 190, 4), parked: true }, pose('camera_3', 50, 8)]);
        registerTimingEvents(raw.events);
        assert.ok('frames' in await raw.events.invoke('timing.balance'));
        const poses = raw.events.invoke('camera.poses');
        assert.equal(poses.find(p => p.name === 'camera_2').frame, 190);
        assert.ok(poses.filter(p => p.name !== 'camera_2').every(p => p.frame < 181));
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

    async 'path: more keys than frames is reported, not applied'() {
        // 3 frames cannot hold 3 keys and a detour
        const { events, ops, markers } = setup([pose('camera_0', 0, 0), pose('camera_1', 1, 4), pose('camera_2', 2, 8)], { frames: 3 });
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'tooFewFrames');
        assert.equal(ops.length, 0);
        assert.deepEqual(markers, []);
    },

    async 'path: Balance after Fix path keeps the frames'() {
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4), pose('camera_2', 60, 8)]);
        registerTimingEvents(events);
        const fixed = await events.invoke('path.fix', FIX);
        assert.ok(fixed.detours > 0);
        const before = summary(events);
        const balanced = await events.invoke('timing.balance');
        assert.ok('frames' in balanced);
        assert.deepEqual(summary(events), before);
    },

    async 'path: keys outside the area are listed'() {
        const box = { min: { x: -1, y: 0, z: -1 }, max: { x: 9, y: 3, z: 5 } };
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4), { ...pose('camera_2', 60, 8), position: new Vec3(8, 5, 0) }], {
            deps: { sceneGrid: async () => ({ grid: fakeGrid, eyeHeight: 1.6, box }), route: fakeRoute }
        });
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, true);
        assert.deepEqual(result.insideGeometry, ['camera_2']);
    },

    async 'path: settings default to reorder and flying'() {
        const { events } = setup([]);
        assert.deepEqual(events.invoke('path.settings'), { keepOrder: false, allowFlying: true, keepClear: false, lookAhead: false, smallestOpening: 0.8 });
        events.fire('path.setSettings', { keepOrder: true });
        assert.deepEqual(events.invoke('path.settings'), { keepOrder: true, allowFlying: true, keepClear: false, lookAhead: false, smallestOpening: 0.8 });
        // missing options come from the settings
        const fixed = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 8), pose('camera_2', 60, 4)]);
        fixed.events.fire('path.setSettings', { keepOrder: true });
        await fixed.events.invoke('path.fix', { allowFlying: true });
        assert.deepEqual(summary(fixed.events).filter(n => !n.endsWith('*')).map(n => n.split('@')[0]), ['camera_0', 'camera_1', 'camera_2']);
    },

    async 'path: the smallest opening round-trips, clamps and reaches the grid'() {
        let openingAt = null;
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4)], {
            deps: {
                sceneGrid: async (allowFlying, opening) => {
                    openingAt = opening;
                    return { grid: fakeGrid, eyeHeight: 1.6 };
                },
                route: fakeRoute
            }
        });
        const opening = () => events.invoke('path.settings').smallestOpening;
        events.fire('path.setSettings', { smallestOpening: 0.6 });
        assert.equal(opening(), 0.6);
        events.fire('path.setSettings', { smallestOpening: 0.1 });
        assert.equal(opening(), 0.4);
        events.fire('path.setSettings', { smallestOpening: 5 });
        assert.equal(opening(), 2.0);
        events.fire('path.setSettings', { smallestOpening: NaN });
        assert.equal(opening(), 2.0);
        events.fire('path.setSettings', { smallestOpening: 0.6 });
        await events.invoke('path.fix', FIX);
        assert.equal(openingAt(1.6), 0.6);
        // the range follows the eye height Fix path uses
        assert.equal(openingAt(3.2), 0.8);
        events.function('candidates.lastSettings', () => ({ box: null, eyeHeight: 3.2 }));
        assert.equal(opening(), 0.8);
    },

    async 'path: the smallest opening reaches the scene grid at the eye height in use'() {
        // the band room of nav-doors at twice the size: a 1.6 high band, eye height 3.2
        const at = (x, z) => ({ position: new Vec3(x, 4, z), target: new Vec3(x, 4, z - 1), fov: 60 });
        const { events } = setup([{ name: 'a', frame: 0, ...at(6, 10.8) }, { name: 'b', frame: 30, ...at(34, 10.8) }], { deps: {} });
        const points = bandRoom(1.6, 2.4).map(v => v * 2);
        const box = { min: { x: -2, y: -2, z: -2 }, max: { x: 42, y: 12, z: 22 } };
        events.function('candidates.cloud', async () => ({ points }));
        events.function('candidates.lastSettings', () => ({ box, eyeHeight: 3.2 }));
        const opening = () => events.invoke('path.settings').smallestOpening;
        assert.equal(opening(), 1.6, 'default at eye height 3.2');
        events.fire('path.setSettings', { smallestOpening: 0.1 });
        assert.equal(opening(), 0.8, 'clamped at eye height 3.2');

        events.fire('path.setSettings', { smallestOpening: 2.4 });
        assert.deepEqual((await events.invoke('path.fix', FIX)).unreachable, ['b'], 'band too low');
        events.fire('path.setSettings', { smallestOpening: 1.6 });
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, true);
        assert.deepEqual(result.unreachable, [], 'band passes');
    },

    async 'path: the result says whether the box of its grid looks metric'() {
        for (const [size, metric] of [[10, true], [1, false]]) {
            const box = { min: { x: -size, y: -size, z: -size }, max: { x: size, y: size, z: size } };
            const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4)], {
                deps: { sceneGrid: async () => ({ grid: fakeGrid, eyeHeight: 1.6, box }), route: fakeRoute }
            });
            assert.equal((await events.invoke('path.fix', FIX)).metric, metric, `box ${size}`);
        }
    },

    async 'path: a cleared scene drops the opening and the eye height estimate'() {
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4)], {
            deps: { sceneGrid: async () => ({ grid: fakeGrid, eyeHeight: 2 }), route: fakeRoute }
        });
        events.fire('path.setSettings', { smallestOpening: 0.45 });
        await events.invoke('path.fix', FIX);
        // clamped to the range at the estimated eye height of 2
        assert.equal(events.invoke('path.settings').smallestOpening, 0.5);
        events.fire('scene.clear');
        // the default at eye height 1.6
        assert.equal(events.invoke('path.settings').smallestOpening, 0.8);
    },

    async 'path: keep clear of walls reaches the grid and resets with the scene'() {
        const radii = [];
        const { events } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4)], {
            deps: {
                sceneGrid: async (allowFlying, openingAt, cameraRadius) => {
                    radii.push(cameraRadius);
                    return { grid: fakeGrid, eyeHeight: 1.6 };
                },
                route: fakeRoute
            }
        });
        assert.equal(events.invoke('path.settings').keepClear, false);
        await events.invoke('path.fix', FIX);
        events.fire('path.setSettings', { keepClear: true });
        assert.equal(events.invoke('path.settings').keepClear, true);
        await events.invoke('path.fix', FIX);
        assert.deepEqual(radii, [0, CAMERA_RADIUS_VOXELS]);
        events.fire('scene.clear');
        assert.equal(events.invoke('path.settings').keepClear, false);
    },

    async 'path: the density rule finds a floor of faint splats that the bodies rule misses'() {
        const { events } = setup([high('camera_0', 0, 1), high('camera_1', 30, 4)], { deps: {} });
        registerCandidateEvents(events, { lockedRenderMode: false, camera: { fov: 60, ortho: false }, getElementsByType: () => [fakeSlab()] });
        const bodies = await events.invoke('path.fix', FIX);
        assert.deepEqual(bodies.unreachable, ['camera_1'], 'no floor without the density rule');
        events.fire('candidates.setSolidRule', 'density');
        const density = await events.invoke('path.fix', FIX);
        assert.deepEqual(density.unreachable, [], 'the faint slab is a floor');
        assert.equal(density.balance.ok, true);
    },

    async 'path: the density occupancy is built once until the splats change'() {
        const { events } = setup([high('camera_0', 0, 1), high('camera_1', 30, 4)], { deps: {} });
        let builds = 0;
        const build = (...args) => {
            builds++;
            return buildDensityOccupancy(...args);
        };
        registerCandidateEvents(events, { lockedRenderMode: false, camera: { fov: 60, ortho: false }, getElementsByType: () => [fakeSlab()] }, build);
        events.fire('candidates.setSolidRule', 'density');
        await events.invoke('path.fix', FIX);
        await events.invoke('path.fix', FIX);
        assert.equal(builds, 1, 'second run reuses the occupancy');
        events.fire('splat.moved');
        const moved = await events.invoke('path.fix', FIX);
        assert.equal(builds, 2, 'a moved splat rebuilds it');
        assert.deepEqual(moved.unreachable, []);
    },

    async 'path: a cleared scene forgets the last Suggest Views settings'() {
        const events = new Events();
        events.function('camera.getPose', () => ({ position: new Vec3(1, 1, 1), target: new Vec3(1, 1, 0) }));
        const scene = { lockedRenderMode: false, camera: { fov: 60, ortho: false }, getElementsByType: () => [] };
        registerCandidateEvents(events, scene);
        registerFixPathEvents(events);
        const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } };
        await events.invoke('candidates.generate', { box, eyeHeight: 1.2, budget: 4, seed: 1 }, new AbortController().signal);
        assert.deepEqual(await events.invoke('path.eyeHeight'), { eyeHeight: 1.2, estimated: false, metric: true });
        events.fire('scene.clear');
        assert.equal(events.invoke('candidates.lastSettings'), null);
        // Fix path prepares afresh, which finds no splats here
        assert.equal(await events.invoke('path.eyeHeight'), null);
    }
};

export { FIX, fakeGrid, fakeRoute, fixPathEventsChecks, pose, setup };
