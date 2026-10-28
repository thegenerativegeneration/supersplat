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

// per object (in the order of ObjectsData.objects): live, hidden and selected (not hidden) Gaussians
type ObjectsState = {
    total: Uint32Array;
    hidden: Uint32Array;
    selected: Uint32Array;
};

const decodeInst = (base64: string, n: number) => {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; ++i) bytes[i] = text.charCodeAt(i);
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
    const valid = (o: any) => typeof o.id === 'number' && typeof o.name === 'string' && typeof o.count === 'number' &&
        Array.isArray(o.alt);
    if (!Array.isArray(json.objects) || !json.objects.every(valid) || typeof json.inst !== 'string' ||
        typeof json.n !== 'number') {
        throw new Error('not an objects file');
    }
    return {
        file: json.file ?? '',
        segmenter: json.segmenter ?? '',
        objects: json.objects,
        inst: decodeInst(json.inst, json.n)
    };
};

export { parseObjects, ObjectsData, ObjectsState, SceneObject };
