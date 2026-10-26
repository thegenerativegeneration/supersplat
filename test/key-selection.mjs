import assert from 'node:assert/strict';

import { registerKeySelectionEvents, selectWith } from './.build/src/key-selection.js';
import { setup } from './camera-track.mjs';

const ids = ['a', 'b', 'c', 'd', 'e'];
const plain = { shift: false, toggle: false };
const shift = { shift: true, toggle: false };
const toggle = { shift: false, toggle: true };

const withKeys = () => {
    const ctx = setup([[0], [30], [60], [90], [120]]);
    registerKeySelectionEvents(ctx.events);
    const poses = ctx.events.invoke('camera.poses').slice().sort((a, b) => a.frame - b.frame);
    return { ...ctx, poses, pid: poses.map(p => p.id) };
};

const keySelectionChecks = {
    'selection: click, shift range, toggle add/remove'() {
        const cases = [
            ['plain click', [], null, 'c', plain, ['c'], 'c'],
            ['plain replaces', ['a', 'b'], 'a', 'd', plain, ['d'], 'd'],
            ['shift without anchor acts as plain', [], null, 'c', shift, ['c'], 'c'],
            ['shift range forward', ['b'], 'b', 'd', shift, ['b', 'c', 'd'], 'b'],
            ['shift range backward', ['d'], 'd', 'b', shift, ['b', 'c', 'd'], 'd'],
            ['shift replaces earlier range', ['b', 'c', 'd'], 'b', 'c', shift, ['b', 'c'], 'b'],
            ['toggle adds', ['a'], 'a', 'c', toggle, ['a', 'c'], 'c'],
            ['toggle removes', ['a', 'c'], 'c', 'a', toggle, ['c'], 'a'],
            ['toggle+shift extends', ['a', 'e'], 'e', 'c', { shift: true, toggle: true }, ['a', 'c', 'd', 'e'], 'e']
        ];
        for (const [name, current, anchor, clicked, g, expected, expectedAnchor] of cases) {
            const r = selectWith(new Set(current), anchor, clicked, ids, g);
            assert.deepEqual([...r.selected].sort(), expected, name);
            assert.equal(r.anchor, expectedAnchor, name);
        }
    },

    'selection: ids that leave the track drop out and fire selectionChanged'() {
        const { events, pid, poses } = withKeys();
        const seen = [];
        events.on('keys.selectionChanged', s => seen.push(s));
        events.fire('keys.setSelection', [pid[1], pid[2]]);
        events.fire('track.removeKey', poses[1].frame);
        assert.deepEqual(events.invoke('keys.selected'), [pid[2]]);
        assert.deepEqual(seen, [[pid[1], pid[2]], [pid[2]]]);
        events.fire('camera.loadPoses', []);
        assert.deepEqual(events.invoke('keys.selected'), []);
        assert.equal(seen.length, 3);
    },

    'selection: a selected key overwritten by a move drops out'() {
        const { events, pid, poses } = withKeys();
        events.fire('keys.setSelection', [pid[1], pid[2]]);
        events.fire('track.moveKey', poses[0].frame, poses[1].frame);
        assert.deepEqual(events.invoke('keys.selected'), [pid[2]]);
    },

    'selection: delete removes keys when focused, else select.delete stays with splats'() {
        const { events, ops, pid } = withKeys();
        let splatDeletes = 0;
        // mirrors the routing line at the top of the select.delete handler in editor.ts
        events.on('select.delete', () => {
            if (events.invoke('keys.focused')) return events.fire('keys.delete');
            splatDeletes++;
        });

        events.fire('keys.setSelection', [pid[1], pid[3]]);
        events.fire('select.delete');
        assert.equal(splatDeletes, 1);
        assert.equal(events.invoke('camera.poses').length, 5);

        events.fire('keys.focus', true);
        const before = ops.length;
        events.fire('select.delete');
        assert.equal(splatDeletes, 1);
        assert.equal(ops.length, before + 1);
        assert.deepEqual(events.invoke('camera.poses').map(p => p.id).sort(), [pid[0], pid[2], pid[4]].sort());
        assert.deepEqual(events.invoke('keys.selected'), []);
        assert.equal(events.invoke('keys.focused'), false);
    },

    'selection: a plain click moves the playhead to the key'() {
        const { events, pid } = withKeys();
        const frames = [];
        events.on('timeline.setFrame', f => frames.push(f));
        events.fire('keys.select', pid[2], plain);
        events.fire('keys.select', pid[4], toggle);
        events.fire('keys.select', pid[0], shift);
        assert.deepEqual(frames, [60]);
        assert.deepEqual(events.invoke('keys.selected').sort(), [...pid].sort());
    }
};

export { keySelectionChecks };
