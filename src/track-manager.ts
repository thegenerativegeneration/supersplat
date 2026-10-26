import { AnimTrack } from './anim-track';
import { CameraAnimTrack, KeyChange, KeyRefusal, Pose } from './camera-poses';
import { AnimTrackEditOp } from './edit-ops';
import { Events } from './events';

/**
 * Manages the active animation track and provides undo-wrapped
 * key operations. Resolves which track the user is interacting
 * with and ensures all mutations are undoable.
 *
 * For now, the active track is always the camera track.
 * When selection-based switching is added, getActiveTrack()
 * will inspect the current selection.
 */
const registerTrackManagerEvents = (events: Events) => {
    // Get the animation track of the currently active element.
    // For now, always returns the camera animation track.
    const getActiveTrack = (): AnimTrack | null => {
        return events.invoke('camera.animTrack') ?? null;
    };

    // Helper: execute an edit on the active track wrapped in undo.
    // The editFn must return true if it modified the track, false if it was a no-op.
    const trackEdit = (name: string, editFn: (track: AnimTrack) => boolean) => {
        const track = getActiveTrack();
        if (!track) return;
        const before = track.snapshot();
        if (!editFn(track)) return;
        const after = track.snapshot();
        events.fire('edit.add', new AnimTrackEditOp(name, track, before, after), true);
    };

    // Like trackEdit for ops that refuse with a reason; a refusal adds no undo op
    const keyEdit = (name: string, editFn: (track: CameraAnimTrack) => true | KeyRefusal | false) => {
        let result: true | KeyRefusal | false = false;
        trackEdit(name, (track) => {
            result = editFn(track as CameraAnimTrack);
            return result === true;
        });
        if (typeof result === 'string') events.fire('track.refused', result);
    };

    // Get keys from active track
    events.function('track.keys', () => {
        const track = getActiveTrack();
        return track ? track.keys : [];
    });

    // Add key to active track
    events.on('track.addKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('addKey', track => track.addKey(keyFrame));
    });

    // Remove key from active track
    events.on('track.removeKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('removeKey', track => track.removeKey(keyFrame));
    });

    // Move key in active track
    events.on('track.moveKey', (fromFrame: number, toFrame: number) => {
        trackEdit('moveKey', track => track.moveKey(fromFrame, toFrame));
    });

    // Copy key in active track
    events.on('track.copyKey', (fromFrame: number, toFrame: number) => {
        trackEdit('copyKey', track => track.copyKey(fromFrame, toFrame));
    });

    // Change, move, copy and remove several keys by id
    events.on('track.updateKeys', (changes: KeyChange[]) => {
        keyEdit('updateKeys', track => track.updateKeys(changes));
    });

    events.on('track.moveKeys', (ids: string[], offset: number) => {
        keyEdit('moveKeys', track => track.moveKeys(ids, offset));
    });

    events.on('track.copyKeys', (ids: string[], offset: number) => {
        keyEdit('copyKeys', track => track.copyKeys(ids, offset));
    });

    events.on('track.removeKeys', (ids: string[]) => {
        trackEdit('removeKeys', track => (track as CameraAnimTrack).removeKeys(ids));
    });

    // Set how long the camera holds at a key
    events.on('track.setLinger', (frame: number, seconds: number) => {
        trackEdit('setLinger', track => (track as CameraAnimTrack).setLinger(frame, seconds));
    });

    // Reassign key frames in order
    events.on('track.retime', (frames: number[]) => {
        trackEdit('retime', track => (track as CameraAnimTrack).retime(frames));
    });

    // Append poses as keys and assign all key frames, as one undo step
    events.on('track.appendPoses', (poses: Parameters<CameraAnimTrack['appendPoses']>[0], frames: number[]) => {
        trackEdit('appendPoses', track => (track as CameraAnimTrack).appendPoses(poses, frames));
    });

    // Replace the whole path (user keys and detour keys), as one undo step
    events.on('track.replacePath', (poses: Pose[]) => {
        trackEdit('fixPath', track => (track as CameraAnimTrack).replacePath(poses));
    });
};

export { registerTrackManagerEvents };
