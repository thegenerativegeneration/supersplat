import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { inlinePlanner } from './.build/src/fix-path-events.js';
import { FIX, fakeGrid, fakeRoute, pose, setup, summary } from './fix-path-events.mjs';
import { progressCounts } from './progress-counts.mjs';

const fakeSceneGrid = async () => ({ grid: fakeGrid, eyeHeight: 1.6 });

// three keys with the wall between the last two
const KEYS = () => [pose('camera_0', 0, 0), pose('camera_1', 30, 4), pose('camera_2', 60, 8)];

// a finished run; returns the markers it shows, with the route before it
const fixOnce = async ({ events, markers }) => {
    const result = await events.invoke('path.fix', FIX);
    assert.equal(result.ok, true);
    const shown = markers[markers.length - 1];
    assert.ok(shown.before.length > 0);
    return shown;
};

const fixPathCancelChecks = {
    async 'path: cancel before the plan applies nothing and keeps the markers'() {
        const run = setup(KEYS());
        const shown = await fixOnce(run);
        const { events, ops, markers } = run;
        const counts = progressCounts(events);
        const original = summary(events);
        const pending = events.invoke('path.fix', FIX);
        events.fire('progressCancel');
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'cancelled');
        assert.deepEqual(summary(events), original);
        assert.equal(ops.length, 1, 'only the first run');
        assert.deepEqual(counts, { start: 1, end: 1 });
        assert.equal(markers[markers.length - 1], shown, 'markers and route before the first run stay');
    },

    async 'path: cancel returns at once while a sampling batch hangs'() {
        let calls = 0;
        let hang = false;
        const run = setup(KEYS(), {
            onSample: () => {
                if (!hang) return;
                calls++;
                return new Promise(() => {});
            }
        });
        const shown = await fixOnce(run);
        const { events, ops, markers } = run;
        hang = true;
        const counts = progressCounts(events);
        const original = summary(events);
        const pending = events.invoke('path.fix', FIX);
        await new Promise(resolve => setTimeout(resolve, 0));
        events.fire('progressCancel');
        let timer;
        const result = await Promise.race([pending, new Promise((resolve) => {
            timer = setTimeout(() => resolve({ reason: 'timeout' }), 1000);
        })]);
        clearTimeout(timer);
        assert.equal(result.reason, 'cancelled');
        assert.equal(calls, 1);
        assert.deepEqual(summary(events), original);
        assert.equal(ops.length, 1, 'only the first run');
        assert.deepEqual(counts, { start: 1, end: 1 });
        assert.equal(markers[markers.length - 1], shown, 'markers and route before the first run stay');
    },

    async 'path: cancel after the planner replied applies nothing and keeps the markers'() {
        let events = null;
        let cancelNext = false;
        const base = inlinePlanner(fakeSceneGrid, fakeRoute);
        const planner = async (input, opts) => {
            const reply = await base(input, opts);
            if (cancelNext) events.fire('progressCancel');
            return reply;
        };
        const run = setup(KEYS(), { deps: { planner } });
        events = run.events;
        const shown = await fixOnce(run);
        cancelNext = true;
        const counts = progressCounts(events);
        const original = summary(events);
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'cancelled');
        assert.deepEqual(summary(events), original);
        assert.equal(run.ops.length, 1, 'only the first run');
        assert.deepEqual(counts, { start: 1, end: 1 });
        assert.equal(run.markers[run.markers.length - 1], shown, 'markers and route before the first run stay');
    },

    async 'path: a moved key position fails with keysChanged'() {
        // addKey names the key camera_<number of keys>, so camera_3 keeps its name
        let release = null;
        const sampled = new Promise((resolve) => {
            release = resolve;
        });
        const { events, ops, popups } = setup([pose('camera_0', 0, 0), pose('camera_3', 30, 4), pose('camera_2', 60, 8)], {
            onSample: () => sampled
        });
        const names = summary(events);
        const pending = events.invoke('path.fix', FIX);
        events.functions.delete('camera.getPose');
        events.function('camera.getPose', () => ({ position: new Vec3(4, 1, 0.5), target: new Vec3(4, 1, -1), fov: 60 }));
        events.fire('track.addKey', 30);
        assert.deepEqual(summary(events), names, 'same names and frames');
        assert.equal(events.invoke('camera.poses').find(p => p.frame === 30).position.z, 0.5);
        release();
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'keysChanged');
        assert.deepEqual(ops.map(op => op.name), ['addKey'], 'only the overwrite');
        assert.equal(popups.length, 1);
    },

    async 'path: a planner error rejects, shows no apply and ends progress once'() {
        const planner = async () => {
            throw new Error('planner failed');
        };
        const { events, ops, popups } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4)], { deps: { planner } });
        const counts = progressCounts(events);
        const original = summary(events);
        await assert.rejects(events.invoke('path.fix', FIX), /planner failed/);
        assert.deepEqual(summary(events), original);
        assert.equal(ops.length, 0);
        assert.equal(popups.length, 0);
        assert.deepEqual(counts, { start: 1, end: 1 });
    }
};

export { fixPathCancelChecks };
