import { Button, Container, Label, Element as PcuiElement } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { PanelSection } from './panel-section';
import arrowSvg from './svg/arrow.svg';
import hiddenSvg from './svg/hidden.svg';
import selectBoxSvg from './svg/select-box.svg';
import shownSvg from './svg/shown.svg';
import { ObjectsData, SceneObject } from '../objects/objects-data';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const formatCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

// one line of the tree: optional expand arrow, text, Gaussian count, eye toggle
class ObjectRow extends Container {
    ids: number[];
    eye: (hidden: boolean) => void;
    arrow: PcuiElement | null = null;

    constructor(text: string, count: number, ids: number[], tooltip: string, group: boolean) {
        super({ class: ['objects-row', group ? 'objects-group' : 'objects-item'] });
        this.ids = ids;
        if (group) {
            this.arrow = new PcuiElement({ dom: createSvg(arrowSvg), class: 'objects-arrow' });
            this.append(this.arrow);
        }
        const label = new Label({ text, class: 'objects-text' });
        label.dom.title = tooltip;
        const countLabel = new Label({ text: formatCount(count), class: 'objects-count' });
        const shown = new PcuiElement({ dom: createSvg(shownSvg), class: 'objects-eye' });
        const hidden = new PcuiElement({ dom: createSvg(hiddenSvg), class: 'objects-eye', hidden: true });
        this.append(label);
        this.append(countLabel);
        this.append(shown);
        this.append(hidden);
        this.eye = (isHidden: boolean) => {
            shown.hidden = isHidden;
            hidden.hidden = !isHidden;
            this.class[isHidden ? 'add' : 'remove']('hidden-object');
        };
        [shown, hidden].forEach(e => e.dom.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('toggleHidden', this);
        }));
        this.arrow?.dom.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('toggleExpand', this);
        });
        this.dom.addEventListener('click', (event: MouseEvent) => this.emit('pick', this, event.shiftKey));
        this.dom.addEventListener('dblclick', () => this.emit('focus', this));
    }
}

const tooltipOf = (o: SceneObject) => [
    `${o.name} #${o.id}: ${o.count} Gaussians`,
    o.cls ? `${i18n.t('objects.class')}: ${o.cls}` : '',
    `${i18n.t('objects.suggestions')}: ${o.alt.map(([w, c]) => `${w} ${c.toFixed(3)}`).join(', ')}`
].filter(Boolean).join('\n');

// groups by name (collapsed), larger groups first; walls, floors and ceilings last
const groupsOf = (objects: SceneObject[]) => {
    const byName = new Map<string, SceneObject[]>();
    objects.forEach((o) => {
        if (!byName.has(o.name)) byName.set(o.name, []);
        byName.get(o.name).push(o);
    });
    const groups = [...byName.entries()].map(([name, list]) => ({
        name,
        list: list.sort((a, b) => b.count - a.count),
        structure: list.every(o => o.structure)
    }));
    return groups.sort((a, b) => (Number(a.structure) - Number(b.structure)) ||
        (b.list.length - a.list.length) || a.name.localeCompare(b.name));
};

class ObjectsPanel extends PanelSection {
    constructor(events: Events) {
        super({ id: 'objects-section', icon: selectBoxSvg, localeKey: 'panel.objects' });

        const info = new Label({ class: 'objects-info' });
        const load = new Button({ class: 'objects-load' });
        i18n.bindText(load, 'objects.load');
        const bar = new Container({ class: 'objects-bar' });
        bar.append(info);
        bar.append(load);
        const list = new Container({ class: 'objects-list' });
        this.content.append(bar);
        this.content.append(list);

        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.json';
        picker.onchange = async () => {
            const file = picker.files?.[0];
            picker.value = '';
            if (file) await events.invoke('objects.load', file);
        };
        load.on('click', () => picker.click());

        const hidden = new Set<number>();
        let rows: { row: ObjectRow, children: ObjectRow[] }[] = [];
        let picked = new Set<ObjectRow>();

        const refreshEyes = () => rows.forEach(({ row, children }) => {
            children.forEach(c => c.eye(hidden.has(c.ids[0])));
            row.eye(row.ids.every(id => hidden.has(id)));
        });

        const setPicked = (next: Set<ObjectRow>) => {
            picked.forEach(r => r.class.remove('selected'));
            next.forEach(r => r.class.add('selected'));
            picked = next;
        };

        const wire = (row: ObjectRow) => {
            row.on('pick', (r: ObjectRow, add: boolean) => {
                setPicked(add ? new Set([...picked, r]) : new Set([r]));
                events.fire('objects.select', r.ids, add);
            });
            row.on('focus', (r: ObjectRow) => {
                setPicked(new Set([r]));
                events.fire('objects.focus', r.ids);
            });
            row.on('toggleHidden', (r: ObjectRow) => {
                const hide = !r.ids.every(id => hidden.has(id));
                r.ids.forEach(id => (hide ? hidden.add(id) : hidden.delete(id)));
                events.fire('objects.setHidden', r.ids, hide);
                refreshEyes();
            });
        };

        const build = (data: ObjectsData | null) => {
            list.clear();
            rows = [];
            picked = new Set();
            hidden.clear();
            info.text = data ? `${data.segmenter} · ${data.objects.length} · ${data.file}` : i18n.t('objects.none');
            if (!data) return;
            groupsOf(data.objects).forEach(({ name, list: objects }) => {
                const count = objects.reduce((s, o) => s + o.count, 0);
                const row = new ObjectRow(`${name} (${objects.length})`, count, objects.map(o => o.id), name, true);
                const box = new Container({ class: 'objects-children', hidden: true });
                const children = objects.map((o) => {
                    const child = new ObjectRow(`${o.name} ${o.id}`, o.count, [o.id], tooltipOf(o), false);
                    wire(child);
                    box.append(child);
                    return child;
                });
                wire(row);
                row.on('toggleExpand', () => {
                    box.hidden = !box.hidden;
                    row.class[box.hidden ? 'remove' : 'add']('expanded');
                });
                row.class[box.hidden ? 'remove' : 'add']('expanded');
                list.append(row);
                list.append(box);
                rows.push({ row, children });
            });
            refreshEyes();
        };

        events.on('objects.changed', build);
        build(null);
    }
}

export { ObjectsPanel };
