import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { Events } from './.build/src/events.js';
import { registerTimingEvents } from './.build/src/timing-events.js';
import { fallbackAppendFrames, registerViewKeyEvents } from './.build/src/view-keys.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';

const setup = (frames, lingers = [], sample = async poses => poses.map((_, i) => (i === 1 ? null : 1))) => {
    const events = new Events();
    events.function('timeline.frames', () => 181);
    events.function('timeline.frameRate', () => 30);
    events.function('timeline.smoothness', () => 1);
    events.function('timeline.loop', () => false);
    events.function('timeline.frame', () => 0);
    events.function('timeline.rotationWeight', () => 1);
    events.function('camera.fov', () => 60);
    events.function('camera.sampleDistances', poses => sample(poses, events));

    const popups = [];
    events.function('showPopup', async (args) => {
        popups.push(args);
        return { action: 'ok' };
    });

    registerCameraPosesEvents(events);
    registerTrackManagerEvents(events);
    registerTimingEvents(events);
    registerViewKeyEvents(events);

    const ops = [];
    events.on('edit.add', op => ops.push(op));

    events.fire('camera.loadPoses', frames.map((frame, i) => ({
        name: `camera_${i}`,
        frame,
        position: new Vec3(i, 0, 0),
        target: new Vec3(i, 0, -1),
        fov: 60,
        ...(lingers[i] ? { linger: lingers[i] } : {})
    })));
    return { events, ops, popups };
};

const sortedKeys = events => [...events.invoke('track.keys')].sort((a, b) => a - b);

const timingEventsChecks = {
    async 'timing: balance retimes keys as one undo step'() {
        const { events, ops, popups } = setup([0, 10, 20]);
        const result = await events.invoke('timing.balance');
        assert.equal(result.ok, true);
        assert.equal(ops.length, 1);
        assert.equal(popups.length, 0);
        assert.deepEqual(sortedKeys(events), [0, 90, 180]);
    },

    async 'timing: failure shows a popup and leaves keys'() {
        const { events, ops, popups } = setup([0, 10, 20], [0, 10, 0]);
        const result = await events.invoke('timing.balance');
        assert.equal(result.ok, false);
        assert.equal(popups.length, 1);
        assert.equal(result.reason, 'lingerTooLong');
        assert.equal(popups[0].type, 'error');
        assert.equal(ops.length, 0);
        assert.deepEqual(sortedKeys(events), [0, 10, 20]);
    },

    async 'timing: undo restores the original frames'() {
        const { events, ops } = setup([0, 10, 20]);
        await events.invoke('timing.balance');
        assert.deepEqual(sortedKeys(events), [0, 90, 180]);
        ops[0].undo();
        assert.deepEqual(sortedKeys(events), [0, 10, 20]);
        ops[0].do();
        assert.deepEqual(sortedKeys(events), [0, 90, 180]);
    },

    async 'timing: keys changing while sampling abort the balance'() {
        const { events, ops, popups } = setup([0, 10, 20], [], async (poses, ev) => {
            ev.fire('track.moveKey', 20, 25);
            return poses.map(() => 1);
        });
        const result = await events.invoke('timing.balance');
        assert.deepEqual(result, { ok: false, reason: 'keysChanged' });
        assert.equal(popups.length, 1);
        assert.equal(ops.length, 1);
        assert.deepEqual(sortedKeys(events), [0, 10, 25]);
    }
    ,

    'views: fallback compresses existing and spaces new keys'() {
        const frames = fallbackAppendFrames([0, 90, 180], 2, 181);
        assert.equal(frames.length, 5);
        assert.equal(frames[0], 0);
        assert.ok(frames[4] <= 180);
        assert.ok(frames.every((f, i) => i === 0 || f > frames[i - 1]));
        assert.deepEqual(frames, [0, 45, 90, 135, 180]);
        assert.deepEqual(fallbackAppendFrames([], 3, 181), [0, 90, 180]);
    },

    async 'views: addKeys balances over all keys'() {
        const { events, ops, popups } = setup([0, 10], [], async poses => poses.map(() => 1));
        const result = await events.invoke('views.addKeys', [
            { position: { x: 5, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, fov: 50, depth: 2 },
            { position: { x: 9, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, fov: 50, depth: 2 }
        ]);
        assert.equal(result.ok, true);
        assert.equal(popups.length, 0);
        assert.equal(ops.length, 1);
        assert.equal(sortedKeys(events).length, 4);
        const added = events.invoke('camera.poses').find(p => p.name === 'camera_2');
        assert.equal(added.target.z, -2);
    },

    async 'views: one pick on an empty track adds a key at frame 0 without a popup'() {
        const { events, popups } = setup([], [], async poses => poses.map(() => 1));
        const result = await events.invoke('views.addKeys', [
            { position: { x: 5, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, fov: 50, depth: 2 }
        ]);
        assert.equal(result.reason, 'tooFewKeys');
        assert.equal(popups.length, 0);
        assert.deepEqual(sortedKeys(events), [0]);
    },

    async 'views: addKeys aborts when keys change during sampling'() {
        const { events, ops, popups } = setup([0, 10], [], async (poses, ev) => {
            ev.fire('track.moveKey', 10, 25);
            return poses.map(() => 1);
        });
        const result = await events.invoke('views.addKeys', [
            { position: { x: 5, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, fov: 50, depth: 2 }
        ]);
        assert.deepEqual(result, { ok: false, reason: 'keysChanged' });
        assert.equal(popups.length, 1);
        assert.ok(ops.every(op => op.name !== 'appendPoses'));
    },

    async 'views: addKeys falls back when balance refuses'() {
        const { events, ops, popups } = setup([0, 10], [0, 10], async poses => poses.map(() => 1));
        const result = await events.invoke('views.addKeys', [
            { position: { x: 5, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, fov: 50, depth: 2 }
        ]);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'lingerTooLong');
        assert.equal(popups.length, 1);
        assert.equal(ops.length, 1);
        assert.equal(sortedKeys(events).length, 3);
    }
};

export { timingEventsChecks };
