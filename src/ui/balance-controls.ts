import { Button, Container, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

const MIN_KEYS = 2;

// the Balance button and the rotation weight it balances with
class BalanceControls extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        super({
            ...args,
            id: 'balance-controls'
        });

        const rotationWeight = new NumericInput({
            id: 'rotation-weight',
            min: 0,
            max: 4,
            step: 0.1,
            precision: 1,
            value: events.invoke('timeline.rotationWeight') ?? 1
        });

        const button = new Button({
            id: 'balance',
            text: i18n.t('timeline.balance')
        });

        this.append(button);
        this.append(rotationWeight);

        let busy = false;

        const updateEnabled = () => {
            const keys = events.invoke('track.keys') as number[] ?? [];
            button.enabled = !busy && keys.length >= MIN_KEYS;
        };

        button.on('click', async () => {
            if (busy) return;
            busy = true;
            updateEnabled();
            try {
                await events.invoke('timing.balance');
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.balance.failed'),
                    message: String(error?.message ?? error)
                });
            } finally {
                busy = false;
                updateEnabled();
            }
        });

        rotationWeight.on('change', (value: number) => {
            if (Number.isFinite(value)) {
                events.fire('timeline.setRotationWeight', value);
            }
        });

        events.on('timeline.rotationWeight', (value: number) => {
            rotationWeight.value = value;
        });

        ['keyAdded', 'keyRemoved', 'keyMoved', 'keyUpdated', 'keysLoaded', 'keysCleared'].forEach((name) => {
            events.on(`track.${name}`, updateEnabled);
        });
        updateEnabled();

        tooltips.register(button, () => i18n.t('tooltip.timeline.balance'), 'top');
        tooltips.register(rotationWeight, () => i18n.t('tooltip.timeline.rotation-weight'), 'top');
    }
}

export { BalanceControls };
