import { DEFAULT_TURN_IN, MAX_TURN_DEG_PER_SEC, VERTICAL, forwardOf, headingOf, limitTurnRate, lookAheadView, normalized, planTurns, turnBetween, type StretchViews, type TurnPlan } from './look-ahead';
import { CubicSpline } from './spline';
import type { Vec3Like } from '../candidates/occupancy';

type ViewKey = {
    position: Vec3Like,
    target: Vec3Like,
    fov: number,
    lookAhead?: boolean,
    turnIn?: number,
    // a detour key: on a look-ahead stretch only its position counts
    auto?: boolean
};

type ViewSplineOptions = { duration: number, smoothness: number, loop: boolean, frameRate: number };

// frames between the forward samples of a stretch
const SAMPLE_FRAMES = 0.5;
const MIN_SAMPLES = 16;
// the forward follows the travel direction at most this fast, in radians per second, and lags
// behind sharper bends; a reversal of travel turns it round instead of flipping it
const FORWARD_TURN_LIMIT = MAX_TURN_DEG_PER_SEC * Math.PI / 180;

// a look-ahead stretch from one user key to the next with look ahead; t0 is negative when it
// wraps in a loop. forwards: the forward view at evenly spaced frames, null without travel
type Stretch = StretchViews & {
    prevDistance: number, keyDistance: number,
    forwards: Vec3Like[] | null,
    plan: TurnPlan | null
};

const turnInOf = (key: ViewKey) => (Number.isFinite(key.turnIn) && key.turnIn >= 0 ? key.turnIn : DEFAULT_TURN_IN);

const viewOf = (key: ViewKey) => {
    const { position: p, target: q } = key;
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
    return {
        view: normalized(dx, dy, dz) ?? { x: 0, y: 0, z: -1 },
        distance: Math.sqrt(dx * dx + dy * dy + dz * dz)
    };
};

// velocity of the spline's first three dimensions at time (per segment parameter, which keeps
// the direction); clamped times use the end segments
const velocity = (spline: CubicSpline, time: number, out: Vec3Like) => {
    const { times, knots, dim } = spline;
    const last = times.length - 1;
    let seg = 0;
    while (seg < last - 1 && time >= times[seg + 1]) seg++;
    const t = Math.min(1, Math.max(0, (time - times[seg]) / (times[seg + 1] - times[seg])));
    const h00 = 6 * t * t - 6 * t;
    const h10 = 3 * t * t - 4 * t + 1;
    const h11 = 3 * t * t - 2 * t;
    const v = [0, 0, 0];
    let idx = seg * dim * 3;
    for (let i = 0; i < 3; i++) {
        const p0 = knots[idx + 1];
        const m0 = knots[idx + 2];
        const m1 = knots[idx + dim * 3];
        const p1 = knots[idx + dim * 3 + 1];
        idx += 3;
        v[i] = (p0 - p1) * h00 + m0 * h10 + m1 * h11;
    }
    out.x = v[0];
    out.y = v[1];
    out.z = v[2];
    return out;
};

// The forward view at evenly spaced frames over [t0, t1]. Vertical travel keeps the heading of
// the last travel before it, or the key view's; a standstill holds the forward around it; the
// forward turns at most FORWARD_TURN_LIMIT. Null when the stretch has no travel.
const sampleForwards = (spline: CubicSpline, t0: number, t1: number, keyView: Vec3Like, frameRate: number) => {
    const n = Math.max(MIN_SAMPLES, Math.ceil((t1 - t0) / SAMPLE_FRAMES));
    const v = { x: 0, y: 0, z: 0 };
    let heading = headingOf(keyView) ?? { x: 1, y: 0, z: 0 };
    const out: (Vec3Like | null)[] = [];
    for (let j = 0; j <= n; j++) {
        velocity(spline, t0 + (t1 - t0) * j / n, v);
        if (Math.hypot(v.x, v.z) >= VERTICAL * Math.hypot(v.x, v.y, v.z)) heading = headingOf(v) ?? heading;
        out.push(forwardOf(v, heading));
    }
    const first = out.findIndex(f => f);
    if (first < 0) return null;
    for (let j = 0; j <= n; j++) out[j] ??= out[j > first ? j - 1 : first];
    return limitTurnRate(out, (t1 - t0) / n / frameRate, FORWARD_TURN_LIMIT);
};

