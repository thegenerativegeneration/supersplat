import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { looksMetric, type Box } from '../candidates/estimate';
import type { ReportLine } from '../path/markers';

// how long a status line stays up
const STATUS_MS = 4000;

// the translated lines joined by newlines
const reportText = (lines: ReportLine[]) => lines.map((line) => {
    const params = { ...line.params };
    for (const [name, key] of Object.entries(line.keyParams ?? {})) params[name] = i18n.t(key);
    return i18n.t(line.key, params);
}).join('\n');

// whether the scene is probably in metres, from the last Suggest Views box
const sceneIsMetric = (events: Events) => {
    const last = events.functions.has('candidates.lastSettings') ?
        events.invoke('candidates.lastSettings') as { box: Box } | null :
        null;
    return last ? looksMetric(last.box) : false;
};

// A non-modal line above an anchor element that hides itself after a while.
const createStatusLine = (parent: Container, anchor: HTMLElement) => {
    const status = new Label({ class: 'status-line', hidden: true });
    parent.append(status);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const hide = () => {
        clearTimeout(timer);
        status.hidden = true;
    };

    const show = (text: string) => {
        hide();
        status.text = text;
        status.hidden = false;
        const rect = anchor.getBoundingClientRect();
        const x = Math.max(4, Math.min(rect.left, window.innerWidth - status.dom.offsetWidth - 4));
        status.dom.style.left = `${x}px`;
        status.dom.style.top = `${Math.max(4, rect.top - status.dom.offsetHeight - 6)}px`;
        timer = setTimeout(hide, STATUS_MS);
    };

    return { show, hide };
};

export { createStatusLine, reportText, sceneIsMetric };
