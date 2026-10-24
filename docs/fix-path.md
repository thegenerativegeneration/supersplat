# Fix Path

Fix Path repairs a camera shot in one click. It puts the keys in a good order, routes the camera through doors and openings instead of walls, and balances the timing.

## What it does

- Orders the keys. The first key stays first. The tool picks the rest for the shortest way through the scene.
- Keys that can't be reached are **parked**: moved after the end of the shot, so they don't play. See [Parked keys](#parked-keys).
- Routes the camera between keys through free space, like a person walking.
- Adds **detour keys** where the camera would hit walls, floors or objects. They get their own colour.
- Balances the timing, like [Balance](balance-timing.md).
- Your own keys keep their position and view. Only their order and time change.
- One Ctrl+Z undoes the whole run.

## Before you start

- Straighten the scene first. See [Suggest Views](view-candidates.md).
- Fix Path uses the **Area** box and **Eye height** of [Suggest Views](view-candidates.md) if you used it in this session. Otherwise it estimates both.
- Hidden and locked splats are ignored.

## Fix the path

1. Add at least two camera keys on the timeline (by hand or with Suggest Views).
2. Click **Fix Path** (next to **Balance**).
3. The keys are ordered, detour keys appear and the timing is balanced.

The button is disabled with fewer than two keys. Detour keys are not counted.

## Options

Click the gear next to **Fix Path**.

- **Keep my order**: keeps your key order and only adds detour keys. Default off.
- **Allow flying**: lets the camera fly where walking can't reach, for example up to a gallery. Default on. The camera still prefers walking at eye height. Off means walking only (stairs work if the scan has them).
- **Keep clear of walls (new)**: checks the camera as a small ball with a radius of a tenth of the eye height (0.16 m at eye height 1.6 m), so the path doesn't graze walls and door frames. Default off, being compared. Keys you placed against a wall are not reported for that. With **Smallest opening** at its minimum, low passes can be reported as blocked.
- **Look ahead (new)**: detour keys look at the path about 2 s ahead (one to four eye heights), at most 35° off the travel direction, and face straight ahead through doors. Near your keys they turn from and to your key's view. Default off, being compared.
- **Density solid space (new)**: decides what is solid the way the published viewer's walk collision does: faint splats add up and small floating clumps are ignored. Default off, being compared with the standard rule. Reads every splat, so it is slower on large scans. The setting is shared with [Suggest Views](view-candidates.md).
- **Smallest opening**: the lowest free band the camera may pass, measured above a sill, railing or stair tread. Default 0.8 m, range 0.4–2.0 m, for an eye height of 1.6 m; default and range scale with the eye height. In metres when the scene looks metric, else in scene units. Rounds to steps of a quarter of the eye height (0.4 m).
  - Lower: the camera squeezes through lower bands, e.g. over a gallery railing, through a window over a desk, or on stairs under a low, sloping ceiling. It dips down there; at the default as low as 0.4 m above the sill.
  - Higher: low bands stay closed; rooms behind them are parked. Above the eye height it acts like the eye height, so normal doors (2 m) always pass.
  - Low passages cost extra, so normal routes keep to eye height.
- **Eye height**: shown for information. "(estimated)" means Suggest Views was not used. To change it, use Suggest Views.

Click outside the box or press Escape to close it.

## Results

- **Clean run**: a short line above the button, "Path fixed. Detour keys added: N". It goes away after a few seconds.
- **Problems left**: a box titled **Path Needs Attention** lists them.
  - "No route found to these keys: ... They were moved after the end of the shot (not played) and marked red; move or delete them."
  - "The path is blocked after the keys at frames ... (marked red on the timeline)."
  - "These keys are inside geometry or outside the area: ... Their routes start from the nearest free space." Outside the area means outside the **Area** box.
- **Errors**: a box titled **Couldn't Fix Path**.
  - "Add at least two camera keys to fix the path."
  - "There are no visible splats to route the camera through."
  - "There are too few frames for your keys and the detour keys. Increase Total Frames and try again."
  - "The camera keys couldn't be updated. Try again."
  - If you move or edit keys while it works, it stops and nothing changes.
- If the timing can't fit, the order and detours are still applied and a **Couldn't Balance Timing** box explains why. See [Errors](balance-timing.md#errors).

## Timeline

- Detour keys have a light blue colour. Your keys keep theirs.
- A red band marks a blocked segment, from the key through its detour keys to your next key.
- A red ring marks a key that could not be reached. Parked keys sit at the right edge of the timeline.
- Detour colours and red bands vanish after the next edit of keys, **Smoothness**, loop or **Total Frames**, and are replaced by the next run. Red rings on parked keys stay until a run reaches them.

## 3D view

With camera poses shown, the camera path is drawn as a line.

- Red line: blocked segment, through its detour keys up to your next key.
- Light blue line: segment next to a detour key.
- Otherwise: the normal pose colour.
- The line follows keys, smoothness, loop and length.
- Red camera: a key that could not be reached (parked).
- Light blue camera: a detour key.

## Parked keys

- Fix Path keeps the biggest group of keys that the camera can travel between. Keys outside it are parked.
- If the first key is parked, the shot starts at the earliest key of the group.
- Parked keys stay in the project with their position, view and linger. They get frames after **Total Frames**, in their old order, and don't play.
- They keep the red ring and red camera, also after edits and reloading the project.
- Next steps, your choice:
  - Delete them.
  - Drag one onto the timeline. It becomes a normal key.
  - Move it in 3D and run Fix Path again. Every run tries parked keys again.
- **Balance** and **Suggest Views** leave parked keys where they are.
- If you raise **Total Frames** past a parked key, it plays again like a normal key.

## Run again

- A new run removes all old detour keys and plans fresh. Detour keys do not pile up.
- Move a detour key in time, or update its pose, and it becomes a normal key. It is then kept.
- Run Fix Path again after changing Balance settings, lingers, timeline length, smoothness or loop. They can bring back collisions, and Fix Path does not rerun by itself.
- **Balance** on a fixed path keeps the timing Fix Path gave it.
- With loop on, the order is a closed tour and the way from the last key back to the first is routed too.

## Limits

- The camera is a small ball (see **Keep clear of walls**). It may not pass very narrow gaps. With **Keep clear of walls** on, the minimum **Smallest opening** setting flags low passes as blocked.
- Holes in the scan can still look like doors, so the route may lead through them. Play the shot to check.
- **Density solid space** reads every splat and is slower on large scans.
- Low doors and gaps at floor level (below about 2 m at eye height 1.6 m) don't pass at any **Smallest opening**: the camera can't drop that far in one step.
- Rooms reachable only through bands lower than **Smallest opening**, or through stairs the scan missed, stay unreachable. Lower **Smallest opening** to reach them, then play the shot: the scan may show a gap where there is glass or a lost ceiling.
- The path check uses the scan's splats, including the size of large ones. Sparse walls with gaps may still leak, so the camera can pass through them. Play the shot to check.
- Very large scans (over 500,000 solid splats) are thinned to 500,000 for the check. Thin roofs and walls can then leak again.
- The route stays inside the **Area** box.
- Fix Path does not check while you drag keys by hand.
