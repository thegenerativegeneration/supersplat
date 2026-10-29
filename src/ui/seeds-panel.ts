import { Button, Container, Label, TextInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { Seed } from '../objects/seed-marker';

// seed points under the objects list: mark toggle, count, save, clear (asks again), one row per seed with a note
class SeedsPanel extends Container {
    constructor(events: Events) {
        super({ class: 'seeds-panel' });

        const title = new Label({ class: 'seeds-title' });
        const mark = new Button({ class: 'seeds-button' });
        const save = new Button({ class: 'seeds-button', enabled: false });
        const clear = new Button({ class: 'seeds-button', enabled: false });
        i18n.bindText(mark, 'objects.seeds.mark');
        i18n.bindText(save, 'objects.seeds.save');
        i18n.bindText(clear, 'objects.seeds.clear');
        const bar = new Container({ class: 'seeds-bar' });
        [title, mark, save, clear].forEach(e => bar.append(e));
        const hint = new Label({ class: 'seeds-hint', hidden: true });
        i18n.bindText(hint, 'objects.seeds.hint');
        const list = new Container({ class: 'seeds-list' });
        this.append(bar);
        this.append(hint);
        this.append(list);

        mark.on('click', () => events.fire('tool.seeds'));
        save.on('click', () => events.fire('seeds.save'));

        let armed: ReturnType<typeof setTimeout> | null = null;
        clear.on('click', () => {
            if (armed) {
                clearTimeout(armed);
                armed = null;
                clear.class.remove('armed');
                events.fire('seeds.clear');
                return;
            }
            clear.class.add('armed');
            clear.text = i18n.t('objects.seeds.clear-confirm');
            armed = setTimeout(() => {
                armed = null;
                clear.class.remove('armed');
                clear.text = i18n.t('objects.seeds.clear');
            }, 3000);
        });

        events.on('seeds.marking', (on: boolean) => {
            mark.class[on ? 'add' : 'remove']('active');
            hint.hidden = !on;
        });

        events.on('seeds.changed', (seeds: Seed[]) => {
            title.text = i18n.t('objects.seeds', { n: seeds.length });
            save.enabled = clear.enabled = seeds.length > 0;
            if (!armed) clear.text = i18n.t('objects.seeds.clear');
            list.clear();
            // newest first, so the seed just placed is at the top
            [...seeds].reverse().forEach((s) => {
                const row = new Container({ class: 'seeds-row' });
                const num = new Label({ text: `#${s.id}`, class: 'seeds-num' });
                const note = new TextInput({ value: s.note, class: 'seeds-note', placeholder: i18n.t('objects.seeds.note') });
                note.on('change', (v: string) => events.fire('seeds.note', s.id, v));
                const remove = new Button({ text: '×', class: 'seeds-remove' });
                remove.on('click', () => events.fire('seeds.remove', s.id));
                [num, note, remove].forEach(e => row.append(e));
                list.append(row);
            });
        });

        title.text = i18n.t('objects.seeds', { n: 0 });
    }
}

export { SeedsPanel };
