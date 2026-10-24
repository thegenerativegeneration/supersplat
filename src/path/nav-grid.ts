import { CellStore } from './cell-store';
import type { Box } from '../candidates/estimate';
import type { Level } from '../candidates/levels';
import type { Occupancy, Vec3Like } from '../candidates/occupancy';

// box-local packed lattice index (ix, iy, iz), see buildNavGrid
type Cell = number;

type Neighbour = { cell: Cell, cost: number };

// Lattice node (ix, iy, iz) sits at ((ix + 0.5) v, iy v, (iz + 0.5) v), so
// walk cells match Suggest Views camera heights, and owns the voxel row iy
// above it. Costs are in voxels.
type NavGrid = {
    voxel: number,
    cellOf(p: Vec3Like): Cell | null,
    nearestFree(p: Vec3Like, maxVoxels: number): Cell | null,
    centre(c: Cell): Vec3Like,
    neighbours(c: Cell): Neighbour[],
    lineFree(a: Vec3Like, b: Vec3Like): boolean
};

type Bounds = { x0: number, y0: number, z0: number, nx: number, ny: number, nz: number };

// fly cells must lie within this many voxels (per axis) of an occupied voxel
const NEAR_VOXELS = 8;
const FLY_PENALTY = 0.5;
const MAX_PENALTY_VOXELS = 10;
// lifts points on a voxel boundary into the row above, as a fraction of a voxel
const LIFT = 1e-4;
// lineFree sampling step, as a fraction of a voxel
const LINE_STEP = 0.25;
// store margin so occupancy lookups one voxel outside the box stay in range
const MARGIN = 2;

// per-cell store layout: occupancy (2 bits), free (2 bits), fly factor code
// (4 bits: 1 = not a graph cell, 2 + k = k voxels above walking), walk flag
const OCC_EMPTY = 1, OCC_FULL = 2;
const FREE_YES = 1 << 2, FREE_NO = 2 << 2, FREE_MASK = 3 << 2;
const FACTOR_SHIFT = 4, FACTOR_MASK = 15 << FACTOR_SHIFT;
const WALK = 1 << 8;

const BLOCKED = 0;

type Step = { dx: number, dy: number, dz: number, length: number, block: number };

const stepIndex = (dx: number, dy: number, dz: number) => (dx + 1) + 3 * (dy + 1) + 9 * (dz + 1);

// The 26 unit steps by stepIndex (the centre is empty). block has the
// freeMask bits of every node of the step's 2x2x2 block except the start:
// all must be free so the straight segment stays clear of occupied voxels.
const STEPS: Step[] = [];
for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            let block = 0;
            for (let sz = 0; sz <= Math.abs(dz); sz++) {
                for (let sy = 0; sy <= Math.abs(dy); sy++) {
                    for (let sx = 0; sx <= Math.abs(dx); sx++) {
                        if (sx + sy + sz > 0) block |= 1 << stepIndex(sx * dx, sy * dy, sz * dz);
                    }
                }
            }
            STEPS[stepIndex(dx, dy, dz)] = { dx, dy, dz, length: Math.sqrt(dx * dx + dy * dy + dz * dz), block };
        }
    }
}

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

