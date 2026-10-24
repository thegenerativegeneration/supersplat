import assert from 'node:assert/strict';

import { blockedBands, fixReport, keyStyles, motionLine } from './.build/src/path/markers.js';

const at = (...frames) => frames.map(frame => ({ frame }));

const NONE = { detours: 0, unreachable: [], blocked: [], insideGeometry: [] };

const STATS = { pathLength: 12, avgSpeed: 1.234, peakSpeed: 0.0567, peakTurnDegPerSec: 18.4 };

const pathMarkersChecks = {
    'path markers: a blocked segment spans its key to the next key': async () => {
        assert.deepEqual(blockedBands(at(0, 30, 60, 90), [30], false, 119), [[30, 60]]);
        assert.deepEqual(blockedBands(at(60, 0, 90, 30), [60, 0], false, 119), [[0, 30], [60, 90]]);
    },

    'path markers: a blocked band runs through detour keys to the next user key': async () => {
        const keys = [...at(0, 30), { frame: 40, auto: true }, { frame: 50, auto: true }, ...at(60)];
        assert.deepEqual(blockedBands(keys, [30], false, 119), [[30, 60]]);
        const closing = [...at(0, 50, 90), { frame: 100, auto: true }];
        assert.deepEqual(blockedBands(closing, [90], true, 119), [[90, 119]]);
    },

    'path markers: the closing segment wraps only when looping': async () => {
        assert.deepEqual(blockedBands(at(10, 50, 90), [90], false, 119), []);
        assert.deepEqual(blockedBands(at(10, 50, 90), [90], true, 119), [[90, 119], [0, 10]]);
        // the first key at frame 0 leaves no piece before it
        assert.deepEqual(blockedBands(at(0, 50, 90), [90], true, 119), [[90, 119]]);
    },

    'path markers: bands stop at the timeline end and ignore unknown frames': async () => {
        assert.deepEqual(blockedBands(at(0, 50, 200), [50, 7], false, 119), [[50, 119]]);
        assert.deepEqual(blockedBands(at(0), [0], true, 119), []);
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

    'path markers: parked keys after the shot are marked unreachable': async () => {
        const keys = [{ name: 'camera_0', frame: 0 }, { name: 'camera_1', frame: 181, parked: true }, { name: 'camera_2', frame: 90, parked: true }];
        const styles = keyStyles(keys, { blocked: [], unreachable: [], insideGeometry: [] }, 181);
        // a parked key the timeline has grown over plays again
        assert.deepEqual([...styles.entries()], [[181, { auto: false, unreachable: true }]]);
    },

    'path markers: a clean run gets a status line with the detour count': async () => {
        assert.deepEqual(fixReport({ ok: true, ...NONE, detours: 3 }),
            { type: 'status', lines: [{ key: 'fix-path.status', params: { count: '3' } }] });
        assert.deepEqual(fixReport({ ok: true, ...NONE }).lines[0].params, { count: '0' });
    },

    'path markers: a clean run adds the camera speed to the status line': async () => {
        const report = fixReport({ ok: true, ...NONE, balance: { ok: true, frames: [], iterations: 1, stats: STATS } }, true);
        assert.equal(report.type, 'status');
        assert.deepEqual(report.lines.map(l => l.key), ['fix-path.status', 'timing.speed']);
        assert.deepEqual(report.lines[1].params, { avg: '1.2', peak: '0.057', turn: '18' });
        assert.deepEqual(report.lines[1].keyParams, { unit: 'fix-path.unit-metres' });
        assert.deepEqual(motionLine(STATS, undefined, false)[0].keyParams, { unit: 'fix-path.unit-scene' });
    },

    'path markers: turns that stay fast turn the report into an info with a warning': async () => {
        const balance = { ok: true, frames: [], iterations: 1, stats: STATS, turnLimited: 34 };
        const report = fixReport({ ok: true, ...NONE, balance }, false);
        assert.equal(report.type, 'info');
        assert.deepEqual(report.lines.map(l => l.key), ['timing.speed', 'timing.turn-limited']);
        assert.deepEqual(report.lines[1].params, { cap: '20', turn: '34' });
        assert.equal(report.lines[0].params.turn, '34');
    },

    'path markers: failed runs report an error, except changed keys': async () => {
        assert.deepEqual(fixReport({ ok: false, reason: 'tooFewKeys', ...NONE }),
            { type: 'error', lines: [{ key: 'fix-path.tooFewKeys' }] });
        assert.deepEqual(fixReport({ ok: false, reason: 'noSplats', ...NONE }).lines, [{ key: 'fix-path.noSplats' }]);
        assert.deepEqual(fixReport({ ok: false, reason: 'rejected', ...NONE }).lines, [{ key: 'fix-path.rejected' }]);
        assert.deepEqual(fixReport({ ok: false, reason: 'tooFewFrames', ...NONE }).lines, [{ key: 'fix-path.tooFewFrames' }]);
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
