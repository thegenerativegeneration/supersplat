# Objects

The **Objects** section of the Scene Manager lists objects detected in a splat: pews, windows, doors and so on. Click one to select its Gaussians.

## Load objects

1. Open the splat the objects were computed for.
2. Select it in the Scene Manager.
3. In **Objects**, click **Load…** and pick its `*.objects.json` file.

- The file must be made for this splat file. A file for a different number of Gaussians is refused with a message.
- Objects files come from `objects_export.py` in the voice-decision project.
- Each splat keeps its own objects. The list shows those of the splat selected in the Scene Manager.
- Load several objects files to compare them: the dropdown under **Load…** switches between them. Loading a file with the same name again replaces it. Hidden parts stay hidden when you switch (show them again before switching to compare).

## Use the list

- Objects are grouped by name, larger groups first. Walls, floors and ceilings come last. Click the arrow to open a group.
- **Click**: select the object's Gaussians. **Shift+click**: add to the selection; on a row that is already selected, remove it.
- Rows follow the selection however it was made (brush, Select None, undo). Fully selected rows are highlighted, partly selected ones dimmer.
- **Double-click**: select and move the camera to it (like **F**).
- **Eye**: hide or show the object. On a group: all its objects. Ctrl+Z undoes it. A dim eye means partly hidden.
- The number on the right is the object's Gaussian count in the file; it does not change after deletes.
- Hover a name for details: how many pieces were merged into it, the segmenter's class, and names from other methods.

## Mark objects (seeds)

Seeds are single points, one per object, used to measure how well objects are detected (for example one per pew).

1. Select the splat in the Scene Manager.
2. Under the objects list, click **Mark**. Each click on the splat now places a seed (an orange dot).
3. Type a note next to a seed if you are unsure (e.g. "connected to the next pew").
4. Click **Mark** again to stop. **×** removes a seed.
5. Click **Save…** to download `<splat name>.seeds.json`.

- Seeds are kept in the browser per splat file, so reloading the page does not lose them.
- **Clear** removes all seeds (click twice).

## Limits

- Names come from pictures of each object matched against a word list (about 1,200 everyday words). Things missing from the list get the nearest word: a wall plaque may show up as "mail slot".
- Objects are often only part of a thing (half a pew, a piece of ceiling). Neighbouring pieces with the same name are merged; sometimes two separate things get merged too.
- A project saved as `.ssproj` and reopened stores the Gaussians in another order; load objects on the original splat file.
