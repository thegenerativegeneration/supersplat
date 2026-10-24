import { Vec3Like } from './occupancy';

type Box = { min: Vec3Like, max: Vec3Like };

const AXES = ['x', 'y', 'z'] as const;

const percentile = (sorted: Float32Array, q: number) => {
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

// Per-axis 3rd to 97th percentile, which drops floaters and far outliers.
const proposeBox = (points: Float32Array): Box => {
    const n = Math.floor(points.length / 3);
    const min = { x: 0, y: 0, z: 0 };
    const max = { x: 0, y: 0, z: 0 };
    if (n === 0) return { min, max };

    const column = new Float32Array(n);
    AXES.forEach((axis, a) => {
        for (let i = 0; i < n; i++) column[i] = points[i * 3 + a];
        column.sort();
        min[axis] = percentile(column, 0.03);
        max[axis] = percentile(column, 0.97);
    });
    return { min, max };
};

// Eigenvector of the smallest eigenvalue of a symmetric 3x3 matrix (cyclic Jacobi).
const smallestEigenvector = (m: number[][]): number[] => {
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 20; sweep++) {
        const off = Math.abs(m[0][1]) + Math.abs(m[0][2]) + Math.abs(m[1][2]);
        if (off < 1e-14) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(m[p][q]) < 1e-300) continue;
            const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const kp = m[k][p];
                const kq = m[k][q];
                m[k][p] = c * kp - s * kq;
                m[k][q] = s * kp + c * kq;
            }
            for (let k = 0; k < 3; k++) {
                const pk = m[p][k];
                const qk = m[q][k];
                m[p][k] = c * pk - s * qk;
                m[q][k] = s * pk + c * qk;
            }
            for (let k = 0; k < 3; k++) {
                const kp = v[k][p];
                const kq = v[k][q];
                v[k][p] = c * kp - s * kq;
                v[k][q] = s * kp + c * kq;
            }
        }
    }
    let best = 0;
    for (let i = 1; i < 3; i++) {
        if (m[i][i] < m[best][best]) best = i;
    }
    return [v[0][best], v[1][best], v[2][best]];
};

const inside = (x: number, y: number, z: number, box: Box) => {
    return x >= box.min.x && x <= box.max.x &&
           y >= box.min.y && y <= box.max.y &&
           z >= box.min.z && z <= box.max.z;
};

// Angle in degrees between +Y and the direction of least variance of the
// points inside the proposed box, folded to [0, 90].
const estimateTiltDeg = (points: Float32Array): number => {
    const box = proposeBox(points);
    const sel: number[] = [];
    for (let i = 0; i + 2 < points.length; i += 3) {
        if (inside(points[i], points[i + 1], points[i + 2], box)) sel.push(i);
    }
    if (sel.length < 3) return 0;

    const mean = [0, 0, 0];
    for (const i of sel) {
        for (let a = 0; a < 3; a++) mean[a] += points[i + a] / sel.length;
    }
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const i of sel) {
        const d = [points[i] - mean[0], points[i + 1] - mean[1], points[i + 2] - mean[2]];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) cov[r][c] += d[r] * d[c] / sel.length;
        }
    }
    const normal = smallestEigenvector(cov);
    const len = Math.hypot(normal[0], normal[1], normal[2]);
    return Math.acos(Math.min(1, Math.abs(normal[1]) / len)) * 180 / Math.PI;
};

const BINS = 32;
const PEAK_SEPARATION = 4;

// 1.6 for metric-looking scenes. Otherwise a fraction of the storey height,
// taken as the distance between the two strongest peaks of the height
// histogram, or of the vertical extent when there is only one peak.
const estimateEyeHeight = (points: Float32Array, box: Box): number => {
    const horizontal = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const vertical = box.max.y - box.min.y;
    if (horizontal >= 5 && horizontal <= 500 && vertical >= 2 && vertical <= 100) return 1.6;

    const fallback = 0.08 * vertical;
    if (!(vertical > 0)) return fallback;

    const hist = new Array<number>(BINS).fill(0);
    for (let i = 0; i + 2 < points.length; i += 3) {
        if (!inside(points[i], points[i + 1], points[i + 2], box)) continue;
        const b = Math.min(BINS - 1, Math.floor((points[i + 1] - box.min.y) / vertical * BINS));
        hist[b]++;
    }

    const order = hist.map((count, bin) => ({ count, bin })).sort((a, b) => b.count - a.count);
    const first = order[0];
    const second = order.find(o => o.count > 0 && Math.abs(o.bin - first.bin) >= PEAK_SEPARATION);
    if (!second) return fallback;
    return 0.55 * Math.abs(first.bin - second.bin) * vertical / BINS;
};

export { estimateEyeHeight, estimateTiltDeg, proposeBox };
export type { Box };
