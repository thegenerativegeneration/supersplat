import {
    PRIMITIVE_LINES,
    SEMANTIC_COLOR,
    SEMANTIC_POSITION,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial
} from 'playcanvas';

import { Element, ElementType } from './element';
import { orbitPreviewLine, type OrbitPreview } from './orbit/orbit-preview-line';
import { vertexShader, fragmentShader } from './shaders/debug-shader';

// The orbit the Orbit popover would add, drawn as lines next to the camera
// path, shown like the path with the camera poses and overlays.
class OrbitPreviewLine extends Element {
    entity: Entity;
    mesh: Mesh;
    preview: OrbitPreview | null = null;
    dirty = false;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const { scene } = this;
        const material = new ShaderMaterial({
            uniqueName: 'orbitPreviewMaterial',
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_color: SEMANTIC_COLOR
            },
            vertexWGSL: vertexShader,
            fragmentWGSL: fragmentShader
        });
        material.depthWrite = true;
        material.depthTest = true;
        material.update();

        this.mesh = new Mesh(scene.graphicsDevice);
        this.mesh.primitive[0] = { baseVertex: 0, type: PRIMITIVE_LINES, base: 0, count: 0 };
        const instance = new MeshInstance(this.mesh, material, null);
        instance.cull = false;
        this.entity = new Entity('orbitPreview');
        this.entity.addComponent('render', { meshInstances: [instance], layers: [scene.worldLayer.id] });
        this.entity.enabled = false;
        scene.app.root.addChild(this.entity);

        scene.events.on('orbit.preview', (preview: OrbitPreview | null) => {
            this.preview = preview;
            this.dirty = true;
            scene.forceRender = true;
        });
    }

    destroy() {
        this.entity?.destroy();
    }

    onPreRender() {
        const { scene } = this;
        if (this.dirty) {
            this.dirty = false;
            this.rebuild();
        }
        const visible = scene.events.invoke('camera.showPoses') && scene.camera.renderOverlays;
        // a count-0 draw still validates its attributes, so stay off without lines
        this.entity.enabled = visible && !!this.preview && this.mesh.primitive[0].count > 0;
    }

    private rebuild() {
        if (!this.preview) {
            this.mesh.primitive[0].count = 0;
            return;
        }
        const { positions, colors } = orbitPreviewLine(this.preview);
        if (positions.length === 0) {
            this.mesh.primitive[0].count = 0;
            return;
        }
        const rgba = new Uint8Array(positions.length / 3 * 4);
        for (let i = 0; i < positions.length / 3; i++) {
            for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(colors[i * 3 + c] * 255);
            rgba[i * 4 + 3] = 255;
        }
        this.mesh.setPositions(positions);
        this.mesh.setColors32(rgba);
        this.mesh.update(PRIMITIVE_LINES);
    }
}

export { OrbitPreviewLine };
