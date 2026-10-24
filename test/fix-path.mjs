import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { buildCameraCurve } from './.build/src/anim/camera-curve.js';
import { setup } from './camera-track.mjs';

const pathPose = (name, frame, x, auto) => ({
    name,
    frame,
    position: new Vec3(x, 1, 0),
    target: new Vec3(x, 1, -1),
    fov: 60,
    ...(auto ? { auto: true } : {})
});

const autoFlags = events => events.invoke('camera.poses').map(p => !!p.auto);

const fixPathChecks = {
    async 'track: camera curve matches the track spline'() {
        const { events } = setup([[0], [60], [150]]);
        let current = null;
        events.on('camera.setPose', (pose) => {
            current = { position: pose.position.clone(), target: pose.target.clone(), fov: pose.fov };
        });
        events.function('camera.getPose', () => current);
        const poses = events.invoke('camera.poses');
        const curve = buildCameraCurve(poses, poses.map(p => p.frame), { duration: 181, smoothness: 1, loop: false });
        assert.ok(curve);

        for (const f of [0, 37, 120]) {
            events.fire('timeline.frame', f);
            const out = curve(f, { position: new Vec3(), target: new Vec3(), fov: 0 });
            for (const k of ['position', 'target']) {
                for (const c of ['x', 'y', 'z']) {
                    assert.ok(Math.abs(out[k][c] - current[k][c]) < 1e-6, `${k}.${c} at ${f}`);
                }
            }
            assert.ok(Math.abs(out.fov - current.fov) < 1e-6);
        }
        assert.equal(buildCameraCurve([poses[0]], [0], { duration: 181, smoothness: 1, loop: false }), null);
    },

    async 'track: auto flag survives undo and serialization'() {
        const { events, ops } = setup([[0], [60]]);
        events.fire('track.replacePath', [pathPose('a', 0, 0), pathPose('b', 30, 5, true), pathPose('c', 60, 10)]);
        assert.deepEqual(autoFlags(events), [false, true, false]);

        await ops[0].undo();
        assert.deepEqual(autoFlags(events), [false, false]);
        await ops[0].do();
        assert.deepEqual(autoFlags(events), [false, true, false]);

        const sets = events.invoke('docSerialize.poseSets');
        assert.deepEqual(sets[0].poses.map(p => 'auto' in p), [false, true, false]);
        const other = setup([]);
        other.events.invoke('docDeserialize.poseSets', sets);
        assert.deepEqual(autoFlags(other.events), [false, true, false]);
    },

    async 'track: moving an auto key makes it normal'() {
        const { events } = setup([[0], [60]]);
        events.fire('track.replacePath', [pathPose('a', 0, 0), pathPose('b', 30, 5, true), pathPose('c', 60, 10)]);
        events.fire('track.moveKey', 30, 40);
        assert.deepEqual(autoFlags(events), [false, false, false]);
    },

    async 'track: replacePath is one undo step'() {
        const { events, ops } = setup([[0], [30, 1.5], [60]]);
        const names = () => events.invoke('camera.poses').map(p => p.name);
        events.fire('track.replacePath', [pathPose('x', 90, 0), pathPose('y', 10, 5), pathPose('z', 50, 9)]);
        assert.equal(ops.length, 1);
        assert.deepEqual([...events.invoke('track.keys')], [10, 50, 90]);
        assert.deepEqual(names(), ['y', 'z', 'x']);

        await ops[0].undo();
        assert.deepEqual([...events.invoke('track.keys')], [0, 30, 60]);
        assert.deepEqual(names(), ['camera_0', 'camera_1', 'camera_2']);
        assert.deepEqual(events.invoke('camera.keyLingers'), [{ frame: 30, linger: 1.5 }]);
    }
};

export { fixPathChecks };
