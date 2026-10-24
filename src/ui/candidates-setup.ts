import { Button, Container, Label, NumericInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { BoxShape } from '../box-shape';
import type { Box } from '../candidates/estimate';
import { eyePreviewPose, showTiltWarning, type ViewPose } from '../candidates/panel-model';
import { Events } from '../events';
import { Scene } from '../scene';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { ShapeTransformGizmo } from '../tools/shape-transform-gizmo';

type Prepared = { box: Box, eyeHeight: number, tiltDeg: number, points: number };

// Area box, eye height and tilt warning shown before generating. Works as an
// editor tool: while active, the area box and its move/resize gizmo are in
// the scene.
class CandidatesSetup extends Container {
    activate: () => void;
    deactivate: () => void;
    setTransformMode: (mode: 'translate' | 'rotate' | 'scale') => boolean;
    getFocus: () => { position: Vec3, radius: number } | null;
    load: (prepared: Prepared) => void;
    values: () => { box: Box, eyeHeight: number };
    stopPreview: () => void;
    onGenerate: () => void = null;

    constructor(events: Events, scene: Scene, tooltips: Tooltips) {
        super({ class: 'candidates-setup' });

        const box = new BoxShape();
        let prepared: Prepared | null = null;
        let active = false;
        let loading = false;

        const row = (cls?: string) => new Container({ class: ['candidates-row', ...(cls ? [cls] : [])] });

        // area
        const areaRow = row();
        const areaLabel = new Label({ class: 'candidates-row-label' });
        i18n.bindText(areaLabel, 'candidates.area');
        const moveButton = new Button({ class: 'candidates-icon-button', icon: 'E111' });
        const scaleButton = new Button({ class: 'candidates-icon-button', icon: 'E112' });
        const resetButton = new Button({ class: 'candidates-small-button' });
        i18n.bindText(resetButton, 'candidates.reset-area');
        areaRow.append(areaLabel);
        areaRow.append(moveButton);
        areaRow.append(scaleButton);
        areaRow.append(resetButton);

        // eye height
        const eyeRow = row();
        const eyeLabel = new Label({ class: 'candidates-row-label' });
        i18n.bindText(eyeLabel, 'candidates.eye-height');
        const eyeInput = new NumericInput({ class: 'candidates-eye-input', min: 0.01, step: 0.05, precision: 2, value: 1.6 });
        const previewButton = new Button({ class: 'candidates-small-button' });
        i18n.bindText(previewButton, 'candidates.preview');
        eyeRow.append(eyeLabel);
        eyeRow.append(eyeInput);
        eyeRow.append(previewButton);

        // tilt
        const tiltRow = row('candidates-warning');
        const tiltLabel = new Label({ class: 'candidates-warning-text' });
        tiltRow.append(tiltLabel);
        tiltRow.hidden = true;

        const generateButton = new Button({ class: 'candidates-primary-button' });
        i18n.bindText(generateButton, 'candidates.generate');

        this.append(areaRow);
        this.append(eyeRow);
        this.append(tiltRow);
        this.append(generateButton);

        const gizmo = new ShapeTransformGizmo(events, scene, {
            rotate: false,
            uniformScale: false,
            lowerBoundScale: new Vec3(0.01, 0.01, 0.01),
            onTransformStart: () => {},
            onTransform: (mode) => {
                if (mode === 'scale') {
                    const { x, y, z } = box.pivot.getLocalScale();
                    box.lenX = x;
                    box.lenY = y;
                    box.lenZ = z;
                } else {
                    box.moved();
                }
            },
            onTransformEnd: () => {},
            onModeChanged: (mode) => {
                moveButton.class[mode === 'translate' ? 'add' : 'remove']('active');
                scaleButton.class[mode === 'scale' ? 'add' : 'remove']('active');
            }
        });

        const setBox = (b: Box) => {
            box.pivot.setPosition((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
            box.lenX = Math.max(0.01, b.max.x - b.min.x);
            box.lenY = Math.max(0.01, b.max.y - b.min.y);
            box.lenZ = Math.max(0.01, b.max.z - b.min.z);
            box.moved();
        };

        const getBox = (): Box => {
            const p = box.pivot.getPosition();
            const h = { x: box.lenX / 2, y: box.lenY / 2, z: box.lenZ / 2 };
            return {
                min: { x: p.x - h.x, y: p.y - h.y, z: p.z - h.z },
                max: { x: p.x + h.x, y: p.y + h.y, z: p.z + h.z }
            };
        };

        // eye height preview: the user's view is saved on start and restored on stop
        let saved: ViewPose | null = null;

        const showBox = (show: boolean) => {
            const inScene = !!box.scene;
            if (show && !inScene) {
                scene.add(box);
                gizmo.attach(box.pivot);
            } else if (!show && inScene) {
                gizmo.detach();
                scene.remove(box);
            }
        };

        // camera.getPose reads the camera entity, which otherwise only follows
        // a new pose on the next frame
        const setPose = (pose: ViewPose) => {
            events.fire('camera.setPose', pose, 0);
            scene.camera.onUpdate(0);
        };

        const applyPreview = () => {
            const pose = eyePreviewPose(getBox(), eyeInput.value, saved.fov);
            setPose(pose);
        };

        const startPreview = () => {
            if (!saved) {
                events.fire('timeline.setPlaying', false);
                saved = events.invoke('camera.getPose');
                previewButton.class.add('active');
                // the box seen from inside hides the view
                showBox(false);
            }
            applyPreview();
        };

        this.stopPreview = () => {
            if (saved) {
                setPose(saved);
                saved = null;
                previewButton.class.remove('active');
                showBox(active);
            }
        };

        previewButton.on('click', () => (saved ? this.stopPreview() : startPreview()));
        eyeInput.on('change', (value: number) => {
            if (active && !loading && Number.isFinite(value) && value > 0) startPreview();
        });

        moveButton.on('click', () => gizmo.toggleMode('translate'));
        scaleButton.on('click', () => gizmo.toggleMode('scale'));
        resetButton.on('click', () => prepared && setBox(prepared.box));
        generateButton.on('click', () => this.onGenerate?.());

        this.load = (p: Prepared) => {
            prepared = p;
            setBox(p.box);
            loading = true;
            eyeInput.value = Number(p.eyeHeight.toFixed(2));
            loading = false;
            tiltRow.hidden = !showTiltWarning(p.tiltDeg);
            tiltLabel.text = i18n.t('candidates.tilt-warning', { degrees: Math.round(p.tiltDeg) });
        };

        this.values = () => ({ box: getBox(), eyeHeight: eyeInput.value });

        this.activate = () => {
            active = true;
            this.hidden = false;
            if (gizmo.mode === 'none') gizmo.setMode('translate');
            showBox(true);
        };

        this.deactivate = () => {
            this.stopPreview();
            eyeInput.blur();
            active = false;
            this.hidden = true;
            showBox(false);
        };

        this.setTransformMode = (mode) => {
            if (mode !== 'rotate') gizmo.toggleMode(mode);
            return true;
        };

        this.getFocus = () => {
            const bound = box.worldBound;
            return { position: bound.center.clone(), radius: bound.halfExtents.length() };
        };

        i18n.onChange(() => {
            if (prepared) tiltLabel.text = i18n.t('candidates.tilt-warning', { degrees: Math.round(prepared.tiltDeg) });
        }, tiltLabel);

        tooltips.register(moveButton, () => i18n.t('tooltip.candidates.move-area'), 'top');
        tooltips.register(scaleButton, () => i18n.t('tooltip.candidates.resize-area'), 'top');
        tooltips.register(eyeInput, () => i18n.t('tooltip.candidates.eye-height'), 'top');
        tooltips.register(previewButton, () => i18n.t('tooltip.candidates.preview'), 'top');

        this.hidden = true;
    }
}

export { CandidatesSetup };
export type { Prepared };
