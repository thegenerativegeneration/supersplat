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

// slots between two looks at the clock inside a read
const CHECK_EVERY = 1024;

// source rows per gather read; one read is not interrupted
const SLICE_ROWS = 65536;

// longest wait for a painted frame before reading
const PAINT_WAIT_MS = 50;

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
// before the first read; a plain task where nothing paints, and at the latest
// after PAINT_WAIT_MS, as a hidden tab paints no frames
const afterPaint = () => new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(resolve, 0));
        setTimeout(resolve, PAINT_WAIT_MS);
    } else {
        setTimeout(resolve, 0);
    }
});

type Pace = { due(): boolean, pause(done: number): Promise<void> };

// Pauses for the browser once YIELD_MS passed since the last pause, reporting
// the instances read so far out of total. due() is cheap enough to call every
// CHECK_EVERY slots.
const pacer = (total: number, onProgress?: ProgressFn): Pace => {
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

// the output of a read: centres and extents in reading order, n floats of out used
type Collected = { out: Float32Array, outExtents: Float32Array, n: number, k: number };

// Reads one layer into c: every stride-th unhidden instance in chunk order,
// SLICE_ROWS source rows per gather read, keeping the opaque, finite ones.
const readLayer = async (splat: Splat, stride: number, c: Collected, pace: Pace) => {
    const { source } = splat.resource;
    const { chunkSize, numChunks, layouts } = source.meta;
    const { instances } = splat;
    const transformOf = transformsOf(splat);
    const { ordered } = groupInstancesByChunk(instances, chunkSize, numChunks[0]);
    const sliceRows = Math.min(SLICE_ROWS, Math.max(1, ordered.length));
    const pool = createChunkDataPool({ chunkSize: sliceRows });
    const picked = new Uint32Array(sliceRows);
    const indices = new Uint32Array(sliceRows);
    const local = new Quat();
    const rot = new Quat();
    try {
        let slot = 0;
        while (slot < ordered.length) {
            let count = 0;
            for (; slot < ordered.length && count < sliceRows; ++slot) {
                if (slot % CHECK_EVERY === 0 && pace.due()) await pace.pause(c.k);
                const instance = ordered[slot];
                if (instances.flags[instance] & State.locked) continue;
                if (c.k++ % stride !== 0) continue;
                picked[count] = instance;
                indices[count++] = instances.sourceRow[instance];
            }
            if (count === 0) continue;
            if (pace.due()) await pace.pause(c.k);
            const position = pool.acquire('position', layouts.position, count);
            const geometric = pool.acquire('geometric', layouts.geometric, count);
            try {
                await source.read({ indices, indexOffset: 0, count, position, geometric });
                const pos = new Float32Array(position.data);
                const geo = new Float32Array(geometric.data);
                for (let row = 0; row < count; ++row) {
                    if (row % CHECK_EVERY === 0 && pace.due()) await pace.pause(c.k);
                    if (!(sigmoid(geo[row * 8 + 7]) > OPAQUE)) continue;
                    const x = pos[row * 3], y = pos[row * 3 + 1], z = pos[row * 3 + 2];
                    const { m, rotation, scale } = transformOf(instances.transformIndex(picked[row]));
                    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
                    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
                    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
                    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) continue;
                    // geometric rows hold rotation w, x, y, z then log scales
                    const g = row * 8;
                    local.set(geo[g + 1], geo[g + 2], geo[g + 3], geo[g]).normalize();
                    rot.mul2(rotation, local);
                    const e = (c.n / 3) * EXTENT_STRIDE;
                    c.outExtents[e] = 2 * scale * Math.exp(geo[g + 4]);
                    c.outExtents[e + 1] = 2 * scale * Math.exp(geo[g + 5]);
                    c.outExtents[e + 2] = 2 * scale * Math.exp(geo[g + 6]);
                    c.outExtents[e + 3] = rot.x;
                    c.outExtents[e + 4] = rot.y;
                    c.outExtents[e + 5] = rot.z;
                    c.outExtents[e + 6] = rot.w;
                    c.out[c.n++] = wx;
                    c.out[c.n++] = wy;
                    c.out[c.n++] = wz;
                }
            } finally {
                position.release();
                geometric.release();
            }
        }
    } finally {
        pool.destroy();
    }
};

// World-space centres and extents (2σ radii and rotation, see SplatExtents)
// of opaque (sigmoid(opacity) > 0.5), finite splats of visible layers,
// skipping hidden instances. Every stride-th unhidden instance is read, then
// the opaque ones are thinned evenly to at most maxPoints. Yields to the
// browser first and then every YIELD_MS, between and inside reads, and
// reports the unhidden instances read then, at the start and at the end.
const readOpaquePoints = async (splats: Splat[], maxPoints = 500000, onProgress?: ProgressFn): Promise<OpaquePoints> => {
    const layers = splats.filter(s => s.visible);
    const eligible = layers.reduce((n, s) => n + s.instances.count - s.instances.numLocked, 0);
    onProgress?.('reading', 0, eligible);
    await afterPaint();
    const pace = pacer(eligible, onProgress);
    const stride = Math.max(1, Math.floor(eligible / (2 * maxPoints)));
    const c: Collected = {
        out: new Float32Array(Math.ceil(eligible / stride) * 3),
        outExtents: new Float32Array(Math.ceil(eligible / stride) * EXTENT_STRIDE),
        n: 0,
        k: 0
    };
    for (const splat of layers) await readLayer(splat, stride, c, pace);

    onProgress?.('reading', eligible, eligible);

    const { out, outExtents, n } = c;
    const count = n / 3;
    const take = Math.min(count, maxPoints);
    if (take === count) return { points: out.slice(0, n), extents: outExtents.slice(0, count * EXTENT_STRIDE) };
    const points = new Float32Array(take * 3);
    const extents = new Float32Array(take * EXTENT_STRIDE);
    for (let i = 0; i < take; i++) {
        if (i % CHECK_EVERY === 0 && pace.due()) await pace.pause(eligible);
        const j = Math.floor(i * count / take);
        for (let e = 0; e < 3; e++) points[i * 3 + e] = out[j * 3 + e];
        for (let e = 0; e < EXTENT_STRIDE; e++) extents[i * EXTENT_STRIDE + e] = outExtents[j * EXTENT_STRIDE + e];
    }
    return { points, extents };
};

export { readOpaquePoints };
export type { OpaquePoints };
