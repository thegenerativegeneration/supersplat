import { createChunkDataPool } from '@playcanvas/splat-transform';
import { Mat4, Quat } from 'playcanvas';

import { sigmoid } from '../color-grade';
import { groupInstancesByChunk } from '../gaussian-instances';
import type { Splat } from '../splat';
import { State } from '../splat-state';
import { EXTENT_STRIDE, type SplatExtents } from './extent';

const OPAQUE = 0.5;

type WorldTransform = { m: Float32Array, rotation: Quat, scale: number };

type OpaquePoints = { points: Float32Array, extents: SplatExtents };

// world matrix, rotation and scale per transform palette entry of one layer;
// the scale is taken as uniform (the length of the first axis)
const transformsOf = (splat: Splat) => {
    const cache = new Map<number, WorldTransform>();
    const palette = new Mat4();
    return (transformIndex: number) => {
        let t = cache.get(transformIndex);
        if (!t) {
            const mat = splat.worldTransform.clone();
            if (transformIndex > 0) {
                splat.transformPalette.getTransform(transformIndex, palette);
                mat.mul(palette);
            }
            const m = mat.data;
            t = { m, rotation: new Quat().setFromMat4(mat), scale: Math.hypot(m[0], m[1], m[2]) };
            cache.set(transformIndex, t);
        }
        return t;
    };
};

// One splat in world space: centre, σ along its own axes (scale · exp(logScale)),
// rotation quaternion and opacity (sigmoid, 0-1). The object is reused between visits.
type SplatRow = {
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    qx: number, qy: number, qz: number, qw: number,
    opacity: number
};

// Calls visit for every finite, unlocked splat of the given layers, in world space.
const forEachSplat = async (splats: Splat[], visit: (s: SplatRow) => void) => {
    const local = new Quat();
    const rot = new Quat();
    const row: SplatRow = { x: 0, y: 0, z: 0, sx: 0, sy: 0, sz: 0, qx: 0, qy: 0, qz: 0, qw: 1, opacity: 0 };

    for (const splat of splats) {
        if (!splat.visible) continue;
        const { source } = splat.resource;
        const { chunkSize, numChunks, numGaussians, layouts } = source.meta;
        const { instances } = splat;
        const transformOf = transformsOf(splat);
        const { starts, ordered } = groupInstancesByChunk(instances, chunkSize, numChunks[0]);
        const pool = createChunkDataPool({ chunkSize });
        try {
            for (let chunkIndex = 0; chunkIndex < numChunks[0]; ++chunkIndex) {
                if (starts[chunkIndex] === starts[chunkIndex + 1]) continue;
                const count = Math.min(chunkSize, numGaussians - chunkIndex * chunkSize);
                const position = pool.acquire('position', layouts.position, count);
                const geometric = pool.acquire('geometric', layouts.geometric, count);
                try {
                    await source.read({ chunkIndex, position, geometric });
                    const pos = new Float32Array(position.data);
                    const geo = new Float32Array(geometric.data);
                    const base = chunkIndex * chunkSize;
                    for (let slot = starts[chunkIndex]; slot < starts[chunkIndex + 1]; ++slot) {
                        const instance = ordered[slot];
                        if (instances.flags[instance] & State.locked) continue;
                        const r = instances.sourceRow[instance] - base;
                        const x = pos[r * 3], y = pos[r * 3 + 1], z = pos[r * 3 + 2];
                        const { m, rotation, scale } = transformOf(instances.transformIndex(instance));
                        row.x = m[0] * x + m[4] * y + m[8] * z + m[12];
                        row.y = m[1] * x + m[5] * y + m[9] * z + m[13];
                        row.z = m[2] * x + m[6] * y + m[10] * z + m[14];
                        if (!Number.isFinite(row.x) || !Number.isFinite(row.y) || !Number.isFinite(row.z)) continue;
                        // geometric rows hold rotation w, x, y, z, log scales, then the opacity logit
                        const g = r * 8;
                        local.set(geo[g + 1], geo[g + 2], geo[g + 3], geo[g]).normalize();
                        rot.mul2(rotation, local);
                        row.sx = scale * Math.exp(geo[g + 4]);
                        row.sy = scale * Math.exp(geo[g + 5]);
                        row.sz = scale * Math.exp(geo[g + 6]);
                        row.qx = rot.x;
                        row.qy = rot.y;
                        row.qz = rot.z;
                        row.qw = rot.w;
                        row.opacity = sigmoid(geo[g + 7]);
                        visit(row);
                    }
                } finally {
                    position.release();
                    geometric.release();
                }
            }
        } finally {
            pool.destroy();
        }
    }
};

// World-space centres and extents (2σ radii and rotation, see SplatExtents)
// of opaque (sigmoid(opacity) > 0.5), finite splats of visible layers,
// skipping hidden instances. Every stride-th unhidden instance is read, then
// the opaque ones are thinned evenly to at most maxPoints.
const readOpaquePoints = async (splats: Splat[], maxPoints = 500000): Promise<OpaquePoints> => {
    const layers = splats.filter(s => s.visible);
    const eligible = layers.reduce((n, s) => n + s.instances.count - s.instances.numLocked, 0);
    const stride = Math.max(1, Math.floor(eligible / (2 * maxPoints)));
    const out = new Float32Array(Math.ceil(eligible / stride) * 3);
    const outExtents = new Float32Array(Math.ceil(eligible / stride) * EXTENT_STRIDE);
    let n = 0;
    let k = 0;

    await forEachSplat(layers, (s) => {
        if (k++ % stride !== 0) return;
        if (!(s.opacity > OPAQUE)) return;
        const e = (n / 3) * EXTENT_STRIDE;
        outExtents[e] = 2 * s.sx;
        outExtents[e + 1] = 2 * s.sy;
        outExtents[e + 2] = 2 * s.sz;
        outExtents[e + 3] = s.qx;
        outExtents[e + 4] = s.qy;
        outExtents[e + 5] = s.qz;
        outExtents[e + 6] = s.qw;
        out[n++] = s.x;
        out[n++] = s.y;
        out[n++] = s.z;
    });

    const count = n / 3;
    const take = Math.min(count, maxPoints);
    const points = new Float32Array(take * 3);
    const extents = new Float32Array(take * EXTENT_STRIDE);
    for (let i = 0; i < take; i++) {
        const j = Math.floor(i * count / take);
        points.set(out.subarray(j * 3, j * 3 + 3), i * 3);
        extents.set(outExtents.subarray(j * EXTENT_STRIDE, (j + 1) * EXTENT_STRIDE), i * EXTENT_STRIDE);
    }
    return { points, extents };
};

export { forEachSplat, readOpaquePoints };
export type { OpaquePoints, SplatRow };
