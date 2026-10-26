import { Vec3 } from 'playcanvas';

import type { BalanceResult } from './anim/balance-timing';
import { newKeyId, nextNamer, Pose } from './camera-poses';
import { looksMetric, type Box } from './candidates/estimate';
import type { Vec3Like } from './candidates/occupancy';
import type { OpaquePoints } from './candidates/read-points';
import { boxAroundKeys, buildFixGrid, replyOf } from './compute/fix-path-job';
import { withProgress, type ProgressHandle } from './compute/progress-handle';
import type { Estimate, FixPlanReply, FixPlanRequest } from './compute/protocol';
import { sampleDistances } from './compute/sample-distances';
import { computeOf, isAbortError, untilAborted, type RunOptions } from './compute/scene-compute';
import { Events } from './events';
import { planFixPath, type FixKey, type RouteFn } from './path/fix-plan';
import { clampOpening, type NavGrid } from './path/nav-grid';
import { finiteOr, showBalanceFailure, snapshotOf, timelineSettings } from './timing-events';

// smallestOpening: in scene units, see clampOpening; eyeHeight: in scene units
type FixPathOptions = { keepOrder: boolean, allowFlying: boolean, smallestOpening: number, eyeHeight: number };

type FixPathResult = {
    ok: boolean,
    // rejected: the track refused the new path; tooFewFrames: more keys
    // than timeline frames; cancelled: the user cancelled the run
    reason?: 'tooFewKeys' | 'noSplats' | 'keysChanged' | 'tooFewFrames' | 'rejected' | 'cancelled',
    detours: number,
    // names of the keys parked after the shot
    unreachable: string[],
    // frames of the keys that start a blocked segment
    blocked: number[],
    insideGeometry: string[],
    balance?: BalanceResult,
    // the box of the grid looks like metres (false without a box)
    metric?: boolean
};

// before: the keys as they were before the run, for the old route in 3D
type PathMarkers = { blocked: number[], unreachable: string[], insideGeometry: string[], before?: Pose[] };

// box: the area the graph covers
type SceneGrid = { grid: NavGrid, eyeHeight: number, box?: Box };

// the smallest opening for an eye height
type OpeningAt = (eyeHeight: number) => number;

// the navigation grid of the scene around the user key positions, at the
// given eye height or the estimate; null without visible splats
type SceneGridFn = (allowFlying: boolean, openingAt: OpeningAt, positions?: Vec3Like[], eyeHeight?: number) => Promise<SceneGrid | null>;

// eyeHeight: the user's, undefined for the estimate
type PlanInput = Omit<FixPlanRequest, 'version' | 'box' | 'eyeHeight' | 'opening'> & { eyeHeight?: number, openingAt: OpeningAt };

// eyeHeight: the one the plan was made at
type PlanReply = FixPlanReply & { eyeHeight: number };

// the plan of the user keys; null without visible splats
type Planner = (input: PlanInput, opts: RunOptions) => Promise<PlanReply | null>;

// sceneGrid or route plan on the main thread instead of the scene compute;
// planner replaces both
type FixPathDeps = {
    sceneGrid?: SceneGridFn,
    route?: RouteFn,
    planner?: Planner
};

const NO_MARKERS: PathMarkers = { blocked: [], unreachable: [], insideGeometry: [] };

// changes after which the markers no longer describe the path
const STALE_EVENTS = [
    'track.keyAdded', 'track.keyRemoved', 'track.keyMoved', 'track.keyUpdated', 'track.keysLoaded', 'track.keysCleared',
    'timeline.smoothness', 'timeline.loop', 'timeline.frames'
];

// The cached scene points with the area box and the given eye height or the
// estimate; null without points. An abort stops the waiting, not the shared
// read and estimate.
const sceneOf = async (events: Events, eyeHeight: number | undefined, { signal, onProgress }: RunOptions) => {
    const cloud = await untilAborted(events.invoke('candidates.cloud', onProgress) as Promise<OpaquePoints>, signal);
    if (!cloud.points || cloud.points.length === 0) return null;
    const estimate = await untilAborted(events.invoke('candidates.prepare', onProgress) as Promise<Estimate>, signal);
    return { cloud, box: estimate.box, eyeHeight: eyeHeight ?? estimate.eyeHeight };
};

// Grid from the cached scene points and splat extents, in the estimated area
// box, at the given eye height or the estimate (see buildFixGrid).
const defaultSceneGrid = (events: Events): SceneGridFn => async (allowFlying, openingAt, positions = [], userEyeHeight) => {
    const scene = await sceneOf(events, userEyeHeight, {});
    if (!scene) return null;
    const { cloud: { points, extents }, box, eyeHeight } = scene;
    return { grid: buildFixGrid(points, extents, { box, eyeHeight, opening: openingAt(eyeHeight), allowFlying, positions }), eyeHeight, box };
};

