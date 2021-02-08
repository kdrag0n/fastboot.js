'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

let debugLevel = false;

function logDebug(...data) {
    if (debugLevel >= 1) {
        console.log(...data);
    }
}

function logVerbose(...data) {
    if (debugLevel >= 2) {
        console.log(...data);
    }
}

/**
 * Changes the debug level for fastboot operations:
 *   - 0 = silent
 *   - 1 = debug, recommended for general use
 *   - 2 = verbose, for debugging only
 *
 * @param {number} level - Debug level to use.
 */
function setDebugLevel(level) {
    debugLevel = level;
}

/**
 * Reads all of the data in the given blob and returns it as an ArrayBuffer.
 *
 * @param {Blob} blob - Blob with the data to read.
 * @returns {buffer} ArrayBuffer containing data from the blob.
 */
function readBlobAsBuffer(blob) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result);
        };
        reader.onerror = () => {
            reject(reader.error);
        };

        reader.readAsArrayBuffer(blob);
    });
}

function waitForFrame() {
    return new Promise((resolve, _reject) => {
        window.requestAnimationFrame(resolve);
    });
}

async function runWithTimedProgress(
    onProgress,
    action,
    item,
    duration,
    workPromise
) {
    let startTime = new Date().getTime();
    let stop = false;

    onProgress(action, item, 0.0);
    let progressPromise = (async () => {
        let now;
        let targetTime = startTime + duration;

        do {
            now = new Date().getTime();
            onProgress(action, item, (now - startTime) / duration);
            await waitForFrame();
        } while (!stop && now < targetTime);
    })();

    await Promise.race([progressPromise, workPromise]);
    stop = true;
    await progressPromise;
    await workPromise;

    onProgress(action, item, 1.0);
}

const FILE_MAGIC = 0xed26ff3a;

const MAJOR_VERSION = 1;
const MINOR_VERSION = 0;
const FILE_HEADER_SIZE = 28;
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

class ImageError extends Error {
    constructor(message) {
        super(message);
        this.name = "ImageError";
    }
}

/**
 * Returns a parsed version of the sparse image file header from the given buffer.
 *
 * @param {ArrayBuffer} buffer - Raw file header data.
 * @returns {header} Object containing the header information.
 */
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
    return chunks
        .map((chunk) => chunk.blocks)
        .reduce((total, c) => total + c, 0);
}

