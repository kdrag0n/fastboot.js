async function connectDevice() {
    let statusField = document.querySelector('.status-field');
    statusField.textContent = 'Connecting...';

    try {
        await connectFastboot();
    } catch (error) {
        statusField.textContent = `Failed to connect to device: ${error.message}`;
        return;
    }

    let product = await sendCommand(device, 'getvar:product');
    let serial = await sendCommand(device, 'getvar:serialno');
    let status = `Connected to ${product} (serial: ${serial})`;
    statusField.textContent = status;
}

async function _sendFormCommand() {
    let inputField = document.querySelector('.command-input');
    let command = inputField.value;
    let result = await sendCommand(device, command);
    document.querySelector('.result-field').textContent = result;
    inputField.value = '';
}

function sendFormCommand(event) {
    event.preventDefault();
    _sendFormCommand();
    return false;
}
