# Orbit Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Orbit button that adds a collision-checked orbit around the camera's focal point as camera keys, timed by Balance and kept intact by Fix Path.

**Architecture:** Pure geometry in `src/orbit/` (keys on a circle, arc check, radius search), an event module `src/orbit-events.ts` (defaults, plan, add), a pose flag `orbit` on camera keys, block handling in Fix Path's planner, and a popover in `src/ui/orbit-controls.ts` with a 3D preview line.

**Tech Stack:** TypeScript, PlayCanvas, pcui, Node test harness (`npm test`; files registered in `test/queue-ordering.mjs`, tests import `./.build/src/...js`), i18n `static/locales/*.json` (9 files, `npm run lint:locales`).

**Spec:** `docs/superpowers/specs/2026-10-25-orbit-tool-design.md`

## Global Constraints

- Splat file only.
- One undo step per Add orbit.
- 22.5° per key (16 per full turn); a span of S degrees has S / 22.5 + 1 keys (round S to a multiple of 22.5); a full turn's last key repeats the first position.
- Target = centre for every orbit key; fov = current camera fov; world up +y.
- Radius search: down in voxel/2 steps, not below MIN_RADIUS = 1 voxel; arc samples every voxel/4; centre may be inside geometry.
- Turn cap stays as is (20°/s, Balance warns when the shot is too short; no automatic timeline change).
- Block = maximal run of keys in frame order sharing one `orbit` id; only changing a key's position/target clears its flag.
- Files < 500 lines; comments describe code, not history; real translations in 9 locales; `npx eslint src` clean (an eslint crash "getTokenOrCommentBefore is not a function" means an import/order violation).
- Unit tests short.

## Review Focus

- Focal point exactly at the camera (radius 0) → defaults give MIN_RADIUS, no NaN keys. Test in Task 2.
- Span not a multiple of 22.5 or outside 90–360 → clamped/rounded, never 0 or 1 key. Test in Task 2.
- Orbit added to an empty timeline (no keys yet) → orbit keys alone, balanced. Test in Task 3.
- Fix Path with two orbits and keepOrder on → each block stays contiguous and in order. Test in Task 4.
- Updating one orbit key with the current view splits the block in two runs; Fix Path keeps both runs intact. Test in Task 4.

---

### Task 1: `orbit` pose flag

**Files:** Modify `src/camera-poses.ts` (Pose type, copyPose, appendPoses accepts an optional `orbit` per added pose), serialization path that saves pose flags (find where `parked`/`auto` are written and read in project save/load), `src/camera-pose-gizmos.ts` only if keys need an orbit colour (no: reuse the user-key colour). Test: `test/camera-track.mjs` or a new `test/orbit-keys.mjs`.

**Interfaces:**
- `Pose.orbit?: string`.
- `appendPoses(added: { position: Vec3, target: Vec3, fov: number, orbit?: string }[], frames: number[])` keeps `orbit` on the new poses.
- Replacing a key's pose by hand (the "update key" path, i.e. `addPose` at an existing frame or the track's update op) drops `orbit`; `moveKey`, `retime`, `replacePath` keep it.

- [ ] Step 1: failing tests — appended poses keep `orbit`; snapshot/restore and save/load keep it; moving a key keeps it; updating a key's view drops it.
- [ ] Step 2: run `npm test` → fail. Step 3: implement. Step 4: `npm test` → pass.
- [ ] Step 5: commit `Keep an orbit id on camera keys`.

### Task 2: Orbit geometry

**Files:** Create `src/orbit/orbit-path.ts`; test `test/orbit-path.mjs`.

