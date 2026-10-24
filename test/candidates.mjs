import assert from 'node:assert/strict';

import { Mat4 } from 'playcanvas';

import { estimateEyeHeight, estimateTiltDeg, proposeBox } from './.build/src/candidates/estimate.js';
import { buildSceneGrid, runGeneration } from './.build/src/candidates/generate.js';
import { findLevels } from './.build/src/candidates/levels.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { sampleCandidates } from './.build/src/candidates/sample.js';
import { readOpaquePoints } from './.build/src/candidates/read-points.js';
import { diversify, imageMetrics, rejectBeforeRender } from './.build/src/candidates/score.js';
import { registerCandidateEvents } from './.build/src/candidate-events.js';
import { Events } from './.build/src/events.js';
import { registerRenderEvents } from './.build/src/render.js';

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

const GREY = image((x, y) => ((x >> 2) + (y >> 2)) % 2 ? 200 : 60);

// generation deps that record calls; distanceOf(i) gives the i-th candidate's depth
const fakeDeps = ({ distanceOf = () => 5, onRender = () => {} } = {}) => {
    const log = { rendered: [], added: [], restores: 0, levels: null, distances: [] };
    const deps = {
        sampleDistances: async (cands) => {
            log.distances = cands.map((c, i) => distanceOf(i));
            return log.distances;
        },
        renderAt: async (cand) => {
            log.rendered.push(cand);
            onRender(log.rendered.length);
            return { rgba: GREY, thumbnail: cand.id };
        },
        restore: () => log.restores++,
        onProgress: () => {},
        onAdded: (scored, thumbnail) => log.added.push({ scored, thumbnail }),
        onLevels: (levels) => {
            log.levels = levels;
        }
    };
    return { deps, log };
};

const FLOOR_POINTS = new Float32Array(floor(0, 0, 10, 0, 10));
const GEN_OPTS = { box: BIG_BOX, eyeHeight: 1.6, budget: 12, seed: 1, fov: 60 };

