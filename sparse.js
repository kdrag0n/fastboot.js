import * as common from './common.js';

const FILE_MAGIC = 0xed26ff3a;

const MAJOR_VERSION = 1;
const MINOR_VERSION = 0;
export const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

const CHUNK_TYPE_RAW = 0xcac1;
const CHUNK_TYPE_FILL = 0xcac2;
const CHUNK_TYPE_IGNORE = 0xcac3;

export class ImageError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

function parseHeader(buffer) {
    let view = new DataView(buffer);

    let magic = view.getUint32(0, true);
    if (magic != FILE_MAGIC) {
        return null;
    }

    // v1.0+
    let major = view.getUint16(4, true);
    let minor = view.getUint16(6, true);
    if (major != MAJOR_VERSION || minor < MINOR_VERSION) {
        throw new ImageError(`Unsupported sparse image version ${major}.${minor}`);
    }

    let fileHdrSize = view.getUint16(8, true);
    let chunkHdrSize = view.getUint16(10, true);
    if (fileHdrSize != FILE_HEADER_SIZE || chunkHdrSize != CHUNK_HEADER_SIZE) {
        throw new ImageError(`Invalid file header size ${fileHdrSize}, chunk header size ${chunkHdrSize}`);
    }

    let blockSize = view.getUint32(12, true);
    if (blockSize % 4 != 0) {
        throw new ImageError(`Block size ${blockSize} is not a multiple of 4`);
    }

    return {
        blockSize: blockSize,
        blocks: view.getUint32(16, true),
        chunks: view.getUint32(20, true),
        crc32: view.getUint32(24, true),
    };
}

function createImage(header, chunks) {
    // 28-byte file header, 12-byte chunk headers
    let overhead = FILE_HEADER_SIZE + CHUNK_HEADER_SIZE * chunks.length;
    let totalData = chunks.map(chunk => chunk.data.byteLength)
                          .reduce((total, c) => total + c);

    let buffer = new ArrayBuffer(overhead + totalData);
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
        if (chunk.type == 'raw') {
            typeMagic = CHUNK_TYPE_RAW;
        } else if (chunk.type == 'fill') {
            typeMagic = CHUNK_TYPE_FILL;
        } else if (chunk.type == 'ignore') {
            typeMagic = CHUNK_TYPE_IGNORE;
        } else {
            // We don't support the undocumented 0xCAC4 CRC32 chunk type because
            // it's unnecessary and very rarely used in practice.
            throw new ImageError(`Invalid chunk type '${chunk.type}'`);
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
        let header = parseHeader(buffer);
        return header != null;
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
    // 1 big chunk with all the raw data
    // TODO: break up into 256/384M chunks to facilitate splitting
    let chunks = [{
        type: 'raw',
        blocks: header.blocks,
        data: rawBuffer,
    }];

    return createImage(header, chunks);
}
