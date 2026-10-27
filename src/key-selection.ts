import type { Pose } from './camera-poses';
import { Events } from './events';
import type { Splat } from './splat';

// toggle = Cmd on macOS, Ctrl elsewhere
type Gesture = { shift: boolean, toggle: boolean };

type Selection = { selected: Set<string>, anchor: string | null };

/**
 * Selection after clicking `clicked`. `ordered` lists all key ids by frame;
 * `anchor` is the last plain or toggle click and stays put on a shift click.
 */
const selectWith = (
    current: ReadonlySet<string>,
    anchor: string | null,
    clicked: string,
    ordered: string[],
    g: Gesture
): Selection => {
    const a = anchor === null ? -1 : ordered.indexOf(anchor);
    if (g.shift && a >= 0) {
        const b = ordered.indexOf(clicked);
        const range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
        return { selected: new Set(g.toggle ? [...current, ...range] : range), anchor };
    }
    if (g.toggle) {
        const selected = new Set(current);
        if (!selected.delete(clicked)) selected.add(clicked);
        return { selected, anchor: clicked };
    }
    return { selected: new Set([clicked]), anchor: clicked };
};

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(id => b.has(id));

/**
 * Shared key selection for the timeline, thumbnail strip, 3D cameras and key editor.
 *
 * Focus decides where Delete goes: key clicks fire `keys.focus(true)`; any other
 * pointerdown clears it. A key surface in the DOM carries the `data-key-surface`
 * attribute so the generic listener leaves focus alone; other surfaces (such as
 * 3D camera hits) fire `keys.focus(true)` themselves after the pointerdown.
 *
 * Splat work from the keyboard or the API also clears focus: a select command,
 * a change of the splat selection or the active layer, a tool activating, and the
 * timeline panel or key strip hiding.
 */
const registerKeySelectionEvents = (events: Events) => {
    let selected = new Set<string>();
    let anchor: string | null = null;
    let focus = false;

    const poses = () => events.invoke('camera.poses') as Pose[];
    const ordered = () => poses().slice().sort((a, b) => a.frame - b.frame).map(p => p.id);

    const apply = (next: Set<string>, nextAnchor: string | null) => {
        anchor = nextAnchor;
        if (!sameIds(selected, next)) {
            selected = next;
            events.fire('keys.selectionChanged', [...selected]);
        }
    };

    events.function('keys.selected', () => [...selected]);
    events.function('keys.focused', () => focus && selected.size > 0);

    events.on('keys.select', (id: string, gesture: Gesture) => {
        const result = selectWith(selected, anchor, id, ordered(), gesture);
        apply(result.selected, result.anchor);
        if (!gesture.shift && !gesture.toggle) {
            const pose = poses().find(p => p.id === id);
            if (pose) events.fire('timeline.setFrame', pose.frame);
        }
    });

    events.on('keys.setSelection', (ids: string[]) => {
        apply(new Set(ids), ids.length ? ids[ids.length - 1] : null);
    });

    // the measure and orient tools take Delete for their own points
    events.on('keys.focus', (value: boolean) => {
        focus = value && !['measure', 'orient'].includes(events.invoke('tool.active'));
    });

    events.on('keys.delete', () => {
        const ids = [...selected];
        if (ids.length === 0) return;
        apply(new Set(), null);
        events.fire('track.removeKeys', ids);
    });

    const dropStale = () => {
        const live = new Set(poses().map(p => p.id));
        const kept = new Set([...selected].filter(id => live.has(id)));
        apply(kept, anchor !== null && live.has(anchor) ? anchor : null);
    };
    ['track.keysLoaded', 'track.keyRemoved', 'track.keysCleared', 'track.keyMoved', 'track.keyAdded'].forEach(name => events.on(name, dropStale));

    const unfocus = () => {
        focus = false;
    };
    // the commands clear focus as they fire; their ops change the selection later
    ['select.all', 'select.none', 'select.invert', 'select.hide', 'select.unhide', 'selection.changed'].forEach(name => events.on(name, unfocus));

    // undo, redo and API edits reach the splat selection without a select command
    const numSelected = new WeakMap<Splat, number>();
    events.on('splat.stateChanged', (splat: Splat) => {
        if ((numSelected.get(splat) ?? 0) !== splat.numSelected) unfocus();
        numSelected.set(splat, splat.numSelected);
    });

    events.on('tool.activated', (name: string | null) => {
        if (name) unfocus();
    });
    events.on('statusBar.panelChanged', (panel: string | null) => {
        if (panel !== 'timeline') unfocus();
    });
    events.on('timeline.keyStrip', (shown: boolean) => {
        if (!shown) unfocus();
    });

    if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', (e) => {
            if (!(e.target instanceof Element && e.target.closest('[data-key-surface]'))) unfocus();
        }, true);
    }
};

export { selectWith, registerKeySelectionEvents, type Gesture };
