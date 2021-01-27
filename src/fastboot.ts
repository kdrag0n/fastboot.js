import * as common from './common';
import * as Sparse from './sparse';

const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const BULK_TRANSFER_SIZE = 16384;

const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB
// To conserve RAM and work around Chromium's ~2 GiB size limit, we limit the
// max download size even if the bootloader can accept more data.
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024; // 1 GiB

interface Response {
  text: string;
  dataSize?: string;
}

/** Exception class for USB or WebUSB-level errors. */
export class UsbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsbError';
  }
}

/** Exception class for bootloader and high-level fastboot errors. */
export class FastbootError extends Error {
  public bootloaderMessage: string;
  constructor(public status: string, message: string) {
    super(`Bootloader replied with ${status}: ${message}`);
    this.bootloaderMessage = message;
    this.name = 'FastbootError';
  }
}

/**
 * Implements fastboot commands and operations for a device connected over USB.
 */
export class FastbootDevice {
  device?: USBDevice;
  _connectResolve?: (value: void) => void;
  _connectReject?: (reason?: unknown) => void;

  /**
   * Creates a new fastboot device object ready to connect to a USB device.
   * This does not actually connect to any devices.
   *
   * @see connect
   */

  /**
   * Returns whether the USB device is currently connected.
   */
  get isConnected(): boolean {
    return !!this.device;
  }

  /**
   * Validates the current USB device's details and connects to it.
   *
   * @private
   */
  async _validateAndConnectDevice(): Promise<void> {
    try {
      await this.device!.open();
      // Opportunistically reset to fix issues on some platforms
      try {
        await this.device!.reset();
      } catch (error) {
        /* Failed = doesn't support reset */
      }

      await this.device!.selectConfiguration(1);
      await this.device!.claimInterface(0); // fastboot
    } catch (error) {
      // Propagate exception from waitForConnect()
      if (this._connectReject) {
        this._connectReject(error);
        this._connectResolve = undefined;
        this._connectReject = undefined;
      }
      throw error;
    }

    // Return from waitForConnect()
    if (this._connectResolve) {
      this._connectResolve();
      this._connectResolve = undefined;
      this._connectReject = undefined;
    }
  }

