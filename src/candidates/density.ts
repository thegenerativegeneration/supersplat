import { DENSITY_STRIDE, type DensitySplats } from './read-density';
import { packKey, unpackKey, type Occupancy, type Vec3Like } from './occupancy';

type DensityOptions = {
    // a voxel is solid when 1 - exp(-density) reaches this
    cutoff?: number,
    // extent of a splat in σ
    sigmaCutoff?: number,
    // solid 26-connected components smaller than this (in voxels) are dropped
    minCluster?: number
};

// per-voxel density at which further splats cannot change the outcome
const SATURATION = 7;

// Half extents of the axis-aligned box around the ellipsoid (σ·reach along the
// splat axes) rotated by the unit quaternion q.
const aabbHalfExtents = (
    r: number, sx: number, sy: number, sz: number, qx: number, qy: number, qz: number, qw: number,
    out: number[]
) => {
    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;
    const r00 = 1 - 2 * (yy + zz), r01 = 2 * (xy - wz), r02 = 2 * (xz + wy);
    const r10 = 2 * (xy + wz), r11 = 1 - 2 * (xx + zz), r12 = 2 * (yz - wx);
    const r20 = 2 * (xz - wy), r21 = 2 * (yz + wx), r22 = 1 - 2 * (xx + yy);
    out[0] = r * Math.sqrt((r00 * sx) ** 2 + (r01 * sy) ** 2 + (r02 * sz) ** 2);
    out[1] = r * Math.sqrt((r10 * sx) ** 2 + (r11 * sy) ** 2 + (r12 * sz) ** 2);
    out[2] = r * Math.sqrt((r20 * sx) ** 2 + (r21 * sy) ** 2 + (r22 * sz) ** 2);
    return [r00, r01, r02, r10, r11, r12, r20, r21, r22];
};

const NEIGHBOURS_26: [number, number, number][] = [];
for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
            if (x || y || z) NEIGHBOURS_26.push([x, y, z]);
        }
    }
}

const dropSmallClusters = (solid: Set<number>, minCluster: number) => {
    if (minCluster <= 1) return solid;
    const kept = new Set<number>();
    const seen = new Set<number>();
    for (const start of solid) {
        if (seen.has(start)) continue;
        seen.add(start);
        const component = [start];
        for (let head = 0; head < component.length; head++) {
            const [ix, iy, iz] = unpackKey(component[head]);
            for (const [dx, dy, dz] of NEIGHBOURS_26) {
                const key = packKey(ix + dx, iy + dy, iz + dz);
                if (solid.has(key) && !seen.has(key)) {
                    seen.add(key);
                    component.push(key);
                }
            }
        }
        if (component.length >= minCluster) component.forEach(key => kept.add(key));
    }
    return kept;
};

// Solid voxels from summed splat density, after splat-transform's voxelizer:
// every voxel overlapping a splat's extent receives opacity·exp(-d²/2), d being
// the Mahalanobis distance from the centre to the voxel's nearest point. A voxel
// is solid at 1 - exp(-sum) >= cutoff; small solid clusters (floaters) are dropped.
const buildDensityOccupancy = (splats: DensitySplats, voxel: number, opts: DensityOptions = {}): Occupancy => {
    const { cutoff = 0.1, sigmaCutoff = 3, minCluster = 8 } = opts;
    const density = new Map<number, number>();
    const half = [0, 0, 0];

    for (let i = 0; i + DENSITY_STRIDE <= splats.length; i += DENSITY_STRIDE) {
        const cx = splats[i], cy = splats[i + 1], cz = splats[i + 2];
        const sx = splats[i + 3], sy = splats[i + 4], sz = splats[i + 5];
        const opacity = splats[i + 10];
        const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = aabbHalfExtents(
            sigmaCutoff, sx, sy, sz, splats[i + 6], splats[i + 7], splats[i + 8], splats[i + 9], half
        );
        if (!(sx > 0 && sy > 0 && sz > 0 && opacity > 0)) continue;

        const x0 = Math.floor((cx - half[0]) / voxel), x1 = Math.floor((cx + half[0]) / voxel);
        const y0 = Math.floor((cy - half[1]) / voxel), y1 = Math.floor((cy + half[1]) / voxel);
        const z0 = Math.floor((cz - half[2]) / voxel), z1 = Math.floor((cz + half[2]) / voxel);

        for (let ix = x0; ix <= x1; ix++) {
            const dx = Math.min(Math.max(cx, ix * voxel), (ix + 1) * voxel) - cx;
            for (let iy = y0; iy <= y1; iy++) {
                const dy = Math.min(Math.max(cy, iy * voxel), (iy + 1) * voxel) - cy;
                for (let iz = z0; iz <= z1; iz++) {
                    const dz = Math.min(Math.max(cz, iz * voxel), (iz + 1) * voxel) - cz;
                    const key = packKey(ix, iy, iz);
                    const sum = density.get(key) ?? 0;
                    if (sum >= SATURATION) continue;
                    // splat frame: local = Rᵀ·d
                    const lx = (r00 * dx + r10 * dy + r20 * dz) / sx;
                    const ly = (r01 * dx + r11 * dy + r21 * dz) / sy;
                    const lz = (r02 * dx + r12 * dy + r22 * dz) / sz;
                    density.set(key, sum + opacity * Math.exp(-0.5 * (lx * lx + ly * ly + lz * lz)));
                }
            }
        }
    }

    const solid = new Set<number>();
    density.forEach((sum, key) => {
        if (1 - Math.exp(-sum) >= cutoff) solid.add(key);
    });
    const keys = dropSmallClusters(solid, minCluster);

    const occupied = (ix: number, iy: number, iz: number) => keys.has(packKey(ix, iy, iz));

    const isFree = (p: Vec3Like, radiusVoxels = 1) => {
        const cx = Math.floor(p.x / voxel);
        const cy = Math.floor(p.y / voxel);
        const cz = Math.floor(p.z / voxel);
        for (let x = cx - radiusVoxels; x <= cx + radiusVoxels; x++) {
            for (let y = cy - radiusVoxels; y <= cy + radiusVoxels; y++) {
                for (let z = cz - radiusVoxels; z <= cz + radiusVoxels; z++) {
                    if (occupied(x, y, z)) return false;
                }
            }
        }
        return true;
    };

    function *cells(): Iterable<[number, number, number]> {
        for (const key of keys) yield unpackKey(key);
    }

    return { voxel, occupied, isFree, cells };
};

export { buildDensityOccupancy };
export type { DensityOptions };
