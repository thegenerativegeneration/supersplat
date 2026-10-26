import { BalanceInput, MAX_TURN_DEG_PER_SEC, BalanceKey, BalanceResult } from './anim/balance-timing';
import { isParked, Pose } from './camera-poses';
import { withProgress } from './compute/progress-handle';
import type { ProgressFn } from './compute/protocol';
import { sampleDistances } from './compute/sample-distances';
import { computeOf, isAbortError } from './compute/scene-compute';
import { Events } from './events';
import { i18n } from './ui/localization';

// auto: a detour key from Fix path, timed by its target distance as when planned
type BalanceSource = { position: Pose['position'], target: Pose['target'], fov: number, linger: number, auto?: boolean };

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

// the timeline values Balance works with, rotation weight clamped to [0, 4]
const timelineSettings = (events: Events): Omit<BalanceInput, 'keys'> => ({
    frames: events.invoke('timeline.frames'),
    frameRate: events.invoke('timeline.frameRate'),
    smoothness: events.invoke('timeline.smoothness'),
    loop: events.invoke('timeline.loop'),
    rotationWeight: Math.min(4, Math.max(0, finiteOr(events.invoke('timeline.rotationWeight'), 1))),
    maxTurnDegPerSec: MAX_TURN_DEG_PER_SEC
});

// the keys by frame (name, frame, view, linger) and the timeline settings a
// run planned with; a different snapshot after an await means they changed
const snapshotOf = (events: Events) => JSON.stringify({
    keys: (events.invoke('camera.poses') as Pose[])
    .slice()
    .sort((a, b) => a.frame - b.frame)
    .map(({ name, frame, position: p, target: t, fov, linger }) => [name, frame, p.x, p.y, p.z, t.x, t.y, t.z, fov ?? null, linger ?? 0]),
    timeline: timelineSettings(events)
});

type BalanceOptions = { signal?: AbortSignal, onProgress?: ProgressFn };

const cancelled = (): { result: BalanceResult, changed: boolean } => ({ result: { ok: false, reason: 'cancelled' }, changed: false });

// samples scene distances for the given non-auto poses (in playback order) and balances
// their timing in the scene compute. changed is true when the track keys moved
// meanwhile, in which case the result is a keysChanged failure; an aborted
// signal gives a cancelled failure.
const computeBalance = async (events: Events, poses: BalanceSource[], opts: BalanceOptions = {}): Promise<{ result: BalanceResult, changed: boolean }> => {
    const { signal, onProgress } = opts;
    const snapshot = snapshotOf(events);
    const sampleStart = performance.now();
    onProgress?.('measuring');
    // too few keys fails below without needing the scene
    const sampled = poses.filter(p => !p.auto);
    let sampledDistances: (number | null)[] = [];
    try {
        if (poses.length >= 2) sampledDistances = await sampleDistances(events, sampled.map(p => ({ position: p.position, target: p.target, fov: p.fov })), signal);
    } catch (error) {
        if (isAbortError(error)) return cancelled();
        throw error;
    }
    if (signal?.aborted) return cancelled();
    const distanceOf = new Map(sampled.map((p, i) => [p, sampledDistances[i] ?? NaN]));
    const sampleMs = performance.now() - sampleStart;

    const keys: BalanceKey[] = poses.map(p => ({
        position: p.position,
        target: p.target,
        fov: p.fov,
        linger: Math.max(0, finiteOr(p.linger, 0)),
        distance: distanceOf.get(p) ?? NaN
    }));

    onProgress?.('timing');
    let result: BalanceResult;
    try {
        result = await computeOf(events).run('balance', { keys, ...timelineSettings(events) }, { signal });
    } catch (error) {
        if (isAbortError(error)) return cancelled();
        throw error;
    }
    if (signal?.aborted) return cancelled();

    // the keys moved meanwhile; the computed frames would not match them
    if (snapshotOf(events) !== snapshot) {
        return { result: { ok: false, reason: 'keysChanged' }, changed: true };
    }

    const outcome = 'reason' in result ? `failed (${result.reason})` : `${result.iterations} iterations`;
    console.debug(`timing.balance: sampled ${sampled.length} keys in ${sampleMs.toFixed(1)} ms, ${outcome}`);

    return { result, changed: false };
};

// Frames for all poses (by frame) from the frames of the balanced ones: parked
// keys keep theirs, the others take balanced frames in order; frames beyond
// them are appended for keys still to be added.
const withParkedFrames = (poses: readonly Pose[], parked: (p: Pose) => boolean, balanced: readonly number[]) => {
    let next = 0;
    const frames = poses.map(p => (parked(p) ? p.frame : balanced[next++]));
    return frames.concat(balanced.slice(next));
};

const showBalanceFailure = (events: Events, reason: string) => events.invoke('showPopup', {
    type: 'error',
    header: i18n.t('popup.balance.failed'),
    message: i18n.t(`popup.balance.${reason}`)
});

const registerTimingEvents = (events: Events) => {
    // retime the camera keys so the camera moves at a steady perceived speed,
    // as one undo step. Keys parked after the shot keep their frames. Leaves
    // the keys untouched and explains why on failure. Runs under the progress
    // dialog; a cancelled run changes nothing.
    events.function('timing.balance', async (): Promise<BalanceResult> => {
        const poses = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        const duration = events.invoke('timeline.frames') as number;
        const parked = (p: Pose) => isParked(p, duration);
        const fallbackFov = events.invoke('camera.fov') as number;
        const sources: BalanceSource[] = poses.filter(p => !parked(p)).map(p => ({
            position: p.position,
            target: p.target,
            fov: p.fov ?? fallbackFov,
            linger: p.linger ?? 0,
            auto: p.auto
        }));

        const result = await withProgress(events, 'progress.balance', async (h) => {
            const balanced = (await computeBalance(events, sources, { signal: h.signal, onProgress: h.update })).result;
            if ('frames' in balanced) events.fire('track.retime', withParkedFrames(poses, parked, balanced.frames));
            return balanced;
        });

        if ('reason' in result && result.reason !== 'cancelled') await showBalanceFailure(events, result.reason);
        return result;
    });
};

export { MAX_TURN_DEG_PER_SEC, registerTimingEvents, computeBalance, finiteOr, showBalanceFailure, snapshotOf, timelineSettings, withParkedFrames, BalanceOptions, BalanceSource };
