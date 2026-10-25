// Texts the Orbit popover shows: the key count, the short-shot warning and the
// report after Add Orbit.

import { clampSpan, DEG_PER_KEY } from './orbit-path';
import type { OrbitAddResult } from '../orbit-events';
import { motionLine, type FixReport, type ReportLine } from '../path/markers';

// reasons the orbit events explain themselves (Balance shows its own popup)
const SELF_REPORTED = new Set(['keysChanged']);

// keys of an orbit with this span, the closing key of a full turn included
const orbitKeyCount = (spanDeg: number) => Math.round(clampSpan(spanDeg) / DEG_PER_KEY) + 1;

const seconds = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : '–');

// the warning line when the shot is shorter than the span takes at the turn
// cap, else null
const turnTimeLine = (turnSeconds: number, shotSeconds: number): ReportLine | null => {
    if (!(shotSeconds < turnSeconds)) return null;
    return { key: 'orbit.turn-time', params: { need: seconds(turnSeconds), shot: seconds(shotSeconds) } };
};

// two decimals, then the translated unit
const lengthText = (value: number, unit: string) => `${value.toFixed(2)} ${unit}`;

// What to tell the user after Add Orbit: an error, the problems left, or a
// status line. unit is the translated length unit.
const orbitReport = (result: OrbitAddResult, metric: boolean, unit: string): FixReport | null => {
    if (!result.ok) {
        const reason = result.reason ?? 'rejected';
        return SELF_REPORTED.has(reason) ? null : { type: 'error', lines: [{ key: `orbit.${reason}` }] };
    }
    const lines: ReportLine[] = [{ key: 'orbit.status', params: { count: String(result.added) } }];
    if (result.reduced && Number.isFinite(result.radius)) {
        lines.push({ key: 'orbit.reduced', params: { radius: lengthText(result.radius, unit) } });
    }
    const problems: ReportLine[] = [];
    if (result.orbitBlocked) problems.push({ key: 'orbit.blocked' });
    if (result.joinBlocked) problems.push({ key: 'orbit.join-blocked' });

    // a failed balance has shown its own popup
    const balance = result.balance;
    const motion = balance?.ok ? motionLine(balance.stats, balance.turnLimited, metric) : [];
    const attention = problems.length > 0 || (balance?.ok && balance.turnLimited !== undefined);
    return { type: attention ? 'info' : 'status', lines: [...lines, ...problems, ...motion] };
};

export { orbitKeyCount, orbitReport, turnTimeLine };
