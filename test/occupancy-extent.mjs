import assert from 'node:assert/strict';

import { Mat4, Quat, Vec3 } from 'playcanvas';

import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { readOpaquePoints } from './.build/src/candidates/read-points.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';
import { findRoute } from './.build/src/path/route.js';
import { fakeSplat } from './candidates.mjs';

const EYE = 1.6;
const V = EYE / 4;
const FROM = { x: 3, y: 2, z: 5.4 };
const TO = { x: 17, y: 2, z: 5.4 };

// dense small points (two per spot, every 0.1 m) over a sheet; f maps (u, w) to [x, y, z]
const sheet = (u0, u1, w0, w1, f, skip = () => false) => {
    const out = [];
    for (let i = 0; u0 + i * 0.1 < u1 - 1e-9; i++) {
        for (let j = 0; w0 + j * 0.1 < w1 - 1e-9; j++) {
            const u = u0 + i * 0.1, w = w0 + j * 0.1;
            if (!skip(u, w)) out.push(...f(u, w), ...f(u, w));
        }
    }
    return out;
};

// a cloud of [x, y, z, rx, ry, rz] splats (2σ radii, axis aligned) plus small points
const cloud = (big, small) => {
    const points = [...small], extents = [];
    for (let i = 0; i < small.length / 3; i++) extents.push(0.001, 0.001, 0.001, 0, 0, 0, 1);
    for (const [x, y, z, rx, ry, rz] of big) {
        points.push(x, y, z);
        extents.push(rx, ry, rz, 0, 0, 0, 1);
    }
    return { points: new Float32Array(points), extents: new Float32Array(extents) };
};

const floor = () => sheet(0, 20, 0, 10, (x, z) => [x, 0, z]);

// flat splats in the plane x = 10.2 on a lattice of centres from (y0, z0)
const lattice = (ys, zs, ry, rz, keep = () => true) => {
    const out = [];
    for (const y of ys) {
        for (const z of zs) {
            if (keep(y, z)) out.push([10.2, y, z, 0.01, ry, rz]);
        }
    }
    return out;
};

const route = ({ points, extents }, box, withExtents = true) => {
    const { occ, levels } = buildSceneGrid(points, box, EYE, NAV_HEAD_VOXELS, withExtents ? extents : undefined);
    return findRoute(buildNavGrid(occ, levels, box, EYE, true), FROM, TO);
};

const steps = (from, to, step) => {
    const out = [];
    for (let v = from; v < to + 1e-9; v += step) out.push(v);
    return out;
};

// wall at x = 10 (z 0 .. 10, up to 2.8 m) of large flat splats, except a
// band of small points around a 0.9 m x 2.0 m door at z 5 .. 5.9, under a
// ceiling at 2.8 m
const doorScene = (open) => {
    const zs = steps(0.45, 9.45, 0.9);
    const big = lattice([0.5, 1.5, 2.5], zs, 0.71, 0.64, (y, z) => z < 3.6 || z > 7.2);
    const band = sheet(0, 2.8, 3.4, 7.4, (y, z) => [10.2, y, z], (y, z) => open && z >= 5 && z < 5.9 && y < 2.0);
    return cloud(big, [...floor(), ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]), ...band]);
};

const occupiedCount = (occ) => [...occ.cells()].length;

