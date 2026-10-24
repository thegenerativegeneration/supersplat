import { Vec3 } from 'playcanvas';

import type { BalanceResult } from './anim/balance-timing';
import { Pose } from './camera-poses';
import { insideBox, looksMetric, type Box } from './candidates/estimate';
import { buildSceneGrid } from './candidates/generate';
import type { DensitySplats } from './candidates/read-density';
import type { OpaquePoints } from './candidates/read-points';
import { Events } from './events';
import { CAMERA_RADIUS_VOXELS } from './path/clearance';
import { planFixPath, type FixKey, type RouteFn } from './path/fix-plan';
import { buildNavGrid, clampOpening, navHeadVoxels, type NavGrid } from './path/nav-grid';
import { finiteOr, showBalanceFailure, snapshotOf, timelineSettings } from './timing-events';

// smallestOpening: in scene units, see clampOpening; keepClear: check the
// camera as a ball of CAMERA_RADIUS_VOXELS; lookAhead: detour keys look
// ahead along the path (see lookOptions)
type FixPathOptions = { keepOrder: boolean, allowFlying: boolean, keepClear: boolean, lookAhead: boolean, smallestOpening: number };

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
    balance?: BalanceResult
};

type PathMarkers = { blocked: number[], unreachable: string[], insideGeometry: string[] };

// box: the area the grid covers; keys outside it are reported
type SceneGrid = { grid: NavGrid, eyeHeight: number, box?: Box };

// the smallest opening for an eye height
type OpeningAt = (eyeHeight: number) => number;

type FixPathDeps = {
    // the navigation grid of the scene, null without visible splats;
    // cameraRadius in voxels
    sceneGrid?: (allowFlying: boolean, openingAt: OpeningAt, cameraRadius: number) => Promise<SceneGrid | null>,
    route?: RouteFn
};

const NO_MARKERS: PathMarkers = { blocked: [], unreachable: [], insideGeometry: [] };

// changes after which the markers no longer describe the path
const STALE_EVENTS = [
    'track.keyAdded', 'track.keyRemoved', 'track.keyMoved', 'track.keyUpdated', 'track.keysLoaded', 'track.keysCleared',
    'timeline.smoothness', 'timeline.loop', 'timeline.frames'
];

// Grid from the cached scene points and splat extents, with the box and eye
// height of the last Suggest Views run, else fresh estimates.
const defaultSceneGrid = (events: Events) => async (allowFlying: boolean, openingAt: OpeningAt, cameraRadius: number): Promise<SceneGrid | null> => {
    const { points, extents } = await events.invoke('candidates.cloud') as OpaquePoints;
    if (!points || points.length === 0) return null;
    const settings: { box: Box, eyeHeight: number } = events.invoke('candidates.lastSettings') ?? await events.invoke('candidates.prepare');
    const { box, eyeHeight } = settings;
    const opening = openingAt(eyeHeight);
    const rule = events.functions.has('candidates.solidRule') ? events.invoke('candidates.solidRule') : 'bodies';
    const density = rule === 'density' ? await events.invoke('candidates.density') as DensitySplats : undefined;
    const { occ, levels } = buildSceneGrid(points, box, eyeHeight, navHeadVoxels(eyeHeight, opening), extents, density);
    return { grid: buildNavGrid(occ, levels, box, eyeHeight, allowFlying, opening, cameraRadius), eyeHeight, box };
};

type EyeHeightInfo = { eyeHeight: number, estimated: boolean, metric: boolean };

// box and eye height of the last Suggest Views run, if any
const lastSettingsOf = (events: Events): { box: Box, eyeHeight: number } | null => {
    return events.functions.has('candidates.lastSettings') ? events.invoke('candidates.lastSettings') : null;
};

// the eye height without waiting for an estimate: the last Suggest Views
// value, else the last one seen, else 1.6
const eyeHeightNow = (events: Events, estimate: number | null) => lastSettingsOf(events)?.eyeHeight ?? estimate ?? 1.6;

// the next free camera_N name
const namer = (poses: readonly Pose[]) => {
    let next = 1 + Math.max(-1, ...poses.map(p => Number(/^camera_(\d+)$/.exec(p.name)?.[1] ?? -1)));
    return () => `camera_${next++}`;
};

