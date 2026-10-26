# Key selection and editing — design

## Intent

The user builds client flythrough videos from camera keys. Two things slow them down today:
- **Selecting a key is hard.** Clicking a timeline marker does nothing unless you drag it. Remove only works when the playhead sits exactly on the key's frame. 3D cameras can't be clicked.
- **A key can't be edited.** The only way is a hidden Ctrl+click that overwrites the key with the current view.

They also see the camera look sideways along a path. They want a per-key "look ahead" that faces the direction of travel and turns into the key's own view on arrival. They want to change properties of several keys at once.

## Goals

- Select keys four ways: a thumbnail strip, timeline markers, 3D camera icons, and multi-select.
- Edit the selected key, or several at once:
  - "Update to view"
  - time (seconds and frame), linger, field of view, position and target
  - pick a surface in 3D for the position or the target
  - look ahead with its turn-in time
  - delete
- Look ahead per key, applied wherever the camera curve is used.
- Every edit is one undo step.

## Non-goals

- Automatic re-balancing after edits. The user decided Balance stays a manual button.
- A graph or curve editor, easing curves, cuts, or frame guides. Those are research follow-ups, see `/Volumes/T7 Shield/Temp/supersplat/key-editing/editing-features-research.md`.
- Reordering keys by dragging thumbnails. Time decides the order; drag on the timeline as today.

## Anti-goals

- A thumbnail strip that freezes the editor while it renders. Renders must be spread out, in the spirit of the background-work project: no frame gap over 100 ms.
- Selection that silently changes which key a later action affects. For example, Delete must never remove splats when the user meant keys, or keys when they meant splats.
- Look ahead that changes the camera path's position. It changes only where the camera looks.

## Decided (by the user)

- **Placement:** a thumbnail strip above the timeline, option B in the mockups (`.superpowers/brainstorm/…/key-list-placement.html`, Lumion/Twinmotion style). It toggles with a small button and is open by default.
- **Which keys get thumbnails:** all keys. Detour keys get narrow blue tiles between the user keys. Parked keys sit at the end, greyed out.
- **Editor:** a small popover next to the selected thumbnail. It holds time, linger, FOV and look ahead (with turn-in seconds), plus the buttons "Update to view", "Pick…", "More" (position/target x/y/z) and "Delete".
- **Selection gestures,** the same in the strip, on the timeline and on 3D cameras:
  - click selects
  - Shift+click selects a range
  - Cmd/Ctrl+click adds or removes one key
  - Alt+drag on the timeline copies
  - The old Ctrl+click overwrite is replaced by "Update to view". The old Shift+drag copy is replaced by Alt+drag.
- **Dragging** one of several selected keys on the timeline moves all of them and keeps their spacing.
- **Several keys selected:** the same editor shows "N keys" and blank fields where the values differ. Typing a value sets it on all of them.
- **Delete / Backspace** removes the selected keys if the last click was on keys (strip, timeline marker or 3D camera). Otherwise it deletes selected splats as today.
- **Pick position:** click a surface, and the camera stands there at eye height above the clicked floor, keeping its view direction, like the HTML player's walk-to. **Pick target:** the clicked point becomes the target.
- **Detour keys:** editing a detour key turns it into a user key, which Fix Path then keeps.
- **Balance:** no automatic re-balance.
- **Look ahead** is per key. While moving, the camera faces the direction of travel, tilting only part of the slope so stairs don't make it nod. It turns into the key's exact view before arrival. The turn-in time is adjustable per key, default 1.5 s.
- **Numbers:** time and frame, linger, field of view, position and target. Position and target sit under "More".
- **Thumbnails** update when the user pauses (about 0.5 s after the last camera move or edit), not live. SuperSplat has no second colour camera:
  - Picking passes swap the engine camera synchronously and render only depth/ID (`withFrame`, `src/camera.ts:895`).
  - Colour captures move the live camera to the pose and back (`render.offscreen`, `src/render.ts:113`; Suggest Views does this in `src/candidate-events.ts:131-147`).
  - Splats are depth-sorted per view.
- **Turn cap vs look ahead:** the turn-in time is a minimum. Balance stretches a look-ahead turn so the camera never turns faster than the 20°/s cap (`MAX_TURN_DEG_PER_SEC`).
- **HTML viewer export and Publish:** when a shot uses look ahead, the export bakes extra in-between keys so the web player matches the video. Shots without look ahead export exactly as today.

## Decided (my calls; the user can override)

1. **Look-ahead semantics:**
   - A key with look ahead on owns the stretch that arrives at it, measured from the previous user key. Detour keys on that stretch keep their positions, but their stored views are ignored there.
   - The view runs forward along the path and turns into the key's view by the key's turn-in time, avoiding a forward → old view → forward wobble at each detour.
   - On that stretch, the view starts as the previous key's view.
   - It turns to the travel direction over the previous key's turn-in time if the previous key also looks ahead, otherwise over 1.5 s.
   - It then faces forward, and over the last turn-in seconds it slerps into the key's own view.
   - If the stretch is shorter than both turns, the turns scale down proportionally.
   - The travel direction comes from the position curve's tangent. Pitch is scaled by 0.4, so the camera tilts a little.
   - Default for new and existing keys: off. Detour keys keep their own forward-looking targets, as today.
