import { Vec3 } from 'playcanvas';

import { runGeneration, THUMB_HEIGHT, THUMB_WIDTH, type GenerateOptions } from './candidates/generate';
import { readOpaquePoints, type OpaquePoints } from './candidates/read-points';
import type { Candidate } from './candidates/sample';
import type { Scored } from './candidates/score';
import type { Estimate, ProgressFn } from './compute/protocol';
import { computeOf } from './compute/scene-compute';
import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { canvasOf, claimRendering, createViewCapture } from './view-capture';

const copyPrepared = (p: Estimate): Estimate => ({ ...p, box: { min: { ...p.box.min }, max: { ...p.box.max } } });

const targetOf = (cand: Candidate, depth: number) => new Vec3(
    cand.position.x + cand.direction.x * depth,
    cand.position.y + cand.direction.y * depth,
    cand.position.z + cand.direction.z * depth
);

const registerCandidateEvents = (events: Events, scene: Scene) => {
    let points: Promise<OpaquePoints> | null = null;
    // the scene estimate for the points it was made from
    let estimate: { points: Promise<OpaquePoints>, result: Promise<Estimate> } | null = null;
    let lastEstimate: Estimate | null = null;
    let running = false;

    const invalidate = () => {
        points = null;
    };
    // only splats matter: the area box joins and leaves the scene as well
    for (const name of ['scene.elementAdded', 'scene.elementRemoved']) {
        events.on(name, (element: { type: ElementType }) => element?.type === ElementType.splat && invalidate());
    }
    for (const name of ['splat.moved', 'splat.visibility', 'splat.stateChanged', 'splat.positionsChanged', 'splat.replaced']) {
        events.on(name, invalidate);
    }

    // progress of reading the points and estimating from them, for every
    // caller waiting on them
    const readProgress: ProgressFn = (stage, done, total) => events.fire('candidates.readProgress', stage, done, total);

    // the result of start, with the read progress going to onProgress while it is pending
    const reporting = async <T>(onProgress: ProgressFn | undefined, start: () => Promise<T>) => {
        const handle = onProgress && events.on('candidates.readProgress', onProgress);
        try {
            return await start();
        } finally {
            handle?.off();
        }
    };

    const scenePoints = () => {
        if (!points) {
            const pending = readOpaquePoints(scene.getElementsByType(ElementType.splat) as Splat[], undefined, readProgress);
            pending.catch(() => {
                if (points === pending) points = null;
            });
            points = pending;
        }
        return points;
    };

    // the cached opaque splat centres (x, y, z triples) and extents of the visible layers
    events.function('candidates.cloud', (onProgress?: ProgressFn) => reporting(onProgress, scenePoints));

    // Area box, eye height and tilt estimated from the scene alone by the
    // scene compute, made once per points array. Suggest Views edits its
    // copy; Fix Path and Orbit use it as it is.
    events.function('candidates.prepare', (onProgress?: ProgressFn): Promise<Estimate> => reporting(onProgress, async () => {
        const cloud = scenePoints();
        if (estimate?.points !== cloud) {
            const result = cloud.then((read) => {
                readProgress('estimate');
                const compute = computeOf(events);
                return compute.run('estimate', { version: compute.pointsVersion(read) });
            });
            const entry = { points: cloud, result };
            result.then((p) => {
                if (estimate === entry) lastEstimate = p;
            }, () => {
                if (estimate === entry) estimate = null;
            });
            estimate = entry;
        }
        return copyPrepared(await estimate.result);
    }));

    // the last finished estimate, null before one or after the splats changed
    events.function('candidates.estimated', () => (lastEstimate && estimate?.points === points ? copyPrepared(lastEstimate) : null));

    events.function('candidates.generate', (opts: GenerateOptions, signal: AbortSignal): Promise<Scored[]> => claimRendering(events, async () => {
        if (running || scene.lockedRenderMode) throw new Error('candidates.generate: the editor is already rendering');
        running = true;
        try {
            const { points: pts, extents } = await scenePoints();
            const fov = opts.fov ?? scene.camera.fov;
            const capture = createViewCapture(events, scene);
            const depths = new Map<string, number>();
            const start = performance.now();
            let rendered = 0;

            const result = await runGeneration({
                sampleDistances: async (cands) => {
                    const poses = cands.map(c => ({ position: c.position, target: targetOf(c, 1), fov: c.fov }));
                    const out = await events.invoke('camera.sampleDistances', poses) as (number | null)[];
                    cands.forEach((c, i) => out[i] !== null && depths.set(c.id, out[i]));
                    return out;
                },
                renderAt: async (cand) => {
                    const view = { position: new Vec3(cand.position.x, cand.position.y, cand.position.z), target: targetOf(cand, depths.get(cand.id) ?? 1), fov: cand.fov };
                    const rgba = await capture.render(view, THUMB_WIDTH, THUMB_HEIGHT);
                    rendered++;
                    return { rgba, thumbnail: canvasOf(rgba, THUMB_WIDTH, THUMB_HEIGHT) };
                },
                restore: capture.restore,
                onProgress: (done, total) => events.fire('candidates.progress', done, total),
                onAdded: (scored, thumbnail) => events.fire('candidates.added', scored, thumbnail),
                onLevels: levels => events.fire('candidates.levels', levels)
            }, pts, { ...opts, fov }, signal, extents);

            console.debug(`candidates.generate: ${rendered} rendered in ${(performance.now() - start).toFixed(0)} ms`);
            events.fire('candidates.done', result.scored.length, result.reason);
            return result.scored;
        } finally {
            running = false;
        }
    }));
};

export { registerCandidateEvents };