// Integer lattice bounds whose node centres lie inside the box.
const latticeBounds = (box: Box, v: number): Bounds => {
    const range = (lo: number, hi: number, offset: number) => {
        let a = Math.ceil(lo / v - offset);
        let b = Math.floor(hi / v - offset);
        while ((a + offset) * v < lo) a++;
        while ((b + offset) * v > hi) b--;
        return [a, b];
    };
    const [x0, x1] = range(box.min.x, box.max.x, 0.5);
    const [y0, y1] = range(box.min.y, box.max.y, 0);
    const [z0, z1] = range(box.min.z, box.max.z, 0.5);
    return { x0, y0, z0, nx: Math.max(0, x1 - x0 + 1), ny: Math.max(0, y1 - y0 + 1), nz: Math.max(0, z1 - z0 + 1) };
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

const pushTo = (map: Map<number, number[]>, key: number, values: number[]) => {
    const list = map.get(key);
    if (list) list.push(...values);
    else map.set(key, values.slice());
};

// Per box column (key lx + nx lz): the rows within NEAR_VOXELS of an
// occupied voxel as merged intervals (dilated along y, then x, then z), and
// the lowest occupied row of the column itself.
const nearColumns = (occ: Occupancy, b: Bounds) => {
    const wide = b.nx + 2 * NEAR_VOXELS;
    const raw = new Map<number, number[]>();
    for (const [ix, iy, iz] of occ.cells()) {
        const lx = ix - b.x0 + NEAR_VOXELS, lz = iz - b.z0 + NEAR_VOXELS;
        if (lx >= 0 && lx < wide && lz >= 0 && lz < b.nz + 2 * NEAR_VOXELS) pushTo(raw, lx + wide * lz, [iy]);
    }

    const ground = new Map<number, number>();
    const alongX = new Map<number, number[]>();
    raw.forEach((rows, key) => {
        const lz = Math.floor(key / wide), lx = key - lz * wide - NEAR_VOXELS;
        if (lx >= 0 && lx < b.nx && lz >= NEAR_VOXELS && lz < b.nz + NEAR_VOXELS) {
            ground.set(lx + b.nx * (lz - NEAR_VOXELS), rows.reduce((m, r) => Math.min(m, r), Infinity));
        }
        const intervals = mergeIntervals(rows.flatMap(r => [r - NEAR_VOXELS, r + NEAR_VOXELS]));
        for (let x = Math.max(0, lx - NEAR_VOXELS); x <= Math.min(b.nx - 1, lx + NEAR_VOXELS); x++) {
            pushTo(alongX, x + b.nx * lz, intervals);
        }
    });

    const near = new Map<number, number[]>();
    alongX.forEach((flat, key) => {
        const lz = Math.floor(key / b.nx) - NEAR_VOXELS, lx = key % b.nx;
        const intervals = mergeIntervals(flat);
        for (let z = Math.max(0, lz - NEAR_VOXELS); z <= Math.min(b.nz - 1, lz + NEAR_VOXELS); z++) {
            pushTo(near, lx + b.nx * z, intervals);
        }
    });
    near.forEach((flat, key) => near.set(key, mergeIntervals(flat)));
    return { near, ground };
};

// Walk cells: free nodes eye height above level surface voxels, connected
// horizontally (8 neighbours, |dy| <= 1, diagonals only between walk
// orthogonals). Fly cells (allowFlying): free nodes in the box within
// NEAR_VOXELS of an occupied voxel, 26 neighbours, cost per step scaled by
// height above walking. Every step also needs its 2x2x2 block free (see
// STEPS). Cells are classified lazily, so memory grows with the cells a
// search touches.
const buildNavGrid = (occ: Occupancy, levels: Level[], box: Box, eyeHeight: number, allowFlying: boolean): NavGrid => {
    const v = occ.voxel;
    const eyeVoxels = Math.round(eyeHeight / v);
    const bounds = latticeBounds(box, v);
    const { x0, y0, z0, nx, ny, nz } = bounds;
    const plane = nx * nz;
    const store = new CellStore(nx + 2 * MARGIN, nz + 2 * MARGIN);
    const get = (ix: number, iy: number, iz: number) => store.get(ix - x0 + MARGIN, iy - y0 + MARGIN, iz - z0 + MARGIN);
    const set = (ix: number, iy: number, iz: number, s: number) => store.set(ix - x0 + MARGIN, iy - y0 + MARGIN, iz - z0 + MARGIN, s);

    const inBox = (ix: number, iy: number, iz: number) => {
        return ix >= x0 && ix < x0 + nx && iy >= y0 && iy < y0 + ny && iz >= z0 && iz < z0 + nz;
    };
    const pack = (ix: number, iy: number, iz: number) => (ix - x0) + nx * (iz - z0) + plane * (iy - y0);
    const column = (ix: number, iz: number) => (ix - x0) + nx * (iz - z0);
    const unpack = (c: Cell): [number, number, number] => {
        const iy = Math.floor(c / plane);
        const rest = c - iy * plane;
        const iz = Math.floor(rest / nx);
        return [rest - iz * nx + x0, iy + y0, iz + z0];
    };

    const centre = (c: Cell): Vec3Like => {
        const [ix, iy, iz] = unpack(c);
        return { x: (ix + 0.5) * v, y: iy * v, z: (iz + 0.5) * v };
    };

    // occ.occupied, cached; valid within one voxel of the box
    const occupied = (ix: number, iy: number, iz: number) => {
        const s = get(ix, iy, iz);
        if (s & 3) return (s & 3) === OCC_FULL;
        const full = occ.occupied(ix, iy, iz);
        set(ix, iy, iz, s | (full ? OCC_FULL : OCC_EMPTY));
        return full;
    };

    // same as occ.isFree(centre) for the voxel row the node owns; callers check inBox
    const free = (ix: number, iy: number, iz: number) => {
        const s = get(ix, iy, iz);
        if (s & FREE_MASK) return (s & FREE_MASK) === FREE_YES;
        let ok = true;
        for (let x = ix - 1; ok && x <= ix + 1; x++) {
            for (let y = iy - 1; ok && y <= iy + 1; y++) {
                for (let z = iz - 1; ok && z <= iz + 1; z++) ok = !occupied(x, y, z);
            }
        }
        set(ix, iy, iz, get(ix, iy, iz) | (ok ? FREE_YES : FREE_NO));
        return ok;
    };

    const walkSets = new Map<number, Set<number>>();
    for (const level of levels) {
        for (const [ix, iy, iz] of level.cells) {
            const cy = iy + 1 + eyeVoxels;
            if (inBox(ix, cy, iz) && free(ix, cy, iz)) {
                set(ix, cy, iz, get(ix, cy, iz) | WALK | (2 << FACTOR_SHIFT));
                addTo(walkSets, column(ix, iz), [cy]);
            }
        }
    }
    const walkRows = sorted(walkSets);
    const columns = allowFlying ? nearColumns(occ, bounds) : null;

    const nearGeometry = (ix: number, iy: number, iz: number) => {
        const intervals = columns.near.get(column(ix, iz));
        if (!intervals) return false;
        for (let i = 0; i < intervals.length; i += 2) {
            if (iy >= intervals[i] && iy <= intervals[i + 1]) return true;
        }
        return false;
    };

    // Voxels above walking height: from the nearest walk cell at or below in
    // the same column, else from eye height above the lowest occupied voxel
    // in the column (or in its dilated column when the column is empty).
    const aboveWalk = (ix: number, iy: number, iz: number) => {
        const col = column(ix, iz);
        const rows = walkRows.get(col);
        const i = rows ? lowerBound(rows, iy + 1) - 1 : -1;
        const ref = i >= 0 ? rows[i] : (columns.ground.get(col) ?? columns.near.get(col)[0] + NEAR_VOXELS) + 1 + eyeVoxels;
        return Math.min(MAX_PENALTY_VOXELS, Math.max(0, iy - ref));
    };

    // cost factor of a graph cell, BLOCKED when not in the graph
    const factorOf = (ix: number, iy: number, iz: number) => {
        if (!inBox(ix, iy, iz)) return BLOCKED;
        let code = (get(ix, iy, iz) & FACTOR_MASK) >> FACTOR_SHIFT;
        if (code === 0) {
            const ok = allowFlying && nearGeometry(ix, iy, iz) && free(ix, iy, iz);
            code = ok ? 2 + aboveWalk(ix, iy, iz) : 1;
            set(ix, iy, iz, get(ix, iy, iz) | (code << FACTOR_SHIFT));
        }
        return code === 1 ? BLOCKED : 1 + FLY_PENALTY * (code - 2);
    };

    const isWalk = (ix: number, iy: number, iz: number) => inBox(ix, iy, iz) && (get(ix, iy, iz) & WALK) !== 0;

    // bit (dx + 1) + 3 (dy + 1) + 9 (dz + 1) set for each free node in the
    // 3x3x3 neighbourhood of (ix, iy, iz) inside the box
    const freeMask = (ix: number, iy: number, iz: number) => {
        let mask = 0, bit = 1;
        for (let z = iz - 1; z <= iz + 1; z++) {
            for (let y = iy - 1; y <= iy + 1; y++) {
                for (let x = ix - 1; x <= ix + 1; x++, bit <<= 1) {
                    if (inBox(x, y, z) && free(x, y, z)) mask |= bit;
                }
            }
        }
        return mask;
    };

    const indexOf = (p: Vec3Like): [number, number, number] => {
        return [Math.floor(p.x / v), Math.floor(p.y / v + LIFT), Math.floor(p.z / v)];
    };

    const cellOf = (p: Vec3Like) => {
        const [ix, iy, iz] = indexOf(p);
        return factorOf(ix, iy, iz) > 0 ? pack(ix, iy, iz) : null;
    };

    const nearestFree = (p: Vec3Like, maxVoxels: number) => {
        const [cx, cy, cz] = indexOf(p);
        let best: Cell | null = null;
        let bestDist = Infinity;
        for (let ix = cx - maxVoxels; ix <= cx + maxVoxels; ix++) {
            for (let iy = cy - maxVoxels; iy <= cy + maxVoxels; iy++) {
                for (let iz = cz - maxVoxels; iz <= cz + maxVoxels; iz++) {
                    if (factorOf(ix, iy, iz) === BLOCKED) continue;
                    const d = ((ix + 0.5) * v - p.x) ** 2 + (iy * v - p.y) ** 2 + ((iz + 0.5) * v - p.z) ** 2;
                    if (d < bestDist) {
                        bestDist = d;
                        best = pack(ix, iy, iz);
                    }
                }
            }
        }
        return best;
    };

    // row of the walk cell in column (ix, iz) within one voxel of iy, or null
    const walkNear = (ix: number, iy: number, iz: number) => {
        for (let dy = -1; dy <= 1; dy++) {
            if (isWalk(ix, iy + dy, iz)) return iy + dy;
        }
        return null;
    };

    const walkNeighbours = (ix: number, iy: number, iz: number) => {
        const out: Neighbour[] = [];
        const mask = freeMask(ix, iy, iz);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dz === 0) continue;
                if (dx !== 0 && dz !== 0 && (walkNear(ix + dx, iy, iz) === null || walkNear(ix, iy, iz + dz) === null)) continue;
                const ny = walkNear(ix + dx, iy, iz + dz);
                if (ny === null) continue;
                const step = STEPS[stepIndex(dx, ny - iy, dz)];
                if ((mask & step.block) === step.block) out.push({ cell: pack(ix + dx, ny, iz + dz), cost: step.length });
            }
        }
        return out;
    };

    // step length times the target cell's factor
    const flyNeighbours = (ix: number, iy: number, iz: number) => {
        const out: Neighbour[] = [];
        const mask = freeMask(ix, iy, iz);
        for (const step of STEPS) {
            if (!step || (mask & step.block) !== step.block) continue;
            const f = factorOf(ix + step.dx, iy + step.dy, iz + step.dz);
            if (f !== BLOCKED) out.push({ cell: pack(ix + step.dx, iy + step.dy, iz + step.dz), cost: f * step.length });
        }
        return out;
    };

    const neighbours = (c: Cell) => {
        const [ix, iy, iz] = unpack(c);
        return allowFlying ? flyNeighbours(ix, iy, iz) : walkNeighbours(ix, iy, iz);
    };

    const lineFree = (a: Vec3Like, b: Vec3Like) => {
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy + dz * dz) / (LINE_STEP * v)));
        for (let i = 0; i <= n; i++) {
            const t = i / n;
            if (!occ.isFree({ x: a.x + dx * t, y: a.y + dy * t + LIFT * v, z: a.z + dz * t })) return false;
        }
        return true;
    };

    return { voxel: v, cellOf, nearestFree, centre, neighbours, lineFree };
};

export { buildNavGrid };
export type { Cell, NavGrid, Neighbour };
