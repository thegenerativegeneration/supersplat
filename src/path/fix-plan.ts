import { planDetours } from './detours';
import { keyRoutes, mainGroup, type KeyRoutes } from './key-graph';
import type { NavGrid } from './nav-grid';
import { orderKeys } from './order';
import type { Route } from './route';
import { balanceTiming, type BalanceInput, type BalanceResult } from '../anim/balance-timing';
import type { CurvePose } from '../anim/camera-curve';
import type { Vec3Like } from '../candidates/occupancy';

// a user key; distance is the sampled scene distance (non-finite: unknown)
type FixKey = CurvePose & { name: string, linger: number, distance: number };

type RouteFn = (grid: NavGrid, from: Vec3Like, to: Vec3Like) => Route | null;

type FixPlanInput = {
    // user keys by frame; the first key of the main group comes first
    keys: FixKey[],
    grid: NavGrid,
    eyeHeight: number,
    keepOrder: boolean,
    timeline: Omit<BalanceInput, 'keys'>,
    // routes each pair on its own instead of keyRoutes (for checks)
    route?: RouteFn
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

// Route distances between the given keys, dist[a][b] from keys[a] to
// keys[b]. With keepOrder they are not needed.
const distanceMatrix = (keys: number[], length: (i: number, j: number) => number, keepOrder: boolean) => keys.map(
    (i, a) => keys.map((j, b) => (keepOrder || a === b ? 0 : length(i, j)))
);

// Plans the main group of keys (the most keys that reach each other) and
// leaves the others out as unreachable. Orders the group by route distance
// (its earliest key first), adds detour keys so the camera curve stays in
// free space and times all keys with Balance. User keys keep their lingers;
// detours get none and time by their target distance.
const planFixPath = (input: FixPlanInput): FixPlan => {
    const { keys, grid, eyeHeight, keepOrder, timeline } = input;
    const start = performance.now();
    const positions = keys.map(k => k.position);
    const routes = input.route ? pairRoutes(grid, positions, input.route) : keyRoutes(grid, positions);
    // mainGroup assumes symmetric edges: keys reach each other when routes run both ways
    const main = mainGroup(keys.length, routes.length);
    const tour = orderKeys(distanceMatrix(main, routes.length, keepOrder), { loop: timeline.loop, keepOrder }).order.map(a => main[a]);
    const inMain = new Set(main);
    const unreachable = keys.map((_, i) => i).filter(i => !inMain.has(i));

    const n = tour.length;
    const segments = n < 2 ? 0 : timeline.loop ? n : n - 1;
    const segmentRoutes = Array.from({ length: segments }, (_, s) => routes.points(tour[s], tour[(s + 1) % n]));

    const user = new Map<CurvePose, FixKey>(keys.map(k => [k, k]));
    let balance: BalanceResult;
    const retime = (poses: CurvePose[]) => {
        balance = balanceTiming({
            ...timeline,
            keys: poses.map((p) => {
                const key = user.get(p);
                return { position: p.position, target: p.target, fov: p.fov, linger: key?.linger ?? 0, distance: key?.distance ?? NaN };
            })
        });
        return 'frames' in balance ? balance.frames : evenFrames(poses.length, timeline.frames, timeline.loop);
    };

    const ordered = tour.map(i => keys[i]);
    const routed = performance.now();
    const plan = planDetours({
        keys: ordered,
        routes: segmentRoutes,
        grid,
        eyeHeight,
        retime,
        curveOpts: { duration: timeline.frames, smoothness: timeline.smoothness, loop: timeline.loop }
    });

    const poses = plan.poses.map((p, i) => ({ pose: p.pose, frame: plan.frames[i], key: p.auto ? null : user.get(p.pose) }));
    const frameOf = new Map(poses.filter(p => p.key).map(p => [p.key, p.frame]));
    return {
        poses,
        detours: poses.filter(p => !p.key).length,
        blocked: plan.blocked.map(s => frameOf.get(ordered[s])),
        unreachable: unreachable.map(i => keys[i].name),
        insideGeometry: keys.filter(k => !grid.pointFree(k.position)).map(k => k.name),
        balance,
        times: { routes: routed - start, detours: performance.now() - routed },
        graph: routes.size
    };
};

export { evenFrames, planFixPath };
export type { FixKey, FixPlan, FixPlanInput, RouteFn };