// a splat-shaped object over one source chunk; rows are [x, y, z, opacityLogit],
// geometricRows optionally gives whole 8-float geometric rows
const fakeSplat = (rows, { flags = [], world = new Mat4(), visible = true, geometricRows = [] } = {}) => {
    const n = rows.length;
    const layouts = { position: { stride: 12, fields: {} }, geometric: { stride: 32, fields: {} } };
    return {
        visible,
        worldTransform: world,
        transformPalette: { getTransform: (i, m) => m.setIdentity() },
        instances: {
            count: n,
            numLocked: flags.filter(f => f & 2).length,
            sourceRow: Uint32Array.from(rows.map((r, i) => i)),
            flags: Uint8Array.from(rows.map((r, i) => flags[i] ?? 0)),
            transformIndex: () => 0
        },
        resource: {
            source: {
                meta: { chunkSize: 64, numChunks: [1], numGaussians: n, layouts },
                read: async ({ position, geometric }) => {
                    const pos = new Float32Array(position.data);
                    const geo = new Float32Array(geometric.data);
                    rows.forEach(([x, y, z, o], i) => {
                        pos.set([x, y, z], i * 3);
                        if (geometricRows[i]) geo.set(geometricRows[i], i * 8);
                        geo[i * 8 + 7] = o;
                    });
                }
            }
        }
    };
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
        assert.equal(n0, 176);
        assert.equal(n1, 64);
        assert.equal(n0 + n1, 240);
    },

    'candidates: small level gets the per-level minimum': async () => {
        const levels = [syntheticLevel(30, 16, 0, 1000), syntheticLevel(4, 4, 0, 10)];
        const occ = buildOccupancy(new Float32Array(0), VOXEL);
        const out = sampleCandidates(levels, occ, { eyeHeight: 1.6, box: BIG_BOX, fov: 60, budget: 240, seed: 1 });
        assert.ok(out.filter(c => c.level === 1).length >= 8);
        assert.equal(out.length, 240);
    },

    'candidates: per-level minimum respects the budget': async () => {
        const levels = Array.from({ length: 40 }, (v, i) => syntheticLevel(4, 4, 0, 100 - i));
        const occ = buildOccupancy(new Float32Array(0), VOXEL);
        const out = sampleCandidates(levels, occ, { eyeHeight: 1.6, box: BIG_BOX, fov: 60, budget: 240, seed: 1 });
        for (let i = 0; i < 40; i++) assert.equal(out.filter(c => c.level === i).length, 6);
        assert.equal(out.length, 240);
    },

    'candidates: budget below level count gives the largest levels one each': async () => {
        const levels = Array.from({ length: 10 }, (v, i) => syntheticLevel(4, 4, 0, 100 - i));
        const occ = buildOccupancy(new Float32Array(0), VOXEL);
        const out = sampleCandidates(levels, occ, { eyeHeight: 1.6, box: BIG_BOX, fov: 60, budget: 4, seed: 1 });
        assert.deepEqual(out.map(c => c.level), [0, 1, 2, 3]);
    },

    'candidates: low room is found with finer voxels': async () => {
        const occ = buildOccupancy(new Float32Array([...floor(0, 0, 10, 0, 10), ...floor(2.6, 0, 10, 0, 10)]), 0.4);
        const levels = findLevels(occ, 5, 8);
        assert.ok(levels.some(l => Math.abs(l.height) <= 0.4), `${levels.map(l => l.height)}`);
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

    'candidates: near wall threshold is 0.75 eye heights': async () => {
        assert.equal(rejectBeforeRender(1.19, 1.6), true);
        assert.equal(rejectBeforeRender(1.21, 1.6), false);
        assert.equal(rejectBeforeRender(null, 1.6), true);
    },

    'candidates: diversify drops near duplicates': async () => {
        const at = (id, x, azimuth, score) => ({ id, position: { x, y: 0, z: 0 }, azimuth, score, depth: 3 });
        assert.equal(diversify([at('a', 0, 0, 1), at('b', 0.1, 0, 0.5)], 0.45).length, 1);
        assert.equal(diversify([at('a', 0, 0, 1), at('b', 0, 180, 0.5)], 0.45).length, 2);
        assert.equal(diversify([at('a', 0, 350, 1), at('b', 0, 10, 0.5)], 0.45).length, 1);
    },

    'candidates: generation reports noLevels on an empty scene': async () => {
        const noise = new Float32Array(600).map((v, i) => ((i * 7919) % 1000) / 10);
        const { deps, log } = fakeDeps();
        const result = await runGeneration(deps, noise, GEN_OPTS, new AbortController().signal);
        assert.equal(result.reason, 'noLevels');
        assert.equal(result.scored.length, 0);
        assert.equal(log.rendered.length, 0);
        assert.equal(log.restores, 0);
    },

    'candidates: rejected candidates are never rendered': async () => {
        const { deps, log } = fakeDeps({ distanceOf: i => (i % 2 ? null : 5) });
        const result = await runGeneration(deps, FLOOR_POINTS, GEN_OPTS, new AbortController().signal);
        const kept = log.distances.filter(d => d !== null).length;
        assert.ok(kept > 0 && kept < log.distances.length);
        assert.equal(log.rendered.length, kept);
        assert.equal(result.reason, undefined);
        assert.equal(log.restores, 1);
        assert.deepEqual(log.levels.map(l => l.index), [0]);
        assert.ok(result.scored.every((s, i) => i === 0 || result.scored[i - 1].score >= s.score));
    },

    'candidates: generation finds a low room at a noisy eye height': async () => {
        const points = new Float32Array([...floor(0, 0, 10, 0, 10), ...floor(2.6, 0, 10, 0, 10)]);
        for (const eyeHeight of [1.6, 1.62]) {
            const { deps, log } = fakeDeps();
            await runGeneration(deps, points, { ...GEN_OPTS, eyeHeight }, new AbortController().signal);
            assert.ok(log.levels.some(l => Math.abs(l.height) <= 0.5), `${eyeHeight}: ${log.levels.map(l => l.height)}`);
        }
    },

    'candidates: cancel stops rendering and keeps results': async () => {
        const controller = new AbortController();
        const { deps, log } = fakeDeps({ onRender: n => n === 3 && controller.abort() });
        const result = await runGeneration(deps, FLOOR_POINTS, GEN_OPTS, controller.signal);
        assert.equal(result.reason, 'cancelled');
        assert.equal(log.added.length, 3);
        assert.ok(result.scored.length >= 1 && result.scored.length <= 3);
        assert.equal(log.restores, 1);
    },

    'candidates: camera restored after render error': async () => {
        const { deps, log } = fakeDeps({
            onRender: (n) => {
                if (n === 2) throw new Error('render failed');
            }
        });
        await assert.rejects(runGeneration(deps, FLOOR_POINTS, GEN_OPTS, new AbortController().signal), /render failed/);
        assert.equal(log.restores, 1);
    },

    'candidates: render order mixes levels': async () => {
        const points = new Float32Array([...floor(0, 0, 10, 0, 10), ...floor(4, 0, 10, 0, 10)]);
        const { deps, log } = fakeDeps();
        await runGeneration(deps, points, { ...GEN_OPTS, budget: 40 }, new AbortController().signal);
        const order = log.rendered.map(c => c.level);
        const switches = order.filter((l, i) => i > 0 && l !== order[i - 1]).length;
        assert.ok(switches > 2, `${order}`);
    },

    'candidates: point readback skips hidden, transparent and invalid splats': async () => {
        const world = new Mat4().setTranslate(10, 0, 0);
        const shown = fakeSplat([[1, 2, 3, 5], [4, 5, 6, -5], [7, 8, 9, 5], [NaN, 0, 0, 5]], { flags: [0, 0, 2, 0], world });
        const hiddenLayer = fakeSplat([[0, 0, 0, 5]], { visible: false });
        assert.deepEqual([...(await readOpaquePoints([shown, hiddenLayer])).points], [11, 2, 3]);
    },

    'candidates: point readback subsamples to maxPoints': async () => {
        const rows = Array.from({ length: 40 }, (v, i) => [i, 0, 0, 5]);
        const { points: out } = await readOpaquePoints([fakeSplat(rows)], 10);
        assert.equal(out.length, 30);
        assert.ok(out[3 * 9] > 30, `${out}`);
    },

    'candidates: a slab of faint splats is a level under the density rule only': async () => {
        // 6 x 6 m slab at eye 1.6 (voxel 0.4): four splats of opacity 0.05 per voxel
        const list = [];
        for (let ix = 0; ix < 15; ix++) {
            for (let iz = 0; iz < 15; iz++) {
                for (let k = 0; k < 4; k++) list.push([(ix + 0.5) * 0.4, 0.2, (iz + 0.5) * 0.4, 0.05, 0.05, 0.05, 0, 0, 0, 1, 0.05]);
            }
        }
        const density = new Float32Array(list.flat());
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 7, y: 4, z: 7 } };
        const none = new Float32Array(0);
        assert.equal(buildSceneGrid(none, box, 1.6).levels.length, 0);
        assert.equal(buildSceneGrid(none, box, 1.6, undefined, undefined, density).levels.length, 1);
    },

    'candidates: the solid rule is shared, defaults to bodies and resets on scene.clear': async () => {
        const events = new Events();
        registerCandidateEvents(events, { getElementsByType: () => [] });
        assert.equal(events.invoke('candidates.solidRule'), 'bodies');
        events.fire('candidates.setSolidRule', 'density');
        assert.equal(events.invoke('candidates.solidRule'), 'density');
        assert.equal((await events.invoke('candidates.density')).length, 0);
        events.fire('scene.clear');
        assert.equal(events.invoke('candidates.solidRule'), 'bodies');
    },

    'candidates: image and video renders refuse while a locked render runs': async () => {
        const events = new Events();
        // any camera or target access would throw a TypeError instead of busy
        const scene = { lockedRenderMode: true, events };
        registerRenderEvents(scene, events);
        const started = [];
        events.on('startSpinner', () => started.push('spinner'));
        events.on('progressStart', () => started.push('progress'));
        await assert.rejects(events.invoke('render.image', { width: 8, height: 8 }), { code: 'busy' });
        await assert.rejects(events.invoke('render.video', {}, null), { code: 'busy' });
        assert.deepEqual(started, []);
        assert.equal(scene.lockedRenderMode, true);
    }
};

export { candidatesChecks, fakeSplat };
