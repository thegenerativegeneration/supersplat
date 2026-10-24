import assert from 'node:assert/strict';

import { buildDensityOccupancy } from './.build/src/candidates/density.js';
import { findLevels } from './.build/src/candidates/levels.js';

const V = 0.4;

// splat list entries: [x, y, z, sx, sy, sz, opacity] with identity rotation
const pack = (list) => {
    const out = new Float32Array(list.length * 11);
    list.forEach(([x, y, z, sx, sy, sz, o], i) => out.set([x, y, z, sx, sy, sz, 0, 0, 0, 1, o], i * 11));
    return out;
};

const centre = i => (i + 0.5) * V;
const count = occ => [...occ.cells()].length;
const solo = { minCluster: 1 };

const densityChecks = {
    'density: an opaque splat marks its voxel, a voxel 2.5 sigma away stays free'() {
        const occ = buildDensityOccupancy(pack([[0.15, centre(0), centre(0), 0.1, 0.1, 0.1, 1]]), V, solo);
        assert.equal(occ.occupied(0, 0, 0), true);
        assert.equal(occ.occupied(1, 0, 0), false);
        assert.equal(occ.isFree({ x: 0.15, y: 0.2, z: 0.2 }, 0), false);
        assert.equal(occ.isFree({ x: 3, y: 3, z: 3 }), true);
    },

    'density: many faint splats add up to a solid voxel'() {
        const one = [centre(0), centre(0), centre(0), 0.1, 0.1, 0.1, 0.02];
        assert.equal(buildDensityOccupancy(pack([one]), V, solo).occupied(0, 0, 0), false);
        const occ = buildDensityOccupancy(pack(Array(10).fill(one)), V, solo);
        assert.equal(occ.occupied(0, 0, 0), true);
    },

    'density: a splat of opacity 0.09 alone stays free'() {
        const occ = buildDensityOccupancy(pack([[centre(0), centre(0), centre(0), 0.1, 0.1, 0.1, 0.09]]), V, solo);
        assert.equal(occ.occupied(0, 0, 0), false);
    },

    'density: a large flat splat marks voxels 2 m from its centre'() {
        const occ = buildDensityOccupancy(pack([[0.2, 0.2, 0.2, 3, 3, 0.02, 1]]), V, solo);
        assert.equal(occ.occupied(Math.floor(2.2 / V), 0, 0), true);
        assert.equal(occ.occupied(0, Math.floor(2.2 / V), 0), true);
        assert.equal(occ.occupied(0, 0, 3), false);
    },

    'density: a rotated splat extends along its rotated axis'() {
        // 90 degrees about z maps the long x axis onto y
        const s = Math.SQRT1_2;
        const data = new Float32Array([0.2, 0.2, 0.2, 2, 0.05, 0.05, 0, 0, s, s, 1]);
        const occ = buildDensityOccupancy(data, V, solo);
        assert.equal(occ.occupied(0, 4, 0), true);
        assert.equal(occ.occupied(4, 0, 0), false);
    },

    'density: small isolated clusters are dropped, large ones kept'() {
        const tiny = (ix, iy, iz) => [centre(ix), centre(iy), centre(iz), 0.01, 0.01, 0.01, 1];
        const list = [tiny(50, 0, 0), tiny(51, 0, 0)];
        for (let x = 0; x < 3; x++) {
            for (let y = 0; y < 3; y++) {
                for (let z = 0; z < 3; z++) list.push(tiny(x, y, z));
            }
        }
        const occ = buildDensityOccupancy(pack(list), V);
        assert.equal(count(occ), 27);
        assert.equal(occ.occupied(50, 0, 0), false);
        assert.equal(occ.occupied(1, 1, 1), true);
        assert.equal(count(buildDensityOccupancy(pack(list), V, solo)), 29);
    },

    'density: a scene without a solid voxel has no cells and no levels'() {
        const occ = buildDensityOccupancy(pack([[0, 0, 0, 0.1, 0.1, 0.1, 0.05]]), V);
        assert.equal(count(occ), 0);
        assert.deepEqual(findLevels(occ, 5, 0), []);
    }
};

export { densityChecks };
