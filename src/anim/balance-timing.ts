import { MAX_TURN_DEG_PER_SEC } from './look-ahead';
import { buildViewSpline } from './look-ahead-spline';

type Point3 = { x: number, y: number, z: number };

type BalanceKey = {
    position: Point3,
    target: Point3,
    fov: number,
    // seconds spent resting at this key
    linger: number,
    // scene distance at this pose; non-finite values fall back to |target - position|
    distance: number,
    // lookAhead, turnIn and auto: see ViewKey in look-ahead-spline.ts
    lookAhead?: boolean,
    turnIn?: number,
    auto?: boolean
};

type BalanceInput = {
    // keys in playback order
    keys: BalanceKey[],
    frames: number,
    frameRate: number,
    smoothness: number,
    loop: boolean,
    rotationWeight: number,
    // peak view turn speed in degrees per second; undefined leaves turning unlimited
    maxTurnDegPerSec?: number
};

type MotionStats = {
    // scene units along the sampled camera path
    pathLength: number,
    // scene units per second over the moving time, lingers excluded
    avgSpeed: number,
    peakSpeed: number,
    peakTurnDegPerSec: number
};

type BalanceResult =
    { ok: true, frames: number[], iterations: number, stats: MotionStats, turnLimited?: number } |
    { ok: false, reason: 'tooFewKeys' | 'lingerTooLong' | 'tooFewFrames' | 'keysChanged' | 'cancelled' };

const MAX_ITERATIONS = 10;
const SAMPLES_PER_SEGMENT = 32;
// a look-ahead view follows the path's bends, so its turn peaks are short: shots with look ahead
// sample each segment at least this often per frame
const LOOK_AHEAD_SAMPLES_PER_FRAME = 2;
const MIN_DISTANCE = 1e-3;
// a sampled peak this far above the turn cap counts as missing it
const TURN_TOLERANCE = 0.05;

const length = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

// rounds float boundaries to integers that are strictly increasing, keeping the first and last fixed
const roundBoundaries = (start: number, durations: number[], end: number) => {
    const r = [start];
    let acc = start;
    for (const d of durations) {
        acc += d;
        r.push(Math.round(acc));
    }
    const last = r.length - 1;
    r[last] = end;

    for (let k = 1; k < last; k++) {
        r[k] = Math.max(r[k], r[k - 1] + 1);
    }
    for (let k = last - 1; k > 0; k--) {
        r[k] = Math.min(r[k], r[k + 1] - 1);
    }
    return r;
};

const sceneDistance = (key: BalanceKey) => {
    const d = Number.isFinite(key.distance) ?
        key.distance :
        length(key.target.x - key.position.x, key.target.y - key.position.y, key.target.z - key.position.z);
    return Math.max(d, MIN_DISTANCE);
};

