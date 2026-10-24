import type { Vec3Like } from '../candidates/occupancy';

// radius of the camera ball for "Keep clear of walls", in voxels; nodes in
// a two-voxel-wide door sit half a voxel from the jambs, so it stays below 0.5
const CAMERA_RADIUS_VOXELS = 0.4;

// distance from x to the interval [lo, lo + v]
const gap = (x: number, lo: number, v: number) => Math.max(0, lo - x, x - lo - v);

// Distance from p to the nearest occupied voxel box within maxVoxels voxels
// per axis of the voxel containing p: 0 inside one, Infinity when none.
// Exact for distances up to maxVoxels voxels.
const pointClearance = (
    occupied: (ix: number, iy: number, iz: number) => boolean,
    voxel: number,
    p: Vec3Like,
    maxVoxels = 1
): number => {
    const cx = Math.floor(p.x / voxel), cy = Math.floor(p.y / voxel), cz = Math.floor(p.z / voxel);
    let best2 = Infinity;
    for (let ix = cx - maxVoxels; ix <= cx + maxVoxels; ix++) {
        const dx = gap(p.x, ix * voxel, voxel);
        for (let iy = cy - maxVoxels; iy <= cy + maxVoxels; iy++) {
            const dy = gap(p.y, iy * voxel, voxel);
            for (let iz = cz - maxVoxels; iz <= cz + maxVoxels; iz++) {
                const d2 = dx * dx + dy * dy + gap(p.z, iz * voxel, voxel) ** 2;
                if (d2 < best2 && occupied(ix, iy, iz)) best2 = d2;
            }
        }
    }
    return Math.sqrt(best2);
};

export { CAMERA_RADIUS_VOXELS, pointClearance };
