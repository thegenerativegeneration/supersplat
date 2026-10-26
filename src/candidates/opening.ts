import type { ProgressFn } from '../compute/protocol';

type OpeningHooks<T> = {
    // starts the shared read and estimate; called again only after a failure or forget()
    prepare: (onProgress: ProgressFn) => Promise<T>;
    onProgress: ProgressFn;
    // the panel is open and waiting for the value
    onLoading: () => void;
    onReady: (value: T) => void;
    onFailed: (error: unknown) => void;
};

// Opens a panel at once and fills it when the prepared value arrives.
// Closing only detaches: the pending preparation keeps running, a late result
// fills nothing, and opening again waits for the same preparation.
const createOpening = <T>(hooks: OpeningHooks<T>) => {
    let value: T | null = null;
    let pending: Promise<T> | null = null;
    // bumped by every open and close, so only the latest open may fill the panel
    let ticket = 0;

    const start = () => {
        const run = hooks.prepare(hooks.onProgress);
        pending = run;
        run.then((v) => {
            if (pending === run) value = v;
        }, () => {
            if (pending === run) pending = null;
        });
        return run;
    };

    const open = async () => {
        const mine = ++ticket;
        if (value) {
            hooks.onReady(value);
            return;
        }
        hooks.onLoading();
        try {
            const result = await (pending ?? start());
            if (mine === ticket) hooks.onReady(result);
        } catch (error) {
            if (mine === ticket) hooks.onFailed(error);
        }
    };

    const close = () => {
        ticket++;
    };

    // the scene changed: the next open prepares again
    const forget = () => {
        value = null;
        pending = null;
    };

    return { open, close, forget, ready: () => value !== null };
};

export { createOpening };
export type { OpeningHooks };
