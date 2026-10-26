# Background Work with Progress and Cancel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Path, Orbit, Balance, Add as Keys and opening Suggest Views stop freezing the editor. Modal runs show the existing progress dialog with a Cancel button.

**Architecture:** One module worker (`scene-compute`) runs the pure CPU stages: estimate, grid, Fix Path plan, orbit plan/check, balance. It runs behind a small client that the main thread talks to. Tests and the fallback use an inline transport that runs the same handler with structured-cloned messages. Main-thread work yields. A progress handle wraps the existing `progressStart/Update/End` dialog: it blocks input at once, reveals the dialog after 300 ms, and turns Cancel into an `AbortSignal`.

**Tech Stack:** TypeScript, PlayCanvas, PCUI, Rollup (ESM), Node test harness (`npm test`, no framework, checks in `test/*.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-26-background-work-design.md`

## Global Constraints

- No freeze over 100 ms (longest rAF gap) for the listed runs on the courtyard scan, cold and warm.
- The dialog appears only for runs over 300 ms. Input is blocked from the first millisecond of a modal run.
- Cancel stops within 200 ms. It leaves `camera.poses`, timeline settings and the undo stack unchanged and adds no undo entry. The exception is Orbit Add after `appendAndBalance` commits, where Cancel is hidden.
- One worker; the worker bundle imports no `playcanvas` and no `@playcanvas/pcui`. A check at the start of Task 1 confirmed this: the 22 files reachable from estimate/generate/fix-plan/nav-grid/orbit-path/curve-check/camera-curve/balance-timing have no external imports.
- The worker holds one copy of the thinned points (≤ 500 000 points from `readOpaquePoints`). No SharedArrayBuffer.
- Fallback: if the worker cannot start or errors, the same handler runs inline and logs one `console.warn`.
- New user-facing strings go in all nine locales (`static/locales/*.json`, same key order; `npm run lint:locales`).
- New code lives in `src/compute/`, with only small hooks in upstream files (`src/ui/editor.ts`, `src/ui/progress.ts`, `src/ui/scss/progress.scss`, `rollup.config.mjs`, `src/main.ts`).
- Files stay under 500 lines. Comments describe code, not history.
- Run `npm test`, `npm run lint`, `npm run lint:locales` and `npm run build` before each commit.

## Review Focus

1. **Cancel after the worker replied but before the keys are applied.** Nothing is applied and the result is `cancelled`. Test in Task 4.
2. **A job throws inside the worker.** The run rejects with the job's message, the error popup shows as today, and `progressEnd` fires exactly once, so the EditorAPI busy counter returns to 0. Tests in Task 2 and Task 4.
3. **Fix Path cancelled while a Suggest Views estimate is pending on the worker.** The estimate is re-sent to the fresh worker and still resolves. Test in Task 2.
4. **Fast slider drags in the Orbit popover.** Only the newest preview request is computed, stale ones reject as superseded, and the worker is never restarted for that. Test in Task 2.
5. **Keys or timeline changed between start and apply.** A moved key position, smoothness, loop or frames change fails with `keysChanged` and applies nothing. Today only `name@frame` counts. Test in Task 4.

---

### Task 1: Compute protocol, jobs and handler (pure, Node-testable)

**Files:**
- Create: `src/compute/protocol.ts` — message and op types.
- Create: `src/compute/fix-path-job.ts` — grid cache + `planFixPath` call + key-index mapping.
- Create: `src/compute/orbit-job.ts` — occupancy cache, orbit plan and curve check, moved from `src/orbit-events.ts` (`sanitise`, `diagonal`, the body of `plan`, and the occupancy part of `checkOrbitCurve`).
- Create: `src/compute/handler.ts` — `createComputeHandler()`.
- Modify: `src/path/key-graph.ts:112` (`keyRoutes`), `src/path/detours.ts:241` (`planDetours`), `src/path/fix-plan.ts:80` (`planFixPath`) — optional `onProgress`.
- Test: `test/compute-handler.mjs` (register in `test/queue-ordering.mjs` like the other check files).

**Interfaces:**
- Produces (`protocol.ts`):
  ```ts
  type Stage = 'reading' | 'estimate' | 'grid' | 'routes' | 'detours' | 'timing' | 'measuring' | 'orbit' | 'checking';
  type ProgressFn = (stage: Stage, done?: number, total?: number) => void;
  type Estimate = { box: Box, eyeHeight: number, tiltDeg: number, points: number };
  type FixPlanRequest = { version: number, box: Box, eyeHeight: number, opening: number, allowFlying: boolean,
      positions: Vec3Like[], keys: FixKey[], keepOrder: boolean, timeline: Omit<BalanceInput, 'keys'> };
  // FixPlan with key identity replaced by the index into request.keys
  type FixPlanReply = Omit<FixPlan, 'poses'> & { poses: { pose: CurvePose, frame: number, keyIndex: number | null }[], box: Box };
  type OrbitPlanRequest = { version: number, box: Box, eyeHeight: number, spec: OrbitSpec };
  type OrbitCheckRequest = { version: number, box: Box, eyeHeight: number, poses: CurvePose[], frames: number[],
      userFrames: number[], first: number, last: number, curve: CurveOptions };
  type ComputeOps = {
      estimate: { args: { version: number }, result: Estimate },
      fixPlan: { args: FixPlanRequest, result: FixPlanReply },
      orbitPlan: { args: OrbitPlanRequest, result: OrbitPlan },
      orbitCheck: { args: OrbitCheckRequest, result: { orbitBlocked: boolean, joinBlocked: boolean } },
      balance: { args: BalanceInput, result: BalanceResult }
  };
  type Request = { id: number, op: keyof ComputeOps, args: unknown }
      | { id: number, op: 'points', args: { version: number, points: Float32Array, extents: Float32Array } };
  type Reply = { id: number, progress: { stage: Stage, done?: number, total?: number } }
      | { id: number, result: unknown } | { id: number, error: string };
  ```
- Produces (`handler.ts`): `createComputeHandler(): (req: Request, post: (reply: Reply) => void) => void`. It keeps the points of the latest version, posts progress at most every 50 ms per request, and posts `{ error }` when a job throws or the version is unknown.
- Produces (`orbit-job.ts`): `orbitPlan(occ: Occupancy, box: Box | null, spec: OrbitSpec): OrbitPlan` and `orbitCheck(occ: Occupancy, req: OrbitCheckRequest)`. `OrbitPlan` and `OrbitAddResult` types move here and `orbit-events.ts` re-exports them.
- Produces (`fix-path-job.ts`): `runFixPlan(points: Float32Array, extents: Float32Array, req: FixPlanRequest, onProgress?: ProgressFn): FixPlanReply`. The grid cache key is version + box + eye height + opening + allowFlying + positions.
- `planFixPath` input gains `onProgress?: ProgressFn`; `keyRoutes(grid, positions, onProgress?)`; `planDetours` input gains `onProgress?`. Stages: `grid` (indeterminate), `routes` (done = key trees built, total = keys), `detours` (done = round, total = `MAX_ROUNDS`).

- [ ] **Step 1: Write the failing tests** in `test/compute-handler.mjs`.
  - `'compute: fixPlan through the handler equals planFixPath on the same grid'`: use the `bandRoom` points from `test/nav-doors.mjs` and two keys as in `fix-path-events.mjs` "the smallest opening reaches the scene grid" (box `{min:{-2,-2,-2},max:{42,12,22}}`, eye height 3.2, opening 1.6). Send `points` then `fixPlan` with `structuredClone` on each message. Compare `poses.map(p => [p.keyIndex, p.frame, p.pose.position])`, `blocked`, `unreachable` and `detours` with a direct `buildSceneGrid` + `buildNavGrid` + `planFixPath` result, where key identity is mapped to an index.
  - `'compute: a second fixPlan with the same request reuses the grid'`: count `grid` progress posts; the second run posts none.
  - `'compute: progress arrives in stage order and ends at total'`: the stages seen are a subsequence of `['grid', 'routes', 'detours']`, and the last `routes` post has `done === total`.
  - `'compute: an unknown points version and a throwing job reply with error'`: both reply `{ id, error }` with a non-empty string and nothing else for that id.
  - `'compute: orbitPlan equals the old orbit.plan for the FAR scene'`: reuse the `FAR`, `BOX`, `EYE` and `SPEC` constants from `test/orbit-events.mjs` (export them). The handler result deep-equals `orbit.plan` at the base commit; record the expected values from the current code before moving it.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, the modules don't exist.
- [ ] **Step 3: Implement** the protocol, the two jobs and the handler with the signatures above. Move the orbit pure parts out of `orbit-events.ts` unchanged, and keep `orbit-events.ts` working by calling them inline for now. Add the `onProgress` parameters. The 50 ms throttle always lets the first and the last post of a stage through.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including all existing checks.
- [ ] **Step 5: Commit** — `git commit -m "Add the scene compute handler with Fix Path and orbit jobs"`

### Task 2: Compute client, inline and worker transports, build

**Files:**
- Create: `src/compute/scene-compute.ts` — client.
- Create: `src/compute/inline-transport.ts`, `src/compute/worker-transport.ts`, `src/compute/worker-entry.ts`.
- Modify: `rollup.config.mjs` — export `[application, worker]`, where `worker` has input `src/compute/worker-entry.ts`, output `dist/scene-compute-worker.js`, format `esm`, the same typescript/resolve/terser plugins, and no scss/copy.
- Modify: `src/main.ts:125-128` — create one compute and `events.function('compute', () => compute)` before the `register*Events` calls.
- Test: `test/compute-client.mjs`.

**Interfaces:**
- Produces:
  ```ts
  type RunOptions = { signal?: AbortSignal, onProgress?: ProgressFn, lane?: 'preview' };
  type SceneCompute = {
      // version for this points array (by identity), sending it on first use
      pointsVersion(cloud: { points: Float32Array, extents: Float32Array }): number,
      run<K extends keyof ComputeOps>(op: K, args: ComputeOps[K]['args'], opts?: RunOptions): Promise<ComputeOps[K]['result']>
  };
  type Transport = { send(req: Request): void, onReply(cb: (reply: Reply) => void): void,
      onFailure(cb: (error: Error) => void): void, restart(): void, readonly interruptible: boolean };
  createSceneCompute(transports: (() => Transport)[]): SceneCompute   // first is preferred; on failure, the next
  inlineTransport(handler = createComputeHandler()): Transport         // setTimeout(0), structuredClone both ways, interruptible false
  workerTransport(url: URL, WorkerCtor: typeof Worker = Worker): Transport  // interruptible true; restart = terminate + new
  computeOf(events: Events): SceneCompute  // the registered 'compute', else registers an inline one on this events object
  ```
- An abort rejects the run with `new DOMException('cancelled', 'AbortError')`. With an interruptible transport, an abort restarts it, re-sends the points of every known version and re-sends every other pending request. With the inline transport, the result of an aborted run is dropped when it arrives.
- `lane: 'preview'`: at most one preview request in flight and one queued. A newer request replaces the queued one, which rejects with `AbortError` `'superseded'`. Previews never restart the transport.
- `worker-entry.ts`: `const handle = createComputeHandler(); self.onmessage = e => handle(e.data, r => self.postMessage(r));`.
- Worker URL in `main.ts`: `new URL('./scene-compute-worker.js', import.meta.url)`. The client falls back to inline on a worker `error` event or a failed construction, warning once.

- [ ] **Step 1: Write the failing tests** in `test/compute-client.mjs`. Use a fake `Worker` class that runs `createComputeHandler` on `setTimeout(0)`, records `terminate()` calls and can be told to emit `error`.
  - `'client: run resolves with the handler result and forwards progress'`.
  - `'client: abort restarts the worker, re-sends points and the other pending request'`: start an `estimate` (pending) and a `fixPlan`, then abort the `fixPlan`. `terminate` was called once, the `fixPlan` rejects with `AbortError`, and the `estimate` still resolves to the same value as without the abort.
  - `'client: preview lane keeps only the newest request and never terminates'`: queue 5 `orbitPlan` previews while one runs. The handler ran 2 of them (the first and the last), the middle 3 reject `superseded`, and `terminate` count is 0.
  - `'client: a worker error falls back to inline and warns once'`: stub `console.warn` and count calls; the pending run still resolves.
  - `'client: the same points array keeps its version; a new array gets a new one'`.
  - `'client: inline abort drops the late result'`: the run rejects at once, and the later reply resolves nothing and throws nothing.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the client, the transports, the worker entry, the rollup entry and the `main.ts` registration.
- [ ] **Step 4: Run** `npm test` (PASS), then `npm run build`. Then `ls dist/scene-compute-worker.js` and `grep -c "playcanvas" dist/scene-compute-worker.js`. Expected: the file exists, under 300 kB, and has no engine code (no `GraphicsDevice` string).
- [ ] **Step 5: Commit** — `git commit -m "Add the scene compute client and worker"`

### Task 3: Progress handle and input blocker

**Files:**
- Create: `src/compute/progress-handle.ts`.
- Modify: `src/ui/editor.ts:427-449` — `progressStart` takes a third optional `{ revealAfterMs?: number }`. While pending, the container has class `pending`, and the class is removed after the delay. `progressEnd` clears the timer.
- Modify: `src/ui/scss/progress.scss` — `#progress-container.pending { background-color: transparent; #dialog { visibility: hidden; } }`.
- Modify: `static/locales/*.json` — the stage texts below.
- Test: `test/progress-handle.mjs`.

**Interfaces:**
- Produces:
  ```ts
  type ProgressHandle = {
      signal: AbortSignal,
      update: ProgressFn,
      // hide Cancel and show this text from now on (Orbit Add after commit)
      lockCancel(textKey: string): void,
      end(): void   // idempotent
  };
  startProgress(events: Events, headerKey: string, revealAfterMs = 300): ProgressHandle
  withProgress<T>(events: Events, headerKey: string, fn: (h: ProgressHandle) => Promise<T>): Promise<T>  // end() in finally
  ```
- The handle fires `progressStart(i18n.t(headerKey), true, { revealAfterMs })` at once. It listens to `progressCancel` only while active and turns it into `abort()`. `update(stage, done, total)` fires `progressUpdate({ text, progress })`, with `progress = 100 * done / total` when total is known and pulsing otherwise (omit `progress`).
- Stage text keys (en values): `progress.reading` "Reading the scene", `progress.estimate` "Estimating the area", `progress.grid` "Building the walkable grid", `progress.routes` "Finding routes {{done}}/{{total}}", `progress.detours` "Placing detours", `progress.timing` "Balancing the timing", `progress.measuring` "Measuring views", `progress.orbit` "Fitting the orbit", `progress.checking` "Checking the orbit". Header keys: reuse `timeline.fix-path`, plus `progress.orbit-add` "Add Orbit", `progress.balance` "Balance", `progress.add-keys` "Add as Keys".

- [ ] **Step 1: Write the failing tests** with a plain `Events` and recorded fires.
  - `'progress: start fires progressStart with Cancel and the reveal delay'`: the args are `[header, true, { revealAfterMs: 300 }]`.
  - `'progress: progressCancel aborts only the active handle'`: after `end()`, a `progressCancel` doesn't abort a new handle's signal unless it is the active one.
  - `'progress: end is idempotent and withProgress ends on throw'`: exactly one `progressEnd` for a throwing `fn`, and the error propagates.
  - `'progress: update maps stages to text and percentage'`: `update('routes', 3, 12)` gives the text "Finding routes 3/12" and `progress: 25`; `update('grid')` has no `progress` field.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the handle, the `ui/editor.ts` hook, the scss and the locale keys in all nine files.
- [ ] **Step 4: Run** `npm test`, `npm run lint:locales`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add a progress handle that blocks input and reveals the dialog after 300 ms"`

### Task 4: Fix Path through compute, with progress and Cancel

**Files:**
- Modify: `src/fix-path-events.ts` — `path.fix` runs inside `withProgress(events, 'timeline.fix-path', …)`; planning goes through a planner.
- Modify: `src/timing-events.ts:11` — `snapshotOf` also covers each pose's position, target and fov, plus frames, smoothness and loop.
- Modify: `src/candidate-events.ts` — `candidates.prepare` runs the `estimate` op via `computeOf(events)`. `readOpaquePoints` yields to the browser (`await new Promise(r => setTimeout(r, 0))`) whenever 16 ms have passed since the last yield. Add an optional `onProgress` to `readOpaquePoints(splats, maxPoints, onProgress?)` with stage `reading`, done = chunks read, total = chunks.
- Modify: `src/ui/fix-path-controls.ts:209-236` — drop the spinner timer. A result with reason `cancelled` shows the status line `status.cancelled` ("Cancelled") and no popup.
- Test: `test/fix-path-events.mjs`, `test/timing-events.mjs`.

**Interfaces:**
- Consumes: `computeOf`, `startProgress`/`withProgress`, `FixPlanRequest`/`FixPlanReply` (Tasks 1–3).
- `FixPathResult.reason` gains `'cancelled'`.
- Inside `fix-path-events.ts`: `type Planner = (req: Omit<FixPlanRequest, 'version'>, opts: RunOptions) => Promise<FixPlanReply | null>`, where null means no splats. Default: compute-backed. It invokes `candidates.cloud` for the points, `compute.pointsVersion` and `compute.run('fixPlan', …)`. When `deps.sceneGrid` or `deps.route` is given (existing tests), an inline planner builds the grid with `deps.sceneGrid` and calls `planFixPath` with `deps.route`, then maps keys to indices the same way as `fix-path-job`. `path.fix` maps `keyIndex` back to `userPoses[keyIndex]` and keeps its apply code as is.
- Order inside `path.fix`: snapshot → `measuring` (GPU `camera.sampleDistances`) → `signal` check → planner → `signal` check → snapshot check → apply. Box and eye height still come from `candidates.prepare` plus the user eye height, so test mocks of `candidates.prepare` keep working.

- [ ] **Step 1: Write the failing tests.**
  - `'path: cancel before the plan applies nothing'`: abort right after `path.fix` starts (fire `progressCancel`). The result is `{ ok: false, reason: 'cancelled' }`, the pose summary is unchanged, `ops.length` is 0, and there is one `progressStart` and one `progressEnd`.
  - `'path: cancel after the planner replied applies nothing'`: wrap the planner via deps so it fires `progressCancel` just before resolving. Same assertions.
  - `'path: a moved key position fails with keysChanged'`: while `camera.sampleDistances` is pending (deferred promise), overwrite `camera_1` at its frame with a new position: re-register `camera.getPose` to return a shifted position, then `events.fire('track.addKey', frameOfCamera1)`. Its name and frame stay the same; only the position changes. Expect `keysChanged` and no apply.
  - `'path: a planner error rejects, shows no apply and ends progress once'`.
  - `'balance: a smoothness change while sampling counts as changed'` in `test/timing-events.mjs`.
  - All existing `fix-path-events.mjs` and `fix-path-overview.mjs` checks still pass unchanged. `fix-path-overview` uses the default scene grid, so it now runs through the inline compute and proves the compute path end to end.
- [ ] **Step 2: Run** `npm test`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Fix Path runs in the background with progress and Cancel"`

### Task 5: Orbit, Balance and Add as Keys through compute

**Files:**
- Modify: `src/orbit-events.ts` — `orbit.plan` uses `compute.run('orbitPlan', …, { lane: 'preview' })`. `orbit.add` runs in `withProgress(events, 'progress.orbit-add', …)`: plan (stage `orbit`, cancellable) → `appendAndBalance` → `h.lockCancel('progress.checking')` → `compute.run('orbitCheck', …)`. Drop the local occupancy cache, which now lives in `orbit-job`.
- Modify: `src/timing-events.ts` — `computeBalance(events, poses, opts?: { signal?, onProgress? })`: stage `measuring` → signal check → `compute.run('balance', …)` with stage `timing`. `timing.balance` runs in `withProgress(events, 'progress.balance', …)`.
- Modify: `src/view-keys.ts` — `appendAndBalance(events, added, opts?: { signal?, onProgress? })` passes them to `computeBalance` and returns `{ ok: false, reason: 'cancelled' }` before `track.appendPoses` when aborted. `views.addKeys` runs in `withProgress(events, 'progress.add-keys', …)`.
- Modify: `src/ui/orbit-controls.ts`, `src/ui/balance-controls.ts`, `src/ui/candidates-panel.ts` (Add as Keys) — handle reason `cancelled` with the `status.cancelled` status line and no popup. The orbit popover shows `orbit.checking` "Checking…" in its hint line while a preview request is pending.
- Test: `test/orbit-events.mjs`, `test/timing-events.mjs`.

**Interfaces:**
- Consumes: Tasks 1–3. `OrbitAddResult.reason` and `BalanceResult` failure reasons gain `'cancelled'` (add `'cancelled'` to `BalanceResult`'s reason union in `src/anim/balance-timing.ts`).

- [ ] **Step 1: Write the failing tests.**
  - `'orbit: add cancelled during planning adds nothing and no undo op'`.
  - `'orbit: cancel is locked once the keys are appended'`: fire `progressCancel` after `track.appendPoses`. The keys stay, `result.ok` is true, and the handle received `lockCancel('progress.checking')`; record it via a spy on `progressUpdate`/the handle.
  - `'orbit: previews superseded while dragging return only the newest plan'`: fire 4 `orbit.plan` calls without awaiting. The first and last resolve, the middle two reject `superseded`.
  - `'balance: cancel during sampling retimes nothing'`.
  - `'views: add as keys cancelled appends nothing'`.
  - Existing orbit, timing and view-key checks pass.
- [ ] **Step 2: Run** `npm test`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Orbit, Balance and Add as Keys run in the background with progress and Cancel"`

### Task 6: Non-blocking openings (Suggest Views panel, Fix Path and Orbit popovers)

**Files:**
- Modify: `src/ui/candidates-panel.ts:308-340` — `open()` shows the panel at once, with a `candidates.reading` "Reading the scene…" label and a bar (reuse the panel's progress styling if present, else a thin CSS bar) fed by the `reading`/`estimate` stages. Drop `startSpinner`. `close()` works while preparing and detaches: a late result fills nothing if the panel was closed, and opening again reuses the shared promise. Generate stays disabled until ready.
- Modify: `src/ui/fix-path-controls.ts` (`showEyeHeight`) and `src/ui/orbit-controls.ts` (`fill`) — show `fix-path.estimating` "Estimating…" in the hint line until the values arrive.
- Modify: `static/locales/*.json`.
- Test: `test/candidates-panel.mjs`.

**Interfaces:**
- Consumes: `candidates.prepare` (now non-blocking via Task 4), and an optional `onProgress` that `candidates.prepare(onProgress?)` forwards to `readOpaquePoints` and the `estimate` op.

- [ ] **Step 1: Write the failing tests** in `test/candidates-panel.mjs`, following its existing setup.
  - `'panel: opens before the estimate resolves and shows reading'`: with a deferred `candidates.prepare`, the panel is visible and Generate is disabled.
  - `'panel: closing while reading detaches and a late estimate fills nothing'`.
  - `'panel: reopening after close reuses the pending estimate'`: `candidates.prepare` is invoked once.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run lint:locales`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Suggest Views, Fix Path and Orbit open without freezing"`

### Task 7: Browser measurement, docs, record

**Files:**
- Modify: `docs/fix-path.md`, `docs/orbit.md`, `docs/balance-timing.md`, `docs/view-candidates.md` — one line each: long runs show a progress bar; Cancel leaves the keys as they were. For Orbit, also that Cancel is gone for the final check.
- Record: `/Volumes/T7 Shield/Temp/supersplat/key-editing/NOTES.md` (separate git repo; commit there with the supersplat hash).

- [ ] **Step 1: Build** with `npm run build`. Serve `dist` with `python3 -m http.server 3125 --bind 127.0.0.1 --directory dist`; the `scenes/courtyard.ply` symlink exists. Load `http://127.0.0.1:3125/?load=http://127.0.0.1:3125/scenes/courtyard.ply`.
- [ ] **Step 2: Measure** with the rAF-gap script from the baseline in `key-editing/NOTES.md`: rotation quat `(0, .7071, .7071, 0)`, 360 frames, the 7 keys of `fix-path/recheck2/run.json` `before.keys`. Do it cold (fresh load) and warm for `path.fix`, `orbit.add`, a burst of 5 `orbit.plan` previews (including the cold first), `timing.balance`, `views.addKeys` with 2 picks, and `candidates.prepare`. Expected: every longest gap < 100 ms. Note total times next to the baseline.
- [ ] **Step 3: Check Cancel in the browser:** start `path.fix`, fire `progressCancel` after 100 ms, and check that `camera.poses` is unchanged and the result is `cancelled` within 200 ms. Then run `path.fix` again and check that it succeeds.
- [ ] **Step 4: Check the fallback** by loading with the worker file renamed. There is one `console.warn`, and Fix Path still works.
- [ ] **Step 5: Check the sub-path build:** `BASE_HREF=/supersplat/ npm run build`, then check that `dist/index.js` resolves the worker relative to `import.meta.url`. Grep for `scene-compute-worker.js` and see that no absolute `/scene-compute-worker.js` appears.
- [ ] **Step 6: Update the docs.** Then `npm test && npm run lint && npm run lint:locales && npm run build`. Commit supersplat (`git commit -m "Document progress and Cancel for long runs"`) and the record repo (`git commit -m "Key editing: background work measured (supersplat <hash>)"`).
