import assert from 'node:assert/strict';

import { Vec3 } from 'playcanvas';

import { setup } from './camera-track.mjs';

const orbitOf = events => events.invoke('camera.poses').map(p => `${p.frame}:${p.orbit ?? '-'}`);

const withOrbit = () => {
    const ctx = setup([[0], [60]]);
    ctx.events.function('camera.getPose', () => ({ position: new Vec3(1, 0, 0), target: new Vec3(1, 0, -1), fov: 60 }));
    ctx.events.fire('track.appendPoses', [
        { position: new Vec3(5, 0, 0), target: new Vec3(0, 0, 0), fov: 50, orbit: 'o1' },
        { position: new Vec3(6, 0, 0), target: new Vec3(0, 0, 0), fov: 50, orbit: 'o1' }
    ], [0, 60, 90, 120]);
    return ctx;
};

const orbitKeyChecks = {
    'orbit: appended poses keep the orbit id'() {
        const { events } = withOrbit();
        assert.deepEqual(orbitOf(events), ['0:-', '60:-', '90:o1', '120:o1']);
    },

    'orbit: snapshot/restore and save/load keep the id'() {
        const { events, ops } = withOrbit();
        events.fire('track.removeKey', 90);
        assert.deepEqual(orbitOf(events), ['0:-', '60:-', '120:o1']);
        ops[ops.length - 1].undo();
        assert.deepEqual(orbitOf(events), ['0:-', '60:-', '90:o1', '120:o1']);

        const sets = events.invoke('docSerialize.poseSets');
        assert.ok(!('orbit' in sets[0].poses[0]));
        const other = setup([]);
        other.events.invoke('docDeserialize.poseSets', sets);
        assert.deepEqual(orbitOf(other.events), ['0:-', '60:-', '90:o1', '120:o1']);
    },

    'orbit: moving, retiming and replacing keep the id'() {
        const { events } = withOrbit();
        events.fire('track.moveKey', 90, 100);
        assert.deepEqual(orbitOf(events), ['0:-', '60:-', '100:o1', '120:o1']);
        events.fire('track.retime', [0, 20, 40, 60]);
        assert.deepEqual(orbitOf(events), ['0:-', '20:-', '40:o1', '60:o1']);
        events.fire('track.replacePath', events.invoke('camera.poses'));
        assert.deepEqual(orbitOf(events), ['0:-', '20:-', '40:o1', '60:o1']);
    },

    'orbit: updating a key with the current view drops the id'() {
        const { events } = withOrbit();
        events.fire('track.addKey', 90);
        assert.deepEqual(orbitOf(events), ['0:-', '60:-', '90:-', '120:o1']);
    }
};

export { orbitKeyChecks };
