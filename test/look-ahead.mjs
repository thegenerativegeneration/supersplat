import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { balanceTiming } from './.build/src/anim/balance-timing.js';
import { buildCameraCurve } from './.build/src/anim/camera-curve.js';
import { lookAheadView, planTurns } from './.build/src/anim/look-ahead.js';
import { CubicSpline } from './.build/src/anim/spline.js';
import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { planFixPath } from './.build/src/path/fix-plan.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';
import { sheet } from './nav-doors.mjs';

// Balance and Fix Path output recorded before look ahead existed (see its commit field)
const BASELINE = JSON.parse(readFileSync(new URL('./fixtures/look-ahead-baseline.json', import.meta.url), 'utf8'));

const DEG = Math.PI / 180;
const v3 = (x, y, z) => ({ x, y, z });
const unit = (v) => {
    const l = Math.hypot(v.x, v.y, v.z);
    return v3(v.x / l, v.y / l, v.z / l);
};
const angleDeg = (a, b) => {
    const ua = unit(a), ub = unit(b);
    return Math.acos(Math.min(1, Math.max(-1, ua.x * ub.x + ua.y * ub.y + ua.z * ub.z))) / DEG;
};
// unit direction in the xz plane at the given yaw (0 = +x, 90 = +z)
const yaw = deg => v3(Math.cos(deg * DEG), 0, Math.sin(deg * DEG));

// a key at p looking along dir
const key = (p, dir, extra = {}) => ({ position: v3(...p), target: v3(p[0] + dir.x, p[1] + dir.y, p[2] + dir.z), fov: 60, ...extra });

const newPose = () => ({ position: v3(0, 0, 0), target: v3(0, 0, 0), fov: 0 });
const viewAt = (curve, frame) => {
    const p = curve(frame, newPose());
    return v3(p.target.x - p.position.x, p.target.y - p.position.y, p.target.z - p.position.z);
};

const nearDeg = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);

// the rule on a straight stretch along +x from frame 0 to t1 at 30 fps
const ruleAt = (t, t1, prevView, keyView, prevTurnIn = 1.5, turnIn = 1.5) => {
    const views = { t0: 0, t1, frameRate: 30, prevView, keyView, prevTurnIn, turnIn };
    const plan = planTurns(views, () => yaw(0));
    return lookAheadView({ ...views, ...plan, t, forward: yaw(0) });
};

const plainSpline = (keys, frames, { duration, smoothness, loop }) => {
    const points = keys.flatMap(k => [k.position.x, k.position.y, k.position.z, k.target.x, k.target.y, k.target.z, k.fov]);
    return loop ?
        CubicSpline.fromPointsLooping(duration, frames, points, smoothness) :
        CubicSpline.fromPoints(frames, points, smoothness);
};

// the largest view turn between consecutive frames of [from, to], in degrees
const maxStep = (curve, from, to, step = 1) => {
    let worst = 0;
    let prev = viewAt(curve, from);
    for (let f = from + step; f <= to; f += step) {
        const cur = viewAt(curve, f);
        assert.ok([cur.x, cur.y, cur.z].every(Number.isFinite), `view at ${f} is not finite`);
        worst = Math.max(worst, angleDeg(prev, cur));
        prev = cur;
    }
    return worst;
};

const EYE = 1.6;
const DOOR_BOX = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };
// the room of the baseline: floor, ceiling at 2.8 and a wall at x = 10 with a door
const doorGrid = () => {
    const points = new Float32Array([
        ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
        ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]),
        ...sheet(0, 2.8, 0, 10, (y, z) => [10, y, z], (y, z) => z >= 5 - 1e-9 && z < 6.3 - 1e-9 && y < 2.1)
    ]);
    const { occ, levels } = buildSceneGrid(points, DOOR_BOX, EYE, NAV_HEAD_VOXELS);
    return buildNavGrid(occ, levels, DOOR_BOX, EYE, false);
};

