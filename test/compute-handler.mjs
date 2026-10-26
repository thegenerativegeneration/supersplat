import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { createComputeHandler } from './.build/src/compute/handler.js';
import { boxAroundKeys } from './.build/src/fix-path-events.js';
import { planFixPath } from './.build/src/path/fix-plan.js';
import { buildNavGrid, navHeadVoxels } from './.build/src/path/nav-grid.js';
import { bandRoom } from './nav-doors.mjs';
import { BOX, EYE, FAR, SPEC } from './orbit-events.mjs';

// orbit.plan results for the FAR scene, recorded before the plan moved into the compute job
const ORBIT_FAR = JSON.parse(readFileSync(new URL('./fixtures/orbit-plan-far.json', import.meta.url), 'utf8'));

// the band room of nav-doors at twice the size, with the keys of
// fix-path-events' "the smallest opening reaches the scene grid"
const BAND = {
    points: bandRoom(1.6, 2.4).map(v => v * 2),
    box: { min: { x: -2, y: -2, z: -2 }, max: { x: 42, y: 12, z: 22 } },
    eyeHeight: 3.2,
    opening: 1.6
};
const fixKey = (name, x, z) => ({
    position: { x, y: 4, z },
    target: { x, y: 4, z: z - 1 },
    fov: 60,
    name,
    linger: 0,
    distance: 1,
    orbit: undefined
});
const KEYS = [fixKey('a', 6, 10.8), fixKey('b', 34, 10.8)];
const TIMELINE = { frames: 181, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1, maxTurnDegPerSec: 20 };

const fixRequest = (version = 1) => ({
    version,
    box: BAND.box,
    eyeHeight: BAND.eyeHeight,
    opening: BAND.opening,
    allowFlying: true,
    positions: KEYS.map(k => k.position),
    keys: KEYS,
    keepOrder: false,
    timeline: TIMELINE
});

// a handler whose messages cross a structured clone both ways, like postMessage
const connect = () => {
    const handle = createComputeHandler();
    const replies = [];
    let id = 0;
    const send = (op, args) => {
        const req = structuredClone({ id: ++id, op, args });
        handle(req, reply => replies.push(structuredClone(reply)));
        return req.id;
    };
    const of = n => replies.filter(r => r.id === n);
    const result = (n) => {
        const done = of(n).filter(r => !('progress' in r));
        assert.equal(done.length, 1, `one final reply for ${n}`);
        assert.ok('result' in done[0], `request ${n} failed: ${done[0].error}`);
        return done[0].result;
    };
    const stages = n => of(n).filter(r => 'progress' in r).map(r => r.progress);
    return { send, of, result, stages };
};

const sendBand = (c, version = 1) => c.send('points', { version, points: BAND.points, extents: undefined });

const summaryOf = plan => ({
    poses: plan.poses.map(p => [p.keyIndex, p.frame, p.pose.position]),
    blocked: plan.blocked,
    unreachable: plan.unreachable,
    detours: plan.detours
});

