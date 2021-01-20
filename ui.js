import * as fastboot from './fastboot.js';

export async function connectDevice() {
    let statusField = document.querySelector('.status-field');
    statusField.textContent = 'Connecting...';

    try {
        await fastboot.connectFastboot();
    } catch (error) {
        statusField.textContent = `Failed to connect to device: ${error.message}`;
        return;
    }

    let product = await fastboot.sendCommand(fastboot.device, 'getvar:product');
    let serial = await fastboot.sendCommand(fastboot.device, 'getvar:serialno');
    let status = `Connected to ${product} (serial: ${serial})`;
    statusField.textContent = status;
}

async function _sendFormCommand() {
    let inputField = document.querySelector('.command-input');
    let command = inputField.value;
    let result = await fastboot.sendCommand(fastboot.device, command);
    document.querySelector('.result-field').textContent = result;
    inputField.value = '';
}

export function sendFormCommand(event) {
    event.preventDefault();
    _sendFormCommand();
    return false;
}
