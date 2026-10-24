# Fix Path — Design

Date: 2026-10-24
Base: branch `feature/balance-timing` at 5e42648 (includes Balance timing and Suggest Views)

## Intent

Shots built from picked views (or hand-placed keys) often move through walls, floors or furniture, because the camera spline connects keys in a straight-ish curve, and the key order is whatever order they were picked in. The user then has to reorder keys and add in-between keys by hand. **Fix path** does that in one click: it orders the keys, routes the camera through doors and openings, and balances the timing.

Part 2 of 3 of the shot workflow:
1. Suggest Views (done)
2. **Fix path** (this document)
3. Orbit tool (later)

## Goals

- A **Fix path** button next to Balance that works on all camera keys on the timeline (hand-placed or from Suggest Views).
- Suggest an order: first key stays first; the rest sorted for the shortest walking distance through the scene (distance along the routed path, not straight line). A **Keep my order** option skips reordering.
- Route between consecutive keys through free space: through doors and openings, never through walls, floors or objects. Where the camera curve would hit geometry, insert **detour keys**.
- Walk-like by default: prefer eye height above the floor below; climb/fly only where walking can't reach. **Allow flying** setting, on by default; off = walking only (stairs if the scan has them).
- Unreachable keys are reported, never silently deleted.
- Run Balance timing over the result. Everything is one undo step.

## Non-goals

- Orbits (part 3), suggesting objects, VLMs.
- Changing where the user's own keys are in space or what they look at. Fix path only changes their order/time and adds detour keys between them.
- Collision checks while the user drags keys by hand (no live mode).
- Perfect collision guarantees against single floaters; the check works on the same occupancy grid as Suggest Views (opaque splats, ≥ 2 per voxel).

## Anti-goals

- The camera visibly passes through a wall, floor, door frame or furniture after Fix path.
- Fix path deletes, moves in space, or re-aims a key the user placed or picked.
- Running Fix path twice piles up detour keys.
- The route goes outside the scanned area (unscanned void shows black or floaters).
- Detours that look like a robot: sharp turns, the camera staring at a wall while it walks, sudden height jumps.

## Decided by the user

- Between rooms the camera finds a way through the scene (door/opening), like a person walking.
- If a key can't be reached (closed or unscanned door): mark it, tell the user which key, don't delete it.
- Order: tool suggests; the shot starts at the first key; the tool chooses the rest and the end.
- Trigger: a separate **Fix path** button working on any keys on the timeline.
- Flying up through open air (e.g. courtyard to gallery) is allowed; a setting controls it.
- **Unreachable keys go to the end of the order**; the segment into them is marked red as blocked. The rest of the shot runs cleanly; the user deletes or moves the unreachable key.
- **Camera path in the 3D view:** draw the camera curve as a line whenever the existing "show camera poses" overlay is on (no new toggle): blocked segments red, detour keys in the auto-key colour, unreachable keys highlighted. Updates when keys, smoothness or loop change.

## Calls made by me (check these)

- **Keep my order** checkbox next to the button (off by default).
- **Allow flying** setting, on by default; even when on, the planner prefers eye height above a floor and only climbs where needed.
- **Detour keys** are marked (`auto` flag on the pose, saved with the project), drawn in a different colour on the timeline. Running Fix path again first removes all `auto` keys, then plans fresh. Editing an auto key by hand (move in time, update pose) turns it into a normal key.
- **Look direction on detours:** along the direction of travel (target ahead on the path), blending towards the next user key's view as the camera approaches it. Fov interpolates between the neighbouring user keys.
- **Detour height:** eye height above the floor below when walking; the eye height is the one from Suggest Views (estimated, editable there).
- **Loop:** with timeline loop on, the order is a closed tour and the last → first segment is routed too.
- **Route stays inside the area box** from Suggest Views and avoids free space far from any scanned geometry (unscanned void).
- Balance runs automatically at the end, with the user's lingers and rotation weight; detour keys get no linger.
- **Box and eye height:** the values last used in Suggest Views in this session (shared session state, not saved in the project); if Suggest Views wasn't used, fresh estimates from `candidates.prepare`. The Fix path popover shows the eye height so a wrong estimate is visible.
- **Balance fails after planning:** keysChanged → abort the whole Fix path, nothing applied. Any other failure (e.g. too few frames for the detour keys) → apply order and detours, space keys with the existing fallback (`fallbackAppendFrames` style compression), and show the Balance message. Still one undo step.
- **Unreachable / blocked markers** are temporary UI state: shown until the next track edit or the next Fix path run, not saved.
- **A user key inside geometry or outside the box:** planning snaps to the nearest free cell; the curve check ignores a radius of 2 voxels around user keys; the report lists the key as "inside geometry".
- **Later smoothness or loop changes** can invalidate the fix; no automatic rerun. The guide says to run Fix path again after changing them.

