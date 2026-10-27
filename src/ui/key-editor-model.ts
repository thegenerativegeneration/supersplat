import { Vec3 } from 'playcanvas';

import { DEFAULT_TURN_IN } from '../anim/look-ahead';
import type { Pose } from '../camera-poses';
import type { KeyChange } from '../key-ops';

type Vec3Like = { x: number, y: number, z: number };

type EditorField = 'time' | 'frame' | 'linger' | 'fov' | 'lookAhead' | 'turnIn' | 'position' | 'target';

// what the editor shows for the selected keys; null means the keys differ
type EditorFields = {
    count: number,
    time: number | null,
    frame: number | null,
    linger: number | null,
    fov: number | null,
    lookAhead: boolean | null,
    turnIn: number | null,
    position: Vec3Like | null,
    target: Vec3Like | null,
    // the view (Update to view, Pick, position and target) is edited for a single key only
    viewEditable: boolean
};

type View = { position: Vec3Like, target: Vec3Like, fov?: number };

// the shared value, or null when the values differ or are missing
const shared = <T>(values: (T | undefined)[]): T | null => {
    if (values.length === 0 || values[0] === undefined) return null;
    return values.every(v => v === values[0]) ? values[0] : null;
};

const plain = (v: Vec3Like): Vec3Like => ({ x: v.x, y: v.y, z: v.z });

const editorFields = (poses: Pose[], frameRate: number): EditorFields => {
    const one = poses.length === 1 ? poses[0] : null;
    return {
        count: poses.length,
        time: one ? one.frame / frameRate : null,
        frame: one ? one.frame : null,
        linger: shared(poses.map(p => p.linger ?? 0)),
        fov: shared(poses.map(p => p.fov)),
        lookAhead: shared(poses.map(p => !!p.lookAhead)),
        turnIn: shared(poses.map(p => p.turnIn ?? DEFAULT_TURN_IN)),
        position: one ? plain(one.position) : null,
        target: one ? plain(one.target) : null,
        viewEditable: !!one
    };
};

// moves the earliest key to frame, the others keep their spacing
const frameChanges = (poses: Pose[], frame: number): KeyChange[] => {
    if (!Number.isFinite(frame) || poses.length === 0) return [];
    const offset = Math.round(frame) - Math.min(...poses.map(p => p.frame));
    return offset === 0 ? [] : poses.map(p => ({ id: p.id, frame: p.frame + offset }));
};

const isVec3Like = (v: unknown): v is Vec3Like => {
    const u = v as Vec3Like;
    return !!u && [u.x, u.y, u.z].every(Number.isFinite);
};

/**
 * The changes that set the field to value on the keys. Time is in seconds
 * and needs the frame rate; times and frames round to whole frames. Position
 * and target change a single key only. Blank or invalid values change nothing.
 */
const changesFor = (poses: Pose[], field: EditorField, value: unknown, frameRate?: number): KeyChange[] => {
    switch (field) {
        case 'time':
            return frameChanges(poses, (value as number) * frameRate);
        case 'frame':
            return frameChanges(poses, value as number);
        case 'lookAhead':
            return typeof value === 'boolean' ? poses.map(p => ({ id: p.id, lookAhead: value })) : [];
        case 'position':
        case 'target':
            if (poses.length !== 1 || !isVec3Like(value)) return [];
            return [{ id: poses[0].id, [field]: new Vec3(value.x, value.y, value.z) }];
        default:
            return typeof value === 'number' && Number.isFinite(value) ? poses.map(p => ({ id: p.id, [field]: value })) : [];
    }
};

// "Update to view": the key takes the camera's view, for a single key only
const viewChanges = (poses: Pose[], view: View): KeyChange[] => {
    if (poses.length !== 1) return [];
    const { position: p, target: t } = view;
    return [{ id: poses[0].id, position: new Vec3(p.x, p.y, p.z), target: new Vec3(t.x, t.y, t.z), fov: view.fov }];
};

// whether the changes move a key inside the shot past its last frame
const leavesShot = (poses: Pose[], changes: KeyChange[], lastFrame: number) => changes.some((c) => {
    const pose = poses.find(p => p.id === c.id);
    return c.frame !== undefined && c.frame > lastFrame && !!pose && pose.frame <= lastFrame;
});

export { changesFor, editorFields, leavesShot, viewChanges, type EditorField, type EditorFields, type Vec3Like };
