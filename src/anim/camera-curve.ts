import { buildViewSpline } from './look-ahead-spline';
import type { Vec3Like } from '../candidates/occupancy';

// lookAhead, turnIn and auto: see ViewKey in look-ahead-spline.ts
type CurvePose = { position: Vec3Like, target: Vec3Like, fov: number, lookAhead?: boolean, turnIn?: number, auto?: boolean };

// frameRate times the look-ahead turns, which are in seconds
type CurveOptions = { duration: number, smoothness: number, loop: boolean, frameRate: number };

/**
 * Build the camera spline for the given keys. Keys at or beyond the duration
 * are ignored. Returns null with fewer than two usable keys. When not looping
 * the spline clamps, holding the outer poses beyond the first/last key. Keys
 * with look ahead change where the camera looks on the way to them.
 */
const buildCameraCurve = (poses: CurvePose[], frames: number[], opts: CurveOptions) => {
    const order = poses.map((_, i) => i)
    .filter(i => frames[i] < opts.duration)
    .sort((a, b) => frames[a] - frames[b]);

    if (order.length < 2) return null;

    const spline = buildViewSpline(order.map(i => poses[i]), order.map(i => frames[i]), opts);
    const result: number[] = [];

    return (frame: number, out: CurvePose): CurvePose => {
        spline(frame, result);
        out.position.x = result[0];
        out.position.y = result[1];
        out.position.z = result[2];
        out.target.x = result[3];
        out.target.y = result[4];
        out.target.z = result[5];
        out.fov = result[6];
        return out;
    };
};

export { buildCameraCurve, CurvePose, CurveOptions };
