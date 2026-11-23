/**
 * Remote-controller (DJI smart controller) IPC: wires the ADB engine (adb.ts)
 * to the renderer. All actions target an Android device over USB; nothing here
 * touches the DUML drone link.
 */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { Adb, adbPath } from './adb';

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
}

type AppAction = 'launch' | 'force-stop' | 'enable' | 'disable' | 'clear';

let adb: Adb | null = null;
function client(): Adb {
  if (!adb) {
    adb = new Adb(adbPath(resourcesDir()));
  }
  return adb;
}

function text(res: { stdout: string; stderr: string }): string {
  return `${res.stdout}\n${res.stderr}`.trim();
}

function send(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

/** Registers all rc:* IPC handlers. Call once at startup. */
export function registerRcHandlers(): void {
  const rc = client();

  ipcMain.handle('rc:connect', async () => {
    await rc.startServer();
    const devices = await rc.listDevices();
    if (devices.length === 0) {
      return {
        ok: false,
        error:
          'No remote controller found. Connect it over USB with the screen on, enable USB debugging, and make sure the cable carries data.',
      };
    }
    const device = devices[0];
    if (device.state === 'unauthorized') {
      return {
        ok: false,
        error: `Controller ${device.serial} has not authorised this computer. Accept "Allow USB debugging" on its screen.`,
        serial: device.serial,
        state: device.state,
      };
    }
    if (device.state !== 'device') {
      return {
        ok: false,
        error: `Controller ${device.serial} is "${device.state}". Unplug and replug it; if it stays that way, revoke USB-debugging authorisations on the controller and restart it.`,
        serial: device.serial,
        state: device.state,
      };
    }
    return { ok: true, info: await rc.deviceInfo(device.serial) };
  });

  ipcMain.handle('rc:info', (_e, serial: string) => rc.deviceInfo(serial));

  ipcMain.handle('rc:packages', (_e, serial: string, thirdPartyOnly: boolean) =>
    rc.listPackages(serial, thirdPartyOnly),
  );

  ipcMain.handle('rc:pick-apk', async () => {
    const window = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window, {
      title: 'Select APKs to install',
      filters: [{ name: 'Android package', extensions: ['apk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
  });

  ipcMain.handle(
    'rc:install',
    async (_e, serial: string, apkPath: string, grantPerms: boolean, downgrade: boolean) => {
      const res = await rc.install(serial, apkPath, grantPerms, downgrade);
      const output = text(res);
      return { ok: res.ok && !/Failure|INSTALL_FAILED/i.test(output), output };
    },
  );

  ipcMain.handle('rc:uninstall', async (_e, serial: string, pkg: string) => {
    const output = text(await rc.uninstall(serial, pkg));
    return { ok: /Success/i.test(output), output };
  });

  ipcMain.handle('rc:set-home', async (_e, serial: string, component: string) => {
    const res = await rc.setHomeActivity(serial, component);
    return { ok: res.ok, output: text(res) };
  });

  ipcMain.handle('rc:launchers', (_e, serial: string) => rc.listLaunchers(serial));

  ipcMain.handle('rc:shell', async (_e, serial: string, command: string) => {
    const res = await rc.shell(serial, command);
    return { ok: res.ok, output: text(res) };
  });

  ipcMain.handle('rc:app-action', async (_e, serial: string, pkg: string, action: AppAction) => {
    let res;
    switch (action) {
      case 'launch':
        res = await rc.launchApp(serial, pkg);
        break;
      case 'force-stop':
        res = await rc.forceStop(serial, pkg);
        break;
      case 'enable':
        res = await rc.setEnabled(serial, pkg, true);
        break;
      case 'disable':
        res = await rc.setEnabled(serial, pkg, false);
        break;
      case 'clear':
        res = await rc.clearData(serial, pkg);
        break;
      default:
        return { ok: false, output: `Unknown action: ${String(action)}` };
    }
    return { ok: res.ok, output: text(res) };
  });

  ipcMain.handle('rc:root', (_e, serial: string) => rc.tryRoot(serial));

  ipcMain.handle('rc:disconnect', async () => {
    await rc.killServer();
    return { ok: true };
  });

  ipcMain.handle('rc:pick-folder', async () => {
    const window = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle('rc:pull-apks', async (_e, serial: string, pkgs: string[], outDir: string) => {
    const results = [];
    for (const [index, pkg] of pkgs.entries()) {
      send('rc:pull-progress', { pkg, index: index + 1, total: pkgs.length });
      const res = await rc.pullApk(serial, pkg, outDir);
      results.push(
        res.ok ? { pkg, ok: true, file: res.file, split: res.split } : { pkg, ok: false, error: res.error },
      );
    }
    return results;
  });

  ipcMain.handle('rc:ls', async (_e, serial: string, dir: string) => {
    const res = await rc.listDir(serial, dir);
    return { ok: res.ok, output: text(res) };
  });

  // The latest capture is kept so "Save" writes exactly the frame on screen.
  let lastScreen: Buffer | null = null;

  ipcMain.handle('rc:screen', async (_e, serial: string) => {
    const png = await rc.screencap(serial);
    if (!png) {
      return { ok: false };
    }
    lastScreen = png;
    return { ok: true, image: `data:image/png;base64,${png.toString('base64')}` };
  });

  ipcMain.handle('rc:screen-save', async () => {
    if (!lastScreen) {
      return { ok: false, output: 'There is no capture to save yet.' };
    }
    const window = BrowserWindow.getAllWindows()[0];
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const save = await dialog.showSaveDialog(window, {
      title: 'Save screenshot',
      defaultPath: `controller-${stamp}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (save.canceled || !save.filePath) {
      return { ok: false, output: 'cancelled' };
    }
    try {
      await writeFile(save.filePath, lastScreen);
      return { ok: true, output: '', file: save.filePath };
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('rc:pull', async (_e, serial: string, remote: string) => {
    const window = BrowserWindow.getAllWindows()[0];
    const base = remote.split('/').filter(Boolean).pop() ?? 'file';
    const save = await dialog.showSaveDialog(window, { title: 'Save pulled file', defaultPath: base });
    if (save.canceled || !save.filePath) {
      return { ok: false, output: 'cancelled' };
    }
    const res = await rc.pull(serial, remote, save.filePath);
    return { ok: res.ok, output: text(res), file: res.ok ? save.filePath : undefined };
  });

  ipcMain.handle('rc:push', async (_e, serial: string, remoteDir: string) => {
    const window = BrowserWindow.getAllWindows()[0];
    const open = await dialog.showOpenDialog(window, { title: 'Select a file to push', properties: ['openFile'] });
    if (open.canceled || open.filePaths.length === 0) {
      return { ok: false, output: 'cancelled' };
    }
    const local = open.filePaths[0];
    const base = local.split(/[\\/]/).pop() ?? 'file';
    const remote = `${remoteDir.replace(/\/$/, '')}/${base}`;
    const res = await rc.push(serial, local, remote);
    return { ok: res.ok, output: text(res) };
  });

  ipcMain.handle('rc:settings-get', async (_e, serial: string, ns: string, key: string) => {
    const res = await rc.settingsGet(serial, ns, key);
    return { ok: res.ok, output: text(res) };
  });

  ipcMain.handle('rc:settings-put', async (_e, serial: string, ns: string, key: string, value: string) => {
    const res = await rc.settingsPut(serial, ns, key, value);
    return { ok: res.ok, output: text(res) };
  });
}
