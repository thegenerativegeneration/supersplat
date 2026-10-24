import { Button, Container, Label, SelectInput } from '@playcanvas/pcui';

import type { LevelInfo } from '../candidates/generate';
import { PAGE_SIZE, busyInputAction, candidatePose, levelOptions, togglePick, visibleItems, type ViewPose } from '../candidates/panel-model';
import type { Scored } from '../candidates/score';
import { Events } from '../events';
import { Scene } from '../scene';
import { CandidatesSetup, type Prepared } from './candidates-setup';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

const BUDGET = 240;
const TOOL = 'candidatesSetup';

// input swallowed while generating (see busyInputAction), so nothing moves
// the camera or edits the scene between candidate renders
const BLOCKED_INPUT = ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'contextmenu', 'keydown'];

type Cell = { item: Scored, dom: HTMLDivElement, badge: HTMLSpanElement };

// Side panel for view candidates: setup, progress, thumbnail grid, picks.
class CandidatesPanel extends Container {
    setup: CandidatesSetup;

    constructor(events: Events, scene: Scene, tooltips: Tooltips) {
        super({ id: 'candidates-panel', class: 'panel', hidden: true });

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (event: Event) => event.stopPropagation());
        });

        // header
        const header = new Container({ class: 'panel-header' });
        const title = new Label({ class: 'panel-header-label' });
        i18n.bindText(title, 'candidates.title');
        const widenButton = new Button({ class: 'candidates-small-button' });
        i18n.bindText(widenButton, 'candidates.widen');
        const closeButton = new Button({ class: 'candidates-small-button' });
        i18n.bindText(closeButton, 'candidates.close');
        header.append(title);
        header.append(widenButton);
        header.append(closeButton);

        const setup = new CandidatesSetup(events, scene, tooltips);
        this.setup = setup;
        const editSetupButton = new Button({ class: 'candidates-small-button', hidden: true });
        i18n.bindText(editSetupButton, 'candidates.new-search');

        // progress
        const progressRow = new Container({ class: ['candidates-row', 'candidates-progress'], hidden: true });
        const bar = document.createElement('div');
        bar.className = 'candidates-bar';
        const barFill = document.createElement('div');
        barFill.className = 'candidates-bar-fill';
        bar.appendChild(barFill);
        const progressText = new Label({ class: 'candidates-progress-text' });
        const cancelButton = new Button({ class: 'candidates-small-button' });
        i18n.bindText(cancelButton, 'candidates.cancel');
        progressRow.dom.appendChild(bar);
        progressRow.append(progressText);
        progressRow.append(cancelButton);

        // filter and status
        const filterRow = new Container({ class: 'candidates-row', hidden: true });
        const filterLabel = new Label({ class: 'candidates-row-label' });
        i18n.bindText(filterLabel, 'candidates.level');
        const levelSelect = new SelectInput({ class: 'candidates-level-select', defaultValue: 'all' });
        filterRow.append(filterLabel);
        filterRow.append(levelSelect);
        const message = new Label({ class: 'candidates-message', hidden: true });

        // grid
        const grid = document.createElement('div');
        grid.className = 'candidates-grid';
        const moreButton = new Button({ class: 'candidates-small-button', hidden: true });

        // footer
        const footer = new Container({ class: ['candidates-row', 'candidates-footer'], hidden: true });
        const clearButton = new Button({ class: 'candidates-small-button' });
        i18n.bindText(clearButton, 'candidates.clear-picks');
        const addButton = new Button({ class: 'candidates-primary-button' });
        footer.append(clearButton);
        footer.append(addButton);

        this.append(header);
        this.append(setup);
        this.append(editSetupButton);
        this.append(progressRow);
        this.append(filterRow);
        this.append(message);
        this.dom.appendChild(grid);
        this.append(moreButton);
        this.append(footer);

        // state
        let prepared: Prepared | null = null;
        let running = false;
        let preparing = false;
        let abort: AbortController | null = null;
        let items: Scored[] = [];
        let streamed: Scored[] = [];
        let levels: LevelInfo[] = [];
        let level: number | null = null;
        let pages = 1;
        let picks: string[] = [];
        let seed = 1;
        let messageKey: string | null = null;
        let messageArgs: Record<string, unknown> = {};
        let moreCount = 0;
        const thumbs = new Map<string, HTMLCanvasElement>();
        let cells: Cell[] = [];

        const setupActive = () => events.invoke('tool.active') === TOOL;

        // hover preview: the user's view is saved on the first hover and restored on leave
        let hoverSaved: ViewPose | null = null;
        let hoverOrtho = false;
        // camera.getPose reads the camera entity, which otherwise only follows
        // a new pose on the next frame
        const setPose = (pose: ViewPose) => {
            events.fire('camera.setPose', pose, 0);
            scene.camera.onUpdate(0);
        };
        const previewItem = (item: Scored) => {
            // the area box would sit around the previewed view
            if (running || setupActive()) return;
            if (!hoverSaved) {
                events.fire('timeline.setPlaying', false);
                hoverSaved = events.invoke('camera.getPose');
                hoverOrtho = scene.camera.ortho;
            }
            setPose(candidatePose(item));
        };
        const endPreview = () => {
            if (hoverSaved) {
                setPose(hoverSaved);
                scene.camera.ortho = hoverOrtho;
                hoverSaved = null;
            }
        };

        const setMessage = (key: string | null, args: Record<string, unknown> = {}) => {
            messageKey = key;
            messageArgs = args;
            message.hidden = !key;
            if (key) message.text = i18n.t(key, args);
        };

        const updateBadges = () => {
            cells.forEach((cell) => {
                const order = picks.indexOf(cell.item.id);
                cell.dom.classList.toggle('picked', order >= 0);
                cell.badge.textContent = order >= 0 ? String(order + 1) : '';
            });
            addButton.text = i18n.t('candidates.add-keys', { count: picks.length });
            addButton.enabled = !running && picks.length > 0;
            closeButton.enabled = !running;
            clearButton.enabled = !running && picks.length > 0;
            footer.hidden = items.length === 0 && !running;
        };

        const createCell = (item: Scored): Cell => {
            const dom = document.createElement('div');
            dom.className = 'candidates-cell';
            const thumb = thumbs.get(item.id);
            if (thumb) dom.appendChild(thumb);
            const badge = document.createElement('span');
            badge.className = 'candidates-badge';
            dom.appendChild(badge);
            dom.addEventListener('mouseenter', () => previewItem(item));
            dom.addEventListener('mouseleave', endPreview);
            dom.addEventListener('click', () => {
                if (running) return;
                picks = togglePick(picks, item.id);
                updateBadges();
            });
            return { item, dom, badge };
        };

        const renderGrid = () => {
            const source = running ? streamed : items;
            const { shown, more } = visibleItems(source, running ? null : level, pages);
            cells = shown.map(createCell);
            grid.replaceChildren(...cells.map(c => c.dom));
            grid.classList.toggle('pending', running);
            moreCount = Math.min(more, PAGE_SIZE);
            moreButton.hidden = more === 0;
            moreButton.text = i18n.t('candidates.show-more', { count: moreCount });
            filterRow.hidden = running || levelOptions(levels, items).length < 2;
            updateBadges();
        };

        const updateLevelOptions = () => {
            levelSelect.options = [
                { v: 'all', t: i18n.t('candidates.all-levels') },
                ...levelOptions(levels, items).map(l => ({
                    v: String(l.index),
                    t: i18n.t('candidates.level-option', { number: l.number, height: l.height.toFixed(1) })
                }))
            ];
            levelSelect.value = level === null ? 'all' : String(level);
        };

        const block = (event: Event) => {
            const target = event.target as Node;
            const action = busyInputAction({
                type: event.type,
                key: (event as KeyboardEvent).key,
                inPanel: this.dom.contains(target),
                onCancel: cancelButton.dom.contains(target)
            });
            if (action === 'pass') return;
            if (action === 'cancel') abort?.abort();
            event.stopPropagation();
            event.preventDefault();
        };
        const setInputBlocked = (blocked: boolean) => {
            // a focused control would otherwise be the target of key presses
            if (blocked) (document.activeElement as HTMLElement)?.blur?.();
            BLOCKED_INPUT.forEach((name) => {
                if (blocked) {
                    window.addEventListener(name, block, { capture: true, passive: false });
                } else {
                    window.removeEventListener(name, block, { capture: true });
                }
            });
            document.body.classList.toggle('candidates-busy', blocked);
        };

        const openSetup = () => {
            if (!setupActive()) events.fire(`tool.${TOOL}`);
        };

        const closeSetup = () => {
            if (setupActive()) events.fire('tool.deactivate');
        };

        const generate = async () => {
            if (running) return;
            const { box, eyeHeight } = setup.values();
            endPreview();
            closeSetup();
            events.fire('timeline.setPlaying', false);

            running = true;
            abort = new AbortController();
            items = [];
            streamed = [];
            picks = [];
            levels = [];
            level = null;
            pages = 1;
            thumbs.clear();
            setMessage(null);
            barFill.style.width = '0%';
            progressText.text = '';
            progressRow.hidden = false;
            editSetupButton.hidden = true;
            setInputBlocked(true);
            renderGrid();

            let reason: string | undefined;
            let failure: any = null;
            const onDone = events.on('candidates.done', (count: number, r?: string) => {
                reason = r;
            });
            try {
                items = await events.invoke('candidates.generate', { box, eyeHeight, budget: BUDGET, seed: seed++ }, abort.signal);
                if (reason === 'noLevels') {
                    setMessage('candidates.noLevels');
                } else if (reason === 'cancelled') {
                    setMessage('candidates.cancelled', { count: items.length });
                } else if (items.length === 0) {
                    setMessage('candidates.none');
                }
            } catch (error) {
                items = [];
                failure = error;
            } finally {
                onDone.off();
                running = false;
                abort = null;
                setInputBlocked(false);
                progressRow.hidden = true;
                editSetupButton.hidden = false;
                streamed = [];
                updateLevelOptions();
                renderGrid();
            }
            // after unblocking input, so the popup can be dismissed
            if (failure) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('candidates.failed'),
                    message: String(failure?.message ?? failure)
                });
            }
        };

        const close = () => {
            if (running || preparing) return;
            endPreview();
            closeSetup();
            this.hidden = true;
        };

        const open = async () => {
            if (running || preparing) return;
            this.hidden = false;
            if (!prepared) {
                preparing = true;
                events.fire('startSpinner');
                try {
                    prepared = await events.invoke('candidates.prepare');
                } catch (error) {
                    prepared = null;
                    await events.invoke('showPopup', {
                        type: 'error',
                        header: i18n.t('candidates.failed'),
                        message: String(error?.message ?? error)
                    });
                } finally {
                    preparing = false;
                    events.fire('stopSpinner');
                }
                if (!prepared || prepared.points === 0) {
                    if (prepared) {
                        await events.invoke('showPopup', {
                            type: 'error',
                            header: i18n.t('candidates.failed'),
                            message: i18n.t('candidates.no-points')
                        });
                    }
                    prepared = null;
                    this.hidden = true;
                    return;
                }
                setup.load(prepared);
            }
            openSetup();
        };

        // a changed scene needs a new proposal next time the panel opens
        const forget = () => {
            if (!running) prepared = null;
        };
        ['scene.elementAdded', 'scene.elementRemoved', 'splat.moved'].forEach(name => events.on(name, (element?: { type?: string }) => {
            if (!element?.type || element.type === 'splat') forget();
        }));

        events.on('candidates.open', () => (this.hidden ? open() : close()));
        events.on(`tool.${TOOL}.deactivated`, () => {
            editSetupButton.hidden = running || this.hidden;
        });
        events.on(`tool.${TOOL}.activated`, () => {
            editSetupButton.hidden = true;
        });

        events.on('candidates.levels', (l: LevelInfo[]) => {
            levels = l;
        });
        events.on('candidates.progress', (done: number, total: number) => {
            barFill.style.width = `${total > 0 ? Math.round(100 * done / total) : 0}%`;
            progressText.text = i18n.t('candidates.progress', { done, total });
        });
        events.on('candidates.added', (item: Scored, thumbnail: HTMLCanvasElement) => {
            if (!running) return;
            thumbs.set(item.id, thumbnail);
            streamed.push(item);
            const { shown } = visibleItems(streamed, null, pages);
            if (shown.length === streamed.length) {
                const cell = createCell(item);
                cells.push(cell);
                grid.appendChild(cell.dom);
            } else {
                moreButton.hidden = true;
            }
        });

        setup.onGenerate = generate;
        editSetupButton.on('click', open);
        cancelButton.on('click', () => abort?.abort());
        closeButton.on('click', close);
        widenButton.on('click', () => {
            this.class[this.class.contains('wide') ? 'remove' : 'add']('wide');
            widenButton.class[this.class.contains('wide') ? 'add' : 'remove']('active');
        });
        levelSelect.on('change', (value: string) => {
            level = value === 'all' ? null : Number(value);
            pages = 1;
            if (!running) renderGrid();
        });
        moreButton.on('click', () => {
            pages++;
            renderGrid();
        });
        clearButton.on('click', () => {
            picks = [];
            updateBadges();
        });
        addButton.on('click', async () => {
            if (running || picks.length === 0) return;
            const byId = new Map(items.map(i => [i.id, i]));
            const views = picks.map(id => byId.get(id)).filter(Boolean).map(i => ({
                position: i.position, direction: i.direction, fov: i.fov, depth: i.depth
            }));
            endPreview();
            addButton.enabled = false;
            try {
                const before = (events.invoke('camera.poses') as unknown[]).length;
                await events.invoke('views.addKeys', views);
                // keep the picks when nothing was appended (keys changed meanwhile)
                if ((events.invoke('camera.poses') as unknown[]).length > before) picks = [];
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('candidates.failed'),
                    message: String(error?.message ?? error)
                });
            } finally {
                updateBadges();
            }
        });

        i18n.onChange(() => {
            updateLevelOptions();
            if (messageKey) message.text = i18n.t(messageKey, messageArgs);
            moreButton.text = i18n.t('candidates.show-more', { count: moreCount });
            updateBadges();
        }, this);

        tooltips.register(widenButton, () => i18n.t('tooltip.candidates.widen'), 'bottom');
        tooltips.register(addButton, () => i18n.t('tooltip.candidates.add-keys'), 'top');

        updateLevelOptions();
        updateBadges();
    }
}

export { CandidatesPanel };
