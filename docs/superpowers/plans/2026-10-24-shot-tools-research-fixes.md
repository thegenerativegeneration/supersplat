# Shot Tools Research Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps the prior-art review found in Suggest Views, Fix Path and Balance timing: viewer-matching density occupancy, a camera sphere check, look-ahead on detours, a 20°/s turn cap with speed readout, wall-aligned and openness-scored candidate views.

**Architecture:** New pure modules (`src/candidates/density.ts`, `walls.ts`, `isovist.ts`, `src/path/clearance.ts`) plus small changes in the existing planners. Every look-changing change sits behind a session option that defaults to current behaviour; the turn cap is on by default. Options reach the planners as plain parameters so the pure code stays testable in Node.

**Tech Stack:** TypeScript, PlayCanvas, pcui, Node test harness (`npm test`: tsc into `test/.build`, files registered in `test/queue-ordering.mjs`), i18n in `static/locales/*.json` (9 files, `npm run lint:locales`).

**Spec:** `docs/superpowers/specs/2026-10-24-shot-tools-research-fixes-design.md`

## Global Constraints

- Splat file only: no photos, capture poses or `cameras.json`.
- Files < 500 lines; `src/path/nav-grid.ts` (411) grows by at most ~30 lines — new logic in new files.
- Options default to the current behaviour; only the turn cap is on by default (user decision).
- Session settings reset on `scene.clear`, like the existing Fix Path / Suggest Views settings.
- All new strings in all 9 locales, real translations.
- Unit tests short (no test above ~1 s).
- Courtyard Fix Path with ~20 keys stays well under 5 s; Suggest Views generation under a minute.
- Comments describe code, not history.
- Run `npm install` once before Task 1 (local splat-transform is 3.6.4, package.json pins 3.10.2) and confirm `npm test` still has only the known failure ("resized picks retain temporary buffers…").

## Rulings from reading the code (deviations from the spec text)

- **No global distance transform.** `nav-grid.ts` already has a clearance cost (`proximity`: `PROXIMITY_WEIGHT · max(0, PROXIMITY_RANGE − d) / PROXIMITY_RANGE`, range 3 voxels, keeps routes in the middle of doors). The spec's soft cost would be weaker than it. The new parts are the sphere check and a sub-voxel clearance query, which need only the 3×3×3 neighbourhood because the camera radius is below one voxel. Felzenszwalb–Huttenlocher is not needed.
- **No per-Gaussian floater filter.** At eye/4 voxels a Gaussian's nearest voxel point lies inside its own voxel, so the filter would only drop splats below 1/255 opacity that cannot make a voxel solid. The cluster filter does the floater work.
- **Camera radius 0.4 voxel** (0.16 at eye 1.6) instead of 0.2 × eye/1.6 = 0.5 voxel: grid nodes in a two-voxel-wide door sit exactly 0.5 voxel from the jambs, so 0.5 would fail the 0.9 m door requirement.

## Review Focus

- Density rule on a scene where everything is faint (no solid voxel, no level) → Suggest Views reports `noLevels`, Fix Path reports no route, no exception. Test in Task 2.
- Turn cap with timeline loop on: the closing segment is capped too. Test in Task 6.
- Detour look direction when the next key looks exactly backwards along travel (antiparallel slerp) → finite direction, clamp holds. Test in Task 5.
- A user key placed close to a wall with "Keep clear of walls" on: the existing user-key skip radius still applies, the key is not reported as blocked. Test in Task 4.
- New options are forgotten on `scene.clear`. Test in Task 3.

---

### Task 1: Read all splats for the density rule

**Files:**
- Modify: `src/candidates/read-points.ts` (split the chunk walk into a shared visitor)
- Create: `src/candidates/read-density.ts`

