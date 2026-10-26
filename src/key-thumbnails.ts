import { Vec3 } from 'playcanvas';

import type { Pose } from './camera-poses';
import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import type { Splat } from './splat';
import { canvasOf, createViewCapture } from './view-capture';

// quiet time after the last input before a tile renders
const IDLE_MS = 500;

const TILE_WIDTH = 160;
const TILE_HEIGHT = 100;

type ThumbDeps = {
    now(): number,
    // the key's view as a tile; null when the capture stepped aside because
    // `ready` turned false before it started
    render(pose: Pose, ready: () => boolean): Promise<HTMLCanvasElement | null>,
    busy(): boolean,
    onTile(id: string, canvas: HTMLCanvasElement): void
};

// what a tile shows; frame, linger and look ahead don't change it
const viewOf = (p: Pose) => [p.position.x, p.position.y, p.position.z, p.target.x, p.target.y, p.target.z, p.fov ?? ''].join(' ');

/**
 * Renders key tiles one at a time while the user is idle. `invalidate` takes
 * all keys and queues those whose view differs from their tile, the newest
 * edits first. `tick` runs once per animation frame.
 */
const createThumbnailQueue = (deps: ThumbDeps) => {
    // the view each tile shows
    const shown = new Map<string, string>();
    let keys = new Map<string, Pose>();
    let queue: string[] = [];
    let lastInput = -Infinity;
    let rendering = false;

    const ready = () => deps.now() - lastInput >= IDLE_MS && !deps.busy();
    const stale = (id: string) => keys.has(id) && shown.get(id) !== viewOf(keys.get(id));

    return {
        invalidate(poses: Pose[]) {
            const before = keys;
            keys = new Map(poses.map(p => [p.id, p]));
            [...shown.keys()].filter(id => !keys.has(id)).forEach(id => shown.delete(id));
            const edited = poses
            .filter(p => stale(p.id) && (!queue.includes(p.id) || viewOf(before.get(p.id)) !== viewOf(p)))
            .map(p => p.id);
            queue = [...edited, ...queue.filter(id => stale(id) && !edited.includes(id))];
        },

        // every key renders again on the next invalidate
        forget() {
            shown.clear();
        },

        input() {
            lastInput = deps.now();
        },

        async tick() {
            if (rendering || !queue.length || !ready()) return;
            const id = queue.shift();
            const pose = keys.get(id);
            const view = viewOf(pose);
            rendering = true;
            try {
                const canvas = await deps.render(pose, ready);
                if (!canvas) {
                    if (stale(id) && !queue.includes(id)) queue.unshift(id);
                } else if (keys.has(id) && viewOf(keys.get(id)) === view) {
                    shown.set(id, view);
                    deps.onTile(id, canvas);
                }
            } finally {
                rendering = false;
            }
        }
    };
};

/**
 * Key tiles for the strip, fired as `keys.thumbnail(id, canvas)`. Tiles render
 * in the command queue, so picks and EditorAPI commands never meet one, and
 * not while anything else may need the camera or the user is at work.
 * Exports claim rendering first (`render.claim`, `render.release`): a tile
 * being drawn finishes and no new one starts until they release.
 */
