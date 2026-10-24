# View Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate candidate camera views from the loaded splats, show them in a side panel, and turn picked views into balanced camera keys.

**Architecture:** Pure modules under `src/candidates/` (voxel occupancy, level detection, sampling, estimates, scoring) are unit-tested in Node. `src/candidate-events.ts` orchestrates point readback, pre-render rejection, offscreen thumbnails and scoring in the browser. `src/view-keys.ts` adds picks as keys plus a Balance pass in one undo step. UI lives in two new files under `src/ui/`.

**Tech Stack:** TypeScript, PlayCanvas engine, @playcanvas/pcui, i18next locales, Node test harness (`npm test`, tsc-emitted `test/.build`).

**Spec:** `docs/superpowers/specs/2026-10-23-view-candidates-design.md`

## Global Constraints

- Splat file only: never read `cameras.json`, source photos or capture poses; no "origin = first camera" assumptions.
- World up is +Y in editor world space; read positions through each splat's `worldTransform` so the user's orientation is respected. No rescale or reorientation of the scene.
- Opaque splats: sigmoid(opacity) > 0.5. Occupied voxel: ≥ 2 splat centres. Skip deleted and hidden instances (instance state flags) and hidden layers.
- Voxel size = eye height / 2 (spike: 0.8 at 1.6). Head clearance = 3 voxels. Minimum level area = 20 m² at eye height 1.6, i.e. `minArea = 20 * (eyeHeight / 1.6)²` in scene units.
- Directions: azimuths every 45° (8), pitches {0°, +10°, −15°}, no roll. Fov = current camera fov (`camera.fov`).
- Candidates per level proportional to level area; default total budget 240.
- Thumbnails 320×200. Panel first page: 40 candidates, "show more" adds 40.
- Picked keys: target placed along the view direction at the candidate's median depth (`camera.sampleDistances`), fov = candidate fov.
- Adding picks: one undo step; keys appended after existing ones in pick order; `timeline.frames` unchanged; balanced. If Balance fails: compress existing key frames proportionally and space new keys evenly at the end, then show the Balance failure message.
- Candidates are session-only (not serialized).
- Every new file < 500 lines. Do not grow `src/camera.ts` or `src/editor.ts` by more than ~20 lines each.
- All UI strings via i18n in all 9 `static/locales/*.json` with real translations; `npm run lint:locales` passes.
- Comments describe code, not history. Tests short and fast (no rendering in Node tests).
- Performance target: ~240 candidates in well under 60 s on the two test scenes; log `candidates.generate: N rendered in X ms` via `console.debug`.

## Review Focus

1. Scene where no level is found (single object scan, tiny scene, box excluding everything): generation ends with a clear message, no crash, viewport camera restored.
2. Cancel or error mid-generation: viewport leaves offscreen mode, the user's camera pose and fov are restored, already rendered candidates stay in the panel.
3. Keys edited while picks are being added (distance sampling is async): abort with the existing `popup.balance.keysChanged` message, no partial edit.
4. Several splat layers, one hidden or rotated: hidden layers ignored, rotated layer's points used in world space.
5. Undo after "Add N as keys": restores the exact previous keys (frames, names, lingers) in one step.

---

### Task 1: Voxel occupancy and level detection

**Files:**
- Create: `src/candidates/occupancy.ts`, `src/candidates/levels.ts`
- Test: `test/candidates.mjs` (register `candidatesChecks` in `test/queue-ordering.mjs`)

**Interfaces:**
- Produces:
  - `type Occupancy = { voxel: number, occupied(ix: number, iy: number, iz: number): boolean, isFree(p: Vec3Like, radiusVoxels?: number): boolean, cells(): Iterable<[number, number, number]> }`
  - `buildOccupancy(points: Float32Array /* xyz world, y up */, voxel: number, minCount = 2): Occupancy`
  - `type Level = { cells: [number, number, number][] /* ix, iy (surface voxel), iz */, area: number, height: number /* median surface y, world */ }`
  - `findLevels(occ: Occupancy, headVoxels: number, minArea: number): Level[]` sorted by area, descending.
  - `type Vec3Like = { x: number, y: number, z: number }` exported from `occupancy.ts`.

- [ ] **Step 1: Write failing checks in `test/candidates.mjs`**

