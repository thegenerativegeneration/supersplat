import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { pickPositionChange, pickStandPoint, pickTargetChange } from './.build/src/key-pick.js';

const keyPose = () => ({
    id: 'a',
    name: 'a',
    frame: 0,
    position: new Vec3(0, 2, 0),
    target: new Vec3(0, 1, -4),
    fov: 60
});

const keyPickChecks = {
    async 'pick: standing point is eye height above the floor found straight down'() {
        const calls = [];
        const hit = { x: 3, y: 0.02, z: -5 };
        const pickDown = async (from) => {
            calls.push(from);
            return { x: from.x, y: 0, z: from.z };
        };
        const stand = await pickStandPoint(hit, 1.6, pickDown);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].x, 3);
        assert.equal(calls[0].z, -5);
        assert.ok(calls[0].y > hit.y, 'the floor is searched from above the hit');
        assert.deepEqual(stand, { x: 3, y: 1.6, z: -5 });
    },

    async 'pick: nothing below leaves the key unchanged'() {
        const hit = { x: 3, y: 1, z: -5 };
        assert.equal(await pickStandPoint(hit, 1.6, async () => null), null);
        assert.equal(await pickPositionChange(keyPose(), hit, 1.6, async () => null), null);
    },

    async 'pick: position keeps the view direction, target aims at the hit'() {
        const pose = keyPose();
        const change = await pickPositionChange(pose, { x: 5, y: 0, z: 5 }, 1.5, async from => ({ x: from.x, y: 0, z: from.z }));
        assert.equal(change.id, 'a');
        assert.ok(change.position.equals(new Vec3(5, 1.5, 5)));
        // moved by (5, -0.5, 5), the same offset as the position
        assert.ok(change.target.equals(new Vec3(5, 0.5, 1)));

        const aimed = pickTargetChange(pose, { x: 1, y: 2, z: 3 });
        assert.equal(aimed.id, 'a');
        assert.ok(aimed.target.equals(new Vec3(1, 2, 3)));
        assert.equal(aimed.position, undefined);
    }
};

export { keyPickChecks };