function calcChunksDataSize(chunks) {
    return chunks
        .map((chunk) => chunk.data.byteLength)
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
        dataView.setUint32(
            chunkOff + 8,
            CHUNK_HEADER_SIZE + chunk.data.byteLength,
            true
        );
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
function isSparse(buffer) {
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
function fromRaw(rawBuffer) {
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
 * @yields {Object} Data of the next split image and its output size in bytes.
 */
async function* splitBlob(blob, splitSize) {
    logDebug(
        `Splitting ${blob.size}-byte sparse image into ${splitSize}-byte chunks`
    );
    // Short-circuit if splitting isn't required
    if (blob.size <= splitSize) {
        logDebug("Blob fits in 1 payload, not splitting");
        yield {
            data: await readBlobAsBuffer(blob),
            bytes: blob.size,
        };
        return;
    }

    let headerData = await readBlobAsBuffer(
        blob.slice(0, FILE_HEADER_SIZE)
    );
    let header = parseFileHeader(headerData);
    // Remove CRC32 (if present), otherwise splitting will invalidate it
    header.crc32 = 0;
    blob = blob.slice(FILE_HEADER_SIZE);

    let splitChunks = [];
    let splitDataBytes = 0;
    for (let i = 0; i < header.chunks; i++) {
        let chunkHeaderData = await readBlobAsBuffer(
            blob.slice(0, CHUNK_HEADER_SIZE)
        );
        let chunk = parseChunkHeader(chunkHeaderData);
        chunk.data = await readBlobAsBuffer(
            blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + chunk.dataBytes)
        );
        blob = blob.slice(CHUNK_HEADER_SIZE + chunk.dataBytes);

        let bytesRemaining = splitSize - calcChunksSize(splitChunks);
        logVerbose(
            `  Chunk ${i}: type ${chunk.type}, ${chunk.dataBytes} bytes / ${chunk.blocks} blocks, ${bytesRemaining} bytes remaining`
        );
        if (bytesRemaining >= chunk.dataBytes) {
            // Read the chunk and add it
            logVerbose("    Space is available, adding chunk");
            splitChunks.push(chunk);
            // Track amount of data written on the output device, in bytes
            splitDataBytes += chunk.blocks * header.blockSize;
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
            logVerbose(
                `Partition is ${
                    header.blocks
                } blocks, used ${splitBlocks}, padded with ${
                    header.blocks - splitBlocks
                }, finishing split with ${calcChunksBlockSize(
                    splitChunks
                )} blocks`
            );
            let splitImage = createImage(header, splitChunks);
            logDebug(
                `Finished ${splitImage.byteLength}-byte split with ${splitChunks.length} chunks`
            );
            yield {
                data: splitImage,
                bytes: splitDataBytes,
            };

            // Start a new split. Every split is considered a full image by the
            // bootloader, so we need to skip the *total* written blocks.
            logVerbose(
                `Starting new split: skipping first ${splitBlocks} blocks and adding chunk`
            );
            splitChunks = [
                {
                    type: "skip",
                    blocks: splitBlocks,
                    data: new ArrayBuffer(),
                },
                chunk,
            ];
            splitDataBytes = 0;
        }
    }

    // Finish the final split if necessary
    if (
        splitChunks.length > 0 &&
        (splitChunks.length > 1 || splitChunks[0].type !== "skip")
    ) {
        let splitImage = createImage(header, splitChunks);
        logDebug(
            `Finishing final ${splitImage.byteLength}-byte split with ${splitChunks.length} chunks`
        );
        yield {
            data: splitImage,
            bytes: splitDataBytes,
        };
    }
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const table = {
	"application": {
		"andrew-inset": "ez",
		"annodex": "anx",
		"atom+xml": "atom",
		"atomcat+xml": "atomcat",
		"atomserv+xml": "atomsrv",
		"bbolin": "lin",
		"cap": ["cap", "pcap"],
		"cu-seeme": "cu",
		"davmount+xml": "davmount",
		"dsptype": "tsp",
		"ecmascript": ["es", "ecma"],
		"futuresplash": "spl",
		"hta": "hta",
		"java-archive": "jar",
		"java-serialized-object": "ser",
		"java-vm": "class",
		"javascript": "js",
		"m3g": "m3g",
		"mac-binhex40": "hqx",
		"mathematica": ["nb", "ma", "mb"],
		"msaccess": "mdb",
		"msword": ["doc", "dot"],
		"mxf": "mxf",
		"oda": "oda",
		"ogg": "ogx",
		"pdf": "pdf",
		"pgp-keys": "key",
		"pgp-signature": ["asc", "sig"],
		"pics-rules": "prf",
		"postscript": ["ps", "ai", "eps", "epsi", "epsf", "eps2", "eps3"],
		"rar": "rar",
		"rdf+xml": "rdf",
		"rss+xml": "rss",
		"rtf": "rtf",
		"smil": ["smi", "smil"],
		"xhtml+xml": ["xhtml", "xht"],
		"xml": ["xml", "xsl", "xsd"],
		"xspf+xml": "xspf",
		"zip": "zip",
		"vnd.android.package-archive": "apk",
		"vnd.cinderella": "cdy",
		"vnd.google-earth.kml+xml": "kml",
		"vnd.google-earth.kmz": "kmz",
		"vnd.mozilla.xul+xml": "xul",
		"vnd.ms-excel": ["xls", "xlb", "xlt", "xlm", "xla", "xlc", "xlw"],
		"vnd.ms-pki.seccat": "cat",
		"vnd.ms-pki.stl": "stl",
		"vnd.ms-powerpoint": ["ppt", "pps", "pot"],
		"vnd.oasis.opendocument.chart": "odc",
		"vnd.oasis.opendocument.database": "odb",
		"vnd.oasis.opendocument.formula": "odf",
		"vnd.oasis.opendocument.graphics": "odg",
		"vnd.oasis.opendocument.graphics-template": "otg",
		"vnd.oasis.opendocument.image": "odi",
		"vnd.oasis.opendocument.presentation": "odp",
		"vnd.oasis.opendocument.presentation-template": "otp",
		"vnd.oasis.opendocument.spreadsheet": "ods",
		"vnd.oasis.opendocument.spreadsheet-template": "ots",
		"vnd.oasis.opendocument.text": "odt",
		"vnd.oasis.opendocument.text-master": "odm",
		"vnd.oasis.opendocument.text-template": "ott",
		"vnd.oasis.opendocument.text-web": "oth",
		"vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
		"vnd.openxmlformats-officedocument.spreadsheetml.template": "xltx",
		"vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
		"vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
		"vnd.openxmlformats-officedocument.presentationml.template": "potx",
		"vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"vnd.openxmlformats-officedocument.wordprocessingml.template": "dotx",
		"vnd.smaf": "mmf",
		"vnd.stardivision.calc": "sdc",
		"vnd.stardivision.chart": "sds",
		"vnd.stardivision.draw": "sda",
		"vnd.stardivision.impress": "sdd",
		"vnd.stardivision.math": ["sdf", "smf"],
		"vnd.stardivision.writer": ["sdw", "vor"],
		"vnd.stardivision.writer-global": "sgl",
		"vnd.sun.xml.calc": "sxc",
		"vnd.sun.xml.calc.template": "stc",
		"vnd.sun.xml.draw": "sxd",
		"vnd.sun.xml.draw.template": "std",
		"vnd.sun.xml.impress": "sxi",
		"vnd.sun.xml.impress.template": "sti",
		"vnd.sun.xml.math": "sxm",
		"vnd.sun.xml.writer": "sxw",
		"vnd.sun.xml.writer.global": "sxg",
		"vnd.sun.xml.writer.template": "stw",
		"vnd.symbian.install": ["sis", "sisx"],
		"vnd.visio": ["vsd", "vst", "vss", "vsw"],
		"vnd.wap.wbxml": "wbxml",
		"vnd.wap.wmlc": "wmlc",
		"vnd.wap.wmlscriptc": "wmlsc",
		"vnd.wordperfect": "wpd",
		"vnd.wordperfect5.1": "wp5",
		"x-123": "wk",
		"x-7z-compressed": "7z",
		"x-abiword": "abw",
		"x-apple-diskimage": "dmg",
		"x-bcpio": "bcpio",
		"x-bittorrent": "torrent",
		"x-cbr": ["cbr", "cba", "cbt", "cb7"],
		"x-cbz": "cbz",
		"x-cdf": ["cdf", "cda"],
		"x-cdlink": "vcd",
		"x-chess-pgn": "pgn",
		"x-cpio": "cpio",
		"x-csh": "csh",
		"x-debian-package": ["deb", "udeb"],
		"x-director": ["dcr", "dir", "dxr", "cst", "cct", "cxt", "w3d", "fgd", "swa"],
		"x-dms": "dms",
		"x-doom": "wad",
		"x-dvi": "dvi",
		"x-httpd-eruby": "rhtml",
		"x-font": "pcf.Z",
		"x-freemind": "mm",
		"x-gnumeric": "gnumeric",
		"x-go-sgf": "sgf",
		"x-graphing-calculator": "gcf",
		"x-gtar": ["gtar", "taz"],
		"x-hdf": "hdf",
		"x-httpd-php": ["phtml", "pht", "php"],
		"x-httpd-php-source": "phps",
		"x-httpd-php3": "php3",
		"x-httpd-php3-preprocessed": "php3p",
		"x-httpd-php4": "php4",
		"x-httpd-php5": "php5",
		"x-ica": "ica",
		"x-info": "info",
		"x-internet-signup": ["ins", "isp"],
		"x-iphone": "iii",
		"x-iso9660-image": "iso",
		"x-java-jnlp-file": "jnlp",
		"x-jmol": "jmz",
		"x-killustrator": "kil",
		"x-koan": ["skp", "skd", "skt", "skm"],
		"x-kpresenter": ["kpr", "kpt"],
		"x-kword": ["kwd", "kwt"],
		"x-latex": "latex",
		"x-lha": "lha",
		"x-lyx": "lyx",
		"x-lzh": "lzh",
		"x-lzx": "lzx",
		"x-maker": ["frm", "maker", "frame", "fm", "fb", "book", "fbdoc"],
		"x-ms-wmd": "wmd",
		"x-ms-wmz": "wmz",
		"x-msdos-program": ["com", "exe", "bat", "dll"],
		"x-msi": "msi",
		"x-netcdf": ["nc", "cdf"],
		"x-ns-proxy-autoconfig": ["pac", "dat"],
		"x-nwc": "nwc",
		"x-object": "o",
		"x-oz-application": "oza",
		"x-pkcs7-certreqresp": "p7r",
		"x-python-code": ["pyc", "pyo"],
		"x-qgis": ["qgs", "shp", "shx"],
		"x-quicktimeplayer": "qtl",
		"x-redhat-package-manager": "rpm",
		"x-ruby": "rb",
		"x-sh": "sh",
		"x-shar": "shar",
		"x-shockwave-flash": ["swf", "swfl"],
		"x-silverlight": "scr",
		"x-stuffit": "sit",
		"x-sv4cpio": "sv4cpio",
		"x-sv4crc": "sv4crc",
		"x-tar": "tar",
		"x-tcl": "tcl",
		"x-tex-gf": "gf",
		"x-tex-pk": "pk",
		"x-texinfo": ["texinfo", "texi"],
		"x-trash": ["~", "%", "bak", "old", "sik"],
		"x-troff": ["t", "tr", "roff"],
		"x-troff-man": "man",
		"x-troff-me": "me",
		"x-troff-ms": "ms",
		"x-ustar": "ustar",
		"x-wais-source": "src",
		"x-wingz": "wz",
		"x-x509-ca-cert": ["crt", "der", "cer"],
		"x-xcf": "xcf",
		"x-xfig": "fig",
		"x-xpinstall": "xpi",
		"applixware": "aw",
		"atomsvc+xml": "atomsvc",
		"ccxml+xml": "ccxml",
		"cdmi-capability": "cdmia",
		"cdmi-container": "cdmic",
		"cdmi-domain": "cdmid",
		"cdmi-object": "cdmio",
		"cdmi-queue": "cdmiq",
		"docbook+xml": "dbk",
		"dssc+der": "dssc",
		"dssc+xml": "xdssc",
		"emma+xml": "emma",
		"epub+zip": "epub",
		"exi": "exi",
		"font-tdpfr": "pfr",
		"gml+xml": "gml",
		"gpx+xml": "gpx",
		"gxf": "gxf",
		"hyperstudio": "stk",
		"inkml+xml": ["ink", "inkml"],
		"ipfix": "ipfix",
		"json": "json",
		"jsonml+json": "jsonml",
		"lost+xml": "lostxml",
		"mads+xml": "mads",
		"marc": "mrc",
		"marcxml+xml": "mrcx",
		"mathml+xml": "mathml",
		"mbox": "mbox",
		"mediaservercontrol+xml": "mscml",
		"metalink+xml": "metalink",
		"metalink4+xml": "meta4",
		"mets+xml": "mets",
		"mods+xml": "mods",
		"mp21": ["m21", "mp21"],
		"mp4": "mp4s",
		"oebps-package+xml": "opf",
		"omdoc+xml": "omdoc",
		"onenote": ["onetoc", "onetoc2", "onetmp", "onepkg"],
		"oxps": "oxps",
		"patch-ops-error+xml": "xer",
		"pgp-encrypted": "pgp",
		"pkcs10": "p10",
		"pkcs7-mime": ["p7m", "p7c"],
		"pkcs7-signature": "p7s",
		"pkcs8": "p8",
		"pkix-attr-cert": "ac",
		"pkix-crl": "crl",
		"pkix-pkipath": "pkipath",
		"pkixcmp": "pki",
		"pls+xml": "pls",
		"prs.cww": "cww",
		"pskc+xml": "pskcxml",
		"reginfo+xml": "rif",
		"relax-ng-compact-syntax": "rnc",
		"resource-lists+xml": "rl",
		"resource-lists-diff+xml": "rld",
		"rls-services+xml": "rs",
		"rpki-ghostbusters": "gbr",
		"rpki-manifest": "mft",
		"rpki-roa": "roa",
		"rsd+xml": "rsd",
		"sbml+xml": "sbml",
		"scvp-cv-request": "scq",
		"scvp-cv-response": "scs",
		"scvp-vp-request": "spq",
		"scvp-vp-response": "spp",
		"sdp": "sdp",
		"set-payment-initiation": "setpay",
		"set-registration-initiation": "setreg",
		"shf+xml": "shf",
		"sparql-query": "rq",
		"sparql-results+xml": "srx",
		"srgs": "gram",
		"srgs+xml": "grxml",
		"sru+xml": "sru",
		"ssdl+xml": "ssdl",
		"ssml+xml": "ssml",
		"tei+xml": ["tei", "teicorpus"],
		"thraud+xml": "tfi",
		"timestamped-data": "tsd",
		"vnd.3gpp.pic-bw-large": "plb",
		"vnd.3gpp.pic-bw-small": "psb",
		"vnd.3gpp.pic-bw-var": "pvb",
		"vnd.3gpp2.tcap": "tcap",
		"vnd.3m.post-it-notes": "pwn",
		"vnd.accpac.simply.aso": "aso",
		"vnd.accpac.simply.imp": "imp",
		"vnd.acucobol": "acu",
		"vnd.acucorp": ["atc", "acutc"],
		"vnd.adobe.air-application-installer-package+zip": "air",
		"vnd.adobe.formscentral.fcdt": "fcdt",
		"vnd.adobe.fxp": ["fxp", "fxpl"],
		"vnd.adobe.xdp+xml": "xdp",
		"vnd.adobe.xfdf": "xfdf",
		"vnd.ahead.space": "ahead",
		"vnd.airzip.filesecure.azf": "azf",
		"vnd.airzip.filesecure.azs": "azs",
		"vnd.amazon.ebook": "azw",
		"vnd.americandynamics.acc": "acc",
		"vnd.amiga.ami": "ami",
		"vnd.anser-web-certificate-issue-initiation": "cii",
		"vnd.anser-web-funds-transfer-initiation": "fti",
		"vnd.antix.game-component": "atx",
		"vnd.apple.installer+xml": "mpkg",
		"vnd.apple.mpegurl": "m3u8",
		"vnd.aristanetworks.swi": "swi",
		"vnd.astraea-software.iota": "iota",
		"vnd.audiograph": "aep",
		"vnd.blueice.multipass": "mpm",
		"vnd.bmi": "bmi",
		"vnd.businessobjects": "rep",
		"vnd.chemdraw+xml": "cdxml",
		"vnd.chipnuts.karaoke-mmd": "mmd",
		"vnd.claymore": "cla",
		"vnd.cloanto.rp9": "rp9",
		"vnd.clonk.c4group": ["c4g", "c4d", "c4f", "c4p", "c4u"],
		"vnd.cluetrust.cartomobile-config": "c11amc",
		"vnd.cluetrust.cartomobile-config-pkg": "c11amz",
		"vnd.commonspace": "csp",
		"vnd.contact.cmsg": "cdbcmsg",
		"vnd.cosmocaller": "cmc",
		"vnd.crick.clicker": "clkx",
		"vnd.crick.clicker.keyboard": "clkk",
		"vnd.crick.clicker.palette": "clkp",
		"vnd.crick.clicker.template": "clkt",
		"vnd.crick.clicker.wordbank": "clkw",
		"vnd.criticaltools.wbs+xml": "wbs",
		"vnd.ctc-posml": "pml",
		"vnd.cups-ppd": "ppd",
		"vnd.curl.car": "car",
		"vnd.curl.pcurl": "pcurl",
		"vnd.dart": "dart",
		"vnd.data-vision.rdz": "rdz",
		"vnd.dece.data": ["uvf", "uvvf", "uvd", "uvvd"],
		"vnd.dece.ttml+xml": ["uvt", "uvvt"],
		"vnd.dece.unspecified": ["uvx", "uvvx"],
		"vnd.dece.zip": ["uvz", "uvvz"],
		"vnd.denovo.fcselayout-link": "fe_launch",
		"vnd.dna": "dna",
		"vnd.dolby.mlp": "mlp",
		"vnd.dpgraph": "dpg",
		"vnd.dreamfactory": "dfac",
		"vnd.ds-keypoint": "kpxx",
		"vnd.dvb.ait": "ait",
		"vnd.dvb.service": "svc",
		"vnd.dynageo": "geo",
		"vnd.ecowin.chart": "mag",
		"vnd.enliven": "nml",
		"vnd.epson.esf": "esf",
		"vnd.epson.msf": "msf",
		"vnd.epson.quickanime": "qam",
		"vnd.epson.salt": "slt",
		"vnd.epson.ssf": "ssf",
		"vnd.eszigno3+xml": ["es3", "et3"],
		"vnd.ezpix-album": "ez2",
		"vnd.ezpix-package": "ez3",
		"vnd.fdf": "fdf",
		"vnd.fdsn.mseed": "mseed",
		"vnd.fdsn.seed": ["seed", "dataless"],
		"vnd.flographit": "gph",
		"vnd.fluxtime.clip": "ftc",
		"vnd.framemaker": ["fm", "frame", "maker", "book"],
		"vnd.frogans.fnc": "fnc",
		"vnd.frogans.ltf": "ltf",
		"vnd.fsc.weblaunch": "fsc",
		"vnd.fujitsu.oasys": "oas",
		"vnd.fujitsu.oasys2": "oa2",
		"vnd.fujitsu.oasys3": "oa3",
		"vnd.fujitsu.oasysgp": "fg5",
		"vnd.fujitsu.oasysprs": "bh2",
		"vnd.fujixerox.ddd": "ddd",
		"vnd.fujixerox.docuworks": "xdw",
		"vnd.fujixerox.docuworks.binder": "xbd",
		"vnd.fuzzysheet": "fzs",
		"vnd.genomatix.tuxedo": "txd",
		"vnd.geogebra.file": "ggb",
		"vnd.geogebra.tool": "ggt",
		"vnd.geometry-explorer": ["gex", "gre"],
		"vnd.geonext": "gxt",
		"vnd.geoplan": "g2w",
		"vnd.geospace": "g3w",
		"vnd.gmx": "gmx",
		"vnd.grafeq": ["gqf", "gqs"],
		"vnd.groove-account": "gac",
		"vnd.groove-help": "ghf",
		"vnd.groove-identity-message": "gim",
		"vnd.groove-injector": "grv",
		"vnd.groove-tool-message": "gtm",
		"vnd.groove-tool-template": "tpl",
		"vnd.groove-vcard": "vcg",
		"vnd.hal+xml": "hal",
		"vnd.handheld-entertainment+xml": "zmm",
		"vnd.hbci": "hbci",
		"vnd.hhe.lesson-player": "les",
		"vnd.hp-hpgl": "hpgl",
		"vnd.hp-hpid": "hpid",
		"vnd.hp-hps": "hps",
		"vnd.hp-jlyt": "jlt",
		"vnd.hp-pcl": "pcl",
		"vnd.hp-pclxl": "pclxl",
		"vnd.hydrostatix.sof-data": "sfd-hdstx",
		"vnd.ibm.minipay": "mpy",
		"vnd.ibm.modcap": ["afp", "listafp", "list3820"],
		"vnd.ibm.rights-management": "irm",
		"vnd.ibm.secure-container": "sc",
		"vnd.iccprofile": ["icc", "icm"],
		"vnd.igloader": "igl",
		"vnd.immervision-ivp": "ivp",
		"vnd.immervision-ivu": "ivu",
		"vnd.insors.igm": "igm",
		"vnd.intercon.formnet": ["xpw", "xpx"],
		"vnd.intergeo": "i2g",
		"vnd.intu.qbo": "qbo",
		"vnd.intu.qfx": "qfx",
		"vnd.ipunplugged.rcprofile": "rcprofile",
		"vnd.irepository.package+xml": "irp",
		"vnd.is-xpr": "xpr",
		"vnd.isac.fcs": "fcs",
		"vnd.jam": "jam",
		"vnd.jcp.javame.midlet-rms": "rms",
		"vnd.jisp": "jisp",
		"vnd.joost.joda-archive": "joda",
		"vnd.kahootz": ["ktz", "ktr"],
		"vnd.kde.karbon": "karbon",
		"vnd.kde.kchart": "chrt",
		"vnd.kde.kformula": "kfo",
		"vnd.kde.kivio": "flw",
		"vnd.kde.kontour": "kon",
		"vnd.kde.kpresenter": ["kpr", "kpt"],
		"vnd.kde.kspread": "ksp",
		"vnd.kde.kword": ["kwd", "kwt"],
		"vnd.kenameaapp": "htke",
		"vnd.kidspiration": "kia",
		"vnd.kinar": ["kne", "knp"],
		"vnd.koan": ["skp", "skd", "skt", "skm"],
		"vnd.kodak-descriptor": "sse",
		"vnd.las.las+xml": "lasxml",
		"vnd.llamagraphics.life-balance.desktop": "lbd",
		"vnd.llamagraphics.life-balance.exchange+xml": "lbe",
		"vnd.lotus-1-2-3": "123",
		"vnd.lotus-approach": "apr",
		"vnd.lotus-freelance": "pre",
		"vnd.lotus-notes": "nsf",
		"vnd.lotus-organizer": "org",
		"vnd.lotus-screencam": "scm",
		"vnd.lotus-wordpro": "lwp",
		"vnd.macports.portpkg": "portpkg",
		"vnd.mcd": "mcd",
		"vnd.medcalcdata": "mc1",
		"vnd.mediastation.cdkey": "cdkey",
		"vnd.mfer": "mwf",
		"vnd.mfmp": "mfm",
		"vnd.micrografx.flo": "flo",
		"vnd.micrografx.igx": "igx",
		"vnd.mif": "mif",
		"vnd.mobius.daf": "daf",
		"vnd.mobius.dis": "dis",
		"vnd.mobius.mbk": "mbk",
		"vnd.mobius.mqy": "mqy",
		"vnd.mobius.msl": "msl",
		"vnd.mobius.plc": "plc",
		"vnd.mobius.txf": "txf",
		"vnd.mophun.application": "mpn",
		"vnd.mophun.certificate": "mpc",
		"vnd.ms-artgalry": "cil",
		"vnd.ms-cab-compressed": "cab",
		"vnd.ms-excel.addin.macroenabled.12": "xlam",
		"vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
		"vnd.ms-excel.sheet.macroenabled.12": "xlsm",
		"vnd.ms-excel.template.macroenabled.12": "xltm",
		"vnd.ms-fontobject": "eot",
		"vnd.ms-htmlhelp": "chm",
		"vnd.ms-ims": "ims",
		"vnd.ms-lrm": "lrm",
		"vnd.ms-officetheme": "thmx",
		"vnd.ms-powerpoint.addin.macroenabled.12": "ppam",
		"vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
		"vnd.ms-powerpoint.slide.macroenabled.12": "sldm",
		"vnd.ms-powerpoint.slideshow.macroenabled.12": "ppsm",
		"vnd.ms-powerpoint.template.macroenabled.12": "potm",
		"vnd.ms-project": ["mpp", "mpt"],
		"vnd.ms-word.document.macroenabled.12": "docm",
		"vnd.ms-word.template.macroenabled.12": "dotm",
		"vnd.ms-works": ["wps", "wks", "wcm", "wdb"],
		"vnd.ms-wpl": "wpl",
		"vnd.ms-xpsdocument": "xps",
		"vnd.mseq": "mseq",
		"vnd.musician": "mus",
		"vnd.muvee.style": "msty",
		"vnd.mynfc": "taglet",
		"vnd.neurolanguage.nlu": "nlu",
		"vnd.nitf": ["ntf", "nitf"],
		"vnd.noblenet-directory": "nnd",
		"vnd.noblenet-sealer": "nns",
		"vnd.noblenet-web": "nnw",
		"vnd.nokia.n-gage.data": "ngdat",
		"vnd.nokia.n-gage.symbian.install": "n-gage",
		"vnd.nokia.radio-preset": "rpst",
		"vnd.nokia.radio-presets": "rpss",
		"vnd.novadigm.edm": "edm",
		"vnd.novadigm.edx": "edx",
		"vnd.novadigm.ext": "ext",
		"vnd.oasis.opendocument.chart-template": "otc",
		"vnd.oasis.opendocument.formula-template": "odft",
		"vnd.oasis.opendocument.image-template": "oti",
		"vnd.olpc-sugar": "xo",
		"vnd.oma.dd2+xml": "dd2",
		"vnd.openofficeorg.extension": "oxt",
		"vnd.openxmlformats-officedocument.presentationml.slide": "sldx",
		"vnd.osgeo.mapguide.package": "mgp",
		"vnd.osgi.dp": "dp",
		"vnd.osgi.subsystem": "esa",
		"vnd.palm": ["pdb", "pqa", "oprc"],
		"vnd.pawaafile": "paw",
		"vnd.pg.format": "str",
		"vnd.pg.osasli": "ei6",
		"vnd.picsel": "efif",
		"vnd.pmi.widget": "wg",
		"vnd.pocketlearn": "plf",
		"vnd.powerbuilder6": "pbd",
		"vnd.previewsystems.box": "box",
		"vnd.proteus.magazine": "mgz",
		"vnd.publishare-delta-tree": "qps",
		"vnd.pvi.ptid1": "ptid",
		"vnd.quark.quarkxpress": ["qxd", "qxt", "qwd", "qwt", "qxl", "qxb"],
		"vnd.realvnc.bed": "bed",
		"vnd.recordare.musicxml": "mxl",
		"vnd.recordare.musicxml+xml": "musicxml",
		"vnd.rig.cryptonote": "cryptonote",
		"vnd.rn-realmedia": "rm",
		"vnd.rn-realmedia-vbr": "rmvb",
		"vnd.route66.link66+xml": "link66",
		"vnd.sailingtracker.track": "st",
		"vnd.seemail": "see",
		"vnd.sema": "sema",
		"vnd.semd": "semd",
		"vnd.semf": "semf",
		"vnd.shana.informed.formdata": "ifm",
		"vnd.shana.informed.formtemplate": "itp",
		"vnd.shana.informed.interchange": "iif",
		"vnd.shana.informed.package": "ipk",
		"vnd.simtech-mindmapper": ["twd", "twds"],
		"vnd.smart.teacher": "teacher",
		"vnd.solent.sdkm+xml": ["sdkm", "sdkd"],
		"vnd.spotfire.dxp": "dxp",
		"vnd.spotfire.sfs": "sfs",
		"vnd.stepmania.package": "smzip",
		"vnd.stepmania.stepchart": "sm",
		"vnd.sus-calendar": ["sus", "susp"],
		"vnd.svd": "svd",
		"vnd.syncml+xml": "xsm",
		"vnd.syncml.dm+wbxml": "bdm",
		"vnd.syncml.dm+xml": "xdm",
		"vnd.tao.intent-module-archive": "tao",
		"vnd.tcpdump.pcap": ["pcap", "cap", "dmp"],
		"vnd.tmobile-livetv": "tmo",
		"vnd.trid.tpt": "tpt",
		"vnd.triscape.mxs": "mxs",
		"vnd.trueapp": "tra",
		"vnd.ufdl": ["ufd", "ufdl"],
		"vnd.uiq.theme": "utz",
		"vnd.umajin": "umj",
		"vnd.unity": "unityweb",
		"vnd.uoml+xml": "uoml",
		"vnd.vcx": "vcx",
		"vnd.visionary": "vis",
		"vnd.vsf": "vsf",
		"vnd.webturbo": "wtb",
		"vnd.wolfram.player": "nbp",
		"vnd.wqd": "wqd",
		"vnd.wt.stf": "stf",
		"vnd.xara": "xar",
		"vnd.xfdl": "xfdl",
		"vnd.yamaha.hv-dic": "hvd",
		"vnd.yamaha.hv-script": "hvs",
		"vnd.yamaha.hv-voice": "hvp",
		"vnd.yamaha.openscoreformat": "osf",
		"vnd.yamaha.openscoreformat.osfpvg+xml": "osfpvg",
		"vnd.yamaha.smaf-audio": "saf",
		"vnd.yamaha.smaf-phrase": "spf",
		"vnd.yellowriver-custom-menu": "cmp",
		"vnd.zul": ["zir", "zirz"],
		"vnd.zzazz.deck+xml": "zaz",
		"voicexml+xml": "vxml",
		"widget": "wgt",
		"winhlp": "hlp",
		"wsdl+xml": "wsdl",
		"wspolicy+xml": "wspolicy",
		"x-ace-compressed": "ace",
		"x-authorware-bin": ["aab", "x32", "u32", "vox"],
		"x-authorware-map": "aam",
		"x-authorware-seg": "aas",
		"x-blorb": ["blb", "blorb"],
		"x-bzip": "bz",
		"x-bzip2": ["bz2", "boz"],
		"x-cfs-compressed": "cfs",
		"x-chat": "chat",
		"x-conference": "nsc",
		"x-dgc-compressed": "dgc",
		"x-dtbncx+xml": "ncx",
		"x-dtbook+xml": "dtb",
		"x-dtbresource+xml": "res",
		"x-eva": "eva",
		"x-font-bdf": "bdf",
		"x-font-ghostscript": "gsf",
		"x-font-linux-psf": "psf",
		"x-font-otf": "otf",
		"x-font-pcf": "pcf",
		"x-font-snf": "snf",
		"x-font-ttf": ["ttf", "ttc"],
		"x-font-type1": ["pfa", "pfb", "pfm", "afm"],
		"x-font-woff": "woff",
		"x-freearc": "arc",
		"x-gca-compressed": "gca",
		"x-glulx": "ulx",
		"x-gramps-xml": "gramps",
		"x-install-instructions": "install",
		"x-lzh-compressed": ["lzh", "lha"],
		"x-mie": "mie",
		"x-mobipocket-ebook": ["prc", "mobi"],
		"x-ms-application": "application",
		"x-ms-shortcut": "lnk",
		"x-ms-xbap": "xbap",
		"x-msbinder": "obd",
		"x-mscardfile": "crd",
		"x-msclip": "clp",
		"x-msdownload": ["exe", "dll", "com", "bat", "msi"],
		"x-msmediaview": ["mvb", "m13", "m14"],
		"x-msmetafile": ["wmf", "wmz", "emf", "emz"],
		"x-msmoney": "mny",
		"x-mspublisher": "pub",
		"x-msschedule": "scd",
		"x-msterminal": "trm",
		"x-mswrite": "wri",
		"x-nzb": "nzb",
		"x-pkcs12": ["p12", "pfx"],
		"x-pkcs7-certificates": ["p7b", "spc"],
		"x-research-info-systems": "ris",
		"x-silverlight-app": "xap",
		"x-sql": "sql",
		"x-stuffitx": "sitx",
		"x-subrip": "srt",
		"x-t3vm-image": "t3",
		"x-tads": "gam",
		"x-tex": "tex",
		"x-tex-tfm": "tfm",
		"x-tgif": "obj",
		"x-xliff+xml": "xlf",
		"x-xz": "xz",
		"x-zmachine": ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8"],
		"xaml+xml": "xaml",
		"xcap-diff+xml": "xdf",
		"xenc+xml": "xenc",
		"xml-dtd": "dtd",
		"xop+xml": "xop",
		"xproc+xml": "xpl",
		"xslt+xml": "xslt",
		"xv+xml": ["mxml", "xhvml", "xvml", "xvm"],
		"yang": "yang",
		"yin+xml": "yin",
		"envoy": "evy",
		"fractals": "fif",
		"internet-property-stream": "acx",
		"olescript": "axs",
		"vnd.ms-outlook": "msg",
		"vnd.ms-pkicertstore": "sst",
		"x-compress": "z",
		"x-compressed": "tgz",
		"x-gzip": "gz",
		"x-perfmon": ["pma", "pmc", "pml", "pmr", "pmw"],
		"x-pkcs7-mime": ["p7c", "p7m"],
		"ynd.ms-pkipko": "pko"
	},
	"audio": {
		"amr": "amr",
		"amr-wb": "awb",
		"annodex": "axa",
		"basic": ["au", "snd"],
		"flac": "flac",
		"midi": ["mid", "midi", "kar", "rmi"],
		"mpeg": ["mpga", "mpega", "mp2", "mp3", "m4a", "mp2a", "m2a", "m3a"],
		"mpegurl": "m3u",
		"ogg": ["oga", "ogg", "spx"],
		"prs.sid": "sid",
		"x-aiff": ["aif", "aiff", "aifc"],
		"x-gsm": "gsm",
		"x-ms-wma": "wma",
		"x-ms-wax": "wax",
		"x-pn-realaudio": "ram",
		"x-realaudio": "ra",
		"x-sd2": "sd2",
		"x-wav": "wav",
		"adpcm": "adp",
		"mp4": "mp4a",
		"s3m": "s3m",
		"silk": "sil",
		"vnd.dece.audio": ["uva", "uvva"],
		"vnd.digital-winds": "eol",
		"vnd.dra": "dra",
		"vnd.dts": "dts",
		"vnd.dts.hd": "dtshd",
		"vnd.lucent.voice": "lvp",
		"vnd.ms-playready.media.pya": "pya",
		"vnd.nuera.ecelp4800": "ecelp4800",
		"vnd.nuera.ecelp7470": "ecelp7470",
		"vnd.nuera.ecelp9600": "ecelp9600",
		"vnd.rip": "rip",
		"webm": "weba",
		"x-aac": "aac",
		"x-caf": "caf",
		"x-matroska": "mka",
		"x-pn-realaudio-plugin": "rmp",
		"xm": "xm",
		"mid": ["mid", "rmi"]
	},
	"chemical": {
		"x-alchemy": "alc",
		"x-cache": ["cac", "cache"],
		"x-cache-csf": "csf",
		"x-cactvs-binary": ["cbin", "cascii", "ctab"],
		"x-cdx": "cdx",
		"x-chem3d": "c3d",
		"x-cif": "cif",
		"x-cmdf": "cmdf",
		"x-cml": "cml",
		"x-compass": "cpa",
		"x-crossfire": "bsd",
		"x-csml": ["csml", "csm"],
		"x-ctx": "ctx",
		"x-cxf": ["cxf", "cef"],
		"x-embl-dl-nucleotide": ["emb", "embl"],
		"x-gamess-input": ["inp", "gam", "gamin"],
		"x-gaussian-checkpoint": ["fch", "fchk"],
		"x-gaussian-cube": "cub",
		"x-gaussian-input": ["gau", "gjc", "gjf"],
		"x-gaussian-log": "gal",
		"x-gcg8-sequence": "gcg",
		"x-genbank": "gen",
		"x-hin": "hin",
		"x-isostar": ["istr", "ist"],
		"x-jcamp-dx": ["jdx", "dx"],
		"x-kinemage": "kin",
		"x-macmolecule": "mcm",
		"x-macromodel-input": ["mmd", "mmod"],
		"x-mdl-molfile": "mol",
		"x-mdl-rdfile": "rd",
		"x-mdl-rxnfile": "rxn",
		"x-mdl-sdfile": ["sd", "sdf"],
		"x-mdl-tgf": "tgf",
		"x-mmcif": "mcif",
		"x-mol2": "mol2",
		"x-molconn-Z": "b",
		"x-mopac-graph": "gpt",
		"x-mopac-input": ["mop", "mopcrt", "mpc", "zmt"],
		"x-mopac-out": "moo",
		"x-ncbi-asn1": "asn",
		"x-ncbi-asn1-ascii": ["prt", "ent"],
		"x-ncbi-asn1-binary": ["val", "aso"],
		"x-pdb": ["pdb", "ent"],
		"x-rosdal": "ros",
		"x-swissprot": "sw",
		"x-vamas-iso14976": "vms",
		"x-vmd": "vmd",
		"x-xtel": "xtel",
		"x-xyz": "xyz"
	},
	"image": {
		"gif": "gif",
		"ief": "ief",
		"jpeg": ["jpeg", "jpg", "jpe"],
		"pcx": "pcx",
		"png": "png",
		"svg+xml": ["svg", "svgz"],
		"tiff": ["tiff", "tif"],
		"vnd.djvu": ["djvu", "djv"],
		"vnd.wap.wbmp": "wbmp",
		"x-canon-cr2": "cr2",
		"x-canon-crw": "crw",
		"x-cmu-raster": "ras",
		"x-coreldraw": "cdr",
		"x-coreldrawpattern": "pat",
		"x-coreldrawtemplate": "cdt",
		"x-corelphotopaint": "cpt",
		"x-epson-erf": "erf",
		"x-icon": "ico",
		"x-jg": "art",
		"x-jng": "jng",
		"x-nikon-nef": "nef",
		"x-olympus-orf": "orf",
		"x-photoshop": "psd",
		"x-portable-anymap": "pnm",
		"x-portable-bitmap": "pbm",
		"x-portable-graymap": "pgm",
		"x-portable-pixmap": "ppm",
		"x-rgb": "rgb",
		"x-xbitmap": "xbm",
		"x-xpixmap": "xpm",
		"x-xwindowdump": "xwd",
		"bmp": "bmp",
		"cgm": "cgm",
		"g3fax": "g3",
		"ktx": "ktx",
		"prs.btif": "btif",
		"sgi": "sgi",
		"vnd.dece.graphic": ["uvi", "uvvi", "uvg", "uvvg"],
		"vnd.dwg": "dwg",
		"vnd.dxf": "dxf",
		"vnd.fastbidsheet": "fbs",
		"vnd.fpx": "fpx",
		"vnd.fst": "fst",
		"vnd.fujixerox.edmics-mmr": "mmr",
		"vnd.fujixerox.edmics-rlc": "rlc",
		"vnd.ms-modi": "mdi",
		"vnd.ms-photo": "wdp",
		"vnd.net-fpx": "npx",
		"vnd.xiff": "xif",
		"webp": "webp",
		"x-3ds": "3ds",
		"x-cmx": "cmx",
		"x-freehand": ["fh", "fhc", "fh4", "fh5", "fh7"],
		"x-pict": ["pic", "pct"],
		"x-tga": "tga",
		"cis-cod": "cod",
		"pipeg": "jfif"
	},
	"message": {
		"rfc822": ["eml", "mime", "mht", "mhtml", "nws"]
	},
	"model": {
		"iges": ["igs", "iges"],
		"mesh": ["msh", "mesh", "silo"],
		"vrml": ["wrl", "vrml"],
		"x3d+vrml": ["x3dv", "x3dvz"],
		"x3d+xml": ["x3d", "x3dz"],
		"x3d+binary": ["x3db", "x3dbz"],
		"vnd.collada+xml": "dae",
		"vnd.dwf": "dwf",
		"vnd.gdl": "gdl",
		"vnd.gtw": "gtw",
		"vnd.mts": "mts",
		"vnd.vtu": "vtu"
	},
	"text": {
		"cache-manifest": ["manifest", "appcache"],
		"calendar": ["ics", "icz", "ifb"],
		"css": "css",
		"csv": "csv",
		"h323": "323",
		"html": ["html", "htm", "shtml", "stm"],
		"iuls": "uls",
		"mathml": "mml",
		"plain": ["txt", "text", "brf", "conf", "def", "list", "log", "in", "bas"],
		"richtext": "rtx",
		"scriptlet": ["sct", "wsc"],
		"texmacs": ["tm", "ts"],
		"tab-separated-values": "tsv",
		"vnd.sun.j2me.app-descriptor": "jad",
		"vnd.wap.wml": "wml",
		"vnd.wap.wmlscript": "wmls",
		"x-bibtex": "bib",
		"x-boo": "boo",
		"x-c++hdr": ["h++", "hpp", "hxx", "hh"],
		"x-c++src": ["c++", "cpp", "cxx", "cc"],
		"x-component": "htc",
		"x-dsrc": "d",
		"x-diff": ["diff", "patch"],
		"x-haskell": "hs",
		"x-java": "java",
		"x-literate-haskell": "lhs",
		"x-moc": "moc",
		"x-pascal": ["p", "pas"],
		"x-pcs-gcd": "gcd",
		"x-perl": ["pl", "pm"],
		"x-python": "py",
		"x-scala": "scala",
		"x-setext": "etx",
		"x-tcl": ["tcl", "tk"],
		"x-tex": ["tex", "ltx", "sty", "cls"],
		"x-vcalendar": "vcs",
		"x-vcard": "vcf",
		"n3": "n3",
		"prs.lines.tag": "dsc",
		"sgml": ["sgml", "sgm"],
		"troff": ["t", "tr", "roff", "man", "me", "ms"],
		"turtle": "ttl",
		"uri-list": ["uri", "uris", "urls"],
		"vcard": "vcard",
		"vnd.curl": "curl",
		"vnd.curl.dcurl": "dcurl",
		"vnd.curl.scurl": "scurl",
		"vnd.curl.mcurl": "mcurl",
		"vnd.dvb.subtitle": "sub",
		"vnd.fly": "fly",
		"vnd.fmi.flexstor": "flx",
		"vnd.graphviz": "gv",
		"vnd.in3d.3dml": "3dml",
		"vnd.in3d.spot": "spot",
		"x-asm": ["s", "asm"],
		"x-c": ["c", "cc", "cxx", "cpp", "h", "hh", "dic"],
		"x-fortran": ["f", "for", "f77", "f90"],
		"x-opml": "opml",
		"x-nfo": "nfo",
		"x-sfv": "sfv",
		"x-uuencode": "uu",
		"webviewhtml": "htt"
	},
	"video": {
		"avif": ".avif",
		"3gpp": "3gp",
		"annodex": "axv",
		"dl": "dl",
		"dv": ["dif", "dv"],
		"fli": "fli",
		"gl": "gl",
		"mpeg": ["mpeg", "mpg", "mpe", "m1v", "m2v", "mp2", "mpa", "mpv2"],
		"mp4": ["mp4", "mp4v", "mpg4"],
		"quicktime": ["qt", "mov"],
		"ogg": "ogv",
		"vnd.mpegurl": ["mxu", "m4u"],
		"x-flv": "flv",
		"x-la-asf": ["lsf", "lsx"],
		"x-mng": "mng",
		"x-ms-asf": ["asf", "asx", "asr"],
		"x-ms-wm": "wm",
		"x-ms-wmv": "wmv",
		"x-ms-wmx": "wmx",
		"x-ms-wvx": "wvx",
		"x-msvideo": "avi",
		"x-sgi-movie": "movie",
		"x-matroska": ["mpv", "mkv", "mk3d", "mks"],
		"3gpp2": "3g2",
		"h261": "h261",
		"h263": "h263",
		"h264": "h264",
		"jpeg": "jpgv",
		"jpm": ["jpm", "jpgm"],
		"mj2": ["mj2", "mjp2"],
		"vnd.dece.hd": ["uvh", "uvvh"],
		"vnd.dece.mobile": ["uvm", "uvvm"],
		"vnd.dece.pd": ["uvp", "uvvp"],
		"vnd.dece.sd": ["uvs", "uvvs"],
		"vnd.dece.video": ["uvv", "uvvv"],
		"vnd.dvb.file": "dvb",
		"vnd.fvt": "fvt",
		"vnd.ms-playready.media.pyv": "pyv",
		"vnd.uvvu.mp4": ["uvu", "uvvu"],
		"vnd.vivo": "viv",
		"webm": "webm",
		"x-f4v": "f4v",
		"x-m4v": "m4v",
		"x-ms-vob": "vob",
		"x-smv": "smv"		
	},
	"x-conference": {
		"x-cooltalk": "ice"
	},
	"x-world": {
		"x-vrml": ["vrm", "vrml", "wrl", "flr", "wrz", "xaf", "xof"]
	}
};

(() => {
	const mimeTypes = {};
	for (let type in table) {
		// eslint-disable-next-line no-prototype-builtins
		if (table.hasOwnProperty(type)) {
			for (let subtype in table[type]) {
				// eslint-disable-next-line no-prototype-builtins
				if (table[type].hasOwnProperty(subtype)) {
					const value = table[type][subtype];
					if (typeof value == "string") {
						mimeTypes[value] = type + "/" + subtype;
					} else {
						for (let indexMimeType = 0; indexMimeType < value.length; indexMimeType++) {
							mimeTypes[value[indexMimeType]] = type + "/" + subtype;
						}
					}
				}
			}
		}
	}
	return mimeTypes;
})();

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const MAX_32_BITS = 0xffffffff;
const MAX_16_BITS = 0xffff;
const COMPRESSION_METHOD_DEFLATE = 0x08;
const COMPRESSION_METHOD_STORE = 0x00;
const COMPRESSION_METHOD_AES = 0x63;

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIR_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE = 0x07064b50;
const END_OF_CENTRAL_DIR_LENGTH = 22;
const ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH = 20;
const ZIP64_END_OF_CENTRAL_DIR_LENGTH = 56;

const EXTRAFIELD_TYPE_ZIP64 = 0x0001;
const EXTRAFIELD_TYPE_AES = 0x9901;
const EXTRAFIELD_TYPE_UNICODE_PATH = 0x7075;
const EXTRAFIELD_TYPE_UNICODE_COMMENT = 0x6375;

const BITFLAG_ENCRYPTED = 0x01;
const BITFLAG_LEVEL = 0x06;
const BITFLAG_DATA_DESCRIPTOR = 0x0008;
const BITFLAG_ENHANCED_DEFLATING = 0x0010;
const BITFLAG_LANG_ENCODING_FLAG = 0x0800;
const FILE_ATTR_MSDOS_DIR_MASK = 0x10;

const DIRECTORY_SIGNATURE = "/";

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

class Crc32 {

	constructor() {
		this.crc = -1;
		this.table = (() => {
			const table = [];
			for (let i = 0; i < 256; i++) {
				let t = i;
				for (let j = 0; j < 8; j++) {
					if (t & 1) {
						t = (t >>> 1) ^ 0xEDB88320;
					} else {
						t = t >>> 1;
					}
				}
				table[i] = t;
			}
			return table;
		})();
	}

	append(data) {
		const table = this.table;
		let crc = this.crc | 0;
		for (let offset = 0, length = data.length | 0; offset < length; offset++) {
			crc = (crc >>> 8) ^ table[(crc ^ data[offset]) & 0xFF];
		}
		this.crc = crc;
	}

	get() {
		return ~this.crc;
	}
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const ERR_INVALID_PASSORD = "Invalid pasword";
const BLOCK_LENGTH = 16;
const RAW_FORMAT = "raw";
const PBKDF2_ALGORITHM = { name: "PBKDF2" };
const SIGNATURE_ALGORITHM = { name: "HMAC" };
const HASH_FUNCTION = "SHA-1";
const CRYPTO_KEY_ALGORITHM = { name: "AES-CTR" };
const BASE_KEY_ALGORITHM = Object.assign({ hash: SIGNATURE_ALGORITHM }, PBKDF2_ALGORITHM);
const DERIVED_BITS_ALGORITHM = Object.assign({ iterations: 1000, hash: { name: HASH_FUNCTION } }, PBKDF2_ALGORITHM);
const AUTHENTICATION_ALGORITHM = Object.assign({ hash: HASH_FUNCTION }, SIGNATURE_ALGORITHM);
const CRYPTO_ALGORITHM = Object.assign({ length: BLOCK_LENGTH }, CRYPTO_KEY_ALGORITHM);
const DERIVED_BITS_USAGE = ["deriveBits"];
const SIGN_USAGE = ["sign"];
const DERIVED_BITS_LENGTH = 528;
const PREAMBULE_LENGTH = 18;
const SIGNATURE_LENGTH = 10;
const COUNTER_DEFAULT_VALUE = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const subtle = crypto.subtle;

class Decrypt {

	constructor(password, signed) {
		this.password = password;
		this.signed = signed;
		this.input = signed && new Uint8Array(0);
		this.pendingInput = new Uint8Array(0);
	}

	async append(input) {
		const decrypt = async (offset = 0) => {
			if (offset + BLOCK_LENGTH <= buferredInput.length - SIGNATURE_LENGTH) {
				const chunkToDecrypt = buferredInput.subarray(offset, offset + BLOCK_LENGTH);
				const outputChunk = await subtle.decrypt(Object.assign({ counter: this.counter }, CRYPTO_ALGORITHM), this.keys.decrypt, chunkToDecrypt);
				incrementCounter(this.counter);
				output.set(new Uint8Array(outputChunk), offset);
				return decrypt(offset + BLOCK_LENGTH);
			} else {
				this.pendingInput = buferredInput.subarray(offset);
				if (this.signed) {
					this.input = concat(this.input, input);
				}
				return output;
			}
		};

		if (this.password) {
			const preambule = input.subarray(0, PREAMBULE_LENGTH);
			await createDecryptionKeys(this, preambule, this.password);
			this.password = null;
			input = input.subarray(PREAMBULE_LENGTH);
		}
		let output = new Uint8Array(input.length - SIGNATURE_LENGTH - ((input.length - SIGNATURE_LENGTH) % BLOCK_LENGTH));
		let buferredInput = input;
		if (this.pendingInput.length) {
			buferredInput = concat(this.pendingInput, input);
			output = expand(output, buferredInput.length - SIGNATURE_LENGTH - ((buferredInput.length - SIGNATURE_LENGTH) % BLOCK_LENGTH));
		}
		return decrypt();
	}

	async flush() {
		const pendingInput = this.pendingInput;
		const keys = this.keys;
		const chunkToDecrypt = pendingInput.subarray(0, pendingInput.length - SIGNATURE_LENGTH);
		const originalSignatureArray = pendingInput.subarray(pendingInput.length - SIGNATURE_LENGTH);
		let decryptedChunkArray = new Uint8Array(0);
		if (chunkToDecrypt.length) {
			const decryptedChunk = await subtle.decrypt(Object.assign({ counter: this.counter }, CRYPTO_ALGORITHM), keys.decrypt, chunkToDecrypt);
			decryptedChunkArray = new Uint8Array(decryptedChunk);
		}
		let valid = true;
		if (this.signed) {
			const signature = await subtle.sign(SIGNATURE_ALGORITHM, keys.authentication, this.input.subarray(0, this.input.length - SIGNATURE_LENGTH));
			const signatureArray = new Uint8Array(signature);
			this.input = null;
			for (let indexSignature = 0; indexSignature < SIGNATURE_LENGTH; indexSignature++) {
				if (signatureArray[indexSignature] != originalSignatureArray[indexSignature]) {
					valid = false;
				}
			}
		}
		return {
			valid,
			data: decryptedChunkArray
		};
	}

}

class Encrypt {

	constructor(password) {
		this.password = password;
		this.output = new Uint8Array(0);
		this.pendingInput = new Uint8Array(0);
	}

	async append(input) {
		const encrypt = async (offset = 0) => {
			if (offset + BLOCK_LENGTH <= input.length) {
				const chunkToEncrypt = input.subarray(offset, offset + BLOCK_LENGTH);
				const outputChunk = await subtle.encrypt(Object.assign({ counter: this.counter }, CRYPTO_ALGORITHM), this.keys.encrypt, chunkToEncrypt);
				incrementCounter(this.counter);
				output.set(new Uint8Array(outputChunk), offset + preambule.length);
				return encrypt(offset + BLOCK_LENGTH);
			} else {
				this.pendingInput = input.subarray(offset);
				this.output = concat(this.output, output);
				return output;
			}
		};

		let preambule = new Uint8Array(0);
		if (this.password) {
			preambule = await createEncryptionKeys(this, this.password);
			this.password = null;
		}
		let output = new Uint8Array(preambule.length + input.length - (input.length % BLOCK_LENGTH));
		output.set(preambule, 0);
		if (this.pendingInput.length) {
			input = concat(this.pendingInput, input);
			output = expand(output, input.length - (input.length % BLOCK_LENGTH));
		}
		return encrypt();
	}

	async flush() {
		let encryptedChunkArray = new Uint8Array(0);
		if (this.pendingInput.length) {
			const encryptedChunk = await subtle.encrypt(Object.assign({ counter: this.counter }, CRYPTO_ALGORITHM), this.keys.encrypt, this.pendingInput);
			encryptedChunkArray = new Uint8Array(encryptedChunk);
			this.output = concat(this.output, encryptedChunkArray);
		}
		const signature = await subtle.sign(SIGNATURE_ALGORITHM, this.keys.authentication, this.output.subarray(PREAMBULE_LENGTH));
		this.output = null;
		const signatureArray = new Uint8Array(signature).subarray(0, SIGNATURE_LENGTH);
		return {
			data: concat(encryptedChunkArray, signatureArray),
			signature: signatureArray
		};
	}
}

async function createDecryptionKeys(decrypt, preambuleArray, password) {
	decrypt.counter = new Uint8Array(COUNTER_DEFAULT_VALUE);
	const salt = preambuleArray.subarray(0, 16);
	const passwordVerification = preambuleArray.subarray(16);
	const encodedPassword = (new TextEncoder()).encode(password);
	const basekey = await subtle.importKey(RAW_FORMAT, encodedPassword, BASE_KEY_ALGORITHM, false, DERIVED_BITS_USAGE);
	const derivedBits = await subtle.deriveBits(Object.assign({ salt }, DERIVED_BITS_ALGORITHM), basekey, DERIVED_BITS_LENGTH);
	const compositeKey = new Uint8Array(derivedBits);
	const passwordVerificationKey = compositeKey.subarray(64);
	decrypt.keys = {
		decrypt: await subtle.importKey(RAW_FORMAT, compositeKey.subarray(0, 32), CRYPTO_KEY_ALGORITHM, true, ["decrypt"]),
		authentication: await subtle.importKey(RAW_FORMAT, compositeKey.subarray(32, 64), AUTHENTICATION_ALGORITHM, false, SIGN_USAGE),
		passwordVerification: passwordVerificationKey
	};
	if (passwordVerificationKey[0] != passwordVerification[0] || passwordVerificationKey[1] != passwordVerification[1]) {
		throw new Error(ERR_INVALID_PASSORD);
	}
}

async function createEncryptionKeys(encrypt, password) {
	encrypt.counter = new Uint8Array(COUNTER_DEFAULT_VALUE);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const encodedPassword = (new TextEncoder()).encode(password);
	const basekey = await subtle.importKey(RAW_FORMAT, encodedPassword, BASE_KEY_ALGORITHM, false, DERIVED_BITS_USAGE);
	const derivedBits = await subtle.deriveBits(Object.assign({ salt }, DERIVED_BITS_ALGORITHM), basekey, DERIVED_BITS_LENGTH);
	const compositeKey = new Uint8Array(derivedBits);
	encrypt.keys = {
		encrypt: await subtle.importKey(RAW_FORMAT, compositeKey.subarray(0, 32), CRYPTO_KEY_ALGORITHM, true, ["encrypt"]),
		authentication: await subtle.importKey(RAW_FORMAT, compositeKey.subarray(32, 64), AUTHENTICATION_ALGORITHM, false, SIGN_USAGE),
		passwordVerification: compositeKey.subarray(64)
	};
	return concat(salt, encrypt.keys.passwordVerification);
}

function incrementCounter(counter) {
	for (let indexCounter = 0; indexCounter < 16; indexCounter++) {
		if (counter[indexCounter] == 255) {
			counter[indexCounter] = 0;
		} else {
			counter[indexCounter]++;
			break;
		}
	}
}

function concat(leftArray, rightArray) {
	let array = leftArray;
	if (leftArray.length + rightArray.length) {
		array = new Uint8Array(leftArray.length + rightArray.length);
		array.set(leftArray, 0);
		array.set(rightArray, leftArray.length);
	}
	return array;
}

function expand(inputArray, length) {
	if (length && length > inputArray.length) {
		const array = inputArray;
		inputArray = new Uint8Array(length);
		inputArray.set(array, 0);
	}
	return inputArray;
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const CODEC_DEFLATE = "deflate";
const CODEC_INFLATE = "inflate";
const ERR_INVALID_SIGNATURE = "Invalid signature";

class Inflate {

	constructor(options) {
		this.signature = options.inputSignature;
		this.encrypted = Boolean(options.inputPassword);
		this.signed = options.inputSigned;
		this.compressed = options.inputCompressed;
		this.inflate = this.compressed && new options.codecConstructor();
		this.crc32 = this.signed && this.signed && new Crc32();
		this.decrypt = this.encrypted && new Decrypt(options.inputPassword);
	}

	async append(data) {
		if (this.encrypted) {
			data = await this.decrypt.append(data);
		}
		if (this.compressed && data.length) {
			data = await this.inflate.append(data);
		}
		if (!this.encrypted && this.signed) {
			this.crc32.append(data);
		}
		return data;
	}

	async flush() {
		let signature, data = new Uint8Array(0);
		if (this.encrypted) {
			const result = await this.decrypt.flush();
			if (!result.valid) {
				throw new Error(ERR_INVALID_SIGNATURE);
			}
			data = result.data;
		} else if (this.signed) {
			const dataViewSignature = new DataView(new Uint8Array(4).buffer);
			signature = this.crc32.get();
			dataViewSignature.setUint32(0, signature);
			if (this.signature != dataViewSignature.getUint32(0, false)) {
				throw new Error(ERR_INVALID_SIGNATURE);
			}
		}
		if (this.compressed) {
			data = (await this.inflate.append(data)) || new Uint8Array(0);
			await this.inflate.flush();
		}
		return { data, signature };
	}
}

class Deflate {

	constructor(options) {
		this.encrypted = options.outputEncrypted;
		this.signed = options.outputSigned;
		this.compressed = options.outputCompressed;
		this.deflate = this.compressed && new options.codecConstructor({ level: options.level || 5 });
		this.crc32 = this.signed && new Crc32();
		this.encrypt = this.encrypted && new Encrypt(options.outputPassword);
	}

	async append(inputData) {
		let data = inputData;
		if (this.compressed && inputData.length) {
			data = await this.deflate.append(inputData);
		}
		if (this.encrypted) {
			data = await this.encrypt.append(data);
		} else if (this.signed) {
			this.crc32.append(inputData);
		}
		return data;
	}

	async flush() {
		let data = new Uint8Array(0), signature;
		if (this.compressed) {
			data = (await this.deflate.flush()) || new Uint8Array(0);
		}
		if (this.encrypted) {
			data = await this.encrypt.append(data);
			const result = await this.encrypt.flush();
			signature = result.signature;
			const newData = new Uint8Array(data.length + result.data.length);
			newData.set(data, 0);
			newData.set(result.data, data.length);
			data = newData;
		} else if (this.signed) {
			signature = this.crc32.get();
		}
		return { data, signature };
	}
}

function createCodec(options) {
	if (options.codecType.startsWith(CODEC_DEFLATE)) {
		return new Deflate(options);
	} else if (options.codecType.startsWith(CODEC_INFLATE)) {
		return new Inflate(options);
	}
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const MESSAGE_INIT = "init";
const MESSAGE_APPEND = "append";
const MESSAGE_FLUSH = "flush";
const MESSAGE_EVENT_TYPE = "message";

let Z_WORKER_SCRIPT_PATH = "z-worker.js";

const workers = {
	pool: [],
	pendingRequests: []
};

function createWorkerCodec(options, config) {
	const pool = workers.pool;
	const streamCopy =
		!options.inputCompressed && !options.inputSigned && !options.inputEncrypted &&
		!options.outputCompressed && !options.outputSigned && !options.outputEncrypted;
	const webWorker = options.useWebWorkers || (options.useWebWorkers === undefined && config.useWebWorkers && !streamCopy);
	let scripts;
	if (webWorker) {
		const codecType = options.codecType;
		if (config.workerScripts) {
			scripts = config.workerScripts[codecType];
		} else {
			options.workerScriptsPath = (config.workerScriptsPath || "") + Z_WORKER_SCRIPT_PATH;
		}
	}
	if (pool.length < config.maxWorkers) {
		const workerData = {};
		pool.push(workerData);
		return getWorkerInterface(workerData, options, webWorker, scripts);
	} else {
		const workerData = pool.find(workerData => !workerData.busy);
		if (workerData) {
			return getWorkerInterface(workerData, options, webWorker, scripts);
		} else {
			return new Promise(resolve => workers.pendingRequests.push({ resolve, options, webWorker, scripts }));
		}
	}
}

function getWorkerInterface(workerData, options, webWorker, scripts) {
	workerData.busy = true;
	workerData.options = options;
	workerData.scripts = scripts;
	workerData.webWorker = webWorker;
	return webWorker ? createWebWorkerInterface(workerData, options) : createWorkerInterface(workerData);
}

function createWorkerInterface(workerData) {
	const interfaceCodec = createCodec(workerData.options);
	return {
		async append(data) {
			try {
				return await interfaceCodec.append(data);
			} catch (error) {
				onTaskFinished(workerData);
				throw error;
			}
		},
		async flush() {
			try {
				return await interfaceCodec.flush();
			} finally {
				onTaskFinished(workerData);
			}
		}
	};
}

function createWebWorkerInterface(workerData, options) {
	let task;
	if (!workerData.interface) {
		if (workerData.scripts) {
			workerData.worker = new Worker(new URL(workerData.scripts[0], (typeof document === 'undefined' ? new (require('u' + 'rl').URL)('file:' + __filename).href : (document.currentScript && document.currentScript.src || new URL('fastboot.cjs', document.baseURI).href))));
		} else {
			workerData.worker = new Worker(new URL(options.workerScriptsPath, (typeof document === 'undefined' ? new (require('u' + 'rl').URL)('file:' + __filename).href : (document.currentScript && document.currentScript.src || new URL('fastboot.cjs', document.baseURI).href))));
		}
		workerData.worker.addEventListener(MESSAGE_EVENT_TYPE, onMessage, false);
		workerData.interface = {
			append(data) {
				return initAndSendMessage({ type: MESSAGE_APPEND, data });
			},
			flush() {
				return initAndSendMessage({ type: MESSAGE_FLUSH });
			}
		};
	}
	return workerData.interface;

	async function initAndSendMessage(message) {
		if (!task) {
			const options = workerData.options;
			const scripts = workerData.scripts ? workerData.scripts.slice(1) : [];
			await sendMessage(Object.assign({
				scripts,
				type: MESSAGE_INIT, options: {
					codecType: options.codecType,
					inputPassword: options.inputPassword,
					inputSigned: options.inputSigned,
					inputSignature: options.signature,
					inputCompressed: options.inputCompressed,
					inputEncrypted: options.inputEncrypted,
					level: options.level,
					outputPassword: options.outputPassword,
					outputSigned: options.outputSigned,
					outputCompressed: options.outputCompressed,
					outputEncrypted: options.outputEncrypted
				}
			}));
		}
		return sendMessage(message);
	}

	function sendMessage(message) {
		const worker = workerData.worker;
		const result = new Promise((resolve, reject) => task = { resolve, reject });
		try {
			if (message.data) {
				try {
					worker.postMessage(message, [message.data.buffer]);
				} catch (error) {
					worker.postMessage(message);
				}
			} else {
				worker.postMessage(message);
			}
		} catch (error) {
			task.reject(error);
			task = null;
			onTaskFinished(workerData);
		}
		return result;
	}

	function onMessage(event) {
		const message = event.data;
		if (task) {
			const reponseError = message.error;
			if (reponseError) {
				const error = new Error(reponseError.message);
				error.stack = reponseError.stack;
				task.reject(error);
				task = null;
				onTaskFinished(workerData);
			} else if (message.type == MESSAGE_INIT || message.type == MESSAGE_FLUSH || message.type == MESSAGE_APPEND) {
				if (message.type == MESSAGE_FLUSH) {
					task.resolve({ data: new Uint8Array(message.data), signature: message.signature });
					task = null;
					onTaskFinished(workerData);
				} else {
					task.resolve(message.data && new Uint8Array(message.data));
				}
			}
		}
	}
}

function onTaskFinished(workerData) {
	workerData.busy = false;
	if (workers.pendingRequests.length) {
		const [{ resolve, options, webWorker, scripts }] = workers.pendingRequests.splice(0, 1);
		resolve(getWorkerInterface(workerData, options, webWorker, scripts));
	} else {
		if (workerData.worker) {
			workerData.worker.terminate();
		}
		workers.pool = workers.pool.filter(data => data != workerData);
	}
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const MINIMUM_CHUNK_SIZE = 64;

async function processData(codec, reader, writer, offset, inputLength, config, options) {
	const chunkSize = Math.max(config.chunkSize, MINIMUM_CHUNK_SIZE);
	return processChunk();

	async function processChunk(chunkIndex = 0, length = 0) {
		const chunkOffset = chunkIndex * chunkSize;
		if (chunkOffset < inputLength) {
			const inputData = await reader.readUint8Array(chunkOffset + offset, Math.min(chunkSize, inputLength - chunkOffset));
			const data = await codec.append(inputData);
			length += await writeData(writer, data);
			if (options.onprogress) {
				options.onprogress(chunkOffset + inputData.length, inputLength);
			}
			return processChunk(chunkIndex + 1, length);
		} else {
			const result = await codec.flush();
			length += await writeData(writer, result.data);
			return { signature: result.signature, length };
		}
	}
}

async function writeData(writer, data) {
	if (data.length) {
		await writer.writeUint8Array(data);
	}
	return data.length;
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const PROPERTY_NAMES = [
	"filename", "rawFilename", "directory", "encrypted", "compressedSize", "uncompressedSize",
	"lastModDate", "rawLastModDate", "comment", "rawComment", "signature", "extraField",
	"rawExtraField", "bitFlag", "extraFieldZip64", "extraFieldUnicodePath", "extraFieldUnicodeComment",
	"extraFieldAES"];

class Entry {

	constructor(data) {
		PROPERTY_NAMES.forEach(name => this[name] = data[name]);
	}

}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const ERR_BAD_FORMAT = "File format is not recognized";
const ERR_EOCDR_NOT_FOUND = "End of central directory not found";
const ERR_EOCDR_ZIP64_NOT_FOUND = "End of Zip64 central directory not found";
const ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND = "End of Zip64 central directory locator not found";
const ERR_CENTRAL_DIRECTORY_NOT_FOUND = "Central directory header not found";
const ERR_LOCAL_FILE_HEADER_NOT_FOUND = "Local file header not found";
const ERR_EXTRAFIELD_ZIP64_NOT_FOUND = "Zip64 extra field not found";
const ERR_ENCRYPTED = "File contains encrypted entry";
const ERR_UNSUPPORTED_ENCRYPTION = "Encryption not supported";
const ERR_UNSUPPORTED_COMPRESSION = "Compression method not supported";
const CHARSET_UTF8 = "utf-8";
const ZIP64_PROPERTIES = ["uncompressedSize", "compressedSize", "offset"];
const CP437 = [
	"\u0000", "☺", "☻", "♥", "♦", "♣", "♠", "•", "◘", "○", "◙", "♂", "♀", "♪", "♫", "☼", "►", "◄", "↕", "‼", "¶", "§", "▬", "↨", "↑", "↓", "→", "←", "∟", "↔", "▲", "▼", " ", "!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?",
	"@", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "[", "\\", "]", "^", "_", "`", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "{", "|", "}", "~", "⌂",
	"Ç", "ü", "é", "â", "ä", "à", "å", "ç", "ê", "ë", "è", "ï", "î", "ì", "Ä", "Å", "É", "æ", "Æ", "ô", "ö", "ò", "û", "ù", "ÿ", "Ö", "Ü", "¢", "£", "¥", "₧", "ƒ", "á", "í", "ó", "ú", "ñ", "Ñ", "ª", "º", "¿", "⌐", "¬", "½", "¼", "¡", "«", "»", "░", "▒", "▓", "│", "┤", "╡", "╢", "╖", "╕", "╣", "║", "╗", "╝", "╜", "╛", "┐",
	"└", "┴", "┬", "├", "─", "┼", "╞", "╟", "╚", "╔", "╩", "╦", "╠", "═", "╬", "╧", "╨", "╤", "╥", "╙", "╘", "╒", "╓", "╫", "╪", "┘", "┌", "█", "▄", "▌", "▐", "▀", "α", "ß", "Γ", "π", "Σ", "σ", "µ", "τ", "Φ", "Θ", "Ω", "δ", "∞", "φ", "ε", "∩", "≡", "±", "≥", "≤", "⌠", "⌡", "÷", "≈", "°", "∙", "·", "√", "ⁿ", "²", "■", " "];

class ZipReader {

	constructor(reader, options = {}, config = {}) {
		this.reader = reader;
		this.options = options;
		this.config = config;
	}

	async getEntries(options = {}) {
		const reader = this.reader;
		if (!reader.initialized) {
			await reader.init();
		}
		const endOfDirectoryInfo = await seekSignature(reader, END_OF_CENTRAL_DIR_SIGNATURE, END_OF_CENTRAL_DIR_LENGTH, MAX_16_BITS);
		if (!endOfDirectoryInfo) {
			throw new Error(ERR_EOCDR_NOT_FOUND);
		}
		const endOfDirectoryView = new DataView(endOfDirectoryInfo.buffer);
		let zip64;
		let directoryDataOffset = getUint32(endOfDirectoryView, 16);
		let filesLength = getUint16(endOfDirectoryView, 8);
		if (directoryDataOffset == MAX_32_BITS || filesLength == MAX_16_BITS) {
			zip64 = true;
			const endOfDirectoryLocatorArray = await reader.readUint8Array(endOfDirectoryInfo.offset - ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH, ZIP64_END_OF_CENTRAL_DIR_LOCATOR_LENGTH);
			const endOfDirectoryLocatorView = new DataView(endOfDirectoryLocatorArray.buffer);
			if (Number(getUint32(endOfDirectoryLocatorView, 0)) != ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE) {
				throw new Error(ERR_EOCDR_ZIP64_NOT_FOUND);
			}
			directoryDataOffset = Number(getBigUint64(endOfDirectoryLocatorView, 8));
			const endOfDirectoryArray = await reader.readUint8Array(directoryDataOffset, ZIP64_END_OF_CENTRAL_DIR_LENGTH);
			const endOfDirectoryView = new DataView(endOfDirectoryArray.buffer);
			if (Number(getUint32(endOfDirectoryView, 0)) != ZIP64_END_OF_CENTRAL_DIR_SIGNATURE) {
				throw new Error(ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND);
			}
			filesLength = Number(getBigUint64(endOfDirectoryView, 24));
			directoryDataOffset -= Number(getBigUint64(endOfDirectoryView, 40));
		}
		if (directoryDataOffset < 0 || (!zip64 && (directoryDataOffset >= reader.size || filesLength >= MAX_16_BITS))) {
			throw new Error(ERR_BAD_FORMAT);
		}
		const directoryArray = await reader.readUint8Array(directoryDataOffset, reader.size - directoryDataOffset);
		const directoryView = new DataView(directoryArray.buffer);
		const entries = [];
		let offset = 0;
		for (let indexFile = 0; indexFile < filesLength; indexFile++) {
			const fileEntry = new ZipEntry(this.reader, this.config, this.options);
			if (getUint32(directoryView, offset) != CENTRAL_FILE_HEADER_SIGNATURE) {
				throw new Error(ERR_CENTRAL_DIRECTORY_NOT_FOUND);
			}
			fileEntry.compressedSize = 0;
			fileEntry.uncompressedSize = 0;
			readCommonHeader(fileEntry, directoryView, offset + 6);
			fileEntry.commentLength = getUint16(directoryView, offset + 32);
			fileEntry.directory = (getUint8(directoryView, offset + 38) & FILE_ATTR_MSDOS_DIR_MASK) == FILE_ATTR_MSDOS_DIR_MASK;
			fileEntry.offset = getUint32(directoryView, offset + 42);
			fileEntry.rawFilename = directoryArray.subarray(offset + 46, offset + 46 + fileEntry.filenameLength);
			const filenameEncoding = options.filenameEncoding === undefined ? this.options.filenameEncoding : options.filenameEncoding;
			fileEntry.filename = decodeString(fileEntry.rawFilename, fileEntry.bitFlag.languageEncodingFlag ? CHARSET_UTF8 : filenameEncoding);
			if (!fileEntry.directory && fileEntry.filename && fileEntry.filename.charAt(fileEntry.filename.length - 1) == DIRECTORY_SIGNATURE) {
				fileEntry.directory = true;
			}
			fileEntry.rawExtraField = directoryArray.subarray(offset + 46 + fileEntry.filenameLength, offset + 46 + fileEntry.filenameLength + fileEntry.extraFieldLength);
			readCommonFooter(fileEntry, fileEntry, directoryView, offset + 6);
			fileEntry.rawComment = directoryArray.subarray(offset + 46 + fileEntry.filenameLength + fileEntry.extraFieldLength, offset + 46
				+ fileEntry.filenameLength + fileEntry.extraFieldLength + fileEntry.commentLength);
			const commentEncoding = options.commentEncoding === undefined ? this.options.commentEncoding : options.commentEncoding;
			fileEntry.comment = decodeString(fileEntry.rawComment, fileEntry.bitFlag.languageEncodingFlag ? CHARSET_UTF8 : commentEncoding);
			const entry = new Entry(fileEntry);
			entry.getData = (writer, options) => fileEntry.getData(writer, options);
			entries.push(entry);
			offset += 46 + fileEntry.filenameLength + fileEntry.extraFieldLength + fileEntry.commentLength;
		}
		return entries;
	}

	async close() {
	}
}

class ZipEntry {

	constructor(reader, config, options) {
		this.reader = reader;
		this.config = config;
		this.options = options;
	}

	async getData(writer, options = {}) {
		const reader = this.reader;
		if (!reader.initialized) {
			await reader.init();
		}
		const dataArray = await reader.readUint8Array(this.offset, 30);
		const dataView = new DataView(dataArray.buffer);
		const password = options.password === undefined ? this.options.password : options.password;
		let inputPassword = password && password.length && password;
		if (this.extraFieldAES) {
			if (this.extraFieldAES.originalCompressionMethod != COMPRESSION_METHOD_AES) {
				throw new Error(ERR_UNSUPPORTED_COMPRESSION);
			}
			if (this.extraFieldAES.strength != 3) {
				throw new Error(ERR_UNSUPPORTED_ENCRYPTION);
			}
		}
		if (this.compressionMethod != COMPRESSION_METHOD_STORE && this.compressionMethod != COMPRESSION_METHOD_DEFLATE) {
			throw new Error(ERR_UNSUPPORTED_COMPRESSION);
		}
		if (getUint32(dataView, 0) != LOCAL_FILE_HEADER_SIGNATURE) {
			throw new Error(ERR_LOCAL_FILE_HEADER_NOT_FOUND);
		}
		const localDirectory = this.localDirectory = {};
		readCommonHeader(localDirectory, dataView, 4);
		localDirectory.rawExtraField = dataArray.subarray(this.offset + 30 + localDirectory.filenameLength, this.offset + 30 + localDirectory.filenameLength + localDirectory.extraFieldLength);
		readCommonFooter(this, localDirectory, dataView, 4);
		let dataOffset = this.offset + 30 + localDirectory.filenameLength + localDirectory.extraFieldLength;
		const inputEncrypted = this.bitFlag.encrypted && localDirectory.bitFlag.encrypted;
		if (inputEncrypted && !inputPassword) {
			throw new Error(ERR_ENCRYPTED);
		}
		const codec = await createWorkerCodec({
			codecType: CODEC_INFLATE,
			codecConstructor: this.config.Inflate,
			inputPassword,
			inputSigned: options.checkSignature === undefined ? this.options.checkSignature : options.checkSignature,
			inputSignature: this.signature,
			inputCompressed: this.compressionMethod != 0,
			inputEncrypted,
			useWebWorkers: options.useWebWorkers === undefined ? this.options.useWebWorkers : options.useWebWorkers
		}, this.config);
		if (!writer.initialized) {
			await writer.init();
		}
		await processData(codec, reader, writer, dataOffset, this.compressedSize, this.config, { onprogress: options.onprogress });
		return writer.getData();
	}
}

function readCommonHeader(directory, dataView, offset) {
	directory.version = getUint16(dataView, offset);
	const rawBitFlag = directory.rawBitFlag = getUint16(dataView, offset + 2);
	directory.bitFlag = {
		encrypted: (rawBitFlag & BITFLAG_ENCRYPTED) == BITFLAG_ENCRYPTED,
		level: (rawBitFlag & BITFLAG_LEVEL) >> 1,
		dataDescriptor: (rawBitFlag & BITFLAG_DATA_DESCRIPTOR) == BITFLAG_DATA_DESCRIPTOR,
		languageEncodingFlag: (rawBitFlag & BITFLAG_LANG_ENCODING_FLAG) == BITFLAG_LANG_ENCODING_FLAG
	};
	directory.encrypted = directory.bitFlag.encrypted;
	directory.rawLastModDate = getUint32(dataView, offset + 6);
	directory.lastModDate = getDate(directory.rawLastModDate);
	directory.filenameLength = getUint16(dataView, offset + 22);
	directory.extraFieldLength = getUint16(dataView, offset + 24);
}

function readCommonFooter(fileEntry, directory, dataView, offset) {
	const rawExtraField = directory.rawExtraField;
	const extraField = directory.extraField = new Map();
	const rawExtraFieldView = new DataView(new Uint8Array(rawExtraField).buffer);
	let offsetExtraField = 0;
	try {
		while (offsetExtraField < rawExtraField.length) {
			const type = getUint16(rawExtraFieldView, offsetExtraField);
			const size = getUint16(rawExtraFieldView, offsetExtraField + 2);
			extraField.set(type, {
				type,
				data: rawExtraField.slice(offsetExtraField + 4, offsetExtraField + 4 + size)
			});
			offsetExtraField += 4 + size;
		}
	} catch (error) {
		// ignored
	}
	const compressionMethod = getUint16(dataView, offset + 4);
	directory.signature = getUint32(dataView, offset + 10);
	directory.uncompressedSize = getUint32(dataView, offset + 18);
	directory.compressedSize = getUint32(dataView, offset + 14);
	const extraFieldZip64 = directory.extraFieldZip64 = extraField.get(EXTRAFIELD_TYPE_ZIP64);
	if (extraFieldZip64) {
		readExtraFieldZip64(extraFieldZip64, directory);
	}
	const extraFieldUnicodePath = directory.extraFieldUnicodePath = extraField.get(EXTRAFIELD_TYPE_UNICODE_PATH);
	if (extraFieldUnicodePath) {
		readExtraFieldUnicode(extraFieldUnicodePath, "filename", "rawFilename", directory, fileEntry);
	}
	let extraFieldUnicodeComment = directory.extraFieldUnicodeComment = extraField.get(EXTRAFIELD_TYPE_UNICODE_COMMENT);
	if (extraFieldUnicodeComment) {
		readExtraFieldUnicode(extraFieldUnicodeComment, "comment", "rawComment", directory, fileEntry);
	}
	const extraFieldAES = directory.extraFieldAES = extraField.get(EXTRAFIELD_TYPE_AES);
	if (extraFieldAES) {
		readExtraFieldAES(extraFieldAES, directory, compressionMethod);
	} else {
		directory.compressionMethod = compressionMethod;
	}
	if (directory.compressionMethod == COMPRESSION_METHOD_DEFLATE) {
		directory.bitFlag.enhancedDeflating = (directory.rawBitFlag & BITFLAG_ENHANCED_DEFLATING) != BITFLAG_ENHANCED_DEFLATING;
	}
}

function readExtraFieldZip64(extraFieldZip64, directory) {
	directory.zip64 = true;
	const extraFieldView = new DataView(extraFieldZip64.data.buffer);
	extraFieldZip64.values = [];
	for (let indexValue = 0; indexValue < Math.floor(extraFieldZip64.data.length / 8); indexValue++) {
		extraFieldZip64.values.push(Number(getBigUint64(extraFieldView, 0 + indexValue * 8)));
	}
	const missingProperties = ZIP64_PROPERTIES.filter(propertyName => directory[propertyName] == MAX_32_BITS);
	for (let indexMissingProperty = 0; indexMissingProperty < missingProperties.length; indexMissingProperty++) {
		extraFieldZip64[missingProperties[indexMissingProperty]] = extraFieldZip64.values[indexMissingProperty];
	}
	ZIP64_PROPERTIES.forEach(propertyName => {
		if (directory[propertyName] == MAX_32_BITS) {
			if (extraFieldZip64 && extraFieldZip64[propertyName] !== undefined) {
				directory[propertyName] = extraFieldZip64[propertyName];
			} else {
				throw new Error(ERR_EXTRAFIELD_ZIP64_NOT_FOUND);
			}
		}
	});
}

function readExtraFieldUnicode(extraFieldUnicode, propertyName, rawPropertyName, directory, fileEntry) {
	const extraFieldView = new DataView(extraFieldUnicode.data.buffer);
	extraFieldUnicode.version = getUint8(extraFieldView, 0);
	extraFieldUnicode.signature = getUint32(extraFieldView, 1);
	const crc32 = new Crc32();
	crc32.append(fileEntry[rawPropertyName]);
	const dataViewSignature = new DataView(new Uint8Array(4).buffer);
	dataViewSignature.setUint32(0, crc32.get(), true);
	extraFieldUnicode[propertyName] = (new TextDecoder()).decode(extraFieldUnicode.data.subarray(5));
	extraFieldUnicode.valid = !fileEntry.bitFlag.languageEncodingFlag && extraFieldUnicode.signature == getUint32(dataViewSignature, 0);
	if (extraFieldUnicode.valid) {
		directory[propertyName] = extraFieldUnicode[propertyName];
	}
}

function readExtraFieldAES(extraFieldAES, directory, compressionMethod) {
	if (extraFieldAES) {
		const extraFieldView = new DataView(extraFieldAES.data.buffer);
		extraFieldAES.vendorVersion = getUint8(extraFieldView, 0);
		extraFieldAES.vendorId = getUint8(extraFieldView, 2);
		const strength = getUint8(extraFieldView, 4);
		extraFieldAES.strength = strength;
		extraFieldAES.originalCompressionMethod = compressionMethod;
		directory.compressionMethod = extraFieldAES.compressionMethod = getUint16(extraFieldView, 5);
	} else {
		directory.compressionMethod = compressionMethod;
	}
}

async function seekSignature(reader, signature, minimumBytes, maximumLength) {
	const signatureArray = new Uint8Array(4);
	const signatureView = new DataView(signatureArray.buffer);
	setUint32(signatureView, 0, signature);
	if (reader.size < minimumBytes) {
		throw new Error(ERR_BAD_FORMAT);
	}
	const maximumBytes = minimumBytes + maximumLength;
	let offset = minimumBytes;
	let dataInfo = await seek(offset);
	if (!dataInfo) {
		dataInfo = await seek(Math.min(maximumBytes, reader.size));
	}
	return dataInfo;

	async function seek(length) {
		const offset = reader.size - length;
		const bytes = await reader.readUint8Array(offset, length);
		for (let indexByte = bytes.length - minimumBytes; indexByte >= 0; indexByte--) {
			if (bytes[indexByte] == signatureArray[0] && bytes[indexByte + 1] == signatureArray[1] &&
				bytes[indexByte + 2] == signatureArray[2] && bytes[indexByte + 3] == signatureArray[3]) {
				return {
					offset,
					buffer: bytes.slice(indexByte, indexByte + minimumBytes).buffer
				};
			}
		}
	}
}

function decodeString(value, encoding) {
	if (!encoding || encoding.trim().toLowerCase() == "cp437") {
		let result = "";
		for (let indexCharacter = 0; indexCharacter < value.length; indexCharacter++) {
			result += CP437[value[indexCharacter]];
		}
		return result;
	} else {
		return (new TextDecoder(encoding)).decode(value);
	}
}

function getDate(timeRaw) {
	const date = (timeRaw & 0xffff0000) >> 16, time = timeRaw & 0x0000ffff;
	try {
		return new Date(1980 + ((date & 0xFE00) >> 9), ((date & 0x01E0) >> 5) - 1, date & 0x001F, (time & 0xF800) >> 11, (time & 0x07E0) >> 5, (time & 0x001F) * 2, 0);
	} catch (error) {
		// ignored
	}
}

function getUint8(view, offset) {
	return view.getUint8(offset);
}

function getUint16(view, offset) {
	return view.getUint16(offset, true);
}

function getUint32(view, offset) {
	return view.getUint32(offset, true);
}

function getBigUint64(view, offset) {
	return view.getBigUint64(offset, true);
}

function setUint32(view, offset, value) {
	view.setUint32(offset, value, true);
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
const TEXT_PLAIN = "text/plain";

class Stream {

	constructor() {
		this.size = 0;
	}

	init() {
		this.initialized = true;
	}
}
class Reader extends Stream {
}

class Writer extends Stream {

	writeUint8Array(array) {
		this.size += array.length;
	}
}

class TextWriter extends Writer {

	constructor(encoding) {
		super();
		this.encoding = encoding;
		this.blob = new Blob([], { type: TEXT_PLAIN });
	}

	writeUint8Array(array) {
		super.writeUint8Array(array);
		this.blob = new Blob([this.blob, array.buffer], { type: TEXT_PLAIN });
	}

	getData() {
		const reader = new FileReader();
		return new Promise((resolve, reject) => {
			reader.onload = event => resolve(event.target.result);
			reader.onerror = reject;
			reader.readAsText(this.blob, this.encoding);
		});
	}
}

class BlobReader extends Reader {

	constructor(blob) {
		super();
		this.blob = blob;
		this.size = blob.size;
	}

	readUint8Array(offset, length) {
		const reader = new FileReader();
		return new Promise((resolve, reject) => {
			reader.onload = event => resolve(new Uint8Array(event.target.result));
			reader.onerror = reject;
			reader.readAsArrayBuffer(this.blob.slice(offset, offset + length));
		});
	}
}

class BlobWriter extends Writer {

	constructor(contentType) {
		super();
		this.offset = 0;
		this.contentType = contentType;
		this.blob = new Blob([], { type: contentType });
	}

	writeUint8Array(array) {
		super.writeUint8Array(array);
		this.blob = new Blob([this.blob, array.buffer], { type: this.contentType });
		this.offset = this.blob.size;
	}

	getData() {
		return this.blob;
	}
}

/*
 Copyright (c) 2021 Gildas Lormeau. All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
 this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright 
 notice, this list of conditions and the following disclaimer in 
 the documentation and/or other materials provided with the distribution.

 3. The names of the authors may not be used to endorse or promote products
 derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL JCRAFT,
 INC. OR ANY CONTRIBUTORS TO THIS SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const DEFAULT_CONFIGURATION = {
	chunkSize: 512 * 1024,
	maxWorkers: (typeof navigator != "undefined" && navigator.hardwareConcurrency) || 2,
	workerScriptsPath: undefined,
	useWebWorkers: true
};

let config = Object.assign({}, DEFAULT_CONFIGURATION);

class ZipReader$1 extends ZipReader {

	constructor(reader, options) {
		super(reader, options, config);
	}
}

function configure(configuration) {
	config = Object.assign({}, config, configuration);
	if (config.workerScripts != null && config.workerScriptsPath != null) {
		throw new Error("Either workerScripts or workerScriptsPath may be set, not both");
	}
	if (config.workerScripts) {
		if (config.workerScripts.deflate && !Array.isArray(config.workerScripts.deflate)) {
			throw new Error("workerScripts.deflate must be an array");
		}
		if (config.workerScripts.inflate && !Array.isArray(config.workerScripts.inflate)) {
			throw new Error("workerScripts.inflate must be an array");
		}
	}
}

// Images needed for fastbootd
const BOOT_CRITICAL_IMAGES = [
    "boot",
    "vendor_boot",
    "dtbo",
    "dt",
    "vbmeta",
    "vbmeta_system",
];

// Less critical images to flash after boot-critical ones
const SYSTEM_IMAGES = ["odm", "product", "system", "system_ext", "vendor"];

/** User-friendly action strings */
const USER_ACTION_MAP = {
    load: "Loading",
    unpack: "Unpacking",
    flash: "Flashing",
    wipe: "Wiping",
    reboot: "Restarting",
};

const BOOTLOADER_REBOOT_TIME = 4000; // ms
const FASTBOOTD_REBOOT_TIME = 16000; // ms
const USERDATA_ERASE_TIME = 1000; // ms

// Wrapper for Entry#getData() to unwrap ProgressEvent errors
async function zipGetData(entry, writer, options = undefined) {
    try {
        return await entry.getData(writer, options);
    } catch (e) {
        if (e instanceof ProgressEvent && e.type === "error") {
            throw e.target.error;
        } else {
            throw e;
        }
    }
}

async function flashEntryBlob(device, entry, onProgress, partition) {
    logDebug(`Unpacking ${partition}`);
    onProgress("unpack", partition, 0.0);
    let blob = await zipGetData(
        entry,
        new BlobWriter("application/octet-stream"),
        {
            onprogress: (bytes, len) => {
                onProgress("unpack", partition, bytes / len);
            },
        }
    );

    logDebug(`Flashing ${partition}`);
    onProgress("flash", partition, 0.0);
    await device.flashBlob(partition, blob, (progress) => {
        onProgress("flash", partition, progress);
    });
}

async function tryFlashImages(device, entries, onProgress, imageNames) {
    for (let imageName of imageNames) {
        let pattern = new RegExp(`${imageName}(?:-.+)?\\.img$`);
        let entry = entries.find((entry) => entry.filename.match(pattern));
        if (entry !== undefined) {
            await flashEntryBlob(device, entry, onProgress, imageName);
        }
    }
}

async function checkRequirements(device, androidInfo) {
    // Deal with CRLF just in case
    for (let line of androidInfo.replace("\r", "").split("\n")) {
        let match = line.match(/^require\s+(.+?)=(.+)$/);
        if (!match) {
            continue;
        }

        let variable = match[1];
        // Historical mismatch that we still need to deal with
        if (variable === "board") {
            variable = "product";
        }

        let expectValue = match[2];
        let expectValues = expectValue.split("|");

        // Special case: not a real variable at all
        if (variable === "partition-exists") {
            // Check whether the partition exists on the device:
            // has-slot = undefined || FAIL => doesn't exist
            // has-slot = yes || no         => exists
            let hasSlot = await device.getVariable(`has-slot:${expectValue}`);
            if (hasSlot !== "yes" && hasSlot !== "no") {
                throw new FastbootError(
                    "FAIL",
                    `Requirement ${variable}=${expectValue} failed, device lacks partition`
                );
            }

            // Check whether we recognize the partition
            if (
                !BOOT_CRITICAL_IMAGES.includes(expectValue) &&
                !SYSTEM_IMAGES.includes(expectValue)
            ) {
                throw new FastbootError(
                    "FAIL",
                    `Requirement ${variable}=${expectValue} failed, unrecognized partition`
                );
            }
        } else {
            let realValue = await device.getVariable(variable);

            if (expectValues.includes(realValue)) {
                logDebug(
                    `Requirement ${variable}=${expectValue} passed`
                );
            } else {
                let msg = `Requirement ${variable}=${expectValue} failed, value = ${realValue}`;
                logDebug(msg);
                throw new FastbootError("FAIL", msg);
            }
        }
    }
}

async function tryReboot(device, target, onReconnect) {
    try {
        await device.reboot(target, false);
    } catch (e) {
        /* Failed = device rebooted by itself */
    }

    await device.waitForConnect(onReconnect);
}

async function flashZip(
    device,
    blob,
    wipe,
    onReconnect,
    onProgress = () => {}
) {
    onProgress("load", "package", 0.0);
    let reader = new ZipReader$1(new BlobReader(blob));
    let entries = await reader.getEntries();

    // Bootloader and radio packs can only be flashed in the bare-metal bootloader
    if ((await device.getVariable("is-userspace")) === "yes") {
        await device.reboot("bootloader", true, onReconnect);
    }

    // 1. Bootloader pack
    await tryFlashImages(device, entries, onProgress, ["bootloader"]);
    await runWithTimedProgress(
        onProgress,
        "reboot",
        "device",
        BOOTLOADER_REBOOT_TIME,
        tryReboot(device, "bootloader", onReconnect)
    );

    // 2. Radio pack
    await tryFlashImages(device, entries, onProgress, ["radio"]);
    await runWithTimedProgress(
        onProgress,
        "reboot",
        "device",
        BOOTLOADER_REBOOT_TIME,
        tryReboot(device, "bootloader", onReconnect)
    );

    // Cancel snapshot update if in progress
    let snapshotStatus = await device.getVariable("snapshot-update-status");
    if (snapshotStatus !== undefined && snapshotStatus !== "none") {
        await device.runCommand("snapshot-update:cancel");
    }

    // Load nested images for the following steps
    logDebug("Loading nested images from zip");
    onProgress("unpack", "images", 0.0);
    let entry = entries.find((e) => e.filename.match(/image-.+\.zip$/));
    let imagesBlob = await zipGetData(
        entry,
        new BlobWriter("application/zip"),
        {
            onprogress: (bytes, len) => {
                onProgress("unpack", "images", bytes / len);
            },
        }
    );
    let imageReader = new ZipReader$1(new BlobReader(imagesBlob));
    let imageEntries = await imageReader.getEntries();

    // 3. Check requirements
    entry = imageEntries.find((e) => e.filename === "android-info.txt");
    if (entry !== undefined) {
        let reqText = await zipGetData(entry, new TextWriter());
        await checkRequirements(device, reqText);
    }

    // 4. Boot-critical images
    await tryFlashImages(
        device,
        imageEntries,
        onProgress,
        BOOT_CRITICAL_IMAGES
    );

    // 5. Super partition template
    // This is also where we reboot to fastbootd.
    entry = imageEntries.find((e) => e.filename === "super_empty.img");
    if (entry !== undefined) {
        await runWithTimedProgress(
            onProgress,
            "reboot",
            "device",
            FASTBOOTD_REBOOT_TIME,
            device.reboot("fastboot", true, onReconnect)
        );

        let superName = await device.getVariable("super-partition-name");
        if (!superName) {
            superName = "super";
        }

        let superAction = wipe ? "wipe" : "flash";
        onProgress(superAction, "super", 0.0);
        let superBlob = await zipGetData(
            entry,
            new BlobWriter("application/octet-stream")
        );
        await device.upload(
            superName,
            await readBlobAsBuffer(superBlob),
            (progress) => {
                onProgress(superAction, "super", progress);
            }
        );
        await device.runCommand(
            `update-super:${superName}${wipe ? ":wipe" : ""}`
        );
    }

    // 6. Remaining system images
    await tryFlashImages(device, imageEntries, onProgress, SYSTEM_IMAGES);

    // We unconditionally reboot back to the bootloader here if we're in fastbootd,
    // even when there's no custom AVB key, because common follow-up actions like
    // locking the bootloader and wiping data need to be done in the bootloader.
    if ((await device.getVariable("is-userspace")) === "yes") {
        await runWithTimedProgress(
            onProgress,
            "reboot",
            "device",
            BOOTLOADER_REBOOT_TIME,
            device.reboot("bootloader", true, onReconnect)
        );
    }

    // 7. Custom AVB key
    entry = entries.find((e) => e.filename.endsWith("avb_pkmd.bin"));
    if (entry !== undefined) {
        await device.runCommand("erase:avb_custom_key");
        await flashEntryBlob(device, entry, onProgress, "avb_custom_key");
    }

    // 8. Wipe userdata
    if (wipe) {
        await runWithTimedProgress(
            onProgress,
            "wipe",
            "data",
            USERDATA_ERASE_TIME,
            device.runCommand("erase:userdata")
        );
    }
}

const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const BULK_TRANSFER_SIZE = 16384;

const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB
// To conserve RAM and work around Chromium's ~2 GiB size limit, we limit the
// max download size even if the bootloader can accept more data.
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024; // 1 GiB

/** Exception class for USB or WebUSB-level errors. */
class UsbError extends Error {
    constructor(message) {
        super(message);
        this.name = "UsbError";
    }
}

/** Exception class for bootloader and high-level fastboot errors. */
class FastbootError extends Error {
    constructor(status, message) {
        super(`Bootloader replied with ${status}: ${message}`);
        this.status = status;
        this.bootloaderMessage = message;
        this.name = "FastbootError";
    }
}

/**
 * Implements fastboot commands and operations for a device connected over USB.
 */
class FastbootDevice {
    /**
     * Creates a new fastboot device object ready to connect to a USB device.
     * This does not actually connect to any devices.
     *
     * @see connect
     */
    constructor() {
        this.device = null;
        this._registeredUsbListeners = false;
        this._connectResolve = null;
        this._connectReject = null;
        this._disconnectResolve = null;
    }

    /**
     * Returns whether the USB device is currently connected.
     */
    get isConnected() {
        return this.device !== null;
    }

    /**
     * Validates the current USB device's details and connects to it.
     *
     * @private
     */
    async _validateAndConnectDevice() {
        // Validate device
        let ife = this.device.configurations[0].interfaces[0].alternates[0];
        if (ife.endpoints.length !== 2) {
            throw new UsbError("Interface has wrong number of endpoints");
        }

        let epIn = null;
        let epOut = null;
        for (let endpoint of ife.endpoints) {
            logVerbose("Checking endpoint:", endpoint);
            if (endpoint.type !== "bulk") {
                throw new UsbError("Interface endpoint is not bulk");
            }

            if (endpoint.direction === "in") {
                if (epIn === null) {
                    epIn = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple IN endpoints");
                }
            } else if (endpoint.direction === "out") {
                if (epOut === null) {
                    epOut = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple OUT endpoints");
                }
            }
        }
        logVerbose("Endpoints: in =", epIn, ", out =", epOut);

        try {
            await this.device.open();
            // Opportunistically reset to fix issues on some platforms
            try {
                await this.device.reset();
            } catch (error) {
                /* Failed = doesn't support reset */
            }

            await this.device.selectConfiguration(1);
            await this.device.claimInterface(0); // fastboot
        } catch (error) {
            // Propagate exception from waitForConnect()
            if (this._connectReject !== null) {
                this._connectReject(error);
                this._connectResolve = null;
                this._connectReject = null;
            }

            this.device = null;
            throw error;
        }

        // Return from waitForConnect()
        if (this._connectResolve !== null) {
            this._connectResolve();
            this._connectResolve = null;
            this._connectReject = null;
        }
    }

    /**
     * Wait for the current USB device to disconnect, if it's still connected.
     * This function returns immediately if no device is connected.
     */
    async waitForDisconnect() {
        if (this.device === null) {
            return;
        }

        return await new Promise((resolve, _reject) => {
            this._disconnectResolve = resolve;
        });
    }

    /**
     * Callback for reconnecting the USB device.
     * This is necessary because some platforms do not support automatic reconnection,
     * and USB connection requests can only be triggered as the result of explicit
     * user action.
     *
     * @callback ReconnectCallback
     */

    /**
     * Wait for the USB device to connect. This function returns at the next
     * connection, regardless of whether the device is the same.
     *
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection.
     */
    async waitForConnect(onReconnect = () => {}) {
        // On Android, we need to request the user to reconnect the device manually
        // because there is no support for automatic reconnection.
        if (navigator.userAgent.includes("Android")) {
            await this.waitForDisconnect();
            onReconnect();
        }

        return await new Promise((resolve, reject) => {
            this._connectResolve = resolve;
            this._connectReject = reject;
        });
    }

    /**
     * Request the user to select a USB device and attempt to connect to it
     * using the fastboot protocol.
     *
     * @throws {UsbError}
     */
    async connect() {
        let devices = await navigator.usb.getDevices();
        logDebug("Found paired USB devices:", devices);
        if (devices.length === 1) {
            this.device = devices[0];
        } else {
            // If multiple paired devices are connected, request the user to
            // select a specific one to reduce ambiguity. This is also necessary
            // if no devices are already paired, i.e. first use.
            logDebug(
                "No or multiple paired devices are connected, requesting one"
            );
            this.device = await navigator.usb.requestDevice({
                filters: [
                    {
                        classCode: FASTBOOT_USB_CLASS,
                        subclassCode: FASTBOOT_USB_SUBCLASS,
                        protocolCode: FASTBOOT_USB_PROTOCOL,
                    },
                ],
            });
        }
        logDebug("Using USB device:", this.device);

        if (!this._registeredUsbListeners) {
            navigator.usb.addEventListener("disconnect", (event) => {
                if (event.device === this.device) {
                    logDebug("USB device disconnected");
                    this.device = null;
                    if (this._disconnectResolve !== null) {
                        this._disconnectResolve();
                        this._disconnectResolve = null;
                    }
                }
            });

            navigator.usb.addEventListener("connect", async (event) => {
                logDebug("USB device connected");
                this.device = event.device;
                await this._validateAndConnectDevice();
            });

            this._registeredUsbListeners = true;
        }

        await this._validateAndConnectDevice();
    }

    /**
     * Reads a raw command response from the bootloader.
     *
     * @private
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async _readResponse() {
        let returnData = {
            text: "",
            dataSize: null,
        };
        let respStatus;
        do {
            let respPacket = await this.device.transferIn(0x01, 64);
            let response = new TextDecoder().decode(respPacket.data);

            respStatus = response.substring(0, 4);
            let respMessage = response.substring(4);
            logDebug(`Response: ${respStatus} ${respMessage}`);

            if (respStatus === "OKAY") {
                // OKAY = end of response for this command
                returnData.text += respMessage;
            } else if (respStatus === "INFO") {
                // INFO = additional info line
                returnData.text += respMessage + "\n";
            } else if (respStatus === "DATA") {
                // DATA = hex string, but it's returned separately for safety
                returnData.dataSize = respMessage;
            } else {
                // Assume FAIL or garbage data
                throw new FastbootError(respStatus, respMessage);
            }
            // INFO means that more packets are coming
        } while (respStatus === "INFO");

        return returnData;
    }

    /**
     * Sends a textual command to the bootloader.
     * This is in raw fastboot format, not AOSP fastboot syntax.
     *
     * @param {string} command - The command to send.
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async runCommand(command) {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder("utf-8").encode(command);
        await this.device.transferOut(0x01, cmdPacket);
        logDebug("Command:", command);

        return this._readResponse();
    }

    /**
     * Returns the value of a bootloader variable.
     *
     * @param {string} varName - The name of the variable to get.
     * @returns {value} Textual content of the variable.
     * @throws {FastbootError}
     */
    async getVariable(varName) {
        let resp;
        try {
            resp = (await this.runCommand(`getvar:${varName}`)).text;
        } catch (error) {
            // Some bootloaders return FAIL instead of empty responses, despite
            // what the spec says. Normalize it here.
            if (error instanceof FastbootError && error.status == "FAIL") {
                resp = undefined;
            } else {
                throw error;
            }
        }

        // Some bootloaders send whitespace around some variables.
        // According to the spec, non-existent variables should return empty
        // responses
        return resp ? resp.trim() : undefined;
    }

    /**
     * Returns the maximum download size for a single payload, in bytes.
     *
     * @private
     * @returns {downloadSize}
     * @throws {FastbootError}
     */
    async _getDownloadSize() {
        try {
            let resp = (
                await this.getVariable("max-download-size")
            ).toLowerCase();
            if (resp) {
                // AOSP fastboot requires hex
                return Math.min(parseInt(resp, 16), MAX_DOWNLOAD_SIZE);
            }
        } catch (error) {
            /* Failed = no value, fallthrough */
        }

        // FAIL or empty variable means no max, set a reasonable limit to conserve memory
        return DEFAULT_DOWNLOAD_SIZE;
    }

    /**
     * Callback for progress updates while flashing or uploading an image.
     *
     * @callback ProgressCallback
     * @param {number} progress - Progress within the current action between 0 and 1.
     */

    /**
     * Reads a raw command response from the bootloader.
     *
     * @private
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async _sendRawPayload(buffer, onProgress) {
        let i = 0;
        let remainingBytes = buffer.byteLength;
        while (remainingBytes > 0) {
            let chunk = buffer.slice(
                i * BULK_TRANSFER_SIZE,
                (i + 1) * BULK_TRANSFER_SIZE
            );
            if (i % 1000 === 0) {
                logVerbose(
                    `  Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`
                );
            }
            if (i % 10 === 0) {
                onProgress(
                    (buffer.byteLength - remainingBytes) / buffer.byteLength
                );
            }

            await this.device.transferOut(0x01, chunk);

            remainingBytes -= chunk.byteLength;
            i += 1;
        }

        onProgress(1.0);
    }

    /**
     * Uploads a payload to the bootloader for further use.
     * Does not handle raw images, flashing, or splitting.
     *
     * @param {string} partition - Name of the partition the payload is intended for.
     * @param {ArrayBuffer} buffer - Buffer containing the data to upload.
     * @param {ProgressCallback} onProgress - Callback for upload progress updates.
     * @throws {FastbootError}
     */
    async upload(partition, buffer, onProgress = () => {}) {
        logDebug(
            `Uploading single sparse to ${partition}: ${buffer.byteLength} bytes`
        );

        // Bootloader requires an 8-digit hex number
        let xferHex = buffer.byteLength.toString(16).padStart(8, "0");
        if (xferHex.length !== 8) {
            throw new FastbootError(
                "FAIL",
                `Transfer size overflow: ${xferHex} is more than 8 digits`
            );
        }

        // Check with the device and make sure size matches
        let downloadResp = await this.runCommand(`download:${xferHex}`);
        if (downloadResp.dataSize === null) {
            throw new FastbootError(
                "FAIL",
                `Unexpected response to download command: ${downloadResp.text}`
            );
        }
        let downloadSize = parseInt(downloadResp.dataSize, 16);
        if (downloadSize !== buffer.byteLength) {
            throw new FastbootError(
                "FAIL",
                `Bootloader wants ${buffer.byteLength} bytes, requested to send ${buffer.bytelength} bytes`
            );
        }

        logDebug(`Sending payload: ${buffer.byteLength} bytes`);
        await this._sendRawPayload(buffer, onProgress);

        logDebug("Payload sent, waiting for response...");
        await this._readResponse();
    }

    /**
     * Reboots to the given target and waits for the device to reconnect, unless
     * otherwise specified.
     *
     * @param {string} target - Where to reboot to, i.e. fastboot or bootloader.
     * @param {boolean} wait - Whether to wait for the device to reconnect.
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection, if wait is enabled.
     */
    async reboot(target = "", wait = false, onReconnect = () => {}) {
        if (target.length > 0) {
            await this.runCommand(`reboot-${target}`);
        } else {
            await this.runCommand("reboot");
        }

        if (wait) {
            await this.waitForConnect(onReconnect);
        }
    }

    /**
     * Flashes the given File or Blob to the given partition on the device.
     *
     * @param {string} partition - The name of the partition to flash.
     * @param {Blob} blob - The Blob to retrieve data from.
     * @param {ProgressCallback} onProgress - Callback for flashing progress updates.
     * @throws {FastbootError}
     */
    async flashBlob(partition, blob, onProgress = () => {}) {
        // Use current slot if partition is A/B
        if ((await this.getVariable(`has-slot:${partition}`)) === "yes") {
            partition += "_" + (await this.getVariable("current-slot"));
        }

        let maxDlSize = await this._getDownloadSize();
        let fileHeader = await readBlobAsBuffer(
            blob.slice(0, FILE_HEADER_SIZE)
        );
        let totalBytes = 0;
        if (isSparse(fileHeader)) {
            let sparseHeader = parseFileHeader(fileHeader);
            totalBytes = sparseHeader.blocks * sparseHeader.blockSize;
        } else {
            totalBytes = blob.size;
        }

        // Logical partitions need to be resized before flashing because they're
        // sized perfectly to the payload.
        if ((await this.getVariable(`is-logical:${partition}`)) === "yes") {
            // As per AOSP fastboot, we reset the partition to 0 bytes first
            // to optimize extent allocation.
            await this.runCommand(`resize-logical-partition:${partition}:0`);
            // Set the actual size
            await this.runCommand(
                `resize-logical-partition:${partition}:${totalBytes}`
            );
        }

        // Convert image to sparse (for splitting) if it exceeds the size limit
        if (blob.size > maxDlSize && !isSparse(fileHeader)) {
            logDebug(`${partition} image is raw, converting to sparse`);

            // Assume that non-sparse images will always be small enough to convert in RAM.
            // The buffer is converted to a Blob for compatibility with the existing flashing code.
            let rawData = await readBlobAsBuffer(blob);
            let sparse = fromRaw(rawData);
            blob = new Blob([sparse]);
        }

        logDebug(
            `Flashing ${blob.size} bytes to ${partition}, ${maxDlSize} bytes per split`
        );
        let splits = 0;
        let sentBytes = 0;
        for await (let split of splitBlob(blob, maxDlSize)) {
            await this.upload(partition, split.data, (progress) => {
                onProgress((sentBytes + progress * split.bytes) / totalBytes);
            });

            logDebug("Flashing payload...");
            await this.runCommand(`flash:${partition}`);

            splits += 1;
            sentBytes += split.bytes;
        }

        logDebug(`Flashed ${partition} with ${splits} split(s)`);
    }

    /**
     * Callback for reconnecting the USB device.
     * This is necessary because some platforms do not support automatic reconnection,
     * and USB connection requests can only be triggered as the result of explicit
     * user action.
     *
     * @callback ReconnectCallback
     */

    /**
     * Callback for factory image flashing progress.
     *
     * @callback FactoryFlashCallback
     * @param {string} action - Action in the flashing process, e.g. unpack/flash.
     * @param {string} item - Item processed by the action, e.g. partition being flashed.
     * @param {number} progress - Progress within the current action between 0 and 1.
     */

    /**
     * Flashes the given factory images zip onto the device, with automatic handling
     * of handling firmware, system, and logical partitions as AOSP fastboot and
     * flash-all.sh would do.
     * Equivalent to `fastboot update name.zip`.
     *
     * @param {FastbootDevice} device - Fastboot device to flash.
     * @param {Blob} blob - Blob containing the zip file to flash.
     * @param {boolean} wipe - Whether to wipe super and userdata. Equivalent to `fastboot -w`.
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection.
     * @param {FactoryFlashCallback} onProgress - Progress callback for image flashing.
     */
    async flashFactoryZip(blob, wipe, onReconnect, onProgress = () => {}) {
        return await flashZip(this, blob, wipe, onReconnect, onProgress);
    }
}

exports.FastbootDevice = FastbootDevice;
exports.FastbootError = FastbootError;
exports.USER_ACTION_MAP = USER_ACTION_MAP;
exports.UsbError = UsbError;
exports.configureZip = configure;
exports.setDebugLevel = setDebugLevel;
//# sourceMappingURL=fastboot.cjs.map
