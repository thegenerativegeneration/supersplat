import { Button, Container, Element } from '@playcanvas/pcui';

import type { Pose } from '../camera-poses';
import { Events } from '../events';
import { isMac, markerAction, toggleKeyName } from './key-marker-gestures';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { AUTO_KEY_COLOR, cssChannels } from '../path/colors';

// three frames side by side
const STRIP_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<rect x="0.5" y="4" width="4.5" height="8" rx="1"/><rect x="5.75" y="4" width="4.5" height="8" rx="1"/>' +
    '<rect x="11" y="4" width="4.5" height="8" rx="1"/></svg>';

type TileKind = 'key' | 'detour' | 'parked';

// keys that play by frame, then those past the end of the shot
const tileOrder = (poses: Pose[], frames: number) => {
    const byFrame = poses.slice().sort((a, b) => a.frame - b.frame);
    const kind = (p: Pose): TileKind => (p.frame >= frames ? 'parked' : p.auto ? 'detour' : 'key');
    return byFrame.map(p => ({ pose: p, kind: kind(p) }));
};

/**
 * Thumbnails of the camera keys above the timeline. Clicks select as on the
 * timeline markers; double-click or right-click opens the key editor. Tiles
 * are key surfaces, so Delete stays on the keys after a click. Images come
 * from `keys.thumbnail`; a tile without one shows only its time.
 */
class KeyStrip extends Container {
    toggle: Button;

    constructor(events: Events, tooltips: Tooltips) {
        super({ id: 'key-strip' });
        this.dom.style.setProperty('--auto-key-rgb', cssChannels(AUTO_KEY_COLOR));

        this.toggle = new Button({ id: 'key-strip-toggle', class: 'active' });
        this.toggle.dom.innerHTML = STRIP_ICON;
        tooltips.register(this.toggle, () => i18n.t('tooltip.timeline.key-strip'), 'top');

        const images = new Map<string, HTMLCanvasElement>();
        // pcui wrappers around tiles, kept so their tooltips unregister on rebuild
        let tileElements: Element[] = [];

        const tileTooltip = (kind: TileKind, seconds: string) => () => {
            const what = kind === 'detour' ? 'tooltip.timeline.key-tile-detour' : kind === 'parked' ? 'tooltip.timeline.key-tile-parked' : 'tooltip.timeline.key-tile';
            return `${i18n.t(what, { time: seconds })} ${i18n.t('tooltip.timeline.key-tile-gestures', { toggle: toggleKeyName })}`;
        };

        const edit = (id: string, tile: HTMLElement) => {
            const rect = tile.getBoundingClientRect();
            events.fire('keys.edit', id, (rect.left + rect.right) / 2, rect.top);
        };

        const addGestures = (tile: HTMLElement, id: string) => {
            tile.addEventListener('click', (event: MouseEvent) => {
                // Ctrl+click raises contextmenu on macOS
                if (isMac && event.ctrlKey) return;
                const toggle = isMac ? event.metaKey : event.ctrlKey;
                const action = markerAction({ button: 0, shift: event.shiftKey, alt: event.altKey, toggle }, false, 0);
                if (action.kind !== 'select') return;
                events.fire('keys.select', id, action.gesture);
                events.fire('keys.focus', true);
            });
            tile.addEventListener('dblclick', () => edit(id, tile));
            tile.addEventListener('contextmenu', (event: MouseEvent) => {
                event.preventDefault();
                edit(id, tile);
            });
        };

        const rebuild = () => {
            tileElements.forEach(el => el.destroy());
            tileElements = [];
            this.dom.innerHTML = '';

            const poses = events.invoke('camera.poses') as Pose[] ?? [];
            const live = new Set(poses.map(p => p.id));
            [...images.keys()].filter(id => !live.has(id)).forEach(id => images.delete(id));
            this.class[poses.length ? 'remove' : 'add']('empty');

            const frameRate = events.invoke('timeline.frameRate') as number;
            const selected = new Set(events.invoke('keys.selected') as string[] ?? []);

            tileOrder(poses, events.invoke('timeline.frames')).forEach(({ pose, kind }) => {
                const tile = document.createElement('div');
                tile.classList.add('key-tile', kind);
                tile.classList.toggle('selected', selected.has(pose.id));
                tile.dataset.id = pose.id;
                tile.dataset.keySurface = '';

                const image = images.get(pose.id);
                if (image) tile.appendChild(image);

                const seconds = (pose.frame / frameRate).toFixed(1);
                if (kind !== 'detour') {
                    const time = document.createElement('span');
                    time.classList.add('key-tile-time');
                    time.textContent = `${seconds} s`;
                    tile.appendChild(time);
                }

                addGestures(tile, pose.id);
                const wrapper = new Element({ dom: tile });
                tooltips.register(wrapper, tileTooltip(kind, seconds), 'top');
                tileElements.push(wrapper);
                this.dom.appendChild(tile);
            });
        };

        events.on('keys.thumbnail', (id: string, canvas: HTMLCanvasElement) => {
            images.get(id)?.remove();
            images.set(id, canvas);
            this.dom.querySelector<HTMLElement>(`.key-tile[data-id="${CSS.escape(id)}"]`)?.prepend(canvas);
        });

        events.on('keys.selectionChanged', (ids: string[]) => {
            const selected = new Set(ids);
            this.dom.querySelectorAll<HTMLElement>('.key-tile').forEach((tile) => {
                tile.classList.toggle('selected', selected.has(tile.dataset.id));
            });
        });

        ['keysLoaded', 'keyAdded', 'keyRemoved', 'keyMoved', 'keyUpdated', 'keysCleared'].forEach((name) => {
            events.on(`track.${name}`, rebuild);
        });
        events.on('timeline.frames', rebuild);
        events.on('timeline.frameRate', rebuild);

        // a vertical wheel scrolls the strip sideways
        this.dom.addEventListener('wheel', (event: WheelEvent) => {
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
            this.dom.scrollLeft += event.deltaY;
            event.preventDefault();
        }, { passive: false });

        // shown or hidden, kept as a preference
        let shown = true;
        events.function('timeline.keyStrip', () => shown);
        events.on('timeline.setKeyStrip', (value: boolean) => {
            if (value === shown) return;
            shown = value;
            this.hidden = !shown;
            this.toggle.class[shown ? 'add' : 'remove']('active');
            events.fire('timeline.keyStrip', shown);
        });
        this.toggle.on('click', () => events.fire('timeline.setKeyStrip', !shown));

        this.on('destroy', () => {
            tileElements.forEach(el => el.destroy());
            tileElements = [];
        });

        rebuild();
    }
}

// the strip above the timeline controls, its toggle in `controls`
const mountKeyStrip = (panel: Container, controls: Container, events: Events, tooltips: Tooltips) => {
    const strip = new KeyStrip(events, tooltips);
    panel.prepend(strip);
    controls.append(strip.toggle);
};

export { mountKeyStrip };
