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
const YIELD_MS = 8;

// slots between two looks at the clock inside a chunk
const CHECK_EVERY = 1024;

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

// resolves once the browser painted a frame, so a caller's "reading" shows
// before the first chunk; a plain task where nothing paints
const afterPaint = () => new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
        setTimeout(resolve, 0);
    }
});

// Pauses for the browser once YIELD_MS passed since the last pause, reporting
// the instances read so far out of total. due() is cheap enough to call every
// CHECK_EVERY slots.
const pacer = (total: number, onProgress?: ProgressFn) => {
    let since = performance.now();
    return {
        due: () => performance.now() - since >= YIELD_MS,
        pause: async (done: number) => {
            onProgress?.('reading', done, total);
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
            since = performance.now();
        }
    };
};

// World-space centres and extents (2σ radii and rotation, see SplatExtents)
// of opaque (sigmoid(opacity) > 0.5), finite splats of visible layers,
// skipping hidden instances. Every stride-th unhidden instance is read, then
// the opaque ones are thinned evenly to at most maxPoints. Yields to the
// browser first and then every YIELD_MS, also inside a chunk, and reports
// the unhidden instances read then, at the start and at the end.
const readOpaquePoints = async (splats: Splat[], maxPoints = 500000, onProgress?: ProgressFn): Promise<OpaquePoints> => {
    const layers = splats.filter(s => s.visible);
    const eligible = layers.reduce((n, s) => n + s.instances.count - s.instances.numLocked, 0);
    onProgress?.('reading', 0, eligible);
    await afterPaint();
    const pace = pacer(eligible, onProgress);
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
            for (let chunkIndex = 0; chunkIndex < numChunks[0]; ++chunkIndex) {
                if (pace.due()) await pace.pause(k);
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
                        if (slot % CHECK_EVERY === 0 && pace.due()) await pace.pause(k);
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

    onProgress?.('reading', eligible, eligible);

    const count = n / 3;
    const take = Math.min(count, maxPoints);
    if (take === count) return { points: out.slice(0, n), extents: outExtents.slice(0, count * EXTENT_STRIDE) };
    const points = new Float32Array(take * 3);
    const extents = new Float32Array(take * EXTENT_STRIDE);
    for (let i = 0; i < take; i++) {
        if (i % CHECK_EVERY === 0 && pace.due()) await pace.pause(eligible);
        const j = Math.floor(i * count / take);
        for (let c = 0; c < 3; c++) points[i * 3 + c] = out[j * 3 + c];
        for (let c = 0; c < EXTENT_STRIDE; c++) extents[i * EXTENT_STRIDE + c] = outExtents[j * EXTENT_STRIDE + c];
    }
    return { points, extents };
};

export { readOpaquePoints };
export type { OpaquePoints };
