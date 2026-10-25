import assert from 'node:assert/strict';

import { orbitPreviewLine } from './.build/src/orbit/orbit-preview-line.js';
import { orbitKeyCount, orbitReport, turnTimeLine } from './.build/src/orbit/orbit-readout.js';
import { BLOCKED_COLOR, ORBIT_PREVIEW_COLOR } from './.build/src/path/colors.js';

const stats = { avgSpeed: 1.234, peakSpeed: 2.5, peakTurnDegPerSec: 18, avgTurnDegPerSec: 10 };
const okResult = (over = {}) => ({
    ok: true, added: 17, radius: 3, reduced: false, orbitBlocked: false, joinBlocked: false,
    balance: { ok: true, frames: [], iterations: 1, stats }, ...over
});
const keysOf = report => report.lines.map(l => l.key);

const preview = (over = {}) => ({
    keys: [], blockedRanges: [], centre: { x: 1, y: 2, z: 3 }, radius: 2, height: 0.5,
    startDeg: 0, spanDeg: 360, dir: 1, ...over
});
const colorOf = (colors, line) => colors.slice(line * 6, line * 6 + 3);

const orbitReadoutChecks = {
    'orbit readout: key count includes the closing key and follows the span rounding'() {
        assert.equal(orbitKeyCount(360), 17);
        assert.equal(orbitKeyCount(90), 5);
        assert.equal(orbitKeyCount(100), 5);
        assert.equal(orbitKeyCount(10), 5);
        assert.equal(orbitKeyCount(NaN), 17);
    },

    'orbit readout: turn-time line only when the shot is too short'() {
        assert.equal(turnTimeLine(18, 20), null);
        assert.equal(turnTimeLine(18, 18), null);
        assert.deepEqual(turnTimeLine(18, 10), { key: 'orbit.turn-time', params: { need: '18.0', shot: '10.0' } });
    },

    'orbit readout: clean add is a status line with count and speed'() {
        const report = orbitReport(okResult(), true, 'm');
        assert.equal(report.type, 'status');
        assert.deepEqual(keysOf(report), ['orbit.status', 'timing.speed']);
        assert.equal(report.lines[0].params.count, '17');
    },

    'orbit readout: reduced radius is reported with its unit'() {
        const report = orbitReport(okResult({ reduced: true, radius: 1.5 }), false, 'units');
        assert.equal(report.type, 'status');
        assert.deepEqual(report.lines[1], { key: 'orbit.reduced', params: { radius: '1.50 units' } });
    },

    'orbit readout: blocked joins and turn limits open a popup'() {
        const join = orbitReport(okResult({ joinBlocked: true }), true, 'm');
        assert.equal(join.type, 'info');
        assert.ok(keysOf(join).includes('orbit.join-blocked'));
        const inside = orbitReport(okResult({ orbitBlocked: true }), true, 'm');
        assert.ok(keysOf(inside).includes('orbit.blocked'));
        const turn = orbitReport(okResult({ balance: { ok: true, frames: [], iterations: 1, stats, turnLimited: 30 } }), true, 'm');
        assert.equal(turn.type, 'info');
        assert.ok(keysOf(turn).includes('timing.turn-limited'));
    },

    'orbit readout: failures are errors, keysChanged reports itself'() {
        const none = { added: 0, orbitBlocked: false, joinBlocked: false };
        assert.deepEqual(orbitReport({ ok: false, reason: 'blocked', ...none }, true, 'm'), { type: 'error', lines: [{ key: 'orbit.blocked' }] });
        assert.equal(orbitReport({ ok: false, reason: 'tooFewFrames', ...none }, true, 'm').lines[0].key, 'orbit.tooFewFrames');
        assert.equal(orbitReport({ ok: false, reason: 'keysChanged', ...none }, true, 'm'), null);
        // a failed balance showed its own popup; the orbit itself is still reported
        const report = orbitReport(okResult({ balance: { ok: false, reason: 'tooFewFrames' } }), true, 'm');
        assert.deepEqual(keysOf(report), ['orbit.status']);
    }
};

const orbitPreviewChecks = {
    'orbit preview: the arc lies on the circle at the orbit height and closes'() {
        const { positions } = orbitPreviewLine(preview());
        const arcLines = 180;
        assert.equal(positions.length / 6, arcLines + 3);
        for (let v = 0; v < arcLines * 2; v++) {
            const [x, y, z] = positions.slice(v * 3, v * 3 + 3);
            assert.ok(Math.abs(Math.hypot(x - 1, z - 3) - 2) < 1e-9);
            assert.ok(Math.abs(y - 2.5) < 1e-9);
        }
        const first = positions.slice(0, 3);
        const last = positions.slice((arcLines * 2 - 1) * 3, arcLines * 2 * 3);
        first.forEach((c, i) => assert.ok(Math.abs(c - last[i]) < 1e-9));
    },

    'orbit preview: lines in blocked ranges are red, across the -180/180 seam too'() {
        const { positions, colors } = orbitPreviewLine(preview({ spanDeg: 90, startDeg: 0, dir: 1, blockedRanges: [[-30, -10]] }));
        // dir 1 decreases the azimuth: lines run 0 → -90 in 2° steps
        assert.deepEqual(colorOf(colors, 0), [...ORBIT_PREVIEW_COLOR]);
        assert.deepEqual(colorOf(colors, 10), [...BLOCKED_COLOR]);
        assert.deepEqual(colorOf(colors, 20), [...ORBIT_PREVIEW_COLOR]);
        assert.equal(positions.length / 6, 45 + 3);

        const seam = orbitPreviewLine(preview({ spanDeg: 90, startDeg: 170, dir: -1, blockedRanges: [[175, 180], [-180, -175]] }));
        // dir -1 increases the azimuth: 170 → 260 (= -100)
        assert.deepEqual(colorOf(seam.colors, 1), [...ORBIT_PREVIEW_COLOR]);
        assert.deepEqual(colorOf(seam.colors, 3), [...BLOCKED_COLOR]);
        assert.deepEqual(colorOf(seam.colors, 6), [...BLOCKED_COLOR]);
        assert.deepEqual(colorOf(seam.colors, 8), [...ORBIT_PREVIEW_COLOR]);
    },

    'orbit preview: a tick per key, nothing for a zero radius'() {
        const keys = [{ position: { x: 3, y: 2.5, z: 3 }, target: { x: 1, y: 2, z: 3 }, fov: 60 }];
        const { positions } = orbitPreviewLine(preview({ keys }));
        assert.equal(positions.length / 6, 180 + 1 + 3);
        assert.deepEqual(orbitPreviewLine(preview({ radius: 0 })).positions, []);
        assert.deepEqual(orbitPreviewLine(preview({ radius: NaN })).positions, []);
    }
};

export { orbitPreviewChecks, orbitReadoutChecks };