## How it works (outline)

1. **Grid.** Reuse the Suggest Views pipeline: `candidates.prepare` (points cache, area box, eye height), occupancy at voxel = eye height / 4, levels. A camera cell is free if `occ.isFree(p)` (1-voxel clearance) and inside the box.
2. **Walkable vs flying cells.** Walking cells: free cells at eye height above a standable surface (level cells, Suggest Views definition), connected horizontally with steps ≤ 1 voxel (stairs/ramps). Flying cells: any other free cell inside the box that is near scanned geometry (builder picks the rule, e.g. within a few metres of an occupied voxel), with a cost penalty per voxel above walking height.
3. **Pairwise routes.** A* (or Dijkstra from each key) on the grid between all key pairs to get route distances; keys whose cell isn't free are snapped to the nearest free cell for planning only (the key itself is not moved). Unreachable pairs = infinite distance.
4. **Order.** First key fixed. For n keys: exact DP for small n (≤ ~12), nearest neighbour + 2-opt above that; closed tour when looping. Keys unreachable from the first key are reported and placed at the end of the order (user decision).
5. **Detours.** For each consecutive pair, simplify the grid route to as few points as possible while every straight piece stays in free space; then check the actual camera curve (the `CubicSpline` the timeline uses, at the current smoothness) by sampling it against the grid, and add route points as detour keys until the sampled curve is collision-free (bounded iterations).
6. **Apply.** One track edit: remove old auto keys, set the new order, insert detour keys, then Balance (`computeBalance` from `src/timing-events.ts`) → final frames. One undo step.
7. **Report.** Popup or status line: N detour keys added, keys K… unreachable (frames), M segments still blocked (if the curve check couldn't be satisfied).

## Constraints (from the code)

- Pose type (`src/camera-poses.ts`): add `auto?: boolean`; keep it through snapshot/restore/copy and serialization like `linger`.
- Undo: one `trackEdit` op (`src/track-manager.ts`), as `appendPoses` does in `src/view-keys.ts`.
- Balance: reuse `computeBalance` (`src/timing-events.ts`); keysChanged handling as in Balance / Add as Keys.
- Spline: `src/anim/spline.ts` (`CubicSpline`, smoothness, loop via `fromPointsLooping`); the viewer export uses the same spline, so the collision check against the editor spline holds for exports.
- Grid: `src/candidates/occupancy.ts`, `levels.ts`, `candidate-events.ts` (`candidates.prepare`). Don't duplicate the point readback.
- 3D path: extend or sit next to `src/camera-pose-gizmos.ts` (debug line mesh, `PRIMITIVE_LINES`, debug shader); sample the same `CubicSpline` the timeline uses; respect the `camera.showPoses` overlay toggle.
- UI: button next to Balance in `src/ui/balance-controls.ts` (or a sibling file); timeline colour for auto keys and unreachable markers in `src/ui/timeline-panel.ts` (already large — append only, put drawing helpers in a new file).
- New files < 500 lines; pure planning code (grid routes, order, simplification, curve check) testable in Node without rendering.
- i18n in all 9 locales, real translations.
- Performance: Fix path on ~20 keys in the courtyard well under 5 s; report measured time.

## Testing

- Unit tests: route around a wall through a door gap; no route through a closed wall (unreachable); walking-only vs flying to an upper level; order = shortest tour with first key fixed (small known case); loop tour; simplification keeps segments free; sampled spline check inserts keys until free; rerun removes old auto keys; auto key edited by hand becomes normal; one undo step.
- Browser check on the courtyard (straightened): keys on the floor and indoor levels picked via Suggest Views → Fix path → render a short video or frame strip for the user; user judges whether the camera passes through geometry and whether detours look natural.
- Experiment record in `/Volumes/T7 Shield/Temp/supersplat/fix-path/` with commit hash; timings and counts to wandb.

## Docs

- Guide `docs/fix-path.md`, README Guides link; update `docs/view-candidates.md` limits line (paths now fixable with Fix path).
