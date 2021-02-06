// @license magnet:?xt=urn:btih:d3d9a9a6595521f9666a5e94cc830dab83b65699&dn=expat.txt MIT

import * as fastboot from "../dist/fastboot.mjs";
import { BlobStore } from "./download.js";

let device = new fastboot.FastbootDevice();
let blobStore = new BlobStore();

// Enable verbose debug logging
fastboot.setDebugLevel(2);

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

    await blobStore.init();
    try {
        await blobStore.download("/releases/taimen-factory-2021.01.06.14.zip");
    } catch (error) {
        statusField.textContent = `Failed to download zip: ${error.message}`;
        throw error;
    }

    statusField.textContent = "Downloaded";
}

function reconnectCallback() {
    let reconnectButton = document.querySelector(".reconnect-button");
    reconnectButton.style.display = "block";
    reconnectButton.onclick = async () => {
        await device.connect();
        reconnectButton.style.display = "none";
    };
}

async function flashFactoryZip(blob) {
    let statusField = document.querySelector(".factory-status-field");
    statusField.textContent = "Flashing...";

    let progressBar = document.querySelector(".factory-progress-bar");

    try {
        await fastboot.FactoryImages.flashZip(
            device,
            blob,
            false,
            reconnectCallback,
            // Progress callback
            (action, item, progress) => {
                let userAction = fastboot.FactoryImages.USER_ACTION_MAP[action];
                statusField.textContent = `${userAction} ${item}`;
                progressBar.value = progress;
            }
        );
    } catch (error) {
        statusField.textContent = `Failed to flash zip: ${error.message}`;
        throw error;
    }

    statusField.textContent = "Successfully flashed factory images";
}

async function flashSelectedFactoryZip(event) {
    event.preventDefault();

    let fileField = document.querySelector(".factory-file");
    await flashFactoryZip(fileField.files[0]);
    fileField.value = "";
}

async function flashDownloadedFactoryZip() {
    await blobStore.init();
    let blob = await blobStore.loadFile("taimen-factory-2021.01.06.14.zip");
    await flashFactoryZip(blob);
}

fastboot.FactoryImages.configureZip({
    workerScripts: {
        inflate: ["../dist/vendor/z-worker-pako.js", "pako_inflate.min.js"],
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
document
    .querySelector(".factory-form")
    .addEventListener("submit", flashSelectedFactoryZip);
document
    .querySelector(".flash-zip-button")
    .addEventListener("click", flashDownloadedFactoryZip);

// @license-end
