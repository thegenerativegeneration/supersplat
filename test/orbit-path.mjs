import assert from 'node:assert/strict';

import { buildOccupancy } from './.build/src/candidates/occupancy.js';
import { arcBlocked, clampSpan, DEG_PER_KEY, fitRadius, MIN_RADIUS, orbitDefaults, orbitKeys } from './.build/src/orbit/orbit-path.js';

const C = { x: 10.5, y: 5.5, z: 10.5 };
const spec = (over = {}) => ({ centre: C, radius: 4, height: 1, startDeg: 30, spanDeg: 360, dir: 1, fov: 55, ...over });
const horizontal = (k, c = C) => ({ x: k.position.x - c.x, z: k.position.z - c.z });

// occupied cells from points (one point per cell is enough with minCount 1)
const sceneOf = (points, voxel = 1) => buildOccupancy(new Float32Array(points.flat()), voxel, 1).occupied;
const ring = (r0, r1, y) => {
    const pts = [];
    for (let r = r0; r <= r1; r += 0.25) {
        for (let a = 0; a < 360; a += 2) pts.push([C.x + r * Math.cos(a * Math.PI / 180), y, C.z + r * Math.sin(a * Math.PI / 180)]);
    }
    return pts;
};

const orbitPathChecks = {
    'orbit path: a full turn has 17 keys on the circle, closed, aimed at the centre'() {
        const keys = orbitKeys(spec());
        assert.equal(keys.length, 17);
        assert.deepEqual(keys[0].position, keys[16].position);
        for (const k of keys) {
            const h = horizontal(k);
            assert.ok(Math.abs(Math.hypot(h.x, h.z) - 4) < 1e-9);
            assert.ok(Math.abs(k.position.y - (C.y + 1)) < 1e-9);
            assert.deepEqual(k.target, C);
            assert.equal(k.fov, 55);
        }
        const h0 = horizontal(keys[0]);
        assert.ok(Math.abs(Math.atan2(h0.z, h0.x) * 180 / Math.PI - 30) < 1e-9);
    },

    'orbit path: 90 degrees gives 5 keys and the span is left open'() {
        const keys = orbitKeys(spec({ spanDeg: 90 }));
        assert.equal(keys.length, 5);
        assert.notDeepEqual(keys[0].position, keys[4].position);
    },

    'orbit path: direction 1 turns counter-clockwise seen from +y, -1 clockwise'() {
        for (const dir of [1, -1]) {
            const keys = orbitKeys(spec({ dir }));
            for (let i = 0; i < 16; i++) {
                const a = horizontal(keys[i]);
                const b = horizontal(keys[i + 1]);
                const crossY = a.z * b.x - a.x * b.z;
                assert.equal(Math.sign(crossY), dir);
                const step = Math.acos((a.x * b.x + a.z * b.z) / 16) * 180 / Math.PI;
                assert.ok(Math.abs(step - DEG_PER_KEY) < 1e-6);
            }
        }
    },

    'orbit path: clampSpan rounds to 22.5 and clamps to 90..360'() {
        assert.equal(clampSpan(100), 90);
        assert.equal(clampSpan(400), 360);
        assert.equal(clampSpan(10), 90);
        assert.equal(clampSpan(NaN), 360);
        assert.equal(clampSpan(115), 112.5);
        assert.equal(orbitKeys(spec({ spanDeg: 100 })).length, 5);
        assert.equal(orbitKeys(spec({ spanDeg: 0 })).length, 5);
    },

    'orbit path: defaults use the horizontal distance and height of the camera'() {
        const d = orbitDefaults(C, { x: C.x, y: C.y + 2, z: C.z + 3 }, 0.4);
        assert.ok(Math.abs(d.radius - 3) < 1e-9);
        assert.ok(Math.abs(d.height - 2) < 1e-9);
        assert.ok(Math.abs(d.startDeg - 90) < 1e-9);
    },

    'orbit path: a focal point at the camera gives the minimum radius and finite keys'() {
        const d = orbitDefaults(C, { ...C }, 0.4);
        assert.ok(Math.abs(d.radius - MIN_RADIUS * 0.4) < 1e-12);
        assert.equal(d.height, 0);
        const keys = orbitKeys({ centre: C, ...d, spanDeg: 360, dir: 1, fov: 60 });
        for (const k of keys) assert.ok([k.position.x, k.position.y, k.position.z].every(Number.isFinite));
    },

    'orbit path: a pillar on the circle blocks the arc around its azimuth'() {
        const s = spec({ startDeg: 0 });
        const occupied = sceneOf([[C.x, C.y + 1, C.z + 4]]);
        const free = arcBlocked(sceneOf([[C.x, C.y + 1, C.z - 8]]), 1, s);
        assert.equal(free.blocked, false);
        assert.deepEqual(free.ranges, []);
        const { blocked, ranges } = arcBlocked(occupied, 1, s);
        assert.equal(blocked, true);
        assert.equal(ranges.length, 1);
        const [lo, hi] = ranges[0];
        assert.ok(Math.floor((hi - 90) / 360) * 360 + 90 >= lo, 'range covers azimuth 90 (mod 360)');
        assert.ok(ranges[0][1] - ranges[0][0] < 40);
    },

    'orbit path: a blocked run across the start azimuth of a full turn is one range'() {
        const occupied = sceneOf([[C.x + 4, C.y + 1, C.z]]);
        const { ranges } = arcBlocked(occupied, 1, spec({ startDeg: 0 }));
        assert.equal(ranges.length, 1);
        assert.ok(ranges[0][1] - ranges[0][0] > 0 && ranges[0][1] - ranges[0][0] < 40);
    },

    'orbit path: fitRadius shrinks in front of a wall and returns null in a tiny closed box'() {
        const wall = sceneOf(ring(3, 3.5, C.y + 1));
        const s = spec({ radius: 3.2 });
        assert.equal(arcBlocked(wall, 1, s).blocked, true);
        const fit = fitRadius(wall, 1, s);
        assert.ok(fit.reduced && fit.radius < 3.2 && fit.radius >= MIN_RADIUS * 1);
        assert.equal(arcBlocked(wall, 1, { ...s, radius: fit.radius }).blocked, false);
        assert.deepEqual(fitRadius(sceneOf([]), 1, s), { radius: 3.2, reduced: false });

        // the step sequence 1.4, 0.9 skips 1.0, which must still be tried
        const edge = spec({ radius: 1.4, startDeg: 0, centre: { ...C, x: 10.9 } });
        const near = sceneOf([[12.3, C.y + 1, C.z]]);
        assert.equal(arcBlocked(near, 1, edge).blocked, true);
        assert.deepEqual(fitRadius(near, 1, edge), { radius: 1, reduced: true });

        const cell = [Math.floor(C.x), Math.floor(C.y + 1), Math.floor(C.z)];
        const shell = [];
        for (let n = 0; n < 27; n++) {
            const [x, y, z] = [n % 3 - 1, Math.floor(n / 3) % 3 - 1, Math.floor(n / 9) - 1];
            if (x || y || z) shell.push([cell[0] + x + 0.5, cell[1] + y + 0.5, cell[2] + z + 0.5]);
        }
        assert.equal(fitRadius(sceneOf(shell), 1, spec({ radius: 2, height: 1 })), null);
    }
};

export { orbitPathChecks };
