# Fix Path

Fix Path repairs a camera shot in one click. It puts the keys in a good order, routes the camera through doors and openings instead of walls, and balances the timing.

## What it does

- Orders the keys. The first key stays first. The tool picks the rest for the shortest way through the scene.
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
- **Eye height**: shown for information. "(estimated)" means Suggest Views was not used. To change it, use Suggest Views.

Click outside the box or press Escape to close it.

## Results

- **Clean run**: a short line above the button, "Path fixed. Detour keys added: N". It goes away after a few seconds.
- **Problems left**: a box titled **Path Needs Attention** lists them.
  - "No route found to these keys: ... They were moved to the end of the shot; move or delete them."
  - "The path is blocked after the keys at frames ... (marked red on the timeline)."
  - "These keys are inside geometry or outside the area: ... Their routes start from the nearest free space."
- **Errors**: a box titled **Couldn't Fix Path**.
  - "Add at least two camera keys to fix the path."
  - "There are no visible splats to route the camera through."
  - "The camera keys couldn't be updated. Try again."
  - If you move or edit keys while it works, it stops and nothing changes.
- If the timing can't fit, the order and detours are still applied and a **Couldn't Balance Timing** box explains why. See [Errors](balance-timing.md#errors).

## Timeline

- Detour keys have a light blue colour. Your keys keep theirs.
- A red band marks a blocked segment, from the key to the next key.
- A red ring marks a key that could not be reached.
- The marks vanish after the next edit of keys, **Smoothness** or loop, and are replaced by the next run.

## 3D view

With camera poses shown, the camera path is drawn as a line.

- Red: blocked segment.
- Light blue: segment next to a detour key.
- Otherwise: the normal pose colour.
- The line follows keys, smoothness, loop and length.

## Run again

- A new run removes all old detour keys and plans fresh. Detour keys do not pile up.
- Move a detour key in time, or update its pose, and it becomes a normal key. It is then kept.
- Run again after you change smoothness or loop. They can bring back collisions, and Fix Path does not rerun by itself.
- With loop on, the order is a closed tour and the way from the last key back to the first is routed too.

## Limits

- Rooms reachable only through very narrow openings, or through stairs the scan missed, stay unreachable.
- The path check uses the scan's splats. Thin or sparse walls may leak, so the camera can still pass through them. Play the shot to check.
- The route stays inside the **Area** box.
- Fix Path does not check while you drag keys by hand.
