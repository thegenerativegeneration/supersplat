import { Vec3 } from 'playcanvas';

import type { BalanceResult } from './anim/balance-timing';
import { Pose } from './camera-poses';
import { insideBox, type Box } from './candidates/estimate';
import { buildSceneGrid } from './candidates/generate';
import { Events } from './events';
import { planFixPath, type FixKey, type RouteFn } from './path/fix-plan';
import { buildNavGrid, NAV_HEAD_VOXELS, type NavGrid } from './path/nav-grid';
import { finiteOr, showBalanceFailure, snapshotOf, timelineSettings } from './timing-events';

type FixPathOptions = { keepOrder: boolean, allowFlying: boolean };

type FixPathResult = {
    ok: boolean,
    // rejected: the track refused the new path; tooFewFrames: more keys
    // than timeline frames
    reason?: 'tooFewKeys' | 'noSplats' | 'keysChanged' | 'tooFewFrames' | 'rejected',
    detours: number,
    // key names
    unreachable: string[],
    // frames of the keys that start a blocked segment
    blocked: number[],
    insideGeometry: string[],
    balance?: BalanceResult
};

type PathMarkers = { blocked: number[], unreachable: string[], insideGeometry: string[] };

// box: the area the grid covers; keys outside it are reported
type SceneGrid = { grid: NavGrid, eyeHeight: number, box?: Box };

type FixPathDeps = {
    // the navigation grid of the scene, null without visible splats
    sceneGrid?: (allowFlying: boolean) => Promise<SceneGrid | null>,
    route?: RouteFn
};

const NO_MARKERS: PathMarkers = { blocked: [], unreachable: [], insideGeometry: [] };

// changes after which the markers no longer describe the path
const STALE_EVENTS = [
    'track.keyAdded', 'track.keyRemoved', 'track.keyMoved', 'track.keyUpdated', 'track.keysLoaded', 'track.keysCleared',
    'timeline.smoothness', 'timeline.loop', 'timeline.frames'
];

// Grid from the cached scene points, with the box and eye height of the last
// Suggest Views run, else fresh estimates.
const defaultSceneGrid = (events: Events) => async (allowFlying: boolean): Promise<SceneGrid | null> => {
    const points = await events.invoke('candidates.points') as Float32Array;
    if (!points || points.length === 0) return null;
    const settings: { box: Box, eyeHeight: number } = events.invoke('candidates.lastSettings') ?? await events.invoke('candidates.prepare');
    const { box, eyeHeight } = settings;
    const { occ, levels } = buildSceneGrid(points, box, eyeHeight, NAV_HEAD_VOXELS);
    return { grid: buildNavGrid(occ, levels, box, eyeHeight, allowFlying), eyeHeight, box };
};

// the next free camera_N name
const namer = (poses: readonly Pose[]) => {
    let next = 1 + Math.max(-1, ...poses.map(p => Number(/^camera_(\d+)$/.exec(p.name)?.[1] ?? -1)));
    return () => `camera_${next++}`;
};

const registerFixPathEvents = (events: Events, deps: FixPathDeps = {}) => {
    const sceneGrid = deps.sceneGrid ?? defaultSceneGrid(events);
    const settings: FixPathOptions = { keepOrder: false, allowFlying: true };
    let markersShown = false;

    const setMarkers = (markers: PathMarkers) => {
        markersShown = markers !== NO_MARKERS;
        events.fire('path.markers', markers);
    };
    const clearMarkers = () => markersShown && setMarkers(NO_MARKERS);
    for (const name of STALE_EVENTS) events.on(name, clearMarkers);

    events.function('path.settings', (): FixPathOptions => ({ ...settings }));
    events.on('path.setSettings', (changes: Partial<FixPathOptions>) => {
        if (typeof changes.keepOrder === 'boolean') settings.keepOrder = changes.keepOrder;
        if (typeof changes.allowFlying === 'boolean') settings.allowFlying = changes.allowFlying;
    });

    // Order the user keys, add detour keys around geometry and balance the
    // timing, as one undo step. Old detour keys are replaced.
    events.function('path.fix', async (options?: Partial<FixPathOptions>): Promise<FixPathResult> => {
        const opts = { ...settings, ...options };
        const start = performance.now();
        const empty = { detours: 0, unreachable: [] as string[], blocked: [] as number[], insideGeometry: [] as string[] };
        clearMarkers();

        const all = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        const userPoses = all.filter(p => !p.auto);
        if (userPoses.length < 2) return { ok: false, reason: 'tooFewKeys', ...empty };
        const snapshot = snapshotOf(events);

        const scene = await sceneGrid(opts.allowFlying);
        if (!scene) return { ok: false, reason: 'noSplats', ...empty };
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
            route: deps.route
        });
        // every key needs a frame of its own
        if (plan.poses.length > timeline.frames) return { ok: false, reason: 'tooFewFrames', ...empty };

        const byKey = new Map(keys.map((k, i) => [k, userPoses[i]]));
        const nextName = namer(userPoses);
        const poses: Pose[] = plan.poses.map(({ pose, frame, key }) => {
            const p = key && byKey.get(key);
            return p ? { ...p, frame } : {
                name: nextName(),
                frame,
                position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
                target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
                fov: pose.fov,
                auto: true
            };
        });
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

        if ('reason' in balance) await showBalanceFailure(events, balance.reason);
        return { ok: true, detours, unreachable, blocked, insideGeometry, balance };
    });
};

export { registerFixPathEvents };
export type { FixPathDeps, FixPathOptions, FixPathResult, PathMarkers };