**Interfaces:**
- `type OrbitSpec = { centre: Vec3Like, radius: number, height: number, startDeg: number, spanDeg: number, dir: 1 | -1, fov: number }` — `startDeg` is the azimuth of the start position around the centre (atan2 of the offset in the xz plane, degrees), `dir` 1 = left (counter-clockwise seen from above, +y up), −1 = right.
- `orbitDefaults(centre: Vec3Like, camera: Vec3Like, voxel: number): { radius, height, startDeg }` — radius = horizontal distance (≥ MIN_RADIUS·voxel), height = camera.y − centre.y.
- `clampSpan(deg: number): number` → multiple of 22.5 in [90, 360].
- `orbitKeys(spec: OrbitSpec): CurvePose[]` (from `src/anim/camera-curve.ts`).
- `arcBlocked(occupied: (ix, iy, iz) => boolean, voxel: number, spec: OrbitSpec): { blocked: boolean, ranges: [number, number][] }` — samples the circle every voxel/4 of arc length; `ranges` are blocked azimuth ranges in degrees for drawing.
- `fitRadius(occupied, voxel, spec): { radius: number, reduced: boolean } | null` — the largest radius ≤ spec.radius in voxel/2 steps (≥ MIN_RADIUS·voxel) whose arc is free; null when none.
- `MIN_RADIUS = 1` (voxels), `DEG_PER_KEY = 22.5`.

- [ ] Step 1: failing tests — 360° gives 17 keys, first and last positions equal, all at the radius (±1e-9) and height, targets at the centre; 90° gives 5 keys; direction 1 turns counter-clockwise seen from +y; `clampSpan(100) === 90`, `clampSpan(400) === 360`, `clampSpan(10) === 90`; defaults with the camera at the centre give MIN_RADIUS·voxel and finite keys; a pillar on the circle → `arcBlocked` true with a range around its azimuth; `fitRadius` shrinks inside a ring wall and returns null when the centre sits in a closed box smaller than MIN_RADIUS.
- [ ] Step 2–4: fail → implement → pass.
- [ ] Step 5: commit `Place orbit keys on a circle and check the arc against the scene`.

### Task 3: Orbit events

**Files:** Create `src/orbit-events.ts` (register in `src/main.ts` or wherever `registerFixPathEvents` is registered); modify `src/view-keys.ts` to share its append-and-balance code (extract `appendAndBalance(events, added)` used by `views.addKeys` and `orbit.add`); test `test/orbit-events.mjs`.

**Interfaces:**
- `orbit.defaults` → `{ centre, radius, height, startDeg, fov, metric, shotSeconds, turnSeconds }` from `camera.focalPoint`, the camera position, the grid voxel (eye/4 of `candidates.lastSettings` or `candidates.prepare`), `timeline.frames / frameRate`; `turnSeconds = spanDeg / MAX_TURN_DEG_PER_SEC` (import from `src/anim/balance-timing.ts`).
- `orbit.plan(spec: OrbitSpec)` → `{ keys: CurvePose[], radius, reduced: boolean, blockedRanges }` or `{ keys: [], blocked: true, blockedRanges }`; grid from `buildSceneGrid` like Fix Path's `defaultSceneGrid` (occupancy only), cached per eye height/box until `candidates.cloud` changes.
- `orbit.add(spec)` → `{ ok, reason?, added: number, radius, reduced, balance, orbitBlocked: boolean, joinBlocked: boolean }`: plans, appends with a fresh id (`orbit_<n>`), balances (one undo step), then runs `curveCollisions` (`src/path/curve-check.ts`) on the new curve: segments between orbit keys → `orbitBlocked`; the segment from the previous last key into the orbit → `joinBlocked`. Uses a NavGrid-free point check equivalent to `grid.pointFree` (occupancy `occupied` of the voxel containing the sample).

- [ ] Step 1: failing tests — defaults from a known focal point/camera; plan on a free scene returns 17 keys at the requested radius; plan near a wall reduces the radius and says so; add on an empty timeline gives 17 keys sharing one orbit id and an ok balance; add after two existing keys appends after them (existing frames come first) and is one undo step (undo restores the old keys); a join through a wall sets `joinBlocked`.
- [ ] Step 2–4: fail → implement → pass.
- [ ] Step 5: commit `Add orbit events that plan, place and balance an orbit`.