**Interfaces:**
- Produces: `type DensitySplats = Float32Array` with `DENSITY_STRIDE = 11` per splat: world centre x, y, z; σ along the splat's own axes sx, sy, sz (world units, `scale · exp(logScale)`, not 2σ); world rotation qx, qy, qz, qw; opacity (sigmoid, 0–1). Exported from `read-density.ts` with `readDensitySplats(splats: Splat[], minOpacity = 1 / 255): Promise<DensitySplats>`.
- Produces: `forEachSplat(splats: Splat[], visit: (s: SplatRow) => void): Promise<void>` in `read-points.ts`, `SplatRow = { x, y, z, sx, sy, sz, qx, qy, qz, qw, opacity }` in world space, skipping locked instances and non-finite centres, for visible layers. `readOpaquePoints` keeps its signature and output (stride thinning, opacity > 0.5, 2σ extents) and uses `forEachSplat`.

- [ ] **Step 1:** Refactor `readOpaquePoints` onto `forEachSplat`; behaviour unchanged (same stride/thinning, same `extents` = 2σ).
- [ ] **Step 2:** Implement `readDensitySplats`: every unlocked instance of visible layers with opacity ≥ `minOpacity`, no thinning; grow the output buffer by doubling.
- [ ] **Step 3:** `npm test` → only the known failure. `npx tsc --noEmit -p .` passes.
- [ ] **Step 4:** Commit: `git commit -m "Read every splat with opacity for the density occupancy"`

### Task 2: Density occupancy with cluster filter

**Files:**
- Create: `src/candidates/density.ts`
- Test: `test/density.mjs` (register in `test/queue-ordering.mjs`)

**Interfaces:**
- Consumes: `DensitySplats`, `DENSITY_STRIDE` (Task 1); `Occupancy`, `packKey`, `unpackKey` from `occupancy.ts`.
- Produces: `buildDensityOccupancy(splats: DensitySplats, voxel: number, opts?: { cutoff?: number, sigmaCutoff?: number, minCluster?: number }): Occupancy` with defaults `cutoff = 0.1`, `sigmaCutoff = 3`, `minCluster = 8` (voxels). Same `Occupancy` contract (`occupied`, `isFree`, `cells`, `voxel`).

Rule (port of splat-transform 3.10.2 `evaluateGaussianForVoxel`): for each splat, every voxel whose box overlaps the splat's 3σ world AABB gets `opacity · exp(−½ d²)`, d = Mahalanobis distance (σ units, splat frame) from the centre to the point of the voxel box nearest the centre. Per voxel Σ (stop adding at 7). Solid when `1 − exp(−Σ) ≥ cutoff`. Then drop 26-connected solid components with fewer than `minCluster` voxels.

- [ ] **Step 1: Write the failing tests**

```js
// one opaque isotropic splat (σ = 0.1) at a voxel centre, voxel 0.4: its voxel is solid,
// a voxel whose nearest point is 2.5σ away (opacity·e^-3.125 ≈ 0.044 < 0.105) is not
// many faint splats (opacity 0.02 each, 10 in one voxel) add up to solid
// one splat of opacity 0.09 alone stays free
// a large flat splat (σ 3 × 3 × 0.02) marks voxels 2 m from its centre (no 1 m cap)
// an isolated 2-voxel blob is dropped, a 3×3×3 block kept (minCluster 8)
// no solid voxel at all: cells() is empty and findLevels returns []
```

Assert with `occ.occupied(ix, iy, iz)` and `[...occ.cells()].length`.

- [ ] **Step 2:** Run `npm test` → new tests fail (module missing).
- [ ] **Step 3:** Implement `buildDensityOccupancy` (Map<packedKey, Σ>; component labelling by BFS over packed keys).
- [ ] **Step 4:** `npm test` → pass.
- [ ] **Step 5:** Commit: `git commit -m "Decide solid voxels by summed splat density, as splat-transform does"`

### Task 3: "Solid space" setting shared by Suggest Views and Fix Path

**Files:**
- Modify: `src/candidates/generate.ts` (`buildSceneGrid` takes a grid source), `src/candidate-events.ts`, `src/fix-path-events.ts` (`defaultSceneGrid`), `src/ui/candidates-setup.ts`, `src/ui/fix-path-controls.ts`, `static/locales/*.json`
- Test: `test/fix-path-events.mjs`, `test/candidates.mjs`

