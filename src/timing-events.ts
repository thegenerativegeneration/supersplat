import { balanceTiming, BalanceKey, BalanceResult } from './anim/balance-timing';
import { Pose } from './camera-poses';
import { Events } from './events';
import { i18n } from './ui/localization';

type SamplePose = { position: Pose['position'], target: Pose['target'], fov: number };

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

const registerTimingEvents = (events: Events) => {
    // retime the camera keys so the camera moves at a steady perceived speed,
    // as one undo step. Leaves the keys untouched and explains why on failure.
    events.function('timing.balance', async (): Promise<BalanceResult> => {
        const poses = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        const fallbackFov = events.invoke('camera.fov') as number;
        const samples: SamplePose[] = poses.map(p => ({
            position: p.position,
            target: p.target,
            fov: p.fov ?? fallbackFov
        }));

        const snapshot = poses.map(p => `${p.name}@${p.frame}`).join('|');
        const sampleStart = performance.now();
        // too few keys fails below without needing the scene
        const distances = (poses.length >= 2 ?
            await events.invoke('camera.sampleDistances', samples) :
            []) as (number | null)[];
        const sampleMs = performance.now() - sampleStart;

        // the keys moved while sampling; the computed frames would not match them
        const current = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        if (current.map(p => `${p.name}@${p.frame}`).join('|') !== snapshot) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('popup.balance.failed'),
                message: i18n.t('popup.balance.keysChanged')
            });
            return { ok: false, reason: 'keysChanged' };
        }

        const keys: BalanceKey[] = samples.map((s, i) => ({
            position: s.position,
            target: s.target,
            fov: s.fov,
            linger: Math.max(0, finiteOr(poses[i].linger ?? 0, 0)),
            distance: distances[i] ?? NaN
        }));

        const rotationWeight = Math.min(4, Math.max(0, finiteOr(events.invoke('timeline.rotationWeight'), 1)));

        const result = balanceTiming({
            keys,
            frames: events.invoke('timeline.frames'),
            frameRate: events.invoke('timeline.frameRate'),
            smoothness: events.invoke('timeline.smoothness'),
            loop: events.invoke('timeline.loop'),
            rotationWeight
        });

        const outcome = 'reason' in result ? `failed (${result.reason})` : `${result.iterations} iterations`;
        console.debug(`timing.balance: sampled ${poses.length} keys in ${sampleMs.toFixed(1)} ms, ${outcome}`);

        if ('frames' in result) {
            events.fire('track.retime', result.frames);
        } else {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('popup.balance.failed'),
                message: i18n.t(`popup.balance.${result.reason}`)
            });
        }

        return result;
    });
};

export { registerTimingEvents };
