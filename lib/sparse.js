import * as common from "./common.js";

const FILE_MAGIC = 0xed26ff3a;

const MAJOR_VERSION = 1;
const MINOR_VERSION = 0;
export const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

// AOSP libsparse uses 64 MiB chunks
const RAW_CHUNK_SIZE = 64 * 1024 * 1024;

const CHUNK_TYPE_RAW = 0xcac1;
const CHUNK_TYPE_FILL = 0xcac2;
const CHUNK_TYPE_SKIP = 0xcac3;

const CHUNK_TYPE_MAP = new Map();
CHUNK_TYPE_MAP.set(CHUNK_TYPE_RAW, "raw");
CHUNK_TYPE_MAP.set(CHUNK_TYPE_FILL, "fill");
CHUNK_TYPE_MAP.set(CHUNK_TYPE_SKIP, "skip");

export class ImageError extends Error {
    constructor(message) {
        super(message);
        this.name = "ImageError";
    }
}

function parseFileHeader(buffer) {
    let view = new DataView(buffer);

    let magic = view.getUint32(0, true);
    if (magic !== FILE_MAGIC) {
        return null;
    }

    // v1.0+
    let major = view.getUint16(4, true);
    let minor = view.getUint16(6, true);
    if (major !== MAJOR_VERSION || minor < MINOR_VERSION) {
        throw new ImageError(`Unsupported sparse image version ${major}.${minor}`);
    }

    let fileHdrSize = view.getUint16(8, true);
    let chunkHdrSize = view.getUint16(10, true);
    if (fileHdrSize !== FILE_HEADER_SIZE || chunkHdrSize !== CHUNK_HEADER_SIZE) {
        throw new ImageError(`Invalid file header size ${fileHdrSize}, chunk header size ${chunkHdrSize}`);
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

function parseChunkHeader(buffer) {
    let view = new DataView(buffer);

    // This isn't the same as what createImage takes.
    // Further processing needs to be done on the chunks.
    return {
        type: CHUNK_TYPE_MAP.get(view.getUint16(0, true)),
        /* 2: reserved, 16 bits */
        blocks: view.getUint32(4, true),
        dataBytes: view.getUint32(8, true) - CHUNK_HEADER_SIZE,
        data: null, // to be populated by consumer
    };
}

function calcChunksBlockSize(chunks) {
    return chunks.map(chunk => chunk.blocks)
        .reduce((total, c) => total + c, 0);
}

function calcChunksDataSize(chunks) {
    return chunks.map(chunk => chunk.data.byteLength)
        .reduce((total, c) => total + c, 0);
}

function calcChunksSize(chunks) {
    // 28-byte file header, 12-byte chunk headers
    let overhead = FILE_HEADER_SIZE + CHUNK_HEADER_SIZE * chunks.length;
    return overhead + calcChunksDataSize(chunks);
}

function createImage(header, chunks) {
    let buffer = new ArrayBuffer(calcChunksSize(chunks));
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

    let chunkOff = FILE_HEADER_SIZE;
    for (let chunk of chunks) {
        let typeMagic;
        if (chunk.type === "raw") {
            typeMagic = CHUNK_TYPE_RAW;
        } else if (chunk.type === "fill") {
            typeMagic = CHUNK_TYPE_FILL;
        } else if (chunk.type === "skip") {
            typeMagic = CHUNK_TYPE_SKIP;
        } else {
            // We don't support the undocumented 0xCAC4 CRC32 chunk type because
            // it's unnecessary and very rarely used in practice.
            throw new ImageError(`Invalid chunk type "${chunk.type}"`);
        }

        dataView.setUint16(chunkOff, typeMagic, true);
        dataView.setUint16(chunkOff + 2, 0, true); // reserved
        dataView.setUint32(chunkOff + 4, chunk.blocks, true);
        dataView.setUint32(chunkOff + 8, CHUNK_HEADER_SIZE + chunk.data.byteLength, true);
        chunkOff += CHUNK_HEADER_SIZE;

        let chunkArrayView = new Uint8Array(chunk.data);
        arrayView.set(chunkArrayView, chunkOff);
        chunkOff += chunk.data.byteLength;
    }

    return buffer;
}

/**
 * Checks whether the given buffer is a valid sparse image.
 *
 * @param {ArrayBuffer} buffer - Buffer containing the data to check.
 * @returns {valid} Whether the buffer is a valid sparse image.
 */
export function isSparse(buffer) {
    try {
        let header = parseFileHeader(buffer);
        return header !== null;
    } catch (error) {
        // ImageError = invalid
        return false;
    }
}

/**
 * Creates a sparse image from buffer containing raw image data.
 *
 * @param {ArrayBuffer} rawBuffer - Buffer containing the raw image data.
 * @returns {sparseBuffer} Buffer containing the new sparse image.
 */
export function fromRaw(rawBuffer) {
    let header = {
        blockSize: 4096,
        blocks: rawBuffer.byteLength / 4096,
        chunks: 1,
        crc32: 0,
    };

    let chunks = [];
    while (rawBuffer.byteLength > 0) {
        let chunkSize = Math.min(rawBuffer.byteLength, RAW_CHUNK_SIZE);
        chunks.push({
            type: "raw",
            blocks: chunkSize / header.blockSize,
            data: rawBuffer.slice(0, chunkSize),
        });
        rawBuffer = rawBuffer.slice(chunkSize);
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
 */
export async function* splitBlob(blob, splitSize) {
    common.logDebug(`Splitting ${blob.size}-byte sparse image into ${splitSize}-byte chunks`);
    // Short-circuit if splitting isn't required
    if (blob.size <= splitSize) {
        common.logDebug("Blob fits in 1 payload, not splitting");
        yield await common.readBlobAsBuffer(blob);
        return;
    }

    let headerData = await common.readBlobAsBuffer(blob.slice(0, FILE_HEADER_SIZE));
    let header = parseFileHeader(headerData);
    // Remove CRC32 (if present), otherwise splitting will invalidate it
    header.crc32 = 0;
    blob = blob.slice(FILE_HEADER_SIZE);

    let splitChunks = [];
    for (let i = 0; i < header.chunks; i++) {
        let chunkHeaderData = await common.readBlobAsBuffer(blob.slice(0, CHUNK_HEADER_SIZE));
        let chunk = parseChunkHeader(chunkHeaderData);
        chunk.data = await common.readBlobAsBuffer(blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + chunk.dataBytes));
        blob = blob.slice(CHUNK_HEADER_SIZE + chunk.dataBytes);

        let bytesRemaining = splitSize - calcChunksSize(splitChunks);
        common.logDebug(`  Chunk ${i}: type ${chunk.type}, ${chunk.dataBytes} bytes / ${chunk.blocks} blocks, ${bytesRemaining} bytes remaining`);
        if (bytesRemaining >= chunk.dataBytes) {
            // Read the chunk and add it
            common.logDebug("    Space is available, adding chunk");
            splitChunks.push(chunk);
        } else {
            // Out of space, finish this split
            // Blocks need to be calculated from chunk headers instead of going by size
            // because FILL and SKIP chunks cover more blocks than the data they contain.
            let splitBlocks = calcChunksBlockSize(splitChunks);
            splitChunks.push({
                type: "skip",
                blocks: header.blocks - splitBlocks,
                data: new ArrayBuffer(),
            });
            common.logDebug(`Partition is ${header.blocks} blocks, used ${splitBlocks}, padded with ${header.blocks - splitBlocks}, finishing split with ${calcChunksBlockSize(splitChunks)} blocks`);
            let splitImage = createImage(header, splitChunks);
            common.logDebug(`Finished ${splitImage.byteLength}-byte split with ${splitChunks.length} chunks`);
            yield splitImage;

            // Start a new split. Every split is considered a full image by the
            // bootloader, so we need to skip the *total* written blocks.
            common.logDebug(`Starting new split: skipping first ${splitBlocks} blocks and adding chunk`);
            splitChunks = [
                {
                    type: "skip",
                    blocks: splitBlocks,
                    data: new ArrayBuffer(),
                },
                chunk,
            ];
        }
    }

    // Finish the final split if necessary
    if (splitChunks.length > 0 &&
            (splitChunks.length > 1 || splitChunks[0].type !== "skip")) {
        let splitImage = createImage(header, splitChunks);
        common.logDebug(`Finishing final ${splitImage.byteLength}-byte split with ${splitChunks.length} chunks`);
        yield splitImage;
    }
}