// plans in the scene compute, which builds the grid and keeps it for the next run
const computePlanner = (events: Events): Planner => async (input, opts) => {
    const scene = await sceneOf(events, input.eyeHeight, opts);
    if (!scene) return null;
    const { allowFlying, positions, keys, keepOrder, timeline, openingAt } = input;
    const { box, eyeHeight } = scene;
    const compute = computeOf(events);
    const version = compute.pointsVersion(scene.cloud);
    const req = { version, box, eyeHeight, opening: openingAt(eyeHeight), allowFlying, positions, keys, keepOrder, timeline };
    return { ...await compute.run('fixPlan', req, opts), eyeHeight };
};

// plans on the main thread over the grid of sceneGrid, routing with route
const inlinePlanner = (sceneGrid: SceneGridFn, route?: RouteFn): Planner => async (input, { onProgress }) => {
    const scene = await sceneGrid(input.allowFlying, input.openingAt, input.positions, input.eyeHeight);
    if (!scene) return null;
    const { keys, keepOrder, timeline } = input;
    const plan = planFixPath({ keys, grid: scene.grid, eyeHeight: scene.eyeHeight, keepOrder, timeline, route, onProgress });
    return { ...replyOf(plan, keys, scene.box), eyeHeight: scene.eyeHeight };
};

// estimated: eyeHeight is the estimate, not the user's
type EyeHeightInfo = { eyeHeight: number, estimate: number, estimated: boolean, metric: boolean };

const plannerOf = (events: Events, deps: FixPathDeps): Planner => {
    if (deps.planner) return deps.planner;
    if (deps.sceneGrid || deps.route) return inlinePlanner(deps.sceneGrid ?? defaultSceneGrid(events), deps.route);
    return computePlanner(events);
};

// a run that changed nothing
const failure = (reason: FixPathResult['reason']): FixPathResult => ({
    ok: false, reason, detours: 0, unreachable: [], blocked: [], insideGeometry: []
});

