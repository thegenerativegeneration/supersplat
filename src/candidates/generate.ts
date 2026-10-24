import { insideBox, type Box } from './estimate';
import { EXTENT_STRIDE, MAX_RADIUS, type SplatExtents } from './extent';
import { findLevels, type Level } from './levels';
import { buildOccupancy, type Occupancy } from './occupancy';
import { mulberry32, sampleCandidates, shuffle, type Candidate } from './sample';
import { candidateScore, diversify, imageMetrics, rejectBeforeRender, type Scored } from './score';

type GenerateOptions = { box: Box, eyeHeight: number, budget: number, seed: number, fov?: number };

type LevelInfo = { index: number, height: number, area: number };

type GenerateDeps<T> = {
    sampleDistances: (cands: Candidate[]) => Promise<(number | null)[]>,
    renderAt: (cand: Candidate) => Promise<{ rgba: Uint8Array, thumbnail: T }>,
    restore: () => void,
    onProgress: (done: number, total: number) => void,
    onAdded: (scored: Scored, thumbnail: T) => void,
    onLevels: (levels: LevelInfo[]) => void
};

type GenerateResult = { scored: Scored[], reason?: 'noLevels' | 'cancelled' };

const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 200;
const DEFAULT_FOV = 60;
const VOXELS_PER_EYE = 4;
// a level needs 1.25 eye heights of free space above it, in whole voxels
const HEAD_VOXELS = Math.ceil(1.25 * VOXELS_PER_EYE);

// the points with centres inside the box, plus the extents (with their
// centres) of splats centred inside the box grown by MAX_RADIUS, since a
// large splat just outside a face still reaches into the box
const pointsInBox = (points: Float32Array, box: Box, extents?: SplatExtents): {
    points: Float32Array, extentPoints?: Float32Array, extents?: SplatExtents
} => {
    const out = new Float32Array(points.length);
    let n = 0;
    for (let i = 0; i + 2 < points.length; i += 3) {
        if (insideBox(points[i], points[i + 1], points[i + 2], box)) {
            out[n++] = points[i];
            out[n++] = points[i + 1];
            out[n++] = points[i + 2];
        }
    }
    const inside = out.subarray(0, n);
    if (!extents) return { points: inside };

    const grown = {
        min: { x: box.min.x - MAX_RADIUS, y: box.min.y - MAX_RADIUS, z: box.min.z - MAX_RADIUS },
        max: { x: box.max.x + MAX_RADIUS, y: box.max.y + MAX_RADIUS, z: box.max.z + MAX_RADIUS }
    };
    const outPoints = new Float32Array(points.length);
    const outExtents = new Float32Array(extents.length);
    let m = 0;
    for (let i = 0; i + 2 < points.length; i += 3) {
        if (insideBox(points[i], points[i + 1], points[i + 2], grown)) {
            const from = (i / 3) * EXTENT_STRIDE;
            outExtents.set(extents.subarray(from, from + EXTENT_STRIDE), (m / 3) * EXTENT_STRIDE);
            outPoints[m++] = points[i];
            outPoints[m++] = points[i + 1];
            outPoints[m++] = points[i + 2];
        }
    }
    return {
        points: inside,
        extentPoints: outPoints.subarray(0, m),
        extents: outExtents.subarray(0, (m / 3) * EXTENT_STRIDE)
    };
};

// Occupancy of the points (and splat extents, if given) inside the box at
// eyeHeight / VOXELS_PER_EYE and the levels in it whose surfaces have
// headVoxels free voxels above, shared by Suggest Views and Fix path.
const buildSceneGrid = (
    points: Float32Array,
    box: Box,
    eyeHeight: number,
    headVoxels = HEAD_VOXELS,
    extents?: SplatExtents
): { occ: Occupancy, levels: Level[] } => {
    const inBox = pointsInBox(points, box, extents);
    const occ = buildOccupancy(inBox.points, eyeHeight / VOXELS_PER_EYE, 2, inBox.extents, inBox.extentPoints);
    const minArea = 8 * (eyeHeight / 1.6) ** 2;
    return { occ, levels: findLevels(occ, headVoxels, minArea) };
};

// Finds levels in the points inside the box, samples candidate views, drops
// those that see nothing or face a wall, then renders and scores the rest in
// a seeded order that mixes levels. The result is score-sorted with near
// duplicates removed. restore runs once after any rendering, also on cancel
// or error.
const runGeneration = async <T>(
    deps: GenerateDeps<T>,
    points: Float32Array,
    opts: GenerateOptions,
    signal: AbortSignal,
    extents?: SplatExtents
): Promise<GenerateResult> => {
    const { box, eyeHeight, budget, seed } = opts;
    const { occ, levels } = buildSceneGrid(points, box, eyeHeight, HEAD_VOXELS, extents);
    deps.onLevels(levels.map((l, index) => ({ index, height: l.height, area: l.area })));
    if (levels.length === 0) return { scored: [], reason: 'noLevels' };

    const fov = opts.fov ?? DEFAULT_FOV;
    const sampled = sampleCandidates(levels, occ, { eyeHeight, box, fov, budget, seed });
    const order = shuffle(sampled, mulberry32(seed ^ 0x9E3779B9));
    if (signal.aborted) return { scored: [], reason: 'cancelled' };

    const distances = await deps.sampleDistances(order);
    const kept = order
    .map((cand, i) => ({ cand, depth: distances[i] }))
    .filter(k => !rejectBeforeRender(k.depth, eyeHeight));

    const scored: Scored[] = [];
    let rendered = false;
    let reason: GenerateResult['reason'];
    deps.onProgress(0, kept.length);
    try {
        for (const { cand, depth } of kept) {
            if (signal.aborted) {
                reason = 'cancelled';
                break;
            }
            rendered = true;
            const { rgba, thumbnail } = await deps.renderAt(cand);
            const metrics = imageMetrics(rgba, THUMB_WIDTH, THUMB_HEIGHT);
            const s: Scored = { ...cand, score: candidateScore(metrics, cand.pitch), depth };
            scored.push(s);
            deps.onAdded(s, thumbnail);
            deps.onProgress(scored.length, kept.length);
        }
    } finally {
        if (rendered) deps.restore();
    }

    return { scored: diversify(scored, eyeHeight), reason };
};

export { buildSceneGrid, runGeneration, THUMB_HEIGHT, THUMB_WIDTH, VOXELS_PER_EYE };
export type { GenerateDeps, GenerateOptions, GenerateResult, LevelInfo };
