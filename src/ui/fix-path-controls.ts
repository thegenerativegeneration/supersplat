import { BooleanInput, Button, Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { fixReport } from '../path/markers';

const MIN_KEYS = 2;

// runs shorter than this finish without a spinner
const SPINNER_DELAY_MS = 300;

// how long the status line after a clean run stays up
const STATUS_MS = 4000;

type Options = { keepOrder: boolean, allowFlying: boolean };

type Settings = { eyeHeight: number };

// options for Fix path, opened from the gear next to the button
class FixPathOptions extends Container {
    open: (anchor: HTMLElement) => void;

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
        const eyeHeight = new Label({ class: 'fix-path-eye-height' });
        const hint = new Label({ class: 'fix-path-hint' });
        i18n.bindText(hint, 'fix-path.eye-height-hint');
        this.append(eyeHeight);
        this.append(hint);

        const formatHeight = (height: number) => (Number.isFinite(height) ? height.toFixed(2) : '–');

        // the eye height Fix path will use: the last Suggest Views value, else the estimate
        const showEyeHeight = async () => {
            const last = events.invoke('candidates.lastSettings') as Settings | null;
            if (last) {
                eyeHeight.text = i18n.t('fix-path.eye-height', { height: formatHeight(last.eyeHeight) });
                return;
            }
            eyeHeight.text = i18n.t('fix-path.eye-height', { height: '…' });
            let estimate = NaN;
            try {
                const prepared = await events.invoke('candidates.prepare') as Settings & { points: number };
                if (prepared.points > 0) estimate = prepared.eyeHeight;
            } catch {
                // no splats to estimate from
            }
            if (!this.hidden && !events.invoke('candidates.lastSettings')) {
                eyeHeight.text = i18n.t('fix-path.eye-height-estimated', { height: formatHeight(estimate) });
            }
        };

        let anchorEl: HTMLElement | null = null;

        const close = () => {
            this.hidden = true;
        };

        this.open = (anchor: HTMLElement) => {
            anchorEl = anchor;
            const settings = events.invoke('path.settings') as Options;
            keepOrder.value = settings.keepOrder;
            allowFlying.value = settings.allowFlying;
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
        const status = new Label({ class: 'fix-path-status', hidden: true });
        this.append(status);
        let statusTimer: ReturnType<typeof setTimeout> | null = null;

        const hideStatus = () => {
            clearTimeout(statusTimer);
            status.hidden = true;
        };

        const showStatus = (text: string) => {
            hideStatus();
            status.text = text;
            status.hidden = false;
            const rect = button.dom.getBoundingClientRect();
            const x = Math.max(4, Math.min(rect.left, window.innerWidth - status.dom.offsetWidth - 4));
            status.dom.style.left = `${x}px`;
            status.dom.style.top = `${Math.max(4, rect.top - status.dom.offsetHeight - 6)}px`;
            statusTimer = setTimeout(hideStatus, STATUS_MS);
        };

        let busy = false;

        const updateEnabled = () => {
            const poses = events.invoke('camera.poses') as { auto?: boolean }[] ?? [];
            button.enabled = !busy && poses.filter(p => !p.auto).length >= MIN_KEYS;
        };

        const showReport = async (result: Parameters<typeof fixReport>[0]) => {
            const report = fixReport(result);
            if (!report) return;
            const text = report.lines.map(line => i18n.t(line.key, line.params)).join('\n');
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
                options.hidden = true;
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