const registerFixPathEvents = (events: Events, deps: FixPathDeps = {}) => {
    const planner = plannerOf(events, deps);
    const settings = { keepOrder: false, allowFlying: true };
    // the user's smallest opening and eye height in scene units, undefined
    // for the defaults
    let opening: number | undefined;
    let eyeHeight: number | undefined;
    let estimate: number | null = null;
    const openingAt = (eye: number) => clampOpening(opening, eye);
    // the eye height without waiting for an estimate: the user's, else the
    // last estimate seen, else 1.6
    const eyeHeightNow = () => eyeHeight ?? estimate ?? 1.6;
    // a new or loaded project starts from the defaults and a fresh estimate
    events.on('scene.clear', () => {
        opening = undefined;
        eyeHeight = undefined;
        estimate = null;
    });
    let markersShown = false;

    const setMarkers = (markers: PathMarkers) => {
        markersShown = markers !== NO_MARKERS;
        events.fire('path.markers', markers);
    };
    const clearMarkers = () => markersShown && setMarkers(NO_MARKERS);
    for (const name of STALE_EVENTS) events.on(name, clearMarkers);

    events.function('path.settings', (): FixPathOptions => {
        const eye = eyeHeightNow();
        return { ...settings, smallestOpening: openingAt(eye), eyeHeight: eye };
    });
    events.on('path.setSettings', (changes: Partial<FixPathOptions>) => {
        if (typeof changes.keepOrder === 'boolean') settings.keepOrder = changes.keepOrder;
        if (typeof changes.allowFlying === 'boolean') settings.allowFlying = changes.allowFlying;
        if (Number.isFinite(changes.smallestOpening)) opening = changes.smallestOpening;
        if (Number.isFinite(changes.eyeHeight) && changes.eyeHeight > 0) eyeHeight = changes.eyeHeight;
    });

    // the eye height Fix path will use, the scene estimate and whether the
    // scene looks metric; null without splats to estimate from
    events.function('path.eyeHeight', async (): Promise<EyeHeightInfo | null> => {
        const prepared = await events.invoke('candidates.prepare') as { box: Box, eyeHeight: number, points: number };
        if (!(prepared.points > 0)) return null;
        estimate = prepared.eyeHeight;
        return { eyeHeight: eyeHeightNow(), estimate, estimated: eyeHeight === undefined, metric: looksMetric(prepared.box) };
    });

    // The keys of a plan: user keys at their planned frames, new detour keys,
    // then the keys outside the shot parked after its end.
    const posesOf = (reply: FixPlanReply, userPoses: Pose[], frames: number): Pose[] => {
        const nextName = nextNamer(userPoses);
        const inShot = new Set(reply.poses.map(p => p.keyIndex));
        const parked: Pose[] = userPoses.filter((_, i) => !inShot.has(i)).map((p, i) => ({ ...p, frame: frames + i, parked: true }));
        const planned = reply.poses.map(({ pose, frame, keyIndex }): Pose => {
            const p = keyIndex !== null && userPoses[keyIndex];
            return p ? { ...p, frame, parked: undefined } : {
                id: newKeyId(),
                name: nextName(),
                frame,
                position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
                target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
                fov: pose.fov,
                auto: true
            };
        });
        return planned.concat(parked);
    };

    // One Fix path run under the progress handle h. popup: the balance
    // failure to explain once the progress is gone.
    const fixWith = async (h: ProgressHandle, options: Partial<FixPathOptions> | undefined, all: Pose[]): Promise<{ result: FixPathResult, popup?: string }> => {
        const opts = { ...settings, ...options };
        const start = performance.now();
        const before = all.map(p => ({ ...p, position: p.position.clone(), target: p.target.clone() }));
        const userPoses = all.filter(p => !p.auto);
        const snapshot = snapshotOf(events);
        const timeline = timelineSettings(events);

        const runOpening = Number.isFinite(options?.smallestOpening) ? options.smallestOpening : opening;
        const runEyeHeight = Number.isFinite(options?.eyeHeight) && options.eyeHeight > 0 ? options.eyeHeight : eyeHeight;

        h.update('measuring');
        const fallbackFov = events.invoke('camera.fov') as number;
        const sources = userPoses.map(p => ({ position: p.position, target: p.target, fov: p.fov ?? fallbackFov }));
        let distances: (number | null)[];
        try {
            distances = await sampleDistances(events, sources, h.signal);
        } catch (error) {
            if (isAbortError(error)) return { result: failure('cancelled') };
            throw error;
        }
        if (h.signal.aborted) return { result: failure('cancelled') };
        const sampleMs = performance.now() - start;

        const keys: FixKey[] = userPoses.map((p, i) => ({
            ...sources[i],
            name: p.name,
            linger: Math.max(0, finiteOr(p.linger, 0)),
            distance: distances[i] ?? NaN,
            orbit: p.orbit,
            lookAhead: p.lookAhead,
            turnIn: p.turnIn
        }));
        let reply: PlanReply | null;
        try {
            reply = await planner({
                keys,
                positions: userPoses.map(p => p.position),
                allowFlying: opts.allowFlying,
                keepOrder: opts.keepOrder,
                timeline,
                eyeHeight: runEyeHeight,
                openingAt: eye => clampOpening(runOpening, eye)
            }, { signal: h.signal, onProgress: h.update });
        } catch (error) {
            if (isAbortError(error)) return { result: failure('cancelled') };
            throw error;
        }
        if (h.signal.aborted) return { result: failure('cancelled') };
        // past the last cancel point: a cancelled run keeps the markers of the
        // last one, since the keys are unchanged
        clearMarkers();
        if (!reply) return { result: failure('noSplats') };
        if (runEyeHeight === undefined) estimate = reply.eyeHeight;
        const planMs = performance.now() - start - sampleMs;

        if (snapshotOf(events) !== snapshot) return { result: failure('keysChanged'), popup: 'keysChanged' };
        // every key needs a frame of its own
        if (reply.poses.length > timeline.frames) return { result: failure('tooFewFrames') };

        const poses = posesOf(reply, userPoses, timeline.frames);
        const applyStart = performance.now();
        events.fire('track.replacePath', poses);
        const applied = (events.invoke('camera.poses') as Pose[]).map(p => `${p.name}@${p.frame}`).sort().join('|');
        if (applied !== poses.map(p => `${p.name}@${p.frame}`).sort().join('|')) return { result: failure('rejected') };

        const { blocked, unreachable, insideGeometry, detours, balance, times, graph, box } = reply;
        setMarkers({ blocked, unreachable, insideGeometry, before });
        const ms = (t: number) => t.toFixed(0);
        console.debug(`path.fix: ${keys.length} keys, ${detours} detours in ${ms(performance.now() - start)} ms ` +
            `(distances ${ms(sampleMs)}, plan ${ms(planMs)}, routes ${ms(times.routes)}, detours ${ms(times.detours)}, ` +
            `apply ${ms(performance.now() - applyStart)})${graph ? `, graph ${graph.nodes} nodes, ${graph.edges} edges` : ''}`);

        // a lone key left in the shot needs no balancing
        const popup = 'reason' in balance && balance.reason !== 'tooFewKeys' ? balance.reason : undefined;
        return { result: { ok: true, detours, unreachable, blocked, insideGeometry, balance, metric: box ? looksMetric(box) : false }, popup };
    };

    // Order the user keys, add detour keys around geometry and balance the
    // timing, as one undo step. Old detour keys are replaced. Keys outside the
    // main group are parked after the end of the shot, in frame order; parked
    // keys of an earlier run are tried again. Runs under the progress dialog;
    // a cancelled run changes nothing, markers included.
    events.function('path.fix', async (options?: Partial<FixPathOptions>): Promise<FixPathResult> => {
        const all = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        if (all.filter(p => !p.auto).length < 2) return failure('tooFewKeys');
        const { result, popup } = await withProgress(events, 'timeline.fix-path', h => fixWith(h, options, all));
        if (popup) await showBalanceFailure(events, popup);
        return result;
    });
};

export { boxAroundKeys, inlinePlanner, registerFixPathEvents };
export type { EyeHeightInfo, FixPathDeps, FixPathOptions, FixPathResult, PathMarkers, Planner };
