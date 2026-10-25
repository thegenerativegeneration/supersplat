import assert from 'node:assert/strict';

import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { buildNavGrid, clampOpening, NAV_HEAD_VOXELS, navHeadVoxels } from './.build/src/path/nav-grid.js';
import { keyRoutes } from './.build/src/path/key-graph.js';
import { findRoute } from './.build/src/path/route.js';

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

// floor at 0, ceiling at 2.8 and a 1.2 m thick wall at x = 10 whose only
// gap is a band of free voxel rows from y0 to y1 (multiples of 0.4)
const bandRoom = (y0, y1) => new Float32Array([
    ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
    ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]),
    ...[10, 10.4, 10.8].flatMap(x => sheet(0, 2.8, 0, 10, (y, z) => [x + 0.2, y, z], y => y >= y0 && y < y1))
]);

// thin wall at x = 10 with a window from 0.9 to 2.1 m (z 2 .. 8) and desks
// with tops at 0.85 m along both sides
const deskRoom = () => new Float32Array([
    ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
    ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]),
    ...sheet(0, 2.8, 0, 10, (y, z) => [10.2, y, z], (y, z) => z >= 2 && z < 8 && y >= 0.9 && y < 2.1),
    ...sheet(8.8, 10, 0, 10, (x, z) => [x, 0.85, z]),
    ...sheet(10.4, 11.6, 0, 10, (x, z) => [x, 0.85, z])
]);

// walking route across the band room with the given smallest opening
const bandRoute = (points, opening, allowFlying = false) => {
    const { occ, levels } = buildSceneGrid(points, BOX, EYE, navHeadVoxels(EYE, opening));
    const grid = buildNavGrid(occ, levels, BOX, EYE, allowFlying, opening);
    return findRoute(grid, { x: 3, y: 2, z: 5.4 }, { x: 17, y: 2, z: 5.4 });
};

// summed step costs along a route of cell centres
const costOf = (grid, points) => {
    let cost = 0;
    for (let k = 1; k < points.length; k++) {
        const to = grid.cellOf(points[k]);
        cost += grid.neighbours(grid.cellOf(points[k - 1])).find(n => n.cell === to).cost;
    }
    return cost;
};

const walkRoute = (points, fy, allowFlying = false) => {
    const { occ, levels } = buildSceneGrid(points, BOX, EYE, NAV_HEAD_VOXELS);
    const grid = buildNavGrid(occ, levels, BOX, EYE, allowFlying);
    return findRoute(grid, { x: 3, y: fy + 2, z: 5.4 }, { x: 17, y: fy + 2, z: 5.4 });
};

// edges reached from start that have no edge back
const oneWayEdges = (grid, start) => {
    const seen = new Set([start]), open = [start];
    let count = 0;
    while (open.length) {
        const u = open.pop();
        for (const { cell } of grid.neighbours(u)) {
            if (!grid.neighbours(cell).some(n => n.cell === u)) count++;
            if (!seen.has(cell)) {
                seen.add(cell);
                open.push(cell);
            }
        }
    }
    return { cells: seen.size, count };
};

