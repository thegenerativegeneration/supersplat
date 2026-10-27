import { Vec3 } from 'playcanvas';

import type { Pose } from './camera-poses';
import { Events } from './events';
import type { KeyChange } from './key-ops';
import type { Scene } from './scene';

type Vec3Like = { x: number, y: number, z: number };

type PickDown = (from: Vec3Like) => Promise<Vec3Like | null>;

type PickMode = 'position' | 'target';

// how far above the clicked point the floor search starts, in eye heights
const LIFT = 0.25;
// how far the clicked point is pulled back toward the viewer first, in eye
// heights, so a downward search from a wall click clears the wall
const APPROACH = 0.15;

// presses on the scene this soon after a picking press finish a double-click
// and belong to the pick
const SETTLE_MS = 600;

// the downward pick: a narrow view straight down, sampled at its centre and
// four close points so a single gap in the splats doesn't fall through
const DOWN_FOV = 20;
const DOWN_POINTS = [
    { x: 0.5, y: 0.5 },
    { x: 0.48, y: 0.5 },
    { x: 0.52, y: 0.5 },
    { x: 0.5, y: 0.48 },
    { x: 0.5, y: 0.52 }
];

/**
 * Where the camera stands for a pick at hit: one eye height above the first
 * surface straight down from just above hit, or null when nothing is below.
 */
const pickStandPoint = async (hit: Vec3Like, eyeHeight: number, pickDown: PickDown): Promise<Vec3Like | null> => {
    const floor = await pickDown({ x: hit.x, y: hit.y + LIFT * eyeHeight, z: hit.z });
    return floor ? { x: hit.x, y: floor.y + eyeHeight, z: hit.z } : null;
};

// Pick position: the key stands at the picked point with the same view
// direction, so the target moves by the same offset. Null when nothing is below.
const pickPositionChange = async (pose: Pose, hit: Vec3Like, eyeHeight: number, pickDown: PickDown): Promise<KeyChange | null> => {
    const stand = await pickStandPoint(hit, eyeHeight, pickDown);
    if (!stand) return null;
    const position = new Vec3(stand.x, stand.y, stand.z);
    const target = pose.target.clone().add(position).sub(pose.position);
    return { id: pose.id, position, target };
};

// Pick target: the key aims at the picked point
const pickTargetChange = (pose: Pose, hit: Vec3Like): KeyChange => ({ id: pose.id, target: new Vec3(hit.x, hit.y, hit.z) });

// hit moved distance toward the viewer, at most half way
const towardViewer = (hit: Vec3Like, viewer: Vec3Like, distance: number): Vec3Like => {
    const d = new Vec3(viewer.x - hit.x, viewer.y - hit.y, viewer.z - hit.z);
    const length = d.length();
    if (length === 0) return hit;
    d.mulScalar(Math.min(distance, length / 2) / length);
    return { x: hit.x + d.x, y: hit.y + d.y, z: hit.z + d.z };
};

/**
 * Pick mode for the key editor: `keys.pick(mode, id)` turns the cursor into a
 * crosshair, and the next left click on the scene picks the key's position or
 * target there. Escape cancels. The click never reaches the camera controls
 * or the active tool, which stays active. `keys.picking` reports the mode or
 * null; `keys.pickMissed` fires when the click found nothing to pick.
 */
const registerKeyPickEvents = (events: Events, scene: Scene) => {
    let picking: { mode: PickMode, id: string } | null = null;
    let swallowPointer: number | null = null;

    const setPicking = (next: { mode: PickMode, id: string } | null) => {
        picking = next;
        document.body.classList.toggle('key-picking', !!next);
        events.fire('keys.picking', next?.mode ?? null);
    };

    events.function('keys.picking', () => picking?.mode ?? null);
    events.on('keys.pick', (mode: PickMode, id: string) => setPicking({ mode, id }));
    events.on('keys.pickCancel', () => {
        if (picking) setPicking(null);
    });

    const pickDown: PickDown = (from) => {
        const { camera } = scene;
        const position = new Vec3(from.x, from.y, from.z);
        const frame = camera.frameAtPose(position, new Vec3(from.x, from.y - 1, from.z), DOWN_FOV);
        return scene.commandQueue.enqueue(async (ctx) => {
            const hits = (await camera.pickDepths(ctx, frame, DOWN_POINTS)).filter(Boolean);
            if (hits.length === 0) return null;
            hits.sort((a, b) => a.position.y - b.position.y);
            const { x, y, z } = hits[hits.length >> 1].position;
            return { x, y, z };
        });
    };

    const pick = async (mode: PickMode, id: string, x: number, y: number) => {
        const viewer = scene.camera.position.clone();
        const hit = await scene.camera.intersect(x, y);
        const pose = (events.invoke('camera.poses') as Pose[]).find(p => p.id === id);
        if (!pose) return;
        let change: KeyChange | null = null;
        if (hit && mode === 'target') {
            change = pickTargetChange(pose, hit.position);
        } else if (hit) {
            const eyeHeight = (events.invoke('path.settings') as { eyeHeight: number }).eyeHeight;
            change = await pickPositionChange(pose, towardViewer(hit.position, viewer, APPROACH * eyeHeight), eyeHeight, pickDown);
        }
        if (change) {
            events.fire('track.updateKeys', [change]);
        } else {
            events.fire('keys.pickMissed');
        }
    };

    const onScene = (target: EventTarget) => target === scene.canvas ||
        (target instanceof Element && !!target.closest('#tools-container'));

    let pickedAt = -Infinity;
    const settling = () => performance.now() - pickedAt < SETTLE_MS;

    window.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button !== 0 || !onScene(event.target) || (!picking && !settling())) return;
        event.stopPropagation();
        event.preventDefault();
        swallowPointer = event.pointerId;
        if (!picking) return;
        const { mode, id } = picking;
        pickedAt = performance.now();
        setPicking(null);
        const rect = scene.canvas.getBoundingClientRect();
        pick(mode, id, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
        .catch(() => events.fire('keys.pickMissed'));
    }, true);

    // nor the click and double-click that complete it, which would refocus the camera
    const swallowClick = (event: MouseEvent) => {
        if (settling() && onScene(event.target)) event.stopPropagation();
    };
    window.addEventListener('click', swallowClick, true);
    window.addEventListener('dblclick', swallowClick, true);

    // the release of the picking click belongs to no one else
    const swallowRelease = (event: PointerEvent) => {
        if (event.pointerId !== swallowPointer) return;
        swallowPointer = null;
        event.stopPropagation();
    };
    window.addEventListener('pointerup', swallowRelease, true);
    window.addEventListener('pointercancel', swallowRelease, true);

    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if (picking && event.key === 'Escape') {
            event.stopImmediatePropagation();
            event.preventDefault();
            setPicking(null);
        }
    }, true);
};

export { pickPositionChange, pickStandPoint, pickTargetChange, registerKeyPickEvents, towardViewer };
