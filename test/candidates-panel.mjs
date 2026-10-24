import assert from 'node:assert/strict';

import {
    PAGE_SIZE, busyInputAction, candidatePose, eyePreviewPose, levelOptions, showTiltWarning, togglePick, visibleItems
} from './.build/src/candidates/panel-model.js';

const candidatesPanelChecks = {
    'candidates panel: picks keep click order and toggle off': async () => {
        let picks = [];
        for (const id of ['b', 'a', 'c', 'a', 'd']) picks = togglePick(picks, id);
        assert.deepEqual(picks, ['b', 'c', 'd']);
    },

    'candidates panel: levels are numbered from the lowest': async () => {
        const options = levelOptions([
            { index: 0, height: 4.2, area: 30 },
            { index: 1, height: 0.1, area: 90 }
        ]);
        assert.deepEqual(options.map(o => [o.index, o.number]), [[1, 1], [0, 2]]);
    },

    'candidates panel: filter and pages': async () => {
        const items = Array.from({ length: 100 }, (_, i) => ({ level: i % 2 }));
        assert.deepEqual([visibleItems(items, null, 1).shown.length, visibleItems(items, null, 1).more], [PAGE_SIZE, 100 - PAGE_SIZE]);
        const odd = visibleItems(items, 1, 2);
        assert.equal(odd.shown.length, 50);
        assert.equal(odd.more, 0);
        assert.ok(odd.shown.every(i => i.level === 1));
    },

    'candidates panel: candidate pose targets the median depth': async () => {
        const pose = candidatePose({ position: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: 0, z: -1 }, depth: 4, fov: 50 });
        assert.deepEqual(pose, { position: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: -1 }, fov: 50 });
    },

    'candidates panel: eye preview stands at eye height over the box centre': async () => {
        const pose = eyePreviewPose({ min: { x: -2, y: 1, z: 0 }, max: { x: 4, y: 9, z: 10 } }, 1.6, 60);
        assert.deepEqual(pose.position, { x: 1, y: 2.6, z: 5 });
        assert.equal(pose.target.y, 2.6);
        assert.ok(pose.target.z < 5);
    },

    'candidates panel: while generating only panel pointers and Enter/Space on Cancel get through': async () => {
        const act = (type, inPanel, extra = {}) => busyInputAction({ type, inPanel, onCancel: false, ...extra });
        assert.equal(act('pointerdown', true), 'pass');
        assert.equal(act('wheel', false), 'block');
        assert.equal(act('keydown', false, { key: 'Escape' }), 'cancel');
        assert.equal(act('keydown', true, { key: 'Escape' }), 'cancel');
        for (const key of ['f', 'w', 'z', 'Delete', ' ', 'Enter']) {
            assert.equal(act('keydown', true, { key }), 'block', key);
        }
        assert.equal(act('keydown', true, { key: 'Enter', onCancel: true }), 'pass');
        assert.equal(act('keydown', true, { key: ' ', onCancel: true }), 'pass');
        assert.equal(act('keydown', true, { key: 'f', onCancel: true }), 'block');
    },

    'candidates panel: tilt warning above 10 degrees only': async () => {
        assert.deepEqual([showTiltWarning(4), showTiltWarning(10), showTiltWarning(12)], [false, false, true]);
    }
};

export { candidatesPanelChecks };
