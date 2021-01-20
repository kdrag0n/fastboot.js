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

    let product = (await device.sendCommand('getvar:product')).text;
    let serial = (await device.sendCommand('getvar:serialno')).text;
    let status = `Connected to ${product} (serial: ${serial})`;
    statusField.textContent = status;
}

async function _sendFormCommand() {
    let inputField = document.querySelector('.command-input');
    let command = inputField.value;
    let result = (await device.sendCommand(command)).text;
    document.querySelector('.result-field').textContent = result;
    inputField.value = '';
}

export function sendFormCommand(event) {
    event.preventDefault();
    _sendFormCommand();
    return false;
}

async function _flashFormFile() {
    let fileField = document.querySelector('.flash-file');
    let partField = document.querySelector('.flash-partition');
    let file = fileField.files[0];
    await device.flashFile(partField.value, file);
    fileField.value = '';
}

export function flashFormFile(event) {
    event.preventDefault();
    _flashFormFile();
    return false;
}
