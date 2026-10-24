import { curveCollisions } from './curve-check';
import type { NavGrid } from './nav-grid';
import { buildCameraCurve, type CurveOptions, type CurvePose } from '../anim/camera-curve';
import type { Vec3Like } from '../candidates/occupancy';

type PlannedPose = { pose: CurvePose, auto: boolean };

// Look-ahead view rule for detour keys: look at the route point ahead
// further on, at most maxOffsetDeg off the travel direction; ease from and to
// the end keys' views over ease of route length. Where narrow(position)
// holds the view outside the ease zones is the travel direction.
type LookOptions = { ahead: number, maxOffsetDeg: number, ease: number, narrow?: (p: Vec3Like) => boolean };

type DetourInput = {
    // user keys in tour order
    keys: CurvePose[],
    // grid route of segment i (keys[i] to the next key), without the key
    // positions themselves; null when unreachable
    routes: (Vec3Like[] | null)[],
    grid: NavGrid,
    eyeHeight: number,
    // frames for the poses; the plan's frames are the array of one of these calls
    retime: (poses: CurvePose[]) => number[],
    curveOpts: CurveOptions,
    look?: LookOptions
};

type DetourPlan = { poses: PlannedPose[], frames: number[], blocked: number[] };

const MAX_ROUNDS = 4;
// curve check sample spacing, in voxels
const SAMPLE_VOXELS = 0.25;
// a new detour closer than this many voxels to an existing one is not added
const DUPLICATE_VOXELS = 1;
// route cells this close to a segment's end keys never become detours
const NEAR_KEY_VOXELS = 1.5;
// detours closer than this to a neighbouring key are dropped when the curve
// stays as clean without them
const PRUNE_VOXELS = 2;

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

const sub = (a: Vec3Like, b: Vec3Like): Vec3Like => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

const dot = (a: Vec3Like, b: Vec3Like) => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Vec3Like, b: Vec3Like): Vec3Like => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
});

const scale = (a: Vec3Like, k: number): Vec3Like => ({ x: a.x * k, y: a.y * k, z: a.z * k });

// unit vector along a, or null when a is (nearly) zero
const normalize = (a: Vec3Like): Vec3Like | null => {
    const len = Math.hypot(a.x, a.y, a.z);
    return len > 1e-9 ? scale(a, 1 / len) : null;
};

const UP = { x: 0, y: 1, z: 0 };
const SIDE = { x: 1, y: 0, z: 0 };

// Spherical interpolation between unit vectors a and b. Opposite vectors
// turn about world up (about x when a is vertical), so the swing is level.
const slerp = (a: Vec3Like, b: Vec3Like, t: number): Vec3Like => {
    const c = Math.max(-1, Math.min(1, dot(a, b)));
    const theta = Math.acos(c);
    const sin = Math.sin(theta);
    if (sin > 1e-6) {
        const ka = Math.sin((1 - t) * theta) / sin, kb = Math.sin(t * theta) / sin;
        return { x: a.x * ka + b.x * kb, y: a.y * ka + b.y * kb, z: a.z * ka + b.z * kb };
    }
    if (c > 0) return { ...a };
    const axis = normalize(sub(UP, scale(a, dot(a, UP)))) ?? normalize(sub(SIDE, scale(a, dot(a, SIDE))));
    const k = cross(axis, a);
    const ca = Math.cos(t * Math.PI), sa = Math.sin(t * Math.PI);
    return { x: a.x * ca + k.x * sa, y: a.y * ca + k.y * sa, z: a.z * ca + k.z * sa };
};

