import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { buildCameraCurve } from './.build/src/anim/camera-curve.js';
import { insideBox } from './.build/src/candidates/estimate.js';
import { findLevels } from './.build/src/candidates/levels.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { buildNavGrid } from './.build/src/path/nav-grid.js';
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

const EYE = 1.6;
const V = EYE / 4;
const BIG_BOX = { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } };

// points on a grid spanning two axes, two per grid point; f maps (u, w) to [x, y, z]
const sheet = (u0, u1, w0, w1, f, skip = () => false) => {
    const out = [];
    for (let u = u0; u < u1 - 1e-9; u += 0.2) {
        for (let w = w0; w < w1 - 1e-9; w += 0.2) {
            if (!skip(u, w)) out.push(...f(u, w), ...f(u, w));
        }
    }
    return out;
};
const floorAt = (y, x0, x1, z0, z1) => sheet(x0, x1, z0, z1, (x, z) => [x, y, z]);
// wall in the plane x = wx, optional gap over z in [g0, g1); with 1-voxel
// clearance a gap needs 3 empty voxel columns, so 1.6 m at eye height 1.6
const wallX = (wx, z0, z1, h, gap) => sheet(0, h, z0, z1, (y, z) => [wx, y, z], (y, z) => gap && z >= gap[0] && z < gap[1]);

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

const fixPathChecks = {
    async 'path: route goes through the door gap'() {
        const { grid } = navOf([floorAt(0, 0, 20, 0, 10), wallX(10, 0, 10, 4, [4.8, 6.4])], { allowFlying: false });
        const route = findRoute(grid, { x: 2, y: 2, z: 2 }, { x: 18, y: 2, z: 2 });
        assert.ok(route);
        assert.equal(route.fromSnapped, false);
        assert.equal(route.toSnapped, false);
        assertRouteFree(grid, route);
        const i = route.points.findIndex(p => p.x > 10);
        const a = route.points[i - 1], b = route.points[i];
        const z = a.z + (b.z - a.z) * (10 - a.x) / (b.x - a.x);
        assert.ok(z >= 4.8 && z <= 6.4, `crosses at z ${z}`);
        assert.ok(route.length > 16);
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
        }
    },

    async 'path: route stays inside the box'() {
        // walking round the wall end (z > 10) is shorter than the gap, but outside the box
        const parts = [floorAt(0, 0, 20, 0, 14), wallX(10, 0, 10, 4, [4.8, 6.4])];
        const from = { x: 2, y: 2, z: 9 }, to = { x: 18, y: 2, z: 9 };
        const open = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 3.5, z: 15 } };
        const outside = findRoute(navOf(parts, { box: open }).grid, from, to);
        assert.ok(outside.points.some(p => p.z > 10.4));

        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 3.5, z: 10.4 } };
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
        assert.ok(ms < 2000, `took ${ms} ms`);
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
    }
};

export { fixPathChecks };
