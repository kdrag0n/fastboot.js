import * as Sparse from "./sparse";
import * as common from "./common";
import {
    FactoryProgressCallback,
    flashZip as flashFactoryZip,
} from "./factory";

const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const BULK_TRANSFER_SIZE = 16384;

const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB
// To conserve RAM and work around Chromium's ~2 GiB size limit, we limit the
// max download size even if the bootloader can accept more data.
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024; // 1 GiB

const GETVAR_TIMEOUT = 10000; // ms

/**
 * Exception class for USB errors not directly thrown by WebUSB.
 */
export class UsbError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsbError";
    }
}

/**
 * Exception class for errors returned by the bootloader, as well as high-level
 * fastboot errors resulting from bootloader responses.
 */
export class FastbootError extends Error {
    status: string;
    bootloaderMessage: string;

    constructor(status: string, message: string) {
        super(`Bootloader replied with ${status}: ${message}`);
        this.status = status;
        this.bootloaderMessage = message;
        this.name = "FastbootError";
    }
}

interface CommandResponse {
    text: string;
    // hex string from DATA
    dataSize?: string;
}

/**
 * Callback for progress updates while flashing or uploading an image.
 *
 * @callback FlashProgressCallback
 * @param {number} progress - Progress for the current action, between 0 and 1.
 */
export type FlashProgressCallback = (progress: number) => void;

/**
 * Callback for reconnecting to the USB device.
 * This is necessary because some platforms do not support automatic reconnection,
 * and USB connection requests can only be triggered as the result of explicit
 * user action.
 *
 * @callback ReconnectCallback
 */
export type ReconnectCallback = () => void;

/**
 * This class is a client for executing fastboot commands and operations on a
 * device connected over USB.
 */
export class FastbootDevice {
    device: USBDevice | null;
    epIn: number | null;
    epOut: number | null;

    private _registeredUsbListeners: boolean;
    private _connectResolve: ((value: any) => void) | null;
    private _connectReject: ((err: Error) => void) | null;
    private _disconnectResolve: ((value: any) => void) | null;

    /**
     * Create a new fastboot device instance. This doesn't actually connect to
     * any USB devices; call {@link connect} to do so.
     */
    constructor() {
        this.device = null;
        this.epIn = null;
        this.epOut = null;

        this._registeredUsbListeners = false;
        this._connectResolve = null;
        this._connectReject = null;
        this._disconnectResolve = null;
    }

    /**
     * Returns whether a USB device is connected and ready for use.
     */
    get isConnected() {
        return (
            this.device !== null &&
            this.device.opened &&
            this.device.configurations[0].interfaces[0].claimed
        );
    }

    /**
     * Validate the current USB device's details and connect to it.
     *
     * @private
     */
    private async _validateAndConnectDevice() {
        if (this.device === null) {
            throw new UsbError("Attempted to connect to null device");
        }

        // Validate device
        let ife = this.device!.configurations[0].interfaces[0].alternates[0];
        if (ife.endpoints.length !== 2) {
            throw new UsbError("Interface has wrong number of endpoints");
        }

        this.epIn = null;
        this.epOut = null;
        for (let endpoint of ife.endpoints) {
            common.logVerbose("Checking endpoint:", endpoint);
            if (endpoint.type !== "bulk") {
                throw new UsbError("Interface endpoint is not bulk");
            }

            if (endpoint.direction === "in") {
                if (this.epIn === null) {
                    this.epIn = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple IN endpoints");
                }
            } else if (endpoint.direction === "out") {
                if (this.epOut === null) {
                    this.epOut = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple OUT endpoints");
                }
            }
        }
        common.logVerbose("Endpoints: in =", this.epIn, ", out =", this.epOut);

        try {
            await this.device!.open();
            // Opportunistically reset to fix issues on some platforms
            try {
                await this.device!.reset();
            } catch (error) {
                /* Failed = doesn't support reset */
            }

            await this.device!.selectConfiguration(1);
            await this.device!.claimInterface(0); // fastboot
        } catch (error) {
            // Propagate exception from waitForConnect()
            if (this._connectReject !== null) {
                this._connectReject(error);
                this._connectResolve = null;
                this._connectReject = null;
            }

            throw error;
        }

        // Return from waitForConnect()
        if (this._connectResolve !== null) {
            this._connectResolve(undefined);
            this._connectResolve = null;
            this._connectReject = null;
        }
    }