**Interfaces:**
- Consumes: `readDensitySplats` (Task 1), `buildDensityOccupancy` (Task 2).
- Produces:
  - `type SolidRule = 'bodies' | 'density'` (in `generate.ts`).
  - `type GridSource = { rule: 'bodies', points: Float32Array, extents?: SplatExtents } | { rule: 'density', splats: DensitySplats }`.
  - `buildSceneGrid(points: Float32Array, box: Box, eyeHeight: number, headVoxels?: number, extents?: SplatExtents, density?: DensitySplats): { occ, levels }` — when `density` is given the density occupancy is built from the splats whose 3σ AABB meets the box, else the current rule. (Keep the positional signature; the existing callers stay valid.)
  - Events: `candidates.solidRule` → `SolidRule` (default `'bodies'`), `candidates.setSolidRule(rule)`, `candidates.density` → `Promise<DensitySplats>` (cached like `candidates.cloud`, same invalidation events). Rule resets to `'bodies'` on `scene.clear`.
  - `runGeneration` and `defaultSceneGrid` read the rule and pass `density` when it is `'density'`. Eye height and box estimates stay on the opaque points.
- UI: a checkbox "Density solid space (new)" in the Suggest Views setup and in the Fix Path gear, both bound to the same event. i18n keys: `candidates.solid-density`, `tooltip.candidates.solid-density` ("Decide what is solid the way the published viewer's walk collision does: faint splats add up, small floating clumps are ignored. Slower on large scans").

- [ ] **Step 1: Failing tests:** `candidates.setSolidRule('density')` then `scene.clear` → `candidates.solidRule` is `'bodies'`; `buildSceneGrid` with a density source of a floor slab of faint splats (opacity 0.05, 4 per voxel) finds one level, the bodies rule (opacity > 0.5 only) finds none.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement events, source switch and the two checkboxes; translations in 9 locales.
- [ ] **Step 4:** `npm test` → pass; `npm run lint:locales` passes.
- [ ] **Step 5:** Commit: `git commit -m "Add a shared density option for solid space"`

### Task 4: Camera sphere check ("Keep clear of walls")

**Files:**
- Create: `src/path/clearance.ts`
- Modify: `src/path/nav-grid.ts` (expose `clearance`, `sphereFree`; `lineFree` uses `sphereFree`), `src/path/curve-check.ts` (use `sphereFree`), `src/fix-path-events.ts` (setting `keepClear`), `src/ui/fix-path-controls.ts`, locales
- Test: `test/nav-doors.mjs`, `test/fix-path.mjs`

**Interfaces:**
- Produces: `pointClearance(occupied: (ix, iy, iz) => boolean, voxel: number, p: Vec3Like, maxVoxels = 1): number` — distance from p to the nearest occupied voxel box within `maxVoxels` voxels per axis of p's voxel (0 inside one), `Infinity` when none.
- Produces on `NavGrid`: `clearance(p: Vec3Like): number` (scene units, `maxVoxels = 1`), `sphereFree(p: Vec3Like): boolean` = `clearance(p) >= radius` where radius comes from a new trailing `buildNavGrid(..., cameraRadius = 0)` parameter in voxels; radius 0 → same as `pointFree`. `pointFree` and key "inside geometry" detection are unchanged.
- `CAMERA_RADIUS_VOXELS = 0.4` exported from `clearance.ts`. Fix Path setting `keepClear: boolean` (default false) in `path.settings` / `path.setSettings`, reset on `scene.clear`; when on, `defaultSceneGrid` builds the grid with `CAMERA_RADIUS_VOXELS`.
- UI: checkbox "Keep clear of walls (new)" in the gear; i18n `fix-path.keep-clear`, `tooltip.fix-path.keep-clear` ("Treat the camera as a small ball so the path doesn't graze walls and door frames").

