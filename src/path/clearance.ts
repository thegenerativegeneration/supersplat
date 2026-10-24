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

// how far, in voxels, a passage's sides may be from the point
const PASSAGE_VOXELS = 1.5;

// an occupied voxel in the row of p, between from and to along one axis
// (dx, dz), whose box is within PASSAGE_VOXELS of p along that axis
const sideOccupied = (
    occupied: (ix: number, iy: number, iz: number) => boolean,
    voxel: number,
    p: Vec3Like,
    dx: number,
    dz: number
) => {
    const cx = Math.floor(p.x / voxel), cy = Math.floor(p.y / voxel), cz = Math.floor(p.z / voxel);
    const reach = PASSAGE_VOXELS * voxel * (1 + 1e-6);
    const along = dx !== 0 ? p.x : p.z;
    const c = dx !== 0 ? cx : cz;
    const dir = dx + dz;
    for (let k = 0; k <= Math.ceil(PASSAGE_VOXELS) + 1; k++) {
        const i = c + dir * k;
        if (gap(along, i * voxel, voxel) > reach) break;
        if (occupied(dx !== 0 ? i : cx, cy, dz !== 0 ? i : cz)) return true;
    }
    return false;
};

// p lies in a passage such as a door: in its voxel row there is occupied
// space within PASSAGE_VOXELS on both sides along x or on both sides along z
const inPassage = (occupied: (ix: number, iy: number, iz: number) => boolean, voxel: number, p: Vec3Like) => {
    const side = (dx: number, dz: number) => sideOccupied(occupied, voxel, p, dx, dz);
    return (side(-1, 0) && side(1, 0)) || (side(0, -1) && side(0, 1));
};

export { CAMERA_RADIUS_VOXELS, inPassage, pointClearance };