const occupancyExtentChecks = {
    'occupancy: a roof of large flat splats blocks a route the centre rule lets through'() {
        // wall of small points up to 2.8 m, a sheet of 16 large splats on top
        const wall = sheet(0, 2.8, 0, 10, (y, z) => [10.2, y, z]);
        const big = lattice([3.5, 4.9], steps(0.7, 10.5, 1.4), 0.7, 0.7);
        assert.equal(big.length, 16);
        const scene = cloud(big, [...floor(), ...wall]);
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 5.5, z: 11 } };

        const leak = route(scene, box, false);
        assert.ok(leak, 'centre rule routes over the wall');
        assert.ok(leak.points.some(p => p.x > 10 && p.x < 10.4 && p.y > 2.8), 'crosses above the wall');
        assert.equal(route(scene, box), null);
    },

    'occupancy: a 0.9 m door in a wall of large splats still routes'() {
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };
        const through = route(doorScene(true), box);
        assert.ok(through, 'routes through the door');
        const at = through.points.find(p => p.x > 10 && p.x < 10.4);
        assert.ok(at.z >= 5 && at.z <= 5.9 && at.y < 2.0, `crosses at ${at.y}, ${at.z}`);
        // the big splats alone close the wall; their centres do not
        assert.equal(route(doorScene(false), box), null);
        assert.ok(route(doorScene(false), box, false), 'centre rule leaks through the big splats');
    },

    'occupancy: large splats whose ellipsoids end exactly at the door edges still route'() {
        // splats centred at z 4.4 / 6.3 reach exactly z 5.0 / 5.9 (door edges)
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };
        const big = lattice([0.5, 1.5, 2.5], [0.8, 2.0, 3.2, 4.4, 6.5, 7.7, 8.9, 10.1], 0.71, 0.6);
        const band = sheet(0, 2.8, 3.4, 7.4, (y, z) => [10.2, y, z], (y, z) => z >= 5 && z < 5.9 && y < 2.0);
        const scene = cloud(big, [...floor(), ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]), ...band]);
        assert.ok(route(scene, box), 'routes through the door');
    },

    'occupancy: large splats centred just outside the box still block inside it'() {
        // x = 10 is the box face; wall of big splats centred 0.5 m outside reaches 0.5 m in
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 10, y: 6, z: 11 } };
        const wall = [];
        for (const y of [0.5, 1.5, 2.5]) {
            for (const z of steps(0.45, 9.45, 0.9)) wall.push([10.5, y, z, 1, 0.71, 0.64]);
        }
        const scene = cloud(wall, [...floor(), ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z])]);
        const to = { x: 9.7, y: 2, z: 4.95 };
        const { occ, levels } = buildSceneGrid(scene.points, box, EYE, NAV_HEAD_VOXELS, scene.extents);
        assert.equal(occ.isFree(to, 0), false, 'extent reaches into the box');
        const reach = (g) => Math.max(...findRoute(buildNavGrid(g.occ, g.levels, box, EYE, true), FROM, to).points.map(p => p.x));
        const bare = buildSceneGrid(scene.points, box, EYE, NAV_HEAD_VOXELS);
        assert.ok(reach(bare) > 9.7, 'centre rule reaches the face');
        assert.ok(reach({ occ, levels }) < 9.6, 'the wall keeps the route off the face');
    },

    'occupancy: a huge floater marks at most a 1 m radius'() {
        const { points, extents } = cloud([[0.1, 0.1, 0.1, 3, 3, 3]], []);
        const occ = buildOccupancy(points, V, 2, extents);
        assert.equal(occ.occupied(0, 0, 0), true);
        for (const [ix, iy, iz] of occ.cells()) {
            const d = Math.hypot((ix + 0.5) * V - 0.1, (iy + 0.5) * V - 0.1, (iz + 0.5) * V - 0.1);
            assert.ok(d <= 1 + 1e-6, `voxel ${ix},${iy},${iz} at ${d}`);
        }
        assert.ok(occupiedCount(occ) > 50, `${occupiedCount(occ)} voxels`);
    },

    'occupancy: the radius cap and the grown box scale with the eye height'() {
        // a huge floater inside the box and a large splat 1.5 outside its face
        const big = [[3.13, 1.57, 3.31, 3, 3, 3], [11.53, 2.17, 5.11, 3, 3, 3]];
        const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } };
        const cellsAt = (scale) => {
            const { points, extents } = cloud(big.map(s => s.map(v => v * scale)), []);
            const scaled = { min: { x: 0, y: 0, z: 0 }, max: { x: 10 * scale, y: 5 * scale, z: 10 * scale } };
            const { occ } = buildSceneGrid(points, scale === 1 ? box : scaled, EYE * scale, NAV_HEAD_VOXELS, extents);
            return [...occ.cells()].map(c => c.join(',')).sort();
        };
        const metric = cellsAt(1);
        assert.ok(metric.length > 50, `${metric.length} voxels`);
        assert.deepEqual(cellsAt(0.1), metric);
    },

    'occupancy: small splats count by centre only and no extents keeps the old rule'() {
        const { points, extents } = cloud([[0.1, 0.1, 0.1, 0.19, 0.19, 0.19]], []);
        assert.equal(occupiedCount(buildOccupancy(points, V, 2, extents)), 0);
        const pair = cloud([[0.1, 0.1, 0.1, 0.5, 0.5, 0.5], [0.15, 0.1, 0.1, 0.5, 0.5, 0.5]], []);
        assert.equal(occupiedCount(buildOccupancy(pair.points, V)), 1);
    },

    async 'occupancy: readback turns splat extents into world space'() {
        // local splat: thin along its x, turned 90° about y (normal along z);
        // the layer turns 90° about x and scales by 2, so the normal points along y
        const local = new Quat().setFromEulerAngles(0, 90, 0);
        const geo = [local.w, local.x, local.y, local.z, Math.log(0.005), Math.log(0.2), Math.log(0.2), 5];
        const world = new Mat4().setTRS(new Vec3(1, 2.2, 3), new Quat().setFromEulerAngles(90, 0, 0), new Vec3(2, 2, 2));
        const { points, extents } = await readOpaquePoints([fakeSplat([[0, 0, 0, 5]], { world, geometricRows: [geo] })]);
        assert.deepEqual([...points], [1, 2.2, 3].map(Math.fround));
        const [rx, ry, rz, qx, qy, qz, qw] = extents;
        assert.ok(Math.abs(rx - 0.02) < 1e-6 && Math.abs(ry - 0.8) < 1e-6 && Math.abs(rz - 0.8) < 1e-6, `${[rx, ry, rz]}`);
        const normal = new Quat(qx, qy, qz, qw).transformVector(new Vec3(1, 0, 0));
        assert.ok(Math.abs(Math.abs(normal.y) - 1) < 1e-5, `normal ${normal}`);

        // a horizontal sheet: voxels beside the centre are marked, above and below not
        const occ = buildOccupancy(points, V, 2, extents);
        const [cx, cy, cz] = [1, 2.2, 3].map(c => Math.floor(c / V));
        assert.equal(occ.occupied(cx + 1, cy, cz), true);
        assert.equal(occ.occupied(cx, cy, cz + 1), true);
        assert.equal(occ.occupied(cx, cy + 1, cz), false);
        assert.equal(occ.occupied(cx, cy - 1, cz), false);
    }
};

export { occupancyExtentChecks };
