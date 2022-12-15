import * as common from "./common";

const FILE_MAGIC = 0xed26ff3a;

const MAJOR_VERSION = 1;
const MINOR_VERSION = 0;
export const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

// AOSP libsparse uses 64 MiB chunks
const RAW_CHUNK_SIZE = 64 * 1024 * 1024;

export class ImageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImageError";
    }
}

export interface SparseSplit {
    data: ArrayBuffer;
    bytes: number;
}

export enum ChunkType {
    Raw = 0xcac1,
    Fill = 0xcac2,
    Skip = 0xcac3,
    Crc32 = 0xcac4,
}

export interface SparseHeader {
    blockSize: number;
    blocks: number;
    chunks: number;
    crc32: number;
}

export interface SparseChunk {
    type: ChunkType;
    /* 2: reserved, 16 bits */
    blocks: number;
    dataBytes: number;
    data: Blob | null; // to be populated by consumer
}

class BlobBuilder {
    private blob: Blob;
    private type: string;

    constructor(type: string = "") {
        this.type = type;
        this.blob = new Blob([], { type: this.type });
    }

    append(blob: Blob) {
        this.blob = new Blob([this.blob, blob], { type: this.type });
    }

    getBlob(): Blob {
        return this.blob;
    }
}

/**
 * Returns a parsed version of the sparse image file header from the given buffer.
 *
 * @param {ArrayBuffer} buffer - Raw file header data.
 * @returns {SparseHeader} Object containing the header information.
 */
export function parseFileHeader(buffer: ArrayBuffer): SparseHeader | null {
    let view = new DataView(buffer);

    let magic = view.getUint32(0, true);
    if (magic !== FILE_MAGIC) {
        return null;
    }

    // v1.0+
    let major = view.getUint16(4, true);
    let minor = view.getUint16(6, true);
    if (major !== MAJOR_VERSION || minor < MINOR_VERSION) {
        throw new ImageError(
            `Unsupported sparse image version ${major}.${minor}`
        );
    }

    let fileHdrSize = view.getUint16(8, true);
    let chunkHdrSize = view.getUint16(10, true);
    if (
        fileHdrSize !== FILE_HEADER_SIZE ||
        chunkHdrSize !== CHUNK_HEADER_SIZE
    ) {
        throw new ImageError(
            `Invalid file header size ${fileHdrSize}, chunk header size ${chunkHdrSize}`
        );
    }

    let blockSize = view.getUint32(12, true);
    if (blockSize % 4 !== 0) {
        throw new ImageError(`Block size ${blockSize} is not a multiple of 4`);
    }

    return {
        blockSize: blockSize,
        blocks: view.getUint32(16, true),
        chunks: view.getUint32(20, true),
        crc32: view.getUint32(24, true),
    };
}

function parseChunkHeader(buffer: ArrayBuffer) {
    let view = new DataView(buffer);

    // This isn't the same as what createImage takes.
    // Further processing needs to be done on the chunks.
    return {
        type: view.getUint16(0, true),
        /* 2: reserved, 16 bits */
        blocks: view.getUint32(4, true),
        dataBytes: view.getUint32(8, true) - CHUNK_HEADER_SIZE,
        data: null, // to be populated by consumer
    } as SparseChunk;
}

function calcChunksBlockSize(chunks: Array<SparseChunk>) {
    return chunks
        .map((chunk) => chunk.blocks)
        .reduce((total, c) => total + c, 0);
}

function calcChunksDataSize(chunks: Array<SparseChunk>) {
    return chunks
        .map((chunk) => chunk.data!.size)
        .reduce((total, c) => total + c, 0);
}

function calcChunksSize(chunks: Array<SparseChunk>) {
    // 28-byte file header, 12-byte chunk headers
    let overhead = FILE_HEADER_SIZE + CHUNK_HEADER_SIZE * chunks.length;
    return overhead + calcChunksDataSize(chunks);
}

async function createImage(header: SparseHeader, chunks: Array<SparseChunk>): Promise<Blob> {
    let blobBuilder = new BlobBuilder();

    let buffer = new ArrayBuffer(FILE_HEADER_SIZE);
    let dataView = new DataView(buffer);
    let arrayView = new Uint8Array(buffer);

    dataView.setUint32(0, FILE_MAGIC, true);
    // v1.0
    dataView.setUint16(4, MAJOR_VERSION, true);
    dataView.setUint16(6, MINOR_VERSION, true);
    dataView.setUint16(8, FILE_HEADER_SIZE, true);
    dataView.setUint16(10, CHUNK_HEADER_SIZE, true);

    // Match input parameters
    dataView.setUint32(12, header.blockSize, true);
    dataView.setUint32(16, header.blocks, true);
    dataView.setUint32(20, chunks.length, true);

    // We don't care about the CRC. AOSP docs specify that this should be a CRC32,
    // but AOSP libsparse always sets 0 and puts the CRC in a final undocumented
    // 0xCAC4 chunk instead.
    dataView.setUint32(24, 0, true);

    blobBuilder.append(new Blob([buffer]));
    for (let chunk of chunks) {
        buffer = new ArrayBuffer(CHUNK_HEADER_SIZE + chunk.data!.size);
        dataView = new DataView(buffer);
        arrayView = new Uint8Array(buffer);

        dataView.setUint16(0, chunk.type, true);
        dataView.setUint16(2, 0, true); // reserved
        dataView.setUint32(4, chunk.blocks, true);
        dataView.setUint32(
            8,
            CHUNK_HEADER_SIZE + chunk.data!.size,
            true
        );

        let chunkArrayView = new Uint8Array(await common.readBlobAsBuffer(chunk.data!));
        arrayView.set(chunkArrayView, CHUNK_HEADER_SIZE);
        blobBuilder.append(new Blob([buffer]));
    }

    return blobBuilder.getBlob();
}

