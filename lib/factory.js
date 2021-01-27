import * as common from "./common.js";
import { ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js";

export { configure as configureZip } from "@zip.js/zip.js";

const DB_NAME = "BlobStore";
const DB_VERSION = 1;

// Images needed for fastbootd
const BOOT_CRITICAL_IMAGES = [
    "boot", "vendor_boot",
    "dtbo", "dt",
    "vbmeta", "vbmeta_system",
];

// Less critical images to flash after boot-critical ones
const SYSTEM_IMAGES = [
    "odm",
    "product",
    "product",
    "system",
    "system_ext",
    "vendor",
];

class BlobStore {
    constructor() {
        this.db = null;
    }

    async _wrapReq(request, onUpgrade = null) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                resolve(request.result);
            };
            request.oncomplete = () => {
                resolve(request.result);
            };
            request.onerror = (event) => {
                reject(event);
            };

            if (onUpgrade !== null) {
                request.onupgradeneeded = onUpgrade;
            }
        });
    }

    async init() {
        this.db = await this._wrapReq(indexedDB.open(DB_NAME, DB_VERSION), (event) => {
            let db = event.target.result;
            db.createObjectStore("files", { keyPath: "name" });
            /* no index needed for such a small database */
        });
    }

    async saveFile(name, blob) {
        this.db.transaction(["files"], "readwrite").objectStore("files").add({
            name: name,
            blob: blob,
        });
    }

    async loadFile(name) {
        try {
            let obj = await this._wrapReq(this.db.transaction("files").objectStore("files").get(name));
            return obj.blob;
        } catch (error) {
            return null;
        }
    }

    async close() {
        this.db.close();
    }
}

export async function downloadZip(url) {
    // Open the DB first to get user consent
    let store = new BlobStore();
    await store.init();

    let filename = url.split("/").pop();
    let blob = await store.loadFile(filename);
    if (blob === null) {
        common.logDebug(`Downloading ${url}`);
        let resp = await fetch(new Request(url));
        blob = await resp.blob();
        common.logDebug("File downloaded, saving...");
        await store.saveFile(filename, blob);
        common.logDebug("File saved");
    } else {
        common.logDebug(`Loaded ${filename} from blob store, skipping download`);
    }

    store.close();
    return blob;
}

async function flashEntryBlob(device, entry, onProgress, partition) {
    common.logDebug(`Unpacking ${partition}`);
    onProgress("unpack", partition);
    let blob = await entry.getData(new BlobWriter("application/octet-stream"));

    common.logDebug(`Flashing ${partition}`);
    onProgress("flash", partition);
    await device.flashBlob(partition, blob);
}

async function tryFlashImages(device, entries, onProgress, imageNames) {
    for (let imageName of imageNames) {
        let pattern = new RegExp(`${imageName}(?:-.+)?\\.img$`);
        let entry = entries.find(entry => entry.filename.match(pattern));
        if (entry !== undefined) {
            await flashEntryBlob(device, entry, onProgress, imageName);
        }
    }
}

export async function flashZip(device, name, onProgress = () => {}) {
    let store = new BlobStore();
    await store.init();

    common.logDebug(`Loading ${name} as zip`);
    let reader = new ZipReader(new BlobReader(await store.loadFile(name)));
    let entries = await reader.getEntries();

    // Bootloader and radio packs can only be flashed in the bare-metal bootloader
    if (await device.getVariable("is-userspace") === "yes") {
        await device.reboot("bootloader", true);
    }

    // 1. Bootloader pack
    await tryFlashImages(device, entries, onProgress, ["bootloader"]);
    onProgress("reboot");
    await device.reboot("bootloader", true);

    // 2. Radio pack
    await tryFlashImages(device, entries, onProgress, ["radio"]);
    onProgress("reboot");
    await device.reboot("bootloader", true);

    // Load nested images for the following steps
    common.logDebug("Loading nested images from zip");
    let entry = entries.find(e => e.filename.match(/image-.+\.zip$/));
    let imagesBlob = await entry.getData(new BlobWriter("application/zip"));
    let imageReader = new ZipReader(new BlobReader(imagesBlob));
    let imageEntries = await imageReader.getEntries();

    // 3. Boot-critical images
    await tryFlashImages(device, imageEntries, onProgress, BOOT_CRITICAL_IMAGES);

    // 4. Super partition template
    // This is also where we reboot to fastbootd.
    entry = imageEntries.find(e => e.filename.endsWith("super_empty.img"));
    if (entry !== undefined) {
        await device.reboot("fastboot", true);

        let superName = await device.getVariable("super-partition-name");
        superName = superName ? superName : "super";

        onProgress("flash", "super");
        let blob = await entry.getData(new BlobWriter("application/octet-stream"));
        await device.upload(superName, await common.readBlobAsBuffer(blob));
        await device.runCommand(`update-super:${superName}`);
    }

    // 5. Remaining system images
    await tryFlashImages(device, imageEntries, onProgress, SYSTEM_IMAGES);

    // 6. Custom AVB key
    // We unconditionally reboot back to the bootloader here if we're in fastbootd,
    // even when there's no custom AVB key, because common follow-up actions like
    // locking the bootloader and wiping data need to be done in the bootloader.
    if (await device.getVariable("is-userspace") === "yes") {
        await device.reboot("bootloader", true);
    }
    entry = entries.find(e => e.filename.endsWith("avb_pkmd.bin"));
    if (entry !== undefined) {
        await flashEntryBlob(device, entry, onProgress, "avb_custom_key");
    }

    store.close();
}
