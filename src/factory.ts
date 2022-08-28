import * as common from "./common";
import {
    ZipReader,
    BlobReader,
    BlobWriter,
    TextWriter,
    Entry,
    EntryGetDataOptions,
    Writer,
} from "@zip.js/zip.js";
import { FastbootDevice, FastbootError, ReconnectCallback } from "./fastboot";

/**
 * Callback for factory image flashing progress.
 *
 * @callback FactoryProgressCallback
 * @param {string} action - Action in the flashing process, e.g. unpack/flash.
 * @param {string} item - Item processed by the action, e.g. partition being flashed.
 * @param {number} progress - Progress within the current action between 0 and 1.
 */
export type FactoryProgressCallback = (
    action: string,
    item: string,
    progress: number
) => void;

// Images needed for fastbootd
const BOOT_CRITICAL_IMAGES = [
    "boot",
    "dt",
    "dtbo",
    "init_boot",
    "pvmfw",
    "recovery",
    "vbmeta_system",
    "vbmeta_vendor",
    "vbmeta",
    "vendor_boot",
    "vendor_kernel_boot",
];

// Less critical images to flash after boot-critical ones
const SYSTEM_IMAGES = [
    "odm",
    "odm_dlkm",
    "product",
    "system_ext",
    "system",
    "vendor_dlkm",
    "vendor",
];

/**
 * User-friendly action strings for factory image flashing progress.
 * This can be indexed by the action argument in FactoryFlashCallback.
 */
export const USER_ACTION_MAP = {
    load: "Loading",
    unpack: "Unpacking",
    flash: "Writing",
    wipe: "Wiping",
    reboot: "Restarting",
};

const BOOTLOADER_REBOOT_TIME = 4000; // ms
const FASTBOOTD_REBOOT_TIME = 16000; // ms
const USERDATA_ERASE_TIME = 1000; // ms

// Wrapper for Entry#getData() that unwraps ProgressEvent errors
async function zipGetData(
    entry: Entry,
    writer: Writer,
    options?: EntryGetDataOptions,
) {
    try {
        return await entry.getData!(writer, options);
    } catch (e) {
        if (
            e instanceof ProgressEvent &&
            e.type === "error" &&
            e.target !== null
        ) {
            throw (e.target as any).error;
        } else {
            throw e;
        }
    }
}

async function flashEntryBlob(
    device: FastbootDevice,
    entry: Entry,
    onProgress: FactoryProgressCallback,
    partition: string
) {
    common.logDebug(`Unpacking ${partition}`);
    onProgress("unpack", partition, 0.0);
    let blob = await zipGetData(
        entry,
        new BlobWriter("application/octet-stream"),
        {
            onprogress: (bytes: number, len: number) => {
                onProgress("unpack", partition, bytes / len);
            },
        }
    );

    common.logDebug(`Flashing ${partition}`);
    onProgress("flash", partition, 0.0);
    await device.flashBlob(partition, blob, (progress) => {
        onProgress("flash", partition, progress);
    });
}

async function tryFlashImages(
    device: FastbootDevice,
    entries: Array<Entry>,
    onProgress: FactoryProgressCallback,
    imageNames: Array<string>
) {
    for (let imageName of imageNames) {
        let pattern = new RegExp(`${imageName}(?:-.+)?\\.img$`);
        let entry = entries.find((entry) => entry.filename.match(pattern));
        if (entry !== undefined) {
            await flashEntryBlob(device, entry, onProgress, imageName);
        }
    }
}

async function checkRequirements(device: FastbootDevice, androidInfo: string) {
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
        let expectValues: Array<string | null> = expectValue.split("|");

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

async function tryReboot(
    device: FastbootDevice,
    target: string,
    onReconnect: ReconnectCallback
) {
    try {
        await device.reboot(target, false);
    } catch (e) {
        /* Failed = device rebooted by itself */
    }

    await device.waitForConnect(onReconnect);
}

export async function flashZip(
    device: FastbootDevice,
    blob: Blob,
    wipe: boolean,
    onReconnect: ReconnectCallback,
    onProgress: FactoryProgressCallback = (
        _action: string,
        _item: string,
        _progress: number
    ) => {}
) {
    onProgress("load", "package", 0.0);
    let reader = new ZipReader(new BlobReader(blob));
    let entries = await reader.getEntries();

    // Bootloader and radio packs can only be flashed in the bare-metal bootloader
    if ((await device.getVariable("is-userspace")) === "yes") {
        await device.reboot("bootloader", true, onReconnect);
    }

    // 1. Bootloader pack
    await tryFlashImages(device, entries, onProgress, ["bootloader"]);
    await common.runWithTimedProgress(
        onProgress,
        "reboot",
        "device",
        BOOTLOADER_REBOOT_TIME,
        tryReboot(device, "bootloader", onReconnect)
    );

    // 2. Radio pack
    await tryFlashImages(device, entries, onProgress, ["radio"]);
    await common.runWithTimedProgress(
        onProgress,
        "reboot",
        "device",
        BOOTLOADER_REBOOT_TIME,
        tryReboot(device, "bootloader", onReconnect)
    );

    // Cancel snapshot update if in progress
    let snapshotStatus = await device.getVariable("snapshot-update-status");
    if (snapshotStatus !== null && snapshotStatus !== "none") {
        await device.runCommand("snapshot-update:cancel");
    }

    // Load nested images for the following steps
    common.logDebug("Loading nested images from zip");
    onProgress("unpack", "images", 0.0);
    let entry = entries.find((e) => e.filename.match(/image-.+\.zip$/));
    let imagesBlob = await zipGetData(
        entry!,
        new BlobWriter("application/zip"),
        {
            onprogress: (bytes: number, len: number) => {
                onProgress("unpack", "images", bytes / len);
            },
        }
    );
    let imageReader = new ZipReader(new BlobReader(imagesBlob));
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
        await common.runWithTimedProgress(
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
            await common.readBlobAsBuffer(superBlob),
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
        await common.runWithTimedProgress(
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
        await common.runWithTimedProgress(
            onProgress,
            "wipe",
            "data",
            USERDATA_ERASE_TIME,
            device.runCommand("erase:userdata")
        );
    }
}
