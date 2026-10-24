import { CubicSpline } from './spline';
import type { Vec3Like } from '../candidates/occupancy';

type CurvePose = { position: Vec3Like, target: Vec3Like, fov: number };

type CurveOptions = { duration: number, smoothness: number, loop: boolean };

/**
 * Build the camera spline for the given keys. Keys at or beyond the duration
 * are ignored. Returns null with fewer than two usable keys. When not looping
 * the spline clamps, holding the outer poses beyond the first/last key.
 */
const buildCameraCurve = (poses: CurvePose[], frames: number[], opts: CurveOptions) => {
    const order = poses.map((_, i) => i)
    .filter(i => frames[i] < opts.duration)
    .sort((a, b) => frames[a] - frames[b]);

    if (order.length < 2) return null;

    const times = order.map(i => frames[i]);
    const points: number[] = [];
    for (const i of order) {
        const p = poses[i];
        points.push(p.position.x, p.position.y, p.position.z);
        points.push(p.target.x, p.target.y, p.target.z);
        points.push(p.fov);
    }

    const spline = opts.loop ?
        CubicSpline.fromPointsLooping(opts.duration, times, points, opts.smoothness) :
        CubicSpline.fromPoints(times, points, opts.smoothness);
    const result: number[] = [];

    return (frame: number, out: CurvePose): CurvePose => {
        spline.evaluate(frame, result);
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