- [ ] **Step 1: Failing tests:**
  - `pointClearance` against brute force on a 3×3×3 neighbourhood (point inside occupied voxel → 0; point 0.3 voxel from a face → 0.3·v).
  - Curve passing 0.2 voxel from a wall: `checkCurve` reports the segment with `cameraRadius = 0.4`, not with 0.
  - 0.9 m door (eye 1.6) in `nav-doors.mjs` scene: route found and curve free with radius 0.4, at both grid alignments the test scene offers (door shifted by half a voxel).
  - A user key 0.1 voxel from a wall: not reported blocked (skip radius).
  - `scene.clear` resets `keepClear`.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → pass; locales lint passes.
- [ ] **Step 5:** Commit: `git commit -m "Check the camera curve as a small sphere when keeping clear of walls"`

### Task 5: Look-ahead on detour keys

**Files:**
- Modify: `src/path/detours.ts` (`detourPoses`, `assemble`, `planDetours` input), `src/path/fix-plan.ts`, `src/fix-path-events.ts` (setting `lookAhead`), `src/ui/fix-path-controls.ts`, locales
- Test: `test/fix-path.mjs`

**Interfaces:**
- Produces: `type LookOptions = { ahead: number, maxOffsetDeg: number, ease: number, narrow?: (p: Vec3Like) => boolean }`. `detourPoses(route, from, to, eyeHeight, look?: LookOptions)`; without `look` the current rule (eyeHeight ahead, ease into `to` over 2 eye heights) is unchanged.
- With `look`: the view looks at the route point `ahead` further on; it is clamped to within `maxOffsetDeg` of the local travel direction (route tangent at the pose); within `ease` of `from` it slerps from `from`'s view to that direction, within `ease` of `to` towards `to`'s view (as now); where `narrow(p)` is true the view is the travel direction and no easing applies. Target distance and fov as now.
- `DetourInput.look?: LookOptions`, `FixPlanInput.look?: { enabled: boolean }`. `planFixPath` computes `ahead = clamp(2 s · speed, eyeHeight, 4 · eyeHeight)` with `speed = Σ route lengths of the ordered segments / ((timeline.frames − Σ linger frames) / frameRate)`, `maxOffsetDeg = 35`, `ease = 2 · eyeHeight`, `narrow = p => grid.clearance(p) < grid.voxel`.
- Fix Path setting `lookAhead: boolean` (default false), reset on `scene.clear`. UI checkbox "Look ahead (new)"; i18n `fix-path.look-ahead`, `tooltip.fix-path.look-ahead` ("Detours look where the camera is going and face forward through doors").

- [ ] **Step 1: Failing tests:**
  - L-shaped route, `look` given: every interior pose's view is within 35° (+1e-6) of the route tangent outside the two ease zones.
  - A pose where `narrow` is true looks along the tangent (angle < 1e-6).
  - `to` looks exactly backwards along travel: all directions finite and unit length.
  - Without `look`, output equals the current output for the same route (regression).
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → pass.
- [ ] **Step 5:** Commit: `git commit -m "Let detour keys look ahead along the path"`

### Task 6: Turn cap and motion stats in Balance timing

**Files:**
- Modify: `src/anim/balance-timing.ts`
- Test: `test/balance-timing.mjs`

**Interfaces:**
- `BalanceInput.maxTurnDegPerSec?: number` (undefined → no cap; existing tests unchanged).
- `BalanceResult` ok branch gains `stats: { pathLength: number, avgSpeed: number, peakSpeed: number, peakTurnDegPerSec: number }` (speeds in scene units per second over moving time, from the sampled final spline) and `turnLimited?: number` (the peak °/s left when the cap could not be met).
- Algorithm inside the existing iteration: per segment measure the peak view-direction rate over its samples (angle between consecutive sampled `target − position` directions / sample time); a segment above the cap needs `duration · peak / cap` frames; give capped segments their minimum and split the rest of `available` over the others by cost (repeat until no new segment hits its minimum). If the minimums exceed `available`, scale all minimums to fit and set `turnLimited` from the final spline. Lingers and boundary rounding as now.

