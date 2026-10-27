import { Events } from '../events';
import { Progress } from './progress';

type ProgressStartOptions = { revealAfterMs?: number };
type ProgressUpdateOptions = { text?: string, progress?: number, cancellable?: boolean };

const registerProgressEvents = (events: Events, progress: Progress) => {
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    // focus moves into the dialog so keyboard shortcuts stay blocked (.blocks-shortcuts)
    let focusBeforeProgress: HTMLElement | null = null;
    const clearRevealTimer = () => {
        if (revealTimer !== null) {
            clearTimeout(revealTimer);
            revealTimer = null;
        }
    };

    events.on('progressStart', (header: string, cancellable?: boolean, options?: ProgressStartOptions) => {
        clearRevealTimer();
        if (progress.hidden) {
            focusBeforeProgress = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        progress.hidden = false;
        progress.dom.focus({ preventScroll: true });
        // blocks input at once; the dialog itself shows after the delay
        const delay = options?.revealAfterMs ?? 0;
        progress.class[delay > 0 ? 'add' : 'remove']('pending');
        if (delay > 0) {
            revealTimer = setTimeout(() => {
                revealTimer = null;
                progress.class.remove('pending');
            }, delay);
        }
        progress.setHeader(header);
        progress.setText('');
        progress.setProgress(0);
        progress.showCancelButton(!!cancellable);
        progress.onCancel = cancellable ? () => events.fire('progressCancel') : null;
    });

    events.on('progressUpdate', (options: ProgressUpdateOptions) => {
        if (options.cancellable !== undefined) {
            progress.showCancelButton(options.cancellable);
            if (!options.cancellable) progress.onCancel = null;
        }
        if (options.text !== undefined) {
            progress.setText(options.text);
        }
        if (options.progress !== undefined) {
            progress.setProgress(options.progress);
        }
    });

    events.on('progressEnd', () => {
        clearRevealTimer();
        progress.class.remove('pending');
        progress.hidden = true;
        progress.showCancelButton(false);
        progress.onCancel = null;
        if (focusBeforeProgress?.isConnected) {
            focusBeforeProgress.focus({ preventScroll: true });
        }
        focusBeforeProgress = null;
    });
};

export { registerProgressEvents };
