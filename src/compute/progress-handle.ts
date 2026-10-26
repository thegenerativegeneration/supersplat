import type { ProgressFn } from './protocol';
import type { Events } from '../events';
import { i18n } from '../ui/localization';

type ProgressHandle = {
    signal: AbortSignal,
    update: ProgressFn,
    // hides Cancel and shows this text from now on
    lockCancel(textKey: string): void,
    // idempotent
    end(): void
};

// Blocks input at once, reveals the dialog after revealAfterMs and turns the
// dialog's Cancel into the handle's signal. Every start pairs with one progressEnd.
const startProgress = (events: Events, headerKey: string, revealAfterMs = 300): ProgressHandle => {
    const abort = new AbortController();
    let active = true;

    const cancelHandle = events.on('progressCancel', () => abort.abort());
    events.fire('progressStart', i18n.t(headerKey), true, { revealAfterMs });

    return {
        signal: abort.signal,

        update: (stage, done, total) => {
            if (!active) return;
            const text = i18n.t(`progress.${stage}`, { done, total });
            // an unknown total clears the fill, leaving the bar's pulse
            const progress = done !== undefined && total ? 100 * done / total : 0;
            events.fire('progressUpdate', { text, progress });
        },

        lockCancel: (textKey) => {
            if (!active) return;
            cancelHandle.off();
            events.fire('progressUpdate', { text: i18n.t(textKey), cancellable: false });
        },

        end: () => {
            if (!active) return;
            active = false;
            cancelHandle.off();
            events.fire('progressEnd');
        }
    };
};

const withProgress = async <T>(events: Events, headerKey: string, fn: (handle: ProgressHandle) => Promise<T>): Promise<T> => {
    const handle = startProgress(events, headerKey);
    try {
        return await fn(handle);
    } finally {
        handle.end();
    }
};

export { startProgress, withProgress };
export type { ProgressHandle };
