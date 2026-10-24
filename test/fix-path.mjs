import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { buildCameraCurve } from './.build/src/anim/camera-curve.js';
import { insideBox } from './.build/src/candidates/estimate.js';
import { findLevels } from './.build/src/candidates/levels.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { checkCurve } from './.build/src/path/curve-check.js';
import { detourPoses, planDetours, simplifyRoute } from './.build/src/path/detours.js';
import { buildNavGrid } from './.build/src/path/nav-grid.js';
import { orderKeys } from './.build/src/path/order.js';
import { findRoute } from './.build/src/path/route.js';
import { setup } from './camera-track.mjs';

const pathPose = (name, frame, x, auto) => ({
    name,
    frame,
    position: new Vec3(x, 1, 0),
    target: new Vec3(x, 1, -1),
    fov: 60,
    ...(auto ? { auto: true } : {})
});

const autoFlags = events => events.invoke('camera.poses').map(p => !!p.auto);

const distOf = pts => pts.map(a => pts.map(b => Math.hypot(a[0] - b[0], a[1] - b[1])));
const tourLength = (d, order, loop) => {
    let sum = 0;
    for (let i = 1; i < order.length; i++) sum += d[order[i - 1]][order[i]];
    return loop ? sum + d[order[order.length - 1]][order[0]] : sum;
};

const EYE = 1.6;
const V = EYE / 4;
const BIG_BOX = { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } };

// points on a grid spanning two axes, two per grid point; f maps (u, w) to [x, y, z]
const sheet = (u0, u1, w0, w1, f, skip = () => false, step = 0.2) => {
    const out = [];
    for (let i = 0; u0 + i * step < u1 - 1e-9; i++) {
        const u = u0 + i * step;
        for (let j = 0; w0 + j * step < w1 - 1e-9; j++) {
            const w = w0 + j * step;
            if (!skip(u, w)) out.push(...f(u, w), ...f(u, w));
        }
    }
    return out;
};
const floorAt = (y, x0, x1, z0, z1) => sheet(x0, x1, z0, z1, (x, z) => [x, y, z]);
// wall in the plane x = wx, optional gap over z in [g0, g1)
const wallX = (wx, z0, z1, h, gap, step = 0.2) => {
    return sheet(0, h, z0, z1, (y, z) => [wx, y, z], (y, z) => gap && z >= gap[0] - 1e-9 && z < gap[1] - 1e-9, step);
};

// z where the route crosses the plane x = wx
const crossingZ = (route, wx) => {
    const i = route.points.findIndex(p => p.x > wx);
    const a = route.points[i - 1], b = route.points[i];
    return a.z + (b.z - a.z) * (wx - a.x) / (b.x - a.x);
};

// occ + levels built the way Suggest Views builds them
const navOf = (parts, { box = BIG_BOX, allowFlying = true } = {}) => {
    const flat = parts.flat();
    const inBox = [];
    for (let i = 0; i < flat.length; i += 3) {
        if (insideBox(flat[i], flat[i + 1], flat[i + 2], box)) inBox.push(flat[i], flat[i + 1], flat[i + 2]);
    }
    const occ = buildOccupancy(new Float32Array(inBox), V);
    const levels = findLevels(occ, Math.ceil(1.25 * 4), 8 * (EYE / 1.6) ** 2);
    return { occ, grid: buildNavGrid(occ, levels, box, EYE, allowFlying) };
};

const assertRouteFree = (grid, route) => {
    for (let i = 1; i < route.points.length; i++) {
        assert.ok(grid.lineFree(route.points[i - 1], route.points[i]), `segment ${i} free`);
    }
};


const curvePose = (x, y, z, t, fov = 60) => ({ position: { x, y, z }, target: { x: t[0], y: t[1], z: t[2] }, fov });
const angle = (a, b) => {
    const dot = a.x * b.x + a.y * b.y + a.z * b.z;
    return Math.acos(Math.min(1, dot / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z))));
};
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const evenFrames = poses => poses.map((_, i) => i * 20);
const CURVE_OPTS = { duration: 100000, smoothness: 1, loop: false };

