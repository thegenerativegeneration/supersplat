import { Vec3 } from 'playcanvas';

import { MAX_TURN_DEG_PER_SEC } from './anim/balance-timing';
import { isParked, Pose } from './camera-poses';
import { looksMetric, type Box } from './candidates/estimate';
import { VOXELS_PER_EYE } from './candidates/generate';
import type { Vec3Like } from './candidates/occupancy';
import type { OpaquePoints } from './candidates/read-points';
import { normaliseRanges, type OrbitAddResult, type OrbitPlan } from './compute/orbit-job';
import { withProgress, type ProgressHandle } from './compute/progress-handle';
import type { Estimate, ProgressFn } from './compute/protocol';
import { computeOf, isAbortError, untilAborted, type RunOptions } from './compute/scene-compute';
import { Events } from './events';
import { clampSpan, orbitDefaults, type OrbitSpec } from './orbit/orbit-path';
import { showBalanceFailure, timelineSettings } from './timing-events';
import { appendAndBalance, appendFailure } from './view-keys';

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

// the next free orbit_N id
const nextOrbitId = (poses: readonly Pose[]) => {
    const n = 1 + Math.max(-1, ...poses.map(p => Number(/^orbit_(\d+)$/.exec(p.orbit ?? '')?.[1] ?? -1)));
    return `orbit_${n}`;
};

// the cached scene points with the area box and eye height estimated from
// them alone, so Suggest Views and Fix Path settings leave orbits as they are
type Scene = { cloud: OpaquePoints, box: Box, eyeHeight: number };

type AddOutcome = { result: OrbitAddResult, popup?: string };

const NONE = { added: 0, orbitBlocked: false, joinBlocked: false };

const noSplats = (): OrbitPlan => ({ keys: [], blocked: true, blockedRanges: [], reason: 'noSplats' });

// The scene, null without splats. An abort stops the waiting, not the shared
// read and estimate.
const sceneOf = async (events: Events, { signal, onProgress }: RunOptions = {}): Promise<Scene | null> => {
    const cloud = await untilAborted(events.invoke('candidates.cloud', onProgress) as Promise<OpaquePoints>, signal);
    if (!cloud.points || cloud.points.length === 0) return null;
    const p = await untilAborted(events.invoke('candidates.prepare', onProgress) as Promise<Estimate>, signal);
    return p.points > 0 ? { cloud, box: p.box, eyeHeight: p.eyeHeight } : null;
};

// the plan in the scene compute, which keeps the scene occupancy for the next one
const planIn = (events: Events, scene: Scene | null, spec: OrbitSpec, opts: RunOptions): Promise<OrbitPlan> => {
    if (!scene) return Promise.resolve(noSplats());
    const compute = computeOf(events);
    const { box, eyeHeight } = scene;
    return compute.run('orbitPlan', { version: compute.pointsVersion(scene.cloud), box, eyeHeight, spec }, opts);
};

// the scene and the plan in it; null when cancelled
const planFor = async (events: Events, spec: OrbitSpec, opts: RunOptions) => {
    try {
        const scene = await sceneOf(events, opts);
        return { scene, planned: await planIn(events, scene, spec, opts) };
    } catch (error) {
        if (isAbortError(error)) return null;
        throw error;
    }
};

// Whether the curve through the keys in the shot enters geometry between the
// orbit's keys, and on the way from the key before into its first key.
const checkOrbitCurve = (events: Events, id: string, scene: Scene, onProgress: ProgressFn) => {
    const timeline = timelineSettings(events);
    const shot = (events.invoke('camera.poses') as Pose[])
    .filter(p => !isParked(p, timeline.frames))
    .sort((a, b) => a.frame - b.frame);
    const frames = shot.map(p => p.frame);
    const first = shot.findIndex(p => p.orbit === id);
    let last = first;
    while (last + 1 < shot.length && shot[last + 1].orbit === id) last++;

    const fallbackFov = events.invoke('camera.fov') as number;
    const compute = computeOf(events);
    return compute.run('orbitCheck', {
        version: compute.pointsVersion(scene.cloud),
        box: scene.box,
        eyeHeight: scene.eyeHeight,
        poses: shot.map(p => ({ position: p.position, target: p.target, fov: p.fov ?? fallbackFov })),
        frames,
        userFrames: shot.filter(p => !p.auto).map(p => p.frame),
        first,
        last,
        curve: { duration: timeline.frames, smoothness: timeline.smoothness, loop: timeline.loop }
    }, { onProgress });
};

