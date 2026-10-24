import { Events } from '../events';
import { AUTO_KEY_COLOR, BLOCKED_COLOR, cssChannels } from '../path/colors';
import { blockedBands, keyStyles, type KeyInfo, type MarkerSet } from '../path/markers';

const NO_MARKERS: MarkerSet = { blocked: [], unreachable: [], insideGeometry: [] };

// Fix path marks on the timeline: detour keys in their own colour, blocked
// segments as red bands, unreachable and parked keys ringed in red. Keeps the
// markers of the last run; the timeline redraws on path.markers.
class TimelinePathMarkers {
    private markers = NO_MARKERS;

    constructor(private events: Events) {
        events.on('path.markers', (markers: MarkerSet) => {
            this.markers = markers ?? NO_MARKERS;
        });
    }

    // decorate the key markers already in the area and add the blocked bands
    draw(area: HTMLElement, offsetFromFrame: (frame: number) => number, lastFrame: number, loop: boolean) {
        area.style.setProperty('--auto-key-rgb', cssChannels(AUTO_KEY_COLOR));
        area.style.setProperty('--blocked-rgb', cssChannels(BLOCKED_COLOR));

        const poses = this.events.invoke('camera.poses') as KeyInfo[] ?? [];
        const styles = keyStyles(poses, this.markers, this.events.invoke('timeline.frames'));
        const keyEls = Array.from(area.querySelectorAll<HTMLElement>('.time-label.key[data-frame]'));

        keyEls.forEach((el) => {
            const style = styles.get(Number(el.dataset.frame));
            if (!style) return;
            el.classList.toggle('auto', style.auto);
            if (style.unreachable) {
                const ring = document.createElement('div');
                ring.classList.add('key-ring');
                ring.style.left = el.style.left;
                // before the key so the key paints on top of it
                area.insertBefore(ring, el);
            }
        });

        // bands go under the keys
        const first = area.querySelector('.key-ring, .time-label.key[data-frame]');
        blockedBands(poses, this.markers.blocked, loop, lastFrame).forEach(([from, to]) => {
            const band = document.createElement('div');
            band.classList.add('blocked-band');
            band.style.left = `${offsetFromFrame(from)}px`;
            band.style.width = `${Math.max(0, offsetFromFrame(to) - offsetFromFrame(from))}px`;
            area.insertBefore(band, first);
        });
    }
}

export { TimelinePathMarkers };
