import { abortError, untilAborted } from './scene-compute';
import type { Events } from '../events';

type SamplePose = { position: { x: number, y: number, z: number }, target: { x: number, y: number, z: number }, fov: number };

// poses per camera.sampleDistances call, so a cancel waits for at most these
const BATCH = 4;

// camera.sampleDistances over poses, in batches; rejects with a cancelled
// AbortError as soon as signal aborts, leaving the batch in flight to finish
// on its own
const sampleDistances = async (events: Events, poses: SamplePose[], signal?: AbortSignal): Promise<(number | null)[]> => {
    const out: (number | null)[] = [];
    for (let i = 0; i < poses.length; i += BATCH) {
        if (signal?.aborted) throw abortError('cancelled');
        const batch = events.invoke('camera.sampleDistances', poses.slice(i, i + BATCH)) as Promise<(number | null)[]>;
        out.push(...await untilAborted(batch, signal));
    }
    return out;
};

export { sampleDistances };
export type { SamplePose };
