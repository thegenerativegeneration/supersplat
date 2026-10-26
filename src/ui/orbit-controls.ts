import { Button, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { createStatusLine, reportText } from './status-line';
import { Tooltips } from './tooltips';
import { clampSpan, type OrbitSpec } from '../orbit/orbit-path';
import type { OrbitPreview } from '../orbit/orbit-preview-line';
import { orbitKeyCount, orbitReport, turnTimeLine } from '../orbit/orbit-readout';
import type { OrbitAddResult, OrbitDefaults, OrbitPlan } from '../orbit-events';

// field changes this close together plan once
const PREVIEW_DELAY_MS = 150;
const DEFAULT_SPAN = 360;

type Fields = { radius: number, height: number, spanDeg: number, dir: 1 | -1 };

// a labelled number input with a unit after it
const numberRow = (parent: Container, text: string, args: object) => {
    const row = new Container({ class: 'orbit-row' });
    const label = new Label({ class: 'orbit-row-label' });
    i18n.bindText(label, text);
    const input = new NumericInput({ class: 'orbit-row-input', ...args });
    const unit = new Label({ class: 'orbit-row-unit' });
    row.append(label);
    row.append(input);
    row.append(unit);
    parent.append(row);
    return { input, unit };
};

// the Orbit popover: fields defaulting from the camera, a live 3D preview and Add Orbit
class OrbitOptions extends Container {
    open: (anchor: HTMLElement) => void;

    close: () => void;

    constructor(events: Events, onAdd: (spec: OrbitSpec, metric: boolean) => void) {
        super({ class: 'orbit-options', hidden: true });

        const radius = numberRow(this, 'orbit.radius', { min: 0, step: 0.1, precision: 2 });
        const height = numberRow(this, 'orbit.height', { step: 0.1, precision: 2 });
        const span = numberRow(this, 'orbit.span', { min: 90, max: 360, step: 22.5, precision: 1, value: DEFAULT_SPAN });
        span.unit.text = '°';

        const dirRow = new Container({ class: 'orbit-row' });
        const dirLabel = new Label({ class: 'orbit-row-label' });
        i18n.bindText(dirLabel, 'orbit.direction');
        const dir = new SelectInput({ class: 'orbit-row-select', defaultValue: 'left' });
        i18n.bindOptions(dir, () => [
            { v: 'left', t: i18n.t('orbit.left') },
            { v: 'right', t: i18n.t('orbit.right') }
        ]);
        dirRow.append(dirLabel);
        dirRow.append(dir);
        this.append(dirRow);

        const keys = new Label({ class: 'orbit-keys' });
        const hint = new Label({ class: 'orbit-hint', hidden: true });
        const turnTime = new Label({ class: 'orbit-hint', hidden: true });
        const add = new Button({ class: 'orbit-add' });
        i18n.bindText(add, 'orbit.add');
        this.append(keys);
        this.append(hint);
        this.append(turnTime);
        this.append(add);

        let defaults: OrbitDefaults | null = null;
        // the time at the turn cap scales with the span
        let turnSecondsPerDeg = 0;
        // set while the inputs show values, so they don't trigger a plan
        let syncing = false;
        // the latest plan request; older answers are dropped
        let planId = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let anchorEl: HTMLElement | null = null;

        const fields = (): Fields => ({
            radius: radius.input.value,
            height: height.input.value,
            spanDeg: clampSpan(span.input.value),
            dir: dir.value === 'right' ? -1 : 1
        });

        const specOf = (d: OrbitDefaults): OrbitSpec => ({ centre: d.centre, startDeg: d.startDeg, fov: d.fov, ...fields() });

        const showLine = (label: Label, key: string | null, params?: Record<string, string>) => {
            label.hidden = !key;
            if (key) label.text = i18n.t(key, params);
        };

        const showKeys = () => {
            keys.text = i18n.t('orbit.keys', { count: String(orbitKeyCount(fields().spanDeg)) });
            const line = defaults ? turnTimeLine(turnSecondsPerDeg * fields().spanDeg, defaults.shotSeconds) : null;
            showLine(turnTime, line?.key ?? null, line?.params);
        };

        // without defaults fill() is still loading and plans once it is done
        const preview = async () => {
            if (!defaults) return;
            const id = ++planId;
            const spec = specOf(defaults);
            showLine(hint, 'orbit.checking');
            let plan: OrbitPlan;
            try {
                plan = await events.invoke('orbit.plan', spec) as OrbitPlan;
            } catch {
                // superseded by a newer preview, or an error Add Orbit reports
                if (id === planId && !this.hidden) showLine(hint, null);
                return;
            }
            if (id !== planId || this.hidden) return;
            if ('blocked' in plan) {
                showLine(hint, plan.reason === 'noSplats' ? 'orbit.noSplats' : 'orbit.blocked');
            } else {
                const reduced = { radius: `${plan.radius.toFixed(2)} ${radius.unit.text}` };
                showLine(hint, plan.reduced ? 'orbit.reduced' : null, reduced);
            }
            const shown: OrbitPreview = {
                keys: plan.keys,
                blockedRanges: plan.blockedRanges,
                centre: spec.centre,
                radius: plan.radius ?? 0,
                height: spec.height,
                startDeg: spec.startDeg,
                spanDeg: spec.spanDeg,
                dir: spec.dir
            };
            events.fire('orbit.preview', shown);
        };

        const schedule = () => {
            if (syncing) return;
            showKeys();
            clearTimeout(timer);
            timer = setTimeout(preview, PREVIEW_DELAY_MS);
        };
        [radius.input, height.input, span.input, dir].forEach(input => input.on('change', schedule));

        // round the span to whole keys as soon as it is typed
        span.input.on('change', (value: number) => {
            const rounded = clampSpan(value);
            if (!syncing && rounded !== value) span.input.value = rounded;
        });

        const close = () => {
            if (this.hidden) return;
            // blur first: a typed value only commits on blur
            [radius.input, height.input, span.input].forEach(input => input.blur());
            clearTimeout(timer);
            planId++;
            this.hidden = true;
            events.fire('orbit.preview', null);
        };
        this.close = close;

        const fill = async () => {
            const id = ++planId;
            add.enabled = false;
            showLine(hint, 'fix-path.estimating');
            const spanDeg = fields().spanDeg;
            let d: OrbitDefaults | null = null;
            try {
                d = await events.invoke('orbit.defaults', spanDeg) as OrbitDefaults | null;
            } catch {
                // no splats to orbit around
            }
            if (id !== planId || this.hidden) return;
            defaults = d;
            turnSecondsPerDeg = d ? d.turnSeconds / spanDeg : 0;
            if (!defaults) {
                showLine(hint, 'orbit.noSplats');
                events.fire('orbit.preview', null);
                return;
            }
            syncing = true;
            radius.input.value = Number(defaults.radius.toFixed(2));
            height.input.value = Number(defaults.height.toFixed(2));
            syncing = false;
            const unit = i18n.t(defaults.metric ? 'fix-path.unit-metres' : 'fix-path.unit-scene');
            radius.unit.text = unit;
            height.unit.text = unit;
            add.enabled = true;
            showKeys();
            preview();
        };

        this.open = (anchor: HTMLElement) => {
            anchorEl = anchor;
            defaults = null;
            if (!Number.isFinite(span.input.value)) {
                syncing = true;
                span.input.value = DEFAULT_SPAN;
                syncing = false;
            }
            showLine(hint, null);
            showLine(turnTime, null);
            showKeys();
            this.hidden = false;
            fill();

            const rect = anchor.getBoundingClientRect();
            const x = Math.max(4, Math.min(rect.right - this.dom.offsetWidth, window.innerWidth - this.dom.offsetWidth - 4));
            this.dom.style.left = `${x}px`;
            // pinned by its bottom edge: hint lines that appear later grow it upwards
            this.dom.style.bottom = `${window.innerHeight - rect.top + 6}px`;
        };

        add.on('click', () => {
            if (!defaults) return;
            // commit typed values before reading them
            [radius.input, height.input, span.input].forEach(input => input.blur());
            const spec = specOf(defaults);
            const metric = defaults.metric;
            close();
            onAdd(spec, metric);
        });

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

// the Orbit button, its popover and the report after Add Orbit
class OrbitControls extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        super({ ...args, id: 'orbit-controls' });

        const button = new Button({ id: 'orbit' });
        i18n.bindText(button, 'timeline.orbit');
        this.append(button);

        const { show: showStatus, hide: hideStatus } = createStatusLine(this, button.dom);
        let busy = false;

        const addOrbit = async (spec: OrbitSpec, metric: boolean) => {
            if (busy) return;
            busy = true;
            button.enabled = false;
            hideStatus();
            let result: OrbitAddResult | null = null;
            let failure = null;
            try {
                result = await events.invoke('orbit.add', spec) as OrbitAddResult;
            } catch (error) {
                failure = error;
            } finally {
                busy = false;
                button.enabled = true;
            }
            if (failure || !result) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('orbit.failed'),
                    message: String(failure?.message ?? failure ?? '')
                });
                return;
            }
            if (result.reason === 'cancelled') {
                showStatus(i18n.t('status.cancelled'));
                return;
            }
            const unit = i18n.t(metric ? 'fix-path.unit-metres' : 'fix-path.unit-scene');
            const report = orbitReport(result, metric, unit);
            if (!report) return;
            const text = reportText(report.lines);
            if (report.type === 'status') {
                showStatus(text);
                return;
            }
            await events.invoke('showPopup', {
                type: report.type,
                header: i18n.t(report.type === 'error' ? 'orbit.failed' : 'orbit.report'),
                message: text
            });
        };

        const options = new OrbitOptions(events, addOrbit);
        this.append(options);

        button.on('click', () => {
            if (options.hidden) {
                options.open(button.dom);
            } else {
                options.close();
            }
        });

        tooltips.register(button, () => i18n.t('tooltip.timeline.orbit'), 'top');
    }
}

export { OrbitControls };
