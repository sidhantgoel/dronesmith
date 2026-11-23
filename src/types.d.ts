import type { ServiceAction } from './service';
import type { HmsFault } from './hms';
import type { FirmwareManifest } from './config';

import type { GimbalAngles, GimbalAxis } from './motorTest';

export type { HmsFault } from './hms';
export type { FirmwareManifest, ManifestModule } from './config';
export type { GimbalAngles, GimbalAxis } from './motorTest';

import type { BatterySnapshot } from './battery';
import type { FcStatus } from './telemetry';

export type { BatteryLive, BatteryPack, BatterySnapshot } from './battery';
export type { FcStatus } from './telemetry';

import type { ConsoleFrame, ConsoleReply, ConsoleRequest } from './consoleCmd';
import type { DiagnosticProgress, DiagnosticReport } from './diagnostics';
import type { ImuRepairMethod, SerialComponent } from './repair';

export type { ConsoleFrame, ConsoleReply, ConsoleRequest } from './consoleCmd';
export type { DiagnosticCheck, DiagnosticProgress, DiagnosticReport } from './diagnostics';
export type { ImuRepairMethod, SerialComponent } from './repair';

/** A repair that is running or has just ended, for the Repairs page. */
export interface RepairState {
  kind: 'gimbal-imu';
  phase: 'running' | 'done' | 'failed';
  /** 0–100. */
  percent: number;
  message: string;
}

export interface SerialRow {
  component: SerialComponent;
  label: string;
  /** The serial the module reported, when it answered with one. */
  serial?: string;
  writable: boolean;
}

export interface SerialWriteResult {
  ok: boolean;
  message: string;
  /** The serial the module reported before the write, when it answered. */
  before?: string;
  /** The serial the module reported after the write, when it answered. */
  after?: string;
}

export interface ReportSaveResult {
  ok: boolean;
  /** Where the report was written, when it was. */
  path?: string;
  message?: string;
}

export interface BatteryReading {
  ok: boolean;
  /** Why nothing could be read, when ok is false. */
  message?: string;
  /** Epoch milliseconds of the read. */
  at: number;
  battery: BatterySnapshot;
}

export interface TelemetryReading {
  /** Latest flight-controller status, once one has arrived on this connection. */
  status?: FcStatus;
  /** Epoch milliseconds that status arrived. */
  at?: number;
}

export interface MotorTestResult {
  ok: boolean;
  message: string;
  /** Answers the gimbal has sent to test commands so far (gimbal test only). */
  acks?: number;
}

export interface PropTestOptions {
  /** The operator confirmed that every propeller is off. */
  propsRemoved: boolean;
  /** Run although the routine was not validated on this aircraft. */
  allowUntested: boolean;
}

export interface PropTestEvent {
  /** DJI motor number, 1–4. */
  motor: number;
  phase: 'spinning' | 'done' | 'failed' | 'stopped';
  /** Epoch milliseconds the spin is due to end, while spinning. */
  endsAt?: number;
  note?: string;
}

export type CalibrationKind = 'jointCoarse' | 'linearHall' | 'advanced';

export interface HmsState {
  faults: HmsFault[];
  /** Epoch milliseconds of the last HMS push. */
  updatedAt: number;
}

export interface HmsReadResult {
  ok: boolean;
  /** Faults held after the read. */
  count: number;
  message: string;
}

export interface ServiceResult {
  action: ServiceAction;
  ok: boolean;
  message: string;
  /** Per-step notes (which module replied, serials found, etc.). */
  details?: string[];
}

export interface ModuleVersion {
  /** Module name, e.g. "Flight controller". */
  name: string;
  hardware: string;
  firmware: string;
  loader: string;
}

export interface CalibrationState {
  kind: CalibrationKind;
  /**
   * pass   - the gimbal sent its concluding report
   * unsure - monitoring ended without a concluding report; the gimbal may
   *          still be calibrating
   * failed - the request could not be delivered or was not acknowledged
   */
  phase: 'running' | 'pass' | 'unsure' | 'failed';
  /** Epoch milliseconds. */
  startedAt: number;
  finishedAt?: number;
  expectMs: number;
  /** Number of progress reports received from the gimbal. */
  reports: number;
  /** Raw bytes of the most recent report, as hex. */
  lastReport?: string;
  /** Percentage the gimbal itself reports (advanced calibration only). */
  progress?: number;
  message: string;
}

