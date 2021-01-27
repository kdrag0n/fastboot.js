/* eslint-disable */
/// @ts-nocheck

import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js';
import * as common from './common';

export { configure as configureZip } from '@zip.js/zip.js';

const DB_NAME = 'BlobStore';
const DB_VERSION = 1;

class BlobStore {
  constructor() {
    this.db = null;
  }

  async _wrapReq(request, onUpgrade = null) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.oncomplete = () => {
        resolve(request.result);
      };
      request.onerror = (event) => {
        reject(event);
      };

      if (onUpgrade !== null) {
        request.onupgradeneeded = onUpgrade;
      }
    });
  }

  async init() {
    this.db = await this._wrapReq(
      indexedDB.open(DB_NAME, DB_VERSION),
      (event) => {
        const db = event.target.result;
        db.createObjectStore('files', { keyPath: 'name' });
        /* no index needed for such a small database */
      },
    );
  }

  async saveFile(name, blob) {
    this.db.transaction(['files'], 'readwrite').objectStore('files').add({
      name: name,
      blob: blob,
    });
  }

  async loadFile(name) {
    try {
      const obj = await this._wrapReq(
        this.db.transaction('files').objectStore('files').get(name),
      );
      return obj.blob;
    } catch (error) {
      return null;
    }
  }

  async close() {
    this.db.close();
  }
}

export async function downloadZip(url) {
  // Open the DB first to get user consent
  const store = new BlobStore();
  await store.init();

  const filename = url.split('/').pop();
  let blob = await store.loadFile(filename);
  if (blob == null) {
    common.logDebug(`Downloading ${url}`);
    const resp = await fetch(new Request(url));
    blob = await resp.blob();
    common.logDebug('File downloaded, saving...');
    await store.saveFile(filename, blob);
    common.logDebug('File saved');
  } else {
    common.logDebug(`Loaded ${filename} from blob store, skipping download`);
  }

  store.close();
  return blob;
}

async function flashEntryBlob(device, entry, progressCallback, partition) {
  progressCallback('unpack', partition);
  const blob = await entry.getData(new BlobWriter('application/octet-stream'));
  progressCallback('flash', partition);
  await device.flashBlob(partition, blob);
}

export async function flashZip(device, name, progressCallback = () => {}) {
  const store = new BlobStore();
  await store.init();

  common.logDebug(`Loading ${name} as zip`);
  const reader = new ZipReader(new BlobReader(await store.loadFile(name)));
  const entries = await reader.getEntries();
  for (const entry of entries) {
    if (entry.filename.match(/avb_pkmd.bin$/)) {
      common.logDebug('Flashing AVB custom key');
      await flashEntryBlob(device, entry, progressCallback, 'avb_custom_key');
    } else if (entry.filename.match(/bootloader-.+\.img$/)) {
      common.logDebug('Flashing bootloader image pack');
      await flashEntryBlob(device, entry, progressCallback, 'bootloader');
    } else if (entry.filename.match(/radio-.+\.img$/)) {
      common.logDebug('Flashing radio image pack');
      await flashEntryBlob(device, entry, progressCallback, 'radio');
    } else if (entry.filename.match(/image-.+\.zip$/)) {
      common.logDebug('Flashing images from nested images zip');

      const imagesBlob = await entry.getData(new BlobWriter('application/zip'));
      const imageReader = new ZipReader(new BlobReader(imagesBlob));
      for (const image of await imageReader.getEntries()) {
        if (!image.filename.endsWith('.img')) {
          continue;
        }

        common.logDebug(`Flashing ${image.filename} from images zip`);
        const partition = image.filename.replace('.img', '');
        await flashEntryBlob(device, image, progressCallback, partition);
      }
    }
  }

  store.close();
}
