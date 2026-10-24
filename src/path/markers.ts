// Timeline marker geometry and the report shown after a Fix path run.

import { MAX_TURN_DEG_PER_SEC, type BalanceResult, type MotionStats } from '../anim/balance-timing';

type MarkerSet = { blocked: readonly number[], unreachable: readonly string[], insideGeometry: readonly string[] };

type KeyInfo = { name: string, frame: number, auto?: boolean, parked?: boolean };

type KeyStyle = { auto: boolean, unreachable: boolean };

// keyParams values are locale keys, translated before they fill the line
type ReportLine = { key: string, params?: Record<string, string>, keyParams?: Record<string, string> };

// error and info are popups; status is a brief non-modal line
type FixReport = { type: 'error' | 'info' | 'status', lines: ReportLine[] };

type FixOutcome = MarkerSet & { ok: boolean, reason?: string, detours: number, balance?: BalanceResult };

// reasons the Fix path event explains itself
const SELF_REPORTED = new Set(['keysChanged']);

// Frame ranges [from, to] of the blocked segments, each from the user key
// at a blocked frame through any detour keys to the next user key, clamped
// to the timeline. With looping the last user key's segment wraps to the
// first user key in two pieces.
const blockedBands = (keys: readonly { frame: number, auto?: boolean }[], blocked: readonly number[], loop: boolean, lastFrame: number) => {
    const user = [...new Set(keys.filter(k => !k.auto).map(k => k.frame))].sort((a, b) => a - b);
    const bands: [number, number][] = [];
    const add = (from: number, to: number) => {
        const a = Math.min(from, lastFrame), b = Math.min(to, lastFrame);
        if (b > a) bands.push([a, b]);
    };
    for (const frame of [...blocked].sort((a, b) => a - b)) {
        const index = user.indexOf(frame);
        if (index === -1) continue;
        if (index < user.length - 1) {
            add(frame, user[index + 1]);
        } else if (loop && user.length > 1) {
            add(frame, lastFrame);
            add(0, user[0]);
        }
    }
    return bands;
};

// styles of the keys that differ from a plain user key, by frame; keys
// parked after the end of the shot (at or past duration) count as unreachable
const keyStyles = (keys: readonly KeyInfo[], markers: MarkerSet, duration = Infinity) => {
    const unreachable = new Set(markers.unreachable);
    const styles = new Map<number, KeyStyle>();
    for (const key of [...keys].sort((a, b) => a.frame - b.frame)) {
        const parked = !!key.parked && key.frame >= duration;
        const style = { auto: !!key.auto, unreachable: parked || unreachable.has(key.name) };
        if (style.auto || style.unreachable) styles.set(key.frame, style);
    }
    return styles;
};

// two significant digits: 0.012, 1.2, 12, 120
const round2 = (value: number) => String(Number(value.toPrecision(2)));

// the camera speed after a retime, and a warning when the turn cap could not be met
const motionLine = (stats: MotionStats, turnLimited: number | undefined, metric: boolean): ReportLine[] => {
    const turn = String(Math.round(turnLimited ?? stats.peakTurnDegPerSec));
    const lines: ReportLine[] = [{
        key: 'timing.speed',
        params: { avg: round2(stats.avgSpeed), peak: round2(stats.peakSpeed), turn },
        keyParams: { unit: metric ? 'fix-path.unit-metres' : 'fix-path.unit-scene' }
    }];
    if (turnLimited !== undefined) {
        lines.push({ key: 'timing.turn-limited', params: { cap: String(MAX_TURN_DEG_PER_SEC), turn } });
    }
    return lines;
};

// what to tell the user after a run: an error, the problems left, or a status line
const fixReport = (result: FixOutcome, metric = false): FixReport | null => {
    if (!result.ok) {
        const reason = result.reason ?? 'rejected';
        return SELF_REPORTED.has(reason) ? null : { type: 'error', lines: [{ key: `fix-path.${reason}` }] };
    }
    const lines: ReportLine[] = [];
    if (result.unreachable.length) {
        lines.push({ key: 'fix-path.unreachable', params: { names: result.unreachable.join(', ') } });
    }
    if (result.blocked.length) {
        const frames = [...result.blocked].sort((a, b) => a - b).join(', ');
        lines.push({ key: 'fix-path.blocked', params: { frames } });
    }
    if (result.insideGeometry.length) {
        lines.push({ key: 'fix-path.inside-geometry', params: { names: result.insideGeometry.join(', ') } });
    }
    const balance = result.balance;
    const motion = balance?.ok ? motionLine(balance.stats, balance.turnLimited, metric) : [];
    if (lines.length || (balance?.ok && balance.turnLimited !== undefined)) {
        return { type: 'info', lines: lines.concat(motion) };
    }
    return {
        type: 'status',
        lines: [{ key: 'fix-path.status', params: { count: String(result.detours) } }, ...motion]
    };
};

export { blockedBands, fixReport, keyStyles, motionLine };
export type { FixReport, KeyInfo, KeyStyle, MarkerSet, ReportLine };
