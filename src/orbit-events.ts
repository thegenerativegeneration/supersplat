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
    let prepared: { points: Float32Array, settings: Promise<SceneSettings | null> } | null = null;

    // box and eye height of the last Suggest Views run, else estimates,
    // prepared once per points array; null without splats
    const sceneSettings = async (): Promise<{ points: Float32Array, extents: OpaquePoints['extents'], settings: SceneSettings } | null> => {
        const { points, extents } = await events.invoke('candidates.cloud') as OpaquePoints;
        if (!points || points.length === 0) return null;
        const last = events.invoke('candidates.lastSettings') as SceneSettings | null;
        if (last) return { points, extents, settings: last };
        if (prepared?.points !== points) {
            const pending = (events.invoke('candidates.prepare') as Promise<SceneSettings & { points: number }>)
            .then(p => (p.points > 0 ? { box: p.box, eyeHeight: p.eyeHeight } : null));
            const entry = { points, settings: pending };
            pending.catch(() => {
                if (prepared === entry) prepared = null;
            });
            prepared = entry;
        }
        const settings = await prepared.settings;
        return settings ? { points, extents, settings } : null;
    };

    // the scene occupancy and box, the occupancy rebuilt when the points, box
    // or eye height change
    const occupancy = async (): Promise<{ occ: Occupancy, box: Box | null } | null> => {
        const scene = await sceneSettings();
        if (!scene) return null;
        const { points, extents, settings: { box, eyeHeight } } = scene;
        const boxKey = JSON.stringify(box);
        if (cached?.points !== points || cached.box !== boxKey || cached.eyeHeight !== eyeHeight) {
            const { occ } = buildSceneGrid(points, box, eyeHeight, undefined, extents);
            cached = { points, box: boxKey, eyeHeight, occ };
        }
        return { occ: cached.occ, box };
    };

    // orbit around the focal point starting at the camera; null without splats
    events.function('orbit.defaults', async (spanDeg = 360): Promise<OrbitDefaults | null> => {
        const settings = (await sceneSettings())?.settings;
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

    // keys on the largest free circle inside the box (the area Fix Path
    // routes in) up to the requested radius
    const plan = async (spec: OrbitSpec): Promise<OrbitPlan> => {
        const scene = await occupancy();
        if (!scene) return { keys: [], blocked: true, blockedRanges: [], reason: 'noSplats' };
        const { occ } = scene;
        const area = scene.box ?? undefined;
        const safe = sanitise(spec, occ.voxel, scene.box);
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
        // a lone full turn in a loop wraps back to its first key by itself
        const closed = timeline.loop && inShot === 0 && clampSpan(spec.spanDeg) === 360;
        const keys = closed ? planned.keys.slice(0, -1) : planned.keys;
        if (inShot + keys.length > timeline.frames) return { ok: false, reason: 'tooFewFrames', radius, reduced, ...none };

        const id = nextOrbitId(poses);
        const balance = await appendAndBalance(events, keys.map(k => ({
            position: new Vec3(k.position.x, k.position.y, k.position.z),
            target: new Vec3(k.target.x, k.target.y, k.target.z),
            fov: k.fov,
            orbit: id
        })));
        if ('reason' in balance && balance.reason === 'keysChanged') return { ok: false, reason: 'keysChanged', radius, reduced, balance, ...none };

        const added = (events.invoke('camera.poses') as Pose[]).filter(p => p.orbit === id).length;
        if (added !== keys.length) return { ok: false, reason: 'rejected', radius, reduced, balance, ...none };

        const scene = await occupancy();
        const check = scene ? checkOrbitCurve(events, id, scene.occ) : { orbitBlocked: false, joinBlocked: false };
        return { ok: true, added, radius, reduced, balance, ...check };
    });
};

export { registerOrbitEvents, normaliseRanges };
export type { OrbitAddResult, OrbitDefaults, OrbitPlan };
