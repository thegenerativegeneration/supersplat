# Balance Timing

Balance spreads your camera keys in time so the camera moves at an even speed through the shot.

## Balance

1. Add at least two camera keys on the timeline.
2. Click **Balance** (next to the loop button).
3. The keys move in time. Their order stays the same.

- Total length stays the **Total Frames** value.
- With loop off, Balance always puts the first key at frame 0 and the last key at the final frame. A pre-roll or post-roll you set by hand is replaced; use linger on the end keys instead.
- Keys beyond **Total Frames** are pulled back into range. Keys parked by [Fix Path](fix-path.md#parked-keys) stay where they are.
- One Ctrl+Z undoes the whole Balance.
- Turn cap (on by default): the view turns at most 20°/s where Total Frames allows. [Fix Path](fix-path.md) does the same.
- Speed readout after a run: "Speed: avg … , peak … , fastest turn …°/s".
- Warning when Total Frames is too low for the cap: "Too few frames to keep turns below 20°/s; fastest turn …°/s. Increase Total Frames for a calmer shot." The shot is still balanced.
- Balance counts moving, turning, zoom and closeness to the scene. Close passes get more time.

## Rotation weight

The number next to **Balance** ("How much turning counts compared to moving") sets how much turning counts. Range 0 to 4, default 1.

- Higher: turns get more time.
- 0: turning counts for nothing.

## Linger

Linger makes the camera slow down at a key, or stop at the start or end.

1. Right-click a key.
2. Enter **Linger (s)**. 0 turns it off.
3. Click **Balance** again. Linger does not re-time the keys by itself.

Lingering keys show a band on the timeline.

- The slow-down covers the segments before and after the key.
- For a shorter linger, place the neighbouring keys closer to it.
- With loop off, linger on the **first** or **last** key holds the camera at the start or end.

## Errors

If Balance fails, a box titled **Couldn't Balance Timing** opens. The message says why:

- "Add at least two camera keys to balance their timing."
- "There are too few frames for this many keys. Increase Total Frames or remove keys."
- "The keys changed while balancing. Try again." Balance stops if you move or edit keys while it works.
- "The keys' linger times don't fit in the animation. Shorten the linger times or increase Total Frames."

## Export

Set the export **Loop Mode** to match the timeline loop button:

| Timeline loop | Export loop mode |
|---|---|
| On | Repeat |
| Off | None or Ping Pong |

If they differ, a warning appears. Click **Match timeline** to fix it.
