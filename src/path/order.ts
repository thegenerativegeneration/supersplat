interface OrderOptions {
    loop: boolean;
    keepOrder: boolean;
}

interface KeyOrder {
    order: number[];
    unreachable: number[];
}

const EXACT_LIMIT = 12;
const MAX_PASSES = 50;

const tourCost = (dist: number[][], tour: number[], loop: boolean) => {
    let sum = 0;
    for (let i = 1; i < tour.length; i++) {
        sum += dist[tour[i - 1]][tour[i]];
    }
    return loop && tour.length > 1 ? sum + dist[tour[tour.length - 1]][tour[0]] : sum;
};

// Held-Karp over subsets of tour[1..]; tour[0] stays first. Ties keep the lower index.
const exactTour = (dist: number[][], keys: number[], loop: boolean) => {
    const m = keys.length - 1;
    if (m <= 0) return keys.slice();
    const full = (1 << m) - 1;
    const cost = new Float64Array((full + 1) * m).fill(Infinity);
    const parent = new Int8Array((full + 1) * m).fill(-1);
    const d = (a: number, b: number) => dist[keys[a]][keys[b]];

    for (let j = 0; j < m; j++) {
        cost[(1 << j) * m + j] = d(0, j + 1);
    }
    for (let set = 1; set <= full; set++) {
        for (let j = 0; j < m; j++) {
            if (!(set & (1 << j))) continue;
            const prevSet = set ^ (1 << j);
            if (!prevSet) continue;
            let best = Infinity;
            let from = -1;
            for (let k = 0; k < m; k++) {
                if (!(prevSet & (1 << k))) continue;
                const c = cost[prevSet * m + k] + d(k + 1, j + 1);
                if (from < 0 || c < best) {
                    best = c;
                    from = k;
                }
            }
            cost[set * m + j] = best;
            parent[set * m + j] = from;
        }
    }

    let last = 0;
    let best = Infinity;
    for (let j = 0; j < m; j++) {
        const c = cost[full * m + j] + (loop ? d(j + 1, 0) : 0);
        if (j === 0 || c < best) {
            best = c;
            last = j;
        }
    }

    const tour = [keys[0]];
    const rev: number[] = [];
    let set = full;
    while (last >= 0) {
        rev.push(keys[last + 1]);
        const p = parent[set * m + last];
        set ^= 1 << last;
        last = p;
    }
    return tour.concat(rev.reverse());
};

// Nearest neighbour from keys[0], then 2-opt segment reversals that never move keys[0].
const heuristicTour = (dist: number[][], keys: number[], loop: boolean) => {
    const tour = [keys[0]];
    const left = keys.slice(1);
    while (left.length) {
        const from = tour[tour.length - 1];
        let pick = 0;
        for (let i = 1; i < left.length; i++) {
            if (dist[from][left[i]] < dist[from][left[pick]]) pick = i;
        }
        tour.push(left.splice(pick, 1)[0]);
    }

    let cost = tourCost(dist, tour, loop);
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let improved = false;
        for (let i = 1; i < tour.length - 1; i++) {
            for (let j = i + 1; j < tour.length; j++) {
                const seg = tour.slice(i, j + 1).reverse();
                const cand = tour.slice(0, i).concat(seg, tour.slice(j + 1));
                const c = tourCost(dist, cand, loop);
                if (c < cost - 1e-12) {
                    tour.splice(0, tour.length, ...cand);
                    cost = c;
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    return tour;
};

const orderKeys = (dist: number[][], opts: OrderOptions): KeyOrder => {
    const reachable: number[] = [];
    const unreachable: number[] = [];
    for (let i = 0; i < dist.length; i++) {
        (i === 0 || dist[0][i] !== Infinity ? reachable : unreachable).push(i);
    }
    if (!dist.length) return { order: [], unreachable };

    let tour: number[];
    if (opts.keepOrder) {
        tour = reachable;
    } else if (reachable.length - 1 <= EXACT_LIMIT) {
        tour = exactTour(dist, reachable, opts.loop);
    } else {
        tour = heuristicTour(dist, reachable, opts.loop);
    }
    return { order: tour.concat(unreachable), unreachable };
};

export { orderKeys, OrderOptions, KeyOrder };
