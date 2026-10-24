import { Vec3 } from 'playcanvas';

import { buildCameraCurve, CurvePose } from './anim/camera-curve';
import { AnimTrack } from './anim-track';
import { Events } from './events';

type Pose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3,
    fov?: number,
    // seconds to hold at this key; absent or 0 means none
    linger?: number,
    // detour key inserted by Fix path; cleared when edited by hand
    auto?: boolean,
    // unreachable key Fix path moved after the end of the shot; cleared when
    // the key moves into the shot
    parked?: boolean
};

// a parked key that still sits after the end of the shot
const isParked = (pose: { frame: number, parked?: boolean }, duration: number) => !!pose.parked && pose.frame >= duration;

const copyPose = (p: Pose): Pose => ({
    name: p.name,
    frame: p.frame,
    position: p.position.clone(),
    target: p.target.clone(),
    fov: p.fov,
    linger: p.linger,
    auto: p.auto,
    parked: p.parked
});

const MAX_LINGER = 60;

/**
 * Camera animation track that manages camera keyframes and interpolation.
 * Implements AnimTrack interface so it can be used with the timeline system.
 *
 * Fully self-contained: subscribes to timeline events internally for
 * evaluation and spline rebuilding.
 */
class CameraAnimTrack implements AnimTrack {
    private poses: Pose[] = [];
    private events: Events;
    private onTimelineChange: ((frame: number) => void) | null = null;

    constructor(events: Events) {
        this.events = events;

        // Evaluate on timeline playback and scrub
        events.on('timeline.time', (time: number) => {
            this.evaluate(time);
        });

        events.on('timeline.frame', (frame: number) => {
            this.evaluate(frame);
        });

        // Rebuild spline when timeline parameters change
        events.on('timeline.frames', () => {
            this.rebuildSpline();
        });

        events.on('timeline.smoothness', () => {
            this.rebuildSpline();
        });

        events.on('timeline.loop', () => {
            this.rebuildSpline();
        });

        // Clear track when scene is cleared
        events.on('scene.clear', () => {
            this.clear();
        });
    }

    get keys(): readonly number[] {
        return this.poses.map(p => p.frame);
    }

    addKey(frame: number): boolean {
        const pose = this.events.invoke('camera.getPose');
        if (!pose) return false;

        const existingIndex = this.poses.findIndex(p => p.frame === frame);

        const newPose: Pose = {
            name: `camera_${this.poses.length}`,
            frame,
            position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
            target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
            fov: pose.fov,
            linger: existingIndex === -1 ? undefined : this.poses[existingIndex].linger,
            parked: existingIndex === -1 ? undefined : this.poses[existingIndex].parked
        };

        if (existingIndex === -1) {
            this.poses.push(newPose);
            this.rebuildSpline();
            this.events.fire('track.keyAdded', frame);
        } else {
            this.poses[existingIndex] = newPose;
            this.rebuildSpline();
            this.events.fire('track.keyUpdated', frame);
        }
        return true;
    }

    removeKey(frame: number): boolean {
        const index = this.poses.findIndex(p => p.frame === frame);
        if (index === -1) return false;
        this.poses.splice(index, 1);
        this.rebuildSpline();
        this.events.fire('track.keyRemoved', frame);
        return true;
    }

    moveKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const index = this.poses.findIndex(p => p.frame === fromFrame);
        if (index === -1) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        // Update the frame (re-find index since splice may have shifted it)
        const movedIndex = this.poses.findIndex(p => p.frame === fromFrame);
        this.poses[movedIndex].frame = toFrame;
        this.poses[movedIndex].auto = undefined;
        this.unparkInShot();
        this.rebuildSpline();
        this.events.fire('track.keyMoved', fromFrame, toFrame);
        return true;
    }

    copyKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const source = this.poses.find(p => p.frame === fromFrame);
        if (!source) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        this.poses.push({
            name: `camera_${this.poses.length}`,
            frame: toFrame,
            position: source.position.clone(),
            target: source.target.clone(),
            fov: source.fov,
            linger: source.linger
        });

        this.rebuildSpline();
        this.events.fire('track.keyAdded', toFrame);
        return true;
    }

    setLinger(frame: number, seconds: number): boolean {
        const pose = this.poses.find(p => p.frame === frame);
        if (!pose) return false;

        const linger = Math.min(MAX_LINGER, Math.max(0, seconds));
        if (linger === (pose.linger ?? 0)) return false;

        pose.linger = linger;
        this.events.fire('track.keyUpdated', frame);
        return true;
    }

    /**
     * Assign frames[i] to the i-th pose ordered by current frame, including
     * poses beyond the timeline end.
     */
    retime(frames: number[]): boolean {
        if (frames.length !== this.poses.length) return false;

        const ordered = this.poses.slice().sort((a, b) => a.frame - b.frame);
        if (ordered.every((p, i) => p.frame === frames[i])) return false;

        ordered.forEach((p, i) => {
            p.frame = frames[i];
        });
        this.unparkInShot();
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
        return true;
    }

    // keys moved into the shot are no longer parked
    private unparkInShot() {
        const duration = this.events.invoke('timeline.frames');
        for (const p of this.poses) {
            if (p.parked && p.frame < duration) p.parked = undefined;
        }
    }

    /**
     * Append new poses and assign frames to all keys in one step. frames
     * covers the existing poses ordered by frame, then the new poses; each
     * key needs a frame of its own.
     */
    appendPoses(added: { position: Vec3, target: Vec3, fov: number }[], frames: number[]): boolean {
        if (frames.length !== this.poses.length + added.length) return false;
        if (frames.some(f => !Number.isFinite(f)) || new Set(frames).size !== frames.length) return false;

        let next = 1 + Math.max(-1, ...this.poses.map(p => Number(/^camera_(\d+)$/.exec(p.name)?.[1] ?? -1)));
        const ordered = this.poses.slice().sort((a, b) => a.frame - b.frame);
        for (const a of added) {
            ordered.push({
                name: `camera_${next++}`,
                frame: 0,
                position: a.position.clone(),
                target: a.target.clone(),
                fov: a.fov
            });
        }
        ordered.forEach((p, i) => {
            p.frame = frames[i];
        });
        this.poses = ordered;
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
        return true;
    }

    /**
     * Replace all poses with the given ones, ordered by frame, in one step.
     */
    replacePath(poses: Pose[]): boolean {
        if (poses.some(p => !Number.isFinite(p.frame))) return false;
        if (new Set(poses.map(p => p.frame)).size !== poses.length) return false;

        this.poses = poses.slice().sort((a, b) => a.frame - b.frame).map(copyPose);
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
        return true;
    }

    evaluate(frame: number): void {
        this.onTimelineChange?.(frame);
    }

    clear(): void {
        this.poses.length = 0;
        this.onTimelineChange = null;
        this.events.fire('track.keysCleared');
    }

    snapshot(): Pose[] {
        return this.poses.map(copyPose);
    }

    restore(snapshot: unknown): void {
        this.poses = (snapshot as Pose[]).map(copyPose);
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    /**
     * Add a pose directly (used for deserialization).
     */
    addPose(pose: Pose): void {
        if (pose.frame === undefined) {
            return;
        }

        pose.fov ??= this.events.invoke('camera.fov') ?? 60;

        const idx = this.poses.findIndex(p => p.frame === pose.frame);
        if (idx !== -1) {
            this.poses[idx] = pose;
            this.rebuildSpline();
            this.events.fire('track.keyUpdated', pose.frame);
        } else {
            this.poses.push(pose);
            this.rebuildSpline();
            this.events.fire('track.keyAdded', pose.frame);
        }
    }

    /**
     * Get all poses (used for serialization).
     */
    getPoses(): readonly Pose[] {
        return this.poses;
    }

    /**
     * Load poses from serialized data.
     */
    loadPoses(posesData: Pose[]): void {
        const defaultFov = this.events.invoke('camera.fov');
        this.poses.length = 0;
        posesData.forEach((pose) => {
            this.poses.push({
                ...pose,
                fov: pose.fov ?? defaultFov
            });
        });
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    private rebuildSpline(): void {
        const duration = this.events.invoke('timeline.frames');
        const smoothness = this.events.invoke('timeline.smoothness');
        const loop = this.events.invoke('timeline.loop');

        const orderedPoses = this.poses.slice()
        .filter(a => a.frame < duration)
        .sort((a, b) => a.frame - b.frame);

        const curve = buildCameraCurve(orderedPoses as CurvePose[], orderedPoses.map(p => p.frame), { duration, smoothness, loop });

        if (curve) {
            const pose = { position: new Vec3(), target: new Vec3(), fov: 0 };

            this.onTimelineChange = (frame: number) => {
                this.events.fire('camera.setPose', curve(frame, pose), 0);
            };
        } else if (orderedPoses.length === 1) {
            // a single key can't form a spline; hold its pose at every frame
            const p = orderedPoses[0];
            const pose = { position: p.position.clone(), target: p.target.clone(), fov: p.fov };

            this.onTimelineChange = () => {
                this.events.fire('camera.setPose', pose, 0);
            };
        } else {
            this.onTimelineChange = null;
        }

        // re-evaluate at the current frame so the camera updates immediately
        this.evaluate(this.events.invoke('timeline.frame'));
    }
}

/**
 * Register the camera animation track and expose it via events.
 * The track is fully self-contained (subscribes to timeline events internally),
 * so this function only needs to create it, expose it, and handle serialization.
 */
const registerCameraPosesEvents = (events: Events) => {
    const track = new CameraAnimTrack(events);

    // Expose the camera animation track
    events.function('camera.animTrack', () => {
        return track;
    });

    // expose poses
    events.function('camera.poses', () => {
        return track.getPoses();
    });

    events.function('camera.keyLingers', () => {
        return track.getPoses()
        .filter(p => (p.linger ?? 0) > 0)
        .map(p => ({ frame: p.frame, linger: p.linger }));
    });

    events.on('camera.loadPoses', (poses: Pose[]) => {
        track.loadPoses(poses);
    });

    // Serialization

    events.function('docSerialize.poseSets', (): any[] => {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const poses = track.getPoses();

        if (poses.length === 0) {
            return [];
        }

        return [{
            name: 'set0',
            poses: poses.map((pose) => {
                return {
                    name: pose.name,
                    frame: pose.frame,
                    position: pack3(pose.position),
                    target: pack3(pose.target),
                    fov: pose.fov,
                    ...(pose.linger > 0 ? { linger: pose.linger } : {}),
                    ...(pose.auto ? { auto: true } : {}),
                    ...(pose.parked ? { parked: true } : {})
                };
            })
        }];
    });

    events.function('docDeserialize.poseSets', (poseSets: any[], documentCameraFov?: number) => {
        if (!poseSets || poseSets.length === 0) {
            return;
        }

        const fps = events.invoke('timeline.frameRate');

        const defaultFov = documentCameraFov ?? events.invoke('camera.fov') ?? 60;

        const loadedPoses: Pose[] = poseSets[0].poses.map((docPose: any, index: number) => {
            return {
                name: docPose.name,
                frame: docPose.frame ?? (index * fps),
                position: new Vec3(docPose.position),
                target: new Vec3(docPose.target),
                fov: docPose.fov ?? defaultFov,
                linger: docPose.linger ?? 0,
                ...(docPose.auto ? { auto: true } : {}),
                ...(docPose.parked ? { parked: true } : {})
            };
        });

        track.loadPoses(loadedPoses);
    });
};

export { registerCameraPosesEvents, CameraAnimTrack, isParked, Pose };