### Task 4: Fix Path keeps orbit blocks intact

**Files:** Modify `src/fix-path-events.ts` (pass orbit ids of user keys), `src/path/fix-plan.ts` (collapse/expand blocks, asymmetric distances, park whole blocks), `src/path/detours.ts` (`DetourInput.fixed?: boolean[]`: fixed segments get no detours and are not pruned, but their collisions still mark them blocked); test `test/fix-path-orbit.mjs`.

**Interfaces:**
- `FixKey.orbit?: string`.
- `orbitBlocks(keys: FixKey[]): number[][]` (in fix-plan.ts or a small new `src/path/blocks.ts`): runs of consecutive keys (input is frame order) with the same orbit id; other keys are single-key blocks.
- Routing: route between block exits and block entries only (key positions of first/last keys); distance from block A to block B = route(last of A, first of B); `orderKeys` gets the block-level matrix (it supports asymmetric distances); a block is in the main group when both its first and last key are; otherwise the whole block is parked.
- Expansion: ordered blocks → key list; segments inside a block have route `[]` and `fixed[i] = true`.
- keepOrder: block order = frame order of first keys.

- [ ] Step 1: failing tests — two user keys and one orbit block in an open room: Fix Path keeps the 17 orbit keys contiguous and in their order, adds no detours between them, and orders the block by its entry/exit; an orbit whose exit is walled off is parked whole (no single orbit key parked); keepOrder with two orbits keeps both contiguous; an orbit split into two runs (one key's view updated) gives two blocks, both intact.
- [ ] Step 2–4: fail → implement → pass (existing Fix Path tests unchanged).
- [ ] Step 5: commit `Fix Path keeps orbit keys together`.

### Task 5: Orbit popover, preview line, docs

**Files:** Create `src/ui/orbit-controls.ts` (button + popover beside Fix Path in `src/ui/timeline-panel.ts`), preview drawing beside `src/path-line.ts` / `src/camera-pose-gizmos.ts` (event `orbit.preview` with keys and blocked ranges, cleared on close), locales (9), `docs/orbit.md`, README Guides link; tests for any pure helpers (e.g. the readout text).

**Interfaces / copy (en):**
- Button `timeline.orbit` "Orbit", tooltip "Orbit: circle the camera around the focal point".
- Fields: `orbit.radius` "Radius", `orbit.height` "Height", `orbit.span` "Span", `orbit.direction` "Direction" with `orbit.left` "Left" / `orbit.right` "Right", readout `orbit.keys` "{{count}} keys", `orbit.turn-time` "Full turn needs ≥ {{need}} s at the turn cap; shot is {{shot}} s", button `orbit.add` "Add Orbit".
- Results: `orbit.reduced` "Radius reduced to {{radius}} to stay clear", `orbit.blocked` "No clear orbit here: move the focal point or the camera", `orbit.join-blocked` "The way into the orbit is blocked; run Fix Path to connect", `orbit.status` "Orbit added: {{count}} keys".
- Units like Fix Path (`fix-path.unit-metres` / `fix-path.unit-scene`).
- Preview updates when a field changes (debounced ~150 ms), drawn red on blocked ranges.

- [ ] Step 1: build the UI; locales; docs (to the point, bullets).
- [ ] Step 2: `npm test`, `npx eslint src`, `npm run lint:locales` pass.
- [ ] Step 3: commit `Add the Orbit popover with a 3D preview`.

### Task 6 (controller, after the final review): browser check and video

- Courtyard: orbit around the courtyard centre and around a corner close to a wall (radius reduction); hall: orbit in the hall. Record keys, radius, reduction, Balance warning, timings; render videos; experiment record `research-fixes/../orbit/` in the experiment repo with the commit hash; user judges: circle smooth, no wobble, no clipping, sensible speed.