const registerFixPathEvents = (events: Events, deps: FixPathDeps = {}) => {
    const sceneGrid = deps.sceneGrid ?? defaultSceneGrid(events);
    const settings = { keepOrder: false, allowFlying: true, keepClear: false, lookAhead: false };
    // the user's smallest opening in scene units, undefined for the default
    let opening: number | undefined;
    let estimate: number | null = null;
    const openingAt = (eyeHeight: number) => clampOpening(opening, eyeHeight);
    // a new or loaded project starts from the default opening and wall
    // clearance and a fresh estimate
    events.on('scene.clear', () => {
        opening = undefined;
        settings.keepClear = false;
        settings.lookAhead = false;
        estimate = null;
    });
    let markersShown = false;

    const setMarkers = (markers: PathMarkers) => {
        markersShown = markers !== NO_MARKERS;
        events.fire('path.markers', markers);
    };
    const clearMarkers = () => markersShown && setMarkers(NO_MARKERS);
    for (const name of STALE_EVENTS) events.on(name, clearMarkers);

    events.function('path.settings', (): FixPathOptions => ({ ...settings, smallestOpening: openingAt(eyeHeightNow(events, estimate)) }));
    events.on('path.setSettings', (changes: Partial<FixPathOptions>) => {
        if (typeof changes.keepOrder === 'boolean') settings.keepOrder = changes.keepOrder;
        if (typeof changes.allowFlying === 'boolean') settings.allowFlying = changes.allowFlying;
        if (typeof changes.keepClear === 'boolean') settings.keepClear = changes.keepClear;
        if (typeof changes.lookAhead === 'boolean') settings.lookAhead = changes.lookAhead;
        if (Number.isFinite(changes.smallestOpening)) opening = changes.smallestOpening;
    });

    // the eye height Fix path will use and whether the scene looks metric;
    // null without splats to estimate from
    events.function('path.eyeHeight', async (): Promise<EyeHeightInfo | null> => {
        const last = lastSettingsOf(events);
        if (last) return { eyeHeight: last.eyeHeight, estimated: false, metric: looksMetric(last.box) };
        const prepared = await events.invoke('candidates.prepare') as { box: Box, eyeHeight: number, points: number };
        if (!(prepared.points > 0)) return null;
        estimate = prepared.eyeHeight;
        return { eyeHeight: prepared.eyeHeight, estimated: true, metric: looksMetric(prepared.box) };
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
        const cameraRadius = opts.keepClear ? CAMERA_RADIUS_VOXELS : 0;
        const scene = await sceneGrid(opts.allowFlying, eyeHeight => clampOpening(runOpening, eyeHeight), cameraRadius);
        if (!scene) return { ok: false, reason: 'noSplats', ...empty };
        estimate = scene.eyeHeight;
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
            distance: distances[i] ?? NaN
        }));
        const timeline = timelineSettings(events);
        const plan = planFixPath({
            keys,
            grid: scene.grid,
            eyeHeight: scene.eyeHeight,
            keepOrder: opts.keepOrder,
            timeline,
            route: deps.route,
            look: { enabled: opts.lookAhead }
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
        const outside = new Set(box ? keys.filter(k => !insideBox(k.position.x, k.position.y, k.position.z, box)).map(k => k.name) : []);
        const insideGeometry = keys.map(k => k.name).filter(n => outside.has(n) || plan.insideGeometry.includes(n));
        setMarkers({ blocked, unreachable, insideGeometry });
        const ms = (t: number) => t.toFixed(0);
        console.debug(`path.fix: ${keys.length} keys, ${detours} detours in ${ms(performance.now() - start)} ms ` +
            `(grid ${ms(gridMs)}, distances ${ms(sampleMs)}, routes ${ms(times.routes)}, detours ${ms(times.detours)}, ` +
            `apply ${ms(performance.now() - applyStart)})${graph ? `, graph ${graph.nodes} nodes, ${graph.edges} edges` : ''}`);

        // a lone key left in the shot needs no balancing
        if ('reason' in balance && balance.reason !== 'tooFewKeys') await showBalanceFailure(events, balance.reason);
        return { ok: true, detours, unreachable, blocked, insideGeometry, balance };
    });
};

export { registerFixPathEvents };
export type { EyeHeightInfo, FixPathDeps, FixPathOptions, FixPathResult, PathMarkers };
