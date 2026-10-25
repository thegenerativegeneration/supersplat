# Shot tools: fixes from the prior-art review — Design

Date: 2026-10-24
Base: branch `feature/balance-timing` at 8dbc68c (Balance timing, Suggest Views, Fix Path)
Research: experiment repo `/Volumes/T7 Shield/Temp/supersplat/`, reports `Automatic camera shots prior art.md` and `Camera shots prior art gaps.md` (commit 244f244), with notes in `research_notes/`.

## Intent

Two research rounds compared Suggest Views, Fix Path and Balance timing with published methods and products. They found gaps where established practice is better than what we built: how solid space is decided from splats, distance from walls, where the camera looks while moving, turn speed. This project closes the gaps that are doable. The orbit tool (project 3) comes after it and builds on the same grid.

## Decided by the user

- Gaps found by the research are added when doable.
- **Rollout:** every change that alters how shots or suggested views look ships behind an option. I render before/after videos (or view grids) on the courtyard (Scan_2) and the hall, the user compares them with given criteria, and only winners become default.
- **Occupancy follows splat-transform's rule**, so Fix Path agrees with the published viewer's walk collision.
- **Turn cap in Balance timing:** about 20°/s, on by default. If Total Frames is too short for the cap, Balance (and Fix Path) still balances, relaxing the cap where it can't be met, and shows a warning naming the fastest turn in °/s. No automatic lengthening.
- **Density rule reads all splats** (no thinning), to match the viewer's rule; slower preparation on large scans is accepted, measured and reported (a worker if needed).
- **Order:** these fixes first, then the orbit tool.

## Goals

1. **Density occupancy** (shared by Suggest Views and Fix Path), option "Solid space: density (new) / splat bodies (current)".
   - Rule from `@playcanvas/splat-transform` 3.10.2 (MIT, already a dependency): each Gaussian adds `opacity · exp(−½ d²)` at the point of the voxel nearest its centre (d = Mahalanobis distance), summed per voxel; solid when `1 − exp(−Σ) ≥ 0.1`; Gaussians reach 3σ. Read the splat-transform source for the exact evaluation and port it; its voxel functions are not exported from the package root, so no deep imports.
   - Semi-transparent splats count (they add up), so the reader also returns opacity and includes splats down to the level where they can matter (builder picks the floor, e.g. 1/255 contribution; record it). All splats are read under this rule (user decision); the 500k thinning stays only for the current rule.
   - No 1 m radius cap under the density rule (the cap caused the roof leak); floaters are handled by a cluster filter instead: keep the connected solid components that hold most of the solid voxels, drop small isolated ones (builder sets the size threshold relative to eye height; record it).
   - Floater filter (drop Gaussians contributing < 1/255 to every solid voxel) only if it changes results at our voxel size; measure and record.
   - Exterior fill and capsule carve: not used (semi-outdoor scenes; walk cells already model the capsule).
2. **Distance field and camera radius** (Fix Path), option "Keep clear of walls".
   - Exact Euclidean distance transform on the occupancy grid (Felzenszwalb–Huttenlocher, separable per axis, linear in voxels).
   - Edge cost: `length · (1 + w · max(0, 1 − c / c_pref)²)`, c = clearance of the cell, c_pref ≈ 2 × camera radius; builder tunes w on the test scenes and records it.
   - Curve check treats the camera as a sphere: a sample fails if its clearance is below the camera radius (default 0.2 × eye height / 1.6; Cinemachine uses 0.2–0.4 m). User-key skip radius stays.
   - Doors: a 0.9 m door must still pass with the default radius; the "Smallest opening" lever keeps working.
   - Voxel size stays eye height / 4. At 0.4 m a 0.9 m door is about two free voxels wide, so clearance must be measured finer than whole voxels: from the sample position to the nearest occupied voxel's box (EDT to pick candidates, exact point-to-box distance for the check). If the 0.9 m door still fails at radius 0.2 × eye/1.6, the radius is lowered and the value recorded.
3. **Look direction on detours** (Fix Path), option "Look ahead (new)".
   - Look at the path point about 2 s ahead at the planned speed (Geraerts 2009) instead of a fixed eye height ahead.
   - Keep the view within 35° of the travel direction (Way-Finder 30–40°), face along travel through narrow passages (clearance below a threshold from goal 2).
   - Ease out of the previous user key's view and into the next one's over the same distance near each key; the 35° clamp applies only between those zones. The turn cap (goal 4) keeps the ease from becoming a fast turn.
