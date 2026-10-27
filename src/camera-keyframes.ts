import { buildCameraCurve, type CurvePose } from './anim/camera-curve';
import type { Pose } from './camera-poses';

type CameraKeyframes = {
    times: number[],
    values: { position: number[], target: number[], fov: number[] }
};

type KeyframeOptions = { frames: number, frameRate: number, smoothness: number, loop: boolean, fov: number };

const BAKE_STEP = 2;

const push = (out: CameraKeyframes, time: number, p: CurvePose) => {
    out.times.push(time);
    out.values.position.push(p.position.x, p.position.y, p.position.z);
    out.values.target.push(p.target.x, p.target.y, p.target.z);
    out.values.fov.push(p.fov);
};

// frames from first to last in steps of BAKE_STEP, always ending on last
const sampleFrames = (first: number, last: number) => {
    const result: number[] = [];
    for (let f = first; f < last; f += BAKE_STEP) result.push(f);
    result.push(last);
    return result;
};

/**
 * The keyframes the web viewer's spline track is built from. Poses are the
 * shot's keys sorted by frame, all inside [0, frames). Without look ahead the
 * keys are written as they are. With it the viewer cannot compute the aim, so
 * the editor curve is baked into keys every 2 frames (looping shots also
 * cover the stretch back to the first key); the viewer's spline then passes
 * through them and reproduces the curve.
 */
const cameraKeyframes = (poses: Pose[], opts: KeyframeOptions): CameraKeyframes => {
    const out: CameraKeyframes = { times: [], values: { position: [], target: [], fov: [] } };
    const keys = poses.map(p => ({ ...p, fov: p.fov ?? opts.fov }));

    const curve = poses.some(p => p.lookAhead) && buildCameraCurve(keys, keys.map(k => k.frame), {
        duration: opts.frames,
        smoothness: opts.smoothness,
        loop: opts.loop,
        frameRate: opts.frameRate
    });

    if (!curve) {
        keys.forEach(k => push(out, k.frame, k));
        return out;
    }

    const first = keys[0].frame;
    const last = keys[keys.length - 1].frame;
    const times = sampleFrames(first, last);
    if (opts.loop) {
        for (let f = last + BAKE_STEP; f < opts.frames; f += BAKE_STEP) times.push(f);
    }

    const sample: CurvePose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 0 };
    for (const t of times) {
        push(out, t, curve(t, sample));
    }
    return out;
};

export { cameraKeyframes, type CameraKeyframes };
