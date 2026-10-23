# Balance Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-off, undoable "Balance timing" action that re-times camera keys for constant apparent motion, with per-key Linger, while staying plain keyframe data for every export.

**Architecture:** A pure balancing function (`src/anim/balance-timing.ts`) takes key poses, per-key scene distances and timeline settings and returns new integer frames. It rebuilds the same `CubicSpline` the editor and viewer use, so it can iterate until the timing stops changing. An event module (`src/timing-events.ts`) gathers poses, asks the camera for depth-picked scene distances, runs the function and applies the result through the existing undo wrapper. The UI is split into new small files.

**Tech Stack:** TypeScript, PlayCanvas engine, `@playcanvas/pcui`, i18next locales, the repo's framework-less Node test harness (`npm test`).

**Spec:** `docs/superpowers/specs/2026-10-23-balance-timing-design.md` (read it first; this plan argues from it)

## Global Constraints

- Branch: `feature/balance-timing`. Never commit to `main`.
- Key times only. No change to `src/anim/spline.ts` evaluation, and no extra keys inserted.
- Total length = `timeline.frames`. Keys keep their order. No keys are added or removed.
- Linger is in seconds and stored as `Pose.linger?: number` (absent/0 = none). It is serialized in `poseSets` and ignored by viewer exports.
- Loop off: the first key sits at `round(L_first·fps)` and the last at `frames − 1 − round(L_last·fps)` (true holds, since the spline clamps). Middle-key linger (any key when looping) adds `L·fps` frames split half/half onto its two adjacent segments.
- Loop on: the first key sits at 0 and the wrap segment (last → first) ends at `frames`. This matches `CubicSpline.fromPointsLooping(frames, …)` in `src/camera-poses.ts` and the viewer.
- Balance runs as one undo step via `trackEdit` (`src/track-manager.ts`).
- Rotation weight: default `1`, range `0..4`, saved in `docSerialize.timeline` next to `smoothness`. A weight of 1 is physically motivated: turning 1 rad moves the image about as much as translating sideways by 1× the scene distance.
- All user-visible strings go through i18n. New keys go into **all 9** files in `static/locales/` in the same position (enforced by `npm run lint:locales`). en and de get real translations, the others get the English text.
- `src/ui/timeline-panel.ts` (581 lines), `src/camera.ts` (1139) and `src/ui/export-popup.ts` (684) only get minimal hooks. New logic goes in new files, each under 500 lines.
- Comments describe code, not history. Match the surrounding style (4-space indent, `const fn = () =>`, event names `area.verb`).
- Tests must stay fast: the whole `npm test` stays under a few seconds.

**Plan decision (deviation from spec, flagged to the user):** scene distance is depth-picked only **at the key poses** and interpolated geometrically along each segment (`d0^(1−t)·d1^t`). Picking at every curve sample would need hundreds of GPU depth passes and miss the "well under a second" target. The result is cached for the whole balance run.

## Review Focus

1. **Degenerate keys**: consecutive identical poses or all keys identical. Expect valid, strictly increasing frames (≥ 1 frame per segment), never NaN. Test: Task 1 `zero-cost keys still get frames`.
2. **Bad depth**: no hit (`null`), 0, NaN or Infinity for a key's distance, e.g. sky or floaters. Expect a fallback to the camera→target distance, clamped to ≥ 1e-3. Test: Task 1 `non-finite distances are clamped`, Task 4 fallback in `timing.balance` test.
3. **Tiny timeline**: more keys than frames allow. Expect refusal with `tooFewFrames`, not overlapping keys. Test: Task 1 `too few frames is refused`. A tight but feasible case is covered by `tight timeline keeps keys distinct`.
4. **Keys beyond `timeline.frames`**: they must be pulled into range and ordered by their current frame. Test: Task 2 `retime pulls out-of-range keys in`.
5. **Two keys with loop on**: the wrap segment is the only other segment. Expect two equal halves for symmetric poses. Test: Task 1 `loop with two keys`.

