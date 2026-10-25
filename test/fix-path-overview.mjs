import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { buildSceneGrid } from './.build/src/candidates/generate.js';
import { boxAroundKeys } from './.build/src/fix-path-events.js';
import { planFixPath } from './.build/src/path/fix-plan.js';
import { keyRoutes } from './.build/src/path/key-graph.js';
import { buildNavGrid, NAV_HEAD_VOXELS } from './.build/src/path/nav-grid.js';
import { attachCell, findRoute, snapCell } from './.build/src/path/route.js';
import { setup } from './fix-path-events.mjs';
import { room, sheet } from './nav-doors.mjs';

const EYE = 1.6;
const TIMELINE = { frames: 600, frameRate: 30, smoothness: 1, loop: false, rotationWeight: 1 };
const FIX = { keepOrder: false, allowFlying: true };

// floor, a roof at 2.8 and four walls around x 0 .. 20, z 0 .. 10
const closedHouse = () => new Float32Array([
    ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
    ...sheet(0, 20, 0, 10, (x, z) => [x, 2.8, z]),
    ...[0, 20].flatMap(x => sheet(0, 2.8, 0, 10, (y, z) => [x, y, z])),
    ...[0, 10].flatMap(z => sheet(0, 2.8, 0, 20, (y, x) => [x, y, z]))
]);

// floor over x 0 .. 20, z 0 .. 10 and a 2.8 m wall at x = 10 with a door,
// open to the sky
const yard = () => new Float32Array([
    ...sheet(0, 20, 0, 10, (x, z) => [x, 0, z]),
    ...sheet(0, 2.8, 0, 10, (y, z) => [10, y, z], (y, z) => z >= 5 && z < 5.9 && y < 2)
]);

const gridOf = (points, box) => {
    const { occ, levels } = buildSceneGrid(points, box, EYE, NAV_HEAD_VOXELS);
    return buildNavGrid(occ, levels, box, EYE, true);
};

const fixKey = (name, p) => ({ name, position: p, target: { x: p.x, y: p.y - 1, z: p.z + 1 }, fov: 60, linger: 0, distance: 5 });

const pose = (name, frame, p) => ({ name, frame, position: new Vec3(p.x, p.y, p.z), target: new Vec3(p.x, p.y - 1, p.z + 1), fov: 60 });

// Fix Path with the default scene grid over points and the Suggest Views box
const fixOver = async (points, box, keys) => {
    const { events } = setup(keys.map(([name, p], i) => pose(name, i * 30, p)), { deps: {} });
    events.function('candidates.cloud', async () => ({ points }));
    events.function('candidates.lastSettings', () => ({ box, eyeHeight: EYE }));
    return events.invoke('path.fix', FIX);
};

const IN_A = { x: 3, y: 1.6, z: 5.4 };
const IN_B = { x: 17, y: 1.6, z: 5.4 };
// 12 m above the roofs of room and closedHouse
const HIGH = { x: 5, y: 14.8, z: 5 };

