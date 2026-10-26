import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { Events } from './.build/src/events.js';
import { registerTimelineEvents } from './.build/src/timeline.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';

export const setup = (frames, total = { frames: 181 }) => {
    const events = new Events();
    events.function('timeline.frames', () => total.frames);
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
    async 'track: every key has a unique id that survives move, retime, undo and save/load'() {
        const { events, ops } = setup([[0], [30], [60]]);
        const ids = () => events.invoke('camera.poses').slice().sort((a, b) => a.frame - b.frame).map(p => p.id);
        const before = ids();
        assert.ok(before.every(Boolean));
        assert.equal(new Set(before).size, 3);

        events.fire('track.moveKey', 30, 40);
        assert.deepEqual(ids(), before);
        events.fire('track.retime', [0, 100, 180]);
        assert.deepEqual(ids(), before);
        await ops[1].undo();
        assert.deepEqual(ids(), before);

        const other = setup([]);
        other.events.invoke('docDeserialize.poseSets', events.invoke('docSerialize.poseSets'));
        assert.deepEqual(other.events.invoke('camera.poses').slice().sort((a, b) => a.frame - b.frame).map(p => p.id), before);
    },

    'track: addKey after a delete never repeats a name'() {
        const { events } = setup([[0], [30], [60]]);
        events.function('camera.getPose', () => ({ position: new Vec3(9, 0, 0), target: new Vec3(9, 0, -1), fov: 60 }));
        events.fire('track.removeKey', 0);
        events.fire('track.addKey', 90);
        events.fire('track.copyKey', 90, 120);
        const names = events.invoke('camera.poses').map(p => p.name);
        assert.equal(new Set(names).size, names.length);
        assert.deepEqual(names.slice().sort(), ['camera_1', 'camera_2', 'camera_3', 'camera_4']);
    },

    'track: old files without ids or with duplicate names load with unique ids and names, and play the same curve'() {
        const curveAt = (events) => {
            const seen = [];
            events.on('camera.setPose', pose => seen.push([pose.position.x, pose.position.y, pose.position.z, pose.target.x, pose.fov]));
            return (frame) => {
                seen.length = 0;
                events.fire('timeline.frame', frame);
                return seen.at(-1);
            };
        };
        const poses = [0, 1, 2].map(i => ({ name: 'camera_0', frame: i * 60, position: [i, i * 2, 0], target: [i, 0, -1], fov: 60 }));
        const { events } = setup([]);
        const at = curveAt(events);
        events.invoke('docDeserialize.poseSets', [{ name: 'set0', poses }]);
        const loaded = events.invoke('camera.poses');
        assert.equal(new Set(loaded.map(p => p.id)).size, 3);
        assert.deepEqual(loaded.map(p => p.name), ['camera_0', 'camera_1', 'camera_2']);

        const frames = [0, 15, 30, 45, 60, 75, 90, 105, 120, 150];
        const first = frames.map(at);
        const again = setup([]);
        const atAgain = curveAt(again.events);
        again.events.invoke('docDeserialize.poseSets', events.invoke('docSerialize.poseSets'));
        assert.deepEqual(frames.map(atAgain), first);
        assert.ok(first.every(Boolean));
    },

    async 'track: lookAhead and turnIn survive copyPose, undo and save/load'() {
        const { events, ops } = setup([[0], [30], [60]]);
        const poses = events.invoke('camera.poses').map(p => ({ ...p }));
        poses[1].lookAhead = true;
        poses[1].turnIn = 0.5;
        events.fire('track.replacePath', poses);
        const keyAt = (ev, frame) => ev.invoke('camera.poses').find(p => p.frame === frame);
        assert.equal(keyAt(events, 30).lookAhead, true);
        assert.equal(keyAt(events, 30).turnIn, 0.5);

        events.fire('track.setLinger', 0, 1);
        await ops[1].undo();
        assert.equal(keyAt(events, 30).lookAhead, true);
        assert.equal(keyAt(events, 30).turnIn, 0.5);

        const sets = events.invoke('docSerialize.poseSets');
        assert.ok(!('lookAhead' in sets[0].poses[0]));
        const other = setup([]);
        other.events.invoke('docDeserialize.poseSets', sets);
        assert.equal(keyAt(other.events, 30).lookAhead, true);
        assert.equal(keyAt(other.events, 30).turnIn, 0.5);
        assert.equal(keyAt(other.events, 0).lookAhead, undefined);
    },

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

    'track: appendPoses rejects repeated frames'() {
        const { events, ops } = setup([[0], [30]]);
        const added = [{ position: new Vec3(), target: new Vec3(0, 0, -1), fov: 50 }];
        events.fire('track.appendPoses', added, [0, 30, 30]);
        events.fire('track.appendPoses', added, [0, 30]);
        assert.equal(ops.length, 0);
        assert.deepEqual(sortedKeys(events), [0, 30]);
    },

    'track: parked survives snapshot and poseSets, retime into the shot clears it'() {
        const { events, ops } = setup([[0], [60]]);
        const parked = { name: 'away', frame: 181, position: new Vec3(5, 0, 0), target: new Vec3(5, 0, -1), fov: 60, parked: true };
        events.fire('track.replacePath', [...events.invoke('camera.poses'), parked]);
        const isParked = () => !!events.invoke('camera.poses').find(p => p.name === 'away').parked;
        assert.equal(isParked(), true);
        events.fire('track.setLinger', 0, 1);
        ops[1].undo();
        assert.equal(isParked(), true);

        const sets = events.invoke('docSerialize.poseSets');
        assert.deepEqual(sets[0].poses.map(p => !!p.parked), [false, false, true]);
        const other = setup([]);
        other.events.invoke('docDeserialize.poseSets', sets);
        assert.equal(other.events.invoke('camera.poses').find(p => p.name === 'away').parked, true);

        events.fire('track.retime', [0, 60, 120]);
        assert.equal(isParked(), false);
    },

    'track: raising Total Frames past a parked key unparks it'() {
        const total = { frames: 181 };
        const { events } = setup([[0], [60]], total);
        const away = (name, frame) => ({ name, frame, position: new Vec3(5, 0, 0), target: new Vec3(5, 0, -1), fov: 60, parked: true });
        events.fire('track.replacePath', [...events.invoke('camera.poses'), away('near', 181), away('far', 182)]);
        total.frames = 182;
        events.fire('timeline.frames', 182);
        const parked = name => !!events.invoke('camera.poses').find(p => p.name === name).parked;
        assert.equal(parked('near'), false);
        assert.equal(parked('far'), true);
    },

    'keys: moveKeys keeps spacing and is one undo step'() {
        const { events, ops } = setup([[0], [30], [60], [90]]);
        const ids = events.invoke('camera.poses').filter(p => p.frame === 30 || p.frame === 60).map(p => p.id);
        events.fire('track.moveKeys', ids, 15);
        assert.deepEqual(sortedKeys(events), [0, 15 + 30, 15 + 60, 90]);
        assert.equal(ops.length, 1);
        ops[0].undo();
        assert.deepEqual(sortedKeys(events), [0, 30, 60, 90]);
    },

    'keys: a move onto an unselected key\'s frame is refused, changes nothing and adds no undo op'() {
        const { events, ops } = setup([[0], [30], [60]]);
        const refusals = [];
        events.on('track.refused', reason => refusals.push(reason));
        events.fire('track.setLinger', 0, 1);
        const id = frame => events.invoke('camera.poses').find(p => p.frame === frame).id;

        events.fire('track.moveKeys', [id(30)], 30);
        assert.deepEqual(refusals, ['frameTaken']);
        events.fire('track.moveKeys', [id(0)], -5);
        assert.deepEqual(refusals, ['frameTaken', 'outOfRange']);
        events.fire('track.moveKeys', ['nope'], 5);
        assert.deepEqual(refusals, ['frameTaken', 'outOfRange', 'unknownKey']);
        events.fire('track.copyKeys', [id(0)], 30);
        assert.equal(refusals.at(-1), 'frameTaken');
        assert.deepEqual(sortedKeys(events), [0, 30, 60]);
        assert.equal(ops.length, 1);

        ops[0].undo();
        assert.equal(events.invoke('camera.poses').find(p => p.frame === 0).linger, undefined);
    },

    'keys: a group move where one key would land on an unselected key\'s frame is refused as a whole'() {
        const { events, ops } = setup([[0], [30], [60]]);
        const refusals = [];
        events.on('track.refused', reason => refusals.push(reason));
        events.fire('track.setLinger', 0, 1);
        const ids = events.invoke('camera.poses').filter(p => p.frame <= 30).map(p => p.id);

        events.fire('track.moveKeys', ids, 30);
        assert.deepEqual(refusals, ['frameTaken']);
        events.fire('track.copyKeys', ids, 30);
        assert.deepEqual(refusals, ['frameTaken', 'frameTaken']);
        assert.deepEqual(sortedKeys(events), [0, 30, 60]);
        assert.equal(ops.length, 1);

        ops[0].undo();
        assert.equal(events.invoke('camera.poses').find(p => p.frame === 0).linger, undefined);
    },

    'keys: updateKeys on a detour clears auto; a linger change keeps orbit, a target change clears it'() {
        const { events } = setup([[0], [60]]);
        const detour = { name: 'detour', frame: 30, position: new Vec3(5, 0, 0), target: new Vec3(5, 0, -1), fov: 60, auto: true, orbit: 'o1' };
        events.fire('track.replacePath', [...events.invoke('camera.poses'), detour]);
        const get = () => events.invoke('camera.poses').find(p => p.frame === 30);

        events.fire('track.updateKeys', [{ id: get().id, linger: 2 }]);
        assert.equal(get().auto, undefined);
        assert.equal(get().linger, 2);
        assert.equal(get().orbit, 'o1');

        events.fire('track.updateKeys', [{ id: get().id, target: new Vec3(6, 0, -1) }]);
        assert.equal(get().orbit, undefined);
    },

    'keys: copyKeys gives new ids and keeps lookAhead'() {
        const { events } = setup([[0], [60]]);
        const detour = { name: 'detour', frame: 30, position: new Vec3(5, 0, 0), target: new Vec3(5, 0, -1), fov: 60, auto: true, orbit: 'o1', lookAhead: true, turnIn: 2, linger: 1 };
        events.fire('track.replacePath', [...events.invoke('camera.poses'), detour]);
        const source = events.invoke('camera.poses').find(p => p.frame === 30);
        events.fire('track.copyKeys', [source.id], 100);
        const copy = events.invoke('camera.poses').find(p => p.frame === 130);
        assert.ok(copy.id && copy.id !== source.id);
        assert.equal(copy.lookAhead, true);
        assert.equal(copy.turnIn, 2);
        assert.equal(copy.linger, 1);
        assert.equal(copy.auto, undefined);
        assert.equal(copy.orbit, undefined);
        assert.equal(new Set(events.invoke('camera.poses').map(p => p.name)).size, 4);
    },

    'keys: removeKeys removes exactly the ids'() {
        const { events, ops } = setup([[0], [30], [60], [90]]);
        const ids = events.invoke('camera.poses').filter(p => p.frame === 30 || p.frame === 90).map(p => p.id);
        events.fire('track.removeKeys', [...ids, 'nope']);
        assert.deepEqual(sortedKeys(events), [0, 60]);
        assert.equal(ops.length, 1);
        events.fire('track.removeKeys', ['nope']);
        assert.equal(ops.length, 1);
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
