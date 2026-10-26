import assert from 'node:assert/strict';

import { NullGraphicsDevice, PIXELFORMAT_RGBA16F, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, Quat, RenderTarget, Texture, Vec3 } from 'playcanvas';

import { Events } from './.build/src/events.js';
import { claimRendering, createViewCapture } from './.build/src/view-capture.js';

// a scene whose camera records what a capture does to it; render.offscreen
// enters offscreen mode at once and settles when the test says
const harness = () => {
    const device = new NullGraphicsDevice();
    const events = new Events();
    const mainTarget = new RenderTarget({
        colorBuffer: new Texture(device, { width: 8, height: 4, format: PIXELFORMAT_RGBA16F, mipmaps: false }),
        depth: false
    });
    const liveVars = () => ({ live: true });
    const camera = {
        fov: 50,
        poseOverride: null,
        targetSizeOverride: null,
        mainTarget,
        finalPass: { vars: liveVars, enabled: true },
        camera: { projection: PROJECTION_ORTHOGRAPHIC, aspectRatio: 2, horizontalFov: true, framePasses: ['main', 'final'], onAppPrerender() {} },
        frameAtPose: (position, target, fov) => ({ position, rotation: new Quat(), fov, near: 0.1, far: 50 }),
        setPoseOverride(override) {
            this.poseOverride = override;
        }
    };
    const scene = { graphicsDevice: device, camera, lockedRenderMode: false, lockedRender: false, forceRender: false, overdrawRender: false };
    const offscreen = {};
    events.function('render.offscreen', (width, height) => {
        camera.targetSizeOverride = { width, height };
        camera.finalPass.enabled = false;
        camera.camera.aspectRatio = width / height;
        return new Promise((resolve, reject) => {
            offscreen.resolve = (rgba) => {
                camera.targetSizeOverride = null;
                camera.finalPass.enabled = true;
                resolve(rgba);
            };
            offscreen.reject = (error) => {
                camera.targetSizeOverride = null;
                camera.finalPass.enabled = true;
                reject(error);
            };
        });
    });
    const view = { position: new Vec3(1, 2, 3), target: new Vec3(1, 2, 0), fov: 70 };
    const cleanup = () => {
        mainTarget.destroyTextureBuffers();
        mainTarget.destroy();
        device.destroy();
    };
    return { events, scene, camera, liveVars, offscreen, view, cleanup };
};

const viewCaptureChecks = {
    async 'capture: the frame shows the held live image, and its last pass puts the live view back'() {
        const { events, scene, camera, liveVars, offscreen, view, cleanup } = harness();
        try {
            const capture = createViewCapture(events, scene);
            const pending = capture.render(view, 160, 100, () => true);
            assert.equal(camera.poseOverride, null, 'nothing happens before a frame update');
            events.fire('update');
            assert.ok(camera.poseOverride, 'the view is on for this frame');
            assert.equal(camera.camera.projection, PROJECTION_PERSPECTIVE);
            assert.equal(scene.lockedRenderMode, true);
            // the canvas is not left unwritten: the blit shows the held image
            assert.equal(camera.finalPass.enabled, true);
            const blit = camera.finalPass.vars();
            assert.equal(blit.srcTexture.width, 8);
            assert.notEqual(blit.srcTexture, camera.mainTarget.colorBuffer);
            const passes = camera.camera.framePasses;
            assert.equal(passes.length, 3);
            // the frame graph runs the last pass: live again before postrender
            passes[2].execute();
            assert.equal(camera.poseOverride, null);
            assert.equal(camera.fov, 50);
            assert.equal(camera.camera.projection, PROJECTION_ORTHOGRAPHIC);
            assert.equal(camera.camera.aspectRatio, 2, 'overlays project with the live aspect');
            assert.equal(camera.finalPass.vars, liveVars);
            assert.equal(camera.finalPass.enabled, false, 'still offscreen while the readback runs');
            assert.deepEqual(passes, ['main', 'final']);
            offscreen.resolve(new Uint8Array(4));
            assert.deepEqual(await pending, new Uint8Array(4));
            assert.equal(camera.finalPass.enabled, true);
            capture.restore();
            assert.equal(scene.lockedRenderMode, false);
            assert.equal(scene.forceRender, true);
        } finally {
            cleanup();
        }
    },

    async 'capture: a failed offscreen render still puts the live view and blit back'() {
        const { events, scene, camera, liveVars, offscreen, view, cleanup } = harness();
        try {
            const capture = createViewCapture(events, scene);
            const pending = capture.render(view, 160, 100);
            events.fire('update');
            offscreen.reject(new Error('lost'));
            await assert.rejects(pending, /lost/);
            assert.equal(camera.poseOverride, null);
            assert.equal(camera.fov, 50);
            assert.equal(camera.finalPass.vars, liveVars);
            assert.equal(camera.finalPass.enabled, true);
            assert.deepEqual(camera.camera.framePasses, ['main', 'final']);
            capture.restore();
            assert.equal(scene.lockedRenderMode, false);
        } finally {
            cleanup();
        }
    },

    async 'capture: waits out an owed live frame, and steps aside when not ready'() {
        const { events, scene, camera, view, cleanup } = harness();
        try {
            const capture = createViewCapture(events, scene);
            scene.forceRender = true;
            const pending = capture.render(view, 160, 100, () => false);
            events.fire('update');
            assert.equal(camera.poseOverride, null, 'the target holds something else until the live frame renders');
            scene.forceRender = false;
            events.fire('update');
            assert.equal(await pending, null);
            assert.equal(scene.lockedRenderMode, false);
        } finally {
            cleanup();
        }
    },

    async 'capture: renders claim background captures and release them, also on failure'() {
        const events = new Events();
        const log = [];
        events.function('render.claim', async () => log.push('claim'));
        events.on('render.release', () => log.push('release'));
        assert.equal(await claimRendering(events, async () => {
            log.push('render');
            return 7;
        }), 7);
        await assert.rejects(claimRendering(events, async () => {
            throw new Error('no');
        }), /no/);
        assert.deepEqual(log, ['claim', 'render', 'release', 'claim', 'release']);
        // without background captures there is nothing to claim
        assert.equal(await claimRendering(new Events(), async () => 1), 1);
    }
};

export { viewCaptureChecks };
