import { createChunkDataPool } from '@playcanvas/splat-transform';
import { Mat4 } from 'playcanvas';

import { sigmoid } from '../color-grade';
import { groupInstancesByChunk } from '../gaussian-instances';
import type { Splat } from '../splat';
import { State } from '../splat-state';

const OPAQUE = 0.5;

// world matrix per transform palette entry of one layer
const transformsOf = (splat: Splat) => {
    const cache = new Map<number, Float32Array>();
    const palette = new Mat4();
    return (transformIndex: number) => {
        let m = cache.get(transformIndex);
        if (!m) {
            const mat = splat.worldTransform.clone();
            if (transformIndex > 0) {
                splat.transformPalette.getTransform(transformIndex, palette);
                mat.mul(palette);
            }
            m = mat.data;
            cache.set(transformIndex, m);
        }
        return m;
    };
};

// World-space centres of opaque (sigmoid(opacity) > 0.5), finite splats of
// visible layers, skipping hidden instances. Every stride-th unhidden instance
// is read, then the opaque ones are thinned evenly to at most maxPoints.
const readOpaquePoints = async (splats: Splat[], maxPoints = 500000): Promise<Float32Array> => {
    const layers = splats.filter(s => s.visible);
    const eligible = layers.reduce((n, s) => n + s.instances.count - s.instances.numLocked, 0);
    const stride = Math.max(1, Math.floor(eligible / (2 * maxPoints)));
    const out = new Float32Array(Math.ceil(eligible / stride) * 3);
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
                        const m = transformOf(instances.transformIndex(instance));
                        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
                        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
                        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
                        if (Number.isFinite(wx) && Number.isFinite(wy) && Number.isFinite(wz)) {
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

    const count = n / 3;
    const take = Math.min(count, maxPoints);
    const result = new Float32Array(take * 3);
    for (let i = 0; i < take; i++) {
        const j = Math.floor(i * count / take) * 3;
        result[i * 3] = out[j];
        result[i * 3 + 1] = out[j + 1];
        result[i * 3 + 2] = out[j + 2];
    }
    return result;
};

export { readOpaquePoints };
