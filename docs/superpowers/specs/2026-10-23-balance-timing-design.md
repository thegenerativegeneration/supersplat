# Balance Timing — Design

Date: 2026-10-23
Base commit: f272ec2

## Intent

Creating camera shots of 3DGS scenes (complex scenes, e.g. buildings) for client and website work is slow mainly because keyframe timing is set by hand: place keys, scrub, drag keys, repeat until the motion looks even. This feature automates timing so the user only chooses *where* the camera goes and *in which order*; the tool decides *when*.

This is project 1 of 2. Project 2 (later, separate design): automatic suggestion of attractive views (VLM or similar) that the user picks from; it will feed keys into this timing tool.

## Goals

- One-off **Balance timing** action that redistributes existing camera keys over the timeline so **apparent motion is constant** across the shot.
- Per-key **Linger** (seconds): the camera slows down strongly around that key, eating into the total length.
- Result is ordinary keyframe data: MP4 render, HTML/ZIP viewer export, publish and saved projects all show the balanced timing with no format change for viewers.
- Undoable as a single step.

## Non-goals

- Automatic view selection (project 2).
- A permanent "auto-timing" mode that re-balances on every edit.
- Changing the spline/interpolation, adding easing curves, or a graph editor.
- Inserting extra keys ("baking") to flatten speed inside segments. Possible later as a separate option.
- A true full stop. See *Constraints*.

## Anti-goals (failure even if it "works")

- Camera visibly wobbles, goes backwards, or jerks after balancing.
- Balancing destroys the user's linger intent on a second run (linger must be persistent).
- HTML export plays different timing than the editor.
- Keys change order or are added/removed by balancing.

## Decided by the user

- Key times only. No change to the evaluation that exports can't reproduce.
- Total length = existing timeline frame count (`timeline.frames`). Balancing fits into it; to change length the user changes that setting and balances again.
- One-off action, undoable; afterwards keys are hand-editable as today.
- Linger is set via **right-click on a key marker → popover** (mockup option A). Balance button lives in the timeline's settings group next to smoothness/loop.
- No true holds now (option 2): linger is a strong slow-down. Duplicated-pose holds wobble with the current spline (verified: keys 0/30/60/90 at x=0/10/10/20 → x drifts 10→10.46→9.54→10 during the "hold").

- **End keys, loop off (user approved):** linger on the first/last key is a *true hold*. The spline clamps outside the key range, so the first key goes to frame `L·fps`, the last to `frames − 1 − L·fps`. Balancing always sets first/last key positions from these values (0 linger → frame 0 / frames−1), overwriting hand-set pre/post-roll. Verified in the bundled viewer (`@playcanvas/supersplat-viewer` 1.35.0, embedded as source in `node_modules/@playcanvas/splat-transform/dist/index.mjs`, `AnimState.fromTrack`): it uses the same `CubicSpline` with the same clamping, and `none` and `pingpong` both clamp at the outer keys, so end holds play there as in the editor.
- **Export loop mismatch (user approved):** export/publish dialogs (`src/ui/export-popup.ts`, `src/ui/publish-settings-dialog.ts`) have their own loop mode (`none`/`repeat`/`pingpong`) defaulting to `timeline.loop`. The viewer builds a looping spline only for `repeat` (loop length = `frames`, same as the editor); `none` and `pingpong` use the clamped spline. So `repeat` matches loop on; `none` and `pingpong` match loop off (pingpong plays the loop-off timing forwards then backwards, which is fine). On a mismatch, show a non-blocking warning with a one-click "match timeline" action.

## Calls made by me (check these)

- Hold and slow-down merged into one per-key setting **Linger: N seconds** (0 = none).
- Linger is stored on the key (`Pose.linger?: number`, seconds), serialized in the project's `poseSets`, ignored by viewer exports.
- Linger time on a middle key (or any key when looping) is added to the segments adjacent to that key, half each. Verified behaviour: with 4× time on both neighbours of a middle key, speed eases smoothly to ~1/5 with no jerk; the slow stretch spans both adjacent segments. To keep a linger short, users place neighbouring keys closer. Document this in the tooltip.
- Balancing includes all keys, also those currently beyond `timeline.frames` (they get pulled into range).
- Rotation weight is saved per project in the timeline serialization next to `smoothness` (`src/timeline.ts`), so re-balancing is reproducible.
- Apparent motion definition (below), with a single user-facing **rotation weight** in the Balance popover (or a dropdown next to the button); defaults chosen by builder after testing on a real scene.

## Constraints (from the code)

