# fastboot.js

fastboot.js is an implementation of the [fastboot](https://android.googlesource.com/platform/system/core/+/master/fastboot/README.md) protocol in JavaScript. It runs in web browsers using the [WebUSB](https://wicg.github.io/webusb/) API, which is currently supported by Chrome.

This work was funded by [GrapheneOS](https://grapheneos.org).

## Features

The following fastboot features are supported:

- Running commands (erase, lock, unlock, getvar, reboot, etc.)
- Flashing raw, bootloader, sparse, and custom AVB key images
- Flashing AOSP factory image zips (update.zip)
- Flashing images larger than the bootloader's maximum download size (by splitting sparse images)

## Example

A basic demo of fastboot.js can be found [here](https://kdrag0n.github.io/fastboot.js/demo/). The source code is included [in this repository](https://github.com/kdrag0n/fastboot.js/tree/master/demo).
