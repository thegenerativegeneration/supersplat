import type { CurvePose } from '../anim/camera-curve';
import type { Vec3Like } from '../candidates/occupancy';

type OrbitSpec = {
    centre: Vec3Like,
    radius: number,
    height: number,
    startDeg: number,
    spanDeg: number,
    dir: 1 | -1,
    fov: number
};

type Occupied = (ix: number, iy: number, iz: number) => boolean;

const MIN_RADIUS = 1;
const DEG_PER_KEY = 22.5;
const MIN_SPAN = 90;
const MAX_SPAN = 360;

const RAD = Math.PI / 180;

// Azimuth is atan2(z, x) of the offset from the centre. Seen from +y with x to
// the right, z points down the screen, so a counter-clockwise (left, dir 1) turn
// decreases the azimuth.
const azimuthAt = (spec: Pick<OrbitSpec, 'startDeg' | 'dir'>, travelledDeg: number) => spec.startDeg - spec.dir * travelledDeg;

const positionAt = (spec: Pick<OrbitSpec, 'centre' | 'height'>, radius: number, azimuthDeg: number): Vec3Like => ({
    x: spec.centre.x + radius * Math.cos(azimuthDeg * RAD),
    y: spec.centre.y + spec.height,
    z: spec.centre.z + radius * Math.sin(azimuthDeg * RAD)
});

const clampSpan = (deg: number) => {
    if (!Number.isFinite(deg)) return MAX_SPAN;
    const rounded = Math.round(deg / DEG_PER_KEY) * DEG_PER_KEY;
    return Math.min(MAX_SPAN, Math.max(MIN_SPAN, rounded));
};

const orbitDefaults = (centre: Vec3Like, camera: Vec3Like, voxel: number) => {
    const dx = camera.x - centre.x;
    const dz = camera.z - centre.z;
    return {
        radius: Math.max(Math.hypot(dx, dz), MIN_RADIUS * voxel),
        height: camera.y - centre.y,
        startDeg: dx === 0 && dz === 0 ? 0 : Math.atan2(dz, dx) / RAD
    };
};

const orbitKeys = (spec: OrbitSpec): CurvePose[] => {
    const count = Math.round(clampSpan(spec.spanDeg) / DEG_PER_KEY);
    const keys: CurvePose[] = [];
    for (let k = 0; k <= count; k++) {
        // a full turn closes exactly on its first key
        const closing = k === count && count * DEG_PER_KEY === MAX_SPAN;
        keys.push({
            position: positionAt(spec, spec.radius, azimuthAt(spec, closing ? 0 : k * DEG_PER_KEY)),
            target: { x: spec.centre.x, y: spec.centre.y, z: spec.centre.z },
            fov: spec.fov
        });
    }
    return keys;
};

// Samples the circle at the camera height every voxel/4 of arc. Ranges are
// maximal blocked runs as [from, to] azimuths in degrees, from <= to, unwrapped
// along the travel (they can lie outside -180..180). On a full turn a run
// crossing the start azimuth is one range.
const arcBlocked = (occupied: Occupied, voxel: number, spec: OrbitSpec) => {
    const span = clampSpan(spec.spanDeg);
    const steps = Math.max(1, Math.ceil(span * RAD * spec.radius / (voxel / 4)));
    const runs: [number, number][] = [];
    let open: [number, number] | null = null;

    for (let i = 0; i <= steps; i++) {
        const travelled = span * i / steps;
        const p = positionAt(spec, spec.radius, azimuthAt(spec, travelled));
        if (occupied(Math.floor(p.x / voxel), Math.floor(p.y / voxel), Math.floor(p.z / voxel))) {
            if (open) {
                open[1] = travelled;
            } else {
                open = [travelled, travelled];
                runs.push(open);
            }
        } else {
            open = null;
        }
    }

    const last = runs[runs.length - 1];
    if (span === MAX_SPAN && runs.length > 1 && runs[0][0] === 0 && last[1] === span) {
        last[1] = span + runs[0][1];
        runs.shift();
    }

    const ranges = runs.map(([t0, t1]): [number, number] => {
        const a = azimuthAt(spec, t0);
        const b = azimuthAt(spec, t1);
        return [Math.min(a, b), Math.max(a, b)];
    });
    return { blocked: ranges.length > 0, ranges };
};

// The largest radius at most spec.radius, in voxel/2 steps and never below
// MIN_RADIUS, whose arc is free.
const fitRadius = (occupied: Occupied, voxel: number, spec: OrbitSpec) => {
    const min = MIN_RADIUS * voxel;
    const start = Math.max(spec.radius, min);
    const steps = Math.floor((start - min) / (voxel / 2) + 1e-9);
    const candidates = Array.from({ length: steps + 1 }, (_, k) => start - k * voxel / 2);
    if (candidates[steps] > min + 1e-9) candidates.push(min);
    for (const radius of candidates) {
        if (!arcBlocked(occupied, voxel, { ...spec, radius }).blocked) {
            return { radius, reduced: radius < spec.radius };
        }
    }
    return null;
};

export { orbitKeys, orbitDefaults, clampSpan, arcBlocked, fitRadius, azimuthAt, positionAt, MIN_RADIUS, DEG_PER_KEY };
export type { OrbitSpec };
