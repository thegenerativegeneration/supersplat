import assert from 'node:assert/strict';

import { registerCandidateEvents } from './.build/src/candidate-events.js';
import { runGeneration } from './.build/src/candidates/generate.js';
import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { mulberry32, sampleCandidates } from './.build/src/candidates/sample.js';
import { wallAngle } from './.build/src/candidates/walls.js';
import { Events } from './.build/src/events.js';

const ALL = () => true;
const BIG_BOX = { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } };

// quaternion of a rotation by deg about +y
const yaw = (deg) => {
    const h = deg * Math.PI / 360;
    return [0, Math.sin(h), 0, Math.cos(h)];
};

// a flat splat (thin along its own x axis) whose normal has the given azimuth
// in the sample.ts convention: normal (sin a, 0, -cos a). A yaw of 90° - a
// turns the splat's x axis (1, 0, 0) onto that normal.
const wallSplat = azimuth => [0.01, 0.2, 0.2, ...yaw(90 - azimuth)];

// uniformly random rotation (Shoemake)
const randomQuat = (rand) => {
    const u1 = rand(), u2 = rand() * 2 * Math.PI, u3 = rand() * 2 * Math.PI;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
};

// four walls of a room turned by `turn` degrees, perWall splats each with
// ±0.5° jitter, at y in [0.2, 2.2]
const room = (turn, perWall, rand) => {
    const points = [];
    const extents = [];
    for (let w = 0; w < 4; w++) {
        for (let i = 0; i < perWall; i++) {
            points.push(w + rand(), 0.2 + 2 * rand(), rand());
            extents.push(...wallSplat(turn + 90 * w + (rand() - 0.5)));
        }
    }
    return { points, extents };
};

const pack = ({ points, extents }) => ({ points: new Float32Array(points), extents: new Float32Array(extents) });

// distance on the 90° circle
const off90 = (a, b) => Math.abs((((a - b + 45) % 90) + 90) % 90 - 45);

const walls23 = (seed) => {
    const rand = mulberry32(seed);
    const r = room(23, 50, rand);
    return { r, rand };
};

