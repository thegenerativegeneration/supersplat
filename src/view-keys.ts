import { Vec3 } from 'playcanvas';

import { BalanceResult } from './anim/balance-timing';
import { Pose } from './camera-poses';
import { Vec3Like } from './candidates/occupancy';
import { Events } from './events';
import { BalanceSource, computeBalance, showBalanceFailure } from './timing-events';

type ViewPick = { position: Vec3Like, direction: Vec3Like, fov: number, depth: number };

// Frames for existing keys (sorted) followed by `added` new keys when balancing
// is not possible: existing keys are scaled into [0, frames - 1 - added * gap]
// and the new keys follow at multiples of gap.
const fallbackAppendFrames = (existing: number[], added: number, frames: number): number[] => {
    const total = existing.length + added;
    const last = frames - 1;
    if (total <= 1) return Array.from({ length: total }, () => 0);
    if (existing.length === 0) {
        return Array.from({ length: total }, (_, i) => Math.round(i * last / (total - 1)));
    }

    const gap = Math.max(1, Math.floor(last / (total - 1)));
    const hi = Math.max(0, last - added * gap);
    const end = existing[existing.length - 1];
    const result: number[] = [];
    existing.forEach((f, i) => {
        const scaled = end > 0 ? Math.round(f * hi / end) : 0;
        result.push(i === 0 ? scaled : Math.max(scaled, result[i - 1] + 1));
    });
    for (let i = 1; i <= added; i++) {
        result.push(result[existing.length - 1] + i * gap);
    }
    return result;
};

const registerViewKeyEvents = (events: Events) => {
    // append picked views as camera keys and balance the timing of all keys,
    // as one undo step. Falls back to simple spacing when balancing refuses.
    events.function('views.addKeys', async (views: ViewPick[]): Promise<BalanceResult> => {
        const existing = (events.invoke('camera.poses') as Pose[]).slice().sort((a, b) => a.frame - b.frame);
        const fallbackFov = events.invoke('camera.fov') as number;

        const added = views.map(v => ({
            position: new Vec3(v.position.x, v.position.y, v.position.z),
            target: new Vec3(
                v.position.x + v.direction.x * v.depth,
                v.position.y + v.direction.y * v.depth,
                v.position.z + v.direction.z * v.depth
            ),
            fov: v.fov
        }));

        const sources: BalanceSource[] = [
            ...existing.map(p => ({
                position: p.position,
                target: p.target,
                fov: p.fov ?? fallbackFov,
                linger: p.linger ?? 0
            })),
            ...added.map(a => ({ ...a, linger: 0 }))
        ];

        const { result, changed } = await computeBalance(events, sources);
        if (changed) {
            await showBalanceFailure(events, 'keysChanged');
            return result;
        }

        const frames = 'frames' in result ?
            result.frames :
            fallbackAppendFrames(existing.map(p => p.frame), added.length, events.invoke('timeline.frames'));
        events.fire('track.appendPoses', added, frames);

        // a lone key needs no balancing, so tooFewKeys is not worth a popup
        if ('reason' in result && result.reason !== 'tooFewKeys') {
            await showBalanceFailure(events, result.reason);
        }
        return result;
    });
};

export { registerViewKeyEvents, fallbackAppendFrames, ViewPick };
