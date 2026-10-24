import type { Box } from './estimate';
import type { LevelInfo } from './generate';
import type { Vec3Like } from './occupancy';

const PAGE_SIZE = 40;
const TILT_WARN_DEG = 10;

type ViewPose = { position: Vec3Like, target: Vec3Like, fov: number };

// Adds id at the end of the pick order, or removes it.
const togglePick = (picks: string[], id: string): string[] => {
    return picks.includes(id) ? picks.filter(p => p !== id) : [...picks, id];
};

// Levels from lowest to highest, numbered from 1.
const levelOptions = (levels: LevelInfo[]) => {
    return levels
    .slice()
    .sort((a, b) => a.height - b.height)
    .map((l, i) => ({ index: l.index, number: i + 1, height: l.height }));
};

// The first pages * PAGE_SIZE items on the level (all levels for null) and
// how many more there are.
const visibleItems = <T extends { level: number }>(items: T[], level: number | null, pages: number) => {
    const filtered = level === null ? items : items.filter(i => i.level === level);
    const count = pages * PAGE_SIZE;
    return { shown: filtered.slice(0, count), more: Math.max(0, filtered.length - count) };
};

// The candidate's view as a camera pose, target at its median depth.
const candidatePose = (c: { position: Vec3Like, direction: Vec3Like, depth: number, fov: number }): ViewPose => ({
    position: { ...c.position },
    target: {
        x: c.position.x + c.direction.x * c.depth,
        y: c.position.y + c.direction.y * c.depth,
        z: c.position.z + c.direction.z * c.depth
    },
    fov: c.fov
});

// Camera at eye height above the box floor, over the box centre, looking
// along -z.
const eyePreviewPose = (box: Box, eyeHeight: number, fov: number): ViewPose => {
    const x = (box.min.x + box.max.x) / 2;
    const z = (box.min.z + box.max.z) / 2;
    const y = box.min.y + eyeHeight;
    return { position: { x, y, z }, target: { x, y, z: z - Math.max(eyeHeight, 1e-3) }, fov };
};

const showTiltWarning = (tiltDeg: number) => tiltDeg > TILT_WARN_DEG;

export { PAGE_SIZE, candidatePose, eyePreviewPose, levelOptions, showTiltWarning, togglePick, visibleItems };
export type { ViewPose };
