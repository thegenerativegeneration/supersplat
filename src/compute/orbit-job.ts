import type { OrbitCheckRequest, ProgressFn } from './protocol';
import type { BalanceResult } from '../anim/balance-timing';
import { buildCameraCurve, type CurvePose } from '../anim/camera-curve';
import type { Box } from '../candidates/estimate';
import type { SplatExtents } from '../candidates/extent';
import { buildSceneGrid } from '../candidates/generate';
import type { Occupancy } from '../candidates/occupancy';
import { arcBlocked, clampSpan, fitRadius, MIN_RADIUS, orbitKeys, type OrbitSpec } from '../orbit/orbit-path';
import { curveCollisions, type PointGrid } from '../path/curve-check';

// blockedRanges: [from, to] azimuths in degrees within -180..180 where the
// arc at the requested radius is blocked; a blocked plan's radius is that
// requested radius, at least MIN_RADIUS (absent without splats)
type OrbitPlan =
    { keys: CurvePose[], radius: number, reduced: boolean, blockedRanges: [number, number][] } |
    { keys: [], blocked: true, blockedRanges: [number, number][], radius?: number, reason?: 'noSplats' };

type OrbitAddResult = {
    ok: boolean,
    // blocked: no free radius; rejected: the track did not take the keys;
    // cancelled: the user cancelled the run before the keys were appended
    reason?: 'noSplats' | 'blocked' | 'tooFewFrames' | 'keysChanged' | 'rejected' | 'cancelled',
    added: number,
    radius?: number,
    reduced?: boolean,
    balance?: BalanceResult,
    // the curve between the orbit's keys enters geometry
    orbitBlocked: boolean,
    // the curve from the previous last key into the orbit enters geometry
    joinBlocked: boolean
};

// the request fields the curve check reads
type OrbitCurve = Omit<OrbitCheckRequest, 'version' | 'box' | 'eyeHeight'>;

const SAMPLE_VOXELS = 0.25;

// Splits [from, to] ranges (to - from <= 360, possibly outside -180..180)
// into ranges within -180..180.
const normaliseRanges = (ranges: [number, number][]) => {
    const out: [number, number][] = [];
    for (const [from, to] of ranges) {
        if (to - from >= 360) {
            out.push([-180, 180]);
            continue;
        }
        const a = ((from + 180) % 360 + 360) % 360 - 180;
        const b = a + (to - from);
        if (b <= 180) {
            out.push([a, b]);
        } else {
            out.push([a, 180], [-180, b - 360]);
        }
    }
    return out;
};

const diagonal = (box: Box) => Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);

// a spec with a finite radius of at least MIN_RADIUS voxels, at most the box
// diagonal, and finite angles
const sanitise = (spec: OrbitSpec, voxel: number, box: Box | null): OrbitSpec => ({
    ...spec,
    radius: Math.max(Math.min(Number.isFinite(spec.radius) ? spec.radius : 0, box ? diagonal(box) : Infinity), MIN_RADIUS * voxel),
    height: Number.isFinite(spec.height) ? spec.height : 0,
    startDeg: Number.isFinite(spec.startDeg) ? spec.startDeg : 0,
    spanDeg: clampSpan(spec.spanDeg),
    dir: spec.dir === -1 ? -1 : 1
});

// One scene occupancy: get rebuilds it when the points, box or eye height
// change; clear drops it and its points.
const createOccupancyCache = () => {
    let cached: { points: Float32Array, box: string, eyeHeight: number, occ: Occupancy } | null = null;
    const get = (points: Float32Array, extents: SplatExtents | undefined, box: Box, eyeHeight: number, onProgress?: ProgressFn): Occupancy => {
        const boxKey = JSON.stringify(box);
        if (cached?.points !== points || cached.box !== boxKey || cached.eyeHeight !== eyeHeight) {
            cached = null;
            onProgress?.('grid');
            const { occ } = buildSceneGrid(points, box, eyeHeight, undefined, extents);
            cached = { points, box: boxKey, eyeHeight, occ };
        }
        return cached.occ;
    };
    const clear = () => {
        cached = null;
    };
    return { get, clear };
};

// keys on the largest free circle inside the box (the area Fix Path
// routes in when it has no far keys) up to the requested radius
const orbitPlan = (occ: Occupancy, box: Box | null, spec: OrbitSpec): OrbitPlan => {
    const area = box ?? undefined;
    const safe = sanitise(spec, occ.voxel, box);
    const occupied = (ix: number, iy: number, iz: number) => occ.occupied(ix, iy, iz);
    const fit = fitRadius(occupied, occ.voxel, safe, area);
    if (!fit) {
        return {
            keys: [],
            blocked: true,
            blockedRanges: normaliseRanges(arcBlocked(occupied, occ.voxel, safe, area).ranges),
            radius: safe.radius
        };
    }
    return { keys: orbitKeys({ ...safe, radius: fit.radius }), radius: fit.radius, reduced: fit.reduced, blockedRanges: [] };
};

// Whether the curve through the keys in the shot enters geometry between the
// orbit's keys, and on the way from the key before into its first key.
const orbitCheck = (occ: Occupancy, req: OrbitCurve) => {
    const { poses, frames, userFrames, first, last } = req;
    const curve = buildCameraCurve(poses, frames, req.curve);
    if (!curve || first < 0) return { orbitBlocked: false, joinBlocked: false };

    const v = occ.voxel;
    const grid: PointGrid = {
        voxel: v,
        pointFree: p => !occ.occupied(Math.floor(p.x / v), Math.floor(p.y / v), Math.floor(p.z / v))
    };
    const from = Math.max(0, first - 1);
    const checked = frames.slice(from, last + 1);
    const segments = curveCollisions(curve, checked, grid, userFrames, SAMPLE_VOXELS * v).map(c => c.segment + from);
    return {
        orbitBlocked: segments.some(s => s >= first && s < last),
        joinBlocked: first > 0 && segments.includes(first - 1)
    };
};

export { createOccupancyCache, normaliseRanges, orbitCheck, orbitPlan };
export type { OrbitAddResult, OrbitPlan };
