import type { FixPlanReply, FixPlanRequest, ProgressFn } from './protocol';
import { insideBox, type Box } from '../candidates/estimate';
import type { SplatExtents } from '../candidates/extent';
import { buildSceneGrid } from '../candidates/generate';
import type { Vec3Like } from '../candidates/occupancy';
import { planFixPath, type FixKey, type FixPlan } from '../path/fix-plan';
import { buildNavGrid, navHeadVoxels, type NavGrid } from '../path/nav-grid';

// what the Fix Path grid depends on besides the points
type GridParams = Pick<FixPlanRequest, 'box' | 'eyeHeight' | 'opening' | 'allowFlying' | 'positions'>;

// box grown to hold each position outside it with margin on each side;
// positions inside leave it as it is
const boxAroundKeys = (box: Box, positions: Vec3Like[], margin: number): Box => {
    const min = { ...box.min }, max = { ...box.max };
    for (const p of positions) {
        if (insideBox(p.x, p.y, p.z, box)) continue;
        for (const axis of ['x', 'y', 'z'] as const) {
            min[axis] = Math.min(min[axis], p[axis] - margin);
            max[axis] = Math.max(max[axis], p[axis] + margin);
        }
    }
    return { min, max };
};

// The navigation grid in the area box. The graph stays inside the box; its
// occupancy also covers the keys outside it plus one eye height, so straight
// moves from far keys see the geometry on their way.
const buildFixGrid = (points: Float32Array, extents: SplatExtents | undefined, params: GridParams): NavGrid => {
    const { box, eyeHeight, opening, allowFlying, positions } = params;
    const { occ, levels } = buildSceneGrid(points, boxAroundKeys(box, positions, eyeHeight), eyeHeight, navHeadVoxels(eyeHeight, opening), extents);
    return buildNavGrid(occ, levels, box, eyeHeight, allowFlying, opening);
};

let cached: { points: Float32Array, key: string, grid: NavGrid } | null = null;

// the grid of the request, rebuilt when the points or its parameters change
const fixGrid = (points: Float32Array, extents: SplatExtents | undefined, req: FixPlanRequest, onProgress?: ProgressFn) => {
    const { version, box, eyeHeight, opening, allowFlying, positions } = req;
    const key = JSON.stringify({ version, box, eyeHeight, opening, allowFlying, positions: positions.map(p => [p.x, p.y, p.z]) });
    if (cached?.points !== points || cached.key !== key) {
        onProgress?.('grid');
        cached = { points, key, grid: buildFixGrid(points, extents, req) };
    }
    return cached.grid;
};

// the plan with each user key replaced by its index into keys
const replyOf = (plan: FixPlan, keys: FixKey[], box: Box): FixPlanReply => {
    const index = new Map(keys.map((k, i) => [k, i]));
    return {
        ...plan,
        poses: plan.poses.map(({ pose, frame, key }) => ({
            pose: { position: pose.position, target: pose.target, fov: pose.fov },
            frame,
            keyIndex: key ? index.get(key) : null
        })),
        box
    };
};

const runFixPlan = (points: Float32Array, extents: SplatExtents | undefined, req: FixPlanRequest, onProgress?: ProgressFn): FixPlanReply => {
    const grid = fixGrid(points, extents, req, onProgress);
    const { keys, eyeHeight, keepOrder, timeline } = req;
    return replyOf(planFixPath({ keys, grid, eyeHeight, keepOrder, timeline, onProgress }), keys, req.box);
};

export { boxAroundKeys, buildFixGrid, replyOf, runFixPlan };
