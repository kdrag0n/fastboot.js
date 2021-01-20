const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const DEBUG = true;

function logDebug(...data) {
    if (DEBUG) {
        console.log(...data);
    }
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

    async sendCommand(command) {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder('utf-8').encode(command);
        await this.device.transferOut(0x01, cmdPacket);
        logDebug('command:', command);

        // Construct response string for each message
        let returnStr = ''
        let response;
        do {
            let respPacket = await this.device.transferIn(0x01, 64);
            response = new TextDecoder().decode(respPacket.data);
            logDebug('response: packet', respPacket, 'string', response);
    
            if (response.startsWith('OKAY')) {
                // OKAY = end of response for this command
                returnStr += response.substring(4);
            } else if (response.startsWith('INFO')) {
                // INFO = additional info line
                returnStr += response.substring(4) + '\n';
            } else {
                // Assume FAIL or garbage data
                throw new FastbootError(response.substring(0, 4), response.substring(4));
            }
        // INFO means that more packets are coming
        } while (response.startsWith('INFO'));
    
        return returnStr;
    }
}