- [ ] **Step 1: Failing tests:**
  - Three keys, second turns the view 180° over a short move, frames 240 at 30 fps, cap 20: final peak turn ≤ 20 · 1.05 °/s and `turnLimited` undefined.
  - Same keys, frames 30: ok, `turnLimited` > 20.
  - Loop on, closing segment holds the big turn: its peak ≤ 21 °/s.
  - `stats.pathLength` of two keys 10 apart on a straight line ≈ 10 (±1%).
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → pass (existing balance tests unchanged).
- [ ] **Step 5:** Commit: `git commit -m "Cap turn speed in Balance timing and report motion stats"`

### Task 7: Turn cap on by default, speed readout and warning

**Files:**
- Create: `src/ui/status-line.ts` (the floating status label now inside `fix-path-controls.ts`, moved and shared)
- Modify: `src/timing-events.ts` (`timelineSettings` adds `maxTurnDegPerSec: 20`), `src/path/markers.ts` (`fixReport` lines), `src/ui/fix-path-controls.ts`, `src/ui/balance-controls.ts`, locales
- Test: `test/path-markers.mjs`, `test/timing-events.mjs`

**Interfaces:**
- Consumes: `stats`, `turnLimited` (Task 6).
- `MAX_TURN_DEG_PER_SEC = 20` in `timing-events.ts`.
- `motionLine(stats, turnLimited: number | undefined, metric: boolean): ReportLine[]` in `markers.ts`: `timing.speed` ("Speed: avg {{avg}} {{unit}}/s, peak {{peak}} {{unit}}/s, fastest turn {{turn}}°/s"), plus `timing.turn-limited` ("Too few frames to keep turns below {{cap}}°/s; fastest turn {{turn}}°/s. Increase Total Frames for a calmer shot.") when `turnLimited` is set. Units `fix-path.unit-metres` / `fix-path.unit-scene`; metric from `looksMetric(candidates.lastSettings.box)` when present, else scene units.
- Balance shows the lines in the shared status line after success; with `turnLimited` it shows an info popup instead. Fix Path appends the lines to its status, and `turnLimited` turns its report into `info`.

- [ ] **Step 1: Failing tests:** `fixReport` with `balance.turnLimited = 34` → type `info` with a `timing.turn-limited` line; clean run → status with `fix-path.status` and `timing.speed`; `timing.balance` passes `maxTurnDegPerSec: 20` to `balanceTiming` (spy via a turn-heavy key set: result peak ≤ 21).
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement; translations.
- [ ] **Step 4:** `npm test` → pass; locales lint passes.
- [ ] **Step 5:** Commit: `git commit -m "Show camera speed after Balance and Fix Path and warn when turns stay fast"`

### Task 8: Wall-aligned candidate directions

**Files:**
- Create: `src/candidates/walls.ts`
- Modify: `src/candidates/sample.ts` (azimuths per level), `src/candidates/generate.ts` (`GenerateOptions.alignToWalls?: boolean`), `src/ui/candidates-setup.ts`, locales
- Test: `test/candidates.mjs`

**Interfaces:**
- Produces: `wallAngle(points: Float32Array, extents: SplatExtents, select: (x: number, y: number, z: number) => boolean): number | null` — degrees in [0, 90) in the azimuth convention of `sample.ts` (0 looks along −Z). Uses opaque splats passing `select` whose smallest 2σ radius < 0.3 × middle (flat) and whose normal (axis of the smallest radius) has |y| < 0.2 (vertical). Hübner et al. 2021: fold normal azimuths mod 90° into 1° bins weighted by `r_large · r_middle`; keep bins ≥ 0.75 × peak, cluster contiguous bins (wrap 89→0), weighted mean of the heaviest cluster, refine by weighted median within ±5°. Returns null when < 50 flat splats or when < 25% of the weight lies within ±5° of the result.
- `sampleCandidates(levels, occ, opts, azimuthsOf?: (level: number) => number[])`; default the current 8 azimuths. With `alignToWalls`, `runGeneration` passes per level `θ + k · 45` (k = 0..7) using splats with y in `[level.height, level.height + 2 · eyeHeight]` inside the level's xz bounds, falling back to the fixed azimuths when `wallAngle` is null.
- UI: checkbox "Align views to walls (new)"; i18n `candidates.align-walls`, `tooltip.candidates.align-walls` ("Point suggested views along and across the walls instead of fixed compass directions").

