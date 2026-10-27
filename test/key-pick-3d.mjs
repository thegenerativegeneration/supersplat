import assert from 'node:assert/strict';

import { nearestKey } from './.build/src/key-pick-3d.js';

const keyPick3dChecks = {
    'pick3d: nearest within 10 px wins; none beyond'() {
        const keys = [
            { id: 'far', screen: { x: 100, y: 100 } },
            { id: 'near', screen: { x: 54, y: 50 } },
            { id: 'nearer', screen: { x: 52, y: 51 } }
        ];
        assert.equal(nearestKey({ x: 50, y: 50 }, keys), 'nearer');
        assert.equal(nearestKey({ x: 60, y: 50 }, keys), 'near');
        assert.equal(nearestKey({ x: 70, y: 50 }, keys), null);
        assert.equal(nearestKey({ x: 70, y: 50 }, keys, 20), 'near');
        assert.equal(nearestKey({ x: 0, y: 0 }, []), null);
    },

    'pick3d: keys behind the camera (screen null) are skipped'() {
        const keys = [
            { id: 'behind', screen: null },
            { id: 'ahead', screen: { x: 58, y: 50 } }
        ];
        assert.equal(nearestKey({ x: 50, y: 50 }, keys), 'ahead');
        assert.equal(nearestKey({ x: 50, y: 50 }, [keys[0]]), null);
    }
};

export { keyPick3dChecks };