```js
// helpers: plane(y, x0, x1, z0, z1, step) returns Float32Array of points, 2 per grid point
'candidates: lone splats are not occupied'        // 1 point in a voxel -> occupied() false
'candidates: isFree false next to a wall'           // wall plane x=0; isFree({x:0.3,y:1,z:0}) false, isFree({x:3,y:1,z:0}) true (voxel 0.8)
'candidates: two stacked floors give two levels'    // floors y=0 and y=4, 10x10 m each -> findLevels(occ, 3, 20).length === 2, heights ≈ [0,4] ±0.8
'candidates: small table is not a level'            // floor 10x10 + table 1x1 at y=0.8 -> 1 level
'candidates: low ceiling removes the level'         // floor y=0, ceiling y=1.6 -> 0 levels (head clearance 3 voxels of 0.8)
'candidates: one-voxel step stays one level'        // floor y=0 for x<5, y=0.8 for x>=5 -> 1 level
```

- [ ] **Step 2: Run `npm test`** — Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Integer voxel keys packed into a number or string map; levels = 4-neighbour flood fill over surface voxels allowing dz in {−1,0,1}; `area = cells × voxel²`.
- [ ] **Step 4: Run `npm test`** — Expected: new checks PASS, the known pre-existing failure `resized picks retain temporary buffers…` unchanged.
- [ ] **Step 5: Commit** `git commit -m "Detect free space and standable levels from splat centres"`

### Task 2: Estimates and candidate sampling

**Files:**
- Create: `src/candidates/estimate.ts`, `src/candidates/sample.ts`
- Test: `test/candidates.mjs`

**Interfaces:**
- Consumes: Task 1 `Occupancy`, `Level`, `Vec3Like`.
- Produces:
  - `type Box = { min: Vec3Like, max: Vec3Like }`
  - `proposeBox(points: Float32Array): Box` — per-axis 3rd–97th percentile.
  - `estimateTiltDeg(points: Float32Array): number` — angle between +Y and the smallest-variance PCA axis of points within the box, folded to [0, 90].
  - `estimateEyeHeight(points: Float32Array, box: Box): number` — 1.6 if the box's horizontal extent is 5–500 and vertical 2–100 (looks metric); otherwise 0.55 × median vertical gap between the two largest density peaks of y (storey height), fallback 0.08 × vertical extent.
  - `type Candidate = { id: string, level: number, position: Vec3Like, direction: Vec3Like, azimuth: number, pitch: number, fov: number }`
  - `sampleCandidates(levels: Level[], occ: Occupancy, opts: { eyeHeight: number, box: Box, fov: number, budget: number, seed: number }): Candidate[]`

- [ ] **Step 1: Failing checks**

```js
'candidates: proposeBox ignores 2% outliers'       // 1000 pts in unit cube + 10 at 1e3 -> max.x < 2
'candidates: tilt of a level floor is ~0'           // plane y=0 -> < 2°; same plane rotated 15° about x -> 15 ± 2
'candidates: metric scene gets eye height 1.6'      // two floors 20x20 m at y=0 and y=4 -> 1.6
'candidates: unitless room scales eye height'      // floor y=0, ceiling y=0.5, extent 2 -> between 0.1 and 0.3
'candidates: budget split by level area'            // levels 300 m² and 100 m², budget 240 -> 180 ± 8 and 60 ± 8
'candidates: positions are free and inside box'     // every c.position: occ.isFree(c.position) && inside box; y = level.height + voxel + eyeHeight ± voxel
'candidates: same seed gives same candidates'       // deep equal
```

- [ ] **Step 2: Run `npm test`** — FAIL.
- [ ] **Step 3: Implement.** Deterministic RNG (mulberry32) from `seed`; directions from azimuth/pitch with y up; ids `c000…`.
- [ ] **Step 4: Run `npm test`** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Estimate box, tilt and eye height; sample candidates per level"`

### Task 3: Scoring and diversity

**Files:**
- Create: `src/candidates/score.ts`
- Test: `test/candidates.mjs`

**Interfaces:**
- Produces:
  - `imageMetrics(rgba: Uint8Array, width: number, height: number): { blur: number, dark: number }` — port of `viewspike/score.py`: grey, 4-neighbour Laplacian magnitude, 18×12 tiles, `blur` = fraction of tiles with mean < 2.0, `dark` = fraction of pixels with grey < 12.
  - `rejectBeforeRender(depth: number | null, eyeHeight: number): boolean` — true if `depth === null` or `depth < 1.1 * eyeHeight` (spike: 1.8 at 1.6).
  - `candidateScore(m: { blur: number, dark: number }, pitch: number): number` — `(1 - blur) - 2 * dark - (0 < |pitch| < 30 ? 0.15 : 0)`.
  - `type Scored = Candidate & { score: number, depth: number }`
  - `diversify(scored: Scored[], minDistance: number, minAngleDeg = 90): Scored[]` — sorted by score desc; skip one if an already kept one is within `minDistance` (3D) and within `minAngleDeg` azimuth.

- [ ] **Step 1: Failing checks**

