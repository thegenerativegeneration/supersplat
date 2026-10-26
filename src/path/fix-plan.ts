import { blockEnds, orbitBlocks, orderBlocks, segmentsInBlocks } from './blocks';
import { planDetours } from './detours';
import { keyRoutes, type KeyRoutes } from './key-graph';
import type { NavGrid } from './nav-grid';
import type { Route } from './route';
import { balanceTiming, type BalanceInput, type BalanceResult } from '../anim/balance-timing';
import type { CurvePose } from '../anim/camera-curve';
import type { Vec3Like } from '../candidates/occupancy';
import type { ProgressFn } from '../compute/protocol';

// a user key; distance is the sampled scene distance (non-finite: unknown);
// orbit: id of the orbit the key belongs to; lookAhead and turnIn come with CurvePose
type FixKey = CurvePose & { name: string, linger: number, distance: number, orbit?: string };

type RouteFn = (grid: NavGrid, from: Vec3Like, to: Vec3Like) => Route | null;

type FixPlanInput = {
    // user keys by frame; the first key of the main group comes first.
    // Consecutive keys of one orbit form a block that stays together.
    keys: FixKey[],
    grid: NavGrid,
    eyeHeight: number,
    keepOrder: boolean,
    timeline: Omit<BalanceInput, 'keys'>,
    // routes each pair on its own instead of keyRoutes (for checks)
    route?: RouteFn,
    // the routes and detours stages
    onProgress?: ProgressFn
};

type FixPlan = {
    // in playback order; key is the user key, null for a detour
    poses: { pose: CurvePose, frame: number, key: FixKey | null }[],
    detours: number,
    // frames of the keys that start a blocked segment
    blocked: number[],
    // names of the keys outside the main group, by frame; not in poses
    unreachable: string[],
    insideGeometry: string[],
    // the timing of the final poses; on failure they are evenly spaced
    balance: BalanceResult,
    // milliseconds spent routing and planning detours
    times: { routes: number, detours: number },
    // nodes and edges of the key components (keyRoutes only)
    graph?: KeyRoutes['size']
};

// n strictly ascending frames spread evenly over the timeline
const evenFrames = (n: number, frames: number, loop: boolean) => {
    if (n <= 1) return Array.from({ length: n }, () => 0);
    const span = loop ? frames / n : (frames - 1) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * span));
};

// symmetric route lookup between keys i and j, routed once per pair
const pairRoutes = (grid: NavGrid, positions: Vec3Like[], route: RouteFn): KeyRoutes => {
    const cache = new Map<number, Route | null>();
    const n = positions.length;
    const get = (i: number, j: number) => {
        const a = Math.min(i, j), b = Math.max(i, j);
        const k = a * n + b;
        if (!cache.has(k)) cache.set(k, route(grid, positions[a], positions[b]));
        return cache.get(k);
    };
    return {
        length: (i, j) => get(i, j)?.length ?? Infinity,
        points: (i, j) => {
            const r = get(i, j);
            if (!r) return null;
            return i < j ? r.points : r.points.slice().reverse();
        },
        size: undefined
    };
};

// Plans the main group of keys (the most keys that reach each other) and
// leaves the others out as unreachable. Orders the group by route distance
// (its earliest key first), adds detour keys so the camera curve stays in
// free space and times all keys with Balance. User keys keep their lingers;
// detours get none and time by their target distance. An orbit block moves
// as one: routed from its last key to the next block's first, kept or left
// out whole, and without detours between its keys.
const planFixPath = (input: FixPlanInput): FixPlan => {
    const { keys, grid, eyeHeight, keepOrder, timeline, onProgress } = input;
    const start = performance.now();
    const blocks = orbitBlocks(keys);
    // routes run between block ends only; node a is key ends[a]
    const ends = blockEnds(blocks);
    const node = new Map(ends.map((k, a) => [k, a]));
    const positions = ends.map(k => keys[k].position);
    const routes = input.route ? pairRoutes(grid, positions, input.route) : keyRoutes(grid, positions, onProgress);
    const tour = orderBlocks(blocks, ends, routes.length, { loop: timeline.loop, keepOrder });
    const inTour = new Set(tour);
    const unreachable = keys.map((_, i) => i).filter(i => !inTour.has(i));

    const n = tour.length;
    const segments = n < 2 ? 0 : timeline.loop ? n : n - 1;
    const fixed = segmentsInBlocks(blocks, tour, segments);
    const segmentRoutes = fixed.map((inBlock, s) => (inBlock ? [] : routes.points(node.get(tour[s]), node.get(tour[(s + 1) % n]))));
    // the keys left without a Dijkstra need none
    onProgress?.('routes', positions.length, positions.length);

    const user = new Map<CurvePose, FixKey>(keys.map(k => [k, k]));
    // the Balance result behind each frames array retime returns; planDetours
    // evaluates trials it may reject, so the result is looked up by the frames it kept
    const balances = new WeakMap<number[], BalanceResult>();
    const retime = (poses: CurvePose[]) => {
        const balance = balanceTiming({
            ...timeline,
            keys: poses.map((p) => {
                const key = user.get(p);
                return {
                    position: p.position,
                    target: p.target,
                    fov: p.fov,
                    linger: key?.linger ?? 0,
                    distance: key?.distance ?? NaN,
                    lookAhead: key?.lookAhead,
                    turnIn: key?.turnIn,
                    auto: !key
                };
            })
        });
        const frames = 'frames' in balance ? balance.frames : evenFrames(poses.length, timeline.frames, timeline.loop);
        balances.set(frames, balance);
        return frames;
    };

    const ordered = tour.map(i => keys[i]);
    const routed = performance.now();
    const plan = planDetours({
        keys: ordered,
        routes: segmentRoutes,
        fixed,
        grid,
        eyeHeight,
        retime,
        curveOpts: { duration: timeline.frames, smoothness: timeline.smoothness, loop: timeline.loop, frameRate: timeline.frameRate },
        onProgress
    });

    const poses = plan.poses.map((p, i) => ({ pose: p.pose, frame: plan.frames[i], key: p.auto ? null : user.get(p.pose) }));
    const frameOf = new Map(poses.filter(p => p.key).map(p => [p.key, p.frame]));
    return {
        poses,
        detours: poses.filter(p => !p.key).length,
        blocked: plan.blocked.map(s => frameOf.get(ordered[s])),
        unreachable: unreachable.map(i => keys[i].name),
        insideGeometry: keys.filter(k => !grid.pointFree(k.position)).map(k => k.name),
        balance: balances.get(plan.frames),
        times: { routes: routed - start, detours: performance.now() - routed },
        graph: routes.size
    };
};

export { evenFrames, planFixPath };
export type { FixKey, FixPlan, FixPlanInput, RouteFn };