---

### Task 1: Pure balancing core

**Files:**
- Create: `src/anim/balance-timing.ts`
- Create: `test/balance-timing.mjs`
- Modify: `test/queue-ordering.mjs` (import and spread `balanceTimingChecks` into `checks`, like `editorCommandChecks`)

**Interfaces:**
- Consumes: `CubicSpline` from `src/anim/spline.ts`.
- Produces:

```ts
type BalanceKey = {
    position: { x: number, y: number, z: number },
    target: { x: number, y: number, z: number },
    fov: number,
    linger: number,      // seconds, >= 0
    distance: number     // scene distance at this pose (caller may pass NaN/0/Infinity; clamped inside)
};
type BalanceInput = {
    keys: BalanceKey[],  // playback order
    frames: number, frameRate: number, smoothness: number, loop: boolean, rotationWeight: number
};
type BalanceResult =
    { ok: true, frames: number[] } |
    { ok: false, reason: 'tooFewKeys' | 'lingerTooLong' | 'tooFewFrames' };
const balanceTiming: (input: BalanceInput) => BalanceResult;
export { balanceTiming, BalanceKey, BalanceInput, BalanceResult };
```

- [ ] **Step 1: Write the failing tests** in `test/balance-timing.mjs`. Export `balanceTimingChecks` as an object of async functions (same style as `test/editor-commands.mjs`) and import from `./.build/src/anim/balance-timing.js`. Helper `key(px, py, pz, tx, ty, tz, { fov = 60, linger = 0, distance = 1 } = {})`. A helper `near(actual, expected, tol)` asserts per element with `Math.abs(a − e) <= tol`. Unless noted: `frameRate 30`, `frames 181`, `smoothness 1`, `loop false`, `rotationWeight 1`. All keys look along −z (target = position + (0,0,−1)) unless noted.

| Test name | Input | Assertion |
|---|---|---|
| `straight evenly spaced path is uniform` | x = 0,1,2,3,4 | `frames` deepEqual `[0, 45, 90, 135, 180]` |
| `uneven spacing gets proportional time` | x = 0,1,3; smoothness 0 | near `[0, 60, 180]`, tol 1 |
| `rotation-only segment balances against translation` | k0 pos 0 target (0,0,−1); k1 pos 0 target (1,0,0); k2 pos (π/2,0,0) target (1+π/2,0,0); smoothness 0 | middle frame near 90, tol 3 |
| `closer geometry gets more time` | x = 0,1,2, distances 1,1,4; smoothness 0 | middle near 117, tol 2 |
| `middle linger adds to both neighbours` | x = 0,1,2,3, linger 1 on key 1 | near `[0, 65, 130, 180]`, tol 1 |
| `end lingers become holds with loop off` | x = 0,1,2, linger 1 on first, 0.5 on last | `frames[0] === 30`, `frames[2] === 165`, middle near 97.5, tol 1 |
| `loop wraps last to first` | square corners (0,0),(1,0),(1,1),(0,1) in xz, default targets (no rotation), loop true, frames 200 | near `[0, 50, 100, 150]`, tol 1 |
| `loop with two keys` | x = 0 and 1, loop true, frames 200 | `frames` deepEqual `[0, 100]` |
| `zero-cost keys still get frames` | three identical keys | deepEqual `[0, 90, 180]` |
| `non-finite distances are clamped` | x = 0,1,2, distances 0, NaN, Infinity | `ok`, all integers, strictly increasing, last 180 |
| `tight timeline keeps keys distinct` | 10 keys x = 0..9, frames 12 | strictly increasing, first 0, last 11 |
| `too few frames is refused` | 10 keys, frames 5 | `{ ok: false, reason: 'tooFewFrames' }` |
| `linger too long is refused` | x = 0,1,2, linger 10 on key 1 | `{ ok: false, reason: 'lingerTooLong' }` |
| `fewer than two keys is refused` | one key | `{ ok: false, reason: 'tooFewKeys' }` |
| `converges and is deterministic` | zig-zag x = 0,1,2,3,4 with z = 0,2,0,2,0 | calling twice gives deepEqual results; strictly increasing |

