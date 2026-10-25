import { mainGroup } from './key-graph';
import { orderKeys, type OrderOptions } from './order';

// Blocks of keys, as key indices: runs of consecutive keys with the same
// orbit id; a key without one is a block of its own.
const orbitBlocks = (keys: readonly { orbit?: string }[]): number[][] => {
    const blocks: number[][] = [];
    keys.forEach((k, i) => {
        const last = blocks[blocks.length - 1];
        if (k.orbit !== undefined && last && keys[last[0]].orbit === k.orbit) last.push(i);
        else blocks.push([i]);
    });
    return blocks;
};

// The keys routes run between: the first and last key of each block,
// ascending, each once.
const blockEnds = (blocks: number[][]) => [...new Set(blocks.flatMap(b => [b[0], b[b.length - 1]]))];

// Orders the blocks of the main group and lists their keys in playback
// order. length(a, b) is the route length between ends[a] and ends[b]. The
// main group is the group of ends holding the most keys of blocks it holds
// both ends of; only those blocks are kept. A block is entered at its first
// key and left at its last, so the block distances are asymmetric. The
// first kept block comes first; keepOrder keeps them in key order.
const orderBlocks = (blocks: number[][], ends: number[], length: (a: number, b: number) => number, opts: OrderOptions): number[] => {
    const node = new Map(ends.map((k, a) => [k, a]));
    const entry = (b: number[]) => node.get(b[0]);
    const exit = (b: number[]) => node.get(b[b.length - 1]);
    const keysWithin = (group: number[]) => {
        const g = new Set(group);
        return blocks.reduce((sum, b) => sum + (g.has(entry(b)) && g.has(exit(b)) ? b.length : 0), 0);
    };
    const group = new Set(mainGroup(ends.length, length, keysWithin));
    const kept = blocks.filter(b => group.has(entry(b)) && group.has(exit(b)));
    const dist = kept.map((from, a) => kept.map((to, b) => (opts.keepOrder || a === b ? 0 : length(exit(from), entry(to)))));
    return orderKeys(dist, opts).order.flatMap(a => kept[a]);
};

// for each segment of the tour (tour[s] to the next key), whether it runs
// between consecutive keys of one block
const segmentsInBlocks = (blocks: number[][], tour: number[], segments: number) => {
    const blockOf = new Map(blocks.flatMap((b, i) => b.map(k => [k, i] as const)));
    return Array.from({ length: segments }, (_, s) => {
        const a = tour[s], b = tour[(s + 1) % tour.length];
        return b === a + 1 && blockOf.get(a) === blockOf.get(b);
    });
};

export { blockEnds, orbitBlocks, orderBlocks, segmentsInBlocks };