const navDoorsChecks = {
    'path: a key reached only one way has no route back'() {
        // cells 0..3 on a line; 2 -> 3 has no edge back
        const edges = [[1], [0, 2], [1, 3], []];
        const grid = {
            voxel: 1,
            cellOf: p => Math.round(p.x),
            nearestFree: () => null,
            centre: c => ({ x: c, y: 0, z: 0 }),
            neighbours: c => edges[c].map(cell => ({ cell, cost: 1 }))
        };
        const routes = keyRoutes(grid, [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }]);
        assert.equal(routes.length(0, 1), 3);
        assert.equal(routes.length(1, 0), Infinity);
        assert.equal(routes.points(1, 0), null);
    },

    'path: walk steps over uneven ground go both ways'() {
        // voxel-sized floor tiles at heights of 0, 1 or 2 voxels
        const v = EYE / 4;
        const tiles = [];
        for (let i = 0; i < 20; i++) {
            for (let j = 0; j < 20; j++) {
                const y = [0, 1, 2, 1][(i + 2 * j) % 4] * v;
                tiles.push(...sheet(i * v, (i + 1) * v, j * v, (j + 1) * v, (x, z) => [x, y, z]));
            }
        }
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 9, y: 6, z: 9 } };
        const { occ, levels } = buildSceneGrid(new Float32Array(tiles), box, EYE, NAV_HEAD_VOXELS);
        const grid = buildNavGrid(occ, levels, box, EYE, false);
        const { cells, count } = oneWayEdges(grid, grid.nearestFree({ x: 4, y: 1.6, z: 4 }, 4));
        assert.ok(cells > 300, `${cells} cells`);
        assert.equal(count, 0);
    },

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

    'path: a 0.8 m band routes at the default opening, not at 1.2 m'() {
        const points = bandRoom(1.6, 2.4);
        for (const allowFlying of [false, true]) {
            const route = bandRoute(points, 0.8, allowFlying);
            assert.ok(route, `default, flying ${allowFlying}`);
            // the camera stays in the free band while it crosses the wall
            for (const p of route.points.filter(q => q.x > 10 && q.x < 11.2)) {
                assert.ok(p.y >= 1.6 && p.y < 2.4, `in the band at ${p.y}`);
            }
            assert.equal(bandRoute(points, 1.2, allowFlying), null, `1.2 m, flying ${allowFlying}`);
        }
    },

    'path: a 0.4 m band routes only with an opening of 0.5 m or less'() {
        const points = bandRoom(2.0, 2.4);
        assert.equal(bandRoute(points, 0.8), null);
        assert.equal(bandRoute(points, 0.6), null);
        for (const opening of [0.5, 0.4]) {
            const route = bandRoute(points, opening);
            assert.ok(route, `opening ${opening}`);
            for (const p of route.points.filter(q => q.x > 10 && q.x < 11.2)) {
                assert.ok(p.y >= 2.0 && p.y < 2.4, `in the band at ${p.y}`);
            }
        }
    },

    'path: doors stay open at every opening setting'() {
        for (const height of [2.0, 2.1]) {
            for (const opening of [0.4, 0.8, 1.2, 1.6, 1.8, 2.0]) {
                assert.ok(bandRoute(room(0, height), opening), `${height} m door at ${opening}`);
            }
        }
    },

    // trade-off of low openings: a window over desks becomes a way through
    'path: a window over desks routes at the default, not at 1.2 m'() {
        const points = deskRoom();
        assert.ok(bandRoute(points, 0.8));
        assert.equal(bandRoute(points, 1.2), null);
    },

    'path: the smallest opening defaults to half the eye height and clamps'() {
        assert.equal(navHeadVoxels(EYE, 0.8), NAV_HEAD_VOXELS);
        assert.equal(navHeadVoxels(EYE, 2.0), 4);
        assert.equal(clampOpening(undefined, 1.6), 0.8);
        assert.equal(clampOpening(undefined, 3.2), 1.6);
        assert.equal(clampOpening(0.1, 1.6), 0.4);
        assert.equal(clampOpening(9, 1.6), 2.0);
        assert.equal(clampOpening(0.6, 1.6), 0.6);
        assert.equal(clampOpening(0.6, 3.2), 0.8);
    },

    'path: one search per key matches A* for every pair'() {
        const { occ, levels } = buildSceneGrid(room(0, 2.0), BOX, EYE, NAV_HEAD_VOXELS);
        const keys = [[3, 5.4], [17, 5.4], [1, 1], [19, 9], [2, 9], [18, 1], [8, 8]].map(([x, z]) => ({ x, y: 2, z }));
        for (const allowFlying of [false, true]) {
            const grid = buildNavGrid(occ, levels, BOX, EYE, allowFlying);
            const routes = keyRoutes(grid, keys);
            for (let i = 0; i < keys.length; i++) {
                for (let j = 0; j < keys.length; j++) {
                    if (i === j) continue;
                    const plain = findRoute(grid, keys[i], keys[j]);
                    const tag = `${allowFlying} ${i}->${j}`;
                    assert.ok(Math.abs(costOf(grid, routes.points(i, j)) - costOf(grid, plain.points)) < 1e-6, `cost ${tag}`);
                    assert.ok(Math.abs(routes.length(i, j) - plain.length) < 1e-6, `length ${tag}: ${routes.length(i, j)} vs ${plain.length}`);
                }
            }
        }
    },

    'path: keys behind a closed wall have no route'() {
        const keys = [{ x: 3, y: 2, z: 5 }, { x: 8, y: 2, z: 2 }, { x: 17, y: 2, z: 5 }];
        for (const allowFlying of [false, true]) {
            const { occ, levels } = buildSceneGrid(room(0, 0), BOX, EYE, NAV_HEAD_VOXELS);
            const routes = keyRoutes(buildNavGrid(occ, levels, BOX, EYE, allowFlying), keys);
            assert.ok(Number.isFinite(routes.length(0, 1)));
            assert.equal(routes.length(0, 2), Infinity);
            assert.equal(routes.points(2, 0), null);
        }
    }
};

export { bandRoom, navDoorsChecks, room, sheet };
