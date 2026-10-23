import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { registerCameraPosesEvents } from './.build/src/camera-poses.js';
import { Events } from './.build/src/events.js';
import { registerTimingEvents } from './.build/src/timing-events.js';
import { registerTrackManagerEvents } from './.build/src/track-manager.js';

const setup = (frames, lingers = []) => {
    const events = new Events();
    events.function('timeline.frames', () => 181);
    events.function('timeline.frameRate', () => 30);
    events.function('timeline.smoothness', () => 1);
    events.function('timeline.loop', () => false);
    events.function('timeline.frame', () => 0);
    events.function('timeline.rotationWeight', () => 1);
    events.function('camera.fov', () => 60);
    events.function('camera.sampleDistances', async poses => poses.map((_, i) => (i === 1 ? null : 1)));

    const popups = [];
    events.function('showPopup', async (args) => {
        popups.push(args);
        return { action: 'ok' };
    });

    registerCameraPosesEvents(events);
    registerTrackManagerEvents(events);
    registerTimingEvents(events);

    const ops = [];
    events.on('edit.add', op => ops.push(op));

    events.fire('camera.loadPoses', frames.map((frame, i) => ({
        name: `camera_${i}`,
        frame,
        position: new Vec3(i, 0, 0),
        target: new Vec3(i, 0, -1),
        fov: 60,
        ...(lingers[i] ? { linger: lingers[i] } : {})
    })));
    return { events, ops, popups };
};

const sortedKeys = events => [...events.invoke('track.keys')].sort((a, b) => a - b);

const timingEventsChecks = {
    async 'timing: balance retimes keys as one undo step'() {
        const { events, ops, popups } = setup([0, 10, 20]);
        const result = await events.invoke('timing.balance');
        assert.equal(result.ok, true);
        assert.equal(ops.length, 1);
        assert.equal(popups.length, 0);
        assert.deepEqual(sortedKeys(events), [0, 90, 180]);
    },

    async 'timing: failure shows a popup and leaves keys'() {
        const { events, ops, popups } = setup([0, 10, 20], [0, 10, 0]);
        const result = await events.invoke('timing.balance');
        assert.equal(result.ok, false);
        assert.equal(popups.length, 1);
        assert.equal(popups[0].type, 'error');
        assert.equal(ops.length, 0);
        assert.deepEqual(sortedKeys(events), [0, 10, 20]);
    }
};

export { timingEventsChecks };
