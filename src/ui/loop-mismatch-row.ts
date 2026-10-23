import { Button, Container, Label, SelectInput } from '@playcanvas/pcui';

import { LoopMode, loopModeMatchesTimeline } from '../anim/loop-mode';
import { Events } from '../events';
import { i18n } from './localization';

// warning row shown while the export loop mode disagrees with the timeline loop toggle
// (balanced timing is computed for the timeline's setting)
const createLoopMismatchRow = (events: Events, loopSelect: SelectInput, animationEnabled: () => boolean) => {
    const message = new Label({ class: 'loop-mismatch-message' });
    i18n.bindText(message, 'popup.export.loop-mismatch');

    const matchButton = new Button({ class: 'loop-mismatch-button' });
    i18n.bindText(matchButton, 'popup.export.loop-match');

    const row = new Container({ class: ['row', 'loop-mismatch-row'], hidden: true });
    row.append(message);
    row.append(matchButton);

    const update = () => {
        const timelineLoop = !!events.invoke('timeline.loop');
        row.hidden = !animationEnabled() || loopModeMatchesTimeline(loopSelect.value as LoopMode, timelineLoop);
    };

    matchButton.on('click', () => {
        loopSelect.value = events.invoke('timeline.loop') ? 'repeat' : 'none';
        update();
    });

    loopSelect.on('change', update);
    events.on('timeline.loop', update);

    return { row, update };
};

export { createLoopMismatchRow };
