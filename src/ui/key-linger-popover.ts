import { Container, Label, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';

// small panel opened by right-clicking a camera key marker, for the key's linger
class KeyLingerPopover extends Container {
    constructor(events: Events, args = {}) {
        super({
            ...args,
            class: 'key-linger-popover',
            hidden: true
        });

        const title = new Label({ class: 'key-linger-title' });
        const label = new Label({ class: 'key-linger-label', text: i18n.t('timeline.linger') });
        const input = new NumericInput({
            class: 'key-linger-input',
            min: 0,
            max: 60,
            step: 0.5,
            precision: 2,
            value: 0
        });

        const row = new Container({ class: 'key-linger-row' });
        row.append(label);
        row.append(input);
        this.append(title);
        this.append(row);

        let frame = -1;
        let syncing = false;

        const close = () => {
            this.hidden = true;
        };

        const lingerOf = (keyFrame: number) => {
            const lingers = events.invoke('camera.keyLingers') as { frame: number, linger: number }[] ?? [];
            return lingers.find(l => l.frame === keyFrame)?.linger ?? 0;
        };

        input.on('change', (value: number) => {
            if (!syncing && !this.hidden && Number.isFinite(value)) {
                events.fire('track.setLinger', frame, value);
            }
        });

        events.on('timeline.keyContextMenu', (keyFrame: number, clientX: number, clientY: number) => {
            frame = keyFrame;
            title.text = i18n.t('timeline.key-at-frame', { frame: keyFrame });
            label.text = i18n.t('timeline.linger');
            syncing = true;
            input.value = lingerOf(keyFrame);
            syncing = false;

            this.hidden = false;

            const x = Math.max(0, Math.min(clientX, window.innerWidth - this.dom.offsetWidth - 4));
            const y = Math.max(0, Math.min(clientY - this.dom.offsetHeight - 8, window.innerHeight - this.dom.offsetHeight - 4));
            this.dom.style.left = `${x}px`;
            this.dom.style.top = `${y}px`;
        });

        // the key set changed under the popover (move, remove, undo)
        ['keyRemoved', 'keyMoved', 'keysLoaded', 'keysCleared'].forEach((name) => {
            events.on(`track.${name}`, close);
        });

        window.addEventListener('pointerdown', (event: Event) => {
            if (!this.hidden && !this.dom.contains(event.target as Node)) {
                close();
            }
        }, true);
        window.addEventListener('blur', close);
        window.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !this.hidden) {
                event.stopPropagation();
                close();
            }
        }, true);
    }
}

export { KeyLingerPopover };
