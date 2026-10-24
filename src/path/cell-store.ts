const CHUNK_BITS = 4;
const CHUNK = 1 << CHUNK_BITS;
const MASK = CHUNK - 1;

// 16-bit value per lattice cell of an nx x ny x nz block (local coordinates
// from 0), stored in lazily allocated 16^3 chunks so memory follows the
// cells actually touched. Unset cells read as 0.
class CellStore {
    private chunks = new Map<number, Uint16Array>();

    private cnx: number;

    private cnz: number;

    private lastKey = -1;

    private lastChunk: Uint16Array | null = null;

    constructor(nx: number, nz: number) {
        this.cnx = (nx >> CHUNK_BITS) + 1;
        this.cnz = (nz >> CHUNK_BITS) + 1;
    }

    private chunk(x: number, y: number, z: number, create: boolean) {
        const key = (x >> CHUNK_BITS) + this.cnx * ((z >> CHUNK_BITS) + this.cnz * (y >> CHUNK_BITS));
        if (key === this.lastKey) return this.lastChunk;
        let chunk = this.chunks.get(key);
        if (!chunk) {
            if (!create) return null;
            chunk = new Uint16Array(CHUNK * CHUNK * CHUNK);
            this.chunks.set(key, chunk);
        }
        this.lastKey = key;
        this.lastChunk = chunk;
        return chunk;
    }

    get(x: number, y: number, z: number) {
        const chunk = this.chunk(x, y, z, false);
        return chunk ? chunk[(x & MASK) | ((z & MASK) << CHUNK_BITS) | ((y & MASK) << (2 * CHUNK_BITS))] : 0;
    }

    set(x: number, y: number, z: number, value: number) {
        const chunk = this.chunk(x, y, z, true);
        chunk[(x & MASK) | ((z & MASK) << CHUNK_BITS) | ((y & MASK) << (2 * CHUNK_BITS))] = value;
    }
}

export { CellStore };
