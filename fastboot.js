let device = null;

class UsbError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

async function connectFastboot() {
    device = await navigator.usb.requestDevice({
        filters: [
            { vendorId: 0x18d1, productId: 0x4ee0 },
        ],
    });
    console.log('dev', device);

    // Validate device
    let interface = device.configurations[0].interfaces[0].alternates[0];
    if (interface.endpoints.length != 2) {
        throw new UsbError('Interface has wrong number of endpoints');
    }
    
    if (interface.interfaceClass != 255 || interface.interfaceProtocol != 3 || interface.interfaceSubclass != 66) {
        throw new UsbError('Interface has wrong class, subclass, or protocol');
    }

    let epIn = null;
    let epOut = null;
    for (let endpoint of interface.endpoints) {
        console.log('check endpoint', endpoint)
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
    console.log('eps: in', epIn, 'out', epOut);

    await device.open();
    await device.reset();
    await device.selectConfiguration(1);
    await device.claimInterface(0); // fastboot
}

async function sendCommand(device, command) {
    if (command.length > 64) {
        throw new RangeError();
    }

    let cmdPacket = new TextEncoder('utf-8').encode(command);
    await device.transferOut(0x01, cmdPacket);

    let returnStr = ''
    let response;
    do {
        let respPacket = await device.transferIn(0x01, 64);
        console.log('resppacket', respPacket)
        response = new TextDecoder().decode(respPacket.data);
        console.log('resppacket', respPacket, 'resp', response);

        if (response.startsWith('OKAY')) {
            returnStr += response.substring(4);
        } else {
            returnStr += `[${response.substring(0, 4)}]: ${response.substring(4)}\n`;
        }
    } while (response.startsWith('INFO'));

    return returnStr;
}