// the forward at frame t of the stretch, between its samples
const forwardAt = (s: { t0: number, t1: number }, forwards: Vec3Like[], t: number) => {
    const n = forwards.length - 1;
    const x = Math.min(n, Math.max(0, (t - s.t0) / (s.t1 - s.t0) * n));
    const j = Math.min(n - 1, Math.floor(x));
    const u = x - j;
    const a = forwards[j], b = forwards[j + 1];
    return normalized(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u) ?? a;
};

// the stretches arriving at the user keys with look ahead, each from the user key before it
const stretchesOf = (keys: ViewKey[], times: number[], spline: CubicSpline, opts: ViewSplineOptions) => {
    const users = keys.map((_, i) => i).filter(i => !keys[i].auto);
    const out: Stretch[] = [];
    users.forEach((to, u) => {
        if (!keys[to].lookAhead || (u === 0 && !opts.loop)) return;
        const from = users[(u + users.length - 1) % users.length];
        const prev = viewOf(keys[from]);
        const key = viewOf(keys[to]);
        const views: StretchViews = {
            t0: from < to ? times[from] : times[from] - opts.duration,
            t1: times[to],
            frameRate: opts.frameRate,
            prevView: prev.view,
            keyView: key.view,
            prevTurnIn: keys[from].lookAhead ? turnInOf(keys[from]) : DEFAULT_TURN_IN,
            turnIn: turnInOf(keys[to])
        };
        const forwards = sampleForwards(spline, views.t0, views.t1, key.view, opts.frameRate);
        out.push({
            ...views,
            prevDistance: prev.distance,
            keyDistance: key.distance,
            forwards,
            plan: forwards && planTurns(views, t => forwardAt(views, forwards, t))
        });
    });
    return out;
};

/**
 * The camera spline through keys at the ascending times, as [px, py, pz, tx, ty, tz, fov].
 * On a stretch arriving at a key with look ahead, the target follows lookAheadView at a view
 * distance blended between the stretch's two user keys; a stretch without travel turns from
 * one key view to the other. Without look ahead it is the plain spline.
 */
const buildViewSpline = (keys: ViewKey[], times: number[], opts: ViewSplineOptions) => {
    const points: number[] = [];
    for (const k of keys) {
        points.push(k.position.x, k.position.y, k.position.z);
        points.push(k.target.x, k.target.y, k.target.z);
        points.push(k.fov);
    }
    const spline = opts.loop ?
        CubicSpline.fromPointsLooping(opts.duration, times, points, opts.smoothness) :
        CubicSpline.fromPoints(times, points, opts.smoothness);

    const stretches = stretchesOf(keys, times, spline, opts);
    if (stretches.length === 0) {
        return (frame: number, result: number[]) => {
            spline.evaluate(frame, result);
            return result;
        };
    }

    return (frame: number, result: number[]) => {
        spline.evaluate(frame, result);
        for (const s of stretches) {
            const t = frame > s.t1 && opts.loop ? frame - opts.duration : frame;
            if (t <= s.t0 || t > s.t1) continue;
            const u = (t - s.t0) / (s.t1 - s.t0);
            const dir = s.forwards ?
                lookAheadView({ ...s.plan, t, t0: s.t0, t1: s.t1, frameRate: s.frameRate, forward: forwardAt(s, s.forwards, t), prevView: s.prevView, keyView: s.keyView }) :
                turnBetween(s.prevView, s.keyView, u);
            const distance = s.prevDistance + (s.keyDistance - s.prevDistance) * u;
            result[3] = result[0] + dir.x * distance;
            result[4] = result[1] + dir.y * distance;
            result[5] = result[2] + dir.z * distance;
            break;
        }
        return result;
    };
};

export { buildViewSpline };
export type { ViewKey, ViewSplineOptions };
