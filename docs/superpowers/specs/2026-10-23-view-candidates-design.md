# View Candidates — Design

Date: 2026-10-23
Base: branch `feature/balance-timing` (5d1af81)
Spike: notes and scripts in the session scratchpad `viewspike/` (NOTES.md); to be copied to `/Volumes/T7 Shield/Temp/supersplat/view-selection-spike/`.

## Intent

Choosing camera views for client shots of 3DGS scenes (buildings, interiors, courtyards) takes a lot of manual orbiting. This feature generates usable candidate views from the splat file alone and lets the user pick from a grid; picks become camera keys that Balance timing (project 1, done) then times.

This is part 1 of 3 of the shot workflow:
1. **View candidates** (this document)
2. Suggested key order and path check (detours around geometry) — later
3. Orbit tool (click an object, get an orbit segment) — later

## Goals

- Generate candidate views inside SuperSplat from the loaded splats only.
- Show them as thumbnails in a side panel; the user picks; picks become camera keys.
- Work for interiors, exteriors and mixed scenes with several ground levels (floors, galleries, roofs).
- Work for metric and arbitrary scene scale.

## Non-goals

- Using source photos, capture camera poses or `cameras.json`. **Hard constraint from the user: splat file only.** Also no capture-tool conventions (e.g. "origin = first camera").
- VLM or learned aesthetic scoring. Spike result: a geometric/image filter already gives usable views (58/60 kept across two scenes).
- Suggesting interesting objects, orbits, key order, path collision checks (parts 2–3).
- Splat-level floater detection (see Follow-ups) unless the filter proves too weak in testing.
- Rescaling or reorienting the scene.

## Anti-goals

- Candidates that look out into nothing, into a wall, or through floaters reach the grid.
- Generation freezes the editor without progress or a way to cancel.
- Hover preview leaves the user's camera somewhere else.
- Picking changes or removes existing keys.

## Decided by the user

- Splat file only (see Non-goals).
- Scene orientation: use the current one; the user straightens the scene beforehand if needed.
- Area: the tool proposes a box; the user can adjust it before generating.
- Scale: no rescaling. One **eye height** value in scene units, auto-estimated, editable, with a live camera preview at that height.
- Progress must be visible.
- UI layout **A** (tentative): side panel beside the viewport, hover previews the view in the viewport, timeline stays visible. Needs a UX review with screenshots before merge.
- Picks are **added** to existing keys. Total length (`timeline.frames`) stays unchanged: new keys go after the existing ones in pick order, then Balance timing runs automatically over all keys, all in one undoable edit. If Balance refuses (e.g. lingers too long for the length), existing key times are compressed proportionally to make room, the new keys are spaced evenly at the end, and the Balance message is shown.
- Interiors and semi-outdoor/outdoor scenes are in scope for the first version (tested: art nouveau hall, courtyard Scan_2).
- Scenes can have multiple ground levels.

## Calls made by me (check these)

- Tilt warning: if the scene looks tilted (> ~10°, estimated from the splats) show a non-blocking warning before generating.
- Panel shows ~40 best candidates, "show more" for the rest, filter by level, can widen into a larger grid.
- Candidates live for the session only (not saved in the project).
- Progress with cancel; thumbnails appear while generation runs.
- Eye-height estimate: if the scene looks metric, 1.6; otherwise derived from detected storey/room height. Builder chooses the heuristic; the user can always correct the value.
- Fov: candidates are rendered with the user's current camera fov, and picked keys store that fov, so thumbnails match keys and picking adds no fov animation.
- Target: a picked key's target is placed along the view direction at the candidate's median depth hit (the same distance Balance timing samples), not at a fixed look-at distance.
- Render budget per level is proportional to level area (not equal share), so a large ground floor isn't starved by many small roof patches.
- Blind test cut-off: ranks just above and just below the panel's first page (~rank 40), 20 each. Results are reported to the user; not an automatic merge gate. UX review is by the user, with screenshots, before the panel is finished.

## How it works (from the spike)

