import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { inlinePlanner } from './.build/src/fix-path-events.js';
import { FIX, fakeGrid, fakeRoute, pose, setup, summary } from './fix-path-events.mjs';
import { progressCounts } from './progress-counts.mjs';

const fakeSceneGrid = async () => ({ grid: fakeGrid, eyeHeight: 1.6 });

const fixPathCancelChecks = {
    async 'path: cancel before the plan applies nothing'() {
        const { events, ops } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4), pose('camera_2', 60, 8)]);
        const counts = progressCounts(events);
        const original = summary(events);
        const pending = events.invoke('path.fix', FIX);
        events.fire('progressCancel');
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'cancelled');
        assert.deepEqual(summary(events), original);
        assert.equal(ops.length, 0);
        assert.deepEqual(counts, { start: 1, end: 1 });
    },

    async 'path: cancel returns at once while a sampling batch hangs'() {
        let calls = 0;
        const { events, ops } = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4), pose('camera_2', 60, 8)], {
            onSample: () => {
                calls++;
                return new Promise(() => {});
            }
        });
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
        assert.equal(ops.length, 0);
        assert.deepEqual(counts, { start: 1, end: 1 });
    },

    async 'path: cancel after the planner replied applies nothing'() {
        let events = null;
        const base = inlinePlanner(fakeSceneGrid, fakeRoute);
        const planner = async (input, opts) => {
            const reply = await base(input, opts);
            events.fire('progressCancel');
            return reply;
        };
        const run = setup([pose('camera_0', 0, 0), pose('camera_1', 30, 4), pose('camera_2', 60, 8)], { deps: { planner } });
        events = run.events;
        const counts = progressCounts(events);
        const original = summary(events);
        const result = await events.invoke('path.fix', FIX);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'cancelled');
        assert.deepEqual(summary(events), original);
        assert.equal(run.ops.length, 0);
        assert.deepEqual(counts, { start: 1, end: 1 });
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