```js
'candidates: flat grey image is all blur'           // 320x200 uniform 128 -> blur 1, dark 0
'candidates: checkerboard has no blur'             // 8px checker -> blur 0
'candidates: black image is all dark'              // dark 1
'candidates: no hit or near wall rejected'          // rejectBeforeRender(null,1.6) true; (1.0,1.6) true; (5,1.6) false
'candidates: diversify drops near duplicates'       // two candidates 0.1 apart same azimuth -> 1 kept; same spot azimuth 180 apart -> 2 kept
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** `git commit -m "Score candidate thumbnails and remove near duplicates"`

### Task 4: Adding picks as balanced keys

**Files:**
- Create: `src/view-keys.ts`
- Modify: `src/camera-poses.ts` (add `appendPoses`), `src/track-manager.ts` (event), `src/timing-events.ts` (extract shared balance input), `src/main.ts` (register)
- Test: `test/camera-track.mjs`, `test/timing-events.mjs`

**Interfaces:**
- Consumes: `balanceTiming` (`src/anim/balance-timing.ts`), `camera.sampleDistances`, `trackEdit`.
- Produces:
  - `CameraAnimTrack.appendPoses(poses: { position: Vec3, target: Vec3, fov: number }[], frames: number[]): boolean` — `frames` covers existing keys (sorted by frame) followed by the new poses; new names unique (`camera_N`, N above any used index); returns false on length mismatch or non-increasing frames.
  - Event `track.appendPoses(poses, frames)` via `trackEdit('appendPoses', …)`.
  - `fallbackAppendFrames(existing: number[], added: number, frames: number): number[]` — existing scaled into `[0, frames-1-added*gap]`, new keys evenly in the rest; strictly increasing, ≥ 1 frame apart; pure, exported from `src/view-keys.ts`.
  - `events.function('views.addKeys', async (views: { position: Vec3Like, direction: Vec3Like, fov: number, depth: number }[]) => BalanceResult)`; registered by `registerViewKeyEvents(events)`.
  - From `src/timing-events.ts`: `computeBalance(events, poses: BalanceSource[]): Promise<{ result: BalanceResult, changed: boolean }>` where `BalanceSource = { position, target, fov, linger }`; `timing.balance` uses it unchanged in behaviour.

- [ ] **Step 1: Failing checks**

```js
'track: appendPoses adds keys and retimes in one undo step'  // 2 keys + 2 new -> 4 keys, ops.length 1, undo -> original frames and names
'track: appendPoses rejects non-increasing frames'          // returns false, no op
'views: fallback compresses existing and spaces new keys'   // fallbackAppendFrames([0,90,180],2,181) strictly increasing, last <= 180, first 0
'views: addKeys balances over all keys'                     // fake sampleDistances -> all 1; result.ok; keys count +N; one edit op
'views: addKeys aborts when keys change during sampling'    // sampleDistances resolves after a track.addKey -> reason keysChanged, no appendPoses op
'views: addKeys falls back when balance refuses'            // linger too long -> keys still added via fallback, popup shown with lingerTooLong
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS. Target = `position + direction * depth`.
- [ ] **Step 5: Commit** `git commit -m "Add picked views as keys and balance them in one undo step"`

### Task 5: Generation pipeline

**Files:**
- Create: `src/candidates/read-points.ts`, `src/candidate-events.ts`
- Modify: `src/main.ts` (register), at most ~20 lines in `src/editor.ts` / `src/camera.ts` if a helper is missing.
- Test: `test/candidates.mjs` (orchestrator with fakes)

**Interfaces:**
- Consumes: Tasks 1–3; `render.offscreen(width, height)`; `camera.setPose`; `camera.getPose`; `camera.sampleDistances`; `camera.fov`.
- Produces:
  - `readOpaquePoints(splats: Splat[], maxPoints = 500000): Promise<Float32Array>` — reads `splat.resource.source` chunks like `filteredIndices` in `src/splat-serialize.ts` (position: 3 floats/row; geometric: 8 floats/row, opacity logit at index 7), skips deleted/hidden instances, transforms by `splat.worldTransform`, uniform subsample to `maxPoints`.
  - `type GenerateOptions = { box: Box, eyeHeight: number, budget: number, seed: number }`
  - `events.function('candidates.prepare', async () => { box: Box, eyeHeight: number, tiltDeg: number, points: number })` — reads points once, caches them for the session.
  - `events.function('candidates.generate', async (opts: GenerateOptions, signal: AbortSignal) => Scored[])` — fires `candidates.progress(done, total)` and `candidates.added(scored: Scored, thumbnail: ImageBitmap | HTMLCanvasElement)` per rendered candidate; on finish fires `candidates.done(count, reason?: 'noLevels' | 'cancelled')`.
  - Pipeline: points filtered to `opts.box` → occupancy (voxel = eyeHeight / 2) → levels (`noLevels` if none) → sample → batch `camera.sampleDistances` → `rejectBeforeRender` → for each kept: set pose instantly, `render.offscreen(320, 200)`, `imageMetrics`, score → after all: `diversify` order. Always restores the user's pose and fov in `finally`.
  - `runGeneration(deps, opts, signal)` — the orchestrator as a pure-ish function taking `deps = { sampleDistances, renderAt, onProgress, onAdded }` so Node checks can fake rendering.

