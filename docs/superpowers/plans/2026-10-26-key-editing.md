# Key Selection and Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Camera keys can be selected (by thumbnail strip, timeline marker, 3D camera icon, or several at once) and edited one at a time or together. Each key also gets an optional look ahead that faces the direction of travel and turns into the key's view on arrival.

**Architecture:**
- **Track:** keys get stable ids. One undoable multi-key track op covers every edit.
- **Selection:** a single selection module that the strip, timeline, gizmos and editor share.
- **Look ahead:** a pure view rule used by both `buildCameraCurve` and Balance. Exports bake it into dense keys.
- **UI:** a thumbnail strip with an idle-time renderer, and a popover editor built on a pure model.

**Tech Stack:** TypeScript, PlayCanvas, PCUI, Rollup; Node test harness (`npm test`; checks in `test/*.mjs` registered in `test/queue-ordering.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-26-key-editing-design.md`

## Global Constraints

- Every edit is one undo step through `trackEdit` in `src/track-manager.ts`.
- Keys are identified by `Pose.id`, never by name or frame, in selection, thumbnails and multi-key ops.
- Gestures are the same in the strip, the timeline and on 3D cameras:
  - click selects; Shift+click selects a range; Cmd/Ctrl+click adds or removes one key (Cmd on macOS, because Ctrl+click is `contextmenu`); Alt+drag copies.
  - Dragging one of several selected keys moves all of them.
  - Right-click opens the editor.
- Frame collisions: a move, copy or typed time that lands on a frame used by an unselected key is refused with a status line (`createStatusLine`, `src/ui/status-line.ts`), never a silent replace.
- Several keys selected: Update to view, Pick… and typed position/target are disabled. Time sets the earliest selected key and the others keep their spacing. Linger, FOV and look ahead apply to all.
- Clearing flags: any editor edit clears `auto`. `orbit` is cleared only when the view changes (Update to view, Pick, typed position/target).
- Look ahead:
  - Per key: `lookAhead?: boolean`, `turnIn?: number` (seconds, default 1.5). Pitch factor 0.4.
  - The key owns the stretch from the previous user key, and detour views on that stretch are ignored. The turn-in is a minimum: a turn lasts at least `angleDeg / MAX_TURN_DEG_PER_SEC` (20°/s).
  - Turns scale down proportionally when the stretch is too short.
  - Without look ahead, every curve, Balance and Fix Path result is identical to today's.
- Thumbnails: 160×100 via the existing offscreen capture, only while idle. That means 500 ms after the last camera move, edit, scrub or pointer/key input, with no playback, modal run (`progressStart` active) or export. One tile per frame. Any input stops the queue, and the live pose is restored exactly.
- Delete/Backspace removes the selected keys when the last click was on keys, otherwise it deletes splats as today (`select.delete`, `src/editor.ts:796`).
- No frame gap over 100 ms from thumbnails or selection on the courtyard with 20 keys.
- New code goes in new files; upstream files get small hooks only. Files stay under 500 lines; `src/ui/timeline-panel.ts` (642 lines) is split first. Comments describe code, not history.
- New strings go in all nine locales, in the same key order (`npm run lint:locales`).
- Run `npm test`, `npm run lint`, `npm run lint:locales` and `npm run build` before each commit.

## Review Focus

1. **Undo after a group drag that was partly refused:** a refused move changes nothing and adds no undo entry, and Ctrl+Z then undoes the previous edit. Test in Task 2.
2. **Selected keys deleted or replaced by Fix Path or undo:** the ids vanish from the selection, and the editor closes or shows the remaining keys. There are no stale ids and no thumbnail for a missing key. Test in Task 3.
3. **Old project files:** poses without `id`, `lookAhead` or `turnIn`, and with duplicate names, load, get unique ids, play exactly as before and save the new fields. Test in Task 1.
4. **Input during thumbnail rendering:** a pointerdown on the canvas between two tiles leaves the live camera exactly where the user put it, and no tile render runs while the pointer is down. Test in Task 8.
5. **Look ahead on the first key, the last key, a looped shot or a key right after a parked key:** none of these throws or flips the view, and a first key with look ahead holds its own view. Test in Task 5.

---

### Task 1: Stable key ids and the new pose fields

**Files:**
- Modify: `src/camera-poses.ts`:
  - `Pose` (`:7-22`) gains `id: string`, `lookAhead?: boolean` and `turnIn?: number`.
  - `copyPose` (`:27-37`) copies all three.
  - Every place that creates a pose (`addKey :102`, `copyKey :168`, `appendPoses`, `addPose`, `loadPoses`) assigns an id when it lacks one.
  - `addKey` and `copyKey` name new keys with the max+1 rule `appendPoses` uses.
  - `docSerialize.poseSets` / `docDeserialize.poseSets` (`:392-445`) write and read `id`, `lookAhead` and `turnIn`. Loading gives an id to every pose without one and renames duplicate names to the next free `camera_N`.
- Modify: `src/fix-path-events.ts` (detour poses get ids).
- Test: `test/camera-track.mjs`.

**Interfaces:**
- Produces: `newKeyId(): string` in `src/camera-poses.ts`, unique per session, e.g. `k` + counter + random suffix. `Pose.id` is always set on poses the track holds.

- [ ] **Step 1: Write failing tests:**
  - `'track: every key has a unique id that survives move, retime, undo and save/load'`
  - `'track: addKey after a delete never repeats a name'`
  - `'track: old files without ids or with duplicate names load with unique ids and names, and play the same curve'`: compare `curve(frame)` at 10 frames before and after.
  - `'track: lookAhead and turnIn survive copyPose, undo and save/load'`
- [ ] **Step 2:** Run `npm test`. Expected: the new checks FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS, including all existing checks.
- [ ] **Step 5:** Commit: `git commit -m "Give camera keys stable ids and look-ahead fields"`

### Task 2: Multi-key track ops

**Files:**
- Modify: `src/camera-poses.ts` — the four `CameraAnimTrack` methods below.
- Modify: `src/track-manager.ts` — events `track.updateKeys`, `track.moveKeys`, `track.copyKeys` and `track.removeKeys`, each through `trackEdit`. Refusals fire `track.refused` with the reason.
- Test: `test/camera-track.mjs`.

**Interfaces:**
- Produces:
  ```ts
  type KeyChange = { id: string, frame?: number, position?: Vec3, target?: Vec3, fov?: number,
      linger?: number, lookAhead?: boolean, turnIn?: number };
  type KeyRefusal = 'frameTaken' | 'unknownKey' | 'outOfRange';
  updateKeys(changes: KeyChange[]): true | KeyRefusal | false  // false = no-op
  moveKeys(ids: string[], offset: number): true | KeyRefusal | false
  copyKeys(ids: string[], offset: number): true | KeyRefusal | false  // copies get new ids, keep lookAhead/turnIn/linger, drop auto/orbit
  removeKeys(ids: string[]): boolean
  ```
- Rules:
  - A changed field clears `auto`; a changed `position`, `target` or `fov` (the view) also clears `orbit`.
  - Frames are clamped to ≥ 0. A frame used by a key not in `ids` gives `'frameTaken'` and changes nothing.
  - `linger` is clamped to `[0, MAX_LINGER]`; `turnIn` to `[0.1, 10]`.
- The old `moveKey` / `copyKey` / `addKey` / `setLinger` stay. Task 4 stops the UI from calling `moveKey` / `copyKey`.

- [ ] **Step 1: Write failing tests:**
  - `'keys: moveKeys keeps spacing and is one undo step'`
  - `'keys: a move onto an unselected key's frame is refused, changes nothing and adds no undo op'`: check `ops.length` is unchanged; then undo undoes the previous op.
  - `'keys: updateKeys on a detour clears auto; a linger change keeps orbit, a target change clears it'`
  - `'keys: copyKeys gives new ids and keeps lookAhead'`
  - `'keys: removeKeys removes exactly the ids'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Add undoable multi-key track ops that refuse frame collisions"`

### Task 3: Key selection and Delete routing

**Files:**
- Create: `src/key-selection.ts` — pure selection logic plus `registerKeySelectionEvents(events)`.
- Modify: `src/editor.ts:796` (`select.delete`) — one-line hook: when `keys.focused` is true, fire `keys.delete` instead.
- Test: `test/key-selection.mjs`.

**Interfaces:**
- Produces:
  ```ts
  type Gesture = { shift: boolean, toggle: boolean };  // toggle = Cmd on macOS, Ctrl elsewhere
  // ordered = ids by frame; anchor = last plain or toggle click
  selectWith(current: ReadonlySet<string>, anchor: string | null, clicked: string, ordered: string[], g: Gesture): { selected: Set<string>, anchor: string | null }
  ```
- Events:
  - `keys.select(id, gesture)` and `keys.setSelection(ids)`, plus the functions `keys.selected(): string[]`, `keys.focused(): boolean` and `keys.delete`.
  - `keys.selectionChanged(ids)` is fired on every change.
  - `keys.focus(true)` is fired by key clicks. A pointerdown anywhere else (canvas without a camera hit, panels) sets focus false.
- On `track.keysLoaded`, `keyRemoved` and `keysCleared`, ids no longer in `camera.poses` are dropped.
- A plain select also fires `timeline.setFrame(frame of clicked)`, so the playhead and camera jump to the key.

- [ ] **Step 1: Write failing tests:**
  - `'selection: click, shift range, toggle add/remove'`: a table of cases over 5 ordered ids.
  - `'selection: ids that leave the track drop out and fire selectionChanged'`
  - `'selection: delete removes keys when focused, else select.delete stays with splats'`
  - `'selection: a plain click moves the playhead to the key'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Add key selection and route Delete to keys after a key click"`

### Task 4: Timeline split and selection gestures on markers

**Files:**
- Create: `src/ui/timeline-ticks.ts` — the `Ticks` class moves out of `src/ui/timeline-panel.ts` (`:14-365`) unchanged at first: commit A, a pure move.
- Create: `src/ui/key-marker-gestures.ts` — pointer handling for one marker:
  - click → `keys.select`; drag → `track.moveKeys(selectionOrClicked, offset)`; Alt+drag → `track.copyKeys`.
  - A selected marker gets the `selected` class.
  - Right-click fires `keys.edit(id, clientX, clientY)`. That replaces `timeline.keyContextMenu` and the linger popover.
  - The Ctrl+click stamp and its `stamping` hint are removed.
- Modify: `src/ui/timeline-panel.ts` — the remove button removes the selection (`keys.delete`), enabled when the selection is non-empty, and the `KeyLingerPopover` registration goes.
- Delete: `src/ui/key-linger-popover.ts`, after Task 7 provides the editor. Until then `keys.edit` opens the old popover for the clicked key.
- Modify: `src/ui/scss/timeline-panel.scss` — `.key.selected` style.
- Modify: `static/locales/*.json` — `status.frame-taken` "Another key is already on that frame", and update `tooltip.timeline.key` for the new gestures.
- Test: `test/key-marker-gestures.mjs`.

**Interfaces:**
- Produces: `markerAction(e: { button, shift, alt, toggle }, moved: boolean, offset: number): { kind: 'select' | 'move' | 'copy' | 'edit' | 'none', … }`, a pure mapping used by the gesture code.
- A `track.refused` with reason `frameTaken` shows `status.frame-taken` in a status line above the timeline.

- [ ] **Step 1:** Commit A: move `Ticks` with no behaviour change. Run `npm test` and `npm run build`. Expected: PASS. Commit: `git commit -m "Move the timeline ticks into their own file"`.
- [ ] **Step 2: Write failing tests** for `markerAction`:
  - plain click → select
  - drag → move
  - Alt+drag → copy
  - right button → edit
  - Shift+click → select with shift
  - Cmd/Ctrl+click → toggle
  - a click without movement never moves
- [ ] **Step 3:** Run `npm test`. Expected: FAIL.
- [ ] **Step 4:** Implement and wire the gestures.
- [ ] **Step 5:** Run `npm test`, `npm run lint:locales`, `npm run build`. Expected: PASS. `wc -l src/ui/timeline-panel.ts src/ui/timeline-ticks.ts` shows both under 500.
- [ ] **Step 6:** Commit: `git commit -m "Select, move and copy keys on the timeline with standard gestures"`

### Task 5: Look-ahead view rule in the curve and in Balance

**Files:**
- Create: `src/anim/look-ahead.ts` — the pure view rule.
- Modify: `src/anim/camera-curve.ts`:
  - `CurvePose` gains `lookAhead?`, `turnIn?` and `auto?`.
  - `CurveOptions` gains `frameRate: number`.
  - Without any `lookAhead`, the evaluator is exactly today's spline.
- Modify: `src/anim/balance-timing.ts:226-260` — the sample loop evaluates through the same curve builder, via a helper that wraps `CubicSpline` + `lookAheadView`. `BalanceKey` gains `lookAhead?`, `turnIn?` and `auto?`.
- Modify: every `buildCameraCurve` caller to pass `frameRate`:
  - `src/camera-poses.ts:337`
  - `src/camera-pose-gizmos.ts:164`
  - `src/path/detours.ts:258`
  - `src/compute/orbit-job.ts:113`, plus `OrbitCheckRequest.curve` in `src/compute/protocol.ts`
- Modify: `src/timing-events.ts` (`BalanceSource`, `snapshotOf`), `src/fix-path-events.ts` (`FixKey` building) and `src/path/fix-plan.ts` (`retime` passes the flags) to carry `lookAhead`/`turnIn`.
- Test: `test/look-ahead.mjs`, plus existing `test/balance-timing.mjs` and `test/fix-path*.mjs` unchanged.

**Interfaces:**
- Produces:
  ```ts
  // view target for frame t on the stretch [t0, t1] arriving at key `to`; prev is the previous user key
  type LookAheadInput = { t: number, t0: number, t1: number, frameRate: number,
      position: Vec3Like, tangent: Vec3Like, prevView: Vec3Like, keyView: Vec3Like,
      prevTurnIn: number, turnIn: number, distance: number };
  lookAheadView(input: LookAheadInput): Vec3Like  // a unit view direction
  ```
- How the view is built:
  - The forward direction is the tangent with its y component scaled by 0.4, then normalised.
  - The turn-out time is `max(prevTurnIn, angle(prevView, forward) / 20°/s)`, and the turn-in time is `max(turnIn, angle(forward, keyView) / 20°/s)`. Both scale down together when their sum exceeds the stretch duration.
  - Slerp prevView → forward, hold forward, then slerp forward → keyView.
  - The target lies at the key-blended view distance along that direction.
- A stretch belongs to the next user key that has `lookAhead`. Detour (`auto`) keys inside it contribute positions only.

- [ ] **Step 1: Write failing tests:**
  - `'look: without lookAhead the curve equals the plain spline at 50 frames'`: bitwise equal.
  - `'look: mid-stretch the view points along the tangent with 0.4 pitch'`
  - `'look: at the key the view equals the key view; turn-in starts turnIn seconds before'`
  - `'look: a 90° turn-in stretches to 4.5 s at the cap'`
  - `'look: a short stretch scales both turns'`
  - `'look: detour views on a look-ahead stretch are ignored'`
  - Review Focus 5: `'look: first key, last key, loop and after a parked key don't throw or flip'`
  - `'balance: results identical without lookAhead for the courtyard 7-key set'`: frames equal to the stored result.
  - `'balance: a look-ahead stretch's peak turn stays ≤ 20°/s + tolerance'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`, then `npm run build` (the worker must still have no engine code). Expected: PASS; `grep -c GraphicsDevice dist/scene-compute-worker.js` prints 0.
- [ ] **Step 5:** Commit: `git commit -m "Add per-key look ahead to the camera curve and Balance"`

### Task 6: Bake look ahead into the HTML viewer export and Publish

**Files:**
- Create: `src/camera-keyframes.ts` — `cameraKeyframes(events, fov)` returns the `keyframes` object both exporters write.
- Modify: `src/export-options.ts:72-107` and `src/ui/publish-settings-dialog.ts:436-465` to use it.
- Test: `test/camera-keyframes.mjs`.

**Interfaces:**
- Produces: `cameraKeyframes(poses: Pose[], opts: { frames, frameRate, smoothness, loop, fov }): { times: number[], values: { position, target, fov } }`.
  - Without look ahead on any key in the shot, the output equals today's keys exactly.
  - With look ahead, it samples the curve every 2 frames over the shot. The last sample sits on the last key's frame.

- [ ] **Step 1: Write failing tests:**
  - `'export: no look ahead gives exactly today's keyframes'`
  - `'export: with look ahead, samples every 2 frames match the curve'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Bake look ahead into the viewer export and Publish"`

### Task 7: Key editor popover and surface picking

**Files:**
- Create: `src/ui/key-editor-model.ts` — pure model: fields for a selection, mixed values, disabled states, and changes for an input.
- Create: `src/ui/key-editor.ts` — the PCUI popover, opened by `keys.edit` and by a selected thumbnail. It contains:
  - fields: time (s), frame, linger, FOV, look ahead (toggle) and turn-in (s)
  - buttons: Update to view, Pick position, Pick target, More (position/target x/y/z) and Delete
- Create: `src/key-pick.ts` — `pickStandPoint` and the pick mode: a crosshair cursor; the next canvas click picks; Escape cancels.
- Delete: `src/ui/key-linger-popover.ts` and its scss.
- Modify: `static/locales/*.json` — editor labels and tooltips. Reuse `timeline.linger`.
- Test: `test/key-editor-model.mjs`, `test/key-pick.mjs`.

**Interfaces:**
- Consumes: `track.updateKeys` (Task 2), `keys.selected` (Task 3), `path.settings().eyeHeight`, `camera.intersect(x, y)`, `camera.frameAtPose` and `camera.pickDepths`.
- Produces:
  ```ts
  editorFields(poses: Pose[], frameRate: number): { count: number, time: number | null, frame: number | null, linger: number | null,
      fov: number | null, lookAhead: boolean | null, turnIn: number | null, position: Vec3Like | null, target: Vec3Like | null,
      viewEditable: boolean }   // null = mixed; viewEditable = count === 1
  changesFor(poses: Pose[], field: 'time' | 'frame' | 'linger' | 'fov' | 'lookAhead' | 'turnIn' | 'position' | 'target', value): KeyChange[]
  // floor straight down from just above `hit`; null when nothing is below
  pickStandPoint(hit: Vec3Like, eyeHeight: number, pickDown: (from: Vec3Like) => Promise<Vec3Like | null>): Promise<Vec3Like | null>
  ```
- "Update to view" builds a `KeyChange` from `camera.getPose()`.
- Pick position keeps the view direction, and the target moves by the same offset. Pick target sets the target to the hit point.

- [ ] **Step 1: Write failing tests:**
  - `'editor: one key shows its values; three keys show null where they differ'`
  - `'editor: time for several keys moves the earliest to it and keeps spacing'`
  - `'editor: view fields are disabled for several keys'`
  - `'pick: standing point is eye height above the floor found straight down'`
  - `'pick: nothing below leaves the key unchanged'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement the model, the pick logic and the popover. Then remove the linger popover.
- [ ] **Step 4:** Run `npm test`, `npm run lint:locales`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Edit selected keys in a popover and pick positions on the scene"`

### Task 8: Thumbnail strip with an idle-time renderer

**Files:**
- Create: `src/key-thumbnails.ts` — cache and queue.
- Create: `src/ui/key-strip.ts` — the strip:
  - placed above the timeline with a toggle button, open by default; the toggle is persisted as a preference (`src/preferences.ts`)
  - tiles: user keys full width, detours narrow and blue (`AUTO_KEY_COLOR`), parked keys at the end and greyed
  - selection gestures as in Task 4; double-click opens the editor
  - tiles without an image show the time
- Modify: `src/ui/timeline-panel.ts` — one hook to mount the strip.
- Modify: `src/ui/scss/` — strip styles matching the timeline.
- Modify: `static/locales/*.json` — `tooltip.timeline.key-strip` and tile tooltips.
- Test: `test/key-thumbnails.mjs`.

**Interfaces:**
- Produces:
  ```ts
  type ThumbDeps = { now(): number, render(pose: Pose): Promise<HTMLCanvasElement>, busy(): boolean,
      onTile(id: string, canvas: HTMLCanvasElement): void };
  createThumbnailQueue(deps: ThumbDeps): { invalidate(poses: Pose[]): void, input(): void, tick(): Promise<void> }
  ```
  - `invalidate` queues keys whose `id + position + target + fov` signature changed, newest first.
  - `input()` marks activity.
  - `tick()`, called once per animation frame, renders at most one tile, and only when `now() - lastInput ≥ 500` and `!busy()`.
- `busy()` is true during playback, a modal run, export/`lockedRenderMode`, or while the pointer is down.
- `render(pose)`:
  - Sets `lockedRenderMode`, sets the pose and fov, calls `render.offscreen(160, 100)`, then restores the live pose and fov exactly.
  - It uses the same steps as `src/candidate-events.ts:131-147`. Share a helper with it instead of copying.

- [ ] **Step 1: Write failing tests** with a fake clock and render:
  - `'thumbs: nothing renders within 500 ms of input'`
  - `'thumbs: one tile per tick, newest edit first'`
  - `'thumbs: busy stops rendering'`
  - `'thumbs: a key re-renders only when its view changes'`
  - `'thumbs: removed keys drop out of the queue'`
  - Review Focus 4: `'thumbs: input between two tiles stops the queue before the next render'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement the queue, the shared capture helper and the strip.
- [ ] **Step 4:** Run `npm test`, `npm run lint:locales`, `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Show camera keys as a thumbnail strip that renders while idle"`

### Task 9: Click cameras in 3D

**Files:**
- Create: `src/key-pick-3d.ts` — a screen-space nearest-icon hit test plus a canvas click handler.
- Modify: `src/camera-pose-gizmos.ts` — selected keys draw in the user-key orange (`#ff8a1f`, add to `src/path/colors.ts`), and `selectionChanged` marks the gizmos dirty.
- Test: `test/key-pick-3d.mjs`.

**Interfaces:**
- Produces: `nearestKey(screen: { x, y }, keys: { id, screen: { x, y } | null }[], maxPx = 10): string | null`.
- The handler is active only when `camera.showPoses` is on and `tool.active` is empty. It acts on a click with under 4 px of pointer movement, and the gestures follow Task 3.

- [ ] **Step 1: Write failing tests:**
  - `'pick3d: nearest within 10 px wins; none beyond'`
  - `'pick3d: keys behind the camera (screen null) are skipped'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run `npm test` and `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Select camera keys by clicking their cameras in 3D"`

### Task 10: Browser check, docs, record

**Files:**
- Modify: `docs/fix-path.md` or a new `docs/editing-keys.md`, linked from `README.md:19`. Give it a short "Editing keys" section: the strip, the gestures, the editor fields, Pick, Delete, look ahead and turn-in, and the refusal message.
- Record: `/Volumes/T7 Shield/Temp/supersplat/key-editing/NOTES.md`, a separate git repo; commit there with the measured supersplat hash.

- [ ] **Step 1: Build a 20-key set on the courtyard.** Build with `npm run build`, serve `dist` on `http://127.0.0.1:3125` (python http.server; `scenes/courtyard.ply` is a symlink) and load `?load=http://127.0.0.1:3125/scenes/courtyard.ply`. Rotate the splat by quat `(0, .7071, .7071, 0)` and use 360 frames. Add 20 keys: the 7 from `fix-path/recheck2/run.json` `before.keys` plus 13 picked with Suggest Views. Save the set as JSON in the record.
- [ ] **Step 2: Measure** with the rAF-gap method from `key-editing/NOTES.md`. Leave the editor idle for 10 s while the thumbnails render. Then orbit the camera during rendering and check that the pose is unchanged by rendering. Then select, drag a group and edit. Expected: every longest gap < 100 ms.
- [ ] **Step 3: Check the done list.** Go through every "Done when" item of the spec in the browser. Take a screenshot each of the strip, the editor (one key and several keys) and the look ticks of a look-ahead key. Copy them into the record folder.
- [ ] **Step 4: Check unchanged results.** Balance and Fix Path results for the 7 keys without look ahead are identical to the starting commit. Compare frames and positions.
- [ ] **Step 5: Check exports.** Export the HTML viewer with one look-ahead key and play it. Its look direction matches the MP4 at 5 sampled frames.
- [ ] **Step 6:** Update the docs, then run `npm test && npm run lint && npm run lint:locales && npm run build`. Commit supersplat (`git commit -m "Document key editing"`) and the record repo (`git commit -m "Key editing: measured (supersplat <hash>)"`).
