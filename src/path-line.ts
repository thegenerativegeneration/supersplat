import type { CurvePose } from './anim/camera-curve';
import { AUTO_KEY_COLOR, BLOCKED_COLOR, type Rgb } from './path/colors';

type PathLineOptions = {
    samplesPerSegment: number,
    // frames of the user keys that start a blocked segment; it runs to the
    // next key that is not auto
    blocked: number[],
    // per key, parallel to frames
    auto: boolean[],
    // wraps the last key to the first, one timeline length later
    loop?: boolean,
    duration?: number,
    // colour of segments that are neither blocked nor next to an auto key
    color?: Rgb,
    // keep every other line only
    dashed?: boolean
};

type LookTickOptions = {
    // frames between ticks
    step: number,
    // in scene units
    length: number,
    duration: number,
    // runs on from the last key back to the first, one timeline length later
    loop?: boolean
};

// look ticks: 3% of the spread of the keys, so they read at the scale of the shot
const LOOK_TICK_FRACTION = 0.03;
const LOOK_TICK_MIN = 0.1;

const POSE_COLOR: Rgb = [0, 1, 1];

type PoseInfo = { name: string, frame?: number, auto?: boolean, parked?: boolean };

// frustum colour per pose: unreachable keys and keys parked after the end of
// the shot (at or past duration) red, detour keys in the auto colour
const poseColors = (poses: readonly PoseInfo[], unreachable: readonly string[], duration = Infinity): Rgb[] => {
    const cut = new Set(unreachable);
    const red = (p: PoseInfo) => cut.has(p.name) || (!!p.parked && p.frame >= duration);
    return poses.map(p => (red(p) ? BLOCKED_COLOR : p.auto ? AUTO_KEY_COLOR : POSE_COLOR));
};

/**
 * Line-list vertices along the camera curve, one run of samplesPerSegment lines
 * per segment between neighbouring keys. Positions are xyz, colours rgb in 0..1.
 * Keys at or beyond the duration are skipped, like the curve does.
 */
const samplePathLine = (
    curve: (frame: number, out: CurvePose) => CurvePose,
    frames: number[],
    opts: PathLineOptions
) => {
    const { samplesPerSegment, blocked, auto, loop = false, duration = Infinity, color = POSE_COLOR, dashed = false } = opts;
    const keys = frames.map((frame, i) => ({ frame, auto: !!auto[i] }))
    .filter(k => k.frame < duration)
    .sort((a, b) => a.frame - b.frame);

    const positions: number[] = [];
    const colors: number[] = [];
    const out: CurvePose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 0 };
    const point = (frame: number, rgb: Rgb) => {
        const { x, y, z } = curve(frame, out).position;
        positions.push(x, y, z);
        colors.push(rgb[0], rgb[1], rgb[2]);
    };

    // a blocked user key's segment runs through the detours up to the next user key
    let inBlocked = false;
    if (loop) {
        const last = keys.filter(k => !k.auto).pop();
        inBlocked = !!last && blocked.includes(last.frame);
    }

    const count = loop ? keys.length : keys.length - 1;
    for (let s = 0; s < count && keys.length > 1; s++) {
        const from = keys[s];
        const to = keys[(s + 1) % keys.length];
        const end = s + 1 < keys.length ? to.frame : to.frame + duration;
        if (!from.auto) inBlocked = blocked.includes(from.frame);
        const rgb = inBlocked ? BLOCKED_COLOR : from.auto || to.auto ? AUTO_KEY_COLOR : color;
        for (let i = dashed ? s * samplesPerSegment % 2 : 0; i < samplesPerSegment; i += dashed ? 2 : 1) {
            point(from.frame + (end - from.frame) * i / samplesPerSegment, rgb);
            point(from.frame + (end - from.frame) * (i + 1) / samplesPerSegment, rgb);
        }
    }
    return { positions, colors };
};

/**
 * Line-list vertices of short ticks along the camera curve, one every step
 * frames from the first key to the last (or round the loop), each from the
 * camera position towards its target.
 */
const sampleLookTicks = (
    curve: ((frame: number, out: CurvePose) => CurvePose) | null,
    frames: number[],
    opts: LookTickOptions
) => {
    const { step, length, duration, loop = false } = opts;
    const keyed = frames.filter(f => f < duration).sort((a, b) => a - b);
    const positions: number[] = [];
    if (!curve || keyed.length < 2 || !(step > 0)) return positions;

    const first = keyed[0];
    const last = loop ? first + duration : keyed[keyed.length - 1];
    const out: CurvePose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 0 };
    for (let frame = first; frame <= last + 1e-9; frame += step) {
        const { position: p, target: t } = curve(frame, out);
        const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (!(d > 0)) continue;
        const k = length / d;
        positions.push(p.x, p.y, p.z, p.x + dx * k, p.y + dy * k, p.z + dz * k);
    }
    return positions;
};

// tick length for keys at these positions
const lookTickLength = (poses: readonly { position: { x: number, y: number, z: number } }[]) => {
    if (poses.length === 0) return LOOK_TICK_MIN;
    const axes = ['x', 'y', 'z'] as const;
    const spans = axes.map(a => Math.max(...poses.map(p => p.position[a])) - Math.min(...poses.map(p => p.position[a])));
    return Math.max(LOOK_TICK_MIN, Math.hypot(...spans) * LOOK_TICK_FRACTION);
};

export { lookTickLength, poseColors, sampleLookTicks, samplePathLine };
export type { LookTickOptions, PathLineOptions };