- [ ] **Step 1: Failing checks**

```js
'candidates: generation reports noLevels on an empty scene'      // deps with points = sparse noise -> done reason noLevels, renderAt never called
'candidates: rejected candidates are never rendered'            // sampleDistances returns null for half -> renderAt calls == kept count
'candidates: cancel stops rendering and keeps results'          // abort after 3 renders -> onAdded called 3 times, reason cancelled
'candidates: camera restored after render error'                // renderAt throws on 2nd -> restore called once, error propagates
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Manual check in the browser** on `/Users/philipp/Downloads/artnouveau_point_cloud_29999.ply` (`npm run build`, `npx serve dist -C`, load via `?load=`): call `scene.events.invoke('candidates.generate', …)` from the console; note the `console.debug` timing line. Review Focus 4: duplicate the layer, rotate one copy 90° and hide the other; `candidates.prepare` box must follow the rotated copy and ignore the hidden one.
- [ ] **Step 6: Commit** `git commit -m "Generate, filter and score view candidates offscreen"`

### Task 6: Setup and candidates panel UI

**Files:**
- Create: `src/ui/candidates-setup.ts`, `src/ui/candidates-panel.ts`, `src/ui/scss/candidates-panel.scss`
- Modify: entry button next to the timeline settings group (`src/ui/timeline-panel.ts`, append only), `src/ui/editor.ts` (mount panel), `static/locales/*.json` (9 files)

**Interfaces:**
- Consumes: `candidates.prepare`, `candidates.generate`, `candidates.progress`, `candidates.added`, `candidates.done`, `views.addKeys`, `BoxShape` + `ShapeTransformGizmo` (`src/tools/box-selection.ts` pattern).
- Produces: UI only.

Behaviour:
- "Suggest views" button opens setup: area box gizmo (from `candidates.prepare`), eye height `NumericInput` (min 0.01) with live preview (viewport camera moves to the largest level centre at that height, restored on close), tilt warning row if `tiltDeg > 10`, Generate.
- Panel (layout A): right side, 2-column grid, widen toggle to 4 columns; inline progress bar + Cancel; thumbnails appear on `candidates.added`, re-sorted by score on `candidates.done`; first 40 then "Show more" (+40); level filter (All / Level 1…n by height); hover = instant `camera.setPose` preview, restore on leave; click toggles pick (orange border, pick order number); "Add N as keys" → `views.addKeys(picks)`; empty result shows `candidates.noLevels` text.
- Follow existing pcui patterns (`src/ui/key-linger-popover.ts`, `src/ui/balance-controls.ts`); check Blender asset browser / Lightroom grid for hover and selection conventions.

- [ ] **Step 1:** Build (`npm run build`) and lint (`npm run lint`, `npm run lint:locales`) pass.
- [ ] **Step 2:** Screenshots for the user's UX review (Playwright, both test scenes): setup with box and eye height, panel during generation, panel with picks, after adding keys (timeline). Save to the scratchpad `ux-screens/candidates-*.png`.
- [ ] **Step 3: Commit** `git commit -m "Add view candidates setup and panel"`

### Task 7: Docs, measurement and blind test

**Files:**
- Create: `docs/view-candidates.md` (user guide, bullet style like `docs/balance-timing.md`)
- Modify: `README.md` "Guides:" line
- Experiment record: `/Volumes/T7 Shield/Temp/supersplat/view-candidates/` (separate git repo, commit hash of this branch)

- [ ] **Step 1:** Write the guide and README link; commit `git commit -m "Document view candidates"`.
- [ ] **Step 2:** On committed code, measure generation time on both scenes (art nouveau hall; `/Volumes/T7 Shield/hslu/Scan_2/point_cloud_6.ply`); log to wandb with the commit hash.
- [ ] **Step 3:** Blind test per scene: 20 candidates ranked just above and 20 just below rank 40, shuffled, keep/drop page as in the spike; user marks; record agreement in the experiment repo and wandb.
- [ ] **Step 4:** Copy the spike record (`viewspike/NOTES.md`, scripts) to `/Volumes/T7 Shield/Temp/supersplat/view-selection-spike/` and commit there.
