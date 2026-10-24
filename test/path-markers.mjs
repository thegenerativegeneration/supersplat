import assert from 'node:assert/strict';

import { blockedBands, fixReport, keyStyles } from './.build/src/path/markers.js';

const NONE = { detours: 0, unreachable: [], blocked: [], insideGeometry: [] };

const pathMarkersChecks = {
    'path markers: a blocked segment spans its key to the next key': async () => {
        assert.deepEqual(blockedBands([0, 30, 60, 90], [30], false, 119), [[30, 60]]);
        assert.deepEqual(blockedBands([60, 0, 90, 30], [60, 0], false, 119), [[0, 30], [60, 90]]);
    },

    'path markers: the closing segment wraps only when looping': async () => {
        assert.deepEqual(blockedBands([10, 50, 90], [90], false, 119), []);
        assert.deepEqual(blockedBands([10, 50, 90], [90], true, 119), [[90, 119], [0, 10]]);
        // the first key at frame 0 leaves no piece before it
        assert.deepEqual(blockedBands([0, 50, 90], [90], true, 119), [[90, 119]]);
    },

    'path markers: bands stop at the timeline end and ignore unknown frames': async () => {
        assert.deepEqual(blockedBands([0, 50, 200], [50, 7], false, 119), [[50, 119]]);
        assert.deepEqual(blockedBands([0], [0], true, 119), []);
    },

    'path markers: key styles mark auto and unreachable keys by frame': async () => {
        const styles = keyStyles([
            { name: 'camera_0', frame: 0 },
            { name: 'camera_1', frame: 20, auto: true },
            { name: 'camera_2', frame: 40 }
        ], { blocked: [20], unreachable: ['camera_2'], insideGeometry: ['camera_0'] });
        assert.deepEqual([...styles.entries()], [
            [20, { auto: true, unreachable: false }],
            [40, { auto: false, unreachable: true }]
        ]);
    },

    'path markers: a clean run needs no report': async () => {
        assert.equal(fixReport({ ok: true, ...NONE, detours: 3 }), null);
    },

    'path markers: failed runs report an error, except changed keys': async () => {
        assert.deepEqual(fixReport({ ok: false, reason: 'tooFewKeys', ...NONE }),
            { type: 'error', lines: [{ key: 'fix-path.tooFewKeys' }] });
        assert.deepEqual(fixReport({ ok: false, reason: 'noSplats', ...NONE }).lines, [{ key: 'fix-path.noSplats' }]);
        assert.deepEqual(fixReport({ ok: false, reason: 'rejected', ...NONE }).lines, [{ key: 'fix-path.rejected' }]);
        // the Fix path event already explains this one
        assert.equal(fixReport({ ok: false, reason: 'keysChanged', ...NONE }), null);
    },

    'path markers: problems are listed in one info report': async () => {
        const report = fixReport({
            ok: true,
            ...NONE,
            unreachable: ['camera_5', 'camera_27'],
            blocked: [300, 120],
            insideGeometry: ['camera_2']
        });
        assert.deepEqual(report, {
            type: 'info',
            lines: [
                { key: 'fix-path.unreachable', params: { names: 'camera_5, camera_27' } },
                { key: 'fix-path.blocked', params: { frames: '120, 300' } },
                { key: 'fix-path.inside-geometry', params: { names: 'camera_2' } }
            ]
        });
        assert.deepEqual(fixReport({ ok: true, ...NONE, blocked: [40] }).lines.map(l => l.key), ['fix-path.blocked']);
    }
};

export { pathMarkersChecks };
