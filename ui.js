import { FastbootDevice, UsbError } from './fastboot.js';

let device = new FastbootDevice();

export async function connectDevice() {
    let statusField = document.querySelector('.status-field');
    statusField.textContent = 'Connecting...';

    try {
        await device.connect();
    } catch (error) {
        statusField.textContent = `Failed to connect to device: ${error.message}`;
        return;
    }

    let product = await device.sendCommand('getvar:product');
    let serial = await device.sendCommand('getvar:serialno');
    let status = `Connected to ${product} (serial: ${serial})`;
    statusField.textContent = status;
}

async function _sendFormCommand() {
    let inputField = document.querySelector('.command-input');
    let command = inputField.value;
    let result = await device.sendCommand(command);
    document.querySelector('.result-field').textContent = result;
    inputField.value = '';
}

export function sendFormCommand(event) {
    event.preventDefault();
    _sendFormCommand();
    return false;
}
