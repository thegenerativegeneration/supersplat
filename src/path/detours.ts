import { curveCollisions } from './curve-check';
import type { NavGrid } from './nav-grid';
import { buildCameraCurve, type CurveOptions, type CurvePose } from '../anim/camera-curve';
import type { Vec3Like } from '../candidates/occupancy';

type PlannedPose = { pose: CurvePose, auto: boolean };

type DetourInput = {
    // user keys in tour order
    keys: CurvePose[],
    // grid route of segment i (keys[i] to the next key), without the key
    // positions themselves; null when unreachable
    routes: (Vec3Like[] | null)[],
    grid: NavGrid,
    eyeHeight: number,
    retime: (poses: CurvePose[]) => number[],
    curveOpts: CurveOptions
};

type DetourPlan = { poses: PlannedPose[], frames: number[], blocked: number[] };

const MAX_ROUNDS = 4;
// curve check sample spacing, in voxels
const SAMPLE_VOXELS = 0.25;
// a new detour closer than this many voxels to an existing one is not added
const DUPLICATE_VOXELS = 1;

const distance = (a: Vec3Like, b: Vec3Like) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

const lerp = (a: Vec3Like, b: Vec3Like, t: number): Vec3Like => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
});

// Greedy line-of-sight shortcutting: from each kept point, go as far along
// the route as the straight piece stays free (at least one point). Keeps both
// endpoints.
const simplifyRoute = (grid: NavGrid, points: Vec3Like[]): Vec3Like[] => {
    if (points.length <= 2) return points.slice();
    const out = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
        let j = i + 1;
        while (j + 1 < points.length && grid.lineFree(points[i], points[j + 1])) j++;
        out.push(points[j]);
        i = j;
    }
    return out;
};

// cumulative arc length at each route point
const arcLengths = (route: Vec3Like[]) => {
    const s = [0];
    for (let i = 1; i < route.length; i++) s.push(s[i - 1] + distance(route[i - 1], route[i]));
    return s;
};

// point at arc length d along the route, clamped to its ends
const pointAt = (route: Vec3Like[], s: number[], d: number): Vec3Like => {
    if (d <= 0) return { ...route[0] };
    for (let i = 1; i < route.length; i++) {
        if (d <= s[i]) {
            const len = s[i] - s[i - 1];
            return len > 0 ? lerp(route[i - 1], route[i], (d - s[i - 1]) / len) : { ...route[i] };
        }
    }
    return { ...route[route.length - 1] };
};

// Poses for the interior points of route (from.position .. to.position).
// Target: the point eyeHeight further along the route, blended linearly
// towards to.target over the last 2 eyeHeight; fov linear in route distance.
const detourPoses = (route: Vec3Like[], from: CurvePose, to: CurvePose, eyeHeight: number): CurvePose[] => {
    const s = arcLengths(route);
    const total = s[s.length - 1];
    const blend = 2 * eyeHeight;
    const out: CurvePose[] = [];
    for (let i = 1; i < route.length - 1; i++) {
        const ahead = pointAt(route, s, s[i] + eyeHeight);
        const w = Math.min(1, Math.max(0, 1 - (total - s[i]) / blend));
        const u = total > 0 ? s[i] / total : 0;
        out.push({
            position: { ...route[i] },
            target: lerp(ahead, to.target, w),
            fov: from.fov + (to.fov - from.fov) * u
        });
    }
    return out;
};

// segment state: the full route from key to key and the indices into it of
// the detour points, ascending
type Segment = { full: Vec3Like[], detours: number[] };

const initialDetours = (grid: NavGrid, full: Vec3Like[]) => {
    const kept = new Set(simplifyRoute(grid, full));
    const out: number[] = [];
    for (let i = 1; i < full.length - 1; i++) {
        if (kept.has(full[i])) out.push(i);
    }
    return out;
};

// Working poses in curve order, each with the user segment it starts.
const assemble = (keys: CurvePose[], segments: (Segment | null)[], eyeHeight: number) => {
    const poses: PlannedPose[] = [];
    const owner: number[] = [];
    keys.forEach((key, i) => {
        poses.push({ pose: key, auto: false });
        owner.push(i);
        const seg = segments[i];
        if (!seg) return;
        const next = keys[(i + 1) % keys.length];
        const route = [key.position, ...seg.detours.map(d => seg.full[d]), next.position];
        for (const pose of detourPoses(route, key, next, eyeHeight)) {
            poses.push({ pose, auto: true });
            owner.push(i);
        }
    });
    return { poses, owner };
};

// Adds the interior route point nearest p as a detour, skipping points
// closer than DUPLICATE_VOXELS to an existing detour (adjacent route cells
// stay eligible); false when no point is left.
const insertDetour = (seg: Segment, p: Vec3Like, voxel: number) => {
    const min = DUPLICATE_VOXELS * voxel * (1 - 1e-6);
    let best = -1, bestDist = Infinity;
    for (let i = 1; i < seg.full.length - 1; i++) {
        const d = distance(seg.full[i], p);
        if (d < bestDist && seg.detours.every(k => distance(seg.full[k], seg.full[i]) >= min)) {
            bestDist = d;
            best = i;
        }
    }
    if (best < 0) return false;
    seg.detours.push(best);
    seg.detours.sort((a, b) => a - b);
    return true;
};

// Detour keys between consecutive user keys so the camera curve stays in
// free space: start from the simplified routes, retime, check the curve and
// add the full-route point nearest the first collision of each colliding
// curve segment, for up to MAX_ROUNDS rounds. Segments without a route, or
// still colliding, are blocked (indices into the user segments). For a loop,
// routes has one entry per key and the last runs back to the first key.
const planDetours = (input: DetourInput): DetourPlan => {
    const { keys, routes, grid, eyeHeight, retime, curveOpts } = input;
    const segments = routes.map((r, i): Segment | null => {
        if (!r) return null;
        const full = [keys[i].position, ...r, keys[(i + 1) % keys.length].position];
        return { full, detours: initialDetours(grid, full) };
    });
    const step = SAMPLE_VOXELS * grid.voxel;

    const evaluate = () => {
        const { poses, owner } = assemble(keys, segments, eyeHeight);
        const curvePoses = poses.map(p => p.pose);
        const frames = retime(curvePoses);
        const curve = buildCameraCurve(curvePoses, frames, curveOpts);
        if (!curve) return { poses, frames, collisions: [] };
        const checked = curveOpts.loop ? [...frames, frames[0] + curveOpts.duration] : frames;
        const userFrames = frames.filter((_, i) => !poses[i].auto);
        const collisions = curveCollisions(curve, checked, grid, userFrames, step)
        .map(c => ({ segment: owner[c.segment], point: c.point }));
        return { poses, frames, collisions };
    };

    let result = evaluate();
    for (let round = 0; round < MAX_ROUNDS && result.collisions.length > 0; round++) {
        let added = false;
        for (const { segment, point } of result.collisions) {
            const seg = segments[segment];
            if (seg) added = insertDetour(seg, point, grid.voxel) || added;
        }
        if (!added) break;
        result = evaluate();
    }

    const blocked = new Set<number>();
    segments.forEach((seg, i) => {
        if (!seg) blocked.add(i);
    });
    for (const c of result.collisions) blocked.add(c.segment);
    return { poses: result.poses, frames: result.frames, blocked: [...blocked].sort((a, b) => a - b) };
};

export { detourPoses, planDetours, simplifyRoute };
export type { DetourInput, DetourPlan, PlannedPose };
