import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { changesFor, editorFields, leavesShot, viewChanges } from './.build/src/ui/key-editor-model.js';
import { setup } from './camera-track.mjs';

const pose = (id, frame, extra = {}) => ({
    id,
    name: id,
    frame,
    position: new Vec3(frame, 1, 0),
    target: new Vec3(frame, 1, -1),
    fov: 60,
    ...extra
});

const byFrame = events => events.invoke('camera.poses').slice().sort((a, b) => a.frame - b.frame);

const keyEditorModelChecks = {
    'editor: one key shows its values; three keys show null where they differ'() {
        const one = editorFields([pose('a', 45, { linger: 1, lookAhead: true, turnIn: 2 })], 30);
        assert.equal(one.count, 1);
        assert.equal(one.time, 1.5);
        assert.equal(one.frame, 45);
        assert.equal(one.linger, 1);
        assert.equal(one.fov, 60);
        assert.equal(one.lookAhead, true);
        assert.equal(one.turnIn, 2);
        assert.deepEqual(one.position, { x: 45, y: 1, z: 0 });
        assert.deepEqual(one.target, { x: 45, y: 1, z: -1 });
        assert.equal(one.viewEditable, true);

        // missing linger, look ahead and turn-in read as their defaults
        const three = editorFields([
            pose('a', 0, { linger: 1, fov: 50 }),
            pose('b', 30, { linger: 1, lookAhead: true }),
            pose('c', 60, { linger: 1, turnIn: 1.5 })
        ], 30);
        assert.equal(three.count, 3);
        assert.equal(three.time, null);
        assert.equal(three.frame, null);
        assert.equal(three.linger, 1);
        assert.equal(three.fov, null);
        assert.equal(three.lookAhead, null);
        assert.equal(three.turnIn, 1.5);
        assert.equal(three.position, null);
        assert.equal(three.target, null);
    },

    'editor: time for several keys moves the earliest to it and keeps spacing'() {
        const { events, ops } = setup([[0], [30], [90], [150]]);
        const [, b, c] = byFrame(events);
        const selected = [c, b];

        // 2.01 s at 30 fps is frame 60.3, rounded to a whole frame
        const changes = changesFor(selected, 'time', 2.01, 30);
        assert.deepEqual(changes.map(ch => [ch.id, ch.frame]).sort(), [[b.id, 60], [c.id, 120]].sort());
        assert.ok(changes.every(ch => Number.isInteger(ch.frame)));
        assert.deepEqual(changesFor(selected, 'frame', 59.6), changes);

        events.fire('track.updateKeys', changes);
        assert.deepEqual(byFrame(events).map(p => p.frame), [0, 60, 120, 150]);
        assert.equal(ops.length, 1);

        // landing the later key on the unselected one at 150 is refused as a whole
        const refused = [];
        events.on('track.refused', reason => refused.push(reason));
        const moved = byFrame(events).filter(p => p.id === b.id || p.id === c.id);
        events.fire('track.updateKeys', changesFor(moved, 'frame', 90));
        assert.deepEqual(refused, ['frameTaken']);
        assert.deepEqual(byFrame(events).map(p => p.frame), [0, 60, 120, 150]);
        assert.equal(ops.length, 1);

        // the same time again changes nothing
        assert.deepEqual(changesFor(moved, 'frame', 60), []);

        // a key inside the shot may not leave it; one already past the end may move
        assert.equal(leavesShot(moved, changesFor(moved, 'frame', 130), 180), true);
        assert.equal(leavesShot(moved, changesFor(moved, 'frame', 70), 180), false);
        const parked = [pose('p', 200), pose('q', 100)];
        assert.equal(leavesShot(parked, changesFor(parked, 'frame', 90), 180), false);
    },

    'editor: view fields are disabled for several keys'() {
        const keys = [pose('a', 0), pose('b', 30)];
        assert.equal(editorFields(keys, 30).viewEditable, false);
        assert.equal(editorFields([], 30).viewEditable, false);
        assert.deepEqual(changesFor(keys, 'position', { x: 1, y: 2, z: 3 }), []);
        assert.deepEqual(changesFor(keys, 'target', { x: 1, y: 2, z: 3 }), []);
        const view = { position: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: 2 }, fov: 40 };
        assert.deepEqual(viewChanges(keys, view), []);

        const [change] = viewChanges([keys[0]], view);
        assert.equal(change.id, 'a');
        assert.ok(change.position.equals(new Vec3(1, 2, 3)));
        assert.ok(change.target.equals(new Vec3(1, 2, 2)));
        assert.equal(change.fov, 40);
        const [typed] = changesFor([keys[0]], 'position', { x: 1, y: 2, z: 3 });
        assert.ok(typed.position instanceof Vec3);
        assert.ok(typed.position.equals(new Vec3(1, 2, 3)));
    },

    'editor: linger, FOV and look ahead apply to all; none of them drops an orbit'() {
        const { events, ops } = setup([[0], [60]]);
        const orbitKeys = byFrame(events).map(p => ({ ...p, orbit: 'o1' }));
        events.fire('track.replacePath', orbitKeys);
        const keys = byFrame(events);

        for (const [field, value] of [['linger', 2], ['fov', 45], ['lookAhead', true], ['turnIn', 3]]) {
            const changes = changesFor(keys, field, value);
            assert.equal(changes.length, 2, field);
            events.fire('track.updateKeys', changes);
            assert.ok(byFrame(events).every(p => p[field] === value), field);
        }
        assert.ok(byFrame(events).every(p => p.orbit === 'o1'));
        // one undo step per edit, after the replacePath
        assert.equal(ops.length, 5);

        // blank or unparsable input changes nothing
        assert.deepEqual(changesFor(keys, 'linger', null), []);
        assert.deepEqual(changesFor(keys, 'time', Number.NaN, 30), []);
    }
};

export { keyEditorModelChecks };
