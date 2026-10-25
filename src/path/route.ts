import type { Cell, NavGrid } from './nav-grid';
import type { Vec3Like } from '../candidates/occupancy';

type Route = { points: Vec3Like[], length: number, fromSnapped: boolean, toSnapped: boolean };

const MAX_EXPANSIONS = 300000;
const SNAP_VOXELS = 2;
// march step of a straight move, in voxels
const STRAIGHT_STEP = 0.25;

const distance = (a: Vec3Like, b: Vec3Like) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

// binary min-heap of cells keyed by priority
class CellHeap {
    private cells: Cell[] = [];

    private keys: number[] = [];

    get size() {
        return this.cells.length;
    }

    push(cell: Cell, key: number) {
        const { cells, keys } = this;
        let i = cells.length;
        cells.push(cell);
        keys.push(key);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (keys[parent] <= key) break;
            cells[i] = cells[parent];
            keys[i] = keys[parent];
            i = parent;
        }
        cells[i] = cell;
        keys[i] = key;
    }

    pop(): Cell {
        const { cells, keys } = this;
        const top = cells[0];
        const lastCell = cells.pop();
        const lastKey = keys.pop();
        const n = cells.length;
        if (n === 0) return top;
        let i = 0;
        for (;;) {
            const l = 2 * i + 1;
            if (l >= n) break;
            const r = l + 1;
            const c = r < n && keys[r] < keys[l] ? r : l;
            if (keys[c] >= lastKey) break;
            cells[i] = cells[c];
            keys[i] = keys[c];
            i = c;
        }
        cells[i] = lastCell;
        keys[i] = lastKey;
        return top;
    }
}

const CHUNK_BITS = 12;
const CHUNK = 1 << CHUNK_BITS;

type SearchChunk = { g: Float64Array, came: Float64Array, closed: Uint8Array };

// A* state per cell (cost so far, predecessor, closed) in lazily allocated
// chunks of consecutive cell indices; cells are small non-negative integers.
class SearchState {
    private chunks = new Map<number, SearchChunk>();

    chunk(c: Cell) {
        const key = Math.floor(c / CHUNK);
        let chunk = this.chunks.get(key);
        if (!chunk) {
            chunk = { g: new Float64Array(CHUNK).fill(Infinity), came: new Float64Array(CHUNK).fill(-1), closed: new Uint8Array(CHUNK) };
            this.chunks.set(key, chunk);
        }
        return chunk;
    }
}

// A* from start to goal with a Euclidean heuristic in voxels; the cells from
// start to goal, or null when unreachable or the expansion cap is hit.
const search = (grid: NavGrid, start: Cell, goal: Cell): Cell[] | null => {
    const goalPos = grid.centre(goal);
    const h = (c: Cell) => distance(grid.centre(c), goalPos) / grid.voxel;
    const state = new SearchState();
    const at = (c: Cell) => c % CHUNK;
    state.chunk(start).g[at(start)] = 0;
    const open = new CellHeap();
    open.push(start, h(start));
    let expansions = 0;

    while (open.size > 0) {
        const cell = open.pop();
        const chunk = state.chunk(cell);
        if (chunk.closed[at(cell)]) continue;
        if (cell === goal) {
            const path = [cell];
            for (let c = chunk.came[at(cell)]; c >= 0; c = state.chunk(c).came[at(c)]) path.push(c);
            return path.reverse();
        }
        chunk.closed[at(cell)] = 1;
        if (++expansions > MAX_EXPANSIONS) return null;

        const base = chunk.g[at(cell)];
        for (const { cell: next, cost } of grid.neighbours(cell)) {
            const nc = state.chunk(next);
            const i = at(next);
            if (nc.closed[i]) continue;
            const tentative = base + cost;
            if (tentative < nc.g[i]) {
                nc.g[i] = tentative;
                nc.came[i] = cell;
                open.push(next, tentative + h(next));
            }
        }
    }
    return null;
};

// the grid cell of p, else the nearest graph cell within SNAP_VOXELS
const snapCell = (grid: Pick<NavGrid, 'cellOf' | 'nearestFree'>, p: Vec3Like) => grid.cellOf(p) ?? grid.nearestFree(p, SNAP_VOXELS);

type Attach = { cell: Cell, straight: number };

type AttachGrid = Pick<NavGrid, 'voxel' | 'cellOf' | 'nearestFree' | 'centre' | 'lineFree'>;

// Straight moves from p towards each point of toward: a move marches from p
// and stops at the first graph cell; it counts when the line from p to the
// cell centre is free. One hit per cell, nearest first; straight is the
// distance from p.
const straightHits = (grid: AttachGrid, p: Vec3Like, toward: Vec3Like[]): Attach[] => {
    const hits = new Map<Cell, number>();
    const q = { x: 0, y: 0, z: 0 };
    for (const t of toward) {
        const n = Math.ceil(distance(p, t) / (STRAIGHT_STEP * grid.voxel));
        for (let i = 1; i <= n; i++) {
            const s = i / n;
            q.x = p.x + (t.x - p.x) * s;
            q.y = p.y + (t.y - p.y) * s;
            q.z = p.z + (t.z - p.z) * s;
            const cell = grid.cellOf(q);
            if (cell === null) continue;
            const at = grid.centre(cell);
            if (!hits.has(cell) && grid.lineFree(p, at)) hits.set(cell, distance(p, at));
            break;
        }
    }
    return [...hits].map(([cell, straight]) => ({ cell, straight })).sort((a, b) => a.straight - b.straight);
};

// The graph cell a key at p starts from: its snapped cell (straight 0), else
// the nearest straight hit towards toward, else null.
const attachCell = (grid: AttachGrid, p: Vec3Like, toward: Vec3Like[]): Attach | null => {
    const snapped = snapCell(grid, p);
    if (snapped !== null) return { cell: snapped, straight: 0 };
    return straightHits(grid, p, toward)[0] ?? null;
};

// Route between the start cells of from and to (see attachCell, each moving
// towards the other end). Points are cell centres from the start cell to the
// goal cell; length is in world units and includes the straight moves.
const findRoute = (grid: NavGrid, from: Vec3Like, to: Vec3Like): Route | null => {
    const start = attachCell(grid, from, [to]);
    const goal = attachCell(grid, to, [from]);
    if (start === null || goal === null) return null;

    const cells = search(grid, start.cell, goal.cell);
    if (!cells) return null;

    const points = cells.map(c => grid.centre(c));
    let length = start.straight + goal.straight;
    for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
    return { points, length, fromSnapped: grid.cellOf(from) === null, toSnapped: grid.cellOf(to) === null };
};

export { attachCell, CellHeap, findRoute, snapCell, straightHits };
export type { Attach, Route };
