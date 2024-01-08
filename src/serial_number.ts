import {BlobReader, BlobWriter, ZipWriter} from "@zip.js/zip.js";

export const isValidSerialNumber = (serial: string): boolean => {
    const pattern = /^A[1-2][0-9]{7}$/;

    return pattern.test(serial);
};

/**
 * Creates a file with a serial number embedded in the last 23 bytes.
 */
export const createImageFile = async (serialNumber: string) => {
    if (!isValidSerialNumber(serialNumber)) {
        throw new Error("Invalid serial number");
    }

    // Create a 1024KB blob filled with zeros
    const size = 1024 * 1024; // 1024KB
    const zeroFilledArray = new Uint8Array(size).fill(0);
    let blob = new Blob([zeroFilledArray]);

    // Overwrite the last 23 bytes with the serial number
    const serialBlob = new Blob([serialNumber]);
    blob = new Blob([blob.slice(0, size - 23), serialBlob]);

    return blob;
};