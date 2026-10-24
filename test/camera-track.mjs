import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { Events } from './.build/src/events.js';
import { registerTimelineEvents } from './.build/src/timeline.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';

export const setup = (frames) => {
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
    },

    async 'timeline: rotation weight defaults to 1 and round-trips'() {
        const events = new Events();
        registerTimelineEvents(events);

        events.invoke('docDeserialize.timeline', {});
        assert.equal(events.invoke('timeline.rotationWeight'), 1);

        events.fire('timeline.setRotationWeight', 2.5);
        const data = events.invoke('docSerialize.timeline');
        assert.equal(data.rotationWeight, 2.5);

        const restored = new Events();
        registerTimelineEvents(restored);
        restored.invoke('docDeserialize.timeline', data);
        assert.equal(restored.invoke('timeline.rotationWeight'), 2.5);

        events.fire('timeline.setRotationWeight', 9);
        assert.equal(events.invoke('timeline.rotationWeight'), 4);
    },

    'track: appendPoses adds keys and retimes in one undo step'() {
        const { events, ops } = setup([[0], [30]]);
        const added = [2, 3].map(i => ({ position: new Vec3(i, 0, 0), target: new Vec3(i, 0, -1), fov: 50 }));
        events.fire('track.appendPoses', added, [0, 50, 100, 180]);
        assert.equal(ops.length, 1);
        assert.deepEqual(sortedKeys(events), [0, 50, 100, 180]);
        const names = events.invoke('camera.poses').map(p => p.name).sort();
        assert.deepEqual(names, ['camera_0', 'camera_1', 'camera_2', 'camera_3']);
        ops[0].undo();
        assert.deepEqual(sortedKeys(events), [0, 30]);
        assert.equal(events.invoke('camera.poses').length, 2);
    },

    'track: appendPoses rejects non-increasing frames'() {
        const { events, ops } = setup([[0], [30]]);
        const added = [{ position: new Vec3(), target: new Vec3(0, 0, -1), fov: 50 }];
        events.fire('track.appendPoses', added, [0, 30, 30]);
        events.fire('track.appendPoses', added, [0, 30]);
        assert.equal(ops.length, 0);
        assert.deepEqual(sortedKeys(events), [0, 30]);
    },

    'track: a copied or replaced auto key is a normal key'() {
        const { events } = setup([[0], [60]]);
        events.function('camera.getPose', () => ({ position: new Vec3(1, 0, 0), target: new Vec3(1, 0, -1), fov: 60 }));
        const autoPose = { name: 'detour', frame: 30, position: new Vec3(5, 0, 0), target: new Vec3(5, 0, -1), fov: 60, auto: true };
        const autoAt = frame => !!events.invoke('camera.poses').find(p => p.frame === frame).auto;
        events.fire('track.replacePath', [...events.invoke('camera.poses'), autoPose]);
        assert.equal(autoAt(30), true);

        events.fire('track.copyKey', 30, 45);
        assert.equal(autoAt(45), false);
        assert.equal(autoAt(30), true);

        events.fire('track.addKey', 30);
        assert.equal(autoAt(30), false);
    }
};

export { cameraTrackChecks };
