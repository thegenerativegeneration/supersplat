import type { Cell, NavGrid } from './nav-grid';
import type { Vec3Like } from '../candidates/occupancy';

type Route = { points: Vec3Like[], length: number, fromSnapped: boolean, toSnapped: boolean };

const MAX_EXPANSIONS = 300000;
const SNAP_VOXELS = 2;

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
const snapCell = (grid: NavGrid, p: Vec3Like) => grid.cellOf(p) ?? grid.nearestFree(p, SNAP_VOXELS);

// Route between the grid cells of from and to (snapped to the nearest graph
// cell within SNAP_VOXELS when outside the graph). Points are cell centres
// from the start cell to the goal cell; length is in world units.
const findRoute = (grid: NavGrid, from: Vec3Like, to: Vec3Like): Route | null => {
    const fromCell = grid.cellOf(from);
    const toCell = grid.cellOf(to);
    const start = fromCell ?? grid.nearestFree(from, SNAP_VOXELS);
    const goal = toCell ?? grid.nearestFree(to, SNAP_VOXELS);
    if (start === null || goal === null) return null;

    const cells = search(grid, start, goal);
    if (!cells) return null;

    const points = cells.map(c => grid.centre(c));
    let length = 0;
    for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
    return { points, length, fromSnapped: fromCell === null, toSnapped: toCell === null };
};

export { CellHeap, findRoute, snapCell };
export type { Route };
