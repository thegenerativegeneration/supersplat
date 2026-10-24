import type { Occupancy, Vec3Like } from './occupancy';

const DEG = Math.PI / 180;

// Free distance along `rays` horizontal rays from p, ray k at azimuth
// k * 360 / rays (azimuth 0 looks along -Z, direction (sin az, 0, -cos az), as
// in sample.ts). Marched in steps of half a voxel; the distance of the first
// step that lands in an occupied voxel, capped at maxDist.
const isovist = (occ: Occupancy, p: Vec3Like, maxDist: number, rays = 72): Float32Array => {
    const out = new Float32Array(rays);
    const step = occ.voxel / 2;
    const steps = Math.ceil(maxDist / step);
    for (let k = 0; k < rays; k++) {
        const az = (k * 2 * Math.PI) / rays;
        const dx = Math.sin(az);
        const dz = -Math.cos(az);
        let dist = maxDist;
        for (let i = 1; i <= steps; i++) {
            const t = i * step;
            if (t >= maxDist) break;
            if (occ.occupied(
                Math.floor((p.x + dx * t) / occ.voxel),
                Math.floor(p.y / occ.voxel),
                Math.floor((p.z + dz * t) / occ.voxel)
            )) {
                dist = t;
                break;
            }
        }
        out[k] = dist;
    }
    return out;
};

// Openness in [0, 1]: half the square root of the visible area relative to a
// full disc of radius maxDist, half the mean free distance within the view's
// horizontal field of view relative to maxDist.
const opennessOf = (rays: Float32Array, maxDist: number, azimuth: number, hfovDeg: number): number => {
    const n = rays.length;
    const stepDeg = 360 / n;
    let area = 0;
    for (const r of rays) area += 0.5 * r * r * stepDeg * DEG;

    let sum = 0;
    let count = 0;
    let nearest = 0;
    let nearestDiff = Infinity;
    for (let k = 0; k < n; k++) {
        const raw = Math.abs(k * stepDeg - azimuth) % 360;
        const diff = Math.min(raw, 360 - raw);
        if (diff <= hfovDeg / 2) {
            sum += rays[k];
            count++;
        }
        if (diff < nearestDiff) {
            nearestDiff = diff;
            nearest = k;
        }
    }
    const inView = count > 0 ? sum / count : rays[nearest];
    return 0.5 * Math.sqrt(area / (Math.PI * maxDist * maxDist)) + 0.5 * inView / maxDist;
};

export { isovist, opennessOf };
