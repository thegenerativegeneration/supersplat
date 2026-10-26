import { ADDRESS_CLAMP_TO_EDGE, FILTER_NEAREST, PROJECTION_PERSPECTIVE, RenderPass, RenderTarget, Texture, Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';

type CaptureView = { position: Vec3, target: Vec3, fov: number };

// a frame that never comes (hidden tab) gives the capture up after this long
const START_TIMEOUT_MS = 1000;
// the copy of the live image is kept this long after the last capture
const HELD_RELEASE_MS = 2000;

// premultiplied rgba over black from render.offscreen, so alpha is dropped
const canvasOf = (rgba: Uint8Array, width: number, height: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const pixels = new Uint8ClampedArray(rgba);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas;
};

/**
 * Runs `render` with background captures (key thumbnails) out of the way:
 * one being drawn finishes first and none starts until `render` settles.
 */
const claimRendering = async <T>(events: Events, render: () => Promise<T>) => {
    const claims = events.functions.has('render.claim');
    if (claims) await events.invoke('render.claim');
    try {
        return await render();
    } finally {
        if (claims) events.fire('render.release');
    }
};

// per scene: a copy of the last live image, shown while a capture's frame renders
const helds = new WeakMap<Scene, { target: RenderTarget | null, timer: ReturnType<typeof setTimeout> | null }>();

const heldOf = (scene: Scene) => {
    let held = helds.get(scene);
    if (!held) {
        held = { target: null, timer: null };
        helds.set(scene, held);
    }
    return held;
};

const releaseHeld = (scene: Scene) => {
    const held = heldOf(scene);
    held.target?.destroyTextureBuffers();
    held.target?.destroy();
    held.target = null;
};

// copies the live image before offscreen mode resizes the camera's targets
const holdLiveImage = (scene: Scene) => {
    const { graphicsDevice: device } = scene;
    const source = scene.camera.mainTarget;
    const held = heldOf(scene);
    clearTimeout(held.timer);
    const { width, height, format } = source.colorBuffer;
    if (held.target && (held.target.width !== width || held.target.height !== height)) releaseHeld(scene);
    if (!held.target) {
        held.target = new RenderTarget({
            colorBuffer: new Texture(device, {
                name: 'heldView',
                width,
                height,
                format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            }),
            depth: false,
            autoResolve: false
        });
    }
    held.target.copy(source, true, false);
    return held.target;
};

/**
 * Colour frames from views other than the live one, rendered with the live
 * camera. A capture starts inside a frame update and renders that frame
 * offscreen, while the canvas shows a copy of the last live image. Once the
 * capture's passes are recorded, the live view goes back, before the frame's
 * postrender, so the viewport, its overlays and input handlers never see the
 * camera elsewhere. The view goes on as a pose override, which leaves the
 * camera's own pose untouched. Rendering stays locked from the first capture
 * until `restore`.
 */
const createViewCapture = (events: Events, scene: Scene) => {
    const { camera } = scene;
    // the last live image, copied at the first capture: rendering stays
    // locked from then on, so no later live frame replaces it
    let held: RenderTarget | null = null;
    // the live camera and blit while a view is on
    let live: { fov: number, projection: number, aspectRatio: number, horizontalFov: boolean, blitVars: () => object } | null = null;
    // runs after a capture's passes and puts the live view back
    let liveAgain: RenderPass | null = null;

    const putBack = () => {
        if (!live) return;
        const { finalPass } = camera;
        const component = camera.camera;
        const passes = component.framePasses;
        if (passes.includes(liveAgain)) passes.splice(passes.indexOf(liveAgain), 1);
        finalPass.vars = live.blitVars;
        finalPass.enabled = !camera.targetSizeOverride;
        component.projection = live.projection;
        component.aspectRatio = live.aspectRatio;
        component.horizontalFov = live.horizontalFov;
        camera.fov = live.fov;
        live = null;
        // the component caches its view matrix until it is dirtied
        component.onAppPrerender();
        camera.setPoseOverride(null);
    };

    const start = (view: CaptureView, width: number, height: number) => {
        const { finalPass } = camera;
        const component = camera.camera;
        // locked mode renders only frames we ask for, always sorted and
        // never stochastic
        scene.lockedRenderMode = true;
        scene.lockedRender = true;
        live = {
            fov: camera.fov,
            projection: component.projection,
            aspectRatio: component.aspectRatio,
            horizontalFov: component.horizontalFov,
            blitVars: finalPass.vars
        };
        // the live frame's overdraw view, before offscreen mode turns overlays off
        const overdraw = scene.overdrawRender ? 1 : 0;
        held ??= holdLiveImage(scene);
        const shown = held;
        const frame = camera.frameAtPose(view.position, view.target, view.fov);
        // the component's field: the ortho setter fires an event
        component.projection = PROJECTION_PERSPECTIVE;
        camera.setPoseOverride({ position: frame.position, rotation: frame.rotation, fov: view.fov, near: frame.near, far: frame.far });
        const rgba = events.invoke('render.offscreen', width, height) as Promise<Uint8Array>;
        // offscreen mode turned the blit off; it shows the held image instead
        const device = scene.graphicsDevice;
        finalPass.vars = () => ({ srcTexture: shown.colorBuffer, blitScale: [shown.width / device.width, shown.height / device.height], overdraw });
        finalPass.enabled = true;
        if (!liveAgain) {
            liveAgain = new RenderPass(device);
            liveAgain.name = 'liveAgain';
            liveAgain.execute = putBack;
        }
        component.framePasses.push(liveAgain);
        return rgba.finally(putBack);
    };

    return {
        // the view's colour frame. With `ready`, null when it turned false by
        // the frame the capture would start in, or when no frame came.
        render: (view: CaptureView, width: number, height: number, ready?: () => boolean) => new Promise<Uint8Array | null>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const update = events.on('update', () => {
                // a live frame is owed: after a pick the target holds something
                // else, after motion it holds a noisy frame, until it renders
                if (!held && (scene.forceRender || scene.pendingResolve)) return;
                update.off();
                clearTimeout(timer);
                try {
                    if (!ready || ready()) start(view, width, height).then(resolve, reject);
                    else resolve(null);
                } catch (error) {
                    reject(error);
                }
            });
            if (ready) {
                timer = setTimeout(() => {
                    update.off();
                    resolve(null);
                }, START_TIMEOUT_MS);
            }
        }),
        restore: () => {
            // unlock first so a throwing camera call can't leave the editor locked
            scene.lockedRenderMode = false;
            scene.forceRender = true;
            putBack();
            if (held) {
                held = null;
                const cached = heldOf(scene);
                clearTimeout(cached.timer);
                cached.timer = setTimeout(() => releaseHeld(scene), HELD_RELEASE_MS);
            }
        }
    };
};

export { canvasOf, claimRendering, createViewCapture, type CaptureView };
