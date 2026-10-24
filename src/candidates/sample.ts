import type { Box } from './estimate';
import type { Level } from './levels';
import type { Occupancy, Vec3Like } from './occupancy';

type Candidate = {
    id: string,
    level: number,
    position: Vec3Like,
    direction: Vec3Like,
    azimuth: number,
    pitch: number,
    fov: number
};

type SampleOptions = {
    eyeHeight: number,
    box: Box,
    fov: number,
    budget: number,
    seed: number
};

const AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315];
const PITCHES = [0, 10, -15];

const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// Splits budget across levels in proportion to weight (largest remainder),
// never giving a level more than its capacity. Leftovers go to levels with room.
const allocate = (weights: number[], capacity: number[], budget: number): number[] => {
    const counts = weights.map(() => 0);
    let remaining = Math.min(budget, capacity.reduce((a, b) => a + b, 0));
    while (remaining > 0) {
        const open = weights.map((w, i) => (counts[i] < capacity[i] ? i : -1)).filter(i => i >= 0);
        const total = open.reduce((a, i) => a + weights[i], 0);
        const left = remaining;
        const shares = open.map(i => ({
            i,
            exact: total > 0 ? left * weights[i] / total : left / open.length
        }));
        let given = 0;
        for (const s of shares) {
            const n = Math.min(Math.floor(s.exact), capacity[s.i] - counts[s.i]);
            counts[s.i] += n;
            given += n;
        }
        shares.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
        for (const s of shares) {
            if (given >= remaining) break;
            if (counts[s.i] < capacity[s.i]) {
                counts[s.i]++;
                given++;
            }
        }
        remaining -= given;
    }
    return counts;
};

const shuffle = <T>(items: T[], rand: () => number) => {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
};

const directionOf = (azimuth: number, pitch: number): Vec3Like => {
    const az = azimuth * Math.PI / 180;
    const p = pitch * Math.PI / 180;
    return { x: Math.sin(az) * Math.cos(p), y: Math.sin(p), z: -Math.cos(az) * Math.cos(p) };
};

// Places cameras at eye height above each level's surface cells, keeps free
// positions inside the box, and picks a view direction for each. The budget is
// shared by level area. Azimuth and pitch are in degrees; azimuth 0 looks along -Z.
const sampleCandidates = (levels: Level[], occ: Occupancy, opts: SampleOptions): Candidate[] => {
    const { eyeHeight, box, fov, budget, seed } = opts;
    const rand = mulberry32(seed);
    const v = occ.voxel;

    const positions = levels.map((level) => {
        const valid: Vec3Like[] = [];
        for (const [ix, iy, iz] of level.cells) {
            const p = { x: (ix + 0.5) * v, y: (iy + 1) * v + eyeHeight, z: (iz + 0.5) * v };
            const within = p.x >= box.min.x && p.x <= box.max.x &&
                           p.y >= box.min.y && p.y <= box.max.y &&
                           p.z >= box.min.z && p.z <= box.max.z;
            if (within && occ.isFree(p)) valid.push(p);
        }
        return shuffle(valid, rand);
    });

    const counts = allocate(levels.map(l => l.area), positions.map(p => p.length), budget);

    const out: Candidate[] = [];
    positions.forEach((list, level) => {
        for (let k = 0; k < counts[level]; k++) {
            const azimuth = AZIMUTHS[Math.floor(rand() * AZIMUTHS.length)];
            const pitch = PITCHES[Math.floor(rand() * PITCHES.length)];
            out.push({
                id: `c${String(out.length).padStart(3, '0')}`,
                level,
                position: list[k],
                direction: directionOf(azimuth, pitch),
                azimuth,
                pitch,
                fov
            });
        }
    });
    return out;
};

export { sampleCandidates };
export type { Candidate, SampleOptions };
