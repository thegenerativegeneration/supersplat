import type { Splat } from '../splat';
import { forEachSplat } from './read-points';

// per splat: centre x, y, z; σ along its own axes sx, sy, sz (world units);
// rotation qx, qy, qz, qw; opacity (0-1)
const DENSITY_STRIDE = 11;

type DensitySplats = Float32Array;

// Every unlocked splat of visible layers with opacity >= minOpacity, unthinned.
const readDensitySplats = async (splats: Splat[], minOpacity = 1 / 255): Promise<DensitySplats> => {
    let buffer = new Float32Array(1 << 20);
    let n = 0;

    await forEachSplat(splats, (s) => {
        if (!(s.opacity >= minOpacity)) return;
        if (n + DENSITY_STRIDE > buffer.length) {
            const grown = new Float32Array(buffer.length * 2);
            grown.set(buffer);
            buffer = grown;
        }
        buffer[n] = s.x;
        buffer[n + 1] = s.y;
        buffer[n + 2] = s.z;
        buffer[n + 3] = s.sx;
        buffer[n + 4] = s.sy;
        buffer[n + 5] = s.sz;
        buffer[n + 6] = s.qx;
        buffer[n + 7] = s.qy;
        buffer[n + 8] = s.qz;
        buffer[n + 9] = s.qw;
        buffer[n + 10] = s.opacity;
        n += DENSITY_STRIDE;
    });

    return buffer.slice(0, n);
};

export { DENSITY_STRIDE, readDensitySplats };
export type { DensitySplats };
