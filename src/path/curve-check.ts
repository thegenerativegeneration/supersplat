import type { NavGrid } from './nav-grid';
import type { CurvePose } from '../anim/camera-curve';
import type { Vec3Like } from '../candidates/occupancy';

type CameraCurve = (frame: number, out: CurvePose) => CurvePose;

type Collision = { segment: number, point: Vec3Like };

// samples this close to a user key position (in voxels) are not checked
const KEY_SKIP_VOXELS = 2;
// subdivision depth per frame interval: 2^-16 frame
const MAX_DEPTH = 16;

const newPose = (): CurvePose => ({ position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 0 });

const dist2 = (a: Vec3Like, b: Vec3Like) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

// First sample of each segment whose position lies in an occupied voxel.
// Segment i runs from frames[i] to frames[i + 1] (for a looping curve pass
// frames[0] + duration as the last entry to check the closing segment).
// Each frame interval is bisected until consecutive samples are at most step
// apart; samples within KEY_SKIP_VOXELS of the curve at a user frame are
// skipped.
const curveCollisions = (curve: CameraCurve, frames: number[], grid: NavGrid, userFrames: number[], step: number): Collision[] => {
    const skip2 = (KEY_SKIP_VOXELS * grid.voxel) ** 2;
    const step2 = step * step;
    const keys = userFrames.map(f => ({ ...curve(f, newPose()).position }));
    const pose = newPose();
    const at = (frame: number): Vec3Like => ({ ...curve(frame, pose).position });
    const bad = (p: Vec3Like) => !grid.pointFree(p) && keys.every(k => dist2(k, p) > skip2);

    // first bad sample in (t0, t1], or null; p0 = position at t0
    const scan = (t0: number, p0: Vec3Like, t1: number, p1: Vec3Like, depth: number): Vec3Like | null => {
        if (depth >= MAX_DEPTH || dist2(p0, p1) <= step2) return bad(p1) ? p1 : null;
        const tm = 0.5 * (t0 + t1);
        const pm = at(tm);
        return scan(t0, p0, tm, pm, depth + 1) ?? scan(tm, pm, t1, p1, depth + 1);
    };

    const out: Collision[] = [];
    for (let i = 0; i + 1 < frames.length; i++) {
        const a = frames[i], b = frames[i + 1];
        if (!(b > a)) continue;
        let p = at(a);
        let hit = bad(p) ? p : null;
        const n = Math.ceil(b - a);
        for (let k = 1; !hit && k <= n; k++) {
            const t1 = a + (b - a) * k / n;
            const p1 = at(t1);
            hit = scan(a + (b - a) * (k - 1) / n, p, t1, p1, 0);
            p = p1;
        }
        if (hit) out.push({ segment: i, point: hit });
    }
    return out;
};

// indices of the segments whose sampled curve enters an occupied voxel
const checkCurve = (curve: CameraCurve, frames: number[], grid: NavGrid, userFrames: number[], step: number): number[] => {
    return curveCollisions(curve, frames, grid, userFrames, step).map(c => c.segment);
};

export { checkCurve, curveCollisions };
export type { CameraCurve, Collision };
