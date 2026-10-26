import assert from 'node:assert/strict';

import { clampGroupOffset, dragIds, markerAction } from './.build/src/ui/key-marker-gestures.js';

const press = (over = {}) => ({ button: 0, shift: false, alt: false, toggle: false, ...over });

const keyMarkerGesturesChecks = {
    'marker gestures: click selects, drag moves, Alt+drag copies, right button edits'() {
        const cases = [
            ['plain click', press(), false, 0, { kind: 'select', gesture: { shift: false, toggle: false } }],
            ['drag', press(), true, 5, { kind: 'move', offset: 5 }],
            ['drag left', press(), true, -3, { kind: 'move', offset: -3 }],
            ['Alt+drag', press({ alt: true }), true, 5, { kind: 'copy', offset: 5 }],
            ['right button', press({ button: 2 }), false, 0, { kind: 'edit' }],
            ['right button after a drag', press({ button: 2 }), true, 4, { kind: 'edit' }],
            ['Shift+click', press({ shift: true }), false, 0, { kind: 'select', gesture: { shift: true, toggle: false } }],
            ['Cmd/Ctrl+click', press({ toggle: true }), false, 0, { kind: 'select', gesture: { shift: false, toggle: true } }],
            ['middle button', press({ button: 1 }), false, 0, { kind: 'none' }],
            ['dragged back to its frame', press(), true, 0, { kind: 'none' }],
            ['Alt+drag back to its frame', press({ alt: true }), true, 0, { kind: 'none' }]
        ];
        for (const [name, e, moved, offset, expected] of cases) {
            assert.deepEqual(markerAction(e, moved, offset), expected, name);
        }
    },

    'marker gestures: a click without movement never moves or copies'() {
        for (const over of [{}, { alt: true }, { shift: true }, { toggle: true }, { alt: true, shift: true }]) {
            for (const offset of [0, 1, -1, 12]) {
                const action = markerAction(press(over), false, offset);
                assert.equal(action.kind, 'select', `${JSON.stringify(over)} offset ${offset}`);
            }
        }
    },

    'marker gestures: a drag takes the selection when the key is in it, else only the key'() {
        assert.deepEqual(dragIds(['a', 'b', 'c'], 'b'), ['a', 'b', 'c']);
        assert.deepEqual(dragIds(['a', 'c'], 'b'), ['b']);
        assert.deepEqual(dragIds([], 'b'), ['b']);
    },

    'marker gestures: a group offset keeps every key at frame 0 or later and in-range keys on the timeline'() {
        const last = 99;
        const cases = [
            ['inside', [10, 20], 5, 5],
            ['stops at frame 0', [10, 20], -15, -10],
            ['stops at the last frame', [10, 90], 20, 9],
            ['single key', [40], -60, -40],
            ['a pinned key does not block moving right', [10, 120], 30, 30],
            ['the in-range keys still stop at the end', [10, 80, 120], 30, 19],
            ['a pinned key alone can land in range', [130], -50, -50]
        ];
        for (const [name, frames, offset, expected] of cases) {
            assert.equal(clampGroupOffset(frames, offset, last), expected, name);
        }
    }
};

export { keyMarkerGesturesChecks };
