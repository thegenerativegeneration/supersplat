import { Vec3 } from 'playcanvas';

import { MAX_TURN_DEG_PER_SEC, type BalanceResult } from './anim/balance-timing';
import { buildCameraCurve, type CurvePose } from './anim/camera-curve';
import { isParked, Pose } from './camera-poses';
import { looksMetric, type Box } from './candidates/estimate';
import { buildSceneGrid, VOXELS_PER_EYE } from './candidates/generate';
import type { Occupancy, Vec3Like } from './candidates/occupancy';
import type { OpaquePoints } from './candidates/read-points';
import { Events } from './events';
import { arcBlocked, clampSpan, fitRadius, MIN_RADIUS, orbitDefaults, orbitKeys, type OrbitSpec } from './orbit/orbit-path';
import { curveCollisions, type PointGrid } from './path/curve-check';
import { timelineSettings } from './timing-events';
import { appendAndBalance } from './view-keys';

type OrbitDefaults = {
    centre: Vec3Like,
    radius: number,
    height: number,
    startDeg: number,
    fov: number,
    // the box of the grid looks like metres
    metric: boolean,
    shotSeconds: number,
    // the shortest time the span takes at the turn cap
    turnSeconds: number
};

// blockedRanges: [from, to] azimuths in degrees within -180..180 where the
// arc at the requested radius is blocked; a blocked plan's radius is that
// requested radius, at least MIN_RADIUS (absent without splats)
type OrbitPlan =
    { keys: CurvePose[], radius: number, reduced: boolean, blockedRanges: [number, number][] } |
    { keys: [], blocked: true, blockedRanges: [number, number][], radius?: number, reason?: 'noSplats' };

type OrbitAddResult = {
    ok: boolean,
    // blocked: no free radius; rejected: the track did not take the keys
    reason?: 'noSplats' | 'blocked' | 'tooFewFrames' | 'keysChanged' | 'rejected',
    added: number,
    radius?: number,
    reduced?: boolean,
    balance?: BalanceResult,
    // the curve between the orbit's keys enters geometry
    orbitBlocked: boolean,
    // the curve from the previous last key into the orbit enters geometry
    joinBlocked: boolean
};

type SceneSettings = { box: Box, eyeHeight: number };

const SAMPLE_VOXELS = 0.25;

// box and eye height of the last Suggest Views run, else fresh estimates;
// null without splats
const sceneSettings = async (events: Events): Promise<SceneSettings | null> => {
    const last = events.invoke('candidates.lastSettings') as SceneSettings | null;
    if (last) return last;
    const prepared = await events.invoke('candidates.prepare') as SceneSettings & { points: number };
    return prepared.points > 0 ? prepared : null;
};

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

// a spec with a finite radius of at least MIN_RADIUS voxels and finite angles
const sanitise = (spec: OrbitSpec, voxel: number): OrbitSpec => ({
    ...spec,
    radius: Math.max(Number.isFinite(spec.radius) ? spec.radius : 0, MIN_RADIUS * voxel),
    height: Number.isFinite(spec.height) ? spec.height : 0,
    startDeg: Number.isFinite(spec.startDeg) ? spec.startDeg : 0,
    spanDeg: clampSpan(spec.spanDeg),
    dir: spec.dir === -1 ? -1 : 1
});

// the next free orbit_N id
const nextOrbitId = (poses: readonly Pose[]) => {
    const n = 1 + Math.max(-1, ...poses.map(p => Number(/^orbit_(\d+)$/.exec(p.orbit ?? '')?.[1] ?? -1)));
    return `orbit_${n}`;
};

// Whether the curve through the keys in the shot enters geometry between the
// orbit's keys, and on the way from the key before into its first key.
const checkOrbitCurve = (events: Events, id: string, occ: Occupancy) => {
    const timeline = timelineSettings(events);
    const shot = (events.invoke('camera.poses') as Pose[])
    .filter(p => !isParked(p, timeline.frames))
    .sort((a, b) => a.frame - b.frame);
    const frames = shot.map(p => p.frame);
    const first = shot.findIndex(p => p.orbit === id);
    let last = first;
    while (last + 1 < shot.length && shot[last + 1].orbit === id) last++;

    const fallbackFov = events.invoke('camera.fov') as number;
    const poses = shot.map(p => ({ position: p.position, target: p.target, fov: p.fov ?? fallbackFov }));
    const curve = buildCameraCurve(poses, frames, { duration: timeline.frames, smoothness: timeline.smoothness, loop: timeline.loop });
    if (!curve || first < 0) return { orbitBlocked: false, joinBlocked: false };

    const v = occ.voxel;
    const grid: PointGrid = {
        voxel: v,
        pointFree: p => !occ.occupied(Math.floor(p.x / v), Math.floor(p.y / v), Math.floor(p.z / v))
    };
    const from = Math.max(0, first - 1);
    const checked = frames.slice(from, last + 1);
    const userFrames = shot.filter(p => !p.auto).map(p => p.frame);
    const segments = curveCollisions(curve, checked, grid, userFrames, SAMPLE_VOXELS * v).map(c => c.segment + from);
    return {
        orbitBlocked: segments.some(s => s >= first && s < last),
        joinBlocked: first > 0 && segments.includes(first - 1)
    };
};

