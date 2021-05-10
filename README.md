# fastboot.js

fastboot.js is an implementation of the Android [fastboot](https://android.googlesource.com/platform/system/core/+/master/fastboot/README.md) protocol in JavaScript. It runs in web browsers by using the [WebUSB](https://wicg.github.io/webusb/) API, which is currently supported by Chrome.

If you're looking for a ready-to-use installer for custom ROMs, see [android-webinstall](https://github.com/kdrag0n/android-webinstall).

## Why?

Many users, particularly those with less technical experience, have trouble flashing custom operating systems on Android devices. This is not necessarily their fault; there are many steps in the process that can go wrong. Broken or outdated Android platform tools, missed commands or steps, and many other factors can cause problems during flashing.

WebUSB makes it possible to move most of the complexity into the browser, where the environment is much more controlled and most of the steps can be automated. This makes it easier for users to flash ROMs onto their devices and is more likely to result in success.

Google's [Android Flash Tool](https://flash.android.com/welcome) for AOSP CI images and Pixel factory images is already taking advantage of this, but unfortunately, it is proprietary and closed-source. Furthermore, it only supports flashing the aforementioned images from Google, so flashing custom ROMs with it is not possible. This is where fastboot.js comes in: it is an open-source library that can be used to create web installers for flashing anything.

## Features

The following fastboot features are supported:

- Running commands (erase, lock, unlock, getvar, reboot, etc.)
- Flashing raw, bootloader, sparse, and custom AVB key images
- Flashing AOSP factory image zips (update.zip), including firmware, logical partitions, and verified boot keys
- Flashing images larger than the bootloader's maximum download size (by splitting sparse images)
- Flashing logical partitions

Detailed progress callbacks are also provided for many flashing steps.

## Installation

This library is available as a [package](https://www.npmjs.com/package/android-fastboot) on npm, so you can easily add it to your project:

```bash
# Using npm
npm install --save android-fastboot

# Using yarn
yarn add android-fastboot
```

## Examples

A basic demo of fastboot.js can be found [here](https://kdrag0n.github.io/fastboot.js/demo/). The source code is included [in this repository](https://github.com/kdrag0n/fastboot.js/tree/master/demo).

There is also a [user-friendly ROM installer](https://github.com/kdrag0n/android-webinstall) available, with a [live ProtonAOSP instance](https://protonaosp.kdrag0n.dev/install/web/?utm_source=github&utm_campaign=fastboot.js) that can be used to flash devices officially supported by ProtonAOSP.

## Documentation

Documentation generated from JSDoc comments can be found [here](https://kdrag0n.github.io/fastboot.js/docs/).
