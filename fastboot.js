const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB

const DEBUG = true;

function logDebug(...data) {
    if (DEBUG) {
        console.log(...data);
    }
}

function readFileAsBuffer(file) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result);
        };
        reader.onerror = () => {
            reject(reader.error);
        };

        reader.readAsArrayBuffer(file);
    });
}

export class UsbError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class FastbootError extends Error {
    constructor(status, message) {
        super(`Bootloader replied with ${status}: ${message}`);
        this.status = status;
        this.bootloaderMessage = message;
        this.name = this.constructor.name;
    }
}

export class FastbootDevice {
    constructor() {
        this.device = null;
        this.maxPacketSize = null;
    }

    async connect() {
        this.device = await navigator.usb.requestDevice({
            filters: [
                { vendorId: 0x18d1, productId: 0x4ee0 },
            ],
        });
        logDebug('dev', this.device);

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
            logDebug('check endpoint', endpoint)
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
                    // Device reports max packet size according to spec
                    this.maxPacketSize = endpoint.packetSize;
                } else {
                    throw new UsbError('Interface has multiple OUT endpoints');
                }
            }
        }
        logDebug('eps: in', epIn, 'out', epOut);

        await this.device.open();
        // TODO: find out if this is actually necessary on Linux
        await this.device.reset();
        await this.device.selectConfiguration(1);
        await this.device.claimInterface(0); // fastboot
    }

    async readResponse() {
        let returnData = {
            text: '',
            dataSize: null,
        };
        let response;
        do {
            let respPacket = await this.device.transferIn(0x01, 64);
            response = new TextDecoder().decode(respPacket.data);
            logDebug('response: packet', respPacket, 'string', response);

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

    async sendCommand(command) {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder('utf-8').encode(command);
        await this.device.transferOut(0x01, cmdPacket);
        logDebug('command:', command);

        return this.readResponse();
    }

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

    // Maximum payload to download and flash
    async getDownloadSize() {
        try {
            let resp = (await getVariable('max-download-size')).toLowerCase();
            if (resp) {
                // AOSP fastboot requires hex
                return parseInt(resp, 16);
            }
        } catch (error) { /* Failed = no value, fallthrough */ }

        // FAIL or empty variable means no max, set a reasonable limit to conserve memory
        return DEFAULT_DOWNLOAD_SIZE;
    }

    async sendRawPayload(buffer) {
        let i = 0;
        let remainingBytes = buffer.byteLength;
        while (remainingBytes > 0) {
            let chunk = buffer.slice(i * this.maxPacketSize, (i + 1) * this.maxPacketSize);
            if (i % 1000 == 0) {
                logDebug(`  Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`);
            }
            await this.device.transferOut(0x01, chunk);

            remainingBytes -= chunk.byteLength;
            i += 1;
        }

        logDebug(`Finished sending payload, ${remainingBytes} bytes remaining`);
    }

    async flashFile(partition, file) {
        // Use current slot if partition is A/B
        try {
            if (await this.getVariable(`has-slot:${partition}`) == 'yes') {
                partition += '_' + await this.getVariable('current-slot');
            }
        } catch (error) { /* Failed = not A/B, fallthrough */ }

        let maxDlSize = await this.getDownloadSize();
        let data = await readFileAsBuffer(file);
        logDebug(`Flashing ${data.byteLength} bytes to ${partition}, ${maxDlSize} bytes per chunk`);

        let totalXferd = 0;
        while (totalXferd < data.byteLength) {
            // Try to transfer as much as possible in this chunk
            let xferSize = Math.min(data.byteLength - totalXferd, maxDlSize);
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

            logDebug(`Chunk: Flashing ${xferSize} bytes, ${data.byteLength - totalXferd} remaining, total sent: ${totalXferd} bytes`);
            await this.sendRawPayload(data.slice(0, xferSize));
            data = data.slice(xferSize);

            logDebug('Chunk sent, waiting for response...');
            await this.readResponse();

            logDebug('Flashing chunk...');
            await this.sendCommand(`flash:${partition}`);
            totalXferd += xferSize;
        }

        logDebug(`Flashed ${partition} in chunks of ${maxDlSize} bytes, ${data.byteLength} bytes remaining`);
    }
}
