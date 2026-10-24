import type { Candidate } from './sample';

type Metrics = { blur: number, dark: number };
type Scored = Candidate & { score: number, depth: number };

const TILES_X = 18;
const TILES_Y = 12;
const FLAT_TILE = 2.0;
const DARK_GREY = 12;

// Measures flat regions (mean Laplacian magnitude per tile below FLAT_TILE) and
// near-black pixels. Pixels are RGBA, rows top-down; alpha is ignored.
const imageMetrics = (rgba: Uint8Array, width: number, height: number): Metrics => {
    const grey = new Float32Array(width * height);
    let dark = 0;
    for (let i = 0; i < grey.length; i++) {
        const g = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
        grey[i] = g;
        if (g < DARK_GREY) dark++;
    }

    const iw = width - 2;
    const ih = height - 2;
    const tw = Math.floor(iw / TILES_X);
    const th = Math.floor(ih / TILES_Y);
    const sums = new Float64Array(TILES_X * TILES_Y);
    for (let ty = 0; ty < TILES_Y; ty++) {
        for (let tx = 0; tx < TILES_X; tx++) {
            let sum = 0;
            for (let y = ty * th + 1; y <= (ty + 1) * th; y++) {
                for (let x = tx * tw + 1; x <= (tx + 1) * tw; x++) {
                    const i = y * width + x;
                    sum += Math.abs(4 * grey[i] - grey[i - width] - grey[i + width] - grey[i - 1] - grey[i + 1]);
                }
            }
            sums[ty * TILES_X + tx] = sum / (tw * th);
        }
    }

    let flat = 0;
    for (const mean of sums) {
        if (mean < FLAT_TILE) flat++;
    }
    return { blur: flat / sums.length, dark: dark / grey.length };
};

// True when the view hits nothing or ends closer than 0.75 eye heights, which
// keeps views across narrow rooms.
const rejectBeforeRender = (depth: number | null, eyeHeight: number) => {
    return depth === null || depth < 0.75 * eyeHeight;
};

// how much a fully open view (openness 1) adds to the score
const PREFER_OPEN_WEIGHT = 0.3;

const candidateScore = (m: Metrics, pitch: number, openness?: number) => {
    const tilted = Math.abs(pitch) > 0 && Math.abs(pitch) < 30;
    const base = (1 - m.blur) - 2 * m.dark - (tilted ? 0.15 : 0);
    return openness === undefined ? base : base + PREFER_OPEN_WEIGHT * openness;
};

// Keeps the best-scored views, dropping one that is both within minDistance
// and within minAngleDeg of azimuth of an already kept one.
const diversify = (scored: Scored[], minDistance: number, minAngleDeg = 90): Scored[] => {
    const kept: Scored[] = [];
    for (const c of [...scored].sort((a, b) => b.score - a.score)) {
        const duplicate = kept.some((k) => {
            const d = Math.hypot(
                c.position.x - k.position.x,
                c.position.y - k.position.y,
                c.position.z - k.position.z
            );
            const diff = Math.abs(c.azimuth - k.azimuth) % 360;
            return d < minDistance && Math.min(diff, 360 - diff) < minAngleDeg;
        });
        if (!duplicate) kept.push(c);
    }
    return kept;
};

export { imageMetrics, rejectBeforeRender, candidateScore, diversify, PREFER_OPEN_WEIGHT };
export type { Metrics, Scored };
