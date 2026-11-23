import { cp } from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    // Native binaries cannot be loaded from inside the archive.
    asar: { unpack: '**/*.node' },
    // Application icon (Forge appends .ico on Windows, .icns on macOS).
    icon: 'resources/icon',
    // libusb-win32 user-space library (USB bulk link), the window icon, and
    // the HMS fault-code database.
    // adb is a directory (adb.exe + its two Windows DLLs) copied whole, so it
    // lands at <resources>/adb/adb.exe for the bundled ADB engine (rc.ts).
    extraResource: ['resources/libusb0.dll', 'resources/icon.ico', 'resources/hms.json', 'resources/adb'],
  },
  rebuildConfig: {},
  hooks: {
    // The Vite plugin packages only its own bundles, and koffi is external to
    // the main bundle (see vite.main.config.ts), so it has to be copied in:
    // the module itself and the prebuilt binary for the target platform.
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      for (const name of ['koffi', `@koromix/koffi-${platform}-${arch}`]) {
        await cp(
          path.resolve('node_modules', name),
          path.join(buildPath, 'node_modules', name),
          { recursive: true },
        );
      }
    },
  },
  makers: [
    new MakerSquirrel({ setupIcon: 'resources/icon.ico' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
