import { platform } from 'playcanvas';

import type { Pose } from '../camera-poses';
import { Events } from '../events';
import type { Gesture } from '../key-selection';

// pointer travel in px before a press on a marker becomes a drag
const DRAG_PX = 3;

// Ctrl+click raises contextmenu on macOS, so Cmd toggles there
const isMac = platform.name === 'osx';

type MarkerPress = { button: number, shift: boolean, alt: boolean, toggle: boolean };

type MarkerAction =
    | { kind: 'select', gesture: Gesture }
    | { kind: 'move' | 'copy', offset: number }
    | { kind: 'edit' }
    | { kind: 'none' };

// what a finished press on a key marker does; offset is in frames
const markerAction = (e: MarkerPress, moved: boolean, offset: number): MarkerAction => {
    if (e.button === 2) return { kind: 'edit' };
    if (e.button !== 0) return { kind: 'none' };
    if (!moved) return { kind: 'select', gesture: { shift: e.shift, toggle: e.toggle } };
    if (offset === 0) return { kind: 'none' };
    return { kind: e.alt ? 'copy' : 'move', offset };
};

// dragging a selected key takes the whole selection along
const dragIds = (selected: string[], clicked: string) => (selected.includes(clicked) ? selected : [clicked]);

// Limits a group offset so no key goes below frame 0 or past the timeline's
// end. A move never pushes a key already past the end further out; every copy
// lands on the timeline, and a copy that can't is cancelled (offset 0).
const clampGroupOffset = (frames: number[], offset: number, lastFrame: number, copying: boolean) => {
    const lo = -Math.min(...frames);
    const top = Math.max(...frames);
    const hi = copying || top <= lastFrame ? lastFrame - top : 0;
    if (hi < lo) return 0;
    return Math.max(lo, Math.min(hi, offset));
};

// the modifier that adds or removes one key, as shown in tooltips
const toggleKeyName = isMac ? '⌘' : 'Ctrl';

// the timeline geometry a marker's gestures need
type MarkerTrack = {
    area: HTMLElement,
    frameAt: (clientX: number) => number,
    leftOf: (frame: number) => number,
    lastFrame: number
};

type Group = {
    ids: string[],
    frames: number[],
    markers: HTMLElement[],
    lefts: string[],
    pinned: boolean[],
    clones: HTMLElement[]
};

// the keys a drag of `id` moves, with their markers
const groupOf = (events: Events, id: string, area: HTMLElement): Group => {
    const ids = dragIds(events.invoke('keys.selected') as string[] ?? [], id);
    const frameOf = new Map((events.invoke('camera.poses') as Pose[]).map(p => [p.id, p.frame]));
    const live = ids.filter(k => frameOf.has(k));
    const markers = Array.from(area.querySelectorAll<HTMLElement>('.time-label.key'))
    .filter(el => live.includes(el.dataset.id));
    return {
        ids: live,
        frames: live.map(k => frameOf.get(k)),
        markers,
        lefts: markers.map(el => el.style.left),
        pinned: markers.map(el => el.classList.contains('out-of-range')),
        clones: []
    };
};

const resetPreview = (group: Group) => {
    group.clones.forEach(el => el.remove());
    group.clones = [];
    group.markers.forEach((el, i) => {
        el.style.left = group.lefts[i];
        el.classList.toggle('out-of-range', group.pinned[i]);
        el.classList.remove('dragging', 'copying');
    });
};

// shows the group offset frames away: moved markers, or clones when copying
const showPreview = (group: Group, track: MarkerTrack, offset: number, copying: boolean) => {
    resetPreview(group);
    const frameOf = new Map(group.ids.map((k, i) => [k, group.frames[i]]));
    group.markers.forEach((el) => {
        const to = frameOf.get(el.dataset.id) + offset;
        const left = to <= track.lastFrame ? `${track.leftOf(to)}px` : el.style.left;
        if (copying) {
            const clone = document.createElement('div');
            clone.classList.add('time-label', 'key', 'dragging');
            clone.style.left = left;
            track.area.appendChild(clone);
            group.clones.push(clone);
            el.classList.add('copying');
        } else {
            el.style.left = left;
            el.classList.add('dragging');
            if (to <= track.lastFrame) el.classList.remove('out-of-range');
        }
    });
};

/**
 * Click, drag and right-click on one key marker. Clicks select, drags move or
 * (with Alt) copy the selection, right-click opens the key's editor. The
 * marker counts as a key surface, so pressing it keeps Delete on keys.
 */
const addMarkerGestures = (events: Events, marker: HTMLElement, id: string, track: MarkerTrack) => {
    marker.dataset.keySurface = '';

    let press: { pointerId: number, x: number, y: number, moved: boolean, delta: number, group: Group | null } = null;

    const run = (action: MarkerAction, group: Group | null, clientX: number, clientY: number) => {
        switch (action.kind) {
            case 'select':
                events.fire('keys.select', id, action.gesture);
                events.fire('keys.focus', true);
                break;
            case 'move':
                events.fire('track.moveKeys', group.ids, action.offset);
                break;
            case 'copy':
                events.fire('track.copyKeys', group.ids, action.offset);
                break;
            case 'edit':
                events.fire('keys.edit', id, clientX, clientY);
                break;
        }
    };

    const startDrag = () => {
        const selected = events.invoke('keys.selected') as string[] ?? [];
        if (!selected.includes(id)) events.fire('keys.setSelection', [id]);
        events.fire('keys.focus', true);
        return groupOf(events, id, track.area);
    };

    const end = () => {
        if (press?.group) resetPreview(press.group);
        if (press && marker.hasPointerCapture(press.pointerId)) marker.releasePointerCapture(press.pointerId);
        press = null;
    };

    marker.addEventListener('contextmenu', (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        end();
        run({ kind: 'edit' }, null, event.clientX, event.clientY);
    });

    marker.addEventListener('pointerdown', (event: PointerEvent) => {
        // keep any press on a key from reaching the scrub handler
        event.stopPropagation();
        if (press || !event.isPrimary || event.button !== 0 || (isMac && event.ctrlKey)) return;
        marker.setPointerCapture(event.pointerId);
        press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, delta: 0, group: null };
    });

    marker.addEventListener('pointermove', (event: PointerEvent) => {
        if (press?.pointerId !== event.pointerId) return;
        if (!press.moved) {
            if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_PX) return;
            press.moved = true;
            press.group = startDrag();
        }
        const { group } = press;
        const own = group.frames[group.ids.indexOf(id)];
        if (own === undefined) return;
        press.delta = track.frameAt(event.clientX) - own;
        const offset = clampGroupOffset(group.frames, press.delta, track.lastFrame, event.altKey);
        showPreview(group, track, offset, event.altKey);
    });

    marker.addEventListener('pointerup', (event: PointerEvent) => {
        if (press?.pointerId !== event.pointerId) return;
        const { moved, delta, group } = press;
        // restore the markers first: a committed edit rebuilds the timeline
        end();
        const offset = group?.frames.length ? clampGroupOffset(group.frames, delta, track.lastFrame, event.altKey) : 0;
        const toggle = isMac ? event.metaKey : event.ctrlKey;
        const action = markerAction({ button: 0, shift: event.shiftKey, alt: event.altKey, toggle }, moved, offset);
        run(action, group, event.clientX, event.clientY);
    });

    marker.addEventListener('pointercancel', end);
};

export { addMarkerGestures, clampGroupOffset, dragIds, isMac, markerAction, toggleKeyName, type MarkerTrack };
