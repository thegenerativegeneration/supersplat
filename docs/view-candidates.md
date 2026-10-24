# Suggest Views

Suggest Views looks at your scene and proposes camera views. No photos needed. You pick the ones you like, and the picks become camera keys.

## Before you start

- Straighten the scene first. The tool uses the current orientation. If the scene looks tilted, the setup shows "The scene looks tilted by about N°. Straighten it first to get level views."
- Hidden and locked splats are ignored.

## Setup

1. Click **Suggest Views** (next to the timeline controls). The **Suggested Views** panel opens.
2. Check the **Area** box in the 3D view. It is proposed for you. Views are only suggested inside it.
   - Use the move and resize buttons next to **Area** to adjust it, then drag the gizmo.
   - **Reset** goes back to the proposed box.
3. Check **Eye height**. It is estimated from the scene (camera height above the floor, in scene units). Type a new value if it looks wrong.
   - **Preview** shows the view from eye height at the centre of the area. Click it again to go back to your view.
4. Optional, all off by default and being compared with the standard behaviour:
   - **Align views to walls (new)**: points views along and across the walls instead of fixed compass directions. Rooms without clear walls keep the fixed directions.
   - **Prefer open views (new)**: ranks views that see more of the space higher.
   - **Density solid space (new)**: decides what is solid the way the published viewer's walk collision does: faint splats add up and small floating clumps are ignored. Default off, being compared with the standard rule. Reads every splat, so it is slower on large scans. The setting is shared with [Fix Path](fix-path.md).
5. Click **Generate**.

## While it generates

- A progress bar shows "done / total".
- The 3D view goes dark and the editor is locked while the views render. Camera, selection and edits are blocked.
- Views appear in the panel as they are found.
- Click **Cancel** or press Escape to stop. You keep the views found so far, after near-duplicates are removed ("Cancelled. Showing the N views rendered so far.").
- **Close** is disabled until it finishes.

## Pick views

- Hover a view to preview it in the 3D view. Moving away restores your camera. Hover preview is off while the setup is shown.
- Click a view to pick it. The number on it is the pick order. Click it again to unpick.
- **Level** filters by floor when the scene has more than one level. It shows once generation is done.
- **Show 40 More** shows the next views.
- **Widen** makes the panel wider (click again to go back).
- **Clear** removes all picks.
- **New Search** goes back to the setup. Change the area or eye height and click **Generate** again.

## Add as Keys

1. Pick views.
2. Click **Add as Keys (N)**.

- The picks are added after the existing camera keys, in pick order.
- Balance then runs over all keys, so the camera moves at an even speed. See the [Balance timing guide](balance-timing.md).
- Total length stays the **Total Frames** value.
- The view then jumps to the pose of the current frame, same as Balance.
- One Ctrl+Z undoes it.
- If Balance can't fit the keys, they are still added and a **Couldn't Balance Timing** box explains why. See [Errors](balance-timing.md#errors).
- In that case the new keys sit at an even spacing after the old ones. With more picks than frames, some keys may sit past the end.
- If you change camera keys while Balance is working, nothing is added. A box says so, and your picks stay.

## Limits

- **Density solid space** reads every splat and is slower on large scans.
- **Align views to walls** needs clear walls. Holes in the scan can still look like doors or openings.
- Suggest Views does not check the camera path between keys for walls or floors. Use [Fix Path](fix-path.md) to route the camera around geometry, then play the shot to check.
- Small or cramped areas can give few or no suggestions ("No usable views found in the area." or "No floor found in the area. Check the area box and the eye height.").
- Suggestions are not saved in the project. They stay only in this browser session, until you generate again or reload. A changed scene needs a new setup.