export interface ImuCalibrationState {
  /**
   * pass    - the aircraft reported 100%
   * unsure  - monitoring ended without a concluding report
   * failed  - the request was refused or not answered
   * stopped - the operator stopped the run
   */
  phase: 'running' | 'pass' | 'unsure' | 'failed' | 'stopped';
  /** Epoch milliseconds. */
  startedAt: number;
  finishedAt?: number;
  /** Percentage the aircraft itself reports. */
  progress?: number;
  /** Index of the position the aircraft is asking for (0–5), once reported. */
  position?: number;
  /** Positions the aircraft has moved past. */
  done: number[];
  /** Number of progress reports received. */
  reports: number;
  message: string;
}

export interface DroneState {
  status: 'searching' | 'connected';
  /** Name of the connected USB endpoint. */
  label?: string;
  /** Why the last connection attempt failed or the link dropped. */
  error?: string;
  /** True while module versions are still being requested. */
  scanning: boolean;
  /**
   * Marketing name of the detected aircraft, e.g. "DJI Mavic 3". Resolved
   * from the factory code in the version-inquiry reply (see models.ts),
   * falling back to the USB product string.
   */
  model?: string;
  /** Factory code the aircraft reports, e.g. "WM260", once detected. */
  modelCode?: string;
  modules: ModuleVersion[];
  /** Camera serial number, once the camera has reported it. */
  cameraSerial?: string;
  /** Aircraft (drone) serial number, once read. */
  serial?: string;
  calibration?: CalibrationState;
  /** Latest IMU-calibration run on this connection, if any. */
  imuCalibration?: ImuCalibrationState;
  /** Latest repair run on this connection, if any. */
  repair?: RepairState;
  /** Latest Health Management System fault report, once any push arrives. */
  hms?: HmsState;
  /** Firmware manifest read from the aircraft config, once available. */
  manifest?: FirmwareManifest;
}

export interface ParamEntry {
  /** Table index, when read by index. */
  index?: number;
  /** Parameter name, when known. */
  name?: string;
  /** Live value (0xE2), when read by index. */
  value?: number;
  /** Factory default (0xE1), for reference next to the live value. */
  default?: number;
  /** Value width in bytes, needed to write it back. */
  size?: number;
  /** Allowed range, when reported. */
  min?: number;
  max?: number;
  /** Type id the aircraft reports. */
  typeId?: number;
  /** Readable type name, e.g. "u16", "float". */
  typeName?: string;
  /** DJI name hash, as 0x-prefixed hex (by-hash reads only). */
  hashHex?: string;
  /** Raw value bytes, space-separated hex (by-hash reads only). */
  valueHex?: string;
  /** True when the flight controller returned a value. */
  ok: boolean;
  /** A note such as "no reply" when ok is false. */
  note?: string;
  /** Raw reply bytes, for diagnosing the format. */
  raw?: string;
}

export interface ParamScanResult {
  ok: boolean;
  /** Total parameter count the table reported, when available. */
  count?: number;
  /** Raw bytes of the table-info (0xE0) reply, for diagnosing the format. */
  tableRaw?: string;
  entries: ParamEntry[];
  error?: string;
}

export interface ParamProgress {
  phase: 'reading' | 'done';
  /** Parameters read so far. */
  done: number;
  /** Expected total, or 0 when the count is unknown. */
  total: number;
}

export interface ParamWriteResult {
  ok: boolean;
  message: string;
}

export interface ParamBackupFileResult {
  ok: boolean;
  /** Absolute path chosen, when ok. */
  path?: string;
  /** File text, on load. */
  text?: string;
  /** "cancelled" when the user dismissed the dialog, or an error message. */
  error?: string;
}

export interface PartitionBackupResult {
  ok: boolean;
  name: string;
  /** Pages that returned data. */
  pages: number;
  bytes: number;
  /** Where the image was written, when the user chose to save it. */
  savedPath?: string;
  message: string;
}

export interface FirmwareFileInfo {
  name: string;
  size: number;
}

export type FlashPhase =
  | 'idle'
  | 'ready'
  | 'entering'
  | 'preparing'
  | 'transferring'
  | 'finishing'
  | 'monitoring'
  | 'done'
  | 'failed';