  /**
   * Wait for the USB device to connect. This function returns at the next
   * connection, regardless of whether the device is the same.
   */
  waitForConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
    });
  }

  /**
   * Request the user to select a USB device and attempt to connect to it
   * using the fastboot protocol.
   *
   * @throws {UsbError}
   */
  async connect(): Promise<void> {
    const devices = await navigator.usb.getDevices();
    common.logDebug('Found paired USB devices:', devices);
    if (devices.length === 1) {
      this.device = devices[0];
    } else {
      // If multiple paired devices are connected, request the user to
      // select a specific one to reduce ambiguity. This is also necessary
      // if no devices are already paired, i.e. first use.
      common.logDebug('Multiple paired devices are connected, requesting one');
      this.device = await navigator.usb.requestDevice({
        filters: [
          {
            classCode: FASTBOOT_USB_CLASS,
            subclassCode: FASTBOOT_USB_SUBCLASS,
            protocolCode: FASTBOOT_USB_PROTOCOL,
          },
        ],
      });
    }
    common.logDebug('Using USB device:', this.device);

    // Validate device
    const ife = this.device.configurations[0].interfaces[0].alternates[0];
    if (ife.endpoints.length !== 2) {
      throw new UsbError('Interface has wrong number of endpoints');
    }

    let epIn;
    let epOut;
    for (const endpoint of ife.endpoints) {
      common.logDebug('Checking endpoint:', endpoint);
      if (endpoint.type !== 'bulk') {
        throw new UsbError('Interface endpoint is not bulk');
      }

      if (endpoint.direction === 'in') {
        if (!epIn) {
          epIn = endpoint.endpointNumber;
        } else {
          throw new UsbError('Interface has multiple IN endpoints');
        }
      } else if (endpoint.direction === 'out') {
        if (!epOut) {
          epOut = endpoint.endpointNumber;
        } else {
          throw new UsbError('Interface has multiple OUT endpoints');
        }
      }
    }
    common.logDebug('Endpoints: in =', epIn, ', out =', epOut);

    navigator.usb.addEventListener('disconnect', (event) => {
      if (event.device === this.device) {
        common.logDebug('USB device disconnected');
        this.device = undefined;
      }
    });

    navigator.usb.addEventListener('connect', async (event) => {
      common.logDebug('USB device connected');
      this.device = event.device;
      await this._validateAndConnectDevice();
    });

    await this._validateAndConnectDevice();
  }

  /**
   * Reads a raw command response from the bootloader.
   *
   * @private
   * @returns {response} Object containing response text and data size, if any.
   * @throws {FastbootError}
   */
  async _readResponse(): Promise<Response> {
    const returnData = <Response>{
      text: '',
    };
    let response;
    do {
      const respPacket = await this.device!.transferIn(0x01, 64);
      response = new TextDecoder().decode(respPacket.data);
      common.logDebug('response: packet', respPacket, 'string', response);

      if (response.startsWith('OKAY')) {
        // OKAY = end of response for this command
        returnData.text += response.substring(4);
      } else if (response.startsWith('INFO')) {
        // INFO = additional info line
        returnData.text += response.substring(4) + '\n';
      } else if (response.startsWith('DATA')) {
        // DATA = hex string, but it"s returned separately for safety
        returnData.dataSize = response.substring(4);
      } else {
        // Assume FAIL or garbage data
        throw new FastbootError(
          response.substring(0, 4),
          response.substring(4),
        );
      }
      // INFO means that more packets are coming
    } while (response.startsWith('INFO'));

    return returnData;
  }

  /**
   * Sends a textual command to the bootloader.
   * This is in raw fastboot format, not AOSP fastboot syntax.
   *
   * @param {string} command - The command to send.
   * @returns {response} Object containing response text and data size, if any.
   * @throws {FastbootError}
   */
  async runCommand(command: string): Promise<Response> {
    // Command and response length is always 64 bytes regardless of protocol
    if (command.length > 64) {
      throw new RangeError();
    }

    // Send raw UTF-8 command
    const cmdPacket = new TextEncoder().encode(command);
    await this.device!.transferOut(0x01, cmdPacket);
    common.logDebug('command:', command);

    return this._readResponse();
  }

  /**
   * Returns the value of a bootloader variable.
   *
   * @param {string} varName - The name of the variable to get.
   * @returns {value} Textual content of the variable.
   * @throws {FastbootError}
   */
  async getVariable(varName: string): Promise<string | undefined> {
    let resp;
    try {
      resp = (await this.runCommand(`getvar:${varName}`)).text;
    } catch (error) {
      // Some bootloaders return FAIL instead of empty responses, despite
      // what the spec says. Normalize it here.
      if (error instanceof FastbootError && error.status == 'FAIL') {
        resp = undefined;
      }
    }

    // Some bootloaders send whitespace around some variables.
    // According to the spec, non-existent variables should return empty
    // responses
    return resp ? resp.trim() : undefined;
  }

  /**
   * Returns the maximum download size for a single payload, in bytes.
   *
   * @private
   * @returns {downloadSize}
   * @throws {FastbootError}
   */
  async _getDownloadSize(): Promise<number> {
    try {
      const resp = await this.getVariable('max-download-size');
      if (resp) {
        // AOSP fastboot requires hex
        return Math.min(parseInt(resp.toLowerCase(), 16), MAX_DOWNLOAD_SIZE);
      }
    } catch (error) {
      /* Failed = no value, fallthrough */
    }

    // FAIL or empty variable means no max, set a reasonable limit to conserve memory
    return DEFAULT_DOWNLOAD_SIZE;
  }

  /**
   * Reads a raw command response from the bootloader.
   *
   * @private
   * @returns {response} Object containing response text and data size, if any.
   * @throws {FastbootError}
   */
  async _sendRawPayload(buffer: ArrayBufferLike): Promise<void> {
    let i = 0;
    let remainingBytes = buffer.byteLength;
    while (remainingBytes > 0) {
      const chunk = buffer.slice(
        i * BULK_TRANSFER_SIZE,
        (i + 1) * BULK_TRANSFER_SIZE,
      );
      if (i % 1000 === 0) {
        common.logDebug(
          `  Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`,
        );
      }
      await this.device!.transferOut(0x01, chunk);

      remainingBytes -= chunk.byteLength;
      i += 1;
    }

    common.logDebug(
      `Finished sending payload, ${remainingBytes} bytes remaining`,
    );
  }

  /**
   * Uploads a payload to the bootloader for further use.
   * Does not handle raw images, flashing, or splitting.
   *
   * @param {string} partition - Name of the partition the payload is intended for.
   * @param {ArrayBuffer} buffer - Buffer containing the data to upload.
   * @throws {FastbootError}
   */
  async upload(partition: string, buffer: ArrayBufferLike): Promise<void> {
    common.logDebug(
      `Uploading single sparse to ${partition}: ${buffer.byteLength} bytes`,
    );

    // Bootloader requires an 8-digit hex number
    const xferHex = buffer.byteLength.toString(16).padStart(8, '0');
    if (xferHex.length !== 8) {
      throw new FastbootError(
        'FAIL',
        `Transfer size overflow: ${xferHex} is more than 8 digits`,
      );
    }

    // Check with the device and make sure size matches
    const downloadResp = await this.runCommand(`download:${xferHex}`);
    if (!downloadResp.dataSize) {
      throw new FastbootError(
        'FAIL',
        `Unexpected response to download command: ${downloadResp.text}`,
      );
    }
    const downloadSize = parseInt(downloadResp.dataSize, 16);
    if (downloadSize !== buffer.byteLength) {
      throw new FastbootError(
        'FAIL',
        `Bootloader wants ${buffer.byteLength} bytes, requested to send ${buffer.byteLength} bytes`,
      );
    }

    common.logDebug(`Sending payload: ${buffer.byteLength} bytes`);
    await this._sendRawPayload(buffer);

    common.logDebug('Payload sent, waiting for response...');
    await this._readResponse();
  }

  /**
   * Reboots to the given target and waits for the device to reconnect, unless
   * otherwise specified.
   *
   * @param {string} target - Where to reboot to, i.e. fastboot or bootloader.
   * @param {boolean} wait - Whether to wait for the device to reconnect.
   */
  async reboot(target = '', wait = false): Promise<void> {
    if (target.length > 0) {
      await this.runCommand(`reboot-${target}`);
    } else {
      await this.runCommand('reboot');
    }

    if (wait) {
      await this.waitForConnect();
    }
  }

  /**
   * Flashes the given File or Blob to the given partition on the device.
   *
   * @param {string} partition - The name of the partition to flash.
   * @param {Blob} blob - The Blob to retrieve data from.
   * @throws {FastbootError}
   */
  async flashBlob(partition: string, blob: Blob): Promise<void> {
    // Use current slot if partition is A/B
    if ((await this.getVariable(`has-slot:${partition}`)) === 'yes') {
      partition += `_${(await this.getVariable('current-slot'))!}`;
    }

    const maxDlSize = await this._getDownloadSize();

    // Logical partitions need to be resized before flashing, since they're
    // sized perfectly to the payload.
    const fileHeader = await common.readBlobAsBuffer(
      blob.slice(0, Sparse.FILE_HEADER_SIZE),
    );
    if ((await this.getVariable(`is-logical:${partition}`)) === 'yes') {
      let totalBytes = 0;
      if (Sparse.isSparse(fileHeader)) {
        const sparseHeader = Sparse.parseFileHeader(fileHeader)!; // Possibly undefined
        totalBytes = sparseHeader.blocks * sparseHeader.blockSize;
      } else {
        totalBytes = blob.size;
      }

      await this.runCommand(
        `resize-logical-partition:${partition}:${totalBytes}`,
      );
    }

    // Convert image to sparse (for splitting) if it exceeds the size limit
    if (blob.size > maxDlSize && !Sparse.isSparse(fileHeader)) {
      common.logDebug(`${partition} image is raw, converting to sparse`);

      // Assume that non-sparse images will always be small enough to convert in RAM.
      // The buffer is converted to a Blob for compatibility with the existing flashing code.
      const rawData = await common.readBlobAsBuffer(blob);
      const sparse = Sparse.fromRaw(rawData);
      blob = new Blob([sparse]);
    }

    common.logDebug(
      `Flashing ${blob.size} bytes to ${partition}, ${maxDlSize} bytes per split`,
    );
    let splits = 0;
    for await (const splitBuffer of Sparse.splitBlob(blob, maxDlSize)) {
      await this.upload(partition, splitBuffer);

      common.logDebug('Flashing payload...');
      await this.runCommand(`flash:${partition}`);

      splits += 1;
    }

    common.logDebug(`Flashed ${partition} with ${splits} split(s)`);
  }
}
