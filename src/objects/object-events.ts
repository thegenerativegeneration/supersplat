import { type ChunkSource } from '@playcanvas/splat-transform';

import { EditOp } from '../edit-ops';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import { PermutedChunkSource } from '../io';
import { Splat } from '../splat';
import { State } from '../splat-state';
import { parseObjects, ObjectsData, ObjectsState } from './objects-data';
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
    const rows = new Uint32Array(splat.resource.numRows);
    for (let i = 0; i < rows.length; ++i) rows[i] = i;
    let source: ChunkSource = splat.resource.source;
    while (source instanceof PermutedChunkSource) {
        const { order } = source;
        for (let i = 0; i < rows.length; ++i) rows[i] = order[rows[i]];
        source = source.parent;
    }
    return rows;
};

type Loaded = {
    // objects file name
    name: string;
    data: ObjectsData;
    // position in data.objects per resource row (-1 = none), and per object id
    rowSlot: Int32Array;
    slotOf: Map<number, number>;
};

// all objects files loaded for one splat and the one shown, so files can be compared without reloading
type Sets = { sets: Loaded[], current: number };

const registerObjectEvents = (events: Events) => {
    // per splat, so switching layers (and undoing a layer delete) keeps each splat's objects
    const loaded = new WeakMap<Splat, Sets>();
    const shown = (splat: Splat) => {
        const entry = loaded.get(splat);
        return entry.sets[entry.current];
    };

    const active = () => {
        const splat = events.invoke('selection') as Splat;
        return splat && loaded.has(splat) ? splat : null;
    };

    // per object: live, hidden and selected Gaussian counts of the active splat, from the flags themselves, so the
    // panel follows every edit (undo, brush, unhide all, ...)
    const stateOf = (splat: Splat): ObjectsState => {
        const { rowSlot, data } = shown(splat);
        const n = data.objects.length;
        const state = { total: new Uint32Array(n), hidden: new Uint32Array(n), selected: new Uint32Array(n) };
        const { sourceRow, flags, count } = splat.instances;
        for (let i = 0; i < count; ++i) {
            const k = rowSlot[sourceRow[i]];
            if (k < 0) continue;
            state.total[k]++;
            if (flags[i] & State.locked) state.hidden[k]++;
            else if (flags[i] & State.selected) state.selected[k]++;
        }
        return state;
    };

    let pending = 0;
    const publishState = () => {
        if (pending) return;
        // stateChanged fires per brush stroke; one count per frame is enough
        pending = requestAnimationFrame(() => {
            pending = 0;
            const splat = active();
            events.fire('objects.state', splat ? stateOf(splat) : null);
        });
    };

    const publish = () => {
        const splat = active();
        const entry = splat ? loaded.get(splat) : null;
        events.fire('objects.sets', entry ? { names: entry.sets.map(l => l.name), current: entry.current } : null);
        events.fire('objects.changed', splat ? shown(splat).data : null);
        publishState();
    };

    events.on('selection.changed', publish);
    events.on('splat.stateChanged', (splat: Splat) => splat === active() && publishState());

    events.function('objects.load', async (file: File) => {
        const splat = events.invoke('selection') as Splat;
        try {
            if (!splat) throw new Error(i18n.t('objects.no-splat'));
            const data = parseObjects(await file.text());
            const { numRows } = splat.resource;
            if (data.inst.length !== numRows) {
                throw new Error(`${file.name}: ${data.inst.length} Gaussians, splat '${splat.name}' has ${numRows}`);
            }
            const slotOf = new Map(data.objects.map((o, k) => [o.id, k]));
            const fileRows = fileRowsOf(splat);
            const rowSlot = new Int32Array(numRows);
            for (let i = 0; i < numRows; ++i) rowSlot[i] = slotOf.get(data.inst[fileRows[i]]) ?? -1;
            const entry = loaded.get(splat) ?? { sets: [], current: 0 };
            const same = entry.sets.findIndex(l => l.name === file.name);
            const at = same >= 0 ? same : entry.sets.length;
            entry.sets[at] = { name: file.name, data, rowSlot, slotOf };
            entry.current = at;
            loaded.set(splat, entry);
            publish();
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('objects.load-failed'),
                message: `'${error.message ?? error}'`
            });
        }
    });

    // predicate over live instances: does the instance belong to one of the objects?
    const hitOf = (splat: Splat, ids: number[]) => {
        const { rowSlot, slotOf, data } = shown(splat);
        const wanted = new Uint8Array(data.objects.length + 1);
        ids.forEach((id) => {
            if (slotOf.has(id)) wanted[slotOf.get(id)] = 1;
        });
        const { sourceRow } = splat.instances;
        // slot -1 reads wanted[-1], i.e. undefined: no hit
        return (i: number) => wanted[rowSlot[sourceRow[i]]] === 1;
    };

    // resolves once the selection is applied (in a command slot, so a following focus sees the new bounds)
    const select = async (ids: number[], op: 'set' | 'add' | 'remove') => {
        const splat = active();
        // selection ops only act on visible splats
        if (!splat || !splat.visible) return false;
        const isHit = hitOf(splat, ids);
        const out: number[] = [];
        for (let i = 0; i < splat.instances.count; ++i) {
            if (isHit(i)) out.push(i);
        }
        const indices = new Uint32Array(out);
        try {
            await splat.scene.commandQueue.enqueue(ctx => events.invoke('select.applyMask', ctx, op, indices));
        } catch (error) {
            console.error(error);
            return false;
        }
        return splat.numSelected > 0;
    };

    events.on('objects.use', (index: number) => {
        const splat = active();
        const entry = splat ? loaded.get(splat) : null;
        if (!entry || index < 0 || index >= entry.sets.length || index === entry.current) return;
        entry.current = index;
        publish();
    });

    events.on('objects.select', (ids: number[], op: 'set' | 'add' | 'remove' = 'set') => select(ids, op));

    events.on('objects.focus', async (ids: number[]) => {
        if (await select(ids, 'set')) events.fire('camera.focus');
    });

    events.on('objects.setHidden', (ids: number[], hide: boolean) => {
        const splat = active();
        if (!splat) return;
        const op = new ObjectsHideOp(splat, hitOf(splat, ids), hide);
        if (!op.ranges.empty) events.fire('edit.add', op);
    });
};

export { registerObjectEvents };
