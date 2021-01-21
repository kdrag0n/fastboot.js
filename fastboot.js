import * as Sparse from './sparse.js';
import * as common from './common.js';

const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const BULK_TRANSFER_SIZE = 16384;

const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB
// To conserve RAM and work around Chromium's ~2 GiB size limit, we limit the
// max download size even if the bootloader can accept more data.
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024; // 1 GiB

/** Exception class for USB or WebUSB-level errors. */
export class UsbError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

/** Exception class for bootloader and high-level fastboot errors. */
export class FastbootError extends Error {
    constructor(status, message) {
        super(`Bootloader replied with ${status}: ${message}`);
        this.status = status;
        this.bootloaderMessage = message;
        this.name = this.constructor.name;
    }
}

/**
 * Implements fastboot commands and operations for a device connected over USB.
 */
export class FastbootDevice {
    /**
     * Creates a new fastboot device object ready to connect to a USB device.
     * This does not actually connect to any devices.
     * 
     * @see connect
     */
    constructor() {
        this.device = null;
    }

    /**
     * Request the user to select a USB device and attempt to connect to it
     * using the fastboot protocol.
     * 
     * @throws {UsbError}
     */
    async connect() {
        this.device = await navigator.usb.requestDevice({
            filters: [
                { vendorId: 0x18d1, productId: 0x4ee0 },
            ],
        });
        common.logDebug('dev', this.device);

        // Validate device
        let ife = this.device.configurations[0].interfaces[0].alternates[0];
        if (ife.endpoints.length != 2) {
            throw new UsbError('Interface has wrong number of endpoints');
        }

        if (ife.interfaceClass != FASTBOOT_USB_CLASS ||
                ife.interfaceSubclass != FASTBOOT_USB_SUBCLASS ||
                ife.interfaceProtocol != FASTBOOT_USB_PROTOCOL) {
            throw new UsbError('Interface has wrong class, subclass, or protocol');
        }

        let epIn = null;
        let epOut = null;
        for (let endpoint of ife.endpoints) {
            common.logDebug('check endpoint', endpoint)
            if (endpoint.type != 'bulk') {
                throw new UsbError('Interface endpoint is not bulk');
            }

            if (endpoint.direction == 'in') {
                if (epIn == null) {
                    epIn = endpoint.endpointNumber;
                } else {
                    throw new UsbError('Interface has multiple IN endpoints');
                }
            } else if (endpoint.direction == 'out') {
                if (epOut == null) {
                    epOut = endpoint.endpointNumber;
                } else {
                    throw new UsbError('Interface has multiple OUT endpoints');
                }
            }
        }
        common.logDebug('eps: in', epIn, 'out', epOut);

        await this.device.open();
        // TODO: find out if this is actually necessary on Linux
        await this.device.reset();
        await this.device.selectConfiguration(1);
        await this.device.claimInterface(0); // fastboot
    }

    /**
     * Reads a raw command response from the bootloader.
     * 
     * @private
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async readResponse() {
        let returnData = {
            text: '',
            dataSize: null,
        };
        let response;
        do {
            let respPacket = await this.device.transferIn(0x01, 64);
            response = new TextDecoder().decode(respPacket.data);
            common.logDebug('response: packet', respPacket, 'string', response);

            if (response.startsWith('OKAY')) {
                // OKAY = end of response for this command
                returnData.text += response.substring(4);
            } else if (response.startsWith('INFO')) {
                // INFO = additional info line
                returnData.text += response.substring(4) + '\n';
            } else if (response.startsWith('DATA')) {
                // DATA = hex string, but it's returned separately for safety
                returnData.dataSize = response.substring(4);
            } else {
                // Assume FAIL or garbage data
                throw new FastbootError(response.substring(0, 4), response.substring(4));
            }
        // INFO means that more packets are coming
        } while (response.startsWith('INFO'));

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
    async sendCommand(command) {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder('utf-8').encode(command);
        await this.device.transferOut(0x01, cmdPacket);
        common.logDebug('command:', command);

        return this.readResponse();
    }

    /**
     * Returns the value of a bootloader variable.
     * 
     * @param {string} varName - The name of the variable to get.
     * @returns {value} Textual content of the variable.
     * @throws {FastbootError}
     */
    async getVariable(varName) {
        let resp = (await this.sendCommand(`getvar:${varName}`)).text;
        // Some bootloaders send whitespace around some variables
        resp = resp.trim();
        // According to the spec, non-existent variables should return empty
        // responses
        if (resp) {
            return resp;
        } else {
            // Throw an error for compatibility reasons
            throw new FastbootError('FAIL', 'No such variable (OKAY)');
        }
    }