const registerKeyThumbnailEvents = (events: Events, scene: Scene) => {
    const counts = { progress: 0, spinner: 0, claims: 0 };
    let stripShown = true;
    let pressed = false;
    let capturing: Promise<void> | null = null;

    const count = (on: string, off: string, key: keyof typeof counts) => {
        events.on(on, () => counts[key]++);
        events.on(off, () => {
            counts[key] = Math.max(0, counts[key] - 1);
        });
    };
    count('progressStart', 'progressEnd', 'progress');
    count('startSpinner', 'stopSpinner', 'spinner');
    events.on('render.release', () => {
        counts.claims = Math.max(0, counts.claims - 1);
    });

    const settled = () => {
        const { camera } = scene;
        return [camera.focalPointTween, camera.azimElevTween, camera.distanceTween].every(t => t.timer >= t.transitionTime) &&
            !camera.lookCameraPos && !camera.poseOverride;
    };

    const busy = () => !stripShown || counts.progress > 0 || counts.spinner > 0 || counts.claims > 0 || pressed ||
        !!events.invoke('timeline.playing') || scene.lockedRenderMode || scene.renderHold > 0 || scene.suspendRender || !settled();

    const render = (pose: Pose, ready: () => boolean) => scene.commandQueue.enqueue(async () => {
        const capture = createViewCapture(events, scene);
        const fov = pose.fov ?? scene.camera.fov;
        const view = { position: new Vec3().copy(pose.position), target: new Vec3().copy(pose.target), fov };
        let done: () => void;
        const rgba = await capture.render(view, TILE_WIDTH, TILE_HEIGHT, () => {
            if (!ready()) return false;
            capturing = new Promise((resolve) => {
                done = resolve;
            });
            events.fire('thumbs.capture', true);
            return true;
        }).finally(() => {
            if (!done) return;
            try {
                capture.restore();
            } finally {
                capturing = null;
                events.fire('thumbs.capture', false);
                done();
            }
        });
        return rgba && canvasOf(rgba, TILE_WIDTH, TILE_HEIGHT);
    });

    const queue = createThumbnailQueue({
        now: () => performance.now(),
        render,
        busy,
        onTile: (id, canvas) => events.fire('keys.thumbnail', id, canvas)
    });

    // the claim's counter rises first, so a tile queued behind it steps aside
    events.function('render.claim', () => (capturing ?? Promise.resolve()).then(() => {
        counts.claims++;
    }));

    // keys without a fov show the live one
    const poses = () => {
        const fov = scene.camera.fov;
        return (events.invoke('camera.poses') as Pose[] ?? []).map(p => (p.fov === undefined ? { ...p, fov } : p));
    };
    const keysChanged = () => {
        queue.input();
        queue.invalidate(poses());
    };
    ['keysLoaded', 'keyAdded', 'keyRemoved', 'keyMoved', 'keyUpdated', 'keysCleared'].forEach((name) => {
        events.on(`track.${name}`, keysChanged);
    });

    // tiles show the scene, so they render again when it changes
    const sceneChanged = () => {
        queue.forget();
        keysChanged();
    };
    for (const name of ['scene.elementAdded', 'scene.elementRemoved']) {
        events.on(name, (element: { type: ElementType }) => element?.type === ElementType.splat && sceneChanged());
    }
    for (const name of ['splat.moved', 'splat.visibility', 'splat.colorsChanged', 'splat.positionsChanged', 'splat.replaced']) {
        events.on(name, sceneChanged);
    }
    // tiles show the clean shot: selecting changes nothing in them, hiding
    // and deleting do
    const hiddenCounts = new Map<Splat, string>();
    const hiddenOf = (splat: Splat) => `${splat.numDeleted} ${splat.numLocked}`;
    events.on('scene.elementAdded', (element: Splat) => element?.type === ElementType.splat && hiddenCounts.set(element, hiddenOf(element)));
    events.on('scene.elementRemoved', (element: Splat) => hiddenCounts.delete(element));
    events.on('splat.stateChanged', (splat: Splat) => {
        if (hiddenCounts.get(splat) === hiddenOf(splat)) return;
        hiddenCounts.set(splat, hiddenOf(splat));
        sceneChanged();
    });
    events.on('camera.fov', () => queue.invalidate(poses()));

    events.on('timeline.frame', () => queue.input());
    events.on('timeline.keyStrip', (shown: boolean) => {
        stripShown = shown;
    });

    // a release outside the window is seen on the next move over it
    const pointer = (event: PointerEvent) => {
        pressed = event.buttons !== 0;
        queue.input();
    };
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
        window.addEventListener(name, pointer, true);
    }
    for (const name of ['wheel', 'keydown', 'keyup']) {
        window.addEventListener(name, () => queue.input(), { capture: true, passive: true });
    }

    events.on('update', () => {
        if (!settled()) queue.input();
        queue.tick().catch(error => console.error('key thumbnail failed', error));
    });

    queue.invalidate(poses());
};

export { createThumbnailQueue, registerKeyThumbnailEvents, type ThumbDeps };
