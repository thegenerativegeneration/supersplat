import { Button, Container, Label, Element as PcuiElement, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { PanelSection } from './panel-section';
import { SeedsPanel } from './seeds-panel';
import arrowSvg from './svg/arrow.svg';
import hiddenSvg from './svg/hidden.svg';
import selectBoxSvg from './svg/select-box.svg';
import shownSvg from './svg/shown.svg';
import { ObjectsData, ObjectsState, SceneObject } from '../objects/objects-data';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const formatCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

// one line of the tree: optional expand arrow, text, Gaussian count, eye toggle. `slots` index ObjectsData.objects
class ObjectRow extends Container {
    ids: number[];
    slots: number[];
    allHidden = false;
    allSelected = false;
    arrow: PcuiElement | null = null;
    render: (state: ObjectsState) => void;

    constructor(text: string, count: number, objects: { id: number, slot: number }[], tooltip: string, group: boolean) {
        super({ class: ['objects-row', group ? 'objects-group' : 'objects-item'] });
        this.ids = objects.map(o => o.id);
        this.slots = objects.map(o => o.slot);
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

        // all / some / none of the row's Gaussians hidden or selected, from the splat's own flags
        this.render = (state: ObjectsState) => {
            let total = 0, numHidden = 0, numSelected = 0;
            this.slots.forEach((k) => {
                total += state.total[k];
                numHidden += state.hidden[k];
                numSelected += state.selected[k];
            });
            const visible = total - numHidden;
            this.allHidden = total > 0 && numHidden === total;
            this.allSelected = visible > 0 && numSelected === visible;
            shown.hidden = this.allHidden;
            hidden.hidden = !this.allHidden;
            this.class[this.allHidden ? 'add' : 'remove']('hidden-object');
            this.class[numHidden > 0 && !this.allHidden ? 'add' : 'remove']('partly-hidden');
            this.class[this.allSelected ? 'add' : 'remove']('selected');
            this.class[numSelected > 0 && !this.allSelected ? 'add' : 'remove']('partly-selected');
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
    o.parts ? i18n.t('objects.parts', { n: o.parts }) : '',
    o.cls ? `${i18n.t('objects.class')}: ${o.cls}` : '',
    o.alt.length ? `${i18n.t('objects.suggestions')}: ${o.alt.map(([w, c]) => `${w} ${c.toFixed(3)}`).join(', ')}` : '',
    o.names?.vlm ? `VLM: ${o.names.vlm}` : '',
    o.names?.siglip ? `SigLIP2: ${o.names.siglip.map(([w]) => w).join(', ')}` : ''
].filter(Boolean).join('\n');

// groups by name (collapsed), larger groups first; walls, floors and ceilings last
const groupsOf = (objects: SceneObject[]) => {
    const byName = new Map<string, { o: SceneObject, slot: number }[]>();
    objects.forEach((o, slot) => {
        if (!byName.has(o.name)) byName.set(o.name, []);
        byName.get(o.name).push({ o, slot });
    });
    const groups = [...byName.entries()].map(([name, list]) => ({
        name,
        list: list.sort((a, b) => b.o.count - a.o.count),
        structure: list.every(({ o }) => o.structure)
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
        // loaded objects files of this splat; switching shows another file without reloading
        const fileSelect = new SelectInput({ class: 'objects-file', hidden: true });
        const list = new Container({ class: 'objects-list' });
        this.content.append(bar);
        this.content.append(fileSelect);
        this.content.append(list);
        this.content.append(new SeedsPanel(events));

        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.json';
        picker.onchange = async () => {
            const file = picker.files?.[0];
            picker.value = '';
            if (file) await events.invoke('objects.load', file);
        };
        load.on('click', () => picker.click());

        let rows: ObjectRow[] = [];

        const wire = (row: ObjectRow) => {
            // shift-click adds, or removes a row that is already fully selected
            row.on('pick', (r: ObjectRow, shift: boolean) => {
                events.fire('objects.select', r.ids, shift ? (r.allSelected ? 'remove' : 'add') : 'set');
            });
            row.on('focus', (r: ObjectRow) => events.fire('objects.focus', r.ids));
            row.on('toggleHidden', (r: ObjectRow) => events.fire('objects.setHidden', r.ids, !r.allHidden));
            rows.push(row);
        };

        const build = (data: ObjectsData | null) => {
            list.clear();
            rows = [];
            info.text = data ? `${data.segmenter} · ${data.objects.length} · ${data.file}` : i18n.t('objects.none');
            if (!data) return;
            groupsOf(data.objects).forEach(({ name, list: members }) => {
                const count = members.reduce((s, { o }) => s + o.count, 0);
                const row = new ObjectRow(`${name} (${members.length})`, count, members.map(({ o, slot }) => ({ id: o.id, slot })),
                    name, true);
                const box = new Container({ class: 'objects-children', hidden: true });
                wire(row);
                members.forEach(({ o, slot }) => {
                    const child = new ObjectRow(`${o.name} ${o.id}`, o.count, [{ id: o.id, slot }], tooltipOf(o), false);
                    wire(child);
                    box.append(child);
                });
                row.on('toggleExpand', () => {
                    box.hidden = !box.hidden;
                    row.class[box.hidden ? 'remove' : 'add']('expanded');
                });
                list.append(row);
                list.append(box);
            });
        };

        let updatingFiles = false;
        fileSelect.on('change', (value: string) => {
            if (!updatingFiles && value !== null) events.fire('objects.use', Number(value));
        });
        events.on('objects.sets', (sets: { names: string[], current: number } | null) => {
            updatingFiles = true;
            fileSelect.options = sets ? sets.names.map((n, k) => ({ v: String(k), t: n })) : [];
            fileSelect.value = sets ? String(sets.current) : null;
            fileSelect.hidden = !sets;
            updatingFiles = false;
        });

        events.on('objects.changed', build);
        events.on('objects.state', (state: ObjectsState | null) => state && rows.forEach(r => r.render(state)));
        build(null);
    }
}

export { ObjectsPanel };
