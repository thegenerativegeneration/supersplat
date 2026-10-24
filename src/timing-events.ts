import { balanceTiming, BalanceInput, BalanceKey, BalanceResult } from './anim/balance-timing';
import { Pose } from './camera-poses';
import { Events } from './events';
import { i18n } from './ui/localization';

type BalanceSource = { position: Pose['position'], target: Pose['target'], fov: number, linger: number };

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

const snapshotOf = (events: Events) => (events.invoke('camera.poses') as Pose[])
.slice()
.sort((a, b) => a.frame - b.frame)
.map(p => `${p.name}@${p.frame}`)
.join('|');

// the timeline values Balance works with, rotation weight clamped to [0, 4]
const timelineSettings = (events: Events): Omit<BalanceInput, 'keys'> => ({
    frames: events.invoke('timeline.frames'),
    frameRate: events.invoke('timeline.frameRate'),
    smoothness: events.invoke('timeline.smoothness'),
    loop: events.invoke('timeline.loop'),
    rotationWeight: Math.min(4, Math.max(0, finiteOr(events.invoke('timeline.rotationWeight'), 1)))
});

// samples scene distances for the given poses (in playback order) and balances
// their timing. changed is true when the track keys moved while sampling, in
// which case the result is a keysChanged failure.
const computeBalance = async (events: Events, poses: BalanceSource[]): Promise<{ result: BalanceResult, changed: boolean }> => {
    const snapshot = snapshotOf(events);
    const sampleStart = performance.now();
    // too few keys fails below without needing the scene
    const distances = (poses.length >= 2 ?
        await events.invoke('camera.sampleDistances', poses.map(p => ({ position: p.position, target: p.target, fov: p.fov }))) :
        []) as (number | null)[];
    const sampleMs = performance.now() - sampleStart;

    // the keys moved while sampling; the computed frames would not match them
    if (snapshotOf(events) !== snapshot) {
        return { result: { ok: false, reason: 'keysChanged' }, changed: true };
    }

    const keys: BalanceKey[] = poses.map((p, i) => ({
        position: p.position,
        target: p.target,
        fov: p.fov,
        linger: Math.max(0, finiteOr(p.linger, 0)),
        distance: distances[i] ?? NaN
    }));

    const result = balanceTiming({ keys, ...timelineSettings(events) });

    const outcome = 'reason' in result ? `failed (${result.reason})` : `${result.iterations} iterations`;
    console.debug(`timing.balance: sampled ${poses.length} keys in ${sampleMs.toFixed(1)} ms, ${outcome}`);

    return { result, changed: false };
};

const showBalanceFailure = (events: Events, reason: string) => events.invoke('showPopup', {
    type: 'error',
    header: i18n.t('popup.balance.failed'),
    message: i18n.t(`popup.balance.${reason}`)
});

const registerTimingEvents = (events: Events) => {
    // retime the camera keys so the camera moves at a steady perceived speed,
    // as one undo step. Leaves the keys untouched and explains why on failure.
    events.function('timing.balance', async (): Promise<BalanceResult> => {
        const poses = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        const fallbackFov = events.invoke('camera.fov') as number;
        const sources: BalanceSource[] = poses.map(p => ({
            position: p.position,
            target: p.target,
            fov: p.fov ?? fallbackFov,
            linger: p.linger ?? 0
        }));

        const { result } = await computeBalance(events, sources);

        if ('frames' in result) {
            events.fire('track.retime', result.frames);
        } else {
            await showBalanceFailure(events, result.reason);
        }

        return result;
    });
};

export { registerTimingEvents, computeBalance, finiteOr, showBalanceFailure, snapshotOf, timelineSettings, BalanceSource };
