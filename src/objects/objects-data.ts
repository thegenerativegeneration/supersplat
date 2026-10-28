// Detected objects of a splat, as written by voice-decision's objects_export.py: per object a name, the segmenter's
// class, a box and its Gaussians (one object id per row of the PLY the objects were computed for).

type SceneObject = {
    id: number;
    name: string;
    // the segmenter's class and the closest words by language feature, with their cosine
    cls: string | null;
    alt: [string, number][];
    structure: boolean;
    count: number;
    min: [number, number, number];
    max: [number, number, number];
};

type ObjectsData = {
    file: string;
    segmenter: string;
    objects: SceneObject[];
    // object id per source row of the splat, -1 = none
    inst: Int32Array;
};

const decodeInst = (base64: string, n: number) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (bytes.length !== n * 4) {
        throw new Error(`object ids for ${bytes.length / 4} Gaussians, file has ${n}`);
    }
    // little-endian int32, as written; copy to an aligned buffer
    const view = new DataView(bytes.buffer);
    const inst = new Int32Array(n);
    for (let i = 0; i < n; ++i) {
        inst[i] = view.getInt32(i * 4, true);
    }
    return inst;
};

const parseObjects = (text: string): ObjectsData => {
    const json = JSON.parse(text);
    if (!Array.isArray(json.objects) || typeof json.inst !== 'string' || typeof json.n !== 'number') {
        throw new Error('not an objects file');
    }
    return {
        file: json.file ?? '',
        segmenter: json.segmenter ?? '',
        objects: json.objects,
        inst: decodeInst(json.inst, json.n)
    };
};

export { parseObjects, ObjectsData, SceneObject };