4. **Turn cap** (Balance timing, default on, no toggle — user decision): peak turn speed of the sampled camera curve ≤ 20°/s (peak, not segment average, because the readout shows the peak). Balance lengthens segments that exceed it inside its iteration. If Total Frames can't fit the cap: balance anyway with the cap relaxed where needed and show a warning with the fastest turn in °/s (new non-error result and i18n string). Fix Path's retiming uses the same rule and shows the same warning in its status.
5. **Speed readout** (Balance and Fix Path status): average and peak camera speed (m/s when the scene looks metric, else scene units/s) and peak turn speed (°/s) of the result.
6. **Suggest Views: wall-aligned directions**, option "Align views to walls". *(Removed after the blind test, see the addenda.)*
   - Dominant wall direction per level (or per room-sized region, builder's call) by the Hübner et al. 2021 histogram: horizontal normals of flat, opaque, near-vertical splats (shortest axis as normal; flatness threshold to calibrate, start smallest < 0.3 × middle) folded mod 90° into 1° bins, peak cluster, weighted median refine.
   - Candidate azimuths = that direction + multiples of 45°. No clear peak → current fixed azimuths.
7. **Suggest Views: openness score**, option "Prefer open views". *(Now always on at weight 0.3, see the addenda.)*
   - Isovist from each candidate position on the eye-height slice of the grid (ray fan, e.g. 72 rays): area and openness; per direction, the depth spread inside the view frustum.
   - Added as a score term with a weight tuned in the comparison; pitch penalty and image terms stay.
8. **Viewer consistency check** (experiment, no UI): voxelize the courtyard with splat-transform's CLI collision export at our voxel size (eye/4) and at its default 0.05 m (downsampled: a coarse voxel is solid if any fine voxel is), and compare with our density grid; report agreement. Recorded in the experiment repo.

## Non-goals

- The orbit tool and spline tangent changes (project 3).
- Telling scan holes from real doors (no published method; noted as a limit).
- Photo- or capture-pose-based quality or uncertainty (hard constraint: splat file only).
- Learned trajectory models, VLMs, aesthetic predictors.
- Exterior fill / carve, lock-and-regenerate in the Suggest Views panel, alpha-completeness rejection (the dark-fraction term already covers empty views; revisit if the comparison shows holes).
- Automatic lengthening of Total Frames.

## Anti-goals

- A default changes without the user having compared it (exception: the turn cap, which the user decided directly; its before/after videos are still shown).
- Fix Path or Suggest Views gets noticeably slower: courtyard Fix Path with ~20 keys stays well under 5 s, Suggest Views generation under a minute; report both.
- Indoor areas become unreachable again (density rule or clearance closing doors). Checked on the courtyard's upper rooms.
- Options pile up in the UI: each option lives in the existing Fix Path gear / Suggest Views setup, and options that lose the comparison are removed again, not kept.

## Calls made by me (check these)

- One shared "Solid space" option, shown in both Fix Path settings and Suggest Views setup, session state like the other settings.
- Options default to the current behaviour until the comparison; after the comparison winners become default and the option is removed if the old behaviour has no use.
- Comparison material: per option, the same keys / same scene, before and after, side by side, plus metrics (detours, min clearance, peak °/s, run time) in wandb. Criteria for the user: passes through geometry, grazes walls, looks into walls, turns too fast, views worth keeping.
- Hübner normals use splats, not voxel faces, because splats carry orientation; if too few flat splats are found the level falls back to fixed azimuths.
- Test scenes: courtyard `/Volumes/T7 Shield/hslu/Scan_2/point_cloud_6.ply` (straightened in the app as before), hall `~/Downloads/artnouveau_point_cloud_29999.ply`.
- `npm install` first: local `node_modules` has splat-transform 3.6.4 while package.json pins 3.10.2.

## Constraints

- Files < 500 lines; `src/path/nav-grid.ts` (411) must not grow much: distance field in a new file.
- i18n in all 9 locales, real translations.
- Unit tests short (Node harness): density rule against hand-computed voxels (one opaque splat solid out to ~2.1σ, many faint splats adding up, cap-free large splat); cluster filter drops an isolated blob; EDT against brute force on a small grid; sphere check rejects a curve grazing a wall and passes a 0.9 m door; look-ahead clamp; turn-cap minimum segment time; Hübner peak on a rotated synthetic room.
- Experiments only on committed code; record commit hashes.
- Docs: update `docs/view-candidates.md`, `docs/fix-path.md`, `docs/balance-timing.md` (options, limits).

## Addendum (2026-10-25, after the courtyard comparison)

Results and videos: experiment repo `research-fixes/NOTES.md`.

Decided by the user:
- **Removed:** "Keep clear of walls" (jittery motion, 4 blocked segments, 124 detours), "Look ahead" (no visible difference from the current rule), "Density solid space" (lost 3 indoor keys at eye/4 voxels). Code remains in git history (6e77aca..e07b005).
- **Turn cap:** stays at 20°/s with the warning. The 150 m courtyard tour needs about 2 min to meet it.
- **Openness:** won the blind pair test (courtyard and hall) 6–0 among decided pairs, 7 same. Always on now, no option; weight stays 0.3 (not tuned).
- **Wall alignment:** no gain in the same test (1–2, 10 same). Removed; code remains in git history (f8586cb).