// poses as sampled from the spline: [px, py, pz, tx, ty, tz, fov]
const moveLength = (a: number[], b: number[]) => length(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

const viewLength = (p: number[]) => length(p[3] - p[0], p[4] - p[1], p[5] - p[2]);

// angle in radians between the view directions (target - position) of two poses
const viewAngle = (a: number[], b: number[]) => {
    const ax = a[3] - a[0], ay = a[4] - a[1], az = a[5] - a[2];
    const bx = b[3] - b[0], by = b[4] - b[1], bz = b[5] - b[2];
    const la = length(ax, ay, az);
    const lb = length(bx, by, bz);
    if (la > 0 && lb > 0) {
        const dot = (ax * bx + ay * by + az * bz) / (la * lb);
        return Math.acos(Math.min(1, Math.max(-1, dot)));
    }
    return 0;
};

const stepCost = (a: number[], b: number[], da: number, db: number, weight: number) => {
    const tr = moveLength(a, b) / Math.sqrt(da * db);
    const rot = viewAngle(a, b) * weight;

    const zoom = a[6] > 0 && b[6] > 0 ? Math.abs(Math.log(b[6] / a[6])) * weight : 0;

    return Math.sqrt(tr * tr + rot * rot + zoom * zoom);
};

// splits the moving frames by cost over the segments, giving each segment at least its minimum.
// Segments that would fall below their minimum are pinned to it and the others share the rest; this
// repeats until no new segment is pinned
const allocate = (available: number, costs: number[], minimums: number[], floorCosts: number[]) => {
    const segs = costs.length;
    const needed = minimums.reduce((a, b) => a + b, 0);
    if (needed >= available && needed > 0) {
        // too few frames for every minimum: each segment keeps half its share by floorCosts, and the other
        // half goes to the segments short of their minimum, in proportion to the shortfall
        const floorTotal = floorCosts.reduce((a, b) => a + b, 0);
        const floors = floorCosts.map(c => (floorTotal > 0 ? available * c / floorTotal : available / segs) / 2);
        const shortfall = minimums.map((m, s) => Math.max(0, m - floors[s]));
        const short = shortfall.reduce((a, b) => a + b, 0);
        const rest = available - floors.reduce((a, b) => a + b, 0);
        return floors.map((f, s) => f + rest * shortfall[s] / short);
    }

    const pinned = new Array<boolean>(segs).fill(false);
    for (;;) {
        let rest = available;
        let total = 0;
        let free = 0;
        for (let s = 0; s < segs; s++) {
            if (pinned[s]) {
                rest -= minimums[s];
            } else {
                total += costs[s];
                free++;
            }
        }
        const durations = costs.map((c, s) => {
            if (pinned[s]) {
                return minimums[s];
            }
            return total > 0 ? rest * c / total : rest / free;
        });
        let changed = false;
        for (let s = 0; s < segs; s++) {
            if (!pinned[s] && durations[s] < minimums[s]) {
                pinned[s] = true;
                changed = true;
            }
        }
        if (!changed) {
            return durations;
        }
    }
};

const balanceTiming = (input: BalanceInput): BalanceResult => {
    const { keys, frames, frameRate, smoothness, loop, rotationWeight, maxTurnDegPerSec } = input;
    const cap = maxTurnDegPerSec !== undefined && maxTurnDegPerSec > 0 ? maxTurnDegPerSec : undefined;
    const n = keys.length;
    if (n < 2) {
        return { ok: false, reason: 'tooFewKeys' };
    }

    const segs = loop ? n : n - 1;
    const lingerFrames = (i: number) => keys[i].linger * frameRate;

    const start = loop ? 0 : Math.round(lingerFrames(0));
    const end = loop ? frames : frames - 1 - Math.round(lingerFrames(n - 1));
    if (end - start < segs) {
        const endLingers = !loop && (keys[0].linger > 0 || keys[n - 1].linger > 0);
        return { ok: false, reason: endLingers ? 'lingerTooLong' : 'tooFewFrames' };
    }

    // a middle key rests for its linger, half of it charged to each neighbouring segment
    const share = new Array<number>(segs).fill(0);
    for (let i = loop ? 0 : 1; i < (loop ? n : n - 1); i++) {
        const half = lingerFrames(i) / 2;
        share[(i + segs - 1) % segs] += half;
        share[i % segs] += half;
    }
    const available = (end - start) - share.reduce((a, b) => a + b, 0);
    if (available < segs) {
        return { ok: false, reason: 'lingerTooLong' };
    }

    const lookAhead = keys.some(k => k.lookAhead);
    const samplesOf = (t0: number, t1: number) => (lookAhead ? Math.max(SAMPLES_PER_SEGMENT, Math.ceil((t1 - t0) * LOOK_AHEAD_SAMPLES_PER_FRAME)) : SAMPLES_PER_SEGMENT);

    const dist = keys.map(sceneDistance);
    const poses = keys.map(k => [
        k.position.x, k.position.y, k.position.z,
        k.target.x, k.target.y, k.target.z,
        k.fov
    ]);

    // initial cost: one step per segment between its two keys
    let costs: number[] = [];
    for (let s = 0; s < segs; s++) {
        const j = (s + 1) % n;
        costs.push(stepCost(poses[s], poses[j], dist[s], dist[j], rotationWeight));
    }

    // moving frames each segment needs to keep under the turn cap; they only grow so the loop settles
    const minimums = new Array<number>(segs).fill(0);
    const peakTurn = new Array<number>(segs).fill(0);
    let pathLength = 0;
    let peakStep = 0;

    const capMissed = () => cap !== undefined && Math.max(...peakTurn) > cap * (1 + TURN_TOLERANCE);

    // costs measured on the first spline, timed before any minimum applied
    let uncappedCosts: number[] | undefined;

    let boundaries: number[] = [];
    let iterations = 0;
    // past MAX_ITERATIONS the loop goes on only while the cap is missed, up to twice as many passes
    for (; iterations < MAX_ITERATIONS || (capMissed() && iterations < 2 * MAX_ITERATIONS); iterations++) {
        let durations: number[];
        if (cap === undefined) {
            const total = costs.reduce((a, b) => a + b, 0);
            durations = costs.map((c, s) => (total > 0 ? available * c / total : available / segs) + share[s]);
        } else {
            durations = allocate(available, costs, minimums, uncappedCosts ?? costs).map((d, s) => d + share[s]);
        }
        const next = roundBoundaries(start, durations, end);
        if (next.join() === boundaries.join()) {
            break;
        }
        boundaries = next;

        // the curve CameraAnimTrack plays
        const spline = buildViewSpline(keys, boundaries.slice(0, n), { duration: frames, smoothness, loop, frameRate });

        costs = [];
        pathLength = 0;
        peakStep = 0;
        const prev: number[] = [];
        const cur: number[] = [];
        for (let s = 0; s < segs; s++) {
            const d0 = dist[s];
            const d1 = dist[(s + 1) % n];
            const t0 = boundaries[s];
            const t1 = boundaries[s + 1];
            const samples = samplesOf(t0, t1);
            const sampleTime = (t1 - t0) / samples / frameRate;
            let cost = 0;
            let maxAngle = 0;
            // a view vector this short flips direction within one sample, so its turn is left out of the peak
            const shortView = 0.1 * Math.min(d0, d1);
            let prevD = d0;
            spline(t0, prev);
            for (let i = 1; i <= samples; i++) {
                const t = i / samples;
                const d = Math.pow(d0, 1 - t) * Math.pow(d1, t);
                spline(t0 + (t1 - t0) * t, cur);
                cost += stepCost(prev, cur, prevD, d, rotationWeight);
                const step = moveLength(prev, cur);
                pathLength += step;
                peakStep = Math.max(peakStep, step / sampleTime);
                if (viewLength(prev) >= shortView && viewLength(cur) >= shortView) {
                    maxAngle = Math.max(maxAngle, viewAngle(prev, cur));
                }
                prev.length = 0;
                prev.push(...cur);
                prevD = d;
            }
            costs.push(cost);
            peakTurn[s] = maxAngle * 180 / Math.PI / sampleTime;
            if (cap !== undefined && peakTurn[s] > cap) {
                // turn speed scales inversely with the segment's frames
                minimums[s] = Math.max(minimums[s], (t1 - t0) * peakTurn[s] / cap - share[s]);
            }
        }
        uncappedCosts ??= costs;
    }

    const peakTurnDegPerSec = Math.max(...peakTurn);
    const stats: MotionStats = {
        pathLength,
        avgSpeed: pathLength / (available / frameRate),
        peakSpeed: peakStep,
        peakTurnDegPerSec
    };
    const result: BalanceResult = { ok: true, frames: boundaries.slice(0, n), iterations, stats };
    if (capMissed()) {
        result.turnLimited = peakTurnDegPerSec;
    }
    return result;
};

export { MAX_TURN_DEG_PER_SEC, balanceTiming, BalanceKey, BalanceInput, BalanceResult, MotionStats };
