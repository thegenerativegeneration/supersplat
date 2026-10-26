import { Button, Container, NumericInput, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { BalanceControls } from './balance-controls';
import { FixPathControls } from './fix-path-controls';
import { KeyLingerPopover } from './key-linger-popover';
import { i18n } from './localization';
import { OrbitControls } from './orbit-controls';
import { createStatusLine } from './status-line';
import { SuggestViewsButton } from './suggest-views-button';
import { Ticks } from './timeline-ticks';
import { Tooltips } from './tooltips';

class TimelinePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'timeline-panel'
        };

        super(args);

        // play controls

        const prev = new Button({
            class: 'button',
            text: '\uE162'
        });

        const play = new Button({
            class: 'button',
            text: '\uE131'
        });

        const next = new Button({
            class: 'button',
            text: '\uE164'
        });

        // key controls

        const addKey = new Button({
            class: 'button',
            text: '\uE120'
        });

        const removeKey = new Button({
            class: 'button',
            text: '\uE121',
            enabled: false
        });

        const buttonControls = new Container({
            id: 'button-controls'
        });
        buttonControls.append(prev);
        buttonControls.append(play);
        buttonControls.append(next);
        buttonControls.append(addKey);
        buttonControls.append(removeKey);

        // settings

        const speed = new SelectInput({
            id: 'speed',
            defaultValue: 30,
            options: [
                { v: 1, t: '1 fps' },
                { v: 6, t: '6 fps' },
                { v: 12, t: '12 fps' },
                { v: 24, t: '24 fps' },
                { v: 30, t: '30 fps' },
                { v: 60, t: '60 fps' }
            ]
        });

        speed.on('change', (value: string) => {
            events.fire('timeline.setFrameRate', parseInt(value, 10));
        });

        events.on('timeline.frameRate', (frameRate: number) => {
            speed.value = frameRate.toString();
        });

        const frames = new NumericInput({
            id: 'totalFrames',
            value: 180,
            min: 1,
            max: 10000,
            precision: 0
        });

        frames.on('change', (value: number) => {
            events.fire('timeline.setFrames', value);
        });

        events.on('timeline.frames', (framesIn: number) => {
            frames.value = framesIn;
        });

        // smoothness

        const smoothness = new NumericInput({
            id: 'smoothness',
            min: 0,
            max: 1,
            step: 0.05,
            value: 1
        });

        smoothness.on('change', (value: number) => {
            events.fire('timeline.setSmoothness', value);
        });

        events.on('timeline.smoothness', (smoothnessIn: number) => {
            smoothness.value = smoothnessIn;
        });

        // loop

        const loop = new Button({
            id: 'loop',
            text: '\uE128'
        });

        loop.on('click', () => {
            events.fire('timeline.setLoop', !events.invoke('timeline.loop'));
        });

        events.on('timeline.loop', (loopIn: boolean) => {
            loop.class[loopIn ? 'add' : 'remove']('active');
        });

        if (events.invoke('timeline.loop')) {
            loop.class.add('active');
        }

        const settingsControls = new Container({
            id: 'settings-controls'
        });
        settingsControls.append(speed);
        settingsControls.append(frames);
        settingsControls.append(smoothness);
        settingsControls.append(loop);
        settingsControls.append(new BalanceControls(events, tooltips));
        settingsControls.append(new FixPathControls(events, tooltips));
        settingsControls.append(new OrbitControls(events, tooltips));
        settingsControls.append(new SuggestViewsButton(events, tooltips));

        // append control groups

        const controlsWrap = new Container({
            id: 'controls-wrap'
        });

        const spacerL = new Container({
            class: 'spacer'
        });

        const spacerR = new Container({
            class: 'spacer'
        });
        spacerR.append(settingsControls);

        controlsWrap.append(spacerL);
        controlsWrap.append(buttonControls);
        controlsWrap.append(spacerR);

        const ticks = new Ticks(events, tooltips);

        this.append(controlsWrap);
        this.append(ticks);
        this.append(new KeyLingerPopover(events));

        // ui handlers

        prev.on('click', (evt: MouseEvent) => {
            if (evt.shiftKey) {
                events.fire('timeline.prevKey');
            } else {
                events.fire('timeline.prevFrame');
            }
        });

        next.on('click', (evt: MouseEvent) => {
            if (evt.shiftKey) {
                events.fire('timeline.nextKey');
            } else {
                events.fire('timeline.nextFrame');
            }
        });

        play.on('click', () => {
            if (events.invoke('timeline.playing')) {
                events.fire('timeline.setPlaying', false);
            } else {
                events.fire('timeline.setPlaying', true);
            }
        });

        // Sync play button icon when playing state changes (e.g. via keyboard shortcut)
        events.on('timeline.playing', (isPlaying: boolean) => {
            play.text = isPlaying ? '\uE135' : '\uE131';
        });

        addKey.on('click', () => {
            events.fire('track.addKey');
        });

        removeKey.on('click', () => {
            events.fire('keys.delete');
        });

        events.on('keys.selectionChanged', (ids: string[]) => {
            removeKey.enabled = ids.length > 0;
        });

        const { show: showStatus } = createStatusLine(this, ticks.dom);
        events.on('track.refused', (reason: string) => {
            if (reason === 'frameTaken') showStatus(i18n.t('status.frame-taken'));
        });

        // cancel animation playback if user interacts with camera
        events.on('camera.controller', (type: string) => {
            if (events.invoke('timeline.playing')) {
                // stop
            }
        });

        // tooltips
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return i18n.formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(prev, tooltip('tooltip.timeline.prev-frame', 'timeline.prevFrame'), 'top');
        tooltips.register(play, tooltip('tooltip.timeline.play', 'timeline.togglePlay'), 'top');
        tooltips.register(next, tooltip('tooltip.timeline.next-frame', 'timeline.nextFrame'), 'top');
        tooltips.register(addKey, tooltip('tooltip.timeline.add-key', 'track.addKey'), 'top');
        tooltips.register(removeKey, tooltip('tooltip.timeline.remove-key'), 'top');
        tooltips.register(speed, () => i18n.t('tooltip.timeline.frame-rate'), 'top');
        tooltips.register(frames, () => i18n.t('tooltip.timeline.total-frames'), 'top');
        tooltips.register(smoothness, () => i18n.t('tooltip.timeline.smoothness'), 'top');
        tooltips.register(loop, () => i18n.t('tooltip.timeline.loop'), 'top');
    }
}

export { TimelinePanel };
