import { Vec3 } from 'playcanvas';

import type { Pose } from './camera-poses';
import { Events } from './events';
import type { Scene } from './scene';
import { isMac, markerAction } from './ui/key-marker-gestures';

type ScreenPoint = { x: number, y: number };

type ScreenKey = { id: string, screen: ScreenPoint | null };

// pointer travel in px up to which a press and release still count as a click
const CLICK_PX = 4;

// how close in px a click must be to a camera icon to hit it
const HIT_PX = 10;

/**
 * The key whose screen position is nearest to `screen` and within `maxPx`, or
 * null. Keys without a screen position (behind the camera) are skipped.
 */
const nearestKey = (screen: ScreenPoint, keys: ScreenKey[], maxPx = HIT_PX): string | null => {
    let best: string | null = null;
    let bestDist = maxPx;
    for (const key of keys) {
        if (!key.screen) continue;
        const d = Math.hypot(key.screen.x - screen.x, key.screen.y - screen.y);
        if (d <= bestDist) {
            best = key.id;
            bestDist = d;
        }
    }
    return best;
};

const projected = new Vec3();
const toKey = new Vec3();

/**
 * Click on the camera icons drawn in the 3D view. A click selects the key
 * (Shift for a range, Cmd/Ctrl to toggle), a right-click opens its editor.
 * Orbit and pan drags are left alone: only a press and release within a few
 * pixels counts, and a click that hits no camera does nothing.
 */
const registerKeyPick3dEvents = (events: Events, scene: Scene) => {
    const { canvas } = scene;
    let press: { pointerId: number, button: number, x: number, y: number, id: string } | null = null;

    const active = () => !!events.invoke('camera.showPoses') && !events.invoke('tool.active') && !events.invoke('keys.picking');

    const screenKeys = (rect: DOMRect): ScreenKey[] => {
        const { camera } = scene;
        const forward = camera.mainCamera.forward;
        return (events.invoke('camera.poses') as Pose[]).map((pose) => {
            toKey.sub2(pose.position, camera.position);
            if (toKey.dot(forward) <= 0) return { id: pose.id, screen: null };
            camera.worldToScreen(pose.position, projected);
            return { id: pose.id, screen: { x: projected.x * rect.width, y: projected.y * rect.height } };
        });
    };

    const hit = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        return nearestKey({ x: clientX - rect.left, y: clientY - rect.top }, screenKeys(rect));
    };

    canvas.addEventListener('pointerdown', (event: PointerEvent) => {
        press = null;
        if (!event.isPrimary || (event.button !== 0 && event.button !== 2) || (isMac && event.button === 0 && event.ctrlKey) || !active()) return;
        const id = hit(event.clientX, event.clientY);
        if (id) press = { pointerId: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, id };
    });

    window.addEventListener('pointerup', (event: PointerEvent) => {
        if (press?.pointerId !== event.pointerId) return;
        const { x, y, button, id } = press;
        press = null;
        if (event.button !== button || Math.hypot(event.clientX - x, event.clientY - y) >= CLICK_PX) return;
        const toggle = isMac ? event.metaKey : event.ctrlKey;
        const action = markerAction({ button, shift: event.shiftKey, alt: false, toggle }, false, 0);
        if (action.kind === 'select') {
            events.fire('keys.select', id, action.gesture);
            events.fire('keys.focus', true);
        } else if (action.kind === 'edit') {
            events.fire('keys.edit', id, event.clientX, event.clientY);
        }
    });

    window.addEventListener('pointercancel', (event: PointerEvent) => {
        if (press?.pointerId === event.pointerId) press = null;
    });
};

export { nearestKey, registerKeyPick3dEvents };