// 0.9 m door (one free voxel) with keys either side, off to one side, so the
// spline through the simplified route clips the door frame
const doorPlan = () => {
    const wall = wallX(10, 0, 10, 4, [5, 5.9], 0.1);
    const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wall], { allowFlying: false });
    const keys = [curvePose(8.5, 2, 1, [8.5, 2, 0]), curvePose(11.5, 2, 1, [11.5, 2, 0]), curvePose(16, 2, 4, [17, 2, 4])];
    const routes = keys.slice(1).map((k, i) => findRoute(grid, keys[i].position, k.position)?.points ?? null);
    return { grid, keys, routes };
};

const fixPathChecks = {
    async 'path: route goes through the door gap'() {
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wallX(10, 0, 10, 4, [5, 6.2])], { allowFlying: false });
        const route = findRoute(grid, { x: 2, y: 2, z: 2 }, { x: 18, y: 2, z: 2 });
        assert.ok(route);
        assert.equal(route.fromSnapped, false);
        assert.equal(route.toSnapped, false);
        assertRouteFree(grid, route);
        const z = crossingZ(route, 10);
        assert.ok(z >= 5 && z <= 6.2, `crosses at z ${z}`);
        assert.ok(route.length > 16);
    },

    async 'path: route passes a 0.9 m door'() {
        const wall = wallX(10, 0, 10, 4, [5, 5.9], 0.1);
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wall], { allowFlying: false });
        const route = findRoute(grid, { x: 2, y: 2, z: 2 }, { x: 18, y: 2, z: 2 });
        assert.ok(route);
        assertRouteFree(grid, route);
        const z = crossingZ(route, 10);
        assert.ok(z >= 5 && z <= 5.9, `crosses at z ${z}`);
    },

    async 'path: route keeps to the middle of a wide opening'() {
        // 3 m opening at z 3.5..6.5, middle third 4.5..5.5; endpoints off to one side
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wallX(10, 0, 10, 4, [3.5, 6.5])], { allowFlying: false });
        const route = findRoute(grid, { x: 2, y: 2, z: 2 }, { x: 18, y: 2, z: 2 });
        assert.ok(route);
        const z = crossingZ(route, 10);
        assert.ok(z >= 4.5 && z <= 5.5, `crosses at z ${z}`);
    },

    async 'path: no route under a raised wall'() {
        // wall from 1.6 m to 4 m, box ceiling 3.5 m; the gap below has clear fly
        // cells, but they are less than eye height above the floor
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 3.5, z: 11 } };
        const wall = sheet(1.6, 4, 0, 10, (y, z) => [10, y, z]);
        const parts = [floorAt(0, 0, 20, 0, 10), wall];
        const from = { x: 2, y: 2, z: 5 }, to = { x: 18, y: 2, z: 5 };
        assert.equal(findRoute(navOf(parts, { box, allowFlying: false }).grid, from, to), null);
        const route = findRoute(navOf(parts, { box }).grid, from, to);
        for (const p of route?.points ?? []) assert.ok(p.y >= 2 - 1e-6, `${p.x},${p.y},${p.z} below eye height`);
    },

    // hole scenes sample mid-voxel: float32 points on a voxel boundary can
    // round into the hole
    async 'path: flying does not pass a one-voxel hole in a wall'() {
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 3.5, z: 11 } };
        const hole = (y, z) => y >= 1.6 - 1e-9 && y < 2 - 1e-9 && z >= 4.8 - 1e-9 && z < 5.2 - 1e-9;
        const wall = sheet(0.1, 4.1, 0.1, 10.1, (y, z) => [10.1, y, z], hole);
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wall], { box });
        assert.equal(findRoute(grid, { x: 2, y: 2, z: 5 }, { x: 18, y: 2, z: 5 }), null);
    },

    async 'path: flying does not pass a one-voxel hole in a ceiling'() {
        // slab at 4 m over the whole box; the hole column is open down to the floor
        const box = { min: { x: 0, y: -1, z: 0 }, max: { x: 20, y: 8, z: 10 } };
        const hole = (x, z) => x >= 10 - 1e-9 && x < 10.4 - 1e-9 && z >= 4.8 - 1e-9 && z < 5.2 - 1e-9;
        const slab = sheet(0.1, 20.1, 0.1, 10.1, (x, z) => [x, 4.1, z], hole);
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), slab], { box });
        assert.equal(findRoute(grid, { x: 2, y: 2, z: 5 }, { x: 17, y: 6, z: 5 }), null);
    },

    async 'path: closed wall is unreachable'() {
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wallX(10, 0, 10, 4)], { allowFlying: false });
        assert.equal(findRoute(grid, { x: 2, y: 2, z: 2 }, { x: 18, y: 2, z: 2 }), null);
    },

    async 'path: flying reaches an upper gallery'() {
        const parts = [floorAt(0, 0, 20, 0, 10), floorAt(4, 14, 20, 0, 10)];
        const from = { x: 2, y: 2, z: 5 }, to = { x: 17, y: 6, z: 5 };
        assert.equal(findRoute(navOf(parts, { allowFlying: false }).grid, from, to), null);
        const { grid } = navOf(parts, { allowFlying: true });
        const route = findRoute(grid, from, to);
        assert.ok(route);
        assertRouteFree(grid, route);
        assert.ok(Math.abs(route.points[route.points.length - 1].y - 6) < 1e-6);
    },

    async 'path: walking is preferred over flying'() {
        // ramp from the floor at x = 6 up to a platform at y = 2 from x = 14, off to the side (z < 4)
        const ramp = sheet(6, 14, 0, 4, (x, z) => [x, (x - 6) / 8 * 2, z]);
        const { occ, grid } = navOf([floorAt(0, 0, 20, 0, 10), ramp, floorAt(2, 14, 20, 0, 10)]);
        const route = findRoute(grid, { x: 2, y: 2, z: 5.5 }, { x: 17, y: 4, z: 5.5 });
        assert.ok(route);
        assertRouteFree(grid, route);
        // flying straight would be shorter
        assert.ok(route.length > Math.hypot(15, 2) + 0.4);
        for (const p of route.points) {
            const ix = Math.floor(p.x / V), iz = Math.floor(p.z / V);
            const iy = Math.floor(p.y / V + 1e-4);
            let ground = iy - 1;
            while (ground > -10 && !occ.occupied(ix, ground, iz)) ground--;
            assert.ok(iy <= ground + 1 + 4 + 1, `point ${p.x},${p.y},${p.z} above walking height`);
            assert.ok(iy >= ground + 1 + 4, `point ${p.x},${p.y},${p.z} below walking height`);
        }
    },

    async 'path: route stays inside the box'() {
        // walking round the wall end (z > 9.9) is shorter than the gap, but outside the box
        const parts = [floorAt(0, 0, 20, 0, 14), wallX(10, 0, 10, 4, [5, 6.2])];
        const from = { x: 2, y: 2, z: 9 }, to = { x: 18, y: 2, z: 9 };
        const open = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 3.5, z: 15 } };
        const outside = findRoute(navOf(parts, { box: open }).grid, from, to);
        assert.ok(outside);
        assert.ok(outside.points.some(p => p.z > 9.9));

        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 3.5, z: 9.9 } };
        const { grid } = navOf(parts, { box });
        const route = findRoute(grid, from, to);
        assert.ok(route);
        assertRouteFree(grid, route);
        for (const p of route.points) assert.ok(insideBox(p.x, p.y, p.z, box), `${p.x},${p.y},${p.z} in box`);
    },

    async 'path: routes across a 40 m box quickly'() {
        const box = { min: { x: 0, y: -1, z: 0 }, max: { x: 40, y: 15, z: 40 } };
        const walls = [wallX(10, 0, 30, 6), wallX(20, 10, 40, 6), wallX(30, 0, 30, 6)];
        const { grid } = navOf([floorAt(0, 0, 40, 0, 40), ...walls], { box });
        const start = performance.now();
        const route = findRoute(grid, { x: 1, y: 2, z: 1 }, { x: 39, y: 2, z: 39 });
        const ms = performance.now() - start;
        assert.ok(route);
        console.debug(`path: 40 m box routed in ${ms.toFixed(0)} ms`);
    },

    async 'path: simplify keeps every piece in free space'() {
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wallX(10, 0, 10, 4, [5, 6.2])], { allowFlying: false });
        const from = { x: 2, y: 2, z: 2 }, to = { x: 18, y: 2, z: 2 };
        const full = [from, ...findRoute(grid, from, to).points, to];
        const simple = simplifyRoute(grid, full);
        assert.ok(simple.length >= 3 && simple.length < full.length / 4, `${simple.length} of ${full.length} points`);
        assert.equal(simple[0], from);
        assert.equal(simple[simple.length - 1], to);
        for (let i = 1; i < simple.length; i++) assert.ok(grid.lineFree(simple[i - 1], simple[i]), `piece ${i} free`);
    },

    async 'path: detour looks ahead and turns to the next view'() {
        const route = Array.from({ length: 41 }, (_, i) => ({ x: i * 0.5, y: 2, z: 0 }));
        const from = curvePose(0, 2, 0, [0, 2, 5], 50), to = curvePose(20, 2, 0, [20, 2, -5], 70);
        const poses = detourPoses(route, from, to, EYE);
        assert.equal(poses.length, 39);
        const first = poses[0], last = poses[poses.length - 1];
        assert.ok(angle(sub(first.target, first.position), { x: 1, y: 0, z: 0 }) < 1e-6);
        assert.ok(Math.abs(Math.hypot(...Object.values(sub(first.target, first.position))) - EYE) < 1e-6);
        const toView = sub(to.target, last.position);
        assert.ok(angle(sub(last.target, last.position), toView) < angle({ x: 1, y: 0, z: 0 }, toView) / 5);
        assert.ok(Math.abs(poses[19].fov - 60) < 1e-6);
        assert.deepEqual(poses[10].position, route[11]);
    },

    async 'path: detours never look through their own position'() {
        // the next key looks back along the approach; for each route length the
        // look-ahead and the next view are opposite near the end
        for (const n of [13, 15, 20, 41]) {
            const route = Array.from({ length: n }, (_, i) => ({ x: i * 0.5, y: 2, z: 0 }));
            const end = route[n - 1].x;
            const from = curvePose(0, 2, 0, [1, 2, 0]), to = curvePose(end, 2, 0, [end - 10, 2, 0]);
            const poses = detourPoses(route, from, to, EYE);
            for (const p of poses) {
                const d = sub(p.target, p.position);
                const len = Math.hypot(d.x, d.y, d.z);
                assert.ok(Number.isFinite(len) && len >= 0.5 * EYE, `n ${n}: target ${len} from position`);
                assert.ok(Math.abs(d.y) < 1e-9, `n ${n}: level swing`);
            }
            const last = poses[poses.length - 1];
            assert.ok(angle(sub(last.target, last.position), { x: -1, y: 0, z: 0 }) < Math.PI / 2, `n ${n}: turned`);
        }
    },

    async 'path: curve check finds a wall crossing'() {
        const parts = [floorAt(0, 0, 20, 0, 10)];
        const keys = [curvePose(8, 2, 5, [8, 2, 4]), curvePose(12, 2, 5, [12, 2, 4])];
        const curve = buildCameraCurve(keys, [0, 30], CURVE_OPTS);
        assert.deepEqual(checkCurve(curve, [0, 30], navOf(parts).grid, [0, 30], 0.25 * V), []);
        const { grid } = navOf([...parts, wallX(10, 0, 10, 4)]);
        assert.deepEqual(checkCurve(curve, [0, 30], grid, [0, 30], 0.25 * V), [0]);
    },

    async 'path: curve check sees a crossing next to a free key'() {
        // the first key is in free space, less than one voxel from the wall
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wallX(10, 0, 10, 4)]);
        const keys = [curvePose(9.8, 2, 5, [9.8, 2, 4]), curvePose(12, 2, 5, [12, 2, 4])];
        assert.ok(grid.pointFree(keys[0].position));
        const curve = buildCameraCurve(keys, [0, 30], CURVE_OPTS);
        assert.deepEqual(checkCurve(curve, [0, 30], grid, [0, 30], 0.25 * V), [0]);
    },

    async 'path: planned detours give a collision-free curve'() {
        const { grid, keys, routes } = doorPlan();
        assert.ok(routes.every(r => r));
        let calls = 0;
        const retime = (poses) => {
            calls++;
            return evenFrames(poses);
        };
        const { poses, frames, blocked } = planDetours({ keys, routes, grid, eyeHeight: EYE, retime, curveOpts: CURVE_OPTS });
        assert.ok(calls > 1, 'refined');
        assert.deepEqual(blocked, []);
        assert.deepEqual(poses.filter(p => !p.auto).map(p => p.pose), keys);
        assert.ok(poses.some(p => p.auto));
        const curve = buildCameraCurve(poses.map(p => p.pose), frames, CURVE_OPTS);
        const userFrames = frames.filter((_, i) => !poses[i].auto);
        assert.deepEqual(checkCurve(curve, frames, grid, userFrames, 0.25 * V), []);
    },

    async 'path: loop routes and checks the closing segment'() {
        const wall = wallX(10, 0, 10, 4, [5, 5.9], 0.1);
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wall], { allowFlying: false });
        // A and B on one side, C behind the door: B -> C and C -> A cross it
        const keys = [curvePose(8.5, 2, 1, [8.5, 2, 0]), curvePose(8.5, 2, 8, [8.5, 2, 9]), curvePose(11.5, 2, 1, [11.5, 2, 0])];
        const routes = keys.map((k, i) => findRoute(grid, k.position, keys[(i + 1) % 3].position).points);
        const opts = { duration: 600, smoothness: 1, loop: true };
        const retime = poses => poses.map((_, i) => i * opts.duration / poses.length);
        const plan = planDetours({ keys, routes, grid, eyeHeight: EYE, retime, curveOpts: opts });
        assert.deepEqual(plan.blocked, []);
        const lastUser = plan.poses.findIndex(p => p.pose === keys[2]);
        assert.ok(plan.poses.slice(lastUser + 1).some(p => p.auto), 'closing detours after the last key');
        const curve = buildCameraCurve(plan.poses.map(p => p.pose), plan.frames, opts);
        const checked = [...plan.frames, plan.frames[0] + opts.duration];
        const userFrames = plan.frames.filter((_, i) => !plan.poses[i].auto);
        assert.deepEqual(checkCurve(curve, checked, grid, userFrames, 0.25 * V), []);

        // without a closing route the straight closing curve hits the wall and
        // only the closing segment is reported
        const open = planDetours({ keys, routes: [routes[0], routes[1], null], grid, eyeHeight: EYE, retime, curveOpts: opts });
        assert.deepEqual(open.blocked, [2]);
    },

    async 'path: refinement stops after four rounds'() {
        // the second key sits inside a 4 m thick block; the given route runs straight into it
        const block = [];
        for (let x = 9; x < 13; x += 0.2) block.push(wallX(x, 0, 10, 4));
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), ...block], { allowFlying: false });
        const keys = [curvePose(2, 2, 5, [3, 2, 5]), curvePose(11, 2, 5, [12, 2, 5])];
        const route = Array.from({ length: 21 }, (_, i) => ({ x: 2.2 + i * 0.4, y: 2, z: 5 }));
        let calls = 0;
        const retime = (poses) => {
            calls++;
            return evenFrames(poses);
        };
        const { blocked } = planDetours({ keys, routes: [route], grid, eyeHeight: EYE, retime, curveOpts: CURVE_OPTS });
        assert.deepEqual(blocked, [0]);
        assert.equal(calls, 5, `${calls} retimes`);

        const none = planDetours({ keys, routes: [null], grid, eyeHeight: EYE, retime: evenFrames, curveOpts: CURVE_OPTS });
        assert.deepEqual(none.blocked, [0]);
        assert.deepEqual(none.poses.map(p => p.auto), [false, false]);
    },

    async 'track: camera curve matches the track spline'() {
        const { events } = setup([[0], [60], [150]]);
        let current = null;
        events.on('camera.setPose', (pose) => {
            current = { position: pose.position.clone(), target: pose.target.clone(), fov: pose.fov };
        });
        events.function('camera.getPose', () => current);
        const poses = events.invoke('camera.poses');
        const curve = buildCameraCurve(poses, poses.map(p => p.frame), { duration: 181, smoothness: 1, loop: false });
        assert.ok(curve);

        for (const f of [0, 37, 120]) {
            events.fire('timeline.frame', f);
            const out = curve(f, { position: new Vec3(), target: new Vec3(), fov: 0 });
            for (const k of ['position', 'target']) {
                for (const c of ['x', 'y', 'z']) {
                    assert.ok(Math.abs(out[k][c] - current[k][c]) < 1e-6, `${k}.${c} at ${f}`);
                }
            }
            assert.ok(Math.abs(out.fov - current.fov) < 1e-6);
        }
        assert.equal(buildCameraCurve([poses[0]], [0], { duration: 181, smoothness: 1, loop: false }), null);
    },

    async 'track: auto flag survives undo and serialization'() {
        const { events, ops } = setup([[0], [60]]);
        events.fire('track.replacePath', [pathPose('a', 0, 0), pathPose('b', 30, 5, true), pathPose('c', 60, 10)]);
        assert.deepEqual(autoFlags(events), [false, true, false]);

        await ops[0].undo();
        assert.deepEqual(autoFlags(events), [false, false]);
        await ops[0].do();
        assert.deepEqual(autoFlags(events), [false, true, false]);

        const sets = events.invoke('docSerialize.poseSets');
        assert.deepEqual(sets[0].poses.map(p => 'auto' in p), [false, true, false]);
        const other = setup([]);
        other.events.invoke('docDeserialize.poseSets', sets);
        assert.deepEqual(autoFlags(other.events), [false, true, false]);
    },

    async 'track: moving an auto key makes it normal'() {
        const { events } = setup([[0], [60]]);
        events.fire('track.replacePath', [pathPose('a', 0, 0), pathPose('b', 30, 5, true), pathPose('c', 60, 10)]);
        events.fire('track.moveKey', 30, 40);
        assert.deepEqual(autoFlags(events), [false, false, false]);
    },

    async 'track: replacePath is one undo step'() {
        const { events, ops } = setup([[0], [30, 1.5], [60]]);
        const names = () => events.invoke('camera.poses').map(p => p.name);
        events.fire('track.replacePath', [pathPose('x', 90, 0), pathPose('y', 10, 5), pathPose('z', 50, 9)]);
        assert.equal(ops.length, 1);
        assert.deepEqual([...events.invoke('track.keys')], [10, 50, 90]);
        assert.deepEqual(names(), ['y', 'z', 'x']);

        await ops[0].undo();
        assert.deepEqual([...events.invoke('track.keys')], [0, 30, 60]);
        assert.deepEqual(names(), ['camera_0', 'camera_1', 'camera_2']);
        assert.deepEqual(events.invoke('camera.keyLingers'), [{ frame: 30, linger: 1.5 }]);
    },

    async 'path: order is the shortest open tour from the first key'() {
        const xs = [0, 30, 10, 40, 20];
        const { order, unreachable } = orderKeys(distOf(xs.map(x => [x, 0])), { loop: false, keepOrder: false });
        assert.deepEqual(order, [0, 2, 4, 1, 3]);
        assert.deepEqual(unreachable, []);
    },

    async 'path: loop order minimises the closed tour'() {
        const pts = [[0, 0], [1, 1], [1, 0], [0, 1]];
        const { order } = orderKeys(distOf(pts), { loop: true, keepOrder: false });
        assert.equal(order[0], 0);
        assert.equal(tourLength(distOf(pts), order, true), 4);
    },

    async 'path: unreachable keys go to the end'() {
        const d = distOf([[0, 0], [5, 0], [1, 0], [3, 0]]);
        for (let i = 0; i < 4; i++) {
            if (i !== 2) d[i][2] = d[2][i] = Infinity;
        }
        const { order, unreachable } = orderKeys(d, { loop: false, keepOrder: false });
        assert.deepEqual(order, [0, 3, 1, 2]);
        assert.deepEqual(unreachable, [2]);
    },

    async 'path: keep my order keeps the order'() {
        const d = distOf([[0, 0], [5, 0], [1, 0], [3, 0]]);
        d[0][3] = d[3][0] = Infinity;
        const { order, unreachable } = orderKeys(d, { loop: false, keepOrder: true });
        assert.deepEqual(order, [0, 1, 2, 3]);
        assert.deepEqual(unreachable, [3]);
    },

    async 'path: large sets use the heuristic'() {
        const n = 20;
        const pts = Array.from({ length: n }, (_, i) => {
            const a = (i * 7 % n) / n * 2 * Math.PI;
            return [Math.cos(a), Math.sin(a)];
        });
        const d = distOf(pts);
        const { order } = orderKeys(d, { loop: true, keepOrder: false });
        assert.equal(order.length, n);
        assert.equal(new Set(order).size, n);
        assert.equal(order[0], 0);
        assert.ok(tourLength(d, order, true) < 2 * Math.PI * 1.05);
    }
};

export { fixPathChecks };
