/**
 * Compatibility bridge: recreates the Electron `window.drone` / `window.rc` /
 * etc. API on top of Tauri's `invoke`/`listen`, so the whole React UI runs
 * unchanged under the Tauri shell while features are ported to Rust one at a
 * time.
 *
 * It installs itself only under Tauri (detected by `__TAURI_INTERNALS__`); in
 * the Electron build the preload already provides these globals and this file
 * does nothing. Methods already ported to Rust are wired through; everything
 * else is a safe stub that rejects (for calls) or is a no-op (for `on*`
 * subscriptions), so the app loads and the Device-info page works even before
 * the rest is ported.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

type AnyFn = (...args: unknown[]) => unknown;

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Subscribes to a Tauri event and returns an unsubscribe function synchronously. */
function on<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void listen<T>(event, (e) => callback(e.payload)).then((fn) => {
    if (cancelled) {
      fn();
    } else {
      unlisten = fn;
    }
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

const notPorted = (name: string): Promise<never> =>
  Promise.reject(new Error(`"${name}" is not available in the Tauri build yet.`));

/** A no-op event subscription (returns an unsubscribe). */
const noopSub = (): (() => void) => () => undefined;

/**
 * Wraps a set of real implementations so any other property access returns a
 * safe stub: `on…`/`subscribe…` become no-op subscriptions, everything else a
 * rejecting async call. Keeps the UI from crashing on unported features.
 */
function withStubs(real: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(real, {
    get(target, prop: string) {
      if (prop in target) {
        return (target as Record<string, unknown>)[prop];
      }
      if (prop.startsWith('on')) {
        return noopSub;
      }
      return ((): Promise<never> => notPorted(prop)) as AnyFn;
    },
  });
}

function install(): void {
  const drone = withStubs({
    getState: (): Promise<unknown> => invoke('drone_get_state'),
    onState: (cb: (state: unknown) => void): (() => void) => on('drone:state', cb),
    runService: (action: string): Promise<unknown> => invoke('service_run', { action }),
    readHms: (): Promise<unknown> => invoke('hms_read'),
    clearHms: (): Promise<void> => invoke('hms_clear'),
    readAllParams: (): Promise<unknown> => invoke('param_read_all'),
    cancelReadParams: (): Promise<void> => invoke('param_cancel_read'),
    writeParam: (name: string, index: number, value: number, size: number, typeId: number): Promise<unknown> =>
      invoke('param_write', { name, index, value, size, typeId }),
    onParamProgress: (cb: (p: unknown) => void): (() => void) => on('drone:param-progress', cb),
    readBattery: (): Promise<unknown> => invoke('battery_read'),
    getTelemetry: (): Promise<unknown> => invoke('telemetry_get'),
    calibrate: (kind: string, allowRestricted?: boolean): Promise<void> =>
      invoke('drone_calibrate', { kind, allowRestricted: allowRestricted ?? false }),
    imuCalibrate: (): Promise<void> => invoke('imu_calibrate'),
    imuCalibrateStop: (): Promise<void> => invoke('imu_stop'),
    gimbalTestMove: (axis: string | null, target: unknown, seconds: number, allowUntested: boolean): Promise<unknown> =>
      invoke('gimbal_move', { axis, target, seconds, allowUntested }),
    gimbalTestJog: (axis: string, delta: number, seconds: number, allowUntested: boolean): Promise<unknown> =>
      invoke('gimbal_jog', { axis, delta, seconds, allowUntested }),
    gimbalTestStop: (): Promise<unknown> => invoke('gimbal_stop'),
    propTestRun: (motors: number[], percent: number, seconds: number, options: unknown): Promise<unknown> =>
      invoke('prop_run', { motors, percent, seconds, options }),
    propTestStop: (): Promise<unknown> => invoke('prop_stop'),
    onPropTest: (cb: (event: unknown) => void): (() => void) => on('drone:prop-test', cb),
    motorBeep: (motor: number, on: boolean, allowUntested: boolean): Promise<unknown> =>
      invoke('motor_beep', { motor, on, allowUntested }),
    motorBeepStop: (): Promise<unknown> => invoke('motor_beep_stop'),
    repairGimbalImu: (method: string): Promise<unknown> => invoke('repair_gimbal_imu', { method }),
    readSerials: (): Promise<unknown> => invoke('serial_read_all'),
    writeSerial: (component: string, serial: string): Promise<unknown> =>
      invoke('serial_write', { component, serial }),
    readParam: (name: string): Promise<unknown> => invoke('param_read', { name }),
    consoleSend: (request: unknown): Promise<unknown> => invoke('console_send', { request }),
    consoleWatch: (on: boolean): Promise<void> => invoke('console_watch', { on }),
    onConsoleFrames: (cb: (frames: unknown) => void): (() => void) => on('drone:console-frames', cb),
    runDiagnostics: (): Promise<unknown> => invoke('diag_run'),
    onDiagnosticProgress: (cb: (p: unknown) => void): (() => void) => on('drone:diag-progress', cb),
    saveReport: (report: unknown): Promise<unknown> => invoke('diag_save_report', { report }),
    saveParamBackup: (json: string): Promise<unknown> => invoke('param_save_backup', { json }),
    loadParamBackup: (): Promise<unknown> => invoke('param_load_backup'),
    backupPartition: (id: number): Promise<unknown> => invoke('partition_backup', { id }),
    pickFirmware: (): Promise<unknown> => invoke('flash_pick'),
    validateFlash: (packagePath: string): Promise<unknown> => invoke('flash_validate', { packagePath }),
    startFlash: (packagePath: string): Promise<void> => invoke('flash_start', { packagePath }),
    cancelFlash: (): Promise<void> => invoke('flash_cancel'),
    getFlashState: (): Promise<unknown> => invoke('flash_get_state'),
    onFlash: (cb: (state: unknown) => void): (() => void) => on('drone:flash', cb),
    onPackets: noopSub,
  });

  const droneFs = withStubs({
    connect: (options?: unknown): Promise<unknown> => invoke('ftp_connect', { options: options ?? null }),
    list: (dir: string): Promise<unknown> => invoke('ftp_list', { dir }),
    download: (dir: string, name: string): Promise<unknown> => invoke('ftp_download', { dir, name }),
    disconnect: (): Promise<void> => invoke('ftp_disconnect'),
    onProgress: (cb: (p: unknown) => void): (() => void) => on('ftp:progress', cb),
  });

  const rc = withStubs({
    connect: (): Promise<unknown> => invoke('rc_connect'),
    info: (serial: string): Promise<unknown> => invoke('rc_info', { serial }),
    packages: (serial: string, thirdPartyOnly: boolean): Promise<unknown> => invoke('rc_packages', { serial, thirdPartyOnly }),
    pickApk: (): Promise<unknown> => invoke('rc_pick_apk'),
    install: (serial: string, apkPath: string, grantPerms: boolean, downgrade: boolean): Promise<unknown> =>
      invoke('rc_install', { serial, apkPath, grantPerms, downgrade }),
    uninstall: (serial: string, pkg: string): Promise<unknown> => invoke('rc_uninstall', { serial, pkg }),
    setHome: (serial: string, component: string): Promise<unknown> => invoke('rc_set_home', { serial, component }),
    launchers: (serial: string): Promise<unknown> => invoke('rc_launchers', { serial }),
    shell: (serial: string, command: string): Promise<unknown> => invoke('rc_shell', { serial, command }),
    appAction: (serial: string, pkg: string, action: string): Promise<unknown> => invoke('rc_app_action', { serial, pkg, action }),
    root: (serial: string): Promise<unknown> => invoke('rc_root', { serial }),
    disconnect: (): Promise<unknown> => invoke('rc_disconnect'),
    pickFolder: (): Promise<unknown> => invoke('rc_pick_folder'),
    pullApks: (serial: string, pkgs: string[], outDir: string): Promise<unknown> => invoke('rc_pull_apks', { serial, pkgs, outDir }),
    ls: (serial: string, dir: string): Promise<unknown> => invoke('rc_ls', { serial, dir }),
    pull: (serial: string, remote: string): Promise<unknown> => invoke('rc_pull', { serial, remote }),
    push: (serial: string, remoteDir: string): Promise<unknown> => invoke('rc_push', { serial, remoteDir }),
    settingsGet: (serial: string, ns: string, key: string): Promise<unknown> => invoke('rc_settings_get', { serial, ns, key }),
    settingsPut: (serial: string, ns: string, key: string, value: string): Promise<unknown> =>
      invoke('rc_settings_put', { serial, ns, key, value }),
    screen: (serial: string): Promise<unknown> => invoke('rc_screen', { serial }),
    screenSave: (): Promise<unknown> => invoke('rc_screen_save'),
    onPullProgress: (cb: (p: unknown) => void): (() => void) => on('rc:pull-progress', cb),
  });

  const fastboot = withStubs({
    scan: (): Promise<unknown> => invoke('fastboot_scan'),
    watch: (on: boolean): Promise<unknown> => invoke('fastboot_watch', { on }),
    onFound: (cb: (result: unknown) => void): (() => void) => on('fastboot:found', cb),
    onWatchStopped: (cb: (info: unknown) => void): (() => void) => on('fastboot:watch-stopped', cb),
    reboot: (target: string): Promise<unknown> => invoke('fastboot_reboot', { target }),
    erase: (partition: string): Promise<unknown> => invoke('fastboot_erase', { partition }),
    flash: (partition: string): Promise<unknown> => invoke('fastboot_flash', { partition }),
    disconnect: (): Promise<void> => invoke('fastboot_disconnect'),
    onFlashProgress: (cb: (p: unknown) => void): (() => void) => on('fastboot:flash-progress', cb),
  });

  const imageTool = withStubs({
    open: (): Promise<unknown> => invoke('image_open'),
    mount: (offset: number): Promise<unknown> => invoke('image_mount', { offset }),
    list: (folder: string): Promise<unknown> => invoke('image_list', { folder }),
    preview: (file: string): Promise<unknown> => invoke('image_preview', { file }),
    extract: (remote: string): Promise<unknown> => invoke('image_extract', { remote }),
    close: (): Promise<void> => invoke('image_close'),
    onProgress: (cb: (p: unknown) => void): (() => void) => on('image:progress', cb),
  });

  Object.assign(window as unknown as Record<string, unknown>, {
    drone,
    rc,
    imageTool,
    droneFs,
    fastboot,
    chromeUi: { setTitleBarTheme: (): void => undefined },
  });
}

if (isTauri && !('drone' in window && (window as unknown as { drone?: unknown }).drone)) {
  install();
}
