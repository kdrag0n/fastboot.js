const DEBUG = true;

export function logDebug(...data) {
    if (DEBUG) {
        console.log(...data);
    }
}

export function readFileAsBuffer(file) {
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
