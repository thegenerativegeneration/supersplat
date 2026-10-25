import assert from 'node:assert/strict';

import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { orbitBlocks } from './.build/src/path/blocks.js';
import { planDetours } from './.build/src/path/detours.js';
import { planFixPath } from './.build/src/path/fix-plan.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';
import { sheet } from './nav-doors.mjs';

const EYE = 1.6;
const BOX = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };
const TIMELINE = { frames: 900, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1 };

// floor and ceiling at 2.8 over 20 x 10 m, with a closed wall at x = 10 when walled
const gridOf = (walled) => {
    const points = new Float32Array([
        ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
        ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]),
        ...(walled ? sheet(0, 2.8, 0, 10, (y, z) => [10, y, z]) : [])
    ]);
    const { occ, levels } = buildSceneGrid(points, BOX, EYE, NAV_HEAD_VOXELS);
    return buildNavGrid(occ, levels, BOX, EYE, false);
};

const key = (name, x, z, t) => ({ name, position: { x, y: 1.6, z }, target: { x: t[0], y: 1.6, z: t[1] }, fov: 60, linger: 0, distance: 5 });

// keys every 22.5 degrees around (cx, cz), from the start angle (degrees,
// 0 along +x) over the span, looking at the centre
const orbit = (id, cx, cz, radius, start, span) => Array.from({ length: span / 22.5 + 1 }, (_, i) => {
    const a = (start + i * 22.5) * Math.PI / 180;
    return { ...key(`${id}${i}`, cx + radius * Math.cos(a), cz + radius * Math.sin(a), [cx, cz]), orbit: id };
});

const plan = (keys, { walled = false, keepOrder = false } = {}) => planFixPath({ keys, grid: gridOf(walled), eyeHeight: EYE, keepOrder, timeline: TIMELINE });

// names of the planned poses, '-' for a detour
const namesOf = result => result.poses.map(p => p.key?.name ?? '-');

// the names appear in the plan as one run, in this order
const assertIntact = (result, names) => {
    const all = namesOf(result);
    const at = all.indexOf(names[0]);
    assert.ok(at >= 0, `${names[0]} missing in ${all.join(' ')}`);
    assert.deepEqual(all.slice(at, at + names.length), names, all.join(' '));
};

const fixPathOrbitChecks = {
    'path: blocks are runs of keys with one orbit id'() {
        const k = orbit => ({ orbit });
        assert.deepEqual(orbitBlocks([k(), k('a'), k('a'), k(), k('a'), k('b'), k('b')]), [[0], [1, 2], [3], [4], [5, 6]]);
        assert.deepEqual(orbitBlocks([]), []);
    },

    'path: Fix Path keeps an orbit together and enters it at its first key'() {
        const ring = orbit('o', 10, 5, 2, 180, 360);
        const result = plan([key('a', 2, 5, [0, 5]), key('b', 18, 5, [20, 5]), ...ring]);
        assert.equal(ring.length, 17);
        assert.deepEqual(namesOf(result), ['a', ...ring.map(k => k.name), 'b']);
        assert.deepEqual(result.unreachable, []);
    },

    'path: an orbit is ordered by its entry and exit, not reversed'() {
        // half turn from (14, 5) over z = 9 to (6, 5): entering next to c is shorter
        const arc = orbit('o', 10, 5, 4, 0, 180);
        const result = plan([key('a', 2, 5, [0, 5]), ...arc, key('c', 18, 5, [20, 5])]);
        assert.deepEqual(namesOf(result).filter(n => n !== '-'), ['a', 'c', ...arc.map(k => k.name)]);
        assertIntact(result, arc.map(k => k.name));
    },

    'path: an orbit whose exit is walled off is parked whole'() {
        // half turn from (7, 5) over z = 2 to (13, 5), across the closed wall
        const arc = orbit('o', 10, 5, 3, 180, 180);
        const result = plan([key('a', 2, 3, [0, 3]), key('b', 4, 3, [4, 0]), ...arc], { walled: true });
        assert.deepEqual(namesOf(result), ['a', 'b']);
        assert.deepEqual(result.unreachable, arc.map(k => k.name));
        // alone it leaves nothing to plan
        const alone = plan(arc, { walled: true });
        assert.deepEqual(alone.poses, []);
        assert.deepEqual(alone.unreachable, arc.map(k => k.name));
    },

    'path: the main group counts every key of an orbit'() {
        const ring = orbit('o', 15, 5, 2, 180, 360);
        const result = plan([key('a', 2, 3, [0, 3]), key('b', 4, 3, [4, 0]), ...ring], { walled: true });
        assert.deepEqual(namesOf(result), ring.map(k => k.name));
        assert.deepEqual(result.unreachable, ['a', 'b']);
    },

    'path: a segment inside a block gets no detours but can be blocked'() {
        const keys = [key('a', 8, 5, [12, 5]), key('b', 12, 5, [14, 5])];
        // the route would give detours; the segment crosses the wall
        const result = planDetours({
            keys,
            routes: [[{ x: 8, y: 1.6, z: 1 }, { x: 12, y: 1.6, z: 1 }]],
            fixed: [true],
            grid: gridOf(true),
            eyeHeight: EYE,
            retime: poses => poses.map((_, i) => i * 30),
            curveOpts: { duration: 60, smoothness: 1, loop: false }
        });
        assert.deepEqual(result.poses.map(p => p.pose), keys);
        assert.deepEqual(result.blocked, [0]);
    },

    'path: keep order keeps two orbits together and in place'() {
        const first = orbit('p', 6, 5, 1.5, 180, 90);
        const second = orbit('q', 14, 5, 1.5, 0, 90);
        const keys = [key('a', 2, 5, [0, 5]), ...first, key('b', 10, 2, [10, 0]), ...second];
        const result = plan(keys, { keepOrder: true });
        assert.deepEqual(namesOf(result).filter(n => n !== '-'), keys.map(k => k.name));
        assertIntact(result, first.map(k => k.name));
        assertIntact(result, second.map(k => k.name));
    },

    'path: an orbit split by an edited key stays intact in both runs'() {
        const ring = orbit('o', 10, 5, 2, 180, 360);
        ring[8] = { ...ring[8], orbit: undefined };
        const keys = [key('a', 2, 5, [0, 5]), key('b', 18, 5, [20, 5]), ...ring];
        assert.deepEqual(orbitBlocks(keys).map(b => b.length), [1, 1, 8, 1, 8]);
        const result = plan(keys);
        assertIntact(result, ring.slice(0, 8).map(k => k.name));
        assertIntact(result, ring.slice(9).map(k => k.name));
        assert.deepEqual(result.unreachable, []);
    },

    'path: keys with distinct orbit ids plan as keys without one'() {
        const plain = [key('a', 2, 5, [0, 5]), key('b', 18, 5, [20, 5]), ...orbit('o', 10, 5, 2, 180, 90).map(({ orbit: _, ...k }) => k)];
        const tagged = plain.map((k, i) => ({ ...k, orbit: `t${i}` }));
        const summary = r => r.poses.map(p => [p.key?.name, p.frame, p.pose.position]);
        assert.deepEqual(summary(plan(tagged)), summary(plan(plain)));
    }
};

export { fixPathOrbitChecks };
