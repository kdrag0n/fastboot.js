const DEBUG = true;

export function logDebug(...data: any[]) {
    if (DEBUG) {
        console.log(...data);
    }
}

export function readBlobAsBuffer(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result as ArrayBuffer);
        };
        reader.onerror = () => {
            reject(reader.error);
        };

        reader.readAsArrayBuffer(blob);
    });
}
