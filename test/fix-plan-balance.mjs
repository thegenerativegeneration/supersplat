import assert from 'node:assert/strict';

import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { planFixPath } from './.build/src/path/fix-plan.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';
import { sheet } from './nav-doors.mjs';

const EYE = 1.6;
const BOX = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };

// floor, ceiling at 2.8 and a wall at x = 10 with a 1.3 m x 2.1 m door at z 5 .. 6.3
const doorGrid = () => {
    const points = new Float32Array([
        ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
        ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]),
        ...sheet(0, 2.8, 0, 10, (y, z) => [10, y, z], (y, z) => z >= 5 - 1e-9 && z < 6.3 - 1e-9 && y < 2.1)
    ]);
    const { occ, levels } = buildSceneGrid(points, BOX, EYE, NAV_HEAD_VOXELS);
    return buildNavGrid(occ, levels, BOX, EYE, false);
};

const fixKey = (name, x, z, t) => ({ name, position: { x, y: 1.6, z }, target: { x: t[0], y: 1.6, z: t[1] }, fov: 60, linger: 0, distance: 5 });

const fixPlanBalanceChecks = {
    'path: the Balance result belongs to the returned poses after a rejected prune trial'() {
        // the last prune trial of this plan is rejected
        const plan = planFixPath({
            keys: [fixKey('a', 2.52, 2.42, [3.52, 2.36]), fixKey('b', 12.23, 7.58, [13.18, 7.27]), fixKey('c', 9.98, 4.64, [9.59, 3.72])],
            grid: doorGrid(),
            eyeHeight: EYE,
            keepOrder: true,
            timeline: { frames: 60, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1 }
        });
        assert.ok(plan.balance.ok);
        assert.deepEqual(plan.balance.frames, plan.poses.map(p => p.frame));
    }
};

export { fixPlanBalanceChecks };
