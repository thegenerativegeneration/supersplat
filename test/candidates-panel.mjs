import assert from 'node:assert/strict';

import { createOpening } from './.build/src/candidates/opening.js';
import {
    PAGE_SIZE, barPercent, busyInputAction, candidatePose, eyePreviewPose, levelOptions, showTiltWarning, togglePick, visibleItems
} from './.build/src/candidates/panel-model.js';

const deferred = () => {
    const d = {};
    d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }));
    return d;
};

const openingHarness = () => {
    const wait = deferred();
    const log = { prepares: 0, loading: 0, filled: [], failed: [], progress: [] };
    const opening = createOpening({
        prepare: (onProgress) => {
            log.prepares++;
            onProgress('reading', 1, 2);
            return wait.promise;
        },
        onProgress: (...args) => log.progress.push(args),
        onLoading: () => log.loading++,
        onReady: v => log.filled.push(v),
        onFailed: e => log.failed.push(e)
    });
    return { wait, log, opening };
};

const candidatesPanelChecks = {
    'panel: the bar fills for a known total and pulses for an unknown one': async () => {
        assert.equal(barPercent(1, 4), 25);
        assert.equal(barPercent(0, 10), 0);
        assert.equal(barPercent(10, 10), 100);
        assert.equal(barPercent(), null);
        assert.equal(barPercent(0, 0), null);
    },

    'panel: opens before the estimate resolves and shows reading': async () => {
        const { wait, log, opening } = openingHarness();
        const opened = opening.open();
        assert.equal(log.loading, 1);
        assert.equal(opening.ready(), false);
        assert.deepEqual(log.progress, [['reading', 1, 2]]);
        assert.equal(log.filled.length, 0);
        wait.resolve({ points: 3 });
        await opened;
        assert.deepEqual(log.filled, [{ points: 3 }]);
        assert.equal(opening.ready(), true);
    },

    'panel: closing while reading detaches and a late estimate fills nothing': async () => {
        const { wait, log, opening } = openingHarness();
        const opened = opening.open();
        opening.close();
        wait.resolve({ points: 3 });
        await opened;
        assert.equal(log.filled.length, 0);
        assert.equal(log.failed.length, 0);
    },

    'panel: reopening after close reuses the pending estimate': async () => {
        const { wait, log, opening } = openingHarness();
        const first = opening.open();
        opening.close();
        const second = opening.open();
        wait.resolve({ points: 3 });
        await Promise.all([first, second]);
        assert.equal(log.prepares, 1);
        assert.deepEqual(log.filled, [{ points: 3 }]);
        await opening.open();
        assert.equal(log.prepares, 1);
        assert.equal(log.filled.length, 2);
    },

    'panel: a failed estimate is reported and the next open prepares again': async () => {
        const { wait, log, opening } = openingHarness();
        const opened = opening.open();
        wait.reject(new Error('boom'));
        await opened;
        assert.equal(log.failed.length, 1);
        await opening.open().catch(() => {});
        assert.equal(log.prepares, 2);
    },

    'panel: a forgotten estimate is prepared again': async () => {
        const { wait, log, opening } = openingHarness();
        wait.resolve({ points: 3 });
        await opening.open();
        opening.forget();
        assert.equal(opening.ready(), false);
        await opening.open();
        assert.equal(log.prepares, 2);
    },

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

    'candidates panel: levels without candidates are not listed': async () => {
        const levels = [
            { index: 0, height: 0.1, area: 30 },
            { index: 1, height: 3, area: 90 },
            { index: 2, height: 6, area: 90 }
        ];
        const options = levelOptions(levels, [{ level: 0 }, { level: 2 }, { level: 2 }]);
        assert.deepEqual(options.map(o => [o.index, o.number]), [[0, 1], [2, 3]]);
        assert.deepEqual(levelOptions(levels, []), []);
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
