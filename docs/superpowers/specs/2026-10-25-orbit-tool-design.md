# Orbit Tool — Design

Date: 2026-10-25
Base: branch `feature/balance-timing` at 84e0780 (Balance timing with turn cap, Suggest Views with openness, Fix Path)
Research: experiment repo `/Volumes/T7 Shield/Temp/supersplat/reports/Automatic camera shots prior art.md` (orbit section) and `research_notes/Automatic camera shots prior art/orbit_shots.md`, `circ.py`.

## Intent

Client shots often circle a subject: a fountain in a courtyard, a staircase, a façade corner. Building that by hand needs many keys placed on a circle, and the camera spline cuts inside a circle when there are few keys. The orbit tool adds an orbit around a chosen point as camera keys in one step. Part 3 of 3 of the shot workflow.

## Decided by the user

- Skipped the questions; all calls below are mine (see "Calls made by me").
- Standing rules from earlier parts: splat file only; one undo step; Balance times the result; orbits must not pass through geometry; anything that changes how shots look gets a user visual check.

## Goals

- An **Orbit** button in the timeline controls next to Fix Path, with a popover: radius, height, span (degrees), direction, a "keys" readout, and **Add orbit**.
- Centre = the camera's current focal point (set as today by picking a point on the splats); start = the current camera position. Radius and height default from the camera's offset to the centre, so "frame the subject, click Orbit, Add" works without typing (DJI/Skydio "circle" pattern).
- While the popover is open, the planned circle is drawn in the 3D view (same line style as the camera path), red where blocked.
- Keys are baked on the circle and appended after the existing keys in the shot; Balance timing runs; one undo step.
- The camera looks at the centre the whole time (aim exact).
- Collision-aware: the orbit is checked against the scene grid before it is added (see How it works).

## Non-goals

- A parametric orbit segment or explicit spline tangents (changes the timeline/export format; baked keys are accurate enough, see numbers below).
- Automatic subject detection or click-to-object segmentation (needs photos; research found no photo-free method).
- Editing an orbit after creation as a unit (undo and redo the orbit instead).
- Spiral, crane or dolly-zoom moves.

## Anti-goals

- The orbit passes through a wall, pillar or floor.
- The orbit visibly wobbles (radius or speed) or turns faster than Balance allows elsewhere.
- Fix Path breaks an orbit apart (reorders its keys or adds detours inside it).
- Adding an orbit moves or deletes existing keys (other than Balance retiming).

## How it works

1. **Keys on the circle.** One key every 22.5° of span (16 per full turn; Catmull-Rom with these tangents dips 0.055 % inside the circle, speed varies ~4 %, `circ.py`). Span 360° by default; a full turn ends at the start angle (the last key repeats the first position). Position = centre + radius·(cos θ, 0, sin θ) + height; target = centre; fov = current camera fov. World up is +y.
2. **Collision check** on the Suggest Views / Fix Path occupancy grid (same box and eye height as Fix Path): sample the arc densely (every quarter voxel); a sample is blocked when its voxel is occupied. If any sample is blocked:
   - find the largest radius r ≤ requested at which the whole arc is free (search down in voxel/2 steps, not below MIN_RADIUS = 1 voxel); if found, use it and tell the user ("radius reduced to … to stay clear");
   - otherwise do not add; draw the blocked parts red and say so.
   - The centre itself may be inside geometry (it usually is: the subject).
3. **Orbit group.** Each orbit's keys carry `orbit: <id>` (string, saved with the project, kept by copy/snapshot like `auto`/`parked`; editing one key by hand clears it on that key). 
4. **Timing.** Keys are appended after the last key in the shot (like Add as Keys), then Balance retimes everything (the turn cap applies: a full turn needs ≥ 18 s at 20°/s; Balance warns as usual when the shot is too short).
5. **Fix Path.** An orbit group is one unit: ordering moves it as a block (enter at its first key, leave at its last), keeps its internal order, adds no detours between its keys, and does not park single orbit keys (the whole group is parked or kept).

## UI

- Orbit button + popover in `src/ui` (new file), next to Fix Path. Fields: Radius (scene units, metres when metric), Height (offset above the centre), Span (90–360°, default 360), Direction (left/right), readout "16 keys". Defaults refresh when the popover opens.
- The 3D preview line lives with the existing path-line drawing (`src/path-line.ts` / `camera-pose-gizmos.ts`).
- Strings in all 9 locales.
- Guide: `docs/orbit.md` (short), README Guides link.

## Calls made by me (check these)

- Centre from the focal point, start from the camera (no new picking tool).
- 16 keys per turn, baked; no new spline type.
- Default direction: left (counter-clockwise seen from above).
- Blocked orbit → shrink radius uniformly; no partial arcs, no height change.
- Orbit keys appended after existing keys, then Balance (not inserted at the playhead).
- Orbit keys timed by Balance like other keys; no separate orbit duration field.
- Fix Path treats orbit groups as blocks.

## Constraints (from the code)

- Pose flags in `src/camera-poses.ts` (`auto`, `parked`): add `orbit?: string` the same way (copy, snapshot, serialization, cleared on hand edit).
- Undo: one track edit (`track.replacePath` pattern from Fix Path / `views.addKeys` append pattern).
- Grid: `buildSceneGrid` / `candidates.cloud` / `candidates.lastSettings` as Fix Path's `defaultSceneGrid`.
- Fix Path ordering in `src/path/order.ts`, `key-graph.ts`, `fix-plan.ts`, `detours.ts`: blocks need the smallest change that keeps groups contiguous (e.g. order block representatives, expand afterwards; skip detours between consecutive keys of one group).
- Files < 500 lines; pure geometry (keys on circle, arc check, radius search) testable in Node.
- Experiment record and user visual check: courtyard (orbit around the fountain/centre) and hall; video for the user.
