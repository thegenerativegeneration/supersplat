import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import i18next from 'i18next';

import { startProgress, withProgress } from './.build/src/compute/progress-handle.js';
import { Events } from './.build/src/events.js';

const en = JSON.parse(readFileSync(new URL('../static/locales/en.json', import.meta.url), 'utf8'));

const setup = async () => {
    if (!i18next.isInitialized) {
        await i18next.init({ lng: 'en', resources: { en: { translation: en } } });
    }
    const events = new Events();
    const fired = [];
    for (const name of ['progressStart', 'progressUpdate', 'progressEnd']) {
        // EventHandler pads the callback with undefined arguments
        events.on(name, (...args) => fired.push([name, ...args.filter(a => a !== undefined)]));
    }
    return { events, fired };
};

const progressHandleChecks = {
    'progress: start fires progressStart with Cancel and the reveal delay': async () => {
        const { events, fired } = await setup();
        const handle = startProgress(events, 'timeline.fix-path');
        assert.deepEqual(fired, [['progressStart', 'Fix Path', true, { revealAfterMs: 300 }]]);
        assert.equal(handle.signal.aborted, false);
        handle.end();
    },

    'progress: progressCancel aborts only the active handle': async () => {
        const { events } = await setup();
        const first = startProgress(events, 'timeline.fix-path');
        first.end();
        const second = startProgress(events, 'timeline.fix-path');
        events.fire('progressCancel');
        assert.equal(first.signal.aborted, false);
        assert.equal(second.signal.aborted, true);

        const third = startProgress(events, 'timeline.fix-path');
        third.lockCancel('progress.timing');
        events.fire('progressCancel');
        assert.equal(third.signal.aborted, false);
        third.end();
    },

    'progress: end is idempotent and withProgress ends on throw': async () => {
        const { events, fired } = await setup();
        const handle = startProgress(events, 'timeline.fix-path');
        handle.end();
        handle.end();
        assert.equal(fired.filter(f => f[0] === 'progressEnd').length, 1);

        fired.length = 0;
        const boom = new Error('boom');
        await assert.rejects(withProgress(events, 'timeline.fix-path', async () => {
            throw boom;
        }), error => error === boom);
        assert.deepEqual(fired.map(f => f[0]), ['progressStart', 'progressEnd']);
    },

    'progress: update maps stages to text and percentage, an unknown total clears the fill': async () => {
        const { events, fired } = await setup();
        const handle = startProgress(events, 'timeline.fix-path');
        fired.length = 0;
        handle.update('routes', 3, 12);
        handle.update('grid');
        handle.lockCancel('progress.timing');
        assert.deepEqual(fired, [
            ['progressUpdate', { text: 'Finding routes 3/12', progress: 25 }],
            ['progressUpdate', { text: 'Building the walkable grid', progress: 0 }],
            ['progressUpdate', { text: 'Balancing the timing', cancellable: false }]
        ]);
        handle.end();
    }
};

export { progressHandleChecks };
