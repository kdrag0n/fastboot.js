// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

import { FastbootDevice, FactoryImages } from "../dist/fastboot.mjs";

let device = new FastbootDevice();

async function connectDevice() {
    let statusField = document.querySelector(".status-field");
    statusField.textContent = "Connecting...";

    try {
        await device.connect();
    } catch (error) {
        statusField.textContent = `Failed to connect to device: ${error.message}`;
        return;
    }

    let product = await device.getVariable("product");
    let serial = await device.getVariable("serialno");
    let status = `Connected to ${product} (serial: ${serial})`;
    statusField.textContent = status;
}

async function sendFormCommand(event) {
    event.preventDefault();

    let inputField = document.querySelector(".command-input");
    let command = inputField.value;
    let result = (await device.runCommand(command)).text;
    document.querySelector(".result-field").textContent = result;
    inputField.value = "";
}

async function flashFormFile(event) {
    event.preventDefault();

    let fileField = document.querySelector(".flash-file");
    let partField = document.querySelector(".flash-partition");
    let file = fileField.files[0];
    await device.flashBlob(partField.value, file);
    fileField.value = "";
    partField.value = "";
}

async function downloadZip() {
    let statusField = document.querySelector(".factory-status-field");
    statusField.textContent = "Downloading...";

    try {
        await FactoryImages.downloadZip(
            "/releases/taimen-factory-2021.01.06.14.zip"
        );
    } catch (error) {
        statusField.textContent = `Failed to download zip: ${error.message}`;
        throw error;
    }

    statusField.textContent = "Downloaded";
}

async function flashZip() {
    let statusField = document.querySelector(".factory-status-field");
    statusField.textContent = "Flashing...";

    try {
        await FactoryImages.flashZip(
            device,
            "taimen-factory-2021.01.06.14.zip"
        );
    } catch (error) {
        statusField.textContent = `Failed to flash zip: ${error.message}`;
        throw error;
    }

    statusField.textContent =
        "Successfully flashed taimen-factory-2021.01.06.14.zip";
}

FactoryImages.configureZip({
    workerScripts: {
        inflate: ["../dist/libs/z-worker-pako.js", "pako_inflate.min.js"],
    },
});

document
    .querySelector(".command-form")
    .addEventListener("submit", sendFormCommand);
document
    .querySelector(".connect-button")
    .addEventListener("click", connectDevice);
document.querySelector(".flash-form").addEventListener("submit", flashFormFile);
document
    .querySelector(".download-zip-button")
    .addEventListener("click", downloadZip);
document.querySelector(".flash-zip-button").addEventListener("click", flashZip);

// @license-end