1. **Free space.** Voxelize splat centres (opaque splats, opacity > 0.5) at a size relative to eye height (spike: 0.8 m at 1.6 m eye height). A voxel counts as occupied with ≥ 2 splats (ignores lone floaters). Restricted to the area box.
2. **Levels.** A standable surface is an occupied voxel with free space above it for at least head clearance (spike: 3 voxels). Group surfaces into connected patches (allow 1-voxel steps for stairs/ramps); keep patches above a minimum area (spike: 20 m² at metric scale). Each patch is a level. Roofs and tables can appear as levels; small ones are dropped by the area threshold, large roofs remain and are scored like any other level.
3. **Positions and directions.** Sample positions on each level at eye height above the surface, require free space around the camera. Directions: 8 azimuths × pitches {0°, +10°, −15°}, no roll. Fov = user's current camera fov. Candidates per level proportional to level area.
4. **Pre-render rejection.** Drop candidates that look into nothing (no depth hits) or have geometry right in front (median depth below a threshold relative to eye height). Cheap: depth picks or a ray march through the voxel grid. Spike rendered these and wasted ~20% of renders on black images.
5. **Render and score.** Render small thumbnails offscreen. Score from the image and depth only: fraction of flat/blurry tiles (floaters, holes), dark/empty fraction, near-geometry penalty, small penalty for slight pitch (converging verticals). See `viewspike/score.py`.
6. **Diversity.** Sort by score; drop near-duplicates (close position and similar direction).

Known weakness (spike): sharp-edged streak floaters near the camera pass the blur metric; a real table close to the camera is penalised like a floater. Acceptable for v1.

## Constraints (from the code)

- Rendering: offscreen render path in `src/render.ts` (`render.offscreen`) and `scene.camera.startOffscreenMode`; GPU depth picking via `camera.pickDepths` / `camera.sampleDistances` (`src/editor.ts`) and `camera.frameAtPose` (`src/camera.ts`). Must not leave the viewport in offscreen mode on cancel or error.
- Splat data: positions/opacity are on the GPU; the builder finds the cheapest readback path (see `src/splat-properties.ts` and the data processor). Use world transforms so the user's orientation is respected.
- Area box: reuse `BoxShape` and the gizmo from `src/tools/box-selection.ts` where possible.
- Keys: add via the camera track (`src/camera-poses.ts`, `addPose`) as one undoable edit through the existing `trackEdit` pattern (`src/track-manager.ts`).
- Progress: `src/ui/progress.ts` exists (header, text, progress, cancel); the panel may instead show inline progress, builder's call.
- File size: keep new files under 500 lines. `src/camera.ts` (1171) and `src/editor.ts` (1312) are already large: put new logic in new modules (e.g. `src/candidates/`), pure functions for voxelization, levels, sampling and scoring, testable without rendering.
- i18n: all strings in `static/locales/*.json` (9 files, `npm run lint:locales`), real translations as in project 1.
- Performance target: whole generation (≈240 candidates) well under a minute on the test scenes; report measured time. Spike via browser screenshots: ~2 min.

## UI

- Entry: a "Suggest views" action (location: builder proposes, near the timeline/camera tools).
- Before generating: area box (proposed, adjustable), eye height (estimated, editable, live preview), tilt warning if any, Generate button.
- Side panel (layout A): progress + cancel, thumbnail grid (2 columns, widen option), level filter, hover = preview in viewport (restore on leave), click = toggle pick, "Add N as keys".
- Check how established tools handle candidate/asset browsers (Blender asset browser, Lightroom grid) and get a UX review.

## Testing

- Unit tests (fast, no rendering): voxel occupancy, level detection (two stacked floors → two levels; small table → dropped), position sampling respects free space, pre-render rejection, diversity filter, key append order and spacing, undo.
- Blind user test on both scenes: candidates from just above and just below the score cut-off (not best vs worst; the spike showed that is too easy). Record agreement.
- Measure generation time on both scenes.
- Experiments recorded in `/Volumes/T7 Shield/Temp/supersplat/` with commit hash; metrics to wandb.

## Follow-ups

- Splat-level floater detection (large, elongated, isolated splats projected into view) if the filter misses too much.
- Part 2: suggested order, path check with detours.
- Part 3: orbit tool; later automatic object suggestions (possible VLM use).

## Docs

- Short user guide entry next to `docs/balance-timing.md`; README "Guides" link.
