import { Vec3 } from 'playcanvas';

import { Pose } from './camera-poses';

const MAX_LINGER = 60;

type KeyChange = {
    id: string,
    frame?: number,
    position?: Vec3,
    target?: Vec3,
    fov?: number,
    linger?: number,
    lookAhead?: boolean,
    turnIn?: number
};

type KeyRefusal = 'frameTaken' | 'unknownKey' | 'outOfRange';

let keyIdCounter = 0;
const keyIdSuffix = Math.random().toString(36).slice(2, 8);

// unique within the session
const newKeyId = () => `k${++keyIdCounter}${keyIdSuffix}`;

// the next free camera_N name
const nextNamer = (poses: readonly { name: string }[]) => {
    let next = 1 + Math.max(-1, ...poses.map(p => Number(/^camera_(\d+)$/.exec(p.name)?.[1] ?? -1)));
    return () => `camera_${next++}`;
};

const copyPose = (p: Pose): Pose => ({
    id: p.id,
    name: p.name,
    frame: p.frame,
    position: p.position.clone(),
    target: p.target.clone(),
    fov: p.fov,
    linger: p.linger,
    auto: p.auto,
    parked: p.parked,
    orbit: p.orbit,
    lookAhead: p.lookAhead,
    turnIn: p.turnIn
});

// gives every pose an id and renames repeated names; the track keeps the result
const withIds = (poses: Pose[]): Pose[] => {
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    const free = nextNamer(poses);
    for (const p of poses) {
        if (!p.id || seenIds.has(p.id)) p.id = newKeyId();
        seenIds.add(p.id);
        if (seenNames.has(p.name)) p.name = free();
        seenNames.add(p.name);
    }
    return poses;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// applies a change to a pose; returns whether anything differed
const applyKeyChange = (pose: Pose, c: KeyChange): boolean => {
    const differs =
        (c.frame !== undefined && c.frame !== pose.frame) ||
        (c.linger !== undefined && clamp(c.linger, 0, MAX_LINGER) !== (pose.linger ?? 0)) ||
        (c.lookAhead !== undefined && c.lookAhead !== !!pose.lookAhead) ||
        (c.turnIn !== undefined && clamp(c.turnIn, 0.1, 10) !== pose.turnIn);
    const viewDiffers =
        (c.position !== undefined && !c.position.equals(pose.position)) ||
        (c.target !== undefined && !c.target.equals(pose.target)) ||
        (c.fov !== undefined && c.fov !== pose.fov);
    if (!differs && !viewDiffers) return false;

    if (c.frame !== undefined) pose.frame = c.frame;
    if (c.position) pose.position = c.position.clone();
    if (c.target) pose.target = c.target.clone();
    if (c.fov !== undefined) pose.fov = c.fov;
    if (c.linger !== undefined) pose.linger = clamp(c.linger, 0, MAX_LINGER);
    if (c.lookAhead !== undefined) pose.lookAhead = c.lookAhead;
    if (c.turnIn !== undefined) pose.turnIn = clamp(c.turnIn, 0.1, 10);
    pose.auto = undefined;
    if (viewDiffers) pose.orbit = undefined;
    return true;
};

// the distinct poses for the ids, or null when one is unknown
const posesById = (poses: Pose[], ids: string[]): Pose[] | null => {
    const found = [...new Set(ids)].map(id => poses.find(p => p.id === id));
    return found.every(Boolean) ? found : null;
};

// Changes the poses in place. Refuses, changing nothing, when an id is
// unknown, a frame is negative, or two keys would share a frame.
const updateKeysIn = (poses: Pose[], changes: KeyChange[]): true | KeyRefusal | false => {
    const byId = new Map(poses.map(p => [p.id, p]));
    if (changes.some(c => !byId.has(c.id))) return 'unknownKey';
    if (changes.some(c => c.frame !== undefined && !(c.frame >= 0))) return 'outOfRange';

    const frames = new Map(poses.map(p => [p.id, p.frame]));
    for (const c of changes) {
        if (c.frame !== undefined) frames.set(c.id, c.frame);
    }
    if (new Set(frames.values()).size !== frames.size) return 'frameTaken';

    let changed = false;
    for (const c of changes) {
        changed = applyKeyChange(byId.get(c.id), c) || changed;
    }
    return changed;
};

const moveKeysIn = (poses: Pose[], ids: string[], offset: number): true | KeyRefusal | false => {
    if (!Number.isFinite(offset)) return false;
    const moved = posesById(poses, ids);
    if (!moved) return 'unknownKey';
    if (offset === 0) return false;
    return updateKeysIn(poses, moved.map(p => ({ id: p.id, frame: p.frame + offset })));
};

// Returns plain copies of the keys offset frames away (no auto, orbit or
// parked), or a refusal or false without touching the poses.
const copyKeysIn = (
    poses: Pose[], ids: string[], offset: number, newId: () => string, nextName: () => string
): Pose[] | KeyRefusal | false => {
    if (!Number.isFinite(offset)) return false;
    const source = posesById(poses, ids);
    if (!source) return 'unknownKey';
    if (offset === 0 || source.length === 0) return false;
    if (source.some(p => p.frame + offset < 0)) return 'outOfRange';

    const taken = new Set(poses.map(p => p.frame));
    if (source.some(p => taken.has(p.frame + offset))) return 'frameTaken';

    return source.map(p => ({
        id: newId(),
        name: nextName(),
        frame: p.frame + offset,
        position: p.position.clone(),
        target: p.target.clone(),
        fov: p.fov,
        linger: p.linger,
        lookAhead: p.lookAhead,
        turnIn: p.turnIn
    }));
};

export { MAX_LINGER, newKeyId, nextNamer, copyPose, withIds, KeyChange, KeyRefusal, updateKeysIn, moveKeysIn, copyKeysIn };
