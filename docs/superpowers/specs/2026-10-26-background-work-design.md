# Background work with progress and Cancel — design

## Intent

The user makes client flythroughs of building scans. On their own scans, Fix Path, Orbit, Balance and opening Suggest Views freeze the editor for "a few seconds". The browser cannot draw while the work runs on the main thread, so the spinner freezes too. They want a progress bar instead of a hang, and a Cancel button.

## Measured (courtyard scan, 453 254 opaque points, this Mac, supersplat ec45dd0)

Longest freeze = largest gap between animation frames while the call runs.

| Step | Total | Longest freeze | Where |
|---|---|---|---|
| `candidates.cloud` (read opaque points from the splats) | 0.30 s | 0.31 s | main thread, CPU |
| `candidates.prepare` (area box, eye height, tilt) | 0.22 s | 0.22 s | main thread, CPU |
| `path.fix` | 0.64 s | 0.34 s | grid + routes + detours CPU; distance sampling GPU |
| `timing.balance` | 0.11 s | 0.01 s | mostly GPU distance sampling |
| `orbit.plan` (after occupancy is cached) | 0.09 s | 0.09 s | CPU |

A first Fix Path on a fresh scene pays read + estimate + fix ≈ 1.2 s here. The cold first `orbit.plan` (occupancy build) was not measured; measure it in the baseline. `readOpaquePoints` caps the cloud at 500 000 points (read-points.ts:40), so only the read grows with splat count. The estimate and grid grow with the area and the voxel count. "A few seconds" on the user's side likely comes from larger areas or a slower machine.

## Goals

- No freeze over 100 ms while Fix Path, Orbit (preview and Add), Balance or opening Suggest Views runs. Measure it as the longest gap between animation frames on the courtyard scan.
- A progress bar with the current step and a Cancel button for runs that take longer than 300 ms (`SPINNER_DELAY_MS` today).
- Cancel stops the work within 200 ms and leaves keys, timeline and undo history exactly as before. It adds no undo entry. The one exception is the last stage of Orbit Add (see decision 10).
- Results are identical to today's for the same input.

## Non-goals

- Faster algorithms. This is about responsiveness; speed-ups are welcome but not required.
- Suggest Views generation itself: it already has a counter and renders thumbnails on the GPU. Only opening the panel (read + estimate) is in scope.
- Export or render progress: it already exists.

## Anti-goals

- A progress bar that still freezes. Showing a bar and then blocking would be worse than now.
- Cancelled or superseded runs that leave half-applied keys, stray detour keys or an undo step.
- A second, different-looking progress UI next to the existing one.

## Constraints

- Browser and WebGL/WebGPU only. No SharedArrayBuffer: the app is not cross-origin isolated, so a running worker cannot be signalled mid-loop.
- The worker bundle must not pull in the PlayCanvas engine or PCUI. Pure modules only (`candidates/estimate`, `candidates/generate` grid parts, `path/*`, `orbit/*`, `anim/balance-timing` if moved). If a pure module imports engine math, replace it with the local `Vec3Like` helpers.
- No workers exist in the repo yet. `main.ts` sets `WorkerQueue.maxWorkers = 0` because splat-transform's worker file is not shipped. Our worker is separate and must actually ship in `dist`.
- Keep upstream separation: new files, with small hooks in existing files.
- Node tests run without workers, so the same code must also run in-process.
- Files stay under 500 lines.

## Decided (by the user)

- Progress and Cancel for Fix Path, Orbit, Balance, and opening Suggest Views.
- Cancel leaves the keys as they were.

## Decided (my calls; the user can override)

1. **Two module workers from one bundle, `scene-compute`.**
   - **Run worker:** handles modal runs (Fix Path, Orbit Add, Balance) and the scene estimate.
   - **Preview worker:** handles Orbit preview plans only.
   - Each worker holds a copy of the scene points per points version: about 5.4 MB of points plus 12.7 MB of extents. The main thread keeps its own copy, because generation, the Orbit cache and the shared `candidates.cloud` promise need it.
   - Each worker runs the CPU stages: scene estimate, `buildSceneGrid` + `buildNavGrid`, `planFixPath` (which already includes `balanceTiming` via `retime`), orbit `fitRadius`/`arcBlocked`/curve check, and any Balance step over 50 ms.
   - Caches are separate slots: the Fix Path grid and the Orbit occupancy. The Fix Path grid key includes the user key positions, because the occupancy box is `boxAroundKeys(box, positions, eyeHeight)`.
