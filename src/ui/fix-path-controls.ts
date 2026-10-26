import { BooleanInput, Button, Container, Label, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { createStatusLine, reportText, sceneIsMetric } from './status-line';
import { Tooltips } from './tooltips';
import { fixReport } from '../path/markers';

const MIN_KEYS = 2;

// runs shorter than this finish without a spinner
const SPINNER_DELAY_MS = 300;

type Options = { keepOrder: boolean, allowFlying: boolean, smallestOpening: number, eyeHeight: number };

type EyeHeightInfo = { eyeHeight: number, estimate: number, estimated: boolean, metric: boolean };

// range of the smallest opening, as a fraction of eye height (see clampOpening)
const OPENING_MIN = 0.25;
const OPENING_MAX = 1.25;
// the grid voxel, as a fraction of eye height: the opening rounds to it
const OPENING_STEP = 0.25;

// options for Fix path, opened from the gear next to the button
class FixPathOptions extends Container {
    open: (anchor: HTMLElement) => void;

    close: () => void;

    constructor(events: Events, tooltips: Tooltips) {
        super({ class: 'fix-path-options', hidden: true });

        const toggle = (key: keyof Options, text: string, tooltip: string) => {
            const row = new Container({ class: 'fix-path-option' });
            const input = new BooleanInput({ class: 'fix-path-option-input' });
            const label = new Label({ class: 'fix-path-option-label' });
            i18n.bindText(label, text);
            row.append(input);
            row.append(label);
            this.append(row);
            input.on('change', (value: boolean) => events.fire('path.setSettings', { [key]: value }));
            label.dom.addEventListener('click', () => {
                input.value = !input.value;
            });
            tooltips.register(row, () => i18n.t(tooltip), 'right');
            return input;
        };

        const keepOrder = toggle('keepOrder', 'fix-path.keep-order', 'tooltip.fix-path.keep-order');
        const allowFlying = toggle('allowFlying', 'fix-path.allow-flying', 'tooltip.fix-path.allow-flying');

        // a labelled number field with a unit
        const numberRow = (text: string, tooltip: string, input: NumericInput) => {
            const row = new Container({ class: 'fix-path-number' });
            const label = new Label({ class: 'fix-path-number-label' });
            i18n.bindText(label, text);
            const unit = new Label({ class: 'fix-path-number-unit' });
            row.append(label);
            row.append(input);
            row.append(unit);
            this.append(row);
            tooltips.register(row, () => i18n.t(tooltip), 'right');
            return unit;
        };

        const eyeInput = new NumericInput({ class: 'fix-path-number-input', min: 0.01, step: 0.05, precision: 2, value: 1.6 });
        const eyeUnit = numberRow('fix-path.eye-height', 'tooltip.fix-path.eye-height', eyeInput);
        const eyeHint = new Label({ class: 'fix-path-hint' });
        this.append(eyeHint);

        const openingInput = new NumericInput({ class: 'fix-path-number-input', step: 0.4, precision: 2 });
        const openingUnit = numberRow('fix-path.smallest-opening', 'tooltip.fix-path.smallest-opening', openingInput);

        // set while the inputs show the current settings, so defaults stay defaults
        let syncing = false;
        let metric = false;

        const formatHeight = (height: number) => (Number.isFinite(height) ? height.toFixed(2) : '–');

        const showOpening = (eye: number) => {
            syncing = true;
            openingInput.min = Number((OPENING_MIN * eye).toFixed(2));
            openingInput.max = Number((OPENING_MAX * eye).toFixed(2));
            openingInput.step = Number((OPENING_STEP * eye).toFixed(2));
            openingInput.value = Number((events.invoke('path.settings') as Options).smallestOpening.toFixed(2));
            syncing = false;
            const unit = i18n.t(metric ? 'fix-path.unit-metres' : 'fix-path.unit-scene');
            openingUnit.text = unit;
            eyeUnit.text = unit;
        };

        const showHint = (info: EyeHeightInfo | null) => {
            eyeHint.text = !info ? '' : info.estimated ?
                i18n.t('fix-path.eye-height-estimated') :
                i18n.t('fix-path.eye-height-estimate', { height: formatHeight(info.estimate) });
        };

        // the eye height Fix path will use (the user's, else the estimate),
        // the opening range and unit that follow from it
        const showEyeHeight = async () => {
            let info: EyeHeightInfo | null = null;
            try {
                info = await events.invoke('path.eyeHeight') as EyeHeightInfo | null;
            } catch {
                // no splats to estimate from
            }
            if (this.hidden) return;
            metric = info?.metric ?? false;
            syncing = true;
            eyeInput.value = Number((info?.eyeHeight ?? 1.6).toFixed(2));
            syncing = false;
            showHint(info);
            showOpening(info?.eyeHeight ?? 1.6);
        };

        eyeInput.on('change', (value: number) => {
            if (syncing || !Number.isFinite(value) || value <= 0) return;
            events.fire('path.setSettings', { eyeHeight: value });
            showEyeHeight();
        });
        openingInput.on('change', (value: number) => {
            if (!syncing && Number.isFinite(value)) events.fire('path.setSettings', { smallestOpening: value });
        });

        let anchorEl: HTMLElement | null = null;

        const close = () => {
            // blur first: a typed number only commits on blur, and must do so
            // before a click on Fix Path runs
            if (!this.hidden) {
                eyeInput.blur();
                openingInput.blur();
            }
            this.hidden = true;
        };
        this.close = close;

        this.open = (anchor: HTMLElement) => {
            anchorEl = anchor;
            const settings = events.invoke('path.settings') as Options;
            keepOrder.value = settings.keepOrder;
            allowFlying.value = settings.allowFlying;
            syncing = true;
            eyeInput.value = Number(settings.eyeHeight.toFixed(2));
            openingInput.value = Number(settings.smallestOpening.toFixed(2));
            syncing = false;
            eyeHint.text = '';
            this.hidden = false;
            showEyeHeight();

            const rect = anchor.getBoundingClientRect();
            const x = Math.max(4, Math.min(rect.right - this.dom.offsetWidth, window.innerWidth - this.dom.offsetWidth - 4));
            this.dom.style.left = `${x}px`;
            this.dom.style.top = `${Math.max(4, rect.top - this.dom.offsetHeight - 6)}px`;
        };

        window.addEventListener('pointerdown', (event: Event) => {
            const target = event.target as Node;
            if (!this.hidden && !this.dom.contains(target) && !anchorEl?.contains(target)) {
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

// the Fix Path button, its options and the report after a run
class FixPathControls extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        super({ ...args, id: 'fix-path-controls' });

        const button = new Button({ id: 'fix-path' });
        i18n.bindText(button, 'timeline.fix-path');
        const optionsButton = new Button({ id: 'fix-path-options', text: '' });
        const options = new FixPathOptions(events, tooltips);

        this.append(button);
        this.append(optionsButton);
        this.append(options);

        // non-modal line above the button after a clean run
        const { show: showStatus, hide: hideStatus } = createStatusLine(this, button.dom);

        let busy = false;

        const updateEnabled = () => {
            const poses = events.invoke('camera.poses') as { auto?: boolean }[] ?? [];
            button.enabled = !busy && poses.filter(p => !p.auto).length >= MIN_KEYS;
        };

        const showReport = async (result: Parameters<typeof fixReport>[0] & { metric?: boolean }) => {
            const report = fixReport(result, result.metric ?? sceneIsMetric(events));
            if (!report) return;
            const text = reportText(report.lines);
            if (report.type === 'status') {
                showStatus(text);
                return;
            }
            await events.invoke('showPopup', {
                type: report.type,
                header: i18n.t(report.type === 'error' ? 'fix-path.failed' : 'fix-path.report'),
                message: text
            });
        };

        button.on('click', async () => {
            if (busy) return;
            busy = true;
            hideStatus();
            updateEnabled();
            let spinning = false;
            const timer = setTimeout(() => {
                spinning = true;
                events.fire('startSpinner');
            }, SPINNER_DELAY_MS);
            let result = null;
            let failure = null;
            try {
                result = await events.invoke('path.fix');
            } catch (error) {
                failure = error;
            } finally {
                clearTimeout(timer);
                if (spinning) events.fire('stopSpinner');
                busy = false;
                updateEnabled();
            }
            if (failure) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('fix-path.failed'),
                    message: String(failure?.message ?? failure)
                });
            } else if (result) {
                await showReport(result);
            }
        });

        optionsButton.on('click', () => {
            if (options.hidden) {
                options.open(optionsButton.dom);
            } else {
                options.close();
            }
        });

        ['keyAdded', 'keyRemoved', 'keyMoved', 'keyUpdated', 'keysLoaded', 'keysCleared'].forEach((name) => {
            events.on(`track.${name}`, updateEnabled);
        });
        updateEnabled();

        tooltips.register(button, () => i18n.t('tooltip.timeline.fix-path'), 'top');
        tooltips.register(optionsButton, () => i18n.t('tooltip.timeline.fix-path-options'), 'top');
    }
}

export { FixPathControls };
