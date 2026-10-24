import assert from 'node:assert/strict';

import { estimateEyeHeight, estimateTiltDeg, proposeBox } from './.build/src/candidates/estimate.js';
import { findLevels } from './.build/src/candidates/levels.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { sampleCandidates } from './.build/src/candidates/sample.js';
import { diversify, imageMetrics, rejectBeforeRender } from './.build/src/candidates/score.js';

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

// level of ncx x ncz surface cells at voxel row iy with a nominal area
const syntheticLevel = (ncx, ncz, iy, area) => {
    const cells = [];
    for (let x = 0; x < ncx; x++) {
        for (let z = 0; z < ncz; z++) cells.push([x, iy, z]);
    }
    return { cells, area, height: (iy + 0.5) * VOXEL };
};

const BIG_BOX = { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } };

const image = (grey, w = 320, h = 200) => {
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = grey(x, y);
            px[i + 3] = 255;
        }
    }
    return px;
};

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
    },

    'candidates: proposeBox ignores 2% outliers': async () => {
        const pts = [];
        for (let i = 0; i < 1000; i++) pts.push(Math.random(), Math.random(), Math.random());
        for (let i = 0; i < 10; i++) pts.push(1e3, 1e3, 1e3);
        const box = proposeBox(new Float32Array(pts));
        assert.ok(box.max.x < 2 && box.max.y < 2 && box.max.z < 2, JSON.stringify(box));
    },

    'candidates: tilt of a level floor is ~0': async () => {
        const flat = new Float32Array(floor(0, 0, 10, 0, 10));
        assert.ok(estimateTiltDeg(flat) < 2);

        const a = 15 * Math.PI / 180;
        const tilted = new Float32Array(flat.length);
        for (let i = 0; i < flat.length; i += 3) {
            tilted[i] = flat[i];
            tilted[i + 1] = flat[i + 1] * Math.cos(a) - flat[i + 2] * Math.sin(a);
            tilted[i + 2] = flat[i + 1] * Math.sin(a) + flat[i + 2] * Math.cos(a);
        }
        assert.ok(Math.abs(estimateTiltDeg(tilted) - 15) <= 2, `${estimateTiltDeg(tilted)}`);
    },

    'candidates: metric scene gets eye height 1.6': async () => {
        const pts = new Float32Array([...floor(0, 0, 20, 0, 20, 0.5), ...floor(4, 0, 20, 0, 20, 0.5)]);
        assert.equal(estimateEyeHeight(pts, proposeBox(pts)), 1.6);
    },

    'candidates: unitless room scales eye height': async () => {
        const pts = new Float32Array([...floor(0, 0, 2, 0, 2, 0.05), ...floor(0.5, 0, 2, 0, 2, 0.05)]);
        const h = estimateEyeHeight(pts, proposeBox(pts));
        assert.ok(h > 0.1 && h < 0.3, `${h}`);
    },

    'candidates: budget split by level area': async () => {
        const levels = [syntheticLevel(30, 16, 0, 300), syntheticLevel(20, 8, 0, 100)];
        const occ = buildOccupancy(new Float32Array(0), VOXEL);
        const out = sampleCandidates(levels, occ, { eyeHeight: 1.6, box: BIG_BOX, fov: 60, budget: 240, seed: 1 });
        const n0 = out.filter(c => c.level === 0).length;
        const n1 = out.filter(c => c.level === 1).length;
        assert.ok(Math.abs(n0 - 180) <= 8, `${n0}`);
        assert.ok(Math.abs(n1 - 60) <= 8, `${n1}`);
        assert.equal(n0 + n1, 240);
    },

    'candidates: positions are free and inside box': async () => {
        const occ = occupancyOf(floor(0, 0, 10, 0, 10));
        const levels = findLevels(occ, 3, 20);
        const box = { min: { x: 1, y: -1, z: 1 }, max: { x: 9, y: 6, z: 9 } };
        const out = sampleCandidates(levels, occ, { eyeHeight: 1.6, box, fov: 60, budget: 40, seed: 3 });
        assert.ok(out.length > 0);
        for (const c of out) {
            const p = c.position;
            assert.ok(occ.isFree(p));
            assert.ok(p.x >= box.min.x && p.x <= box.max.x && p.z >= box.min.z && p.z <= box.max.z);
            assert.ok(p.y >= box.min.y && p.y <= box.max.y);
            assert.ok(Math.abs(p.y - (levels[c.level].height + VOXEL + 1.6)) <= VOXEL + 1e-6, `${p.y}`);
            assert.ok(Math.abs(Math.hypot(c.direction.x, c.direction.y, c.direction.z) - 1) < 1e-6);
            assert.equal(c.fov, 60);
        }
    },

    'candidates: same seed gives same candidates': async () => {
        const occ = occupancyOf(floor(0, 0, 10, 0, 10));
        const levels = findLevels(occ, 3, 20);
        const opts = { eyeHeight: 1.6, box: BIG_BOX, fov: 60, budget: 30, seed: 7 };
        assert.deepEqual(sampleCandidates(levels, occ, opts), sampleCandidates(levels, occ, opts));
    },

    'candidates: flat grey image is all blur': async () => {
        const m = imageMetrics(image(() => 128), 320, 200);
        assert.equal(m.blur, 1);
        assert.equal(m.dark, 0);
    },

    'candidates: checkerboard has no blur': async () => {
        const m = imageMetrics(image((x, y) => ((x >> 3) + (y >> 3)) % 2 ? 255 : 0), 320, 200);
        assert.equal(m.blur, 0);
    },

    'candidates: black image is all dark': async () => {
        assert.equal(imageMetrics(image(() => 0), 320, 200).dark, 1);
    },

    'candidates: no hit or near wall rejected': async () => {
        assert.equal(rejectBeforeRender(null, 1.6), true);
        assert.equal(rejectBeforeRender(1.0, 1.6), true);
        assert.equal(rejectBeforeRender(5, 1.6), false);
    },

    'candidates: diversify drops near duplicates': async () => {
        const at = (id, x, azimuth, score) => ({ id, position: { x, y: 0, z: 0 }, azimuth, score, depth: 3 });
        assert.equal(diversify([at('a', 0, 0, 1), at('b', 0.1, 0, 0.5)], 0.45).length, 1);
        assert.equal(diversify([at('a', 0, 0, 1), at('b', 0, 180, 0.5)], 0.45).length, 2);
        assert.equal(diversify([at('a', 0, 350, 1), at('b', 0, 10, 0.5)], 0.45).length, 1);
    }
};

export { candidatesChecks };
