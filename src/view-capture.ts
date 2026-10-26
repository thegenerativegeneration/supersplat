import { PROJECTION_PERSPECTIVE, Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';

type CaptureView = { position: Vec3, target: Vec3, fov: number };

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
 * Colour frames from views other than the live one, rendered with the live
 * camera. A capture starts inside a frame update, renders that frame
 * offscreen and puts the live view back when the frame ends, so the viewport
 * and input handlers never see the camera elsewhere. The view goes on as a
 * pose override, which leaves the camera's own pose untouched. Rendering stays
 * locked from the first capture until `restore`.
 */
const createViewCapture = (events: Events, scene: Scene) => {
    const { camera } = scene;
    // the live fov and projection while a view is on
    let live: { fov: number, projection: number } | null = null;

    const putBack = () => {
        if (!live) return;
        camera.camera.projection = live.projection;
        camera.fov = live.fov;
        live = null;
        camera.setPoseOverride(null);
    };

    const start = (view: CaptureView, width: number, height: number) => {
        // locked mode renders only frames we ask for, always sorted and
        // never stochastic, and keeps the viewport from showing the capture
        scene.lockedRenderMode = true;
        scene.lockedRender = true;
        live = { fov: camera.fov, projection: camera.camera.projection };
        const frame = camera.frameAtPose(view.position, view.target, view.fov);
        // the component's field: the ortho setter fires an event
        camera.camera.projection = PROJECTION_PERSPECTIVE;
        camera.setPoseOverride({ position: frame.position, rotation: frame.rotation, fov: view.fov, near: frame.near, far: frame.far });
        const drawn = events.on('postrender', () => {
            drawn.off();
            putBack();
        });
        const rgba = events.invoke('render.offscreen', width, height) as Promise<Uint8Array>;
        return rgba.finally(() => drawn.off());
    };

    return {
        // the view's colour frame, or null when `ready` turned false by the
        // frame the capture would start in
        render: (view: CaptureView, width: number, height: number, ready = () => true) => new Promise<Uint8Array | null>((resolve, reject) => {
            const update = events.on('update', () => {
                update.off();
                try {
                    if (ready()) start(view, width, height).then(resolve, reject);
                    else resolve(null);
                } catch (error) {
                    reject(error);
                }
            });
        }),
        restore: () => {
            // unlock first so a throwing camera call can't leave the editor locked
            scene.lockedRenderMode = false;
            scene.forceRender = true;
            putBack();
        }
    };
};

export { canvasOf, createViewCapture, type CaptureView };
