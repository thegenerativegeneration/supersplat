// Timeline marker geometry and the report shown after a Fix path run.

type MarkerSet = { blocked: readonly number[], unreachable: readonly string[], insideGeometry: readonly string[] };

type KeyInfo = { name: string, frame: number, auto?: boolean };

type KeyStyle = { auto: boolean, unreachable: boolean };

type ReportLine = { key: string, params?: Record<string, string> };

// error and info are popups; status is a brief non-modal line
type FixReport = { type: 'error' | 'info' | 'status', lines: ReportLine[] };

type FixOutcome = MarkerSet & { ok: boolean, reason?: string, detours: number };

// reasons the Fix path event explains itself
const SELF_REPORTED = new Set(['keysChanged']);

// Frame ranges [from, to] of the blocked segments, each from the key at a
// blocked frame to the next key, clamped to the timeline. With looping the
// last key's segment wraps to the first key in two pieces.
const blockedBands = (keyFrames: readonly number[], blocked: readonly number[], loop: boolean, lastFrame: number) => {
    const keys = [...new Set(keyFrames)].sort((a, b) => a - b);
    const bands: [number, number][] = [];
    const add = (from: number, to: number) => {
        const a = Math.min(from, lastFrame), b = Math.min(to, lastFrame);
        if (b > a) bands.push([a, b]);
    };
    for (const frame of [...blocked].sort((a, b) => a - b)) {
        const index = keys.indexOf(frame);
        if (index === -1) continue;
        if (index < keys.length - 1) {
            add(frame, keys[index + 1]);
        } else if (loop && keys.length > 1) {
            add(frame, lastFrame);
            add(0, keys[0]);
        }
    }
    return bands;
};

// styles of the keys that differ from a plain user key, by frame
const keyStyles = (keys: readonly KeyInfo[], markers: MarkerSet) => {
    const unreachable = new Set(markers.unreachable);
    const styles = new Map<number, KeyStyle>();
    for (const key of [...keys].sort((a, b) => a.frame - b.frame)) {
        const style = { auto: !!key.auto, unreachable: unreachable.has(key.name) };
        if (style.auto || style.unreachable) styles.set(key.frame, style);
    }
    return styles;
};

// what to tell the user after a run: an error, the problems left, or a status line
const fixReport = (result: FixOutcome): FixReport | null => {
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
    return lines.length ? { type: 'info', lines } : {
        type: 'status',
        lines: [{ key: 'fix-path.status', params: { count: String(result.detours) } }]
    };
};

export { blockedBands, fixReport, keyStyles };
export type { FixReport, KeyInfo, KeyStyle, MarkerSet, ReportLine };
