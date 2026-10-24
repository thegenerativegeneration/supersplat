import assert from 'node:assert/strict';

import { buildCameraCurve } from './.build/src/anim/camera-curve.js';
import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { CAMERA_RADIUS_VOXELS, pointClearance } from './.build/src/path/clearance.js';
import { checkCurve } from './.build/src/path/curve-check.js';
import { planFixPath } from './.build/src/path/fix-plan.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';
import { sheet } from './nav-doors.mjs';

const EYE = 1.6;
const V = EYE / 4;
const BOX = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };
const CURVE_OPTS = { duration: 100000, smoothness: 1, loop: false };

// floor at 0 and a full-height wall in the voxel column x 10 .. 10.4
const wallGrid = (cameraRadius) => {
    const points = new Float32Array([
        ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
        ...sheet(0, 4, 0, 10, (y, z) => [10, y, z])
    ]);
    const { occ, levels } = buildSceneGrid(points, BOX, EYE, NAV_HEAD_VOXELS);
    return buildNavGrid(occ, levels, BOX, EYE, false, undefined, cameraRadius);
};

// floor, ceiling at 2.8 and a wall at x = 10 with a 1.3 m x 2.1 m door at z 5 .. 6.3
const doorGrid = () => {
    const points = new Float32Array([
        ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
        ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]),
        ...sheet(0, 2.8, 0, 10, (y, z) => [10, y, z], (y, z) => z >= 5 - 1e-9 && z < 6.3 - 1e-9 && y < 2.1)
    ]);
    const { occ, levels } = buildSceneGrid(points, BOX, EYE, NAV_HEAD_VOXELS);
    return buildNavGrid(occ, levels, BOX, EYE, false, undefined, CAMERA_RADIUS_VOXELS);
};

const fixKey = (name, x, z, t) => ({ name, position: { x, y: 1.6, z }, target: { x: t[0], y: 1.6, z: t[1] }, fov: 60, linger: 0, distance: 5 });

const curvePose = (x, z, t) => ({ position: { x, y: 2, z }, target: { x: t[0], y: 2, z: t[1] }, fov: 60 });

// distance from p to the nearest occupied box, by clamping p into each box
const bruteClearance = (occupied, v, p) => {
    let best = Infinity;
    for (let ix = -2; ix <= 2; ix++) {
        for (let iy = -2; iy <= 2; iy++) {
            for (let iz = -2; iz <= 2; iz++) {
                if (!occupied(ix, iy, iz)) continue;
                const c = [[p.x, ix], [p.y, iy], [p.z, iz]].map(([x, i]) => Math.min(Math.max(x, i * v), (i + 1) * v) - x);
                best = Math.min(best, Math.hypot(...c));
            }
        }
    }
    return best;
};

const clearanceChecks = {
    'path: point clearance matches brute force around the voxel'() {
        let seed = 7;
        const random = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };
        const v = 0.4;
        for (let trial = 0; trial < 200; trial++) {
            // occupied voxels only in the 3x3x3 around voxel (0, 0, 0)
            const full = new Set();
            for (let k = 0; k < 27; k++) if (random() < 0.15) full.add(k);
            const occupied = (ix, iy, iz) => Math.max(Math.abs(ix), Math.abs(iy), Math.abs(iz)) <= 1 &&
                full.has((ix + 1) + 3 * (iy + 1) + 9 * (iz + 1));
            const p = { x: random() * v, y: random() * v, z: random() * v };
            const got = pointClearance(occupied, v, p);
            const want = bruteClearance(occupied, v, p);
            assert.ok(got === want || Math.abs(got - want) < 1e-12, `trial ${trial}: ${got} vs ${want}`);
        }
        const one = (ix, iy, iz) => ix === 1 && iy === 0 && iz === 0;
        assert.equal(pointClearance(one, v, { x: 0.5, y: 0.2, z: 0.2 }), 0, 'inside');
        assert.ok(Math.abs(pointClearance(one, v, { x: 0.28, y: 0.2, z: 0.2 }) - 0.3 * v) < 1e-12, 'face');
        assert.equal(pointClearance(() => false, v, { x: 0.2, y: 0.2, z: 0.2 }), Infinity, 'none');
    },

    'path: radius 0 keeps the point test'() {
        const grid = wallGrid(0);
        for (const x of [9.99, 10.01, 9.5]) {
            const p = { x, y: 2, z: 5 };
            assert.equal(grid.sphereFree(p), grid.pointFree(p), `x ${x}`);
        }
    },

    'path: a curve 0.2 voxel from a wall collides only as a sphere'() {
        const x = 10 - 0.2 * V;
        const curve = buildCameraCurve([curvePose(x, 2, [x - 1, 2]), curvePose(x, 8, [x - 1, 8])], [0, 30], CURVE_OPTS);
        assert.deepEqual(checkCurve(curve, [0, 30], wallGrid(0), [], 0.25 * V), []);
        assert.deepEqual(checkCurve(curve, [0, 30], wallGrid(CAMERA_RADIUS_VOXELS), [], 0.25 * V), [0]);
    },

    'path: a key 0.1 voxel from a wall keeps its skip radius'() {
        const keys = [curvePose(10 - 0.1 * V, 5, [9, 5]), curvePose(6, 5, [5, 5])];
        const curve = buildCameraCurve(keys, [0, 30], CURVE_OPTS);
        const grid = wallGrid(CAMERA_RADIUS_VOXELS);
        assert.ok(grid.pointFree(keys[0].position));
        assert.deepEqual(checkCurve(curve, [0, 30], grid, [0, 30], 0.25 * V), []);
    },

    'path: a key 0.1 m before a wall does not hide the curve crossing it'() {
        const keys = [curvePose(9.9, 5, [9, 5]), curvePose(11.5, 5, [12, 5])];
        const curve = buildCameraCurve(keys, [0, 30], CURVE_OPTS);
        assert.deepEqual(checkCurve(curve, [0, 30], wallGrid(0), [0, 30], 0.25 * V), [0], 'radius off');
        assert.deepEqual(checkCurve(curve, [0, 30], wallGrid(CAMERA_RADIUS_VOXELS), [0, 30], 0.25 * V), [0], 'radius on');
    },

    'path: the Balance result belongs to the returned poses after a rejected prune trial'() {
        // the last prune trial of this plan is rejected
        const plan = planFixPath({
            keys: [fixKey('a', 6.92, 9.02, [7.01, 9.31]), fixKey('b', 6.56, 4.12, [6.4, 3.31]), fixKey('c', 12.56, 9.48, [12.48, 10.26])],
            grid: doorGrid(),
            eyeHeight: EYE,
            keepOrder: true,
            timeline: { frames: 60, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1 }
        });
        assert.ok(plan.balance.ok);
        assert.deepEqual(plan.balance.frames, plan.poses.map(p => p.frame));
    }
};

export { clearanceChecks };
