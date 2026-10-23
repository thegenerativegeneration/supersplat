import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { Events } from './.build/src/events.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';

const setup = (frames) => {
    const events = new Events();
    events.function('timeline.frames', () => 181);
    events.function('timeline.frameRate', () => 30);
    events.function('timeline.smoothness', () => 1);
    events.function('timeline.loop', () => false);
    events.function('timeline.frame', () => 0);
    events.function('camera.fov', () => 60);
    registerCameraPosesEvents(events);
    registerTrackManagerEvents(events);

    const ops = [];
    events.on('edit.add', op => ops.push(op));

    events.fire('camera.loadPoses', frames.map(([frame, linger], i) => ({
        name: `camera_${i}`,
        frame,
        position: new Vec3(i, 0, 0),
        target: new Vec3(i, 0, -1),
        fov: 60,
        ...(linger ? { linger } : {})
    })));
    return { events, ops };
};

const sortedKeys = events => [...events.invoke('track.keys')].sort((a, b) => a - b);

const cameraTrackChecks = {
    async 'track: setLinger is one undo step and survives snapshot/restore'() {
        const { events, ops } = setup([[0], [30], [60]]);
        events.fire('track.setLinger', 30, 1.5);
        assert.equal(ops.length, 1);
        assert.deepEqual(events.invoke('camera.keyLingers'), [{ frame: 30, linger: 1.5 }]);
        await ops[0].undo();
        assert.deepEqual(events.invoke('camera.keyLingers'), []);
        await ops[0].do();
        assert.deepEqual(events.invoke('camera.keyLingers'), [{ frame: 30, linger: 1.5 }]);
    },

    async 'track: retime moves keys in order and keeps linger'() {
        const { events, ops } = setup([[0], [30, 1], [60]]);
        events.fire('track.retime', [0, 100, 180]);
        assert.equal(ops.length, 1);
        assert.deepEqual(sortedKeys(events), [0, 100, 180]);
        assert.deepEqual(events.invoke('camera.keyLingers'), [{ frame: 100, linger: 1 }]);
    },

    async 'track: retime pulls out-of-range keys in'() {
        const { events } = setup([[0], [50], [300]]);
        events.fire('track.retime', [0, 90, 180]);
        assert.deepEqual(sortedKeys(events), [0, 90, 180]);
    },

    async 'track: retime with wrong length is a no-op'() {
        const { events, ops } = setup([[0], [30], [60]]);
        events.fire('track.retime', [0, 100]);
        assert.equal(ops.length, 0);
        assert.deepEqual(sortedKeys(events), [0, 30, 60]);
    },

    async 'track: linger round-trips through poseSets'() {
        const { events } = setup([[0], [30], [60]]);
        events.fire('track.setLinger', 30, 1.5);
        const sets = events.invoke('docSerialize.poseSets');
        assert.deepEqual(sets[0].poses.map(p => p.linger), [undefined, 1.5, undefined]);
        assert.ok(!('linger' in sets[0].poses[0]));

        const other = setup([]);
        other.events.invoke('docDeserialize.poseSets', sets);
        assert.deepEqual(other.events.invoke('camera.keyLingers'), [{ frame: 30, linger: 1.5 }]);
    }
};

export { cameraTrackChecks };