const registerOrbitEvents = (events: Events) => {
    let cached: { points: Float32Array, box: string, eyeHeight: number, occ: Occupancy } | null = null;

    // the scene occupancy, rebuilt when the points, box or eye height change
    const occupancy = async (): Promise<Occupancy | null> => {
        const { points, extents } = await events.invoke('candidates.cloud') as OpaquePoints;
        if (!points || points.length === 0) return null;
        const settings = await sceneSettings(events);
        if (!settings) return null;
        const { box, eyeHeight } = settings;
        const boxKey = JSON.stringify(box);
        if (cached?.points !== points || cached.box !== boxKey || cached.eyeHeight !== eyeHeight) {
            const { occ } = buildSceneGrid(points, box, eyeHeight, undefined, extents);
            cached = { points, box: boxKey, eyeHeight, occ };
        }
        return cached.occ;
    };

    // orbit around the focal point starting at the camera; null without splats
    events.function('orbit.defaults', async (spanDeg = 360): Promise<OrbitDefaults | null> => {
        const settings = await sceneSettings(events);
        if (!settings) return null;
        const { position, target } = events.invoke('camera.getPose') as { position: Vec3Like, target: Vec3Like };
        const centre = { x: target.x, y: target.y, z: target.z };
        const voxel = settings.eyeHeight / VOXELS_PER_EYE;
        const { frames, frameRate } = timelineSettings(events);
        return {
            centre,
            ...orbitDefaults(centre, position, voxel),
            fov: events.invoke('camera.fov') as number,
            metric: looksMetric(settings.box),
            shotSeconds: frames / frameRate,
            turnSeconds: clampSpan(spanDeg) / MAX_TURN_DEG_PER_SEC
        };
    });

    // keys on the largest free circle up to the requested radius
    const plan = async (spec: OrbitSpec): Promise<OrbitPlan> => {
        const occ = await occupancy();
        if (!occ) return { keys: [], blocked: true, blockedRanges: [], reason: 'noSplats' };
        const safe = sanitise(spec, occ.voxel);
        const occupied = (ix: number, iy: number, iz: number) => occ.occupied(ix, iy, iz);
        const fit = fitRadius(occupied, occ.voxel, safe);
        if (!fit) {
            return {
                keys: [],
                blocked: true,
                blockedRanges: normaliseRanges(arcBlocked(occupied, occ.voxel, safe).ranges),
                radius: safe.radius
            };
        }
        return { keys: orbitKeys({ ...safe, radius: fit.radius }), radius: fit.radius, reduced: fit.reduced, blockedRanges: [] };
    };
    events.function('orbit.plan', plan);

    // Append the planned orbit after the keys in the shot and balance the
    // timing, as one undo step, then check the new curve against the scene.
    events.function('orbit.add', async (spec: OrbitSpec): Promise<OrbitAddResult> => {
        const none = { added: 0, orbitBlocked: false, joinBlocked: false };
        const planned = await plan(spec);
        if ('blocked' in planned) return { ok: false, reason: planned.reason ?? 'blocked', ...none };

        const poses = events.invoke('camera.poses') as Pose[];
        const timeline = timelineSettings(events);
        const inShot = poses.filter(p => !isParked(p, timeline.frames)).length;
        const { radius, reduced } = planned;
        if (inShot + planned.keys.length > timeline.frames) return { ok: false, reason: 'tooFewFrames', radius, reduced, ...none };

        const id = nextOrbitId(poses);
        const balance = await appendAndBalance(events, planned.keys.map(k => ({
            position: new Vec3(k.position.x, k.position.y, k.position.z),
            target: new Vec3(k.target.x, k.target.y, k.target.z),
            fov: k.fov,
            orbit: id
        })));
        if ('reason' in balance && balance.reason === 'keysChanged') return { ok: false, reason: 'keysChanged', radius, reduced, balance, ...none };

        const added = (events.invoke('camera.poses') as Pose[]).filter(p => p.orbit === id).length;
        if (added !== planned.keys.length) return { ok: false, reason: 'rejected', radius, reduced, balance, ...none };

        const occ = await occupancy();
        const check = occ ? checkOrbitCurve(events, id, occ) : { orbitBlocked: false, joinBlocked: false };
        return { ok: true, added, radius, reduced, balance, ...check };
    });
};

export { registerOrbitEvents, normaliseRanges };
export type { OrbitAddResult, OrbitDefaults, OrbitPlan };
