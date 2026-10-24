import assert from 'node:assert/strict';

import { registerCandidateEvents } from './.build/src/candidate-events.js';
import { Events } from './.build/src/events.js';
import { isovist, opennessOf } from './.build/src/candidates/isovist.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { candidateScore, PREFER_OPEN_WEIGHT } from './.build/src/candidates/score.js';

const VOXEL = 0.4;
const Y = 0.8;

// two points per sample on a line at height Y, from (x0, z0) to (x1, z1)
const line = (x0, z0, x1, z1) => {
    const out = [];
    const n = Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.05);
    for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n;
        const z = z0 + (z1 - z0) * i / n;
        out.push(x, Y, z, x, Y, z);
    }
    return out;
};

// 4 x 4 m room around the origin; a doorway of width `door` in the wall at z = -2
const room = (door = 0) => {
    const pts = [
        ...line(-2.1, 2.1, 2.1, 2.1),
        ...line(-2.1, -2.1, -2.1, 2.1),
        ...line(2.1, -2.1, 2.1, 2.1)
    ];
    pts.push(...line(-2.1, -2.1, -door / 2, -2.1), ...line(door / 2, -2.1, 2.1, -2.1));
    return buildOccupancy(new Float32Array(pts), VOXEL, 2);
};

const centre = { x: 0, y: Y, z: 0 };

const isovistChecks = {
    'isovist: rays in a closed 4 x 4 m room': () => {
        const rays = isovist(room(), centre, 16);
        assert.equal(rays.length, 72);
        for (const k of [0, 18, 36, 54]) assert.ok(Math.abs(rays[k] - 2) <= 0.25, `${k}: ${rays[k]}`);
        for (const k of [9, 27, 45, 63]) assert.ok(Math.abs(rays[k] - 2.83) <= 0.3, `${k}: ${rays[k]}`);
    },

    'isovist: free distance is capped at maxDist': () => {
        const rays = isovist(buildOccupancy(new Float32Array(0), VOXEL, 2), centre, 3);
        for (const r of rays) assert.ok(r <= 3 && r > 2.5);
    },

    'isovist: openness is higher out of a doorway than facing the near wall': () => {
        const rays = isovist(room(1.6), centre, 16);
        const out = opennessOf(rays, 16, 0, 40);
        const wallFacing = opennessOf(rays, 16, 180, 40);
        assert.ok(out > wallFacing + 0.1, `${out} vs ${wallFacing}`);
        for (const v of [out, wallFacing]) assert.ok(v >= 0 && v <= 1);
    },

    'isovist: openness treats azimuths past 360 and below 0 alike': () => {
        const rays = isovist(room(1.6), centre, 16);
        const base = opennessOf(rays, 16, 10, 40);
        assert.ok(Math.abs(opennessOf(rays, 16, 370, 40) - base) < 1e-9);
        assert.ok(Math.abs(opennessOf(rays, 16, -350, 40) - base) < 1e-9);
    },

    'isovist: candidateScore without openness is unchanged, with it adds the weighted term': () => {
        const m = { blur: 0.25, dark: 0.1 };
        assert.equal(candidateScore(m, 0), 0.75 - 0.2);
        assert.equal(candidateScore(m, 10), 0.75 - 0.2 - 0.15);
        assert.ok(Math.abs(candidateScore(m, 0, 0.5) - (0.55 + PREFER_OPEN_WEIGHT * 0.5)) < 1e-12);
    },

    'isovist: the prefer-open setting defaults off and resets on scene.clear': () => {
        const events = new Events();
        registerCandidateEvents(events, { getElementsByType: () => [] });
        assert.equal(events.invoke('candidates.preferOpen'), false);
        events.fire('candidates.setPreferOpen', true);
        assert.equal(events.invoke('candidates.preferOpen'), true);
        events.fire('scene.clear');
        assert.equal(events.invoke('candidates.preferOpen'), false);
    }
};

export { isovistChecks };
