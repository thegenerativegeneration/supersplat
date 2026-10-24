import { CellStore } from './cell-store';
import { addTo, inIntervals, lowerBound, nearIntervals, occupiedRows, sorted, type Bounds } from './columns';
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
    lineFree(a: Vec3Like, b: Vec3Like): boolean,
    pointFree(p: Vec3Like): boolean
};

// fly cells must lie within this many voxels (per axis) of an occupied voxel
const NEAR_VOXELS = 8;
const FLY_PENALTY = 0.5;
const MAX_PENALTY_VOXELS = 10;
// entering a cell d voxels from the nearest occupied voxel costs
// PROXIMITY_WEIGHT * max(0, PROXIMITY_RANGE - d) / PROXIMITY_RANGE more, so
// routes keep to the middle of doors and corridors
const PROXIMITY_WEIGHT = 3;
const PROXIMITY_RANGE = 3;
// lifts points on a voxel boundary into the row above, as a fraction of a voxel
const LIFT = 1e-4;
// lineFree sampling step, as a fraction of a voxel
const LINE_STEP = 0.25;
// store margin so occupancy lookups one voxel outside the box stay in range
const MARGIN = 2;

// per-cell store layout: occupancy (2 bits), clear (2 bits), fly factor code
// (4 bits: 1 = not a graph cell, 2 + k = k voxels above walking), walk flag,
// squared distance code (4 bits: 1 + min(d^2, PROXIMITY_RANGE^2))
const OCC_EMPTY = 1, OCC_FULL = 2;
const CLEAR_YES = 1 << 2, CLEAR_NO = 2 << 2, CLEAR_MASK = 3 << 2;
const FACTOR_SHIFT = 4, FACTOR_MASK = 15 << FACTOR_SHIFT;
const WALK = 1 << 8;
const DIST_SHIFT = 9, DIST_MASK = 15 << DIST_SHIFT;
const DIP = 1 << 13;

// head clearance in voxels of the surfaces walk cells stand on (Suggest
// Views levels need more)
const NAV_HEAD_VOXELS = 3;
// extra cost of a step into a dip walk cell (one voxel lower, under a lintel)
const DIP_COST = 2;

const BLOCKED = 0;

type Step = { dx: number, dy: number, dz: number, length: number, block: number, walkBlock: number };

const stepIndex = (dx: number, dy: number, dz: number) => (dx + 1) + 3 * (dy + 1) + 9 * (dz + 1);

// The 26 unit steps by stepIndex (the centre is empty). block has the
// passMask bits of every node of the step's 2x2x2 block except the start:
// all must be unoccupied so the straight segment stays out of occupied voxels.
// A segment between nodes one row apart runs through the lower row only (a
// node owns the voxel above it), so walkBlock has the block's nodes in the
// lower row plus the target.
const STEPS: Step[] = [];
for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            let block = 0, walkBlock = 1 << stepIndex(dx, dy, dz);
            const low = Math.min(0, dy);
            for (let sz = 0; sz <= Math.abs(dz); sz++) {
                for (let sy = 0; sy <= Math.abs(dy); sy++) {
                    for (let sx = 0; sx <= Math.abs(dx); sx++) {
                        if (sx + sy + sz === 0) continue;
                        const bit = 1 << stepIndex(sx * dx, sy * dy, sz * dz);
                        block |= bit;
                        if (sy * dy === low) walkBlock |= bit;
                    }
                }
            }
            STEPS[stepIndex(dx, dy, dz)] = { dx, dy, dz, length: Math.sqrt(dx * dx + dy * dy + dz * dz), block, walkBlock };
        }
    }
}

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