// Spherical interpolation from unit vector a towards b, turning at most
// maxRad away from a.
const clampTowards = (a: Vec3Like, b: Vec3Like, maxRad: number): Vec3Like => {
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
    return angle <= maxRad ? b : normalize(slerp(a, b, maxRad / angle)) ?? a;
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// view direction at interior route point i with the look-ahead rule. Where
// the ease zones overlap on a short route both apply, the ease into to last.
const lookDirection = (route: Vec3Like[], s: number[], i: number, from: CurvePose, toView: Vec3Like | null, look: LookOptions) => {
    const pos = route[i];
    const tangent = normalize(sub(route[i + 1], route[i - 1])) ?? SIDE;
    const ahead = normalize(sub(pointAt(route, s, s[i] + look.ahead), pos)) ?? tangent;
    let dir = look.narrow?.(pos) ? tangent : clampTowards(tangent, ahead, look.maxOffsetDeg * Math.PI / 180);
    const ease = look.ease > 0 ? look.ease : 1e-9;
    const wOut = clamp01(1 - s[i] / ease);
    const wIn = clamp01(1 - (s[s.length - 1] - s[i]) / ease);
    const fromView = normalize(sub(from.target, from.position));
    if (wOut > 0 && fromView) dir = normalize(slerp(dir, fromView, wOut)) ?? dir;
    if (wIn > 0 && toView) dir = normalize(slerp(dir, toView, wIn)) ?? dir;
    return dir;
};

// Poses for the interior points of route (from.position .. to.position).
// View direction without look: towards the point eyeHeight further along
// the route, turned by slerp towards to.target over the last 2 eyeHeight;
// with look, see LookOptions. The target lies along it at a distance
// blended from eyeHeight to the distance of to.target (at least eyeHeight)
// over the last 2 eyeHeight. Fov is linear in route distance.
const detourPoses = (route: Vec3Like[], from: CurvePose, to: CurvePose, eyeHeight: number, look?: LookOptions): CurvePose[] => {
    const s = arcLengths(route);
    const total = s[s.length - 1];
    const blend = 2 * eyeHeight;
    const out: CurvePose[] = [];
    for (let i = 1; i < route.length - 1; i++) {
        const pos = route[i];
        const toTarget = sub(to.target, pos);
        const w = Math.min(1, Math.max(0, 1 - (total - s[i]) / blend));
        let dir: Vec3Like;
        if (look) {
            dir = lookDirection(route, s, i, from, normalize(toTarget), look);
        } else {
            const travel = normalize(sub(pointAt(route, s, s[i] + eyeHeight), pos)) ?? normalize(sub(route[i + 1], route[i - 1])) ?? SIDE;
            const view = normalize(toTarget) ?? travel;
            dir = normalize(slerp(travel, view, w)) ?? travel;
        }
        const reach = eyeHeight + w * (Math.max(eyeHeight, Math.hypot(toTarget.x, toTarget.y, toTarget.z)) - eyeHeight);
        const u = total > 0 ? s[i] / total : 0;
        out.push({
            position: { ...pos },
            target: { x: pos.x + dir.x * reach, y: pos.y + dir.y * reach, z: pos.z + dir.z * reach },
            fov: from.fov + (to.fov - from.fov) * u
        });
    }
    return out;
};

// segment state: the full route from key to key and the indices into it of
// the detour points, ascending
type Segment = { full: Vec3Like[], detours: number[] };

// interior route point i is within NEAR_KEY_VOXELS of an end key
const nearEnd = (full: Vec3Like[], i: number, voxel: number) => {
    const near = NEAR_KEY_VOXELS * voxel * (1 + 1e-6);
    return distance(full[i], full[0]) <= near || distance(full[i], full[full.length - 1]) <= near;
};

const initialDetours = (grid: NavGrid, full: Vec3Like[]) => {
    const kept = new Set(simplifyRoute(grid, full));
    const out: number[] = [];
    for (let i = 1; i < full.length - 1; i++) {
        if (kept.has(full[i]) && !nearEnd(full, i, grid.voxel)) out.push(i);
    }
    return out;
};

// Working poses in curve order, each with the user segment it starts.
const assemble = (keys: CurvePose[], segments: (Segment | null)[], eyeHeight: number, look?: LookOptions) => {
    const poses: PlannedPose[] = [];
    const owner: number[] = [];
    keys.forEach((key, i) => {
        poses.push({ pose: key, auto: false });
        owner.push(i);
        const seg = segments[i];
        if (!seg) return;
        const next = keys[(i + 1) % keys.length];
        const route = [key.position, ...seg.detours.map(d => seg.full[d]), next.position];
        for (const pose of detourPoses(route, key, next, eyeHeight, look)) {
            poses.push({ pose, auto: true });
            owner.push(i);
        }
    });
    return { poses, owner };
};

// Adds the interior route point nearest p as a detour, skipping points
// closer than DUPLICATE_VOXELS to an existing detour (adjacent route cells
// stay eligible) or near the end keys; false when no point is left.
const insertDetour = (seg: Segment, p: Vec3Like, voxel: number) => {
    const min = DUPLICATE_VOXELS * voxel * (1 - 1e-6);
    let best = -1, bestDist = Infinity;
    for (let i = 1; i < seg.full.length - 1; i++) {
        const d = distance(seg.full[i], p);
        if (d < bestDist && !nearEnd(seg.full, i, voxel) && seg.detours.every(k => distance(seg.full[k], seg.full[i]) >= min)) {
            bestDist = d;
            best = i;
        }
    }
    if (best < 0) return false;
    seg.detours.push(best);
    seg.detours.sort((a, b) => a - b);
    return true;
};

// the first index from on into seg.detours of a detour closer than
// PRUNE_VOXELS to the key or detour before or after it; -1 when none
const crowdedDetour = (seg: Segment, voxel: number, from: number) => {
    const pts = [0, ...seg.detours, seg.full.length - 1];
    for (let d = from; d < seg.detours.length; d++) {
        const p = seg.full[pts[d + 1]];
        const gap = Math.min(distance(p, seg.full[pts[d]]), distance(p, seg.full[pts[d + 2]]));
        if (gap < PRUNE_VOXELS * voxel) return d;
    }
    return -1;
};

// Removes crowded detours one at a time, keeping each removal accept()
// approves (accept sees the segment without it).
const pruneSegment = (seg: Segment, voxel: number, accept: () => boolean) => {
    let d = crowdedDetour(seg, voxel, 0);
    while (d >= 0) {
        const saved = seg.detours;
        seg.detours = saved.slice();
        seg.detours.splice(d, 1);
        if (accept()) {
            // the next detour moved down to index d
            d = crowdedDetour(seg, voxel, d);
        } else {
            seg.detours = saved;
            d = crowdedDetour(seg, voxel, d + 1);
        }
    }
};

// Detour keys between consecutive user keys so the camera curve stays in
// free space: start from the simplified routes, retime, check the curve and
// add the full-route point nearest the first collision of each colliding
// curve segment, for up to MAX_ROUNDS rounds. Then crowded detours are
// dropped one at a time where no segment starts colliding without them.
// Segments without a route, or still colliding, are blocked (indices into
// the user segments). For a loop, routes has one entry per key and the last
// runs back to the first key.
const planDetours = (input: DetourInput): DetourPlan => {
    const { keys, routes, grid, eyeHeight, retime, curveOpts, look } = input;
    const segments = routes.map((r, i): Segment | null => {
        if (!r) return null;
        const full = [keys[i].position, ...r, keys[(i + 1) % keys.length].position];
        return { full, detours: initialDetours(grid, full) };
    });
    const step = SAMPLE_VOXELS * grid.voxel;

    const evaluate = () => {
        const { poses, owner } = assemble(keys, segments, eyeHeight, look);
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

    // drop crowded detours while no other segment starts colliding
    const colliding = (r: typeof result) => new Set(r.collisions.map(c => c.segment));
    const before = colliding(result);
    const accept = () => {
        const trial = evaluate();
        if (![...colliding(trial)].every(s => before.has(s))) return false;
        result = trial;
        return true;
    };
    segments.forEach((seg, i) => {
        if (seg && !before.has(i)) pruneSegment(seg, grid.voxel, accept);
    });

    const blocked = new Set<number>();
    segments.forEach((seg, i) => {
        if (!seg) blocked.add(i);
    });
    for (const c of result.collisions) blocked.add(c.segment);
    return { poses: result.poses, frames: result.frames, blocked: [...blocked].sort((a, b) => a - b) };
};

export { detourPoses, planDetours, simplifyRoute };
export type { DetourInput, DetourPlan, LookOptions, PlannedPose };
