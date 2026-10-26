import { createChunkDataPool } from '@playcanvas/splat-transform';
import { Mat4, Quat } from 'playcanvas';

import { sigmoid } from '../color-grade';
import type { ProgressFn } from '../compute/protocol';
import { groupInstancesByChunk } from '../gaussian-instances';
import type { Splat } from '../splat';
import { State } from '../splat-state';
import { EXTENT_STRIDE, type SplatExtents } from './extent';

const OPAQUE = 0.5;

// longest stretch of reading between two yields to the browser
const YIELD_MS = 16;

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

// World-space centres and extents (2σ radii and rotation, see SplatExtents)
// of opaque (sigmoid(opacity) > 0.5), finite splats of visible layers,
// skipping hidden instances. Every stride-th unhidden instance is read, then
// the opaque ones are thinned evenly to at most maxPoints. Yields to the
// browser every YIELD_MS and reports the chunks read then, at the start and
// at the end.
const readOpaquePoints = async (splats: Splat[], maxPoints = 500000, onProgress?: ProgressFn): Promise<OpaquePoints> => {
    const layers = splats.filter(s => s.visible);
    const chunks = layers.reduce((n, s) => n + s.resource.source.meta.numChunks[0], 0);
    let chunksRead = 0;
    let yieldedAt = performance.now();
    onProgress?.('reading', 0, chunks);
    const eligible = layers.reduce((n, s) => n + s.instances.count - s.instances.numLocked, 0);
    const stride = Math.max(1, Math.floor(eligible / (2 * maxPoints)));
    const out = new Float32Array(Math.ceil(eligible / stride) * 3);
    const outExtents = new Float32Array(Math.ceil(eligible / stride) * EXTENT_STRIDE);
    const local = new Quat();
    const rot = new Quat();
    let n = 0;
    let k = 0;

    for (const splat of layers) {
        const { source } = splat.resource;
        const { chunkSize, numChunks, numGaussians, layouts } = source.meta;
        const { instances } = splat;
        const transformOf = transformsOf(splat);
        const { starts, ordered } = groupInstancesByChunk(instances, chunkSize, numChunks[0]);
        const pool = createChunkDataPool({ chunkSize });
        try {
            for (let chunkIndex = 0; chunkIndex < numChunks[0]; ++chunkIndex, ++chunksRead) {
                if (performance.now() - yieldedAt >= YIELD_MS) {
                    onProgress?.('reading', chunksRead, chunks);
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, 0);
                    });
                    yieldedAt = performance.now();
                }
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
                        if (k++ % stride !== 0) continue;
                        const row = instances.sourceRow[instance] - base;
                        if (!(sigmoid(geo[row * 8 + 7]) > OPAQUE)) continue;
                        const x = pos[row * 3], y = pos[row * 3 + 1], z = pos[row * 3 + 2];
                        const { m, rotation, scale } = transformOf(instances.transformIndex(instance));
                        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
                        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
                        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
                        if (Number.isFinite(wx) && Number.isFinite(wy) && Number.isFinite(wz)) {
                            // geometric rows hold rotation w, x, y, z then log scales
                            const g = row * 8;
                            local.set(geo[g + 1], geo[g + 2], geo[g + 3], geo[g]).normalize();
                            rot.mul2(rotation, local);
                            const e = (n / 3) * EXTENT_STRIDE;
                            outExtents[e] = 2 * scale * Math.exp(geo[g + 4]);
                            outExtents[e + 1] = 2 * scale * Math.exp(geo[g + 5]);
                            outExtents[e + 2] = 2 * scale * Math.exp(geo[g + 6]);
                            outExtents[e + 3] = rot.x;
                            outExtents[e + 4] = rot.y;
                            outExtents[e + 5] = rot.z;
                            outExtents[e + 6] = rot.w;
                            out[n++] = wx;
                            out[n++] = wy;
                            out[n++] = wz;
                        }
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

    onProgress?.('reading', chunks, chunks);

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

export { readOpaquePoints };
export type { OpaquePoints };
