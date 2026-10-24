import { rasterizeExtents, type SplatExtents } from './extent';

type Vec3Like = { x: number, y: number, z: number };

type Occupancy = {
    voxel: number,
    occupied(ix: number, iy: number, iz: number): boolean,
    isFree(p: Vec3Like, radiusVoxels?: number): boolean,
    cells(): Iterable<[number, number, number]>
};

// voxel indices are packed into one safe integer, 17 bits per axis
const BITS = 17;
const OFFSET = 1 << (BITS - 1);
const SPAN = 1 << BITS;

const packKey = (ix: number, iy: number, iz: number) => {
    return ((ix + OFFSET) * SPAN + (iy + OFFSET)) * SPAN + (iz + OFFSET);
};

const unpackKey = (key: number): [number, number, number] => {
    const iz = key % SPAN;
    const rest = (key - iz) / SPAN;
    const iy = rest % SPAN;
    const ix = (rest - iy) / SPAN;
    return [ix - OFFSET, iy - OFFSET, iz - OFFSET];
};

// Voxels holding at least minCount points count as occupied, so isolated
// floaters do not block free space. With extents, voxels inside a large
// splat's body are occupied too (see rasterizeExtents); extentPoints are the
// centres those extents belong to (default: points).
const buildOccupancy = (
    points: Float32Array,
    voxel: number,
    minCount = 2,
    extents?: SplatExtents,
    extentPoints: Float32Array = points
): Occupancy => {
    const counts = new Map<number, number>();
    for (let i = 0; i + 2 < points.length; i += 3) {
        const key = packKey(
            Math.floor(points[i] / voxel),
            Math.floor(points[i + 1] / voxel),
            Math.floor(points[i + 2] / voxel)
        );
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const keys = new Set<number>();
    counts.forEach((count, key) => {
        if (count >= minCount) keys.add(key);
    });
    if (extents) {
        rasterizeExtents(extentPoints, extents, voxel, (ix, iy, iz) => keys.add(packKey(ix, iy, iz)));
    }

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

export { buildOccupancy, packKey, unpackKey };
export type { Occupancy, Vec3Like };
