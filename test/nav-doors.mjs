import assert from 'node:assert/strict';

import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';
import { components, findRoute } from './.build/src/path/route.js';

const EYE = 1.6;
const BOX = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };

// points every 0.1 m over a sheet, two per point; f maps (u, w) to [x, y, z]
const sheet = (u0, u1, w0, w1, f, skip = () => false, step = 0.1) => {
    const out = [];
    for (let i = 0; u0 + i * step < u1 - 1e-9; i++) {
        for (let j = 0; w0 + j * step < w1 - 1e-9; j++) {
            const u = u0 + i * step, w = w0 + j * step;
            if (!skip(u, w)) out.push(...f(u, w), ...f(u, w));
        }
    }
    return out;
};

// floor at fy, ceiling 2.8 m above it and a wall at x = 10 with a door
// (z 5 .. 5 + width, below fy + height)
const room = (fy, height, width = 0.9) => new Float32Array([
    ...sheet(0, 20, 0, 10, (x, z) => [x, fy, z]),
    ...sheet(0, 20, 0, 10, (x, z) => [x, fy + 2.8, z]),
    ...sheet(fy, fy + 2.8, 0, 10, (y, z) => [10, y, z], (y, z) => z >= 5 && z < 5 + width && y < fy + height)
]);

const walkRoute = (points, fy, allowFlying = false) => {
    const { occ, levels } = buildSceneGrid(points, BOX, EYE, NAV_HEAD_VOXELS);
    const grid = buildNavGrid(occ, levels, BOX, EYE, allowFlying);
    return findRoute(grid, { x: 3, y: fy + 2, z: 5.4 }, { x: 17, y: fy + 2, z: 5.4 });
};

const navDoorsChecks = {
    'path: walking and flying pass a 2 m high door under a ceiling'() {
        for (const [fy, allowFlying] of [[0, false], [0.15, false], [0.3, false], [0, true]]) {
            const route = walkRoute(room(fy, 2.0), fy, allowFlying);
            assert.ok(route, `floor at ${fy}, flying ${allowFlying}`);
            // the wall voxel column is x 10 .. 10.4
            const at = route.points.find(p => p.x > 10 && p.x < 10.4);
            assert.ok(at.z >= 5 && at.z <= 5.9, `crosses at z ${at.z}`);
            assert.ok(at.y < fy + 2.0, `below the lintel at ${at.y}`);
        }
    },

    'path: a 1 m high opening does not route'() {
        assert.equal(walkRoute(room(0, 1.0), 0), null);
        assert.equal(walkRoute(room(0, 1.0), 0, true), null);
    },

    'path: weighted routes estimate within twice the plain length'() {
        const { occ, levels } = buildSceneGrid(room(0, 2.0), BOX, EYE, NAV_HEAD_VOXELS);
        const pairs = [[[3, 5.4], [17, 5.4]], [[1, 1], [19, 9]], [[2, 9], [18, 1]], [[4, 3], [8, 8]]];
        for (const allowFlying of [false, true]) {
            const grid = buildNavGrid(occ, levels, BOX, EYE, allowFlying);
            for (const [[ax, az], [bx, bz]] of pairs) {
                const a = { x: ax, y: 2, z: az }, b = { x: bx, y: 2, z: bz };
                const plain = findRoute(grid, a, b).length;
                const weighted = findRoute(grid, a, b, 2).length;
                assert.ok(weighted >= plain - 1e-9 && weighted <= 2 * plain, `${allowFlying} ${ax},${az}: ${weighted} vs ${plain}`);
            }
        }
    },

    'path: components separate rooms behind a closed wall'() {
        for (const allowFlying of [false, true]) {
            const { occ, levels } = buildSceneGrid(room(0, 0), BOX, EYE, NAV_HEAD_VOXELS);
            const { same } = components(buildNavGrid(occ, levels, BOX, EYE, allowFlying));
            assert.equal(same({ x: 3, y: 2, z: 5 }, { x: 8, y: 2, z: 2 }), true);
            assert.equal(same({ x: 3, y: 2, z: 5 }, { x: 17, y: 2, z: 5 }), false);
        }
        const { occ, levels } = buildSceneGrid(room(0, 2.0), BOX, EYE, NAV_HEAD_VOXELS);
        assert.equal(components(buildNavGrid(occ, levels, BOX, EYE, false)).same({ x: 3, y: 2, z: 5 }, { x: 17, y: 2, z: 5 }), true);
    }
};

export { navDoorsChecks };
