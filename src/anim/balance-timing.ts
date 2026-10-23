import { CubicSpline } from './spline';

type Point3 = { x: number, y: number, z: number };

type BalanceKey = {
    position: Point3,
    target: Point3,
    fov: number,
    // seconds spent resting at this key
    linger: number,
    // scene distance at this pose; non-finite values fall back to |target - position|
    distance: number
};

type BalanceInput = {
    // keys in playback order
    keys: BalanceKey[],
    frames: number,
    frameRate: number,
    smoothness: number,
    loop: boolean,
    rotationWeight: number
};

type BalanceResult =
    { ok: true, frames: number[] } |
    { ok: false, reason: 'tooFewKeys' | 'lingerTooLong' | 'tooFewFrames' };

const MAX_ITERATIONS = 10;
const SAMPLES_PER_SEGMENT = 32;
const MIN_DISTANCE = 1e-3;

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

// a pose as sampled from the spline: [px, py, pz, tx, ty, tz, fov]
const stepCost = (a: number[], b: number[], da: number, db: number, weight: number) => {
    const tr = length(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / Math.sqrt(da * db);

    const ax = a[3] - a[0], ay = a[4] - a[1], az = a[5] - a[2];
    const bx = b[3] - b[0], by = b[4] - b[1], bz = b[5] - b[2];
    const la = length(ax, ay, az);
    const lb = length(bx, by, bz);
    let angle = 0;
    if (la > 0 && lb > 0) {
        const dot = (ax * bx + ay * by + az * bz) / (la * lb);
        angle = Math.acos(Math.min(1, Math.max(-1, dot)));
    }
    const rot = angle * weight;

    const zoom = a[6] > 0 && b[6] > 0 ? Math.abs(Math.log(b[6] / a[6])) * weight : 0;

    return Math.sqrt(tr * tr + rot * rot + zoom * zoom);
};

const balanceTiming = (input: BalanceInput): BalanceResult => {
    const { keys, frames, frameRate, smoothness, loop, rotationWeight } = input;
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

    let boundaries: number[] = [];
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const total = costs.reduce((a, b) => a + b, 0);
        const durations = costs.map((c, s) => (total > 0 ? available * c / total : available / segs) + share[s]);
        const next = roundBoundaries(start, durations, end);
        if (next.join() === boundaries.join()) {
            break;
        }
        boundaries = next;

        // same construction as CameraAnimTrack.rebuildSpline
        const keyFrames = boundaries.slice(0, n);
        const points = poses.flat();
        const spline = loop ?
            CubicSpline.fromPointsLooping(frames, keyFrames, points, smoothness) :
            CubicSpline.fromPoints(keyFrames, points, smoothness);

        costs = [];
        const prev: number[] = [];
        const cur: number[] = [];
        for (let s = 0; s < segs; s++) {
            const d0 = dist[s];
            const d1 = dist[(s + 1) % n];
            const t0 = boundaries[s];
            const t1 = boundaries[s + 1];
            let cost = 0;
            let prevD = d0;
            spline.evaluate(t0, prev);
            for (let i = 1; i <= SAMPLES_PER_SEGMENT; i++) {
                const t = i / SAMPLES_PER_SEGMENT;
                const d = Math.pow(d0, 1 - t) * Math.pow(d1, t);
                spline.evaluate(t0 + (t1 - t0) * t, cur);
                cost += stepCost(prev, cur, prevD, d, rotationWeight);
                prev.length = 0;
                prev.push(...cur);
                prevD = d;
            }
            costs.push(cost);
        }
    }

    return { ok: true, frames: boundaries.slice(0, n) };
};

export { balanceTiming, BalanceKey, BalanceInput, BalanceResult };
