import { Container, Label } from '@playcanvas/pcui';
import { Mat4, Quat, Vec3 } from 'playcanvas';

import { EntityTransformOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { Transform } from '../transform';
import { localize } from '../ui/localization';

const veca = new Vec3();
const vecd = new Vec3();

const mat = new Mat4();
const mat2 = new Mat4();
const mat3 = new Mat4();
const rotMat = new Mat4();

const quat = new Quat();

const isPrimary = (e: PointerEvent) => {
    return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
};

const averageEdgeLength = (a: Vec3, b: Vec3, c: Vec3) => {
    return (a.distance(b) + a.distance(c) + b.distance(c)) / 3;
};

const calcBasis = (p0: Vec3, p1: Vec3, p2: Vec3, u: Vec3, v: Vec3, w: Vec3) => {
    u.sub2(p1, p0);
    if (u.lengthSq() < 1e-10) {
        return false;
    }
    u.normalize();

    vecd.sub2(p2, p0);
    w.cross(u, vecd);
    if (w.lengthSq() < 1e-10) {
        return false;
    }
    w.normalize();

    v.cross(w, u);
    v.normalize();

    return true;
};

const buildRotation = (
    sourceU: Vec3,
    sourceV: Vec3,
    sourceW: Vec3,
    targetU: Vec3,
    targetV: Vec3,
    targetW: Vec3,
    out: Mat4
) => {
    const d = out.data;

    const c0x = targetU.x * sourceU.x + targetV.x * sourceV.x + targetW.x * sourceW.x;
    const c0y = targetU.y * sourceU.x + targetV.y * sourceV.x + targetW.y * sourceW.x;
    const c0z = targetU.z * sourceU.x + targetV.z * sourceV.x + targetW.z * sourceW.x;

    const c1x = targetU.x * sourceU.y + targetV.x * sourceV.y + targetW.x * sourceW.y;
    const c1y = targetU.y * sourceU.y + targetV.y * sourceV.y + targetW.y * sourceW.y;
    const c1z = targetU.z * sourceU.y + targetV.z * sourceV.y + targetW.z * sourceW.y;

    const c2x = targetU.x * sourceU.z + targetV.x * sourceV.z + targetW.x * sourceW.z;
    const c2y = targetU.y * sourceU.z + targetV.y * sourceV.z + targetW.y * sourceW.z;
    const c2z = targetU.z * sourceU.z + targetV.z * sourceV.z + targetW.z * sourceW.z;

    d[0] = c0x; d[1] = c0y; d[2] = c0z; d[3] = 0;
    d[4] = c1x; d[5] = c1y; d[6] = c1z; d[7] = 0;
    d[8] = c2x; d[9] = c2y; d[10] = c2z; d[11] = 0;
    d[12] = 0; d[13] = 0; d[14] = 0; d[15] = 1;
};

const solveSimilarity = (source: Vec3[], target: Vec3[], outTranslation: Vec3, outRotation: Quat, outScale: number) => {
    const su = new Vec3();
    const sv = new Vec3();
    const sw = new Vec3();
    const tu = new Vec3();
    const tv = new Vec3();
    const tw = new Vec3();

    if (!calcBasis(source[0], source[1], source[2], su, sv, sw)) {
        return { ok: false, scale: 1 };
    }

    if (!calcBasis(target[0], target[1], target[2], tu, tv, tw)) {
        return { ok: false, scale: 1 };
    }

    const sourceMetric = averageEdgeLength(source[0], source[1], source[2]);
    const targetMetric = averageEdgeLength(target[0], target[1], target[2]);

    if (sourceMetric <= 1e-8 || targetMetric <= 1e-8) {
        return { ok: false, scale: 1 };
    }

    const scale = targetMetric / sourceMetric;

    buildRotation(su, sv, sw, tu, tv, tw, rotMat);
    outRotation.setFromMat4(rotMat);

    rotMat.transformPoint(source[0], veca);
    veca.mulScalar(scale);
    outTranslation.copy(target[0]).sub(veca);

    return { ok: true, scale };
};

class Align3PointTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        let active = false;
        let clicked = false;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'align3pt-tool-svg';
        parent.appendChild(svg);

        const ns = svg.namespaceURI;

        const createMarker = (kind: 'source' | 'target', index: number) => {
            const circle = document.createElementNS(ns, 'circle') as SVGCircleElement;
            circle.classList.add(kind);

            const text = document.createElementNS(ns, 'text') as SVGTextElement;
            text.classList.add(kind);
            text.textContent = `${index + 1}`;

            svg.appendChild(circle);
            svg.appendChild(text);

            return { circle, text };
        };

        const sourceMarkers = [0, 1, 2].map(i => createMarker('source', i));
        const targetMarkers = [0, 1, 2].map(i => createMarker('target', i));

        let sourceSplat: Splat = null;
        let targetSplat: Splat = null;

        const sourcePoints: Vec3[] = [];
        const targetPoints: Vec3[] = [];

        const setMarkerVisible = (marker: { circle: SVGCircleElement, text: SVGTextElement }, visible: boolean) => {
            const value = visible ? 'visible' : 'hidden';
            marker.circle.setAttribute('visibility', value);
            marker.text.setAttribute('visibility', value);
        };

        const setMarkerPosition = (marker: { circle: SVGCircleElement, text: SVGTextElement }, x: number, y: number) => {
            marker.circle.setAttribute('cx', x.toString());
            marker.circle.setAttribute('cy', y.toString());
            marker.text.setAttribute('x', (x + 8).toString());
            marker.text.setAttribute('y', (y - 8).toString());
        };

        const hideMarkers = () => {
            [...sourceMarkers, ...targetMarkers].forEach((marker) => {
                setMarkerVisible(marker, false);
            });
        };

        const getPoint2d = (splat: Splat, localPoint: Vec3, result: Vec3) => {
            splat.worldTransform.transformPoint(localPoint, result);
            scene.camera.worldToScreen(result, result);
            result.x *= canvasContainer.dom.clientWidth;
            result.y *= canvasContainer.dom.clientHeight;
        };

        const updateMarkers = () => {
            if (!active) {
                hideMarkers();
                return;
            }

            for (let i = 0; i < 3; i++) {
                const sourceMarker = sourceMarkers[i];
                const targetMarker = targetMarkers[i];

                if (sourceSplat && i < sourcePoints.length) {
                    getPoint2d(sourceSplat, sourcePoints[i], veca);
                    setMarkerPosition(sourceMarker, veca.x, veca.y);
                    setMarkerVisible(sourceMarker, true);
                } else {
                    setMarkerVisible(sourceMarker, false);
                }

                if (targetSplat && i < targetPoints.length) {
                    getPoint2d(targetSplat, targetPoints[i], veca);
                    setMarkerPosition(targetMarker, veca.x, veca.y);
                    setMarkerVisible(targetMarker, true);
                } else {
                    setMarkerVisible(targetMarker, false);
                }
            }
        };

        events.on('postrender', updateMarkers);

        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        const promptLabel = new Label({
            text: ''
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        selectToolbar.append(promptLabel);
        canvasContainer.append(selectToolbar);

        const updatePrompt = () => {
            if (!sourceSplat) {
                promptLabel.text = localize('align.3pt.no-selection');
                return;
            }

            if (sourcePoints.length < 3) {
                promptLabel.text = `${localize('align.3pt.pick-source')} (${sourcePoints.length + 1}/3)`;
                return;
            }

            if (!targetSplat) {
                promptLabel.text = localize('align.3pt.pick-target-splat');
                return;
            }

            promptLabel.text = `${localize('align.3pt.pick-target')} (${targetPoints.length + 1}/3)`;
        };

        const reset = () => {
            sourceSplat = null;
            targetSplat = null;
            sourcePoints.length = 0;
            targetPoints.length = 0;
            updatePrompt();
            hideMarkers();
        };

        const collectLocalPoint = (splat: Splat, worldPoint: Vec3, out: Vec3[]) => {
            mat.invert(splat.worldTransform);
            mat.transformPoint(worldPoint, veca);
            out.push(veca.clone());
        };

        const applyAlignment = () => {
            const sw = [new Vec3(), new Vec3(), new Vec3()];
            const tw = [new Vec3(), new Vec3(), new Vec3()];

            for (let i = 0; i < 3; i++) {
                sourceSplat.worldTransform.transformPoint(sourcePoints[i], sw[i]);
                targetSplat.worldTransform.transformPoint(targetPoints[i], tw[i]);
            }

            const translation = new Vec3();
            const rotation = new Quat();
            const solved = solveSimilarity(sw, tw, translation, rotation, 1);

            if (!solved.ok) {
                events.invoke('showPopup', {
                    type: 'error',
                    header: localize('popup.error'),
                    message: localize('align.3pt.invalid-points')
                });
                return false;
            }

            mat.setTRS(translation, rotation, veca.set(solved.scale, solved.scale, solved.scale));
            mat2.copy(sourceSplat.worldTransform);
            mat3.mul2(mat, mat2);

            const entity = sourceSplat.entity;
            if (entity.parent) {
                mat2.invert(entity.parent.getWorldTransform());
                mat3.mul2(mat2, mat3);
            }

            const oldt = new Transform(
                entity.getLocalPosition(),
                entity.getLocalRotation(),
                entity.getLocalScale()
            );

            const p = mat3.getTranslation();
            const r = new Quat().setFromMat4(mat3);
            const s = mat3.getScale();

            sourceSplat.move(p, r, s);

            const newt = new Transform(
                entity.getLocalPosition(),
                entity.getLocalRotation(),
                entity.getLocalScale()
            );

            events.fire('edit.add', new EntityTransformOp({ splat: sourceSplat, oldt, newt }));

            return true;
        };

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
            }
        };

        const pointermove = () => {
            clicked = false;
        };

        const pointerup = async (e: PointerEvent) => {
            if (!active || !clicked || !isPrimary(e) || !sourceSplat) {
                clicked = false;
                return;
            }

            clicked = false;

            const rect = canvasContainer.dom.getBoundingClientRect();
            const nx = (e.clientX - rect.left) / Math.max(1, rect.width);
            const ny = (e.clientY - rect.top) / Math.max(1, rect.height);

            const result = await scene.camera.intersect(
                Math.min(1, Math.max(0, nx)),
                Math.min(1, Math.max(0, ny))
            );

            if (!result?.splat) {
                return;
            }

            const hitSplat = result.splat;

            if (sourcePoints.length < 3) {
                if (hitSplat !== sourceSplat) {
                    return;
                }
                collectLocalPoint(sourceSplat, result.position, sourcePoints);
                scene.forceRender = true;
                updatePrompt();
                return;
            }

            if (hitSplat === sourceSplat) {
                return;
            }

            if (!targetSplat) {
                targetSplat = hitSplat;
            }

            if (targetSplat !== hitSplat) {
                return;
            }

            if (targetPoints.length < 3) {
                collectLocalPoint(targetSplat, result.position, targetPoints);
                updatePrompt();
            }

            if (targetPoints.length === 3) {
                const success = applyAlignment();
                reset();
                if (success) {
                    events.fire('tool.deactivate');
                }
            }

            scene.forceRender = true;
            e.preventDefault();
            e.stopPropagation();
        };

        this.activate = () => {
            active = true;
            reset();
            sourceSplat = events.invoke('selection') as Splat;
            updatePrompt();

            if (!sourceSplat) {
                events.fire('tool.deactivate');
                return;
            }

            selectToolbar.hidden = false;
            parent.style.display = 'block';
            parent.classList.add('noevents');
            svg.classList.remove('hidden');

            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
        };

        this.deactivate = () => {
            active = false;
            reset();
            selectToolbar.hidden = true;
            parent.style.display = 'none';
            parent.classList.remove('noevents');
            svg.classList.add('hidden');

            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
        };
    }
}

export { Align3PointTool };