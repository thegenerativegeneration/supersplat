import { BooleanInput, Button, Container, Label, NumericInput } from '@playcanvas/pcui';

import type { Pose } from '../camera-poses';
import { Events } from '../events';
import { changesFor, editorFields, leavesShot, viewChanges, type EditorField, type EditorFields } from './key-editor-model';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

// how long a missed pick is reported
const MISSED_MS = 4000;

type PickMode = 'position' | 'target';

// pointer presses here leave the editor open: the scene (to frame a view or
// pick), the timeline and any key surface
const keepsOpen = (target: EventTarget) => target instanceof Element &&
    !!target.closest('#canvas, #tools-container, #timeline-panel, [data-key-surface]');

/**
 * Popover that edits the selected keys, opened by `keys.edit(id, x, y)`. It
 * follows the selection and the keys (undo, Fix Path) and closes when the
 * selection is empty. With several keys, fields that differ are blank and
 * the view controls are disabled.
 */
class KeyEditor extends Container {
    constructor(events: Events, tooltips: Tooltips) {
        super({ class: 'key-editor', hidden: true });
        // a press in the editor keeps Delete on the keys
        this.dom.dataset.keySurface = '';

        // set while the fields show the keys, and while a typed value is discarded
        let syncing = false;
        let fields: EditorFields | null = null;

        const selectedPoses = () => {
            const ids = new Set(events.invoke('keys.selected') as string[] ?? []);
            return (events.invoke('camera.poses') as Pose[]).filter(p => ids.has(p.id));
        };
        const frameRate = () => events.invoke('timeline.frameRate') as number;

        // header

        const header = new Container({ class: 'key-editor-header' });
        const title = new Label({ class: 'key-editor-title' });
        const closeButton = new Button({ class: 'key-editor-close', text: '×' });
        header.append(title);
        header.append(closeButton);
        this.append(header);
        const titleText = () => (!fields ? '' : fields.count === 1 ?
            i18n.t('timeline.key-at-frame', { frame: fields.frame }) :
            i18n.t('key-editor.keys', { count: fields.count }));
        i18n.bindText(title, titleText);

        // fields

        const row = (text: string, input: NumericInput | BooleanInput, tooltip?: string) => {
            const r = new Container({ class: 'key-editor-row' });
            const label = new Label({ class: 'key-editor-label' });
            i18n.bindText(label, text);
            r.append(label);
            r.append(input);
            this.append(r);
            if (tooltip) tooltips.register(r, () => i18n.t(tooltip), 'right');
            return r;
        };

        const numberInput = (args: { min?: number, max?: number, step: number, precision: number }) => new NumericInput({
            class: 'key-editor-input', allowNull: true, hideSlider: true, value: null, ...args
        });

        const time = numberInput({ min: 0, step: 0.1, precision: 2 });
        const frame = numberInput({ min: 0, step: 1, precision: 0 });
        const linger = numberInput({ min: 0, max: 60, step: 0.5, precision: 2 });
        const fov = numberInput({ min: 10, max: 120, step: 1, precision: 1 });
        const lookAhead = new BooleanInput({ class: 'key-editor-toggle', type: 'toggle' });
        const turnIn = numberInput({ min: 0.1, max: 10, step: 0.5, precision: 1 });

        row('key-editor.time', time);
        row('key-editor.frame', frame);
        row('timeline.linger', linger);
        row('panel.settings.fov', fov);
        row('key-editor.look-ahead', lookAhead, 'tooltip.key-editor.look-ahead');
        const turnInRow = row('key-editor.turn-in', turnIn, 'tooltip.key-editor.turn-in');

        // view buttons

        // a view button explains why it is disabled for several keys
        const button = (parent: Container, text: string, tooltip: string, view = true) => {
            const b = new Button({ class: 'key-editor-button' });
            i18n.bindText(b, text);
            parent.append(b);
            tooltips.register(b, () => i18n.t(view && fields?.viewEditable === false ? 'tooltip.key-editor.one-key' : tooltip), 'right');
            return b;
        };

        const viewButtons = new Container({ class: ['key-editor-buttons', 'key-editor-view'] });
        this.append(viewButtons);
        const updateView = button(viewButtons, 'key-editor.update-view', 'tooltip.key-editor.update-view');
        const pickPosition = button(viewButtons, 'key-editor.pick-position', 'tooltip.key-editor.pick-position');
        const pickTarget = button(viewButtons, 'key-editor.pick-target', 'tooltip.key-editor.pick-target');

        const hint = new Label({ class: 'key-editor-hint', hidden: true });
        this.append(hint);

        // position and target under More

        const more = new Container({ class: 'key-editor-more', hidden: true });
        const vectorRow = (text: string) => {
            const r = new Container({ class: 'key-editor-vector' });
            const label = new Label({ class: 'key-editor-label' });
            i18n.bindText(label, text);
            r.append(label);
            const inputs = [0, 1, 2].map(() => numberInput({ step: 0.1, precision: 3 }));
            inputs.forEach(input => r.append(input));
            more.append(r);
            return inputs;
        };
        const position = vectorRow('panel.scene.transform.position');
        const target = vectorRow('key-editor.target');

        const footer = new Container({ class: 'key-editor-buttons' });
        const moreButton = new Button({ class: 'key-editor-button' });
        i18n.bindText(moreButton, 'key-editor.more');
        footer.append(moreButton);
        const deleteButton = button(footer, 'key-editor.delete', 'tooltip.key-editor.delete', false);
        this.append(more);
        this.append(footer);

        // showing the keys

        const showVector = (inputs: NumericInput[], v: { x: number, y: number, z: number } | null) => {
            inputs.forEach((input, i) => {
                input.value = v ? [v.x, v.y, v.z][i] : null;
                input.enabled = !!v;
            });
        };

        let closing = false;
        const close = () => {
            if (this.hidden || closing) return;
            // a typed value commits on blur, so blur while the editor still edits the keys
            closing = true;
            const active = document.activeElement;
            if (active instanceof HTMLElement && this.dom.contains(active)) active.blur();
            closing = false;
            events.fire('keys.pickCancel');
            this.hidden = true;
        };

        const refresh = () => {
            const poses = selectedPoses();
            if (poses.length === 0) {
                fields = null;
                close();
                return;
            }
            fields = editorFields(poses, frameRate());
            syncing = true;
            title.text = titleText();
            time.value = fields.time;
            frame.value = fields.frame;
            linger.value = fields.linger;
            fov.value = fields.fov;
            if (fields.lookAhead === null) {
                lookAhead.values = [true, false];
            } else {
                lookAhead.value = fields.lookAhead;
            }
            turnIn.value = fields.turnIn;
            turnInRow.enabled = fields.lookAhead !== false;
            showVector(position, fields.position);
            showVector(target, fields.target);
            [updateView, pickPosition, pickTarget].forEach((b) => {
                b.enabled = fields.viewEditable;
            });
            syncing = false;
        };

        // editing the keys

        const apply = (changes: ReturnType<typeof changesFor>, poses: Pose[]) => {
            if (changes.length === 0) return;
            if (leavesShot(poses, changes, events.invoke('timeline.frames') - 1)) {
                // the shot's end bounds the editor as frame 0 bounds the track
                events.fire('track.refused', 'outOfRange');
            } else {
                events.fire('track.updateKeys', changes);
            }
        };

        const commit = (field: EditorField, value: unknown) => {
            if (syncing || this.hidden) return;
            const poses = selectedPoses();
            apply(changesFor(poses, field, value, frameRate()), poses);
            // the real values, also after a refusal
            refresh();
        };

        const vectorValue = (inputs: NumericInput[]) => {
            const [x, y, z] = inputs.map(input => input.value);
            return { x, y, z };
        };

        time.on('change', (v: number | null) => commit('time', v));
        frame.on('change', (v: number | null) => commit('frame', v));
        linger.on('change', (v: number | null) => commit('linger', v));
        fov.on('change', (v: number | null) => commit('fov', v));
        lookAhead.on('change', (v: boolean) => commit('lookAhead', v));
        turnIn.on('change', (v: number | null) => commit('turnIn', v));
        position.forEach(input => input.on('change', () => commit('position', vectorValue(position))));
        target.forEach(input => input.on('change', () => commit('target', vectorValue(target))));

        updateView.on('click', () => {
            const poses = selectedPoses();
            apply(viewChanges(poses, events.invoke('camera.getPose')), poses);
        });

        const startPick = (mode: PickMode) => {
            const poses = selectedPoses();
            if (events.invoke('keys.picking') === mode) {
                events.fire('keys.pickCancel');
            } else if (poses.length === 1) {
                events.fire('keys.pick', mode, poses[0].id);
            }
        };
        pickPosition.on('click', () => startPick('position'));
        pickTarget.on('click', () => startPick('target'));

        let missedTimer: ReturnType<typeof setTimeout> | null = null;
        const showHint = (text: string | null) => {
            clearTimeout(missedTimer);
            hint.text = text ?? '';
            hint.hidden = !text;
        };
        events.on('keys.picking', (mode: PickMode | null) => {
            pickPosition.class[mode === 'position' ? 'add' : 'remove']('active');
            pickTarget.class[mode === 'target' ? 'add' : 'remove']('active');
            showHint(mode ? i18n.t('key-editor.pick-hint') : null);
        });
        events.on('keys.pickMissed', () => {
            if (this.hidden) return;
            showHint(i18n.t('key-editor.pick-missed'));
            missedTimer = setTimeout(() => showHint(null), MISSED_MS);
        });

        moreButton.on('click', () => {
            more.hidden = !more.hidden;
            moreButton.class[more.hidden ? 'remove' : 'add']('active');
        });
        deleteButton.on('click', () => events.fire('keys.delete'));
        closeButton.on('click', close);

        // opening and following the keys

        const place = (clientX: number, clientY: number) => {
            const { offsetWidth: w, offsetHeight: h } = this.dom;
            const x = Math.max(4, Math.min(clientX - w / 2, window.innerWidth - w - 4));
            const above = clientY - h - 12;
            const y = above >= 4 ? above : Math.min(clientY + 12, window.innerHeight - h - 4);
            this.dom.style.left = `${x}px`;
            this.dom.style.top = `${Math.max(4, y)}px`;
        };

        events.on('keys.edit', (id: string, clientX: number, clientY: number) => {
            if (!(events.invoke('camera.poses') as Pose[]).some(p => p.id === id)) return;
            if (!(events.invoke('keys.selected') as string[]).includes(id)) events.fire('keys.setSelection', [id]);
            events.fire('keys.focus', true);
            this.hidden = false;
            refresh();
            place(clientX, clientY);
        });

        const follow = () => {
            if (!this.hidden) refresh();
        };
        events.on('keys.selectionChanged', () => {
            events.fire('keys.pickCancel');
            follow();
        });
        ['keysLoaded', 'keyAdded', 'keyRemoved', 'keyMoved', 'keyUpdated', 'keysCleared'].forEach((name) => {
            events.on(`track.${name}`, follow);
        });
        events.on('timeline.frameRate', follow);

        window.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!this.hidden && !this.dom.contains(event.target as Node) && !keepsOpen(event.target)) close();
        }, true);

        // Escape drops a typed value and closes; while picking, the pick mode
        // takes Escape first and the editor stays open
        window.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || this.hidden || events.invoke('keys.picking')) return;
            event.stopPropagation();
            syncing = true;
            close();
            syncing = false;
        }, true);
    }
}

export { KeyEditor };