const lookAheadChecks = {
    'look: without lookAhead the curve equals the plain spline at 50 frames'() {
        const keys = [
            key([0, 1, 0], yaw(30)),
            key([4, 2, 3], yaw(120), { lookAhead: false, turnIn: 3 }),
            key([9, 1, -2], yaw(200), { auto: true }),
            key([12, 3, 5], yaw(300))
        ];
        const frames = [0, 61, 117, 240];
        for (const loop of [false, true]) {
            const opts = { duration: 250, smoothness: 1, loop, frameRate: 30 };
            const curve = buildCameraCurve(keys, frames, opts);
            const spline = plainSpline(keys, frames, opts);
            for (let i = 0; i < 50; i++) {
                const frame = i * 5.1;
                const expected = [];
                spline.evaluate(frame, expected);
                const p = curve(frame, newPose());
                assert.deepEqual([p.position.x, p.position.y, p.position.z, p.target.x, p.target.y, p.target.z, p.fov], expected, `frame ${frame} loop ${loop}`);
            }
        }
    },

    'look: mid-stretch the view points along the tangent with 0.4 pitch'() {
        // two keys form a straight spline from (0, 0, 0) to (30, 6, 0); both views sideways
        const keys = [key([0, 0, 0], yaw(90)), key([30, 6, 0], yaw(-90), { lookAhead: true })];
        const opts = { duration: 400, smoothness: 1, loop: false, frameRate: 30 };
        const curve = buildCameraCurve(keys, [0, 360], opts);
        const view = unit(viewAt(curve, 180));
        const expected = unit(v3(30, 6 * 0.4, 0));
        for (const c of ['x', 'y', 'z']) nearDeg(view[c], expected[c], 1e-9, c);
        // the position stays the plain spline's
        const spline = plainSpline(keys, [0, 360], opts);
        const plain = [];
        spline.evaluate(180, plain);
        const p = curve(180, newPose());
        assert.deepEqual([p.position.x, p.position.y, p.position.z, p.fov], [plain[0], plain[1], plain[2], plain[6]]);
    },

    'look: at the key the view equals the key view; turn-in starts turnIn seconds before'() {
        // the key view is 10 degrees off the travel direction, well within a 2 s turn at the cap
        const keys = [key([0, 0, 0], yaw(0)), key([40, 0, 0], yaw(10), { lookAhead: true, turnIn: 2 })];
        const curve = buildCameraCurve(keys, [0, 400], { duration: 401, smoothness: 1, loop: false, frameRate: 30 });
        nearDeg(angleDeg(viewAt(curve, 400), yaw(10)), 0, 1e-6, 'at the key');
        nearDeg(angleDeg(viewAt(curve, 339), yaw(0)), 0, 1e-6, 'before the turn-in');
        assert.ok(angleDeg(viewAt(curve, 341), yaw(0)) > 0.01, 'turning just after the turn-in starts');
        nearDeg(angleDeg(viewAt(curve, 370), yaw(0)), 5, 1e-6, 'half way through the turn-in');
    },

    'look: a 90° turn-in stretches to 4.5 s at the cap'() {
        const keyView = yaw(90);
        nearDeg(angleDeg(ruleAt(165, 300, yaw(0), keyView), yaw(0)), 0, 1e-9, 'turn-in start');
        nearDeg(angleDeg(ruleAt(232.5, 300, yaw(0), keyView), yaw(0)), 45, 1e-9, 'half way');
        nearDeg(angleDeg(ruleAt(300, 300, yaw(0), keyView), keyView), 0, 1e-9, 'at the key');
        const view = ruleAt(200, 300, yaw(0), keyView);
        nearDeg(Math.hypot(view.x, view.y, view.z), 1, 1e-12, 'unit length');
    },

    'look: a short stretch scales both turns'() {
        // turn-out 1.5 s (a 10° turn), turn-in 4.5 s (90°): 6 s on a 3 s stretch become 0.75 s and 2.25 s
        const prevView = yaw(-10);
        const keyView = yaw(90);
        nearDeg(angleDeg(ruleAt(11.25, 90, prevView, keyView), prevView), 5, 1e-9, 'half way through the turn-out');
        nearDeg(angleDeg(ruleAt(22.5, 90, prevView, keyView), yaw(0)), 0, 1e-9, 'forward between the turns');
        nearDeg(angleDeg(ruleAt(56.25, 90, prevView, keyView), yaw(0)), 45, 1e-9, 'half way through the turn-in');
    },

    'look: detour views on a look-ahead stretch are ignored'() {
        const opts = { duration: 400, smoothness: 1, loop: false, frameRate: 30 };
        const frames = [0, 100, 200, 300];
        const withDetour = target => [
            key([0, 0, 0], yaw(0)),
            key([10, 0, 0], yaw(45)),
            { ...key([20, 0, 3], target), auto: true },
            key([30, 0, 0], yaw(0), { lookAhead: true })
        ];
        const a = buildCameraCurve(withDetour(yaw(180)), frames, opts);
        const b = buildCameraCurve(withDetour(v3(0, 1, 0)), frames, opts);
        for (let f = 101; f <= 300; f += 7) {
            assert.deepEqual(viewAt(a, f), viewAt(b, f), `frame ${f}`);
        }
        assert.ok(angleDeg(viewAt(a, 200), yaw(180)) > 90, 'the detour view is not used');
        // the stretch starts at the previous user key: before it the plain spline plays
        const spline = plainSpline(withDetour(yaw(180)), frames, opts);
        for (let f = 0; f <= 100; f += 10) {
            const plain = [];
            spline.evaluate(f, plain);
            const p = a(f, newPose());
            assert.deepEqual([p.target.x, p.target.y, p.target.z], plain.slice(3, 6), `frame ${f}`);
        }
    },

    'look: first key, last key, loop and after a parked key don\'t throw or flip'() {
        const ring = [
            key([0, 0, 0], yaw(0), { lookAhead: true }),
            key([20, 0, 0], yaw(90)),
            key([20, 0, 20], yaw(180), { lookAhead: true, turnIn: 0.5 }),
            key([0, 0, 20], yaw(270), { lookAhead: true })
        ];
        const frames = [0, 150, 300, 450];
        // non-loop: no stretch arrives at the first key; the last key ends on its own view
        const open = buildCameraCurve(ring, frames, { duration: 600, smoothness: 1, loop: false, frameRate: 30 });
        nearDeg(angleDeg(viewAt(open, 0), yaw(0)), 0, 1e-9, 'first key');
        nearDeg(angleDeg(viewAt(open, 450), yaw(270)), 0, 1e-6, 'last key');
        nearDeg(angleDeg(viewAt(open, 550), yaw(270)), 0, 1e-6, 'after the last key');
        assert.ok(maxStep(open, 0, 599) < 3, 'open curve turns smoothly');

        // loop: the stretch into the first key comes from the last user key across the wrap
        const loop = buildCameraCurve(ring, frames, { duration: 600, smoothness: 1, loop: true, frameRate: 30 });
        nearDeg(angleDeg(viewAt(loop, 0), yaw(0)), 0, 1e-6, 'first key in a loop');
        nearDeg(angleDeg(viewAt(loop, 600), yaw(0)), 0, 1e-6, 'loop end');
        assert.ok(maxStep(loop, 0, 600, 0.5) < 3, 'loop turns smoothly');

        // a single user key on a circle of detours owns the whole loop
        const circle = [0, 72, 144, 216, 288].map((a, i) => key([10 * Math.cos(a * DEG), 0, 10 * Math.sin(a * DEG)], yaw(i ? 180 : 90), i ? { auto: true } : { lookAhead: true }));
        const lone = buildCameraCurve(circle, [0, 120, 240, 360, 480], { duration: 600, smoothness: 1, loop: true, frameRate: 30 });
        assert.ok(maxStep(lone, 0, 600) < 3, 'lone key loop turns smoothly');
        nearDeg(angleDeg(viewAt(lone, 0), yaw(90)), 0, 1e-6, 'lone key');

        // a parked key (at or after the end) changes nothing, look ahead or not
        const opts = { duration: 460, smoothness: 1, loop: false, frameRate: 30 };
        const shot = buildCameraCurve(ring, frames, opts);
        const parked = buildCameraCurve([...ring, key([5, 0, 5], yaw(45), { lookAhead: true, parked: true })], [...frames, 470], opts);
        for (let f = 0; f <= 460; f += 9) assert.deepEqual(viewAt(parked, f), viewAt(shot, f), `frame ${f}`);

        // a stretch without travel (both keys at one spot) still turns without NaN
        const still = buildCameraCurve([key([0, 0, 0], yaw(0)), key([0, 0, 0], yaw(90), { lookAhead: true })], [0, 90], opts);
        assert.ok(maxStep(still, 0, 90) < 3, 'turning on the spot');
        nearDeg(angleDeg(viewAt(still, 90), yaw(90)), 0, 1e-6, 'standing key');
    },

    'look: no frame turns faster than the cap on the triangle of detours or the courtyard'() {
        const perFrame = 20 / 30 * 1.05;
        // one look-ahead key on a triangle of detours: the travel sweeps across the opposite of
        // its view during the turn-in, at the frames that once flipped the view
        const triangle = [
            { ...key([0, 0, 0], yaw(0), { lookAhead: true }), linger: 0, distance: 5 },
            { ...key([20, 0, 0], yaw(90), { auto: true }), linger: 0, distance: 5 },
            { ...key([20, 0, 20], yaw(180), { auto: true }), linger: 0, distance: 5 }
        ];
        const fixed = buildCameraCurve(triangle, [0, 200, 400], { duration: 600, smoothness: 1, loop: true, frameRate: 30 });
        const fixedStep = maxStep(fixed, 0, 600, 0.25) * 4;
        assert.ok(fixedStep <= perFrame, `triangle at fixed frames: ${fixedStep}° per frame`);

        const settings = { frameRate: 30, smoothness: 1, rotationWeight: 1, maxTurnDegPerSec: 20 };
        const cases = [
            ['triangle', triangle, { ...settings, frames: 600, loop: true }],
            ['courtyard', BASELINE.balance[0].input.keys.map(k => ({ ...k, lookAhead: true })), { ...settings, frames: 1800, loop: false }]
        ];
        for (const [name, keys, timing] of cases) {
            const result = balanceTiming({ ...timing, keys });
            assert.equal(result.turnLimited, undefined, name);
            const curve = buildCameraCurve(keys, result.frames, { duration: timing.frames, smoothness: 1, loop: timing.loop, frameRate: 30 });
            const step = maxStep(curve, 0, timing.loop ? timing.frames : timing.frames - 1, 0.25) * 4;
            assert.ok(step <= perFrame, `${name}: ${step}° per frame`);
        }
    },

    'look: vertical travel keeps a heading and never looks straight up'() {
        const opts = { duration: 400, smoothness: 1, loop: false, frameRate: 30 };
        // straight up with no level travel on the stretch: the key view's heading
        const lift = buildCameraCurve([key([0, 0, 0], yaw(30)), key([0, 10, 0], yaw(30), { lookAhead: true })], [0, 300], opts);
        const mid = unit(viewAt(lift, 150));
        nearDeg(Math.atan2(mid.z, mid.x) / DEG, 30, 1e-6, 'heading');
        assert.ok(mid.y > 0.5 && mid.y < 0.98, `pitch y ${mid.y}`);

        // level travel along +x, then a climb whose spline overshoots back in x
        const climb = buildCameraCurve([
            key([0, 0, 0], yaw(0)),
            { ...key([10, 0, 0], yaw(0)), auto: true },
            { ...key([10, 12, 0], yaw(90)), auto: true },
            key([10, 24, 0], yaw(180), { lookAhead: true })
        ], [0, 100, 200, 399], opts);
        for (let f = 0; f <= 399; f += 0.5) {
            const v = unit(viewAt(climb, f));
            assert.ok(Math.abs(v.y) < 0.98, `frame ${f}: y ${v.y}`);
        }
        assert.ok(maxStep(climb, 0, 399, 0.25) * 4 <= 20 / 30 * 1.05, 'the climb turns within the cap');
    },

    'balance: results identical without lookAhead for the courtyard 7-key set'() {
        for (const { name, input, result } of BASELINE.balance) {
            assert.deepEqual(balanceTiming(input), result, name);
            const flagged = { ...input, keys: input.keys.map(k => ({ ...k, lookAhead: false, turnIn: 3 })) };
            assert.deepEqual(balanceTiming(flagged), result, `${name}, lookAhead false`);
        }
    },

    'fix path: results identical without lookAhead for the door room'() {
        const grid = doorGrid();
        for (const { name, keys, keepOrder, timeline, result } of BASELINE.fixPath) {
            const plan = planFixPath({ keys, grid, eyeHeight: EYE, keepOrder, timeline });
            const actual = {
                poses: plan.poses.map(p => ({ pose: p.pose, frame: p.frame, key: p.key?.name ?? null })),
                detours: plan.detours,
                blocked: plan.blocked,
                unreachable: plan.unreachable,
                balance: plan.balance
            };
            assert.deepEqual(JSON.parse(JSON.stringify(actual)), result, name);
        }
        // the retime inside Fix Path times with look ahead when a key has it
        const { keys, keepOrder, timeline, result } = BASELINE.fixPath[0];
        const flagged = keys.map(k => (k.name === 'b' ? { ...k, lookAhead: true } : k));
        const plan = planFixPath({ keys: flagged, grid, eyeHeight: EYE, keepOrder, timeline });
        assert.notDeepEqual(plan.balance.frames, result.balance.frames);
    },

    'balance: a look-ahead stretch\'s peak turn stays ≤ 20°/s + tolerance'() {
        // along +x; the middle key looks sideways and the last one looks back the other way, so the
        // look-ahead stretch turns 90° out and 90° in: at least 9 s at 20°/s
        const keys = [
            { ...key([0, 0, 0], yaw(0)), linger: 0, distance: 5 },
            { ...key([8, 0, 0], yaw(90)), linger: 0, distance: 5 },
            { ...key([16, 0, 0], yaw(-90), { lookAhead: true }), linger: 0, distance: 5 }
        ];
        const settings = { frames: 600, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1, maxTurnDegPerSec: 20 };
        const result = balanceTiming({ ...settings, keys });
        assert.equal(result.ok, true);
        assert.equal(result.turnLimited, undefined);
        assert.ok(result.stats.peakTurnDegPerSec <= 20 * 1.05, `stats peak ${result.stats.peakTurnDegPerSec}`);
        assert.ok(result.frames[2] - result.frames[1] >= 9 * 30, `stretch ${result.frames}`);

        // sampled independently through the curve the editor plays
        const curve = buildCameraCurve(keys, result.frames, { duration: 600, smoothness: 1, loop: false, frameRate: 30 });
        const step = 0.25;
        const peak = maxStep(curve, 0, 599, step) * 30 / step;
        assert.ok(peak <= 20 * 1.05, `curve peak ${peak}`);
    }
};

export { lookAheadChecks };
