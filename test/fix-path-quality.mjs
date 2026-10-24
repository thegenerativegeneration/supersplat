import assert from 'node:assert/strict';

import { findLevels } from './.build/src/candidates/levels.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { planFixPath } from './.build/src/path/fix-plan.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';

const EYE = 1.6;
const V = EYE / 4;
const BOX = { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } };

// points on a grid spanning two axes, two per grid point; f maps (u, w) to [x, y, z]
const sheet = (u0, u1, w0, w1, f, skip = () => false, step = 0.2) => {
    const out = [];
    for (let i = 0; u0 + i * step < u1 - 1e-9; i++) {
        for (let j = 0; w0 + j * step < w1 - 1e-9; j++) {
            const u = u0 + i * step, w = w0 + j * step;
            if (!skip(u, w)) out.push(...f(u, w), ...f(u, w));
        }
    }
    return out;
};

// floor and a wall at x = 10 with a 0.9 m door at z 5 .. 5.9, walking only
const doorGrid = () => {
    const floor = sheet(0, 20, 0, 10, (x, z) => [x, 0, z]);
    const wall = sheet(0, 4, 0, 10, (y, z) => [10, y, z], (y, z) => z >= 5 - 1e-9 && z < 5.9 - 1e-9, 0.1);
    const occ = buildOccupancy(new Float32Array([...floor, ...wall]), V);
    return buildNavGrid(occ, findLevels(occ, NAV_HEAD_VOXELS, 8), BOX, EYE, false);
};

const key = (name, x, z, t) => ({ name, position: { x, y: 1.6, z }, target: { x: t[0], y: 1.6, z: t[1] }, fov: 60, linger: 0, distance: 5 });

// a, then b at x by the wall, then c behind the door
const plan = (grid, x, frames) => planFixPath({
    keys: [key('a', 3, 2, [3, 0]), key('b', x, 3, [8, 3]), key('c', 17, 8, [19, 8])],
    grid,
    eyeHeight: EYE,
    keepOrder: true,
    timeline: { frames, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1 }
});

// floor split by a closed wall at x = 10
const closedGrid = () => {
    const floor = sheet(0, 20, 0, 10, (x, z) => [x, 0, z]);
    const wall = sheet(0, 4, 0, 10, (y, z) => [10, y, z], () => false, 0.1);
    const occ = buildOccupancy(new Float32Array([...floor, ...wall]), V);
    return buildNavGrid(occ, findLevels(occ, NAV_HEAD_VOXELS, 8), BOX, EYE, false);
};

// keys sit at 1.6 m, route cells at 2 m: compare over the floor
const flatDistance = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

const fixPathQualityChecks = {
    'path: detour keys keep clear of user keys'() {
        const grid = doorGrid();
        for (const x of [10.05, 9.5, 9.2]) {
            const { poses, blocked } = plan(grid, x, 300);
            assert.deepEqual(blocked, [], `b at ${x}`);
            const users = poses.filter(p => p.key).map(p => p.pose.position);
            for (const p of poses.filter(q => !q.key)) {
                const near = Math.min(...users.map(u => flatDistance(u, p.pose.position)));
                assert.ok(near > V, `b at ${x}: detour ${near.toFixed(2)} m from a key`);
            }
        }
    },

    'path: a key against a wall needs at most two detours'() {
        const { detours, blocked } = plan(doorGrid(), 10.05, 300);
        assert.deepEqual(blocked, []);
        assert.ok(detours <= 2, `${detours} detours`);
    },

    'path: the group with most keys is planned, the rest is left out'() {
        for (const keepOrder of [false, true]) {
            const result = planFixPath({
                keys: [key('a', 17, 5, [19, 5]), key('b', 3, 2, [3, 0]), key('c', 6, 8, [6, 9]), key('d', 4, 5, [4, 7])],
                grid: closedGrid(),
                eyeHeight: EYE,
                keepOrder,
                timeline: { frames: 300, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1 }
            });
            assert.deepEqual(result.unreachable, ['a'], `keepOrder ${keepOrder}`);
            const names = result.poses.filter(p => p.key).map(p => p.key.name);
            assert.equal(names[0], 'b');
            assert.deepEqual(names.slice().sort(), ['b', 'c', 'd']);
            assert.deepEqual(result.blocked, []);
            assert.equal(result.poses[0].frame, 0);
        }
    },

    'path: no two keys of a fixed path are one frame apart'() {
        const grid = doorGrid();
        for (const x of [10.05, 9.5]) {
            const frames = plan(grid, x, 60).poses.map(p => p.frame);
            const gap = Math.min(...frames.slice(1).map((f, i) => f - frames[i]));
            assert.ok(gap > 1, `b at ${x}: gap ${gap}`);
        }
    }
};

export { fixPathQualityChecks };