const fixPathOverviewChecks = {
    'path: a key high above the yard is reached by a straight move'() {
        const box = boxAroundKeys({ min: { x: -3, y: -1, z: -3 }, max: { x: 23, y: 6, z: 13 } }, [IN_A, HIGH], EYE);
        assert.ok(box.max.y >= HIGH.y + EYE - 1e-9, `box top ${box.max.y}`);
        const grid = gridOf(yard(), box);
        assert.equal(snapCell(grid, HIGH), null, 'too far to snap');

        const attach = attachCell(grid, HIGH, [IN_A]);
        assert.ok(attach, 'linked');
        const at = grid.centre(attach.cell);
        assert.ok(at.y > IN_A.y && at.y < HIGH.y - 6, `attaches above walking height at ${at.y}`);
        assert.ok(at.x >= 0 && at.x <= 20 && at.z >= 0 && at.z <= 10, `over the yard at ${at.x}, ${at.z}`);
        const straight = Math.hypot(at.x - HIGH.x, at.y - HIGH.y, at.z - HIGH.z);
        assert.ok(Math.abs(attach.straight - straight) < 1e-9);

        const route = findRoute(grid, HIGH, IN_A);
        assert.ok(route, 'route');
        assert.ok(route.fromSnapped);
        assert.ok(route.length >= straight, 'length includes the straight move');
        const routes = keyRoutes(grid, [IN_A, HIGH]);
        assert.ok(Number.isFinite(routes.length(0, 1)) && Number.isFinite(routes.length(1, 0)));
        assert.ok(routes.length(1, 0) >= straight);

        const plan = planFixPath({ keys: [fixKey('a', IN_A), fixKey('o', HIGH)], grid, eyeHeight: EYE, keepOrder: false, timeline: TIMELINE });
        assert.deepEqual(plan.unreachable, []);
        assert.deepEqual(plan.blocked, []);
    },

    'path: a straight move into geometry does not link'() {
        // graph cells from x = 5 on, but every line is blocked
        const grid = {
            voxel: 0.4,
            cellOf: p => (p.x >= 5 ? Math.floor(p.x / 0.4) : null),
            nearestFree: () => null,
            centre: c => ({ x: (c + 0.5) * 0.4, y: 0, z: 0 }),
            lineFree: () => false
        };
        assert.equal(attachCell(grid, { x: 0, y: 0, z: 0 }, [{ x: 10, y: 0, z: 0 }]), null);
        grid.lineFree = () => true;
        const attach = attachCell(grid, { x: 0, y: 0, z: 0 }, [{ x: 10, y: 0, z: 0 }, { x: -10, y: 0, z: 0 }]);
        assert.equal(attach.cell, Math.floor(5 / 0.4));
    },

    async 'path: a key above a roof the area box cut off stays out of the house'() {
        // the box ends below the roof, as a box at the 97th height percentile can
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 2.4, z: 11 } };
        const grown = boxAroundKeys(box, [IN_A, HIGH], EYE);
        assert.equal(gridOf(closedHouse(), grown).lineFree(HIGH, IN_A), false, 'the roof is in the grid');

        const result = await fixOver(closedHouse(), box, [['a', IN_A], ['o', HIGH]]);
        assert.equal(result.ok, true);
        assert.ok(result.unreachable.includes('o') || result.blocked.length > 0, JSON.stringify(result));
        assert.deepEqual(result.insideGeometry, [], 'not outside the grown box');
    },

    async 'path: a key outside the area box next to the scan is reached once the box grows'() {
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 15, y: 6, z: 11 } };
        const result = await fixOver(room(0, 2.0), box, [['a', IN_A], ['b', IN_B]]);
        assert.equal(result.ok, true);
        assert.deepEqual(result.unreachable, []);
        assert.deepEqual(result.insideGeometry, []);
    },

    async 'path: the scene grid gets the key positions'() {
        let positions = null;
        const { events } = setup([pose('a', 0, IN_A), pose('b', 30, IN_B)], {
            deps: {
                sceneGrid: async (allowFlying, openingAt, keys) => {
                    positions = keys;
                    return null;
                }
            }
        });
        await events.invoke('path.fix', FIX);
        assert.deepEqual(positions.map(p => [p.x, p.y, p.z]), [[3, 1.6, 5.4], [17, 1.6, 5.4]]);
    },

    'path: keys that snap attach and route as before'() {
        const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 21, y: 6, z: 11 } };
        assert.deepEqual(boxAroundKeys(box, [IN_A, IN_B], EYE), box, 'keys well inside keep the box');
        const grid = gridOf(room(0, 2.0), box);
        const keys = [IN_A, IN_B, { x: 8, y: 1.9, z: 2 }];
        keys.forEach((p, i) => {
            assert.deepEqual(attachCell(grid, p, keys.filter((_, j) => j !== i)), { cell: snapCell(grid, p), straight: 0 });
        });
        const routes = keyRoutes(grid, keys);
        for (let i = 0; i < keys.length; i++) {
            for (let j = 0; j < keys.length; j++) {
                if (i === j) continue;
                const plain = findRoute(grid, keys[i], keys[j]);
                // centre to centre, without a straight part
                let length = 0;
                for (let k = 1; k < plain.points.length; k++) {
                    const a = plain.points[k - 1], b = plain.points[k];
                    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
                }
                assert.ok(Math.abs(plain.length - length) < 1e-9, `${i} -> ${j}`);
                assert.ok(Math.abs(routes.length(i, j) - plain.length) < 1e-6, `${i} -> ${j}`);
            }
        }
    }
};

export { fixPathOverviewChecks };
