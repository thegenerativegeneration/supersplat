import type { Occupancy } from '../candidates/occupancy';

// lattice bounds of the box: first index and count per axis
type Bounds = { x0: number, y0: number, z0: number, nx: number, ny: number, nz: number };

// index of the first value >= lo
const lowerBound = (arr: Int32Array, lo: number) => {
    let a = 0, b = arr.length;
    while (a < b) {
        const m = (a + b) >> 1;
        if (arr[m] < lo) a = m + 1;
        else b = m;
    }
    return a;
};

const addTo = (map: Map<number, Set<number>>, key: number, values: Iterable<number>) => {
    let set = map.get(key);
    if (!set) map.set(key, set = new Set());
    for (const v of values) set.add(v);
};

const sorted = (map: Map<number, Set<number>>) => {
    const out = new Map<number, Int32Array>();
    map.forEach((set, key) => out.set(key, Int32Array.from(set).sort()));
    return out;
};

// Sorts flat [lo, hi, lo, hi, ...] row intervals and merges overlapping ones.
const mergeIntervals = (flat: number[]) => {
    const pairs: [number, number][] = [];
    for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
    pairs.sort((p, q) => p[0] - q[0]);
    const out: number[] = [];
    for (const [lo, hi] of pairs) {
        if (out.length && lo <= out[out.length - 1] + 1) out[out.length - 1] = Math.max(out[out.length - 1], hi);
        else out.push(lo, hi);
    }
    return out;
};

const inIntervals = (intervals: number[] | undefined, iy: number) => {
    if (!intervals) return false;
    for (let i = 0; i < intervals.length; i += 2) {
        if (iy >= intervals[i] && iy <= intervals[i + 1]) return true;
    }
    return false;
};

const pushTo = (map: Map<number, number[]>, key: number, values: number[]) => {
    const list = map.get(key);
    if (list) list.push(...values);
    else map.set(key, values.slice());
};

// Sorted occupied rows per box column (key lx + nx lz).
const occupiedRows = (occ: Occupancy, b: Bounds) => {
    const rows = new Map<number, Set<number>>();
    for (const [ix, iy, iz] of occ.cells()) {
        const lx = ix - b.x0, lz = iz - b.z0;
        if (lx >= 0 && lx < b.nx && lz >= 0 && lz < b.nz) addTo(rows, lx + b.nx * lz, [iy]);
    }
    return sorted(rows);
};

// Per box column (key lx + nx lz): the rows within radius voxels (per axis)
// of an occupied voxel, as merged intervals dilated along y, then x, then z.
const nearIntervals = (occ: Occupancy, b: Bounds, radius: number) => {
    const wide = b.nx + 2 * radius;
    const raw = new Map<number, number[]>();
    for (const [ix, iy, iz] of occ.cells()) {
        const lx = ix - b.x0 + radius, lz = iz - b.z0 + radius;
        if (lx >= 0 && lx < wide && lz >= 0 && lz < b.nz + 2 * radius) pushTo(raw, lx + wide * lz, [iy]);
    }

    const alongX = new Map<number, number[]>();
    raw.forEach((rows, key) => {
        const lz = Math.floor(key / wide), lx = key - lz * wide - radius;
        const intervals = mergeIntervals(rows.flatMap(r => [r - radius, r + radius]));
        for (let x = Math.max(0, lx - radius); x <= Math.min(b.nx - 1, lx + radius); x++) {
            pushTo(alongX, x + b.nx * lz, intervals);
        }
    });

    const near = new Map<number, number[]>();
    alongX.forEach((flat, key) => {
        const lz = Math.floor(key / b.nx) - radius, lx = key % b.nx;
        const intervals = mergeIntervals(flat);
        for (let z = Math.max(0, lz - radius); z <= Math.min(b.nz - 1, lz + radius); z++) {
            pushTo(near, lx + b.nx * z, intervals);
        }
    });
    near.forEach((flat, key) => near.set(key, mergeIntervals(flat)));
    return near;
};

export { addTo, inIntervals, lowerBound, nearIntervals, occupiedRows, sorted };
export type { Bounds };
