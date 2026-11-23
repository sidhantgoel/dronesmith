# Dronesmith

A desktop tool for servicing DJI drones over USB. It talks the drone's
DUML/DUPC service protocol and provides board information, gimbal and IMU
calibration, diagnostics and a service report, firmware flashing, a partition
image explorer, a drone FTP browser, fastboot recovery, and smart-controller
(ADB) tools.

> **Warning:** This operates directly on drone hardware. Read-only features
> (board info, diagnostics, telemetry, FTP, partition dumps) are safe; write
> features (firmware flashing, gimbal/IMU repairs, serial writes, fastboot
> flash/erase) can permanently damage or brick a device. Use only on hardware
> you own and understand.

## Two shells, one UI

The React UI (`src/renderer/`) runs on either of two backends:

- **Electron** (`src/*.ts`) — the original main process.
- **Tauri** (`src-tauri/`) — a Rust backend exposing the same features as Tauri
  commands. The UI runs unchanged through the bridge in
  `src/renderer/tauriBridge.ts`.

USB access uses the libusb-win32 driver (`libusb0.dll`), so the native service
link is Windows-oriented.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ (24 recommended)
- [Rust](https://www.rust-lang.org/tools/install) (stable) — for the Tauri build
- Platform dependencies for [Tauri 2](https://tauri.app/start/prerequisites/)

## Build and run

```sh
npm install

# Web UI only (Vite dev server / production bundle)
npm run web:dev
npm run web:build

# Tauri app (Rust backend + web UI)
npm run tauri:dev
npm run tauri:build

# Electron app (original shell)
npm start
npm run make
```

## Continuous integration

`.github/workflows/build.yml` type-checks and builds the web bundle on Linux and
builds the Tauri app on Windows for every push and pull request.

## Releases

`.github/workflows/release.yml` builds installers for Windows, Linux and macOS
(Apple silicon and Intel) and attaches them to a draft GitHub Release whenever a
`v*` tag is pushed:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Review the draft release on GitHub, then publish it. macOS bundles are unsigned
unless signing secrets are configured, so Gatekeeper will warn on first launch.

## License

[MIT](LICENSE)
