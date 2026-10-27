import type { Vec3Like } from '../candidates/occupancy';

// highest view turn speed the app asks for, in degrees per second
const MAX_TURN_DEG_PER_SEC = 20;

// seconds a look-ahead turn takes at least when the key sets none
const DEFAULT_TURN_IN = 1.5;

// share of the path's slope the forward view tilts by
const LOOK_PITCH = 0.4;

// travel whose horizontal part is below this share of its speed counts as vertical
const VERTICAL = 0.1;

const CAP = MAX_TURN_DEG_PER_SEC * Math.PI / 180;
const EPSILON = 1e-9;
// passes that settle the turn times against the forward at their ends
const PLAN_PASSES = 8;

const normalized = (x: number, y: number, z: number): Vec3Like | null => {
    const l = Math.sqrt(x * x + y * y + z * z);
    return l > EPSILON ? { x: x / l, y: y / l, z: z / l } : null;
};

// unit heading in the xz plane, null for a vertical direction
const headingOf = (v: Vec3Like): Vec3Like | null => {
    const h = Math.hypot(v.x, v.z);
    return h > EPSILON ? { x: v.x / h, y: 0, z: v.z / h } : null;
};

const yawOf = (v: Vec3Like) => Math.atan2(v.z, v.x);
const pitchOf = (v: Vec3Like) => Math.asin(Math.min(1, Math.max(-1, v.y)));
const fromYawPitch = (yaw: number, pitch: number): Vec3Like => ({
    x: Math.cos(pitch) * Math.cos(yaw),
    y: Math.sin(pitch),
    z: Math.cos(pitch) * Math.sin(yaw)
});

// yaw from a to b in (-PI, PI]; a vertical direction takes the other one's yaw
const yawStep = (a: Vec3Like, b: Vec3Like) => {
    if (!headingOf(a) || !headingOf(b)) return 0;
    let d = yawOf(b) - yawOf(a);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    return d;
};

// Turns unit a towards unit b by the fraction u, yaw and pitch each at a steady rate, so a turn
// goes round the horizon and never over the top.
const turnBetween = (a: Vec3Like, b: Vec3Like, u: number): Vec3Like => {
    const yaw = (headingOf(a) ? yawOf(a) : yawOf(b)) + yawStep(a, b) * u;
    const pitch = pitchOf(a) + (pitchOf(b) - pitchOf(a)) * u;
    return fromYawPitch(yaw, pitch);
};

// the fastest view rotation of turnBetween(a, b) over a unit of time, in radians; equals the
// angle between them for level views
const turnAngle = (a: Vec3Like, b: Vec3Like) => {
    const pa = pitchOf(a), pb = pitchOf(b);
    const level = pa * pb <= 0 ? 1 : Math.max(Math.cos(pa), Math.cos(pb));
    return Math.hypot(level * yawStep(a, b), pb - pa);
};

// The view along a travel velocity: its slope tilted by LOOK_PITCH. Near-vertical travel keeps
// the given heading and tilts as if it had VERTICAL of its speed horizontally, so the view never
// points straight up or down. Null without travel.
const forwardOf = (velocity: Vec3Like, heading: Vec3Like) => {
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed < EPSILON) return null;
    const flat = Math.hypot(velocity.x, velocity.z);
    if (flat >= VERTICAL * speed) return normalized(velocity.x, velocity.y * LOOK_PITCH, velocity.z);
    const h = VERTICAL * speed;
    return normalized(heading.x * h, velocity.y * LOOK_PITCH, heading.z * h);
};