// One Add Orbit run under the progress handle h. Cancel changes nothing until
// the keys are appended; the curve check after that cannot be cancelled.
// popup: the balance failure to explain once the progress is gone.
const addWith = async (events: Events, h: ProgressHandle, spec: OrbitSpec): Promise<AddOutcome> => {
    const cancelled: AddOutcome = { result: { ok: false, reason: 'cancelled', ...NONE } };
    const opts = { signal: h.signal, onProgress: h.update };
    const run = await planFor(events, spec, opts);
    if (!run || h.signal.aborted) return cancelled;
    const { scene, planned } = run;
    if ('blocked' in planned) return { result: { ok: false, reason: planned.reason ?? 'blocked', ...NONE } };

    const poses = events.invoke('camera.poses') as Pose[];
    const timeline = timelineSettings(events);
    const inShot = poses.filter(p => !isParked(p, timeline.frames)).length;
    const { radius, reduced } = planned;
    // a lone full turn in a loop wraps back to its first key by itself
    const closed = timeline.loop && inShot === 0 && clampSpan(spec.spanDeg) === 360;
    const keys = closed ? planned.keys.slice(0, -1) : planned.keys;
    if (inShot + keys.length > timeline.frames) return { result: { ok: false, reason: 'tooFewFrames', radius, reduced, ...NONE } };

    const id = nextOrbitId(poses);
    const balance = await appendAndBalance(events, keys.map(k => ({
        position: new Vec3(k.position.x, k.position.y, k.position.z),
        target: new Vec3(k.target.x, k.target.y, k.target.z),
        fov: k.fov,
        orbit: id
    })), opts);
    const reason = 'reason' in balance ? balance.reason : undefined;
    if (reason === 'cancelled') return cancelled;
    const popup = appendFailure(balance);
    if (reason === 'keysChanged') return { result: { ok: false, reason, radius, reduced, balance, ...NONE }, popup };

    // the keys are in, so the check runs to its end
    h.lockCancel('progress.checking');
    const added = (events.invoke('camera.poses') as Pose[]).filter(p => p.orbit === id).length;
    if (added !== keys.length) return { result: { ok: false, reason: 'rejected', radius, reduced, balance, ...NONE }, popup };

    // the keys stay added when the check fails; it then reports no blocks
    let check = { orbitBlocked: false, joinBlocked: false };
    try {
        check = await checkOrbitCurve(events, id, scene, h.update);
    } catch (error) {
        console.warn('orbit.add: the curve check failed', error);
    }
    return { result: { ok: true, added, radius, reduced, balance, ...check }, popup };
};

const registerOrbitEvents = (events: Events) => {
    // orbit around the focal point starting at the camera; null without splats
    events.function('orbit.defaults', async (spanDeg = 360): Promise<OrbitDefaults | null> => {
        const scene = await sceneOf(events);
        if (!scene) return null;
        const { position, target } = events.invoke('camera.getPose') as { position: Vec3Like, target: Vec3Like };
        const centre = { x: target.x, y: target.y, z: target.z };
        const voxel = scene.eyeHeight / VOXELS_PER_EYE;
        const { frames, frameRate } = timelineSettings(events);
        return {
            centre,
            ...orbitDefaults(centre, position, voxel),
            fov: events.invoke('camera.fov') as number,
            metric: looksMetric(scene.box),
            shotSeconds: frames / frameRate,
            turnSeconds: clampSpan(spanDeg) / MAX_TURN_DEG_PER_SEC
        };
    });

    // the preview plan; a newer one supersedes it while it waits
    events.function('orbit.plan', async (spec: OrbitSpec): Promise<OrbitPlan> => {
        return planIn(events, await sceneOf(events), spec, { lane: 'preview' });
    });

    // Append the planned orbit after the keys in the shot and balance the
    // timing, as one undo step, then check the new curve against the scene.
    // Runs under the progress dialog.
    events.function('orbit.add', async (spec: OrbitSpec): Promise<OrbitAddResult> => {
        const { result, popup } = await withProgress(events, 'progress.orbit-add', h => addWith(events, h, spec));
        if (popup) await showBalanceFailure(events, popup);
        return result;
    });
};

export { registerOrbitEvents, normaliseRanges };
export type { OrbitAddResult, OrbitDefaults, OrbitPlan };