/**
 * Creates a sparse image from buffer containing raw image data.
 *
 * @param {Blob} blob - Blob containing the raw image data.
 * @returns {Promise<Blob>} Promise that resolves the blob containing the new sparse image.
 */
export async function fromRaw(blob: Blob): Promise<Blob> {
    let header = {
        blockSize: 4096,
        blocks: blob.size / 4096,
        chunks: 1,
        crc32: 0,
    };

    let chunks = [];
    while (blob.size > 0) {
        let chunkSize = Math.min(blob.size, RAW_CHUNK_SIZE);
        chunks.push({
            type: ChunkType.Raw,
            blocks: chunkSize / header.blockSize,
            data: blob.slice(0, chunkSize),
        } as SparseChunk);
        blob = blob.slice(chunkSize);
    }

    return createImage(header, chunks);
}

/**
 * Split a sparse image into smaller sparse images within the given size.
 * This takes a Blob instead of an ArrayBuffer because it may process images
 * larger than RAM.
 *
 * @param {Blob} blob - Blob containing the sparse image to split.
 * @param {number} splitSize - Maximum size per split.
 * @yields {Object} Data of the next split image and its output size in bytes.
 */
export async function* splitBlob(blob: Blob, splitSize: number) {
    common.logDebug(
        `Splitting ${blob.size}-byte sparse image into ${splitSize}-byte chunks`
    );
    // Short-circuit if splitting isn't required
    if (blob.size <= splitSize) {
        common.logDebug("Blob fits in 1 payload, not splitting");
        yield {
            data: await common.readBlobAsBuffer(blob),
            bytes: blob.size,
        } as SparseSplit;
        return;
    }

    let headerData = await common.readBlobAsBuffer(
        blob.slice(0, FILE_HEADER_SIZE)
    );
    let header = parseFileHeader(headerData);
    if (header === null) {
        throw new ImageError("Blob is not a sparse image");
    }

    // Remove CRC32 (if present), otherwise splitting will invalidate it
    header.crc32 = 0;
    blob = blob.slice(FILE_HEADER_SIZE);

    let splitChunks: Array<SparseChunk> = [];
    let splitDataBytes = 0;
    for (let i = 0; i < header.chunks; i++) {
        let chunkHeaderData = await common.readBlobAsBuffer(
            blob.slice(0, CHUNK_HEADER_SIZE)
        );
        let chunk = parseChunkHeader(chunkHeaderData);
        chunk.data = blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + chunk.dataBytes);
        blob = blob.slice(CHUNK_HEADER_SIZE + chunk.dataBytes);

        let bytesRemaining = splitSize - calcChunksSize(splitChunks);
        common.logVerbose(
            `  Chunk ${i}: type ${chunk.type}, ${chunk.dataBytes} bytes / ${chunk.blocks} blocks, ${bytesRemaining} bytes remaining`
        );
        if (bytesRemaining >= chunk.dataBytes) {
            // Read the chunk and add it
            common.logVerbose("    Space is available, adding chunk");
            splitChunks.push(chunk);
            // Track amount of data written on the output device, in bytes
            splitDataBytes += chunk.blocks * header.blockSize;
        } else {
            // Out of space, finish this split
            // Blocks need to be calculated from chunk headers instead of going by size
            // because FILL and SKIP chunks cover more blocks than the data they contain.
            let splitBlocks = calcChunksBlockSize(splitChunks);
            splitChunks.push({
                type: ChunkType.Skip,
                blocks: header.blocks - splitBlocks,
                data: new Blob([]),
                dataBytes: 0,
            });
            common.logVerbose(
                `Partition is ${
                    header.blocks
                } blocks, used ${splitBlocks}, padded with ${
                    header.blocks - splitBlocks
                }, finishing split with ${calcChunksBlockSize(
                    splitChunks
                )} blocks`
            );
            let splitImage = await createImage(header, splitChunks);
            common.logDebug(
                `Finished ${splitImage.size}-byte split with ${splitChunks.length} chunks`
            );
            yield {
                data: await common.readBlobAsBuffer(splitImage),
                bytes: splitDataBytes,
            } as SparseSplit;

            // Start a new split. Every split is considered a full image by the
            // bootloader, so we need to skip the *total* written blocks.
            common.logVerbose(
                `Starting new split: skipping first ${splitBlocks} blocks and adding chunk`
            );
            splitChunks = [
                {
                    type: ChunkType.Skip,
                    blocks: splitBlocks,
                    data: new Blob([]),
                    dataBytes: 0,
                },
                chunk,
            ];
            splitDataBytes = 0;
        }
    }

    // Finish the final split if necessary
    if (
        splitChunks.length > 0 &&
        (splitChunks.length > 1 || splitChunks[0].type !== ChunkType.Skip)
    ) {
        let splitImage = await createImage(header, splitChunks);
        common.logDebug(
            `Finishing final ${splitImage.size}-byte split with ${splitChunks.length} chunks`
        );
        yield {
            data: await common.readBlobAsBuffer(splitImage),
            bytes: splitDataBytes,
        } as SparseSplit;
    }
}