- [ ] **Step 1: Failing tests:** synthetic room of flat wall splats rotated 23° → `wallAngle` within 1° of 23; same room plus 30% random-orientation flat splats → still within 2°; only floor splats (normals up) → null; azimuths passed through `sampleCandidates` appear in the candidates.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → pass; locales lint passes.
- [ ] **Step 5:** Commit: `git commit -m "Option to align suggested views to the walls"`

### Task 9: Openness score for candidates

**Files:**
- Create: `src/candidates/isovist.ts`
- Modify: `src/candidates/score.ts` (`candidateScore` takes an optional openness term), `src/candidates/generate.ts` (`GenerateOptions.preferOpen?: boolean`), `src/ui/candidates-setup.ts`, locales
- Test: `test/candidates.mjs`

**Interfaces:**
- Produces: `isovist(occ: Occupancy, p: Vec3Like, maxDist: number, rays = 72): Float32Array` — free distance per horizontal ray (ray k at azimuth `k · 360 / rays`, same convention as `sample.ts`), marched in steps of `occ.voxel / 2`, capped at `maxDist`.
- `opennessOf(rays: Float32Array, maxDist: number, azimuth: number, hfovDeg: number): number` in [0, 1] = `0.5 · sqrt(area / (π · maxDist²)) + 0.5 · mean(rays within ±hfov/2 of azimuth) / maxDist`, area = `½ Σ r² Δφ`.
- `candidateScore(m, pitch, openness?: number)` adds `PREFER_OPEN_WEIGHT · openness` (`PREFER_OPEN_WEIGHT = 0.3`, exported, tuned in the comparison) when given. `maxDist = 10 · eyeHeight`; the isovist is computed once per candidate position before rendering.
- UI: checkbox "Prefer open views (new)"; i18n `candidates.prefer-open`, `tooltip.candidates.prefer-open` ("Rank views that see more of the space higher").

- [ ] **Step 1: Failing tests:** in a closed 4 × 4 m room `isovist` rays from the centre are 2 ± 0.25 (axis) and ≈ 2.83 (diagonal); a view out of an open doorway scores higher openness than one facing the near wall; `candidateScore` without openness equals the current value.
- [ ] **Step 2:** `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → pass; locales lint passes.
- [ ] **Step 5:** Commit: `git commit -m "Option to rank candidate views by how open they are"`

### Task 10: Docs

**Files:**
- Modify: `docs/view-candidates.md`, `docs/fix-path.md`, `docs/balance-timing.md`, `README.md` (only if a guide link changes)

- [ ] **Step 1:** Add the options (one line each, what it does, that it is new and being compared), the turn cap and speed readout, the camera-radius limit (very narrow gaps), and the limit that scan holes can still look like doors. To the point, no prose.
- [ ] **Step 2:** Commit: `git commit -m "Document the new shot tool options and the turn cap"`

### Task 11 (controller, after the final review): comparison material and experiments

Not a subagent task; runs on committed code, recorded in `/Volumes/T7 Shield/Temp/supersplat/research-fixes/` with the commit hash, metrics to wandb (project `supersplat-view-candidates`).

- [ ] Timing: courtyard Fix Path (~20 keys) and Suggest Views with each option on/off; density read/build time on hall and courtyard.
- [ ] Fix Path videos, same keys, before/after per option (density, keep clear, look ahead) and turn cap on/off; metrics: detours, min clearance along the curve, peak °/s, run time.
- [ ] Suggest Views grids before/after for wall alignment and openness (same seed, same box) on both scenes.
- [ ] Viewer check: splat-transform CLI collision voxels for the courtyard at eye/4 and at 0.05 m (downsampled: coarse voxel solid if any fine voxel is) vs our density grid; agreement %.
- [ ] Questionnaire page for the user with criteria: passes through geometry, grazes walls, looks into walls, turns too fast, views worth keeping.
