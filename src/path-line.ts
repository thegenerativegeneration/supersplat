import type { CurvePose } from './anim/camera-curve';
import { AUTO_KEY_COLOR, BLOCKED_COLOR, type Rgb } from './path/colors';

type PathLineOptions = {
    samplesPerSegment: number,
    // frames of the keys that start a blocked segment
    blocked: number[],
    // per key, parallel to frames
    auto: boolean[],
    // wraps the last key to the first, one timeline length later
    loop?: boolean,
    duration?: number,
    // colour of segments that are neither blocked nor next to an auto key
    color?: Rgb
};

const POSE_COLOR: Rgb = [0, 1, 1];

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
    const { samplesPerSegment, blocked, auto, loop = false, duration = Infinity, color = POSE_COLOR } = opts;
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

    const count = loop ? keys.length : keys.length - 1;
    for (let s = 0; s < count && keys.length > 1; s++) {
        const from = keys[s];
        const to = keys[(s + 1) % keys.length];
        const end = s + 1 < keys.length ? to.frame : to.frame + duration;
        const rgb = blocked.includes(from.frame) ? BLOCKED_COLOR : from.auto || to.auto ? AUTO_KEY_COLOR : color;
        for (let i = 0; i < samplesPerSegment; i++) {
            point(from.frame + (end - from.frame) * i / samplesPerSegment, rgb);
            point(from.frame + (end - from.frame) * (i + 1) / samplesPerSegment, rgb);
        }
    }
    return { positions, colors };
};

export { samplePathLine };
export type { PathLineOptions };
