import { Container } from '@playcanvas/pcui';
import { Mat4, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { OverlayWriter, ToolOverlay } from '../tool-overlay';

// one click per object the user names (e.g. one per pew); position in the splat file's own coordinates
type Seed = { id: number, position: [number, number, number], note: string };

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

const mat = new Mat4();
const p = new Vec3();

const storageKey = (splat: Splat) => `objects.seeds:${splat.filename ?? splat.name}`;

const loadSeeds = (splat: Splat): Seed[] => {
    try {
        return JSON.parse(localStorage.getItem(storageKey(splat)) ?? '[]');
    } catch {
        return [];
    }
};

// Tool for placing seed points on the selected splat. Seeds are kept per splat file in local storage and saved
// as JSON for evaluation outside the editor. Events: seeds.remove, seeds.note, seeds.clear, seeds.save; fires
// seeds.changed (seeds) and seeds.marking (on); function seeds.list.
class SeedMarker {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let splat: Splat | null = null;
        let seeds: Seed[] = [];
        let active = false;

        const store = () => {
            if (!splat) return;
            try {
                localStorage.setItem(storageKey(splat), JSON.stringify(seeds));
            } catch {
                // storage full or blocked: seeds stay in memory until saved
            }
        };

        const changed = () => {
            store();
            events.fire('seeds.changed', seeds);
            scene.forceRender = true;
        };

        const overlay = new ToolOverlay();
        overlay.provider = (writer: OverlayWriter) => {
            if (!splat) return;
            seeds.forEach((s) => {
                p.set(s.position[0], s.position[1], s.position[2]);
                splat.worldTransform.transformPoint(p, p);
                writer.dot(p);
            });
        };
        scene.add(overlay);

        events.on('selection.changed', (selection: Splat) => {
            splat = selection ?? null;
            seeds = splat ? loadSeeds(splat) : [];
            events.fire('seeds.changed', seeds);
        });

        let clicked = false;
        let clickX = 0;
        let clickY = 0;
        const isPrimary = (e: PointerEvent) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);

        const pointerdown = (e: PointerEvent) => {
            if (isPrimary(e)) {
                clicked = true;
                clickX = e.offsetX;
                clickY = e.offsetY;
            }
        };
        const pointermove = (e: PointerEvent) => {
            if (clicked && Math.hypot(e.offsetX - clickX, e.offsetY - clickY) > CLICK_TOLERANCE) {
                clicked = false;
            }
        };
        const pointerup = async (e: PointerEvent) => {
            if (!splat || !clicked || !isPrimary(e)) return;
            clicked = false;
            const target = splat;
            const { clientWidth, clientHeight } = canvasContainer.dom;
            const hit = await scene.camera.intersect(clickX / clientWidth, clickY / clientHeight);
            if (!hit || !active || splat !== target) return;
            mat.invert(target.worldTransform);
            mat.transformPoint(hit.position, p);
            const id = seeds.reduce((m, s) => Math.max(m, s.id), 0) + 1;
            seeds.push({ id, position: [p.x, p.y, p.z], note: '' });
            changed();
            e.preventDefault();
            e.stopPropagation();
        };

        this.activate = () => {
            active = true;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            events.fire('seeds.marking', true);
        };

        this.deactivate = () => {
            active = false;
            clicked = false;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            events.fire('seeds.marking', false);
        };

        events.function('seeds.list', () => seeds);
        events.on('seeds.remove', (id: number) => {
            seeds = seeds.filter(s => s.id !== id);
            changed();
        });
        events.on('seeds.note', (id: number, note: string) => {
            const seed = seeds.find(s => s.id === id);
            if (seed) {
                seed.note = note;
                store();
            }
        });
        events.on('seeds.clear', () => {
            seeds = [];
            changed();
        });
        events.on('seeds.save', () => {
            if (!splat) return;
            const base = (splat.filename ?? splat.name).split(/[\\/]/).pop();
            const name = `${base.replace(/\.[^.]+$/, '')}.seeds.json`;
            const blob = new Blob([JSON.stringify({ file: splat.filename ?? splat.name, seeds }, null, 1)],
                { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = name;
            link.click();
            URL.revokeObjectURL(link.href);
        });
    }
}

export { SeedMarker, Seed };