export interface FlashState {
  phase: FlashPhase;
  /** Marketing name and factory code of the target, for display. */
  model?: string;
  modelCode?: string;
  /** Internal route name, e.g. "MAVIC3". */
  droneType?: string;
  /** Selected firmware package path. */
  packagePath?: string;
  files: FirmwareFileInfo[];
  totalSize: number;
  /** 1-based index of the file being transferred. */
  fileIndex?: number;
  currentFile?: string;
  /** 0–100 within the current file. */
  fileProgress?: number;
  /** 0–100 across all files. */
  overallProgress?: number;
  message: string;
  error?: string;
  /** Latest decoded upgrade-status report from the aircraft, once monitoring. */
  statusDetail?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** Result of a dry-run validation: no device writes were performed. */
export interface FlashValidation {
  ok: boolean;
  model?: string;
  modelCode?: string;
  droneType?: string;
  files: FirmwareFileInfo[];
  totalSize: number;
  /** Non-fatal cautions to show the operator. */
  warnings: string[];
  /** Why validation failed, when ok is false. */
  error?: string;
}

export interface DroneApi {
  getState(): Promise<DroneState>;
  /**
   * Runs a calibration. For the advanced routine, allowRestricted overrides the
   * firmware-only block so a model like the Mini 3 Pro can be tested.
   */
  calibrate(kind: CalibrationKind, allowRestricted?: boolean): Promise<void>;
  /** Starts the IMU calibration; progress arrives in the state's imuCalibration. */
  imuCalibrate(): Promise<void>;
  /** Stops a running IMU calibration and leaves factory mode. */
  imuCalibrateStop(): Promise<void>;
  /** Queries the battery once: pack data, live measurements, cells and serial. */
  readBattery(): Promise<BatteryReading>;
  /** Returns the latest flight-controller status the aircraft has pushed. */
  getTelemetry(): Promise<TelemetryReading>;
  onState(callback: (state: DroneState) => void): () => void;
  /** Opens a file dialog to choose a firmware package; returns its path. */
  pickFirmware(): Promise<string | undefined>;
  /** Dry-run: reads the package and plans the flash without touching the device. */
  validateFlash(packagePath: string): Promise<FlashValidation>;
  /** Begins the real flash. Progress arrives via onFlash. */
  startFlash(packagePath: string): Promise<void>;
  /** Requests the running flash stop at the next safe point. */
  cancelFlash(): Promise<void>;
  getFlashState(): Promise<FlashState>;
  onFlash(callback: (state: FlashState) => void): () => void;
  /** Runs a one-shot service command (factory mode, ESC repair, pairing, reads). */
  runService(action: ServiceAction): Promise<ServiceResult>;
  /** Reads one flight-controller parameter by name (hash addressing). */
  readParam(name: string): Promise<ParamEntry>;
  /** Reads the whole parameter table by index; progress arrives via onParamProgress. */
  readAllParams(): Promise<ParamScanResult>;
  /** Requests a running read-all stop. */
  cancelReadParams(): Promise<void>;
  /** Subscribes to read-all progress. */
  onParamProgress(callback: (progress: ParamProgress) => void): () => void;
  /** Writes a parameter (by index, with hash fallback) and verifies by read-back. */
  writeParam(
    name: string,
    index: number,
    value: number,
    size: number,
    typeId: number,
  ): Promise<ParamWriteResult>;
  /** Re-subscribes to HMS and collects faults for a few seconds. */
  readHms(): Promise<HmsReadResult>;
  /** Forgets the faults collected so far. */
  clearHms(): Promise<void>;
  /** Writes the given JSON to a file the user picks (parameter backup). */
  saveParamBackup(json: string): Promise<ParamBackupFileResult>;
  /** Opens a parameter-backup file the user picks and returns its text. */
  loadParamBackup(): Promise<ParamBackupFileResult>;
  /** Reads a partition by id and offers to save it. Read-only. */
  backupPartition(id: number): Promise<PartitionBackupResult>;
  /**
   * Gimbal motor test: moves to absolute angles over `seconds`. With an axis
   * only that axis moves; with null all three are driven.
   */
  gimbalTestMove(
    axis: GimbalAxis | null,
    target: GimbalAngles,
    seconds: number,
    allowUntested: boolean,
  ): Promise<MotorTestResult>;
  /** Gimbal motor test: jogs one axis at about `delta` degrees per second; 0 holds it. */
  gimbalTestJog(
    axis: GimbalAxis,
    delta: number,
    seconds: number,
    allowUntested: boolean,
  ): Promise<MotorTestResult>;
  /** Gimbal motor test: holds every axis where it is. */
  gimbalTestStop(): Promise<MotorTestResult>;
  /** Propeller motor test: spins the given motors (1–4) one after another. */
  propTestRun(
    motors: number[],
    percent: number,
    seconds: number,
    options: PropTestOptions,
  ): Promise<MotorTestResult>;
  /** Propeller motor test: stops the motors now. */
  propTestStop(): Promise<MotorTestResult>;
  /** Subscribes to per-motor progress of a running propeller test. */
  onPropTest(callback: (event: PropTestEvent) => void): () => void;
  /** Motor beep: switches one motor's beep on or off (motor is 1–4). */
  motorBeep(motor: number, on: boolean, allowUntested: boolean): Promise<MotorTestResult>;
  /** Motor beep: silences every motor. */
  motorBeepStop(): Promise<MotorTestResult>;
  /** Runs the gimbal IMU repair; progress arrives in the state's repair field. */
  repairGimbalImu(method: ImuRepairMethod): Promise<MotorTestResult>;
  /** Reads the serial number of every module that reports one. */
  readSerials(): Promise<SerialRow[]>;
  /** Writes a module's serial number in factory mode and reads it back. */
  writeSerial(component: SerialComponent, serial: string): Promise<SerialWriteResult>;
  /** Runs the full check. */
  runDiagnostics(): Promise<DiagnosticReport | null>;
  onDiagnosticProgress(callback: (progress: DiagnosticProgress) => void): () => void;
  /** Saves a full-check report as a text file the operator chooses. */
  saveReport(report: DiagnosticReport): Promise<ReportSaveResult>;
  /** Command console: sends one command and returns the answer, if any. */
  consoleSend(request: ConsoleRequest): Promise<ConsoleReply>;
  /** Command console: starts or stops forwarding received frames. */
  consoleWatch(on: boolean): Promise<void>;
  onConsoleFrames(callback: (frames: ConsoleFrame[]) => void): () => void;
  /**
   * Development only: one formatted line per packet received from the drone,
   * batched per USB read. Never fires in packaged builds.
   */
  onPackets(callback: (lines: string[]) => void): () => void;
}

export interface ChromeUiApi {
  /** Repaints the native window-control overlay for the given theme. */
  setTitleBarTheme(mode: 'light' | 'dark'): void;
}

// ── Remote controller (ADB) ──────────────────────────────────────────────────

export interface RcInfo {
  serial: string;
  state: string;
  model: string;
  android: string;
  sdk: string;
  firmware: string;
  battery: number;
  root: boolean;
}

export interface RcConnectResult {
  ok: boolean;
  info?: RcInfo;
  error?: string;
  serial?: string;
  state?: string;
}

export interface RcPackage {
  pkg: string;
  apkPath: string;
  system: boolean;
}

export interface RcCommandResult {
  ok: boolean;
  output: string;
  file?: string;
}

export interface RcRootResult {
  root: boolean;
  message: string;
}

export interface RcPullResult {
  pkg: string;
  ok: boolean;
  file?: string;
  split?: boolean;
  error?: string;
}

export interface RcPullProgress {
  pkg: string;
  index: number;
  total: number;
}

export type RcAppAction = 'launch' | 'force-stop' | 'enable' | 'disable' | 'clear';

export interface RcScreenResult {
  ok: boolean;
  /** The capture as a PNG data URL, when ok. */
  image?: string;
}

export interface RcApi {
  /** Captures the controller's screen once. */
  screen(serial: string): Promise<RcScreenResult>;
  /** Saves the most recent capture to a file the operator chooses. */
  screenSave(): Promise<RcCommandResult>;
  connect(): Promise<RcConnectResult>;
  info(serial: string): Promise<RcInfo>;
  packages(serial: string, thirdPartyOnly: boolean): Promise<RcPackage[]>;
  pickApk(): Promise<string[] | null>;
  install(serial: string, apkPath: string, grantPerms: boolean, downgrade: boolean): Promise<RcCommandResult>;
  uninstall(serial: string, pkg: string): Promise<RcCommandResult>;
  setHome(serial: string, component: string): Promise<RcCommandResult>;
  launchers(serial: string): Promise<string[]>;
  shell(serial: string, command: string): Promise<RcCommandResult>;
  appAction(serial: string, pkg: string, action: RcAppAction): Promise<RcCommandResult>;
  root(serial: string): Promise<RcRootResult>;
  disconnect(): Promise<{ ok: boolean }>;
  pickFolder(): Promise<string | null>;
  pullApks(serial: string, pkgs: string[], outDir: string): Promise<RcPullResult[]>;
  ls(serial: string, dir: string): Promise<RcCommandResult>;
  pull(serial: string, remote: string): Promise<RcCommandResult>;
  push(serial: string, remoteDir: string): Promise<RcCommandResult>;
  settingsGet(serial: string, ns: string, key: string): Promise<RcCommandResult>;
  settingsPut(serial: string, ns: string, key: string, value: string): Promise<RcCommandResult>;
  onPullProgress(callback: (progress: RcPullProgress) => void): () => void;
}

// ── Partition image explorer ─────────────────────────────────────────────────

import type {
  ImageExtractProgress,
  ImageExtractResult,
  ImageListResult,
  ImageMountResult,
  ImageOpenResult,
  ImagePreview,
} from './imageExplorer';

export type { FsEntry, FsStats, PartitionCandidate } from './ext4';
export type {
  ImageExtractProgress,
  ImageExtractResult,
  ImageListResult,
  ImageMountResult,
  ImageOpenResult,
  ImagePreview,
} from './imageExplorer';

// ── Drone files (USB FTP) ────────────────────────────────────────────────────

import type {
  FtpConnectResult,
  FtpDownloadProgress,
  FtpDownloadResult,
  FtpListResult,
} from './droneFtp';

export type { FtpConnectResult, FtpDownloadProgress, FtpDownloadResult, FtpEntry, FtpListResult } from './droneFtp';

export interface DroneFsApi {
  /** Connects to the drone's USB FTP and signs in; tries the known logins when none is given. */
  connect(options?: { host?: string; user?: string; password?: string }): Promise<FtpConnectResult>;
  list(dir: string): Promise<FtpListResult>;
  /** Downloads one file to a path the operator chooses. */
  download(dir: string, name: string): Promise<FtpDownloadResult>;
  disconnect(): Promise<void>;
  onProgress(callback: (progress: FtpDownloadProgress) => void): () => void;
}

// ── Fastboot explorer ────────────────────────────────────────────────────────

import type {
  FastbootActionResult,
  FastbootFlashProgress,
  FastbootScanResult,
} from './fastbootService';

export type { FastbootActionResult, FastbootFlashProgress, FastbootScanResult } from './fastbootService';

export interface FastbootApi {
  /** Finds a device in fastboot and reads its variables. */
  scan(): Promise<FastbootScanResult>;
  /**
   * Starts or stops polling for a device that appears in fastboot, catching the
   * brief boot-time recovery window and holding it. The result arrives via
   * onFound; onWatchStopped fires if it gives up.
   */
  watch(on: boolean): Promise<FastbootActionResult>;
  onFound(callback: (result: FastbootScanResult) => void): () => void;
  onWatchStopped(callback: (info: { reason: string }) => void): () => void;
  /** reboot | reboot-bootloader | reboot-fastboot | continue. */
  reboot(target: string): Promise<FastbootActionResult>;
  /** Erases a partition (destructive). */
  erase(partition: string): Promise<FastbootActionResult>;
  /** Picks an image and writes it to a partition (destructive). */
  flash(partition: string): Promise<FastbootActionResult>;
  disconnect(): Promise<void>;
  onFlashProgress(callback: (progress: FastbootFlashProgress) => void): () => void;
}

export interface ImageToolApi {
  /** Asks for an image file and returns the partitions found in it. */
  open(): Promise<ImageOpenResult>;
  /** Opens the ext filesystem at a partition's byte offset. */
  mount(offset: number): Promise<ImageMountResult>;
  list(folder: string): Promise<ImageListResult>;
  preview(file: string): Promise<ImagePreview>;
  /** Copies a file, or a folder and everything in it, out of the image. */
  extract(remote: string): Promise<ImageExtractResult>;
  close(): Promise<void>;
  onProgress(callback: (progress: ImageExtractProgress) => void): () => void;
}

declare global {
  interface Window {
    drone: DroneApi;
    rc: RcApi;
    imageTool: ImageToolApi;
    droneFs: DroneFsApi;
    fastboot: FastbootApi;
    chromeUi?: ChromeUiApi;
  }
}
