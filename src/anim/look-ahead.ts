import { CubicSpline } from './spline';
import type { Vec3Like } from '../candidates/occupancy';

// highest view turn speed the app asks for, in degrees per second
const MAX_TURN_DEG_PER_SEC = 20;

// seconds a look-ahead turn takes at least when the key sets none
const DEFAULT_TURN_IN = 1.5;

// share of the path's slope the forward view tilts by
const LOOK_PITCH = 0.4;

const CAP = MAX_TURN_DEG_PER_SEC * Math.PI / 180;
const EPSILON = 1e-9;

// view target for frame t on the stretch [t0, t1] arriving at key `to`; prev is the previous user key
type LookAheadInput = {
    t: number, t0: number, t1: number, frameRate: number,
    position: Vec3Like, tangent: Vec3Like, prevView: Vec3Like, keyView: Vec3Like,
    prevTurnIn: number, turnIn: number, distance: number
};

const dot = (a: Vec3Like, b: Vec3Like) => a.x * b.x + a.y * b.y + a.z * b.z;

const normalized = (x: number, y: number, z: number): Vec3Like | null => {
    const l = Math.sqrt(x * x + y * y + z * z);
    return l > EPSILON ? { x: x / l, y: y / l, z: z / l } : null;
};

const angle = (a: Vec3Like, b: Vec3Like) => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));

// rotates unit a towards unit b by the fraction u of the angle between them; opposite vectors
// turn about the vertical (or about x for vertical ones)
const slerp = (a: Vec3Like, b: Vec3Like, u: number): Vec3Like => {
    const omega = angle(a, b);
    if (omega < 1e-6) return { ...b };
    const sin = Math.sin(omega);
    if (sin > 1e-6) {
        const wa = Math.sin((1 - u) * omega) / sin;
        const wb = Math.sin(u * omega) / sin;
        return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb, z: a.z * wa + b.z * wb };
    }
    const side = normalized(-a.z, 0, a.x) ?? { x: 1, y: 0, z: 0 };
    const c = Math.cos(u * omega), s = Math.sin(u * omega);
    return { x: a.x * c + side.x * s, y: a.y * c + side.y * s, z: a.z * c + side.z * s };
};

// A unit view direction: from prevView it turns to the travel direction (the tangent tilted by
// LOOK_PITCH of its slope), holds it and turns into keyView by t1. Each turn takes its time in
// seconds, or longer when it would pass the turn cap; both shrink together to fit the stretch.
// Without travel the view turns from prevView to keyView over the whole stretch.
const lookAheadView = (input: LookAheadInput): Vec3Like => {
    const { t, t0, t1, frameRate, tangent, prevView, keyView } = input;
    const forward = normalized(tangent.x, tangent.y * LOOK_PITCH, tangent.z);
    if (!forward) return slerp(prevView, keyView, (t - t0) / (t1 - t0));

    const span = (t1 - t0) / frameRate;
    let turnOut = Math.max(input.prevTurnIn, angle(prevView, forward) / CAP);
    let turnIn = Math.max(input.turnIn, angle(forward, keyView) / CAP);
    if (turnOut + turnIn > span) {
        const k = span / (turnOut + turnIn);
        turnOut *= k;
        turnIn *= k;
    }
    const elapsed = (t - t0) / frameRate;
    const remaining = (t1 - t) / frameRate;
    if (elapsed < turnOut) return slerp(prevView, forward, elapsed / turnOut);
    if (remaining < turnIn) return slerp(forward, keyView, 1 - remaining / turnIn);
    return forward;
};

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

// a look-ahead stretch from user key `from` to user key `to`; t0 is negative when it wraps in a loop
type Stretch = {
    t0: number, t1: number,
    prevView: Vec3Like, keyView: Vec3Like, prevDistance: number, keyDistance: number,
    prevTurnIn: number, turnIn: number
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

// the stretches arriving at the user keys with look ahead, each from the user key before it
const stretchesOf = (keys: ViewKey[], times: number[], opts: ViewSplineOptions) => {
    const users = keys.map((_, i) => i).filter(i => !keys[i].auto);
    const out: Stretch[] = [];
    users.forEach((to, u) => {
        if (!keys[to].lookAhead || (u === 0 && !opts.loop)) return;
        const from = users[(u + users.length - 1) % users.length];
        const prev = viewOf(keys[from]);
        const key = viewOf(keys[to]);
        out.push({
            t0: from < to ? times[from] : times[from] - opts.duration,
            t1: times[to],
            prevView: prev.view,
            keyView: key.view,
            prevDistance: prev.distance,
            keyDistance: key.distance,
            prevTurnIn: keys[from].lookAhead ? turnInOf(keys[from]) : DEFAULT_TURN_IN,
            turnIn: turnInOf(keys[to])
        });
    });
    return out;
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

/**
 * The camera spline through keys at the ascending times, as [px, py, pz, tx, ty, tz, fov].
 * On a stretch arriving at a key with look ahead, the target follows lookAheadView at a view
 * distance blended between the stretch's two user keys. Without look ahead it is the plain spline.
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

    const stretches = stretchesOf(keys, times, opts);
    if (stretches.length === 0) {
        return (frame: number, result: number[]) => {
            spline.evaluate(frame, result);
            return result;
        };
    }

    const position = { x: 0, y: 0, z: 0 };
    const tangent = { x: 0, y: 0, z: 0 };
    return (frame: number, result: number[]) => {
        spline.evaluate(frame, result);
        for (const s of stretches) {
            const t = frame > s.t1 && opts.loop ? frame - opts.duration : frame;
            if (t <= s.t0 || t > s.t1) continue;
            position.x = result[0];
            position.y = result[1];
            position.z = result[2];
            velocity(spline, frame, tangent);
            const u = (t - s.t0) / (s.t1 - s.t0);
            const distance = s.prevDistance + (s.keyDistance - s.prevDistance) * u;
            const dir = lookAheadView({ ...s, t, frameRate: opts.frameRate, position, tangent, distance });
            result[3] = position.x + dir.x * distance;
            result[4] = position.y + dir.y * distance;
            result[5] = position.z + dir.z * distance;
            break;
        }
        return result;
    };
};

export { DEFAULT_TURN_IN, LOOK_PITCH, MAX_TURN_DEG_PER_SEC, buildViewSpline, lookAheadView };
export type { LookAheadInput, ViewKey, ViewSplineOptions };