2. **Cancel terminates the run worker and starts a fresh one.** That is the only reliable way to stop a synchronous loop without SharedArrayBuffer. Its caches are lost, so the next run pays again. This is acceptable. The preview worker is never terminated (see 5). Only one modal run happens at a time, because the dialog blocks input, so a Cancel kills nothing else. If a Suggest Views estimate was waiting on the run worker, it is re-sent to the fresh worker.
3. **Main-thread stages yield.** Reading points from the splats (needs splat data and the transform palette) and GPU distance sampling stay on the main thread. They yield to the browser between chunks and check the cancel signal there. Applying keys (`track.replacePath`) stays as it is; it is fast.
4. **Progress UI: reuse the existing Progress dialog** (`src/ui/progress.ts`, `progressStart/Update/End`). Export and publish use it without Cancel; `render.video` shows Cancel via `cancellable` (render.ts:346). Cancel fires the global `progressCancel` (ui/editor.ts:433), which the progress handle owns while its run is active. `progressStart` raises the EditorAPI busy counter (editor-session.ts:69), and the handle must balance it with `progressEnd` on every path. Modal runs **block input from the first millisecond**: an invisible blocker goes up at once, and the visible dialog only after 300 ms, so shorter runs show nothing. As a second guard, the staleness check widens to key positions, targets, fov, timeline settings and path settings, and fails with `keysChanged`. Today `snapshotOf` compares only `name@frame`. The text names the step, e.g. "Building the walkable grid", "Finding routes 3/12", "Placing detours 5/9", "Measuring views". The bar is determinate where a stage knows its total, otherwise it pulses.
5. **Orbit popover preview is not modal.** It runs on the preview worker, because the preview re-plans on every change of radius, height or span. While planning, the popover shows "Checking…" next to the preview. The worker keeps at most one queued request, the newest; older queued ones are dropped, and a result that is stale on arrival is dropped too. The worker is never terminated for superseding, so a slow occupancy build still finishes and stays cached. Orbit **Add** uses the modal dialog on the run worker.
6. **Opening Suggest Views:** the panel opens at once with "Reading the scene…" and a bar inside the panel. Area and eye height fill in when ready. Generate stays disabled until then. No modal dialog. **Closing the panel is the Cancel:** the panel detaches from the result and does not abort the shared `candidates.cloud` read or estimate, which Fix Path and Orbit reuse.
7. **Fallback:** if the worker cannot start, or a run fails inside it, the same code runs in-process. This is today's behaviour with yields between stages. It logs one `console.warn`.
8. **Progress reporting from pure code:** stages take an optional `onProgress(stage, done, total)` callback and stay synchronous. In the worker, the callback posts a message at most every 50 ms. Pure functions keep their signatures plus that optional argument, so existing tests stand.
9. **Other cold paths:** reading points and the estimate become non-blocking for every caller. Opening the Fix Path popover (`path.eyeHeight`) and the Orbit popover (`orbit.defaults`) then shows "Estimating…" in place of the values until ready. No dialog and no Cancel; closing the popover detaches. `views.addKeys` (Add as Keys) uses `appendAndBalance` like Orbit Add and gets the same modal handling.
10. **Orbit Add after its keys are applied:** Cancel is offered until `appendAndBalance` commits. After that, the curve check runs with the Cancel button hidden and the text "Checking the orbit…". It is short, and cancelling it would mean undoing a committed step.

## Data flow (Fix Path)

1. Main: snapshot of keys (existing `snapshotOf`), start the progress handle (300 ms delay).
2. Main: `candidates.cloud` (yielding read) → points version. Send to the worker if it doesn't have that version yet.
3. Worker: estimate (if not cached) → grid (if not cached) → reply.
4. Main: GPU distance sampling (existing `camera.sampleDistances`, yielding between batches).
5. Worker: `planFixPath` with progress → plan. Keys are matched by index across `postMessage`, not by object identity (fix-plan.ts:126 and fix-path-events.ts:186-189 use identity today). The worker returns key indices, and main maps them back. The `route` option and the closure-based fake grids in tests only work inline, so tests keep using `InlineSceneCompute`.
6. Main: if the widened snapshot changed → existing `keysChanged` failure. If cancelled → resolve `{ ok: false, reason: 'cancelled' }` and change nothing. Else apply as today (one undo step), set markers, end progress.

Orbit, Balance and the Suggest Views opening follow the same shape with fewer stages.

## Interfaces (sketch, the builder may refine)

- `src/compute/scene-compute.ts`: `SceneCompute` with `estimate(version)`, `sceneGrid(version, params)`, `planFixPath(input)`, `orbitPlan(input)` …. Each takes `{ signal?: AbortSignal, onProgress? }` and returns a promise. Two implementations: `WorkerSceneCompute` (browser) and `InlineSceneCompute` (tests, fallback).
- `src/compute/scene-compute-worker.ts`: the worker entry; message protocol `{ id, op, args }` → `{ id, progress }` / `{ id, result }` / `{ id, error }`.
- `src/compute/progress-handle.ts`: wraps `progressStart/Update/End` with the 300 ms delay and the Cancel → `AbortController` link.
- A new result reason `'cancelled'` for `path.fix`, `orbit.add`, `views.addKeys` and `timing.balance`. The UI shows no error popup for it, only a short status line ("Cancelled").
- `rollup.config.mjs`: a second input for the worker, emitted next to `index.js`, loaded with `new Worker(new URL('./scene-compute-worker.js', import.meta.url), { type: 'module' })`.

## Done when

- On the courtyard scan, cold (fresh load) and warm: Fix Path, Orbit Add, Orbit preview changes (including the cold first preview), Balance, Add as Keys, and opening Suggest Views and the Fix Path / Orbit popovers each keep the longest frame gap under 100 ms. Measure with the rAF gap method in `/Volumes/T7 Shield/Temp/supersplat/key-editing/` and record before/after with commit hashes.
- Cancel during each run leaves `camera.poses`, timeline settings and the undo stack unchanged. Tests cover this with the inline implementation and an abort at each stage.
- Fix Path and Orbit results from the worker equal the inline results for the courtyard replay keys. Compare the key positions, frames and markers.
- `npm test`, `npm run lint`, `npm run lint:locales` and `npm run build` pass. `dist` contains the worker file, and the deployed `pages` build loads it from its sub-path (`BASE_HREF`).
- New user-facing strings exist in all nine locales.
- `docs/fix-path.md`, `docs/orbit.md`, `docs/balance-timing.md` and `docs/view-candidates.md` mention the progress bar and Cancel in one line each.

## Left to the builder

- The exact stage list and labels, and where inside `planFixPath` / key routes the progress callback fires.
- Whether Balance's CPU part is worth moving. Profile first; leave it inline if under 50 ms on the courtyard.
- How points versions are identified. A counter bumped where `candidate-events` invalidates `points` is enough.
- Message batching, transfer lists and error mapping.
