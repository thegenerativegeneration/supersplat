// Per splat: sx, sy, sz (2σ radii along the splat's own axes, world units),
// then its world rotation qx, qy, qz, qw.
type SplatExtents = Float32Array;

const EXTENT_STRIDE = 7;
// radii are capped so floaters can't fill whole rooms: MAX_RADIUS at an eye
// height of 1.6, scaled with the eye height for scenes in other units
const MAX_RADIUS = 1;

const maxRadiusAt = (eyeHeight: number) => MAX_RADIUS * eyeHeight / 1.6;

// Calls mark(ix, iy, iz) for every voxel whose centre lies inside splat i's
// 2σ ellipsoid, with radii floored at half a voxel (so a thin surface marks
// the voxel layer it passes through) and capped at maxRadius. Splats with
// all radii below half a voxel mark nothing.
const rasterizeExtents = (
    points: Float32Array,
    extents: SplatExtents,
    voxel: number,
    maxRadius: number,
    mark: (ix: number, iy: number, iz: number) => void
) => {
    const half = voxel / 2;
    const n = Math.min(points.length / 3, extents.length / EXTENT_STRIDE);
    for (let i = 0; i < n; i++) {
        const e = i * EXTENT_STRIDE;
        const sx = extents[e], sy = extents[e + 1], sz = extents[e + 2];
        if (!(Math.max(sx, sy, sz) >= half)) continue;
        const rx = Math.min(Math.max(sx, half), maxRadius);
        const ry = Math.min(Math.max(sy, half), maxRadius);
        const rz = Math.min(Math.max(sz, half), maxRadius);

        // rotation matrix columns are the splat's axes in world space
        const qx = extents[e + 3], qy = extents[e + 4], qz = extents[e + 5], qw = extents[e + 6];
        const xx = qx * qx, yy = qy * qy, zz = qz * qz;
        const xy = qx * qy, xz = qx * qz, yz = qy * qz;
        const wx = qw * qx, wy = qw * qy, wz = qw * qz;
        const m00 = 1 - 2 * (yy + zz), m01 = 2 * (xy - wz), m02 = 2 * (xz + wy);
        const m10 = 2 * (xy + wz), m11 = 1 - 2 * (xx + zz), m12 = 2 * (yz - wx);
        const m20 = 2 * (xz - wy), m21 = 2 * (yz + wx), m22 = 1 - 2 * (xx + yy);

        // axis-aligned half extents of the ellipsoid
        const hx = Math.hypot(m00 * rx, m01 * ry, m02 * rz);
        const hy = Math.hypot(m10 * rx, m11 * ry, m12 * rz);
        const hz = Math.hypot(m20 * rx, m21 * ry, m22 * rz);

        const px = points[i * 3], py = points[i * 3 + 1], pz = points[i * 3 + 2];
        const x0 = Math.ceil((px - hx) / voxel - 0.5), x1 = Math.floor((px + hx) / voxel - 0.5);
        const y0 = Math.ceil((py - hy) / voxel - 0.5), y1 = Math.floor((py + hy) / voxel - 0.5);
        const z0 = Math.ceil((pz - hz) / voxel - 0.5), z1 = Math.floor((pz + hz) / voxel - 0.5);
        for (let ix = x0; ix <= x1; ix++) {
            const dx = (ix + 0.5) * voxel - px;
            for (let iy = y0; iy <= y1; iy++) {
                const dy = (iy + 0.5) * voxel - py;
                for (let iz = z0; iz <= z1; iz++) {
                    const dz = (iz + 0.5) * voxel - pz;
                    // R^T d in the splat's frame, scaled to the unit sphere
                    const u = (m00 * dx + m10 * dy + m20 * dz) / rx;
                    const v = (m01 * dx + m11 * dy + m21 * dz) / ry;
                    const w = (m02 * dx + m12 * dy + m22 * dz) / rz;
                    if (u * u + v * v + w * w <= 1 + 1e-9) mark(ix, iy, iz);
                }
            }
        }
    }
};

export { EXTENT_STRIDE, MAX_RADIUS, maxRadiusAt, rasterizeExtents };
export type { SplatExtents };