- Pose = `position`, `target`, `fov` at an integer `frame` (`src/camera-poses.ts`). One `CubicSpline` (`src/anim/spline.ts`) over all 7 values, times = frames, global `smoothness` (0..1), optional loop (wraps last→first).
- Spline tangents depend on key times. Retiming changes the path shape, so balancing must iterate: compute costs on the curve, retime, rebuild, re-measure, until frame assignment stops changing (cap iterations, e.g. 10).
- Speed inside a segment is not constant (Hermite easing; at smoothness < 1 the camera slows at every key). Balancing equalises per-segment *average* apparent speed. Report residual variation during development on a real path. If visible at smoothness 1, raise it before considering baking.
- Viewer exports (`src/export-options.ts`, `src/ui/publish-settings-dialog.ts`) send raw `times`, `values`, `smoothness` to the PlayCanvas viewer (bundled via splat-transform; spline code identical to `src/anim/spline.ts`). Anything not expressible as key times is invisible there.
- Keys are integer frames: round with cumulative rounding (error does not accumulate), every segment ≥ 1 frame, order preserved.
- Undo: wrap in the existing `trackEdit` pattern (`src/track-manager.ts`) so snapshot/restore covers it. `snapshot()`/`restore()` must carry `linger`.
- `src/ui/timeline-panel.ts` is already 581 lines. New UI (popover, balance control) goes in new files. Balancing logic is a pure function in its own module (e.g. `src/anim/balance-timing.ts`), no PlayCanvas scene access except through an injected distance sampler.
- All strings via i18n like existing tooltips; locales in `static/locales/*.json` (9 languages; at least en + de real translations, others en fallback per repo convention, which the builder should check).

## Apparent motion

Per sample along the evaluated curve (fine sampling per segment):

- **Translation**: `|Δposition| / d`, where `d` = distance from camera to visible scene geometry. Makes a pass close to a façade count as more motion than the same speed far away.
- **Rotation**: angle between consecutive view directions (`target − position`), times rotation weight.
- **Zoom**: `|log(fov₁/fov₀)|`, same weight scale as rotation.

Combine per sample (e.g. `sqrt(t² + r² + z²)`; builder may choose sum if better on tests), sum per segment = segment cost.

Distance `d`: from the splat data, e.g. median depth of splat centres inside a small cone around the view direction, or a depth render. Must be robust to floaters (median / percentile, clamp to sane min). Cache per balance run. Fallback if unavailable: distance to `target`. Builder chooses method; must be fast enough that a balance on ~20 keys completes in well under a second on a typical scene.

## Algorithm (outline)

1. Inputs: ordered keys, `frames`, `frameRate`, `smoothness`, `loop`, linger per key, rotation weight.
2. `lingerFrames` = Σ linger × frameRate. If ≥ frames − (#segments), refuse with a clear message.
3. Initial times ∝ chord cost between keys.
4. Loop: build spline, measure segment costs, assign `available = frames − lingerFrames` proportionally to cost (zero-cost segments get minimum 1 frame), add linger shares, round cumulatively, stop when unchanged.
5. With loop on, the wrap segment (last → first) is a segment like any other. The first key stays at frame 0. With loop off, first/last key positions come from their end-hold lingers (see above), and `available` excludes those holds.
6. Apply as one undoable edit.

Fewer than 2 keys → Balance disabled.

## UI

- **Balance button** (⚖ icon + tooltip) in timeline settings group after loop. Click = balance immediately with current settings. Rotation weight sits in a small attached dropdown/popover (builder's choice, follow existing pcui patterns in `src/ui/`).
- **Right-click on key marker** → popover: "Key @ frame N", Linger seconds (numeric, 0 = off). Changing it does *not* re-balance automatically.
- **Track markers**: keys with linger show a subtle band across their adjacent segments (mockup: dashed blue halo) so lingering keys are visible at a glance.
- Existing drag / shift-drag on keys unchanged.
- UX must get a review (screenshots to the user) before merge. Check how After Effects ("Rove Across Time", keyframe context menu) and Blender handle similar per-key settings.

## Prior art

- After Effects "Rove Across Time": retimes spatial keyframes for constant speed between first and last key. Closest existing feature. Distance-only, no depth or rotation weighting.
- Arc-length reparameterisation of splines: standard technique, rejected here because exports can't reproduce it.

## Testing

- Unit tests for the pure balancing function (fast, no rendering), via the existing `test/` setup (`npm test`): order preserved, keys span exactly the available range (first at end-hold start, last at frames−1−end-hold, loop: wrap segment ends at frames), linger respected, end holds, loop wrap segment, convergence, zero-length segments, linger too large → error, ≥1 frame per segment.
- One test: on a straight constant-spacing path, balanced result is uniform.
- Manual check on a real building scene: before/after video for the user to judge. User compares visuals; criteria: perceived evenness, no wobble, lingers feel intentional.
- Experiment notes (residual speed variation, distance-method choice) recorded per user's global instructions in `/Volumes/T7 Shield/Temp/supersplat/` with commit hash.

## Follow-ups (not this project)

- Upstream PR to PlayCanvas viewer + SuperSplat spline: zero tangent when adjacent keys share a pose. That enables true holds.
- Optional speed baking.
- Project 2: view suggestion.

## Docs

- README / user docs: short entry on Balance timing and Linger, plain language.