const wallsChecks = {
    'walls: a room turned 23° gives a wall angle within 1° of 23': async () => {
        const { points, extents } = pack(walls23(1).r);
        const angle = wallAngle(points, extents, ALL);
        assert.ok(angle !== null && off90(angle, 23) <= 1, `${angle}`);
    },

    'walls: 30% randomly oriented flat splats keep the angle within 2°': async () => {
        const { r, rand } = walls23(2);
        const noise = Math.round(0.3 / 0.7 * r.points.length / 3);
        for (let i = 0; i < noise; i++) {
            r.points.push(rand() * 4, 2 * rand(), rand());
            r.extents.push(0.01, 0.2, 0.2, ...randomQuat(rand));
        }
        const { points, extents } = pack(r);
        const angle = wallAngle(points, extents, ALL);
        assert.ok(angle !== null && off90(angle, 23) <= 2, `${angle}`);
    },

    'walls: floor splats only give no wall angle': async () => {
        const points = [];
        const extents = [];
        for (let i = 0; i < 400; i++) {
            points.push(i % 20, 0, Math.floor(i / 20));
            extents.push(0.2, 0.01, 0.2, 0, 0, 0, 1);
        }
        assert.equal(wallAngle(new Float32Array(points), new Float32Array(extents), ALL), null);
    },

    'walls: fewer than 50 wall splats or splats outside select give no angle': async () => {
        const rand = mulberry32(3);
        const few = pack(room(23, 12, rand));
        assert.equal(wallAngle(few.points, few.extents, ALL), null);
        const { points, extents } = pack(walls23(4).r);
        assert.equal(wallAngle(points, extents, (x, y) => y > 5), null);
    },

    'walls: no angle when every bin is kept or the result has under 25% support': async () => {
        const of = (azimuthAt, n) => {
            const points = [];
            const extents = [];
            for (let i = 0; i < n; i++) {
                points.push(0, 1, 0);
                extents.push(...wallSplat(azimuthAt(i)));
            }
            return [new Float32Array(points), new Float32Array(extents)];
        };
        assert.equal(wallAngle(...of(i => i / 10, 900), ALL), null);
        // five equal directions 18° apart: the best holds a fifth of the weight
        assert.equal(wallAngle(...of(i => 5 + 18 * (i % 5), 500), ALL), null);
        assert.ok(off90(wallAngle(...of(i => (i % 4 ? 23 : 5 + 18 * (i % 5)), 500), ALL), 23) < 1);
    },

    'walls: the align setting defaults off and resets on scene.clear': async () => {
        const events = new Events();
        registerCandidateEvents(events, { getElementsByType: () => [] });
        assert.equal(events.invoke('candidates.alignToWalls'), false);
        events.fire('candidates.setAlignToWalls', true);
        assert.equal(events.invoke('candidates.alignToWalls'), true);
        events.fire('scene.clear');
        assert.equal(events.invoke('candidates.alignToWalls'), false);
    },

    'walls: azimuths per level pass through sampleCandidates': async () => {
        const cells = [];
        for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) cells.push([x, 0, z]);
        const levels = [{ cells, area: 36, height: 0.2 }, { cells: cells.map(([x, , z]) => [x, 10, z]), area: 20, height: 4.2 }];
        const occ = buildOccupancy(new Float32Array(0), 0.4);
        const azimuthsOf = level => (level === 0 ? [23, 113] : [7]);
        const out = sampleCandidates(levels, occ, { eyeHeight: 1.6, box: BIG_BOX, fov: 60, budget: 40, seed: 1 }, azimuthsOf);
        assert.ok(out.some(c => c.level === 0) && out.some(c => c.level === 1));
        for (const c of out) {
            assert.ok(azimuthsOf(c.level).includes(c.azimuth), `${c.level}: ${c.azimuth}`);
            const az = Math.atan2(c.direction.x, -c.direction.z) * 180 / Math.PI;
            assert.ok(Math.abs((((az - c.azimuth) % 360) + 540) % 360 - 180) < 1e-6);
        }
        assert.deepEqual(new Set(out.filter(c => c.level === 0).map(c => c.azimuth)), new Set([23, 113]));
    },

    'walls: generation aligns azimuths to the walls only when asked': async () => {
        const points = [];
        const extents = [];
        for (let x = 0; x < 10; x += 0.2) {
            for (let z = 0; z < 10; z += 0.2) {
                points.push(x, 0, z, x, 0, z);
                extents.push(0.01, 0.01, 0.01, 0, 0, 0, 1, 0.01, 0.01, 0.01, 0, 0, 0, 1);
            }
        }
        // a wall at x = 10 just past the floor, its splats turned 23°
        const rand = mulberry32(5);
        for (let i = 0; i < 200; i++) {
            points.push(10.2, 0.4 + 2 * rand(), 10 * rand());
            extents.push(...wallSplat(23 + 90 * (i % 4)));
        }
        const pts = new Float32Array(points);
        const ext = new Float32Array(extents);
        const run = async (alignToWalls) => {
            const rendered = [];
            const deps = {
                sampleDistances: async cands => cands.map(() => 5),
                renderAt: async (cand) => {
                    rendered.push(cand);
                    return { rgba: new Uint8Array(320 * 200 * 4).fill(128), thumbnail: null };
                },
                restore: () => {},
                onProgress: () => {},
                onAdded: () => {},
                onLevels: () => {}
            };
            const opts = { box: BIG_BOX, eyeHeight: 1.6, budget: 24, seed: 1, fov: 60, alignToWalls };
            await runGeneration(deps, pts, opts, new AbortController().signal, ext);
            return rendered;
        };
        const aligned = await run(true);
        assert.ok(aligned.length > 0);
        const off45 = a => Math.abs((((a - 23 + 22.5) % 45) + 45) % 45 - 22.5);
        for (const c of aligned) assert.ok(off45(c.azimuth) < 1, `${c.azimuth}`);
        const fixed = await run(false);
        for (const c of fixed) assert.equal(c.azimuth % 45, 0);
    }
};

export { wallsChecks };