    /**
     * Returns the maximum download size for a single payload, in bytes.
     * 
     * @private
     * @returns {downloadSize}
     * @throws {FastbootError}
     */
    async getDownloadSize() {
        try {
            let resp = (await getVariable('max-download-size')).toLowerCase();
            if (resp) {
                // AOSP fastboot requires hex
                return Math.min(parseInt(resp, 16), MAX_DOWNLOAD_SIZE);
            }
        } catch (error) { /* Failed = no value, fallthrough */ }

        // FAIL or empty variable means no max, set a reasonable limit to conserve memory
        return DEFAULT_DOWNLOAD_SIZE;
    }

    /**
     * Reads a raw command response from the bootloader.
     * 
     * @private
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async sendRawPayload(buffer) {
        let i = 0;
        let remainingBytes = buffer.byteLength;
        while (remainingBytes > 0) {
            let chunk = buffer.slice(i * BULK_TRANSFER_SIZE, (i + 1) * BULK_TRANSFER_SIZE);
            if (i % 1000 == 0) {
                common.logDebug(`  Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`);
            }
            await this.device.transferOut(0x01, chunk);

            remainingBytes -= chunk.byteLength;
            i += 1;
        }

        common.logDebug(`Finished sending payload, ${remainingBytes} bytes remaining`);
    }

    /**
     * Flashes the given File or Blob to the given partition on the device.
     *
     * @param {string} partition - The name of the partition to flash.
     * @param {Blob} file - The Blob or File to retrieve data from.
     * @throws {FastbootError}
     */
    async flashFile(partition, file) {
        // Prepare image if it's not sparse
        let fileHeader = await common.readFileAsBuffer(file.slice(0, Sparse.FILE_HEADER_SIZE));
        if (!Sparse.isSparse(fileHeader)) {
            common.logDebug(`${partition} image is raw, converting to sparse`);

            // Assume that non-sparse images will always be small enough to convert in RAM.
            // The buffer is converted to a Blob for compatibility with the existing flashing code.
            let rawData = await common.readFileAsBuffer(file);
            let sparse = Sparse.rawToSparseImage(rawData);
            file = new Blob([sparse]);
        }

        // Use current slot if partition is A/B
        try {
            if (await this.getVariable(`has-slot:${partition}`) == 'yes') {
                partition += '_' + await this.getVariable('current-slot');
            }
        } catch (error) { /* Failed = not A/B, fallthrough */ }

        let maxDlSize = await this.getDownloadSize();
        common.logDebug(`Flashing ${file.size} bytes to ${partition}, ${maxDlSize} bytes per chunk`);

        let totalXferd = 0;
        while (totalXferd < file.size) {
            // Try to transfer as much as possible in this chunk
            let xferSize = Math.min(file.size - totalXferd, maxDlSize);
            // Bootloader requires an 8-digit hex number
            let xferHex = xferSize.toString(16).padStart(8, '0');
            if (xferHex.length != 8) {
                throw new FastbootError('FAIL', `Transfer size overflow: ${xferHex} is more than 8 digits`);
            }

            // Check with the device and make sure size matches
            let downloadResp = await this.sendCommand(`download:${xferHex}`);
            if (downloadResp.dataSize == null) {
                throw new FastbootError('FAIL', `Unexpected response to download command: ${downloadResp.text}`);
            }
            xferSize = parseInt(downloadResp.dataSize, 16);
            // Sanity check: we'll end up in an infinite loop if size is 0
            if (xferSize == 0) {
                throw new FastbootError('FAIL', `Bootloader returned download size 0: ${downloadResp.text}`);
            }

            common.logDebug(`Chunk: Flashing ${xferSize} bytes, ${file.size - totalXferd} remaining, total sent: ${totalXferd} bytes`);
            let chunkData = await common.readFileAsBuffer(file.slice(totalXferd, totalXferd + xferSize));
            await this.sendRawPayload(chunkData);

            common.logDebug('Chunk sent, waiting for response...');
            await this.readResponse();

            common.logDebug('Flashing chunk...');
            await this.sendCommand(`flash:${partition}`);
            totalXferd += xferSize;
        }

        common.logDebug(`Flashed ${partition} in chunks of ${maxDlSize} bytes, ${file.size - totalXferd} bytes remaining`);
    }
}
