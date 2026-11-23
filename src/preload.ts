// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('drone', {
  getState: (): Promise<unknown> => ipcRenderer.invoke('drone:getState'),
  calibrate: (kind: string, allowRestricted?: boolean): Promise<void> =>
    ipcRenderer.invoke('drone:calibrate', kind, allowRestricted),
  imuCalibrate: (): Promise<void> => ipcRenderer.invoke('imu:calibrate'),
  imuCalibrateStop: (): Promise<void> => ipcRenderer.invoke('imu:stop'),
  readBattery: (): Promise<unknown> => ipcRenderer.invoke('battery:read'),
  getTelemetry: (): Promise<unknown> => ipcRenderer.invoke('telemetry:get'),
  onState: (callback: (state: unknown) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: unknown,
    ): void => callback(state);
    ipcRenderer.on('drone:state', listener);
    return () => ipcRenderer.removeListener('drone:state', listener);
  },
  pickFirmware: (): Promise<string | undefined> =>
    ipcRenderer.invoke('flash:pick'),
  validateFlash: (packagePath: string): Promise<unknown> =>
    ipcRenderer.invoke('flash:validate', packagePath),
  startFlash: (packagePath: string): Promise<void> =>
    ipcRenderer.invoke('flash:start', packagePath),
  cancelFlash: (): Promise<void> => ipcRenderer.invoke('flash:cancel'),
  getFlashState: (): Promise<unknown> => ipcRenderer.invoke('flash:getState'),
  runService: (action: string): Promise<unknown> => ipcRenderer.invoke('service:run', action),
  readParam: (name: string): Promise<unknown> => ipcRenderer.invoke('param:read', name),
  readAllParams: (): Promise<unknown> => ipcRenderer.invoke('param:readAll'),
  cancelReadParams: (): Promise<void> => ipcRenderer.invoke('param:cancelRead'),
  onParamProgress: (callback: (progress: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown): void =>
      callback(progress);
    ipcRenderer.on('drone:param-progress', listener);
    return () => ipcRenderer.removeListener('drone:param-progress', listener);
  },
  writeParam: (
    name: string,
    index: number,
    value: number,
    size: number,
    typeId: number,
  ): Promise<unknown> => ipcRenderer.invoke('param:write', name, index, value, size, typeId),
  readHms: (): Promise<unknown> => ipcRenderer.invoke('hms:read'),
  clearHms: (): Promise<void> => ipcRenderer.invoke('hms:clear'),
  saveParamBackup: (json: string): Promise<unknown> =>
    ipcRenderer.invoke('param:saveBackup', json),
  loadParamBackup: (): Promise<unknown> => ipcRenderer.invoke('param:loadBackup'),
  backupPartition: (id: number): Promise<unknown> =>
    ipcRenderer.invoke('partition:backup', id),
  gimbalTestMove: (axis: string | null, target: unknown, seconds: number, allowUntested: boolean): Promise<unknown> =>
    ipcRenderer.invoke('motor:gimbalMove', axis, target, seconds, allowUntested),
  gimbalTestJog: (axis: string, delta: number, seconds: number, allowUntested: boolean): Promise<unknown> =>
    ipcRenderer.invoke('motor:gimbalJog', axis, delta, seconds, allowUntested),
  gimbalTestStop: (): Promise<unknown> => ipcRenderer.invoke('motor:gimbalStop'),
  propTestRun: (motors: number[], percent: number, seconds: number, options: unknown): Promise<unknown> =>
    ipcRenderer.invoke('motor:propRun', motors, percent, seconds, options),
  propTestStop: (): Promise<unknown> => ipcRenderer.invoke('motor:propStop'),
  onPropTest: (callback: (event: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown): void => callback(event);
    ipcRenderer.on('drone:prop-test', listener);
    return () => ipcRenderer.removeListener('drone:prop-test', listener);
  },
  motorBeep: (motor: number, on: boolean, allowUntested: boolean): Promise<unknown> =>
    ipcRenderer.invoke('motor:beep', motor, on, allowUntested),
  motorBeepStop: (): Promise<unknown> => ipcRenderer.invoke('motor:beepStop'),
  repairGimbalImu: (method: string): Promise<unknown> => ipcRenderer.invoke('repair:gimbalImu', method),
  readSerials: (): Promise<unknown> => ipcRenderer.invoke('serial:readAll'),
  writeSerial: (component: string, serial: string): Promise<unknown> =>
    ipcRenderer.invoke('serial:write', component, serial),
  runDiagnostics: (): Promise<unknown> => ipcRenderer.invoke('diag:run'),
  onDiagnosticProgress: (callback: (progress: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown): void => callback(progress);
    ipcRenderer.on('drone:diag-progress', listener);
    return () => ipcRenderer.removeListener('drone:diag-progress', listener);
  },
  saveReport: (report: unknown): Promise<unknown> => ipcRenderer.invoke('diag:saveReport', report),
  consoleSend: (request: unknown): Promise<unknown> => ipcRenderer.invoke('console:send', request),
  consoleWatch: (on: boolean): Promise<void> => ipcRenderer.invoke('console:watch', on),
  onConsoleFrames: (callback: (frames: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, frames: unknown): void => callback(frames);
    ipcRenderer.on('drone:console-frames', listener);
    return () => ipcRenderer.removeListener('drone:console-frames', listener);
  },
  onFlash: (callback: (state: unknown) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: unknown,
    ): void => callback(state);
    ipcRenderer.on('drone:flash', listener);
    return () => ipcRenderer.removeListener('drone:flash', listener);
  },
  onPackets: (callback: (lines: string[]) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      lines: string[],
    ): void => callback(lines);
    ipcRenderer.on('drone:packets', listener);
    return () => ipcRenderer.removeListener('drone:packets', listener);
  },
});