- [ ] **Step 2: Run** `npm test`. Expected: tsc fails or the checks FAIL because `balance-timing.js` doesn't exist.

- [ ] **Step 3: Implement `balanceTiming` in `src/anim/balance-timing.ts`.** The algorithm isn't fixed by the tests, so follow this:

```text
n = keys.length; segs = loop ? n : n − 1
if n < 2 → tooFewKeys
fps = frameRate; lf(i) = keys[i].linger · fps
start = loop ? 0 : round(lf(0));  end = loop ? frames : frames − 1 − round(lf(n−1))
if end − start < segs → (lingers > 0 on the ends ? lingerTooLong : tooFewFrames)
share[s] = extra frames for segment s: for each key i that is a "middle" key
   (loop: every key; no loop: 0 < i < n−1) add lf(i)/2 to segments i−1 and i (mod n when looping)
available = (end − start) − Σ share;  if available < segs → lingerTooLong
d(i) = clamp(finite(keys[i].distance) ? distance : |target − position|, ≥ 1e-3)
cost of a step between poses a, b at distances da, db:
   tr = |Δposition| / sqrt(da·db);  rot = angle(dir_a, dir_b) · w;  zoom = |ln(fov_b / fov_a)| · w
   step = sqrt(tr² + rot² + zoom²)
initial costs: one step per segment between its two keys (chord)
iterate ≤ 10:
   durations[s] = available · c[s] / Σc (Σc == 0 → available / segs) + share[s]
   new = roundBoundaries(start, durations, end)       // boundaries incl. the closing one
   if new equals previous → stop
   build spline exactly like CameraAnimTrack.rebuildSpline (points [px,py,pz,tx,ty,tz,fov],
     loop ? CubicSpline.fromPointsLooping(frames, keyFrames, points, smoothness)
          : CubicSpline.fromPoints(keyFrames, points, smoothness))
   c[s] = Σ step over 32 samples evaluated in [b_s, b_{s+1}], distance at sample t = d0^(1−t)·d1^t
return key frames = boundaries[0..n−1]
```

Write `roundBoundaries(start: number, durations: number[], end: number): number[]` as a private helper. It does cumulative rounding of the float boundaries, then a forward pass enforcing `r[k] ≥ r[k−1] + 1`, then a backward pass enforcing `r[k] ≤ r[k+1] − 1`, with `r[0] = start` and `r[last] = end` fixed.

- [ ] **Step 4: Run** `npm test`. Expected: all `balance:` checks print `ok`, and the existing checks still pass.

- [ ] **Step 5: Commit**

```bash
git add src/anim/balance-timing.ts test/balance-timing.mjs test/queue-ordering.mjs
git commit -m "Add pure keyframe timing balancer"
```

---

### Task 2: Linger on keys and retiming in the camera track

**Files:**
- Modify: `src/camera-poses.ts` (Pose type, snapshot/restore/copyKey/addKey-replace keep linger, serialization, new methods)
- Modify: `src/track-manager.ts` (two undoable events)
- Create: `test/camera-track.mjs` (+ register in `test/queue-ordering.mjs`)

**Interfaces:**
- Produces:
  - `Pose.linger?: number`
  - `CameraAnimTrack.setLinger(frame: number, seconds: number): boolean`. Clamps to `[0, 60]` and returns false if there's no key at `frame` or the value is unchanged. Fires `track.keyUpdated`.
  - `CameraAnimTrack.retime(frames: number[]): boolean`. Assigns `frames[i]` to the i-th pose sorted by current frame (out-of-range keys included) and returns false if the lengths differ or nothing changed. Rebuilds the spline and fires `track.keysLoaded`.
  - Events: `track.setLinger (frame, seconds)` and `track.retime (frames)`, both through `trackEdit` with the names `'setLinger'` / `'retime'`, casting the active track to `CameraAnimTrack`.
  - `events.function('camera.keyLingers')` → `{ frame: number, linger: number }[]` for keys with linger > 0.
  - Serialization: `linger` is written only when > 0 and read back as `docPose.linger ?? 0`.

