# Objects

The **Objects** section of the Scene Manager lists objects detected in a splat: pews, windows, doors and so on. Click one to select its Gaussians.

## Load objects

1. Open the splat the objects were computed for.
2. Select it in the Scene Manager.
3. In **Objects**, click **Load…** and pick its `*.objects.json` file.

- The file must be made for this splat file. A file for a different number of Gaussians is refused with a message.
- Objects files come from `objects_export.py` in the voice-decision project.
- Each splat keeps its own objects. The list shows those of the splat selected in the Scene Manager.

## Use the list

- Objects are grouped by name, larger groups first. Walls, floors and ceilings come last. Click the arrow to open a group.
- **Click**: select the object's Gaussians. **Shift+click**: add to the selection; on a row that is already selected, remove it.
- Rows follow the selection however it was made (brush, Select None, undo). Fully selected rows are highlighted, partly selected ones dimmer.
- **Double-click**: select and move the camera to it (like **F**).
- **Eye**: hide or show the object. On a group: all its objects. Ctrl+Z undoes it. A dim eye means partly hidden.
- The number on the right is the object's Gaussian count in the file; it does not change after deletes.
- Hover a name for details: the segmenter's class and the closest words found for the object.

## Limits

- Names are the segmenter's classes (ScanNet's 200 indoor classes), so they can be wrong in other places: church pews show up as "couch".
- A project saved as `.ssproj` and reopened stores the Gaussians in another order; load objects on the original splat file.
