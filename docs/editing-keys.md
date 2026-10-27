# Editing Keys

Select camera keys and change them: time, linger, field of view, position, target and look ahead. ⌘ on macOS, Ctrl elsewhere.

## Thumbnail strip

The strip above the timeline shows one tile per key, in time order.

- Your keys: a picture of the view and its time.
- Detour keys from [Fix Path](fix-path.md): narrow blue tiles between your keys.
- Parked keys (past the end of the shot, they don't play): greyed out at the end.
- Pictures update about half a second after you stop moving the camera or editing. A key without a picture shows only its time.
- Show or hide the strip with the strip button at the left of the timeline controls. The choice is remembered.
- Mouse wheel scrolls the strip sideways.

## Select keys

Works the same on strip tiles, timeline markers and the camera icons in 3D.

| Gesture | Does |
|---|---|
| Click | Select one key. The playhead jumps to it. |
| Shift+click | Select all keys from the last clicked one to this one. |
| ⌘/Ctrl+click | Add or remove one key. |
| Right-click | Open the key editor. In the strip, double-click too. |

- Selected keys are highlighted in the strip, on the timeline and in 3D (orange camera).
- 3D camera icons can be clicked while cameras are shown and no selection tool is active. A drag still orbits the view.

## Move and copy on the timeline

- Drag a selected marker: all selected keys move and keep their spacing.
- Alt+drag: copy the selected keys instead.
- A move or copy onto a frame used by another key is refused: "Another key is already on that frame".
- Keys stay between frame 0 and the end of the shot.

## Key editor

Right-click a key (or double-click a tile). The editor follows the selection.

| Field | What it sets |
|---|---|
| **Time (s)** / **Frame** | When the key plays. |
| **Linger (s)** | Slow down at the key, see [Balance](balance-timing.md#linger). |
| **Field of View** | Zoom at the key. |
| **Look Ahead** | Face the direction of travel on the way to this key, see below. |
| **Turn-in (s)** | Time to turn into the key's view on arrival. Default 1.5. |
| **Update to View** | The key takes the current camera view. |
| **Pick Position** | Click the scene: the camera stands there at eye height, same view direction. |
| **Pick Target** | Click the scene: the camera looks at that point. |
| **More** | Position and target as x, y, z. |
| **Delete** | Delete the selected keys. |

- Typed values apply on Enter or when you leave the field. Escape closes the editor and drops the typed value.
- Eye height for Pick Position is the [Fix Path](fix-path.md) eye height.
- Picking: Escape cancels. "Nothing found there. Try another spot." means the click hit no surface; nothing changes.
- Editing a detour key turns it into your own key, so Fix Path keeps it.
- Balance does not rerun by itself. Click **Balance** after editing.
- A time past the end of the shot is refused: "Keys must stay inside the shot".

## Several keys

- The editor shows "N keys". Fields where the keys differ are blank.
- A typed value applies to all selected keys.
- Time or frame: the earliest selected key goes there, the others keep their spacing.
- **Update to View**, **Pick** and position/target need a single key.

## Delete

- Delete or Backspace removes the selected keys when your last click was on a key (tile, marker, 3D camera or the editor).
- After a click in the scene, Delete removes selected splats as before. Keys stay.
- While typing in an editor field, Delete and Backspace edit the text.

## Look ahead

For a key with **Look Ahead** on, on the way from the previous key:

1. The camera turns from the previous key's view to the direction of travel.
2. It faces forward, tilting only a little on slopes and stairs.
3. Over the last **Turn-in** seconds it turns into the key's own view.

- The camera path stays where it is. Only the view changes.
- **Turn-in** is a minimum. Click **Balance** after turning look ahead on: it gives large turns more time, so they stay at most 20°/s where **Total Frames** allows.
- On a short stretch between two keys there is no time to face forward: the turns take all of it.
- The forward direction itself turns at most 20°/s, so on sharp bends it lags behind the travel direction.
- The look ticks along the 3D path show where the camera looks.
- Video, HTML viewer export and Publish show the same view.

## Undo

- Every edit, move, copy, pick and delete is one ⌘Z / Ctrl+Z.
