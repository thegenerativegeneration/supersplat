import { Vec3 } from 'playcanvas';

import { MAX_TURN_DEG_PER_SEC } from './anim/balance-timing';
import { isParked, Pose } from './camera-poses';
import { looksMetric, type Box } from './candidates/estimate';
import { VOXELS_PER_EYE } from './candidates/generate';
import type { Occupancy, Vec3Like } from './candidates/occupancy';
import type { OpaquePoints } from './candidates/read-points';
import { normaliseRanges, orbitCheck, orbitOccupancy, orbitPlan, type OrbitAddResult, type OrbitPlan } from './compute/orbit-job';
import { Events } from './events';
import { clampSpan, orbitDefaults, type OrbitSpec } from './orbit/orbit-path';
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

type SceneSettings = { box: Box, eyeHeight: number };

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
    return orbitCheck(occ, {
        poses: shot.map(p => ({ position: p.position, target: p.target, fov: p.fov ?? fallbackFov })),
        frames,
        userFrames: shot.filter(p => !p.auto).map(p => p.frame),
        first,
        last,
        curve: { duration: timeline.frames, smoothness: timeline.smoothness, loop: timeline.loop }
    });
};

const registerOrbitEvents = (events: Events) => {
    // box and eye height estimated from the scene alone, so Suggest Views
    // and Fix Path settings leave orbits as they are; null without splats
    const sceneSettings = async (): Promise<{ points: Float32Array, extents: OpaquePoints['extents'], settings: SceneSettings } | null> => {
        const { points, extents } = await events.invoke('candidates.cloud') as OpaquePoints;
        if (!points || points.length === 0) return null;
        const p = await events.invoke('candidates.prepare') as SceneSettings & { points: number };
        return p.points > 0 ? { points, extents, settings: { box: p.box, eyeHeight: p.eyeHeight } } : null;
    };

    // the scene occupancy and box
    const occupancy = async (): Promise<{ occ: Occupancy, box: Box | null } | null> => {
        const scene = await sceneSettings();
        if (!scene) return null;
        const { points, extents, settings: { box, eyeHeight } } = scene;
        return { occ: orbitOccupancy(points, extents, box, eyeHeight), box };
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

    const plan = async (spec: OrbitSpec): Promise<OrbitPlan> => {
        const scene = await occupancy();
        if (!scene) return { keys: [], blocked: true, blockedRanges: [], reason: 'noSplats' };
        return orbitPlan(scene.occ, scene.box, spec);
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
