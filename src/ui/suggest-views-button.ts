import { Button } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

// opens and closes the view candidates panel
class SuggestViewsButton extends Button {
    constructor(events: Events, tooltips: Tooltips) {
        super({ id: 'suggest-views' });
        i18n.bindText(this, 'candidates.suggest-views');
        this.on('click', () => events.fire('candidates.open'));
        tooltips.register(this, () => i18n.t('tooltip.candidates.suggest-views'), 'top');
    }
}

export { SuggestViewsButton };