- [ ] **Step 1: Write failing tests** in `test/camera-track.mjs`. Setup: `new Events()` with functions `timeline.frames → 181`, `timeline.frameRate → 30`, `timeline.smoothness → 1`, `timeline.loop → false`, `timeline.frame → 0`, `camera.fov → 60`, then `registerCameraPosesEvents(events)` and `registerTrackManagerEvents(events)`. Collect `edit.add` ops in an array. Load poses via `events.fire('camera.loadPoses', [...])`.
  - `track: setLinger is one undo step and survives snapshot/restore`: setLinger(30, 1.5) → one op, `camera.keyLingers` deepEqual `[{frame:30, linger:1.5}]`. `op.undo()` → `[]`. `op.do()` → back.
  - `track: retime moves keys in order and keeps linger`: poses at 0, 30, 60 (linger 1 on 30) → fire `track.retime [0, 100, 180]` → `track.keys` sorted deepEqual `[0,100,180]` and the linger is now on frame 100.
  - `track: retime pulls out-of-range keys in`: poses at 0, 50, 300 → retime `[0, 90, 180]` → keys `[0, 90, 180]`.
  - `track: retime with wrong length is a no-op`: no op added, keys unchanged.
  - `track: linger round-trips through poseSets`: `docSerialize.poseSets` includes `linger: 1.5` only on that pose. `docDeserialize.poseSets` of that output restores it.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (`setLinger is not a function` / missing event).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "Store linger on camera keys and support retiming"`

---

### Task 3: Rotation weight in timeline state

**Files:**
- Modify: `src/timeline.ts`
- Test: add to `test/camera-track.mjs` (import `registerTimelineEvents`)

**Interfaces:**
- Produces: `events.fire('timeline.setRotationWeight', value)` (clamped to 0..4), notification `timeline.rotationWeight` (fired with the value), and `events.function('timeline.rotationWeight')`. Serialized as `rotationWeight` in `docSerialize.timeline`, deserialized `?? 1`. Same pattern as smoothness.

- [ ] **Step 1: Failing tests**: `timeline: rotation weight defaults to 1 and round-trips`. A fresh deserialize of `{}` gives `1`. Set 2.5, serialize, deserialize → `2.5`. Set 9 → `4`.
- [ ] **Step 2: Run** `npm test`. Expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected pass.
- [ ] **Step 5: Commit** `git commit -m "Add rotation weight to timeline settings"`

---

### Task 4: Scene distance sampling and the balance command

**Files:**
- Modify: `src/camera.ts`. Add `frameAtPose(position: Vec3, target: Vec3, fov: number): CameraFrame` next to `captureFrame`: start from `captureFrame()`, override position, look-at rotation, fov, `ortho: false`, and recompute `view` and `projection` (perspective, same aspect/near/far/horizontalFov) so `frameRay` and `withFrame` agree.
- Modify: `src/editor.ts`. Next to `camera.getPose`, add `events.function('camera.sampleDistances', (poses: { position, target, fov }[]) => Promise<(number | null)[]>)`. One `scene.commandQueue.enqueue` for all poses. Per pose, call `camera.pickDepths(ctx, camera.frameAtPose(...), GRID)` where GRID is a 5×5 grid over normalized `[0.3, 0.7]²`. Return the median `distance` of the hits, or `null` if fewer than 3 points hit.
- Create: `src/timing-events.ts` with `registerTimingEvents(events: Events)`. Register it in `src/main.ts` after `registerTrackManagerEvents`.
- Create: `test/timing-events.mjs` (+ register)

**Interfaces:**
- Consumes: `balanceTiming` (Task 1), `track.retime` and `camera.poses` (Task 2), `timeline.rotationWeight` (Task 3).
- Produces: `events.function('timing.balance', async () => BalanceResult)`. It sorts poses by frame, invokes `camera.sampleDistances`, builds `BalanceKey`s (`distance: sampled ?? NaN`, so the core falls back to the target distance), calls `balanceTiming` with the timeline settings and on `ok` fires `track.retime`. On failure it awaits `showPopup({ type: 'error', header: i18n.t('popup.balance.failed'), message: i18n.t('popup.balance.<reason>') })` and doesn't change any keys. It logs `console.debug` with the sample time in ms and the iteration count.

- [ ] **Step 1: Failing tests** with stubbed events (as in Task 2, plus a fake `camera.sampleDistances` returning `[1, null, 1]`, a fake `showPopup` recording its args and `timeline.rotationWeight → 1`):
  - `timing: balance retimes keys as one undo step`: poses x = 0,1,2 at frames 0, 10, 20 → `await events.invoke('timing.balance')` → `ok`, exactly one `edit.add` op, keys `[0, 90, 180]`.
  - `timing: failure shows a popup and leaves keys`: linger 10 on the middle key → `ok: false`, popup recorded with `type: 'error'`, no op, keys unchanged.
- [ ] **Step 2: Run** `npm test`. Expected FAIL.
- [ ] **Step 3: Implement** `timing-events.ts`, `frameAtPose` and `camera.sampleDistances`. Add the locale keys `popup.balance.failed`, `popup.balance.tooFewKeys`, `popup.balance.lingerTooLong` and `popup.balance.tooFewFrames` to all 9 locale files.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run lint:locales`. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "Add balance timing command with depth-sampled scene distance"`

---

### Task 5: Timeline UI (Balance control, key linger popover, linger bands)

**Files:**
- Create: `src/ui/balance-controls.ts`. A `Container` holding the Balance button (tooltip `tooltip.timeline.balance`) and a `NumericInput` for rotation weight (0..4, step 0.1, precision 1, tooltip `tooltip.timeline.rotation-weight`). The button is disabled when there are fewer than 2 keys. Clicking it invokes `timing.balance`.
- Create: `src/ui/key-linger-popover.ts`. It listens to `timeline.keyContextMenu (frame, clientX, clientY)` and shows a small panel titled with `timeline.key-at-frame` (`Key @ frame {{frame}}`) containing a `NumericInput` labelled `timeline.linger` (seconds, 0..60, step 0.5). On change it fires `track.setLinger`. It closes on Escape, on an outside click and on a key change. Positioning and close handling follow the pattern in `src/ui/clipboard-menu.ts` (`show`, the clamp to window).
- Modify: `src/ui/timeline-panel.ts`. In `createKey`, add a `contextmenu` listener (preventDefault) that fires `timeline.keyContextMenu`. In `rebuild`, draw a `.linger-band` element for each `camera.keyLingers` entry, spanning the previous key (or frame 0) to the next key (or the last frame). Append `BalanceControls` to `settingsControls` after `loop`. Register the popover once in the panel constructor. Add the key-tooltip hint "Right-click to set linger".
- Modify: `src/ui/scss/timeline-panel.scss`. Style `.linger-band`: low-opacity accent fill, behind the key markers, `pointer-events: none`. Style the popover like the existing menus.
- Modify: `static/locales/*.json`. Add `tooltip.timeline.balance` ("Balance timing: even out camera speed across the shot"), `tooltip.timeline.rotation-weight` ("How much turning counts compared to moving"), `timeline.linger` ("Linger (s)"), `timeline.key-at-frame` and the updated `tooltip.timeline.key`. The linger tooltip explains that "slows down around this key; at the first/last key without looping the camera stops".

- [ ] **Step 1: Implement** as above. This is GPU/DOM UI with no unit test, so the verification is manual.
- [ ] **Step 2: Run** `npm run lint && npm run lint:locales && npm test && npm run build`. Expected: all pass.
- [ ] **Step 3: Manual check** with `npm run develop`. Load a scene, add 5 keys, right-click one key and set linger to 1, and check that the band appears. Click Balance, check that the keys move, and that Ctrl+Z restores them in one step. Check that the console shows the debug line with the sample time, and that the time is under 1000 ms for 20 keys. If it isn't, reduce the grid to 3×3 and note it.
- [ ] **Step 4: UX review.** Take screenshots of the timeline with bands, the open popover and the Balance control, and show them to the user for review against After Effects/Blender conventions as the spec requires. Apply the feedback before continuing.
- [ ] **Step 5: Commit** `git commit -m "Add balance timing and key linger controls to the timeline"`

---

### Task 6: Export loop-mode mismatch warning

**Files:**
- Create: `src/anim/loop-mode.ts` with `loopModeMatchesTimeline(mode: 'none' | 'repeat' | 'pingpong', timelineLoop: boolean): boolean` (`repeat` ↔ true, `none`/`pingpong` ↔ false).
- Create: `src/ui/loop-mismatch-row.ts`. It builds a row with a warning `Label` (`popup.export.loop-mismatch`: "Loop mode differs from the timeline's loop setting. Balanced timing may play wrong.") and a button (`popup.export.loop-match`: "Match timeline") that sets the select to `timeline.loop ? 'repeat' : 'none'`. It takes `(events, loopSelect: SelectInput, animationEnabled: () => boolean)` and shows itself only on a mismatch while animation is enabled. It updates on `change` of the select and on `timeline.loop`.
- Modify: `src/ui/export-popup.ts` and `src/ui/publish-settings-dialog.ts`. Insert the row after `loopRow`, with a few lines each.
- Test: add `loop: mode matching` checks to `test/balance-timing.mjs` for all six combinations.
- Locales: the two keys above, in all 9 files.

- [ ] **Step 1: Failing test** for `loopModeMatchesTimeline`: `repeat/true → true`, `none/false → true`, `pingpong/false → true`, `repeat/false → false`, `none/true → false`, `pingpong/true → false`.
- [ ] **Step 2: Run** `npm test`. Expected FAIL.
- [ ] **Step 3: Implement** the helper and the row, then wire it into both dialogs.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run lint:locales && npm run build`. Then a manual check: open the export dialog with animation on, switch the loop mode to make it mismatch, see the warning, click Match, and check the warning disappears.
- [ ] **Step 5: Commit** `git commit -m "Warn when export loop mode differs from the timeline"`

---

### Task 7: Real-scene check, experiment record, docs

**Files:**
- Create: `docs/balance-timing.md` with short user directions and no prose: what Balance does, how to set linger, the end-key stop rule, keeping lingers short by placing neighbouring keys closer, and the export loop mode note.
- Modify: `README.md` with a one-line link to `docs/balance-timing.md` under the existing feature/docs list (or a new "Guides" line if none exists).
- Experiment record: `/Volumes/T7 Shield/Temp/supersplat/balance-timing/` (a separate git repo, init if missing), containing `notes.md` with the supersplat commit hash used, the scene, the sample timing, the residual speed variation and the chosen grid size.

- [ ] **Step 1: Commit** the docs first so the experiment runs on committed code: `git commit -m "Document balance timing"`.
- [ ] **Step 2: Real scene**: on the user's building scene, place about 8 keys including one close pass along a façade, and render an MP4 before and after Balance. Export HTML (loop mode `none`) with linger on the first key, and check in a browser that the start holds.
- [ ] **Step 3: Measure residual variation**. Sample the balanced spline at every frame and log the per-frame apparent-motion cost (using the cost from Task 1) to wandb as a line chart, plus min/max/CV per segment in `notes.md`.
- [ ] **Step 4: User comparison**. Give the user both videos with these criteria: evenness of the perceived speed, no wobble, whether lingers feel intentional, and whether the close pass feels rushed. Record their verdict in `notes.md` and commit the experiment repo.
- [ ] **Step 5:** If the user flags unevenness, stop and bring it back to them. Don't add baking or spline changes inside this plan.
