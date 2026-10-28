import { type ChunkSource } from '@playcanvas/splat-transform';

import { EditOp } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import { PermutedChunkSource } from '../io';
import { Splat } from '../splat';
import { State } from '../splat-state';
import { parseObjects, ObjectsData } from './objects-data';
import { i18n } from '../ui/localization';

// hides or shows the Gaussians of some objects (the locked bit, as SuperSplat's own hide); undo restores exactly
// the Gaussians this op changed
class ObjectsHideOp implements EditOp {
    name = 'objectsHide';
    splat: Splat;
    ranges: IndexRanges;
    hide: boolean;

    constructor(splat: Splat, isHit: (i: number) => boolean, hide: boolean) {
        const flags = splat.instances.flags;
        const locked = (i: number) => (flags[i] & State.locked) !== 0;
        this.splat = splat;
        this.hide = hide;
        this.ranges = IndexRanges.fromPredicate(splat.instances.count, i => isHit(i) && locked(i) !== hide);
    }

    private async apply(hide: boolean) {
        const { instances } = this.splat;
        if (hide) {
            instances.setBits(this.ranges, State.locked);
        } else {
            instances.clearBits(this.ranges, State.locked);
        }
        await this.splat.updateState();
    }

    do() {
        return this.apply(this.hide);
    }

    undo() {
        return this.apply(!this.hide);
    }

    destroy() {
        this.splat = null;
        this.ranges = null;
    }
}

// file row of every resource row: the loader may Morton-order the Gaussians and keep the file order as a
// permutation of its source (possibly nested)
const fileRowsOf = (splat: Splat) => {
    const rows = new Uint32Array(splat.numSplats);
    for (let i = 0; i < rows.length; ++i) rows[i] = i;
    let source: ChunkSource = splat.resource.source;
    while (source instanceof PermutedChunkSource) {
        const { order } = source;
        for (let i = 0; i < rows.length; ++i) rows[i] = order[rows[i]];
        source = source.parent;
    }
    return rows;
};

const registerObjectEvents = (events: Events) => {
    let data: ObjectsData | null = null;
    let splat: Splat | null = null;
    // object id per resource row
    let rowObject: Int32Array | null = null;

    const clear = () => {
        data = null;
        splat = null;
        rowObject = null;
        events.fire('objects.changed', null);
    };

    events.on('scene.elementRemoved', (element: { type: ElementType }) => {
        if (element === splat) clear();
    });

    events.function('objects.data', () => data);

    events.function('objects.load', async (file: File) => {
        const target = events.invoke('selection') as Splat;
        try {
            if (!target) throw new Error(i18n.t('objects.no-splat'));
            const parsed = parseObjects(await file.text());
            if (parsed.inst.length !== target.numSplats) {
                throw new Error(`${file.name}: ${parsed.inst.length} Gaussians, splat '${target.name}' has ${target.numSplats}`);
            }
            const fileRows = fileRowsOf(target);
            rowObject = new Int32Array(fileRows.length);
            for (let i = 0; i < fileRows.length; ++i) rowObject[i] = parsed.inst[fileRows[i]];
            data = parsed;
            splat = target;
            events.fire('objects.changed', data);
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('objects.load-failed'),
                message: `'${error.message ?? error}'`
            });
        }
    });

    // predicate over live instances: does the instance belong to one of the objects?
    const hitOf = (ids: number[]) => {
        const wanted = new Set(ids);
        const objectOf = rowObject;
        const { sourceRow } = splat.instances;
        return (i: number) => wanted.has(objectOf[sourceRow[i]]);
    };

    // sorted instance indices of the objects' Gaussians
    const indicesOf = (ids: number[]) => {
        const isHit = hitOf(ids);
        const out: number[] = [];
        for (let i = 0; i < splat.instances.count; ++i) {
            if (isHit(i)) out.push(i);
        }
        return new Uint32Array(out);
    };

    // resolves once the selection is applied (in a command slot, so a following focus sees the new bounds)
    const select = async (ids: number[], op: 'set' | 'add') => {
        if (!data) return;
        // selection ops act on the active splat
        if (events.invoke('selection') !== splat) events.fire('selection', splat);
        const indices = indicesOf(ids);
        await splat.scene.commandQueue.enqueue(ctx => events.invoke('select.applyMask', ctx, op, indices));
    };

    events.on('objects.select', (ids: number[], add = false) => select(ids, add ? 'add' : 'set'));

    events.on('objects.focus', async (ids: number[]) => {
        await select(ids, 'set');
        events.fire('camera.focus');
    });

    events.on('objects.setHidden', (ids: number[], hide: boolean) => {
        if (!data) return;
        events.fire('edit.add', new ObjectsHideOp(splat, hitOf(ids), hide));
    });
};

export { registerObjectEvents };
