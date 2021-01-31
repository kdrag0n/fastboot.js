let debugMode = false;

export function logDebug(...data) {
    if (debugMode) {
        console.log(...data);
    }
}

/**
 * Enables or disables debug mode. In debug mode, fastboot.js prints detailed
 * logs to the browser console.
 *
 * @param {boolean} mode - Whether to enable debug mode.
 */
export function setDebugMode(mode) {
    debugMode = mode;
}

/**
 * Reads all of the data in the given blob and returns it as an ArrayBuffer.
 *
 * @param {Blob} blob - Blob with the data to read.
 * @returns {buffer} ArrayBuffer containing data from the blob.
 */
export function readBlobAsBuffer(blob) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result);
        };
        reader.onerror = () => {
            reject(reader.error);
        };

        reader.readAsArrayBuffer(blob);
    });
}

function waitForFrame() {
    return new Promise((resolve, _reject) => {
        window.requestAnimationFrame(resolve);
    });
}

export async function runWithTimedProgress(onProgress, action, item, duration, workPromise) {
    let startTime = new Date().getTime();
    let stop = false;

    onProgress(action, item, 0.0);
    let progressPromise = (async () => {
        let now;
        let targetTime = startTime + duration;

        do {
            now = new Date().getTime();
            onProgress(action, item, (now - startTime) / duration);
            await waitForFrame();
        } while (!stop && now < targetTime);
    })();

    await Promise.race([progressPromise, workPromise]);
    stop = true;
    await progressPromise;

    onProgress(action, item, 1.0);
}