const computeHandlerChecks = {
    'compute: fixPlan through the handler equals planFixPath on the same grid'() {
        const c = connect();
        sendBand(c);
        const reply = c.result(c.send('fixPlan', fixRequest()));

        const { points, box, eyeHeight, opening } = BAND;
        const { occ, levels } = buildSceneGrid(points, boxAroundKeys(box, KEYS.map(k => k.position), eyeHeight), eyeHeight, navHeadVoxels(eyeHeight, opening));
        const grid = buildNavGrid(occ, levels, box, eyeHeight, true, opening);
        const keys = structuredClone(KEYS);
        const plan = planFixPath({ keys, grid, eyeHeight, keepOrder: false, timeline: TIMELINE });
        const direct = { ...plan, poses: plan.poses.map(p => ({ ...p, keyIndex: p.key ? keys.indexOf(p.key) : null })) };

        assert.ok(reply.poses.length >= 2, `${reply.poses.length} poses`);
        assert.deepEqual(summaryOf(reply), summaryOf(direct));
        assert.deepEqual(reply.box, box);
    },

    'compute: a second fixPlan with the same request reuses the grid'() {
        const c = connect();
        sendBand(c);
        const grids = n => c.stages(n).filter(s => s.stage === 'grid').length;
        const first = c.send('fixPlan', fixRequest());
        const second = c.send('fixPlan', fixRequest());
        assert.ok(grids(first) > 0, 'the first run builds the grid');
        assert.equal(grids(second), 0, 'the second run reuses it');
        assert.deepEqual(summaryOf(c.result(second)), summaryOf(c.result(first)));
    },

    'compute: caches belong to one handler and go with its points'() {
        // the same points object, so only the cache owner and clearing decide
        // builds of the walkable grid (fixPlan) or the orbit's scene map
        const grids = (handle, id, op, args) => {
            const posts = [];
            handle({ id, op, args }, reply => posts.push(reply));
            const stage = op === 'orbitPlan' ? 'scene' : 'grid';
            if (op === 'orbitPlan') assert.ok(!posts.some(r => r.progress?.stage === 'grid'), 'an orbit builds no walkable grid');
            return posts.filter(r => r.progress?.stage === stage).length;
        };
        const points = { version: 1, points: BAND.points, extents: undefined };
        const a = createComputeHandler(), b = createComputeHandler();
        grids(a, 1, 'points', points);
        grids(b, 1, 'points', points);
        assert.equal(grids(a, 2, 'fixPlan', fixRequest()), 1, 'a builds its grid');
        assert.equal(grids(a, 3, 'fixPlan', fixRequest()), 0, 'a reuses it');
        assert.equal(grids(b, 2, 'fixPlan', fixRequest()), 1, 'b builds its own');
        const orbit = { version: 1, box: BAND.box, eyeHeight: BAND.eyeHeight, spec: SPEC };
        assert.equal(grids(a, 4, 'orbitPlan', orbit), 1, 'a builds its occupancy');
        assert.equal(grids(a, 5, 'orbitPlan', orbit), 0, 'a reuses it');
        grids(a, 6, 'points', points);
        assert.equal(grids(a, 7, 'fixPlan', fixRequest()), 1, 'a points request drops the grid');
        assert.equal(grids(a, 8, 'orbitPlan', orbit), 1, 'and the occupancy');
    },

    'compute: progress arrives in stage order and ends at total'() {
        const c = connect();
        sendBand(c, 7);
        const n = c.send('fixPlan', fixRequest(7));
        c.result(n);
        const progress = c.stages(n);
        const order = ['grid', 'routes', 'detours'];
        const seen = progress.map(p => p.stage).filter((s, i, all) => i === 0 || s !== all[i - 1]);
        assert.deepEqual(seen, order.filter(s => seen.includes(s)), `stages ${seen}`);
        assert.ok(seen.includes('routes'), 'routes reported');
        const routes = progress.filter(p => p.stage === 'routes');
        const last = routes[routes.length - 1];
        assert.equal(last.done, last.total);
        assert.ok(last.total > 0);
    },

    'compute: an unknown points version and a throwing job reply with error'() {
        const c = connect();
        sendBand(c, 1);
        for (const n of [c.send('fixPlan', fixRequest(2)), c.send('balance', null)]) {
            const replies = c.of(n);
            assert.equal(replies.length, 1, `replies for ${n}: ${JSON.stringify(replies)}`);
            assert.deepEqual(Object.keys(replies[0]).sort(), ['error', 'id']);
            assert.equal(typeof replies[0].error, 'string');
            assert.ok(replies[0].error.length > 0);
        }
    },

    'compute: orbitPlan equals the old orbit.plan for the FAR scene'() {
        const c = connect();
        c.send('points', { version: 3, points: new Float32Array(FAR), extents: undefined });
        const plan = spec => c.result(c.send('orbitPlan', { version: 3, box: BOX, eyeHeight: EYE, spec }));
        // JSON drops the sign of zero, as the recording did
        const recorded = p => JSON.parse(JSON.stringify(p));
        assert.deepEqual(recorded(plan(SPEC)), ORBIT_FAR.free);
        assert.deepEqual(recorded(plan({ ...SPEC, radius: 1e9 })), ORBIT_FAR.capped);
        assert.deepEqual(recorded(plan({ ...SPEC, centre: { x: 25, y: 0, z: 0 } })), ORBIT_FAR.outside);
    }
};

export { BAND, computeHandlerChecks, fixRequest };