// Limits the forward samples, dt seconds apart, to turn at most maxRate radians per second in yaw
// and pitch, so a reversal of travel turns the view round instead of flipping it. yawShares, when
// given, scales the yaw limit at each sample (the horizontal share of the travel there), so the
// heading barely turns while the travel is near vertical.
const limitTurnRate = (forwards: Vec3Like[], dt: number, maxRate: number, yawShares?: number[]) => {
    let yaw = yawOf(forwards[0]);
    let pitch = pitchOf(forwards[0]);
    return forwards.map((f, j) => {
        if (j > 0) {
            let dy = yawOf(f) - yaw;
            while (dy > Math.PI) dy -= 2 * Math.PI;
            while (dy <= -Math.PI) dy += 2 * Math.PI;
            if (yawShares) {
                const maxYaw = maxRate * dt * yawShares[j];
                dy = Math.min(maxYaw, Math.max(-maxYaw, dy));
            }
            let dp = pitchOf(f) - pitch;
            const step = Math.hypot(Math.cos(pitch) * dy, dp);
            if (step > maxRate * dt) {
                dy *= maxRate * dt / step;
                dp *= maxRate * dt / step;
            }
            yaw += dy;
            pitch += dp;
        }
        return fromYawPitch(yaw, pitch);
    });
};

// a stretch arriving at a key with look ahead, in frames from the previous user key
type StretchViews = {
    t0: number, t1: number, frameRate: number,
    prevView: Vec3Like, keyView: Vec3Like,
    // seconds each turn takes at least
    prevTurnIn: number, turnIn: number
};

// the two turns of a stretch, in seconds, and the forward views they turn out to and in from
type TurnPlan = { turnOut: number, turnIn: number, outForward: Vec3Like, inForward: Vec3Like };

// Each turn takes its time, or longer when turning to (from) the forward at its end (start)
// would pass the turn cap; both shrink together to fit the stretch. forwardAt gives the
// forward view at a frame of the stretch.
const planTurns = (s: StretchViews, forwardAt: (frame: number) => Vec3Like): TurnPlan => {
    const span = (s.t1 - s.t0) / s.frameRate;
    const fit = (turnOut: number, turnIn: number): TurnPlan => {
        const k = turnOut + turnIn > span ? span / (turnOut + turnIn) : 1;
        return {
            turnOut: turnOut * k,
            turnIn: turnIn * k,
            outForward: forwardAt(s.t0 + turnOut * k * s.frameRate),
            inForward: forwardAt(s.t1 - turnIn * k * s.frameRate)
        };
    };
    let turnOut = s.prevTurnIn;
    let turnIn = s.turnIn;
    let plan = fit(turnOut, turnIn);
    // the times only grow, so the passes settle
    for (let pass = 1; pass < PLAN_PASSES; pass++) {
        const nextOut = Math.max(turnOut, turnAngle(s.prevView, plan.outForward) / CAP);
        const nextIn = Math.max(turnIn, turnAngle(plan.inForward, s.keyView) / CAP);
        if (nextOut === turnOut && nextIn === turnIn) break;
        turnOut = nextOut;
        turnIn = nextIn;
        plan = fit(turnOut, turnIn);
    }
    return plan;
};

// view for frame t on the stretch [t0, t1] arriving at the key with keyView
type LookAheadInput = TurnPlan & {
    t: number, t0: number, t1: number, frameRate: number,
    // the forward view at t
    forward: Vec3Like,
    prevView: Vec3Like, keyView: Vec3Like
};

// A unit view direction: from prevView it turns to outForward, follows the forward and turns from
// inForward into keyView by t1 (see turnBetween).
const lookAheadView = (input: LookAheadInput): Vec3Like => {
    const { t, t0, t1, frameRate, turnOut, turnIn } = input;
    const elapsed = (t - t0) / frameRate;
    const remaining = (t1 - t) / frameRate;
    if (elapsed < turnOut) return turnBetween(input.prevView, input.outForward, elapsed / turnOut);
    if (remaining < turnIn) return turnBetween(input.inForward, input.keyView, 1 - remaining / turnIn);
    return input.forward;
};

export { DEFAULT_TURN_IN, LOOK_PITCH, MAX_TURN_DEG_PER_SEC, VERTICAL, forwardOf, headingOf, limitTurnRate, lookAheadView, normalized, planTurns, turnBetween };
export type { LookAheadInput, StretchViews, TurnPlan };
