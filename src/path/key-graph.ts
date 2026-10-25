import type { Cell, NavGrid } from './nav-grid';
import { CellHeap, snapCell, straightHits, type Attach } from './route';
import type { Vec3Like } from '../candidates/occupancy';

// One connected component of the nav graph as a compressed adjacency:
// node k is grid cell cells[k], its edges are offsets[k] .. offsets[k + 1]
// into targets (node indices) and costs.
type Component = { cells: Float64Array, offsets: Int32Array, targets: Int32Array, costs: Float64Array };

type KeyRoutes = {
    // world length of the cheapest route from key i to key j, Infinity when
    // they are not connected
    length(i: number, j: number): number,
    // cell centres of that route from i's cell to j's cell, or null
    points(i: number, j: number): Vec3Like[] | null,
    // nodes and edges held in all components
    size: { nodes: number, edges: number }
};

// typed array that doubles when full
class Grow<T extends Int32Array | Float64Array> {
    data: T;

    length = 0;

    constructor(private make: (n: number) => T) {
        this.data = make(1024);
    }

    push(v: number) {
        if (this.length === this.data.length) {
            const next = this.make(this.data.length * 2);
            next.set(this.data);
            this.data = next;
        }
        this.data[this.length++] = v;
    }

    trim() {
        return this.data.slice(0, this.length) as T;
    }
}

// Breadth-first flood fill from start; index maps every reached cell to its
// node, valid until the next call.
const buildComponent = (grid: NavGrid, start: Cell) => {
    const index = new Map<Cell, number>([[start, 0]]);
    const cells = new Grow(n => new Float64Array(n));
    const targets = new Grow(n => new Int32Array(n));
    const costs = new Grow(n => new Float64Array(n));
    const offsets = new Grow(n => new Int32Array(n));
    cells.push(start);
    for (let u = 0; u < cells.length; u++) {
        offsets.push(targets.length);
        for (const { cell, cost } of grid.neighbours(cells.data[u])) {
            let k = index.get(cell);
            if (k === undefined) {
                k = cells.length;
                index.set(cell, k);
                cells.push(cell);
            }
            targets.push(k);
            costs.push(cost);
        }
    }
    offsets.push(targets.length);
    const component: Component = { cells: cells.trim(), offsets: offsets.trim(), targets: targets.trim(), costs: costs.trim() };
    return { component, index };
};

// Dijkstra from node source until every node in goals is settled; the
// predecessor of each node in the shortest path tree (-1: none).
const dijkstra = (c: Component, source: number, goals: number[]): Int32Array => {
    const n = c.cells.length;
    const cost = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const wanted = new Set(goals);
    cost[source] = 0;
    const open = new CellHeap();
    open.push(source, 0);
    while (open.size > 0 && wanted.size > 0) {
        const u = open.pop();
        if (done[u]) continue;
        done[u] = 1;
        wanted.delete(u);
        for (let e = c.offsets[u]; e < c.offsets[u + 1]; e++) {
            const v = c.targets[e];
            const next = cost[u] + c.costs[e];
            if (!done[v] && next < cost[v]) {
                cost[v] = next;
                parent[v] = u;
                open.push(v, next);
            }
        }
    }
    return parent;
};

// Cheapest routes between the given key positions (snapped like findRoute;
// lengths include the straight moves): the components holding the keys are
// built once, then one Dijkstra per source key settles all keys of its
// component. A key that does not snap tries its straight hits towards the
// other keys, nearest first, and takes the first whose component holds
// another key's cell, else the nearest.
const keyRoutes = (grid: NavGrid, positions: Vec3Like[]): KeyRoutes => {
    const comps: Component[] = [];
    // cell -> node of each component, dropped once the keys are placed
    const indexes: Map<Cell, number>[] = [];
    const componentOf = (cell: Cell) => {
        const k = indexes.findIndex(index => index.has(cell));
        if (k >= 0) return k;
        const { component, index } = buildComponent(grid, cell);
        comps.push(component);
        indexes.push(index);
        return comps.length - 1;
    };

    const attached: (Attach | null)[] = positions.map((p) => {
        const cell = snapCell(grid, p);
        return cell === null ? null : { cell, straight: 0 };
    });
    positions.forEach((p, i) => {
        if (attached[i]) return;
        const hits = straightHits(grid, p, positions.filter((_, j) => j !== i));
        const joins = (hit: Attach) => {
            const index = indexes[componentOf(hit.cell)];
            return attached.some((a, j) => j !== i && a && index.has(a.cell));
        };
        attached[i] = hits.find(joins) ?? hits[0] ?? null;
    });

    // component and node of each key, -1 when it has no graph cell
    const compOf = new Int32Array(positions.length).fill(-1);
    const nodeOf = new Int32Array(positions.length).fill(-1);
    attached.forEach((a, i) => {
        if (!a) return;
        compOf[i] = componentOf(a.cell);
        nodeOf[i] = indexes[compOf[i]].get(a.cell);
    });
    indexes.length = 0;

    const trees = new Map<number, Int32Array>();
    const tree = (i: number) => {
        if (!trees.has(i)) {
            const goals = positions.map((_, j) => j).filter(j => compOf[j] === compOf[i]).map(j => nodeOf[j]);
            trees.set(i, dijkstra(comps[compOf[i]], nodeOf[i], goals));
        }
        return trees.get(i);
    };

    const paths = new Map<number, { points: Vec3Like[], length: number } | null>();
    const path = (i: number, j: number) => {
        const key = i * positions.length + j;
        if (!paths.has(key)) {
            if (compOf[i] < 0 || compOf[i] !== compOf[j]) {
                paths.set(key, null);
            } else {
                const comp = comps[compOf[i]];
                const parent = tree(i);
                const points: Vec3Like[] = [];
                let last = -1;
                for (let k = nodeOf[j]; k >= 0; k = parent[k]) {
                    points.push(grid.centre(comp.cells[k]));
                    last = k;
                }
                // edges can be one-way, so a key in the same component may
                // still be out of reach from i: then the chain misses i
                if (last !== nodeOf[i]) {
                    paths.set(key, null);
                    return null;
                }
                points.reverse();
                let length = attached[i].straight + attached[j].straight;
                for (let k = 1; k < points.length; k++) {
                    const a = points[k - 1], b = points[k];
                    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
                }
                paths.set(key, { points, length });
            }
        }
        return paths.get(key);
    };

    return {
        length: (i, j) => path(i, j)?.length ?? Infinity,
        points: (i, j) => path(i, j)?.points ?? null,
        size: {
            nodes: comps.reduce((a, c) => a + c.cells.length, 0),
            edges: comps.reduce((a, c) => a + c.targets.length, 0)
        }
    };
};

// The main group of keys: keys reach each other when routes run both ways,
// and groups join through shared keys. Returns the indices of the group with
// the highest weight (default: the most keys), ascending; on a tie the group
// holding the lowest index.
const mainGroup = (n: number, length: (i: number, j: number) => number, weight = (group: number[]) => group.length): number[] => {
    const root = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (find(i) !== find(j) && length(i, j) < Infinity && length(j, i) < Infinity) root[find(j)] = find(i);
        }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(i);
    }
    // groups come in order of their lowest index, so the first largest wins
    let best: number[] = [], bestWeight = -Infinity;
    for (const g of groups.values()) {
        const w = weight(g);
        if (w > bestWeight) {
            best = g;
            bestWeight = w;
        }
    }
    return best;
};

export { keyRoutes, mainGroup };
export type { KeyRoutes };
