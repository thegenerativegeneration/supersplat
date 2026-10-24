import { Occupancy, packKey, unpackKey } from './occupancy';

type Level = {
    cells: [number, number, number][],
    area: number,
    height: number
};

// A surface voxel is occupied with headVoxels free voxels above it.
const isSurface = (occ: Occupancy, ix: number, iy: number, iz: number, headVoxels: number) => {
    for (let h = 1; h <= headVoxels; h++) {
        if (occ.occupied(ix, iy + h, iz)) return false;
    }
    return true;
};

const median = (values: number[]) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
};

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Groups surface voxels into connected levels (floors, galleries, roofs).
// Neighbouring columns connect when their surfaces differ by at most one
// voxel in height, so steps do not split a level.
const findLevels = (occ: Occupancy, headVoxels: number, minArea: number): Level[] => {
    const surface = new Set<number>();
    for (const [ix, iy, iz] of occ.cells()) {
        if (isSurface(occ, ix, iy, iz, headVoxels)) surface.add(packKey(ix, iy, iz));
    }

    const levels: Level[] = [];
    const visited = new Set<number>();
    for (const start of surface) {
        if (visited.has(start)) continue;
        visited.add(start);
        const stack = [start];
        const cells: [number, number, number][] = [];
        while (stack.length) {
            const cell = unpackKey(stack.pop());
            cells.push(cell);
            const [ix, iy, iz] = cell;
            for (const [dx, dz] of NEIGHBOURS) {
                for (let dy = -1; dy <= 1; dy++) {
                    const key = packKey(ix + dx, iy + dy, iz + dz);
                    if (surface.has(key) && !visited.has(key)) {
                        visited.add(key);
                        stack.push(key);
                    }
                }
            }
        }

        const area = cells.length * occ.voxel * occ.voxel;
        if (area >= minArea) {
            levels.push({ cells, area, height: (median(cells.map(c => c[1])) + 0.5) * occ.voxel });
        }
    }

    return levels.sort((a, b) => b.area - a.area);
};

export { findLevels };
export type { Level };
