import { EXTENT_STRIDE, type SplatExtents } from './extent';

// a splat is flat when its smallest radius is below this share of the middle one
const FLAT_RATIO = 0.3;
// a flat splat is part of a wall when its normal's |y| is below this
const MAX_NORMAL_Y = 0.2;
const MIN_FLAT_SPLATS = 50;
const PEAK_SHARE = 0.75;
const REFINE_DEG = 5;
const MIN_SUPPORT = 0.25;
const BINS = 90;

// signed difference a - b on the 90° circle, in [-45, 45)
const fold = (a: number, b: number) => ((((a - b + 45) % 90) + 90) % 90) - 45;

const weightedMedian = (items: { value: number, weight: number }[]) => {
    items.sort((a, b) => a.value - b.value);
    const half = items.reduce((s, it) => s + it.weight, 0) / 2;
    let acc = 0;
    for (const it of items) {
        acc += it.weight;
        if (acc >= half) return it.value;
    }
    return items[items.length - 1].value;
};

// The dominant wall direction of the flat, vertical opaque splats whose centres
// pass select, in degrees in [0, 90) in the azimuth convention of sample.ts
// (0 looks along -Z). After Hübner et al. 2021: normal azimuths folded mod 90°
// into 1° bins weighted by the splat's area (largest × middle radius), bins
// within PEAK_SHARE of the peak grouped into contiguous clusters (89 wraps to
// 0), the weighted mean of the heaviest cluster refined by the weighted median
// of the normals within REFINE_DEG. Null with fewer than MIN_FLAT_SPLATS such
// splats or when less than MIN_SUPPORT of their weight lies within REFINE_DEG
// of the result.
const wallAngle = (
    points: Float32Array,
    extents: SplatExtents,
    select: (x: number, y: number, z: number) => boolean
): number | null => {
    const angles: number[] = [];
    const weights: number[] = [];
    const n = Math.min(points.length / 3, extents.length / EXTENT_STRIDE);
    for (let i = 0; i < n; i++) {
        if (!select(points[i * 3], points[i * 3 + 1], points[i * 3 + 2])) continue;
        const e = i * EXTENT_STRIDE;
        const r = [extents[e], extents[e + 1], extents[e + 2]];
        const order = [0, 1, 2].sort((a, b) => r[a] - r[b]);
        const [small, middle, large] = order.map(k => r[k]);
        if (!(small < FLAT_RATIO * middle)) continue;

        // column `order[0]` of the rotation matrix is the normal in world space
        const qx = extents[e + 3], qy = extents[e + 4], qz = extents[e + 5], qw = extents[e + 6];
        let nx: number, ny: number, nz: number;
        if (order[0] === 0) {
            nx = 1 - 2 * (qy * qy + qz * qz); ny = 2 * (qx * qy + qw * qz); nz = 2 * (qx * qz - qw * qy);
        } else if (order[0] === 1) {
            nx = 2 * (qx * qy - qw * qz); ny = 1 - 2 * (qx * qx + qz * qz); nz = 2 * (qy * qz + qw * qx);
        } else {
            nx = 2 * (qx * qz + qw * qy); ny = 2 * (qy * qz - qw * qx); nz = 1 - 2 * (qx * qx + qy * qy);
        }
        const len = Math.hypot(nx, ny, nz);
        if (!(len > 0) || Math.abs(ny / len) >= MAX_NORMAL_Y) continue;

        const azimuth = Math.atan2(nx, -nz) * 180 / Math.PI;
        angles.push(((azimuth % 90) + 90) % 90);
        weights.push(large * middle);
    }
    if (angles.length < MIN_FLAT_SPLATS) return null;

    const hist = new Float64Array(BINS);
    angles.forEach((a, i) => {
        hist[Math.min(BINS - 1, Math.floor(a))] += weights[i];
    });
    const peak = Math.max(...hist);
    if (!(peak > 0)) return null;
    const kept = Array.from(hist, h => h >= PEAK_SHARE * peak);

    // a cluster starts at a kept bin whose left neighbour (wrapping) is not kept
    let best: { start: number, length: number, weight: number } | null = null;
    for (let start = 0; start < BINS; start++) {
        if (!kept[start] || kept[(start + BINS - 1) % BINS]) continue;
        let length = 0;
        let weight = 0;
        while (length < BINS && kept[(start + length) % BINS]) {
            weight += hist[(start + length) % BINS];
            length++;
        }
        if (!best || weight > best.weight) best = { start, length, weight };
    }
    // every bin kept: the histogram is flat, no dominant direction
    if (!best) return null;

    let sum = 0;
    for (let k = 0; k < best.length; k++) sum += hist[(best.start + k) % BINS] * (best.start + k + 0.5);
    const mean = sum / best.weight;

    const near = angles
    .map((a, i) => ({ value: fold(a, mean), weight: weights[i] }))
    .filter(it => Math.abs(it.value) <= REFINE_DEG);
    const result = near.length ? (((mean + weightedMedian(near)) % 90) + 90) % 90 : mean % 90;

    const total = weights.reduce((a, b) => a + b, 0);
    const support = angles.reduce((s, a, i) => s + (Math.abs(fold(a, result)) <= REFINE_DEG ? weights[i] : 0), 0);
    return support >= MIN_SUPPORT * total ? result : null;
};

export { wallAngle };
