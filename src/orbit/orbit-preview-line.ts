import { azimuthAt, clampSpan, positionAt } from './orbit-path';
import type { CurvePose } from '../anim/camera-curve';
import type { Vec3Like } from '../candidates/occupancy';
import { BLOCKED_COLOR, ORBIT_PREVIEW_COLOR, type Rgb } from '../path/colors';

// what the Orbit popover previews: the planned keys, and the circle at the
// radius they use (or the requested one, with the blocked ranges, when no
// radius is free)
type OrbitPreview = {
    keys: CurvePose[],
    // [from, to] azimuths in degrees within -180..180
    blockedRanges: [number, number][],
    centre: Vec3Like,
    radius: number,
    height: number,
    startDeg: number,
    spanDeg: number,
    dir: 1 | -1
};

// degrees of arc per drawn line
const DEG_PER_LINE = 2;
// key ticks and the centre cross, as a fraction of the radius
const MARK_SIZE = 0.06;

const wrap180 = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;

const inRanges = (deg: number, ranges: readonly [number, number][]) => {
    const a = wrap180(deg);
    return ranges.some(([from, to]) => a >= from && a <= to);
};

/**
 * Line-list vertices of the orbit preview: the arc sampled every DEG_PER_LINE
 * degrees, red where a line's middle lies in a blocked range, an upward tick at
 * each key and a cross at the centre. Positions are xyz, colours rgb in 0..1.
 */
const orbitPreviewLine = (preview: OrbitPreview) => {
    const positions: number[] = [];
    const colors: number[] = [];
    const line = (a: Vec3Like, b: Vec3Like, rgb: Rgb) => {
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        colors.push(...rgb, ...rgb);
    };
    if (!(preview.radius > 0)) return { positions, colors };

    const spec = { ...preview, spanDeg: clampSpan(preview.spanDeg) };
    const lines = Math.ceil(spec.spanDeg / DEG_PER_LINE);
    for (let i = 0; i < lines; i++) {
        const t0 = spec.spanDeg * i / lines;
        const t1 = spec.spanDeg * (i + 1) / lines;
        const blocked = inRanges(azimuthAt(spec, (t0 + t1) / 2), spec.blockedRanges);
        line(
            positionAt(spec, spec.radius, azimuthAt(spec, t0)),
            positionAt(spec, spec.radius, azimuthAt(spec, t1)),
            blocked ? BLOCKED_COLOR : ORBIT_PREVIEW_COLOR
        );
    }

    const size = spec.radius * MARK_SIZE;
    for (const { position: p } of spec.keys) {
        line(p, { x: p.x, y: p.y + size, z: p.z }, ORBIT_PREVIEW_COLOR);
    }
    const c = spec.centre;
    line({ x: c.x - size, y: c.y, z: c.z }, { x: c.x + size, y: c.y, z: c.z }, ORBIT_PREVIEW_COLOR);
    line({ x: c.x, y: c.y - size, z: c.z }, { x: c.x, y: c.y + size, z: c.z }, ORBIT_PREVIEW_COLOR);
    line({ x: c.x, y: c.y, z: c.z - size }, { x: c.x, y: c.y, z: c.z + size }, ORBIT_PREVIEW_COLOR);
    return { positions, colors };
};

export { orbitPreviewLine };
export type { OrbitPreview };
