import { Container, Element } from '@playcanvas/pcui';

import type { Pose } from '../camera-poses';
import { Events } from '../events';
import { addMarkerGestures, type MarkerTrack } from './key-marker-gestures';
import { i18n } from './localization';
import { TimelinePathMarkers } from './path-markers';
import { Tooltips } from './tooltips';

class Ticks extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'ticks'
        };

        super(args);

        const workArea = new Container({
            id: 'ticks-area'
        });

        this.append(workArea);

        let frameFromOffset: (offset: number) => number;
        let moveCursor: (frame: number) => void;

        // pcui wrappers around key markers, kept so their tooltips unregister
        // (via the destroy event) when the timeline is rebuilt
        let keyElements: Element[] = [];

        // Fix path marks, drawn by rebuild
        const pathMarkers = new TimelinePathMarkers(events);

        // rebuild the timeline
        const rebuild = () => {
            // clear existing labels
            keyElements.forEach(el => el.destroy());
            keyElements = [];
            workArea.dom.innerHTML = '';

            const numFrames = events.invoke('timeline.frames');
            const currentFrame = events.invoke('timeline.frame');

            const padding = 20;
            const width = this.dom.getBoundingClientRect().width - padding * 2;

            // round the smallest step that keeps labels ~50px apart up to the
            // 1/2/5 * 10^n series so labels land on round frame numbers
            const minStep = Math.max(1, numFrames / Math.max(1, Math.floor(width / 50)));
            const magnitude = 10 ** Math.floor(Math.log10(minStep));
            const labelStep = [1, 2, 5, 10].map(m => m * magnitude).find(s => s >= minStep) ?? 10 * magnitude;

            // subdivide labels with minor ticks (fifths, or halves for 1/2 steps)
            const tickStep = labelStep === 1 ? 0 : labelStep / (labelStep % 5 === 0 ? 5 : 2);

            const offsetFromFrame = (frame: number) => {
                return padding + Math.floor(frame / (numFrames - 1) * width);
            };

            frameFromOffset = (offset: number) => {
                return Math.max(0, Math.min(numFrames - 1, Math.floor((offset - padding) / width * (numFrames - 1))));
            };

            // timeline labels

            for (let frame = 0; frame < numFrames; frame += labelStep) {
                const label = document.createElement('div');
                label.classList.add('time-label');
                label.style.left = `${offsetFromFrame(frame)}px`;
                label.textContent = frame.toString();
                workArea.dom.appendChild(label);
            }

            // minor ticks

            if (tickStep > 0) {
                for (let frame = tickStep; frame < numFrames; frame += tickStep) {
                    if (frame % labelStep !== 0) {
                        const tick = document.createElement('div');
                        tick.classList.add('time-tick');
                        tick.style.left = `${offsetFromFrame(frame)}px`;
                        workArea.dom.appendChild(tick);
                    }
                }
            }

            // keys - get from active track
            const keys = events.invoke('track.keys') as number[] ?? [];

            // keys at frame >= numFrames don't play (the spline ignores them);
            // pin them just past the right end of the strip instead of hiding them
            const inRangeKeys = keys.filter(k => k < numFrames);
            const outOfRangeKeys = keys.filter(k => k >= numFrames).sort((a, b) => a - b);

            // center of a pinned marker: 10px right of the last frame, staggered
            // 2px per extra marker, capped so the 8px diamond stays inside the
            // 20px right padding
            const pinnedOffset = (index: number) => {
                return padding + width + 10 + Math.min(index, 3) * 2;
            };

            // keys that linger get a band between their neighbours. Without
            // looping, the first/last key hold from the start / to the end;
            // with looping they wrap around, drawn as two pieces.
            const looping = !!events.invoke('timeline.loop');
            const lingers = events.invoke('camera.keyLingers') as { frame: number, linger: number }[] ?? [];
            const sortedKeys = [...inRangeKeys].sort((a, b) => a - b);
            const lastFrame = numFrames - 1;
            const addBand = (from: number, to: number) => {
                const band = document.createElement('div');
                band.classList.add('linger-band');
                band.style.left = `${offsetFromFrame(from)}px`;
                band.style.width = `${Math.max(0, offsetFromFrame(to) - offsetFromFrame(from))}px`;
                workArea.dom.appendChild(band);
            };
            lingers.forEach(({ frame: lingerFrame }) => {
                const index = sortedKeys.indexOf(lingerFrame);
                if (index === -1) return;
                const isFirst = index === 0;
                const isLast = index === sortedKeys.length - 1;
                if (looping && sortedKeys.length > 1 && (isFirst || isLast)) {
                    if (isFirst) {
                        addBand(0, sortedKeys[1]);
                        addBand(sortedKeys[sortedKeys.length - 1], lastFrame);
                    } else {
                        addBand(sortedKeys[index - 1], lastFrame);
                        addBand(0, sortedKeys[0]);
                    }
                } else {
                    addBand(isFirst ? 0 : sortedKeys[index - 1], isLast ? lastFrame : sortedKeys[index + 1]);
                }
            });

            const idOf = new Map((events.invoke('camera.poses') as Pose[] ?? []).map(p => [p.frame, p.id]));
            const selected = new Set(events.invoke('keys.selected') as string[] ?? []);
            const markerTrack: MarkerTrack = {
                area: workArea.dom,
                frameAt: clientX => frameFromOffset(clientX - workArea.dom.getBoundingClientRect().left),
                leftOf: offsetFromFrame,
                lastFrame
            };

            const createKey = (keyFrame: number, pinnedIndex = -1) => {
                const outOfRange = pinnedIndex !== -1;

                const label = document.createElement('div');
                label.classList.add('time-label', 'key');
                if (outOfRange) {
                    label.classList.add('out-of-range');
                }
                label.style.left = `${outOfRange ? pinnedOffset(pinnedIndex) : offsetFromFrame(keyFrame)}px`;
                label.dataset.frame = keyFrame.toString();

                const id = idOf.get(keyFrame);
                if (id) {
                    label.dataset.id = id;
                    label.classList.toggle('selected', selected.has(id));
                    addMarkerGestures(events, label, id, markerTrack);
                }

                const wrapper = new Element({ dom: label });
                tooltips.register(wrapper, () => (outOfRange ?
                    i18n.t('tooltip.timeline.key-out-of-range', { frame: keyFrame }) :
                    i18n.t('tooltip.timeline.key')), 'top');
                keyElements.push(wrapper);

                workArea.dom.appendChild(label);
            };

            inRangeKeys.forEach((keyFrame: number) => {
                createKey(keyFrame);
            });

            // ascending order so the marker for the largest frame renders topmost
            outOfRangeKeys.forEach((keyFrame: number, index: number) => {
                createKey(keyFrame, index);
            });

            pathMarkers.draw(workArea.dom, offsetFromFrame, lastFrame, looping);

            // cursor

            const cursor = document.createElement('div');
            cursor.classList.add('time-label', 'cursor');
            cursor.style.left = `${offsetFromFrame(currentFrame)}px`;
            cursor.textContent = currentFrame.toString();
            workArea.dom.appendChild(cursor);

            moveCursor = (frame: number) => {
                cursor.style.left = `${offsetFromFrame(frame)}px`;
                cursor.textContent = frame.toString();
            };
        };

        // handle scrubbing

        let scrubbing = false;

        workArea.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!scrubbing && event.isPrimary && event.button === 0) {
                scrubbing = true;
                workArea.dom.setPointerCapture(event.pointerId);
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointermove', (event: PointerEvent) => {
            if (scrubbing) {
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointerup', (event: PointerEvent) => {
            if (scrubbing && event.isPrimary) {
                workArea.dom.releasePointerCapture(event.pointerId);
                scrubbing = false;
            }
        });

        this.on('destroy', () => {
            keyElements.forEach(el => el.destroy());
            keyElements = [];
        });

        events.on('keys.selectionChanged', (ids: string[]) => {
            const selected = new Set(ids);
            workArea.dom.querySelectorAll<HTMLElement>('.time-label.key[data-id]').forEach((el) => {
                el.classList.toggle('selected', selected.has(el.dataset.id));
            });
        });

        // rebuild the timeline on dom resize
        new ResizeObserver(() => rebuild()).observe(workArea.dom);

        // rebuild when timeline frames change
        events.on('timeline.frames', () => {
            rebuild();
        });

        events.on('timeline.frame', (frame: number) => {
            moveCursor(frame);
        });

        // rebuild when track keys change
        events.on('track.keyAdded', () => {
            rebuild();
        });

        events.on('track.keyRemoved', () => {
            rebuild();
        });

        events.on('track.keyMoved', () => {
            rebuild();
        });

        events.on('track.keyUpdated', () => {
            rebuild();
        });

        events.on('track.keysLoaded', () => {
            rebuild();
        });

        events.on('track.keysCleared', () => {
            rebuild();
        });

        events.on('path.markers', () => {
            rebuild();
        });
    }
}

export { Ticks };
