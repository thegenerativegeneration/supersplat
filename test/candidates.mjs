import assert from 'node:assert/strict';

import { findLevels } from './.build/src/candidates/levels.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';

const VOXEL = 0.8;

// horizontal grid of points at height y, two per grid point
const floor = (y, x0, x1, z0, z1, step = 0.2) => {
    const out = [];
    for (let x = x0; x < x1; x += step) {
        for (let z = z0; z < z1; z += step) {
            out.push(x, y, z, x, y, z);
        }
    }
    return out;
};

// wall in the plane x = 0
const wall = () => {
    const out = [];
    for (let y = 0; y < 3; y += 0.2) {
        for (let z = -2; z < 2; z += 0.2) {
            out.push(0, y, z, 0, y, z);
        }
    }
    return out;
};

const occupancyOf = (...parts) => buildOccupancy(new Float32Array(parts.flat()), VOXEL);

const candidatesChecks = {
    'candidates: lone splats are not occupied': async () => {
        const occ = buildOccupancy(new Float32Array([0.1, 0.1, 0.1]), VOXEL);
        assert.equal(occ.occupied(0, 0, 0), false);
    },

    'candidates: isFree false next to a wall': async () => {
        const occ = occupancyOf(wall());
        assert.equal(occ.isFree({ x: 0.3, y: 1, z: 0 }), false);
        assert.equal(occ.isFree({ x: 3, y: 1, z: 0 }), true);
    },

    'candidates: two stacked floors give two levels': async () => {
        const occ = occupancyOf(floor(0, 0, 10, 0, 10), floor(4, 0, 10, 0, 10));
        const levels = findLevels(occ, 3, 20);
        assert.equal(levels.length, 2);
        const heights = levels.map(l => l.height).sort((a, b) => a - b);
        assert.ok(Math.abs(heights[0] - 0) <= 0.8, `${heights}`);
        assert.ok(Math.abs(heights[1] - 4) <= 0.8, `${heights}`);
    },

    'candidates: small table is not a level': async () => {
        const occ = occupancyOf(floor(0, 0, 10, 0, 10), floor(0.8, 4, 5, 4, 5));
        assert.equal(findLevels(occ, 3, 20).length, 1);
    },

    'candidates: low ceiling removes the level': async () => {
        const occ = occupancyOf(floor(0, 0, 10, 0, 10), floor(1.6, 0, 10, 0, 10));
        const levels = findLevels(occ, 3, 20);
        assert.ok(levels.every(l => Math.abs(l.height) > 0.8), `${levels.map(l => l.height)}`);
    },

    'candidates: one-voxel step stays one level': async () => {
        const occ = occupancyOf(floor(0, 0, 5, 0, 10), floor(0.8, 5, 10, 0, 10));
        assert.equal(findLevels(occ, 3, 20).length, 1);
    }
};

export { candidatesChecks };
