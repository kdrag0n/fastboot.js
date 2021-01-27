import * as common from "./common.js";
import { ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js";
import { FastbootDevice } from "./fastboot.js";

export { configure as configureZip } from "@zip.js/zip.js";

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
const SYSTEM_IMAGES = [
    "odm",
    "product",
    "product",
    "system",
    "system_ext",
    "vendor",
];

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
        let entry = entries.find((entry) => entry.filename.match(pattern));
        if (entry !== undefined) {
            await flashEntryBlob(device, entry, onProgress, imageName);
        }
    }
}

/**
 * Callback for factory image flashing progress.
 *
 * @callback FactoryFlashCallback
 * @param {string} action - Action in the flashing process, e.g. unpack/flash.
 * @param {string} item - Item processed by the action, e.g. partition being flashed.
 */

/**
 * Flashes the given factory images zip onto the device, with automatic handling
 * of handling firmware, system, and logical partitions as AOSP fastboot and
 * flash-all.sh would do.
 * Equivalent to `fastboot update name.zip`.
 *
 * @param {FastbootDevice} device - Fastboot device to flash.
 * @param {Blob} blob - Blob containing the zip file to flash.
 * @param {FactoryFlashCallback} onProgress - Progress callback for image flashing.
 */
export async function flashZip(device, blob, onProgress = () => {}) {
    let reader = new ZipReader(new BlobReader(blob));
    let entries = await reader.getEntries();

    // Bootloader and radio packs can only be flashed in the bare-metal bootloader
    if ((await device.getVariable("is-userspace")) === "yes") {
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
    let entry = entries.find((e) => e.filename.match(/image-.+\.zip$/));
    let imagesBlob = await entry.getData(new BlobWriter("application/zip"));
    let imageReader = new ZipReader(new BlobReader(imagesBlob));
    let imageEntries = await imageReader.getEntries();

    // 3. Boot-critical images
    await tryFlashImages(
        device,
        imageEntries,
        onProgress,
        BOOT_CRITICAL_IMAGES
    );

    // 4. Super partition template
    // This is also where we reboot to fastbootd.
    entry = imageEntries.find((e) => e.filename.endsWith("super_empty.img"));
    if (entry !== undefined) {
        await device.reboot("fastboot", true);

        let superName = await device.getVariable("super-partition-name");
        if (!superName) {
            superName = "super";
        }

        onProgress("flash", "super");
        let superBlob = await entry.getData(
            new BlobWriter("application/octet-stream")
        );
        await device.upload(
            superName,
            await common.readBlobAsBuffer(superBlob)
        );
        await device.runCommand(`update-super:${superName}`);
    }

    // 5. Remaining system images
    await tryFlashImages(device, imageEntries, onProgress, SYSTEM_IMAGES);

    // 6. Custom AVB key
    // We unconditionally reboot back to the bootloader here if we're in fastbootd,
    // even when there's no custom AVB key, because common follow-up actions like
    // locking the bootloader and wiping data need to be done in the bootloader.
    if ((await device.getVariable("is-userspace")) === "yes") {
        await device.reboot("bootloader", true);
    }
    entry = entries.find((e) => e.filename.endsWith("avb_pkmd.bin"));
    if (entry !== undefined) {
        await flashEntryBlob(device, entry, onProgress, "avb_custom_key");
    }
}