// Remote-controller (DJI smart controller) ADB service tools.
contextBridge.exposeInMainWorld('rc', {
  connect: (): Promise<unknown> => ipcRenderer.invoke('rc:connect'),
  info: (serial: string): Promise<unknown> => ipcRenderer.invoke('rc:info', serial),
  packages: (serial: string, thirdPartyOnly: boolean): Promise<unknown> =>
    ipcRenderer.invoke('rc:packages', serial, thirdPartyOnly),
  pickApk: (): Promise<string[] | null> => ipcRenderer.invoke('rc:pick-apk'),
  install: (serial: string, apkPath: string, grantPerms: boolean, downgrade: boolean): Promise<unknown> =>
    ipcRenderer.invoke('rc:install', serial, apkPath, grantPerms, downgrade),
  uninstall: (serial: string, pkg: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:uninstall', serial, pkg),
  setHome: (serial: string, component: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:set-home', serial, component),
  launchers: (serial: string): Promise<string[]> => ipcRenderer.invoke('rc:launchers', serial),
  shell: (serial: string, command: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:shell', serial, command),
  appAction: (serial: string, pkg: string, action: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:app-action', serial, pkg, action),
  root: (serial: string): Promise<unknown> => ipcRenderer.invoke('rc:root', serial),
  disconnect: (): Promise<unknown> => ipcRenderer.invoke('rc:disconnect'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('rc:pick-folder'),
  pullApks: (serial: string, pkgs: string[], outDir: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:pull-apks', serial, pkgs, outDir),
  ls: (serial: string, dir: string): Promise<unknown> => ipcRenderer.invoke('rc:ls', serial, dir),
  pull: (serial: string, remote: string): Promise<unknown> => ipcRenderer.invoke('rc:pull', serial, remote),
  push: (serial: string, remoteDir: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:push', serial, remoteDir),
  settingsGet: (serial: string, ns: string, key: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:settings-get', serial, ns, key),
  settingsPut: (serial: string, ns: string, key: string, value: string): Promise<unknown> =>
    ipcRenderer.invoke('rc:settings-put', serial, ns, key, value),
  screen: (serial: string): Promise<unknown> => ipcRenderer.invoke('rc:screen', serial),
  screenSave: (): Promise<unknown> => ipcRenderer.invoke('rc:screen-save'),
  onPullProgress: (callback: (p: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p);
    ipcRenderer.on('rc:pull-progress', listener);
    return () => ipcRenderer.removeListener('rc:pull-progress', listener);
  },
});

// Fastboot explorer: inspect/flash a drone that is in fastboot mode.
contextBridge.exposeInMainWorld('fastboot', {
  scan: (): Promise<unknown> => ipcRenderer.invoke('fastboot:scan'),
  watch: (on: boolean): Promise<unknown> => ipcRenderer.invoke('fastboot:watch', on),
  onFound: (callback: (result: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown): void => callback(result);
    ipcRenderer.on('fastboot:found', listener);
    return () => ipcRenderer.removeListener('fastboot:found', listener);
  },
  onWatchStopped: (callback: (info: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: unknown): void => callback(info);
    ipcRenderer.on('fastboot:watch-stopped', listener);
    return () => ipcRenderer.removeListener('fastboot:watch-stopped', listener);
  },
  reboot: (target: string): Promise<unknown> => ipcRenderer.invoke('fastboot:reboot', target),
  erase: (partition: string): Promise<unknown> => ipcRenderer.invoke('fastboot:erase', partition),
  flash: (partition: string): Promise<unknown> => ipcRenderer.invoke('fastboot:flash', partition),
  disconnect: (): Promise<void> => ipcRenderer.invoke('fastboot:disconnect'),
  onFlashProgress: (callback: (p: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p);
    ipcRenderer.on('fastboot:flash-progress', listener);
    return () => ipcRenderer.removeListener('fastboot:flash-progress', listener);
  },
});

// Partition image explorer: read-only browsing of ext filesystems in a dump file.
contextBridge.exposeInMainWorld('imageTool', {
  open: (): Promise<unknown> => ipcRenderer.invoke('image:open'),
  mount: (offset: number): Promise<unknown> => ipcRenderer.invoke('image:mount', offset),
  list: (folder: string): Promise<unknown> => ipcRenderer.invoke('image:list', folder),
  preview: (file: string): Promise<unknown> => ipcRenderer.invoke('image:preview', file),
  extract: (remote: string): Promise<unknown> => ipcRenderer.invoke('image:extract', remote),
  close: (): Promise<void> => ipcRenderer.invoke('image:close'),
  onProgress: (callback: (p: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p);
    ipcRenderer.on('image:progress', listener);
    return () => ipcRenderer.removeListener('image:progress', listener);
  },
});

// Drone files: reads files from the aircraft over its USB FTP server.
contextBridge.exposeInMainWorld('droneFs', {
  connect: (options?: { host?: string; user?: string; password?: string }): Promise<unknown> =>
    ipcRenderer.invoke('ftp:connect', options),
  list: (dir: string): Promise<unknown> => ipcRenderer.invoke('ftp:list', dir),
  download: (dir: string, name: string): Promise<unknown> => ipcRenderer.invoke('ftp:download', dir, name),
  disconnect: (): Promise<void> => ipcRenderer.invoke('ftp:disconnect'),
  onProgress: (callback: (p: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p);
    ipcRenderer.on('ftp:progress', listener);
    return () => ipcRenderer.removeListener('ftp:progress', listener);
  },
});

// Lets the renderer keep the native window-control overlay in step with the
// light/dark theme.
contextBridge.exposeInMainWorld('chromeUi', {
  setTitleBarTheme: (mode: 'light' | 'dark'): void =>
    ipcRenderer.send('window:titlebar-theme', mode),
});