// A node is passable when its own voxel is unoccupied. Walk cells stand on
// level surface voxels (levels found with NAV_HEAD_VOXELS): eye height above
// the surface when the voxels from the second row above it up to that node
// are unoccupied, else one voxel lower (a dip, e.g. under a door lintel)
// when those up to the lower node are; connected horizontally (8
// neighbours, |dy| <= 1, diagonals only between walk orthogonals, walkBlock),
// so doors route. Fly cells (allowFlying): nodes in the box with 1-voxel clearance
// (occ.isFree), within NEAR_VOXELS of an occupied voxel and at least eye
// height above the occupied voxel below them; 26 neighbours, cost per step
// scaled by height above walking. Every step adds the proximity cost of the
// cell it enters and needs its 2x2x2 block passable (see STEPS). Cells are classified lazily, so memory grows with the cells a
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

    const passable = (ix: number, iy: number, iz: number) => !occupied(ix, iy, iz);

    // same as occ.isFree(centre): no occupied voxel in the 3x3x3 around the node
    const clear = (ix: number, iy: number, iz: number) => {
        const s = get(ix, iy, iz);
        if (s & CLEAR_MASK) return (s & CLEAR_MASK) === CLEAR_YES;
        let ok = true;
        for (let x = ix - 1; ok && x <= ix + 1; x++) {
            for (let y = iy - 1; ok && y <= iy + 1; y++) {
                for (let z = iz - 1; ok && z <= iz + 1; z++) ok = !occupied(x, y, z);
            }
        }
        set(ix, iy, iz, get(ix, iy, iz) | (ok ? CLEAR_YES : CLEAR_NO));
        return ok;
    };

    const near2 = nearIntervals(occ, bounds, PROXIMITY_RANGE - 1);

    // proximity cost of entering the node; occupied voxels with d < RANGE lie
    // within RANGE - 1 per axis, so the 5x5x5 cube is enough
    const proximity = (ix: number, iy: number, iz: number) => {
        const s = get(ix, iy, iz);
        let code = (s & DIST_MASK) >> DIST_SHIFT;
        if (code === 0) {
            const r = PROXIMITY_RANGE - 1;
            let d2 = PROXIMITY_RANGE * PROXIMITY_RANGE;
            if (inIntervals(near2.get(column(ix, iz)), iy)) {
                for (let x = -r; x <= r; x++) {
                    for (let y = -r; y <= r; y++) {
                        for (let z = -r; z <= r; z++) {
                            if (x * x + y * y + z * z < d2 && occupied(ix + x, iy + y, iz + z)) d2 = x * x + y * y + z * z;
                        }
                    }
                }
            }
            code = 1 + d2;
            set(ix, iy, iz, s | (code << DIST_SHIFT));
        }
        return PROXIMITY_WEIGHT * Math.max(0, PROXIMITY_RANGE - Math.sqrt(code - 1)) / PROXIMITY_RANGE;
    };

    const stepCost = (step: Step, factor: number, ix: number, iy: number, iz: number) => {
        return factor * step.length + proximity(ix, iy, iz) + ((get(ix, iy, iz) & DIP) ? DIP_COST : 0);
    };

    const walkSets = new Map<number, Set<number>>();
    for (const level of levels) {
        for (const [ix, iy, iz] of level.cells) {
            // free rows iy + 2 .. top
            let top = iy + 1;
            while (top < iy + 1 + eyeVoxels && passable(ix, top + 1, iz)) top++;
            const cy = top === iy + 1 + eyeVoxels ? top : iy + eyeVoxels;
            if (top >= iy + eyeVoxels && inBox(ix, cy, iz)) {
                set(ix, cy, iz, get(ix, cy, iz) | WALK | (2 << FACTOR_SHIFT) | (cy < iy + 1 + eyeVoxels ? DIP : 0));
                addTo(walkSets, column(ix, iz), [cy]);
            }
        }
    }
    const walkRows = sorted(walkSets);
    const near8 = allowFlying ? nearIntervals(occ, bounds, NEAR_VOXELS) : null;
    const occRows = allowFlying ? occupiedRows(occ, bounds) : null;

    // row of the highest occupied voxel below the node in its column (at
    // most one row under the box), or null
    const floorBelow = (ix: number, iy: number, iz: number) => {
        const rows = occRows.get(column(ix, iz));
        const i = rows ? lowerBound(rows, iy) - 1 : -1;
        return i >= 0 && rows[i] >= y0 - 1 ? rows[i] : null;
    };

    // Voxels above walking height: from the nearest walk cell at or below in
    // the same column, else from eye height above the floor below.
    const aboveWalk = (ix: number, iy: number, iz: number, floor: number) => {
        const rows = walkRows.get(column(ix, iz));
        const i = rows ? lowerBound(rows, iy + 1) - 1 : -1;
        const ref = i >= 0 ? rows[i] : floor + 1 + eyeVoxels;
        return Math.min(MAX_PENALTY_VOXELS, Math.max(0, iy - ref));
    };

    const flyCode = (ix: number, iy: number, iz: number) => {
        if (!allowFlying || !inIntervals(near8.get(column(ix, iz)), iy)) return 1;
        const floor = floorBelow(ix, iy, iz);
        if (floor === null || iy < floor + 1 + eyeVoxels || !clear(ix, iy, iz)) return 1;
        return 2 + aboveWalk(ix, iy, iz, floor);
    };

    // cost factor of a graph cell, BLOCKED when not in the graph
    const factorOf = (ix: number, iy: number, iz: number) => {
        if (!inBox(ix, iy, iz)) return BLOCKED;
        let code = (get(ix, iy, iz) & FACTOR_MASK) >> FACTOR_SHIFT;
        if (code === 0) {
            code = flyCode(ix, iy, iz);
            set(ix, iy, iz, get(ix, iy, iz) | (code << FACTOR_SHIFT));
        }
        return code === 1 ? BLOCKED : 1 + FLY_PENALTY * (code - 2);
    };

    const isWalk = (ix: number, iy: number, iz: number) => inBox(ix, iy, iz) && (get(ix, iy, iz) & WALK) !== 0;

    // bit (dx + 1) + 3 (dy + 1) + 9 (dz + 1) set for each passable node in the
    // 3x3x3 neighbourhood of (ix, iy, iz) inside the box
    const passMask = (ix: number, iy: number, iz: number) => {
        let mask = 0, bit = 1;
        for (let z = iz - 1; z <= iz + 1; z++) {
            for (let y = iy - 1; y <= iy + 1; y++) {
                for (let x = ix - 1; x <= ix + 1; x++, bit <<= 1) {
                    if (inBox(x, y, z) && passable(x, y, z)) mask |= bit;
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

    const cornersWalk = (ix: number, iz: number, dx: number, dz: number, iy: number, ny: number) => {
        return [iy, ny].every(y => walkNear(ix + dx, y, iz) !== null && walkNear(ix, y, iz + dz) !== null);
    };

    const walkNeighbours = (ix: number, iy: number, iz: number) => {
        const out: Neighbour[] = [];
        const mask = passMask(ix, iy, iz);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dz === 0) continue;
                const ny = walkNear(ix + dx, iy, iz + dz);
                if (ny === null) continue;
                // a diagonal needs both corner columns walkable near both rows,
                // so the step back is allowed too
                if (dx !== 0 && dz !== 0 && !cornersWalk(ix, iz, dx, dz, iy, ny)) continue;
                const step = STEPS[stepIndex(dx, ny - iy, dz)];
                if ((mask & step.walkBlock) === step.walkBlock) {
                    out.push({ cell: pack(ix + dx, ny, iz + dz), cost: stepCost(step, 1, ix + dx, ny, iz + dz) });
                }
            }
        }
        return out;
    };

    // step length times the target cell's factor, plus proximity; steps
    // between walk cells need only walkBlock, as when walking
    const flyNeighbours = (ix: number, iy: number, iz: number) => {
        const out: Neighbour[] = [];
        const mask = passMask(ix, iy, iz);
        const fromWalk = isWalk(ix, iy, iz);
        for (const step of STEPS) {
            if (!step) continue;
            const x = ix + step.dx, y = iy + step.dy, z = iz + step.dz;
            const block = fromWalk && isWalk(x, y, z) ? step.walkBlock : step.block;
            if ((mask & block) !== block) continue;
            const f = factorOf(x, y, z);
            if (f !== BLOCKED) out.push({ cell: pack(x, y, z), cost: stepCost(step, f, x, y, z) });
        }
        return out;
    };

    const neighbours = (c: Cell) => {
        const [ix, iy, iz] = unpack(c);
        return allowFlying ? flyNeighbours(ix, iy, iz) : walkNeighbours(ix, iy, iz);
    };

    // the voxel containing the point (lifted like indexOf) is unoccupied
    const pointFree = (p: Vec3Like) => {
        return !occ.occupied(Math.floor(p.x / v), Math.floor(p.y / v + LIFT), Math.floor(p.z / v));
    };

    // every voxel sampled along the segment is unoccupied
    const lineFree = (a: Vec3Like, b: Vec3Like) => {
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy + dz * dz) / (LINE_STEP * v)));
        const p = { x: 0, y: 0, z: 0 };
        for (let i = 0; i <= n; i++) {
            const t = i / n;
            p.x = a.x + dx * t;
            p.y = a.y + dy * t;
            p.z = a.z + dz * t;
            if (!pointFree(p)) return false;
        }
        return true;
    };

    return { voxel: v, cellOf, nearestFree, centre, neighbours, lineFree, pointFree };
};

export { buildNavGrid, NAV_HEAD_VOXELS };
export type { Cell, NavGrid, Neighbour };
