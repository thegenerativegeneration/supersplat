import {
    PRIMITIVE_LINES,
    SEMANTIC_COLOR,
    SEMANTIC_POSITION,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { buildCameraCurve } from './anim/camera-curve';
import { Pose } from './camera-poses';
import { Element, ElementType } from './element';
import type { PathMarkers } from './fix-path-events';
import { poseColors, samplePathLine } from './path-line';
import { vertexShader, fragmentShader } from './shaders/debug-shader';

// temp vectors for frustum geometry calculation (module-scope to avoid allocations)
const tmpForward = new Vec3();
const tmpRight = new Vec3();
const tmpUp = new Vec3();
const tmpBase = new Vec3();
const tmpTL = new Vec3();
const tmpTR = new Vec3();
const tmpBL = new Vec3();
const tmpBR = new Vec3();
const tmpUpTip = new Vec3();

// lines per camera icon: 4 pyramid + 4 base rect + 2 up indicator = 10
const LINES_PER_CAMERA = 10;
const VERTS_PER_CAMERA = LINES_PER_CAMERA * 2;

// line segments per span between two keys
const PATH_SAMPLES = 24;

class CameraPoseGizmos extends Element {
    entity: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    pathEntity: Entity;
    pathMesh: Mesh;
    blocked: number[] = [];
    unreachable: string[] = [];
    dirty = true;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'cameraPoseGizmoMaterial',
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_color: SEMANTIC_COLOR
            },
            vertexWGSL: vertexShader,
            fragmentWGSL: fragmentShader
        });
        this.material.depthWrite = true;
        this.material.depthTest = true;
        this.material.update();

        this.mesh = new Mesh(device);
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.cull = false;

        this.entity = new Entity('cameraPoseGizmos');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.worldLayer.id]
        });

        scene.app.root.addChild(this.entity);

        this.pathMesh = new Mesh(device);
        this.pathMesh.primitive[0] = { baseVertex: 0, type: PRIMITIVE_LINES, base: 0, count: 0 };
        const pathInstance = new MeshInstance(this.pathMesh, this.material, null);
        pathInstance.cull = false;
        this.pathEntity = new Entity('cameraPath');
        this.pathEntity.addComponent('render', { meshInstances: [pathInstance], layers: [scene.worldLayer.id] });
        scene.app.root.addChild(this.pathEntity);

        // mark dirty when poses or scene bound change
        const markDirty = () => {
            this.dirty = true;
            if (scene.events.invoke('camera.showPoses')) {
                scene.forceRender = true;
            }
        };
        const { events } = scene;
        events.on('track.keyAdded', markDirty);
        events.on('track.keyRemoved', markDirty);
        events.on('track.keyMoved', markDirty);
        events.on('track.keyUpdated', markDirty);
        events.on('track.keysCleared', markDirty);
        events.on('track.keysLoaded', markDirty);
        events.on('scene.boundChanged', markDirty);
        events.on('timeline.smoothness', markDirty);
        events.on('timeline.loop', markDirty);
        events.on('timeline.frames', markDirty);
        events.on('path.markers', (markers: PathMarkers) => {
            this.blocked = markers.blocked;
            this.unreachable = markers.unreachable;
            markDirty();
        });
    }

    destroy() {
        this.entity?.destroy();
        this.pathEntity?.destroy();
    }

    onPreRender() {
        const { scene } = this;
        const visible = scene.events.invoke('camera.showPoses') && scene.camera.renderOverlays;

        if (visible && this.dirty) {
            this.dirty = false;
            this.rebuildMesh();
            this.rebuildPath();
        }

        // with no poses the mesh has never been given a vertex buffer, and a
        // count-0 non-instanced draw is still submitted and still validates its
        // attributes - so stay disabled until there is geometry
        this.entity.enabled = visible && this.mesh.primitive[0].count > 0;
        this.pathEntity.enabled = visible && this.pathMesh.primitive[0].count > 0;
    }

    // the camera curve as lines, coloured per segment
    private rebuildPath() {
        const { events } = this.scene;
        const poses = events.invoke('camera.poses') as Pose[];
        const duration = events.invoke('timeline.frames') as number;
        const loop = events.invoke('timeline.loop') as boolean;
        const frames = poses.map(p => p.frame);
        const curve = buildCameraCurve(poses.map(p => ({ ...p, fov: p.fov ?? 60 })), frames, {
            duration, smoothness: events.invoke('timeline.smoothness'), loop
        });
        if (!curve) {
            this.pathMesh.primitive[0].count = 0;
            return;
        }

        const { positions, colors } = samplePathLine(curve, frames, {
            samplesPerSegment: PATH_SAMPLES,
            blocked: this.blocked,
            auto: poses.map(p => !!p.auto),
            loop,
            duration
        });
        const rgba = new Uint8Array(positions.length / 3 * 4);
        for (let i = 0; i < positions.length / 3; i++) {
            for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(colors[i * 3 + c] * 255);
            rgba[i * 4 + 3] = 255;
        }
        this.pathMesh.setPositions(positions);
        this.pathMesh.setColors32(rgba);
        this.pathMesh.update(PRIMITIVE_LINES);
    }

    private rebuildMesh() {
        const poses = this.scene.events.invoke('camera.poses') as Pose[];
        if (!poses || poses.length === 0) {
            this.mesh.primitive[0].count = 0;
            return;
        }

        const depth = 0.08;
        const halfW = 0.06;
        const halfH = 0.04;

        const numVerts = poses.length * VERTS_PER_CAMERA;
        const positions: number[] = [];
        const colors = new Uint8Array(numVerts * 4);

        const pushLine = (a: Vec3, b: Vec3) => {
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        };

        for (const pose of poses) {
            const { position, target } = pose;

            // forward direction
            tmpForward.sub2(target, position).normalize();

            // right direction (handle degenerate case when looking straight up/down)
            if (Math.abs(tmpForward.y) > 0.999) {
                tmpRight.cross(tmpForward, Vec3.BACK).normalize();
            } else {
                tmpRight.cross(tmpForward, Vec3.UP).normalize();
            }

            // up direction
            tmpUp.cross(tmpRight, tmpForward);

            // base center (in front of camera position)
            tmpBase.copy(position).addScaled(tmpForward, depth);

            // frustum corners
            tmpTL.copy(tmpBase).addScaled(tmpUp, halfH).addScaled(tmpRight, -halfW);
            tmpTR.copy(tmpBase).addScaled(tmpUp, halfH).addScaled(tmpRight, halfW);
            tmpBL.copy(tmpBase).addScaled(tmpUp, -halfH).addScaled(tmpRight, -halfW);
            tmpBR.copy(tmpBase).addScaled(tmpUp, -halfH).addScaled(tmpRight, halfW);

            // pyramid edges from position to corners
            pushLine(position, tmpTL);
            pushLine(position, tmpTR);
            pushLine(position, tmpBL);
            pushLine(position, tmpBR);

            // base rectangle
            pushLine(tmpTL, tmpTR);
            pushLine(tmpTR, tmpBR);
            pushLine(tmpBR, tmpBL);
            pushLine(tmpBL, tmpTL);

            // up indicator triangle
            tmpUpTip.copy(tmpBase).addScaled(tmpUp, halfH * 1.5);
            pushLine(tmpTL, tmpUpTip);
            pushLine(tmpTR, tmpUpTip);
        }

        // per camera: unreachable and parked keys red, detour keys in the auto colour
        poseColors(poses, this.unreachable, this.scene.events.invoke('timeline.frames')).forEach((rgb, p) => {
            for (let i = p * VERTS_PER_CAMERA; i < (p + 1) * VERTS_PER_CAMERA; i++) {
                for (let c = 0; c < 3; c++) colors[i * 4 + c] = Math.round(rgb[c] * 255);
                colors[i * 4 + 3] = 255;
            }
        });

        this.mesh.setPositions(positions);
        this.mesh.setColors32(colors);
        this.mesh.update(PRIMITIVE_LINES);
    }
}

export { CameraPoseGizmos };
