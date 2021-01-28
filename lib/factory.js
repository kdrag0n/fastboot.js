import * as common from "./common.js";
import { ZipReader, BlobReader, BlobWriter, TextWriter } from "@zip.js/zip.js";
import { FastbootDevice, FastbootError } from "./fastboot.js";

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

/** User-friendly action strings */
export const USER_ACTION_MAP = {
    unpack: "Unpacking",
    flash: "Flashing",
    wipe: "Wiping",
    reboot: "Restarting",
};

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

async function checkRequirements(device, androidInfo) {
    // Deal with CRLF just in case
    for (let line of androidInfo.replace("\r", "").split("\n")) {
        let match = line.match(/^require\s+(.+?)=(.+)$/);
        if (match) {
            let variable = match[1];
            // Historical mismatch that we still need to deal with
            if (variable === "board") {
                variable = "product";
            }

            let expectValue = match[2];
            let expectValues = expectValue.split("|");
            let realValue = await device.getVariable(variable);

            if (expectValues.includes(realValue)) {
                common.logDebug(
                    `Requirement ${variable}=${expectValue} passed`
                );
            } else {
                let msg = `Requirement ${variable}=${expectValue} failed, value = ${realValue}`;
                common.logDebug(msg);
                throw new FastbootError("FAIL", msg);
            }
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
 * @param {boolean} wipe - Whether to wipe super and userdata. Equivalent to `fastboot -w`.
 * @param {FactoryFlashCallback} onProgress - Progress callback for image flashing.
 */
export async function flashZip(device, blob, wipe, onProgress = () => {}) {
    let reader = new ZipReader(new BlobReader(blob));
    let entries = await reader.getEntries();

    // Bootloader and radio packs can only be flashed in the bare-metal bootloader
    if ((await device.getVariable("is-userspace")) === "yes") {
        await device.reboot("bootloader", true);
    }

    // 1. Bootloader pack
    await tryFlashImages(device, entries, onProgress, ["bootloader"]);
    onProgress("reboot", "device");
    await device.reboot("bootloader", true);

    // 2. Radio pack
    await tryFlashImages(device, entries, onProgress, ["radio"]);
    onProgress("reboot", "device");
    await device.reboot("bootloader", true);

    // Cancel snapshot update if in progress
    let snapshotStatus = await device.getVariable("snapshot-update-status");
    if (snapshotStatus !== undefined && snapshotStatus !== "none") {
        await device.runCommand("snapshot-update:cancel");
    }

    // Load nested images for the following steps
    common.logDebug("Loading nested images from zip");
    let entry = entries.find((e) => e.filename.match(/image-.+\.zip$/));
    let imagesBlob = await entry.getData(new BlobWriter("application/zip"));
    let imageReader = new ZipReader(new BlobReader(imagesBlob));
    let imageEntries = await imageReader.getEntries();

    // 3. Check requirements
    entry = imageEntries.find((e) => e.filename === "android-info.txt");
    if (entry !== undefined) {
        let reqText = await entry.getData(new TextWriter());
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
        await device.reboot("fastboot", true);

        let superName = await device.getVariable("super-partition-name");
        if (!superName) {
            superName = "super";
        }

        onProgress(wipe ? "wipe" : "flash", "super");
        let superBlob = await entry.getData(
            new BlobWriter("application/octet-stream")
        );
        await device.upload(
            superName,
            await common.readBlobAsBuffer(superBlob)
        );
        await device.runCommand(
            `update-super:${superName}${wipe ? ":wipe" : ""}`
        );
    }

    // 6. Remaining system images
    await tryFlashImages(device, imageEntries, onProgress, SYSTEM_IMAGES);

    // 7. Custom AVB key
    // We unconditionally reboot back to the bootloader here if we're in fastbootd,
    // even when there's no custom AVB key, because common follow-up actions like
    // locking the bootloader and wiping data need to be done in the bootloader.
    if ((await device.getVariable("is-userspace")) === "yes") {
        await device.reboot("bootloader", true);
    }
    entry = entries.find((e) => e.filename === "avb_pkmd.bin");
    if (entry !== undefined) {
        await flashEntryBlob(device, entry, onProgress, "avb_custom_key");
    }

    // 8. Wipe userdata
    if (wipe) {
        onProgress("wipe", "data");
        await device.runCommand("erase:userdata");
    }
}
