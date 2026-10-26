import { Vec3 } from 'playcanvas';

import type { BalanceResult } from './anim/balance-timing';
import { Pose } from './camera-poses';
import { insideBox, looksMetric, type Box } from './candidates/estimate';
import { buildSceneGrid } from './candidates/generate';
import type { Vec3Like } from './candidates/occupancy';
import type { OpaquePoints } from './candidates/read-points';
import { Events } from './events';
import { planFixPath, type FixKey, type RouteFn } from './path/fix-plan';
import { buildNavGrid, clampOpening, navHeadVoxels, type NavGrid } from './path/nav-grid';
import { finiteOr, showBalanceFailure, snapshotOf, timelineSettings } from './timing-events';

// smallestOpening: in scene units, see clampOpening; eyeHeight: in scene units
type FixPathOptions = { keepOrder: boolean, allowFlying: boolean, smallestOpening: number, eyeHeight: number };

type FixPathResult = {
    ok: boolean,
    // rejected: the track refused the new path; tooFewFrames: more keys
    // than timeline frames
    reason?: 'tooFewKeys' | 'noSplats' | 'keysChanged' | 'tooFewFrames' | 'rejected',
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

type PathMarkers = { blocked: number[], unreachable: string[], insideGeometry: string[] };

// box: the area the graph covers
type SceneGrid = { grid: NavGrid, eyeHeight: number, box?: Box };

// the smallest opening for an eye height
type OpeningAt = (eyeHeight: number) => number;

type FixPathDeps = {
    // the navigation grid of the scene around the user key positions, at the
    // given eye height or the estimate; null without visible splats
    sceneGrid?: (allowFlying: boolean, openingAt: OpeningAt, positions?: Vec3Like[], eyeHeight?: number) => Promise<SceneGrid | null>,
    route?: RouteFn
};

const NO_MARKERS: PathMarkers = { blocked: [], unreachable: [], insideGeometry: [] };

// changes after which the markers no longer describe the path
const STALE_EVENTS = [
    'track.keyAdded', 'track.keyRemoved', 'track.keyMoved', 'track.keyUpdated', 'track.keysLoaded', 'track.keysCleared',
    'timeline.smoothness', 'timeline.loop', 'timeline.frames'
];

// box grown to hold each position outside it with margin on each side;
// positions inside leave it as it is
const boxAroundKeys = (box: Box, positions: Vec3Like[], margin: number): Box => {
    const min = { ...box.min }, max = { ...box.max };
    for (const p of positions) {
        if (insideBox(p.x, p.y, p.z, box)) continue;
        for (const axis of ['x', 'y', 'z'] as const) {
            min[axis] = Math.min(min[axis], p[axis] - margin);
            max[axis] = Math.max(max[axis], p[axis] + margin);
        }
    }
    return { min, max };
};

// Grid from the cached scene points and splat extents, in the estimated area
// box, at the given eye height or the estimate. The graph stays inside the
// box; its occupancy also covers the keys outside it plus one eye height, so
// straight moves from far keys see the geometry on their way.
const defaultSceneGrid = (events: Events) => async (allowFlying: boolean, openingAt: OpeningAt, positions: Vec3Like[] = [], userEyeHeight?: number): Promise<SceneGrid | null> => {
    const { points, extents } = await events.invoke('candidates.cloud') as OpaquePoints;
    if (!points || points.length === 0) return null;
    const estimate = await events.invoke('candidates.prepare') as { box: Box, eyeHeight: number };
    const { box } = estimate;
    const eyeHeight = userEyeHeight ?? estimate.eyeHeight;
    const opening = openingAt(eyeHeight);
    const { occ, levels } = buildSceneGrid(points, boxAroundKeys(box, positions, eyeHeight), eyeHeight, navHeadVoxels(eyeHeight, opening), extents);
    return { grid: buildNavGrid(occ, levels, box, eyeHeight, allowFlying, opening), eyeHeight, box };
};

// estimated: eyeHeight is the estimate, not the user's
type EyeHeightInfo = { eyeHeight: number, estimate: number, estimated: boolean, metric: boolean };

// the next free camera_N name
const namer = (poses: readonly Pose[]) => {
    let next = 1 + Math.max(-1, ...poses.map(p => Number(/^camera_(\d+)$/.exec(p.name)?.[1] ?? -1)));
    return () => `camera_${next++}`;
};

const registerFixPathEvents = (events: Events, deps: FixPathDeps = {}) => {
    const sceneGrid = deps.sceneGrid ?? defaultSceneGrid(events);
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

    // Order the user keys, add detour keys around geometry and balance the
    // timing, as one undo step. Old detour keys are replaced. Keys outside the
    // main group are parked after the end of the shot, in frame order; parked
    // keys of an earlier run are tried again.
    events.function('path.fix', async (options?: Partial<FixPathOptions>): Promise<FixPathResult> => {
        const opts = { ...settings, ...options };
        const start = performance.now();
        const empty = { detours: 0, unreachable: [] as string[], blocked: [] as number[], insideGeometry: [] as string[] };
        clearMarkers();

        const all = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        const userPoses = all.filter(p => !p.auto);
        if (userPoses.length < 2) return { ok: false, reason: 'tooFewKeys', ...empty };
        const snapshot = snapshotOf(events);

        const runOpening = Number.isFinite(options?.smallestOpening) ? options.smallestOpening : opening;
        const runEyeHeight = Number.isFinite(options?.eyeHeight) && options.eyeHeight > 0 ? options.eyeHeight : eyeHeight;
        const scene = await sceneGrid(opts.allowFlying, eye => clampOpening(runOpening, eye), userPoses.map(p => p.position), runEyeHeight);
        if (!scene) return { ok: false, reason: 'noSplats', ...empty };
        if (runEyeHeight === undefined) estimate = scene.eyeHeight;
        const gridMs = performance.now() - start;

        const fallbackFov = events.invoke('camera.fov') as number;
        const sources = userPoses.map(p => ({ position: p.position, target: p.target, fov: p.fov ?? fallbackFov }));
        const distances = await events.invoke('camera.sampleDistances', sources) as (number | null)[];
        const sampleMs = performance.now() - start - gridMs;

        if (snapshotOf(events) !== snapshot) {
            await showBalanceFailure(events, 'keysChanged');
            return { ok: false, reason: 'keysChanged', ...empty };
        }

        const keys: FixKey[] = userPoses.map((p, i) => ({
            ...sources[i],
            name: p.name,
            linger: Math.max(0, finiteOr(p.linger, 0)),
            distance: distances[i] ?? NaN,
            orbit: p.orbit
        }));
        const timeline = timelineSettings(events);
        const plan = planFixPath({
            keys,
            grid: scene.grid,
            eyeHeight: scene.eyeHeight,
            keepOrder: opts.keepOrder,
            timeline,
            route: deps.route
        });
        // every key needs a frame of its own
        if (plan.poses.length > timeline.frames) return { ok: false, reason: 'tooFewFrames', ...empty };

        const byKey = new Map(keys.map((k, i) => [k, userPoses[i]]));
        const nextName = namer(userPoses);
        const inShot = new Set(plan.poses.map(p => p.key));
        const parked: Pose[] = userPoses.filter((_, i) => !inShot.has(keys[i])).map((p, i) => ({ ...p, frame: timeline.frames + i, parked: true }));
        const planned = plan.poses.map(({ pose, frame, key }): Pose => {
            const p = key && byKey.get(key);
            return p ? { ...p, frame, parked: undefined } : {
                name: nextName(),
                frame,
                position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
                target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
                fov: pose.fov,
                auto: true
            };
        });
        const poses = planned.concat(parked);
        const applyStart = performance.now();
        events.fire('track.replacePath', poses);
        const applied = (events.invoke('camera.poses') as Pose[]).map(p => `${p.name}@${p.frame}`).sort().join('|');
        if (applied !== poses.map(p => `${p.name}@${p.frame}`).sort().join('|')) {
            return { ok: false, reason: 'rejected', ...empty };
        }

        const { blocked, unreachable, detours, balance, times, graph } = plan;
        const { box } = scene;
        const { insideGeometry } = plan;
        setMarkers({ blocked, unreachable, insideGeometry });
        const ms = (t: number) => t.toFixed(0);
        console.debug(`path.fix: ${keys.length} keys, ${detours} detours in ${ms(performance.now() - start)} ms ` +
            `(grid ${ms(gridMs)}, distances ${ms(sampleMs)}, routes ${ms(times.routes)}, detours ${ms(times.detours)}, ` +
            `apply ${ms(performance.now() - applyStart)})${graph ? `, graph ${graph.nodes} nodes, ${graph.edges} edges` : ''}`);

        // a lone key left in the shot needs no balancing
        if ('reason' in balance && balance.reason !== 'tooFewKeys') await showBalanceFailure(events, balance.reason);
        return { ok: true, detours, unreachable, blocked, insideGeometry, balance, metric: box ? looksMetric(box) : false };
    });
};

export { boxAroundKeys, registerFixPathEvents };
export type { EyeHeightInfo, FixPathDeps, FixPathOptions, FixPathResult, PathMarkers };