2. **One view rule, two consumers.** The look-ahead view is one pure function, `lookAheadView`, used in two places:
   - by `buildCameraCurve` (`src/anim/camera-curve.ts`), which drives playback, video export, the 3D path line and look ticks;
   - by Balance timing (`src/anim/balance-timing.ts`), which builds its own spline today and sums view angles over 32 samples per segment (`balance-timing.ts:226-270`). Its view samples on look-ahead stretches must come from the same function. That includes Fix Path's retime, which calls `balanceTiming` (`path/fix-plan.ts:107`).

   Both need frame rate, because turn-in is in seconds. `BalanceKey`, `BalanceSource`, `FixKey`, the compute protocol and `snapshotOf` carry `lookAhead` and `turnIn`. The collision checks (`path/curve-check.ts`) read only positions and need no change. Results for keys without look ahead stay identical.
3. **Data:**
   - `Pose` gains `id` (unique, stable), `lookAhead?: boolean` and `turnIn?: number` (seconds). `copyPose` (`src/camera-poses.ts:27-37`) and the save/load code (`camera-poses.ts:392-445`) carry them, so undo, restore and `replacePath` keep them.
   - Today names can repeat (`addKey`/`copyKey` use `camera_${this.poses.length}`, `camera-poses.ts:102,168`), so selection and thumbnails use `id`. Files without ids get them on load.
   - Any edit through the editor clears `auto` (detour → user key, decided).
   - `orbit` is cleared only when the view changes: Update to view, Pick, or typed position/target. Time, linger, FOV and look-ahead edits keep it. That keeps orbit blocks together for Fix Path (`path/blocks.ts`).
4. **Selection state** lives in one place (`key-selection`) as a set of key ids, not frames, so it survives retiming. The strip, timeline, 3D gizmos and editor all read and write it. Keys that disappear drop out of it.
5. **Thumbnails:**
   - Rendered with the existing offscreen capture at 160×100, only while the user is idle: 0.5 s after the last camera move, edit or scrub, with no playback, modal run or export running.
   - One tile per frame, newest edits first. Any user input stops the queue at once, and the live camera pose is restored exactly. Image and video renders refuse to start while the editor is busy (`render.ts:152-157`), so the queue stops before a capture starts and never blocks an export.
   - A key re-renders when its position, target or FOV changes.
   - Cached by key name plus pose. A key without a thumbnail yet shows a neutral tile with its time.
   - Rendering pauses while a modal run or playback is active.
6. **3D camera picking** is a screen-space test against the projected camera icons: the nearest within 10 px wins. It is active only when camera poses are shown and no splat selection tool is active, so it never fights splat selection.
7. **Surface picking** reuses the editor's picker (`camera.intersect` / `pickDepths` with `frameAtPose`). The picker returns no normal (`camera.ts:1034-1058`), so Pick position always takes the first surface straight down from a point just above the clicked point. That point is found with a downward pick from `frameAtPose`, and it works for floor and wall clicks alike. The camera then stands one eye height above it; eye height is Fix Path's, `path.settings().eyeHeight`. If nothing is hit, the pick changes nothing. The HTML player's walk-to (in `@playcanvas/splat-transform`) is the reference for feel.
8. **Frame collisions:**
   - A typed time, a drag (single or group) or an Alt+copy that would land on a frame used by an unselected key is refused with a short status line. Today a single drag silently replaces that key; this is the one deliberate change to old behaviour, per the anti-goal.
   - Typing a time for several keys sets the earliest selected key to it, and the others keep their spacing.
   - With several keys selected, "Update to view", "Pick…" and typed position/target are disabled, because they would stack the keys. Time, linger, FOV and look ahead apply to all.
9. **Timeline code split:** `src/ui/timeline-panel.ts` is 642 lines. Markers, gestures and the strip move into their own files before the new behaviour is added, per the 500-line rule.
10. **Strip toggle state** is a per-viewer preference, stored the way other view preferences are.
11. **Right-click** on a key (strip or timeline) opens the new editor. It replaces the linger popover (`src/ui/key-linger-popover.ts`). On macOS the add/remove toggle is Cmd+click, because Ctrl+click fires `contextmenu`.
12. **Reference key sets:** the 7-key courtyard set (`fix-path/recheck2/run.json` `before.keys`) for "unchanged results", plus a 20-key courtyard set the builder makes once and records in the experiment repo for the frame-gap test. The baseline is the commit the work starts from.

## Constraints

- Keep upstream separation: new UI in new files (`src/ui/key-strip.ts`, `src/ui/key-editor.ts`, `src/key-selection.ts` …), with small hooks in upstream files.
- Strings go in all nine locales.
- Files stay under 500 lines.
- No frame gap over 100 ms from thumbnails or selection on the courtyard scan with 20 keys.
- Existing behaviour without look ahead is unchanged. Existing tests pass, and the Balance and Fix Path results for the courtyard replay keys are identical.

## Done when

- On the courtyard scan with 20 keys, the user can:
  - select a key by thumbnail, timeline marker and 3D camera
  - select a range and a toggle set
  - drag a group in time
  - edit time, linger, FOV, position and target for one and for several keys
  - pick position and target
  - "Update to view"
  - delete with the Delete key without touching selected splats
  - undo each of these in one step.
- Look ahead on a key visibly faces forward in the look ticks, turns into the key view over the turn-in time, and the exported video matches the preview.
- Measured: no frame gap over 100 ms while thumbnails render, and Balance and Fix Path results are unchanged for keys without look ahead. Both are recorded in the experiment repo with the commit hash.
- `npm test`, `npm run lint`, `npm run lint:locales` and `npm run build` pass. User docs get a short "Editing keys" section, and `docs/` gets the new shortcuts.

## Left to the builder

- The exact visual sizes of the strip and the popover. Match the existing timeline styling.
- Thumbnail scheduling details within the limits above.
- How Balance samples the view direction for look-ahead stretches, within decision 2.