    /**
     * Wait for the current USB device to disconnect, if it's still connected.
     * Returns immediately if no device is connected.
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
     * Wait for the USB device to connect. Returns at the next connection,
     * regardless of whether the connected USB device matches the previous one.
     *
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection on Android.
     */
    async waitForConnect(onReconnect: ReconnectCallback = () => {}) {
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
     * Request the user to select a USB device and connect to it using the
     * fastboot protocol.
     *
     * @throws {UsbError}
     */
    async connect() {
        let devices = await navigator.usb.getDevices();
        common.logDebug("Found paired USB devices:", devices);
        if (devices.length === 1) {
            this.device = devices[0];
        } else {
            // If multiple paired devices are connected, request the user to
            // select a specific one to reduce ambiguity. This is also necessary
            // if no devices are already paired, i.e. first use.
            common.logDebug(
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
        common.logDebug("Using USB device:", this.device);

        if (!this._registeredUsbListeners) {
            navigator.usb.addEventListener("disconnect", (event) => {
                if (event.device === this.device) {
                    common.logDebug("USB device disconnected");
                    if (this._disconnectResolve !== null) {
                        this._disconnectResolve(undefined);
                        this._disconnectResolve = null;
                    }
                }
            });

            navigator.usb.addEventListener("connect", async (event) => {
                common.logDebug("USB device connected");
                this.device = event.device;

                // Check whether waitForConnect() is pending and save it for later
                let hasPromiseReject = this._connectReject !== null;
                try {
                    await this._validateAndConnectDevice();
                } catch (error) {
                    // Only rethrow errors from the event handler if waitForConnect()
                    // didn't already handle them
                    if (!hasPromiseReject) {
                        throw error;
                    }
                }
            });

            this._registeredUsbListeners = true;
        }

        await this._validateAndConnectDevice();
    }

    /**
     * Read a raw command response from the bootloader.
     *
     * @private
     * @returns {Promise<CommandResponse>} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    private async _readResponse(): Promise<CommandResponse> {
        let respData = {
            text: "",
        } as CommandResponse;
        let respStatus;

        do {
            let respPacket = await this.device!.transferIn(this.epIn!, 64);
            let response = new TextDecoder().decode(respPacket.data);

            respStatus = response.substring(0, 4);
            let respMessage = response.substring(4);
            common.logDebug(`Response: ${respStatus} ${respMessage}`);

            if (respStatus === "OKAY") {
                // OKAY = end of response for this command
                respData.text += respMessage;
            } else if (respStatus === "INFO") {
                // INFO = additional info line
                respData.text += respMessage + "\n";
            } else if (respStatus === "DATA") {
                // DATA = hex string, but it's returned separately for safety
                respData.dataSize = respMessage;
            } else {
                // Assume FAIL or garbage data
                throw new FastbootError(respStatus, respMessage);
            }
            // INFO = more packets are coming
        } while (respStatus === "INFO");

        return respData;
    }

    /**
     * Send a textual command to the bootloader and read the response.
     * This is in raw fastboot format, not AOSP fastboot syntax.
     *
     * @param {string} command - The command to send.
     * @returns {Promise<CommandResponse>} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async runCommand(command: string): Promise<CommandResponse> {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder().encode(command);
        await this.device!.transferOut(this.epOut!, cmdPacket);
        common.logDebug("Command:", command);

        return this._readResponse();
    }

    /**
     * Read the value of a bootloader variable. Returns undefined if the variable
     * does not exist.
     *
     * @param {string} varName - The name of the variable to get.
     * @returns {Promise<string>} Textual content of the variable.
     * @throws {FastbootError}
     */
    async getVariable(varName: string): Promise<string | null> {
        let resp;
        try {
            resp = (
                await common.runWithTimeout(
                    this.runCommand(`getvar:${varName}`),
                    GETVAR_TIMEOUT
                )
            ).text;
        } catch (error) {
            // Some bootloaders return FAIL instead of empty responses, despite
            // what the spec says. Normalize it here.
            if (error instanceof FastbootError && error.status == "FAIL") {
                resp = null;
            } else {
                throw error;
            }
        }

        // Some bootloaders send whitespace around some variables.
        // According to the spec, non-existent variables should return empty
        // responses
        return resp ? resp.trim() : null;
    }

    /**
     * Get the maximum download size for a single payload, in bytes.
     *
     * @private
     * @returns {Promise<number>}
     * @throws {FastbootError}
     */
    private async _getDownloadSize(): Promise<number> {
        try {
            let resp = (await this.getVariable(
                "max-download-size"
            ))!.toLowerCase();
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
     * Send a raw data payload to the bootloader.
     *
     * @private
     */
    private async _sendRawPayload(
        buffer: ArrayBuffer,
        onProgress: FlashProgressCallback
    ) {
        let i = 0;
        let remainingBytes = buffer.byteLength;
        while (remainingBytes > 0) {
            let chunk = buffer.slice(
                i * BULK_TRANSFER_SIZE,
                (i + 1) * BULK_TRANSFER_SIZE
            );
            if (i % 1000 === 0) {
                common.logVerbose(
                    `  Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`
                );
            }
            if (i % 10 === 0) {
                onProgress(
                    (buffer.byteLength - remainingBytes) / buffer.byteLength
                );
            }

            await this.device!.transferOut(this.epOut!, chunk);

            remainingBytes -= chunk.byteLength;
            i += 1;
        }

        onProgress(1.0);
    }

    /**
     * Upload a payload to the bootloader for later use, e.g. flashing.
     * Does not handle raw images, flashing, or splitting.
     *
     * @param {string} partition - Name of the partition the payload is intended for.
     * @param {ArrayBuffer} buffer - Buffer containing the data to upload.
     * @param {FlashProgressCallback} onProgress - Callback for upload progress updates.
     * @throws {FastbootError}
     */
    async upload(
        partition: string,
        buffer: ArrayBuffer,
        onProgress: FlashProgressCallback = (_progress) => {}
    ) {
        common.logDebug(
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
        if (downloadResp.dataSize === undefined) {
            throw new FastbootError(
                "FAIL",
                `Unexpected response to download command: ${downloadResp.text}`
            );
        }
        let downloadSize = parseInt(downloadResp.dataSize!, 16);
        if (downloadSize !== buffer.byteLength) {
            throw new FastbootError(
                "FAIL",
                `Bootloader wants ${buffer.byteLength} bytes, requested to send ${buffer.byteLength} bytes`
            );
        }

        common.logDebug(`Sending payload: ${buffer.byteLength} bytes`);
        await this._sendRawPayload(buffer, onProgress);

        common.logDebug("Payload sent, waiting for response...");
        await this._readResponse();
    }

    /**
     * Reboot to the given target, and optionally wait for the device to
     * reconnect.
     *
     * @param {string} target - Where to reboot to, i.e. fastboot or bootloader.
     * @param {boolean} wait - Whether to wait for the device to reconnect.
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection, if wait is enabled.
     */
    async reboot(
        target: string = "",
        wait: boolean = false,
        onReconnect: ReconnectCallback = () => {}
    ) {
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
     * Flash the given Blob to the given partition on the device. Any image
     * format supported by the bootloader is allowed, e.g. sparse or raw images.
     * Large raw images will be converted to sparse images automatically, and
     * large sparse images will be split and flashed in multiple passes
     * depending on the bootloader's payload size limit.
     *
     * @param {string} partition - The name of the partition to flash.
     * @param {Blob} blob - The Blob to retrieve data from.
     * @param {FlashProgressCallback} onProgress - Callback for flashing progress updates.
     * @throws {FastbootError}
     */
    async flashBlob(
        partition: string,
        blob: Blob,
        onProgress: FlashProgressCallback = (_progress) => {}
    ) {
        // Use current slot if partition is A/B
        if ((await this.getVariable(`has-slot:${partition}`)) === "yes") {
            partition += "_" + (await this.getVariable("current-slot"));
        }

        let maxDlSize = await this._getDownloadSize();
        let fileHeader = await common.readBlobAsBuffer(
            blob.slice(0, Sparse.FILE_HEADER_SIZE)
        );

        let totalBytes = blob.size;
        let isSparse = false;
        try {
            let sparseHeader = Sparse.parseFileHeader(fileHeader);
            if (sparseHeader !== null) {
                totalBytes = sparseHeader.blocks * sparseHeader.blockSize;
                isSparse = true;
            }
        } catch (error) {
            // ImageError = invalid, so keep blob.size
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
        if (blob.size > maxDlSize && !isSparse) {
            common.logDebug(`${partition} image is raw, converting to sparse`);
            blob = await Sparse.fromRaw(blob);
        }

        common.logDebug(
            `Flashing ${blob.size} bytes to ${partition}, ${maxDlSize} bytes per split`
        );
        let splits = 0;
        let sentBytes = 0;
        for await (let split of Sparse.splitBlob(blob, maxDlSize)) {
            await this.upload(partition, split.data, (progress) => {
                onProgress((sentBytes + progress * split.bytes) / totalBytes);
            });

            common.logDebug("Flashing payload...");
            await this.runCommand(`flash:${partition}`);

            splits += 1;
            sentBytes += split.bytes;
        }

        common.logDebug(`Flashed ${partition} with ${splits} split(s)`);
    }

    /**
     * Boot the given Blob on the device.
     * Equivalent to `fastboot boot boot.img`.
     *
     * @param {Blob} blob - The Blob to retrieve data from.
     * @param {FlashProgressCallback} onProgress - Callback for flashing progress updates.
     * @throws {FastbootError}
     */
    async bootBlob(
        blob: Blob,
        onProgress: FlashProgressCallback = (_progress) => {}
    ) {

        common.logDebug(`Booting ${blob.size} bytes image`);

        let data = await common.readBlobAsBuffer(blob);
        await this.upload("boot.img", data, onProgress);

        common.logDebug("Booting payload...");
        await this.runCommand("boot");

        common.logDebug(`Booted ${blob.size} bytes image`);
    }

    /**
     * Flash the given factory images zip onto the device, with automatic handling
     * of firmware, system, and logical partitions as AOSP fastboot and
     * flash-all.sh would do.
     * Equivalent to `fastboot update name.zip`.
     *
     * @param {Blob} blob - Blob containing the zip file to flash.
     * @param {boolean} wipe - Whether to wipe super and userdata. Equivalent to `fastboot -w`.
     * @param {ReconnectCallback} onReconnect - Callback to request device reconnection.
     * @param {FactoryProgressCallback} onProgress - Progress callback for image flashing.
     */
    async flashFactoryZip(
        blob: Blob,
        wipe: boolean,
        onReconnect: ReconnectCallback,
        onProgress: FactoryProgressCallback = (_progress) => {}
    ) {
        return await flashFactoryZip(this, blob, wipe, onReconnect, onProgress);
    }
}
