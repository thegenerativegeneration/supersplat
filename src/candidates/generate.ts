import { insideBox, type Box } from './estimate';
import { findLevels } from './levels';
import { buildOccupancy } from './occupancy';
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

const pointsInBox = (points: Float32Array, box: Box) => {
    const out = new Float32Array(points.length);
    let n = 0;
    for (let i = 0; i + 2 < points.length; i += 3) {
        const x = points[i], y = points[i + 1], z = points[i + 2];
        if (insideBox(x, y, z, box)) {
            out[n++] = x;
            out[n++] = y;
            out[n++] = z;
        }
    }
    return out.subarray(0, n);
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
    signal: AbortSignal
): Promise<GenerateResult> => {
    const { box, eyeHeight, budget, seed } = opts;
    const occ = buildOccupancy(pointsInBox(points, box), eyeHeight / VOXELS_PER_EYE);
    const minArea = 8 * (eyeHeight / 1.6) ** 2;
    const levels = findLevels(occ, HEAD_VOXELS, minArea);
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

export { runGeneration, THUMB_HEIGHT, THUMB_WIDTH };
export type { GenerateDeps, GenerateOptions, GenerateResult, LevelInfo };
