# Orbit

Orbit adds camera keys on a circle around a point in one click: a fountain, a statue, a corner. The camera looks at the point the whole way round.

## Add an orbit

1. Set the focal point: **double-click** the subject on the splats. In orbit mode a **middle-mouse click** works too.
2. Move the camera to where the orbit should start. Its distance and height to the focal point become the defaults.
3. Click **Orbit** (next to **Fix Path**). A preview circle appears in 3D.
4. Change the fields if you want. The preview follows.
5. Click **Add Orbit**.

- The orbit keys go after your existing keys. Then the timing is balanced, like [Balance](balance-timing.md).
- One Ctrl+Z removes the whole orbit.
- A longer run shows a progress bar with **Cancel**. Cancel leaves the keys as they were. Once the keys are added, Cancel is gone for the final check ("Checking the orbit").
- Splat files only. Hidden and locked splats are ignored.

## Fields

- **Radius**: distance from the focal point, along the ground. In metres when the scene looks metric, else in scene units.
- **Height**: camera height above the focal point. Negative looks up at it.
- **Span**: how far round, 90–360°. Rounds to steps of 22.5°.
- **Direction**: **Left** turns counter-clockwise seen from above, **Right** clockwise.
- **Keys**: one key every 22.5°, plus one at the end. A full turn has 17 keys; the last one repeats the first position. Exception: a full turn alone in a looping shot has 16 keys, because the loop closes it.
- Defaults refresh each time you open the box. Click outside or press Escape to close it.

## Near walls

- The circle is checked against the scan before it is added. Leaving the area estimated from the scan counts as blocked, like in [Fix Path](fix-path.md). Suggest Views and Fix Path settings don't change it.
- If it hits something, the radius shrinks until the circle is free. The box says "Radius reduced to …".
- If no radius is free: "No clear orbit here". Red parts of the preview show where it is blocked. Move the focal point or the camera.
- The height never changes and the circle is never cut short.
- After adding, the camera curve between the orbit keys is checked too. If it touches geometry, a box says so: try a slightly smaller radius.
- The way from your last key into the orbit is not routed. If it is blocked, you are told to run **Fix Path**.

## 3D preview

- Shown while the box is open, also with camera poses hidden.
- Lavender circle with a tick at each key, and a cross at the focal point.
- Red: blocked part of the circle.

## Timing

- Balance times the orbit like any other keys. There is no separate orbit duration.
- Turns are capped at 20°/s. A full turn needs at least 18 s.
- If the shot is shorter, the box warns: "This orbit needs ≥ … s at the turn cap; shot is … s". You can still add the orbit; Balance then turns faster and tells you. Increase **Total Frames** for a calmer orbit.

## Fix Path

- [Fix Path](fix-path.md) keeps each orbit's keys together and in order, with no detour keys between them.
- It routes the way into and out of the orbit.
- An orbit that can't be reached is parked as a whole.
- Updating an orbit key on the timeline with a different view makes it a normal key. The orbit splits there; each part stays together. Dragging keys in time keeps them in the orbit.

## Limits

- The check uses the circle at the camera height. Thin objects the scan missed are not seen.
- The orbit keeps a fixed radius and height. No spirals, no partial arcs around obstacles.
- You can't edit an orbit as a whole after adding it. Undo it and add a new one.
- Needs at least one frame per key. Too few frames: increase **Total Frames**.
