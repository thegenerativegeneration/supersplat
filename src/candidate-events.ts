import { Vec3 } from 'playcanvas';

import { estimateEyeHeight, estimateTiltDeg, proposeBox, type Box } from './candidates/estimate';
import { runGeneration, THUMB_HEIGHT, THUMB_WIDTH, type GenerateOptions } from './candidates/generate';
import { readOpaquePoints, type OpaquePoints } from './candidates/read-points';
import type { Candidate } from './candidates/sample';
import type { Scored } from './candidates/score';
import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';

type Pose = { position: Vec3, target: Vec3 };

const targetOf = (cand: Candidate, depth: number) => new Vec3(
    cand.position.x + cand.direction.x * depth,
    cand.position.y + cand.direction.y * depth,
    cand.position.z + cand.direction.z * depth
);

// premultiplied rgba over black, so alpha is dropped
const thumbnailOf = (rgba: Uint8Array) => {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const pixels = new Uint8ClampedArray(rgba);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    canvas.getContext('2d').putImageData(new ImageData(pixels, THUMB_WIDTH, THUMB_HEIGHT), 0, 0);
    return canvas;
};

const registerCandidateEvents = (events: Events, scene: Scene) => {
    let points: Promise<OpaquePoints> | null = null;
    let running = false;
    // box and eye height of the last Suggest Views run in this session
    let lastSettings: { box: Box, eyeHeight: number } | null = null;

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

    const scenePoints = () => {
        if (!points) {
            const pending = readOpaquePoints(scene.getElementsByType(ElementType.splat) as Splat[]);
            pending.catch(() => {
                if (points === pending) points = null;
            });
            points = pending;
        }
        return points;
    };

    // the cached opaque splat centres (x, y, z triples) and extents of the visible layers
    events.function('candidates.cloud', () => scenePoints());

    events.function('candidates.lastSettings', () => lastSettings);

    events.function('candidates.prepare', async () => {
        const { points: pts } = await scenePoints();
        const box = proposeBox(pts);
        return {
            box,
            eyeHeight: estimateEyeHeight(pts, box),
            tiltDeg: estimateTiltDeg(pts),
            points: pts.length / 3
        };
    });

    events.function('candidates.generate', async (opts: GenerateOptions, signal: AbortSignal): Promise<Scored[]> => {
        if (running || scene.lockedRenderMode) throw new Error('candidates.generate: the editor is already rendering');
        running = true;
        lastSettings = {
            box: { min: { ...opts.box.min }, max: { ...opts.box.max } },
            eyeHeight: opts.eyeHeight
        };
        try {
            const { points: pts, extents } = await scenePoints();
            const { camera } = scene;
            const fov = opts.fov ?? camera.fov;
            const saved = events.invoke('camera.getPose');
            const user: Pose = {
                position: new Vec3(saved.position.x, saved.position.y, saved.position.z),
                target: new Vec3(saved.target.x, saved.target.y, saved.target.z)
            };
            const savedFov = camera.fov;
            const savedOrtho = camera.ortho;
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
                    // locked mode renders only frames we ask for, always sorted and
                    // never stochastic, and keeps the viewport from showing candidates
                    scene.lockedRenderMode = true;
                    scene.lockedRender = true;
                    camera.fov = cand.fov;
                    camera.setPose(new Vec3(cand.position.x, cand.position.y, cand.position.z), targetOf(cand, depths.get(cand.id) ?? 1), 0);
                    const rgba = await events.invoke('render.offscreen', THUMB_WIDTH, THUMB_HEIGHT) as Uint8Array;
                    rendered++;
                    return { rgba, thumbnail: thumbnailOf(rgba) };
                },
                restore: () => {
                    // unlock first so a throwing camera call can't leave the editor locked
                    scene.lockedRenderMode = false;
                    scene.forceRender = true;
                    camera.fov = savedFov;
                    camera.setPose(user.position, user.target, 0);
                    camera.ortho = savedOrtho;
                    camera.onUpdate(0);
                },
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
    });
};

export { registerCandidateEvents };
