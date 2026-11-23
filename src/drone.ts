/**
 * Main-process drone session: finds and connects to a DJI product on its
 * own, reads module versions as soon as it is connected, and runs the gimbal
 * calibration routines.
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import {
  AckType,
  CmdSet,
  describePacket,
  DevType,
  encodePacket,
  moduleInfo,
  PacketParser,
  toHex,
  type Packet,
} from './duml';
import { BulkTransport, connectBulk } from './usb0';
import { matchModelCode, type DroneModel } from './models';
import {
  blockSizeFromReply,
  dataStep,
  decodeUpgradeStatus,
  enterStep,
  fileOpenStep,
  finishStep,
  flashRouteForCode,
  md5Step,
  prepareStep,
  readFirmwarePackage,
  type DumlStep,
  type FirmwareFile,
  type FlashRoute,
} from './flasher';
import {
  decodeGimbalSelfCheck,
  decodeGnssStatus,
  decodeHmsPush,
  decodeHmsTelemetry,
  makeHmsResolver,
  FC_SENDER_TYPE,
  FC_STATUS_CMD_ID,
  FC_STATUS_CMD_SET,
  GIMBAL_SELFCHECK_CMD_ID,
  GIMBAL_SELFCHECK_CMD_SET,
  GIMBAL_SENDER_TYPE,
  HMS_CMD_SET,
  HMS_CMD_ID,
  HMS_TELEMETRY_CMD_SET,
  HMS_TELEMETRY_CMD_ID,
  type HmsFault,
} from './hms';
import {
  VISION_SENSORS,
  cameraSerialSteps,
  isReadService,
  linkTestSteps,
  serialFromReply,
  serviceCleanupSteps,
  serviceSteps,
  visionCalSteps,
  visionSensorOf,
  visionSensorSerial,
  visionSensorStep,
  type ServiceAction,
} from './service';
import { parseConfig } from './config';
import {
  decodeParamValue,
  djiParamHash,
  encodeParamValue,
  paramInfoByIndexStep,
  paramReadByHashStep,
  paramReadByIndexStep,
  paramTableInfoStep,
  paramWriteByIndexStep,
  paramWriteUnlockStep,
  parseParamInfo,
  parseParamTableInfo,
  parseParamValueByHash,
  parseParamValueByIndex,
} from './params';
import { partitionById, partitionPageStep } from './partition';
import { entersFactoryMode, planAdvancedCalibration, type AdvancedCalibrationPlan } from './gimbalCal';
import { IMU_POSITIONS, parseImuProgress, planImuCalibration, type ImuCalibrationPlan } from './imuCal';
import {
  BATTERY_CMD_SERIAL,
  BATTERY_CMD_SET,
  BATTERY_CMD_STATIC,
  BATTERY_SENDER_TYPE,
  applyBatteryReply,
  batteryRequestSteps,
  type BatterySnapshot,
} from './battery';
import { decodeFcStatus } from './telemetry';
import {
  REPAIR_STEP_MS,
  SERIAL_FACTORY_SETTLE_MS,
  SERIAL_TARGETS,
  planImuRepair,
  repairDurationMs,
  serialFactorySteps,
  serialProblem,
  serialReadStep,
  serialTarget,
  serialWriteStep,
  type ImuRepairMethod,
  type SerialComponent,
} from './repair';
import {
  DIAGNOSTIC_STAGES,
  batteryChecks,
  faultChecks,
  formatDiagnosticReport,
  reportFileStamp,
  type DiagnosticCheck,
  type DiagnosticProgress,
  type DiagnosticReport,
} from './diagnostics';
import {
  CONSOLE_FRAME_BYTES,
  CONSOLE_KEEP_FRAMES,
  CONSOLE_REPLY_WAIT_MS,
  consoleRequestProblem,
  hexBytes,
  type ConsoleFrame,
  type ConsoleReply,
  type ConsoleRequest,
} from './consoleCmd';
import {
  GIMBAL_AXES,
  GIMBAL_JOG_RATE,
  PROP_DEFAULT_OUTPUT,
  PROP_DEFAULT_TIMER,
  PROP_FACTORY_SETTLE_MS,
  PROP_GAP_MS,
  PROP_MAX_PERCENT,
  PROP_MAX_SECONDS,
  PROP_MOTORS,
  PROP_PARAM_OUTPUT,
  PROP_PARAM_TIMER,
  PROP_TICK_MS,
  PROP_WATCHDOG_MS,
  beepStep,
  beepSupport,
  gimbalAbsoluteStep,
  gimbalEnableStep,
  gimbalRelativeStep,
  gimbalTestSupport,
  propCatalogExpected,
  propCatalogName,
  propCatalogStep,
  propFactorySteps,
  propRunStep,
  propTestSupport,
  propThrottleHash,
  propThrottleValue,
  propWriteAccepted,
  propWriteStep,
  type GimbalAngles,
  type GimbalAxis,
  type GimbalLimits,
  type PropMotor,
} from './motorTest';
import type {
  BatteryReading,
  CalibrationKind,
  CalibrationState,
  DroneState,
  FirmwareFileInfo,
  FlashState,
  FlashValidation,
  HmsReadResult,
  ImuCalibrationState,
  ModuleVersion,
  MotorTestResult,
  ParamBackupFileResult,
  ParamEntry,
  ParamProgress,
  ParamScanResult,
  ParamWriteResult,
  PartitionBackupResult,
  PropTestEvent,
  PropTestOptions,
  RepairState,
  ReportSaveResult,
  SerialRow,
  SerialWriteResult,
  ServiceResult,
  TelemetryReading,
} from './types';

const CMD_GENERAL_GET_SERIAL = 0x51;
const CMD_GENERAL_GET_CONFIG = 0x4f;
/** Modules that may serve the config file, tried in order. */
const CONFIG_RECEIVERS = [0x48, 0x4f, 0x01, 0x28];

/** Friendly name for a DUML receiver address, for service result details. */
function receiverLabel(receiver: number): string {
  const names: Record<number, string> = {
    0x01: 'Camera',
    0x03: 'Flight controller',
    0x04: 'Gimbal',
    0x08: 'Battery',
    0x0b: 'Battery',
    0x09: 'Remote link',
    0x11: 'Monocular vision',
    0x12: 'Binocular vision',
    0xc3: 'Radio',
  };
  return names[receiver] ?? `Module 0x${receiver.toString(16).padStart(2, '0')}`;
}

const CONNECT_INTERVAL_MS = 1500;
const SCAN_SPACING_MS = 15;
const SCAN_WAIT_MS = 1500;
const SCAN_RETRY_MS = 3000;
const CALIB_ACK_TIMEOUT_MS = 1000;
const CALIB_ACK_RETRIES = 3;

const CMD_UPGRADE_STATUS = 0x42;
// HMS subscription, replicated from a USB capture of the reference tool: a
// query (0x21/0x11, empty) then an enable (0x21/0x05, payload 0x01) sent to
// five modules. After both phases the flight controller pushes 0x21/0x06.
const HMS_SUBSCRIBE_CMD_ID = 0x11;
const HMS_ENABLE_CMD_ID = 0x05;
const HMS_TARGETS = [0x12, 0xc3, 0x01, 0x04, 0x02];
const FLASH_ENTER_TIMEOUT_MS = 1200;
const FLASH_STEP_TIMEOUT_MS = 10000;
/** How long to listen for upgrade-status reports after the commit step. */
const FLASH_MONITOR_MS = 240000;

const CMD_GENERAL_VERSION_INQUIRY = 0x01;
const CMD_GIMBAL_CALIBRATION = 0x08;
const CMD_GIMBAL_CALIBRATION_PROGRESS = 0x30;

const PC = moduleInfo(DevType.PC, 0);
const GIMBAL = moduleInfo(DevType.GIMBAL, 0);

/**
 * Raw DUML addresses (type | index << 5) the reference tool probes with a GENERAL
 * VersionInquiry (cmd 0x01) to identify the aircraft. The first module that
 * answers with a recognisable factory code wins.
 */
const MODEL_PROBE_RECEIVERS = [0x00, 0x28, 0x1f, 0x01, 0x2d, 0xa2];
const MODEL_PROBE_TIMEOUT_MS = 500;

interface ScanTarget {
  type: number;
  index: number;
  name: string;
}

const SCAN_TARGETS: ScanTarget[] = [
  { type: DevType.FLYCONTROLLER, index: 0, name: 'Flight controller' },
  { type: DevType.CAMERA, index: 0, name: 'Camera' },
  { type: DevType.GIMBAL, index: 0, name: 'Gimbal' },
  { type: DevType.CENTER_BOARD, index: 0, name: 'Center board' },
  { type: DevType.BATTERY, index: 0, name: 'Battery' },
  { type: DevType.ESC, index: 0, name: 'ESC 1' },
  { type: DevType.ESC, index: 1, name: 'ESC 2' },
  { type: DevType.ESC, index: 2, name: 'ESC 3' },
  { type: DevType.ESC, index: 3, name: 'ESC 4' },
  { type: DevType.REMOTE_RADIO, index: 0, name: 'Remote radio' },
  { type: DevType.WIFI, index: 0, name: 'Wi-Fi' },
  { type: DevType.LB_DM3XX_SKY, index: 0, name: 'Video encoder (DM3xx)' },
  { type: DevType.LB_MCU_SKY, index: 0, name: 'Lightbridge MCU' },
  { type: DevType.DM368_GROUND, index: 0, name: 'DM368 ground' },
  { type: DevType.OFDM_GROUND, index: 0, name: 'OFDM ground' },
  { type: DevType.LB_68013_SKY, index: 0, name: 'Lightbridge 68013' },
  { type: DevType.SER_68013_GROUND, index: 0, name: '68013 ground' },
  { type: DevType.MVO, index: 0, name: 'Vision (MVO)' },
  { type: DevType.SVO, index: 0, name: 'Vision (SVO)' },
  { type: DevType.LB_FPGA_SKY, index: 0, name: 'Lightbridge FPGA' },
  { type: DevType.FPGA_GROUND, index: 0, name: 'FPGA ground' },
  { type: DevType.STATION, index: 0, name: 'Station' },
  { type: DevType.XU, index: 0, name: 'XU' },
  { type: DevType.WTF, index: 0, name: 'Module 24' },
  { type: DevType.IMU, index: 0, name: 'IMU' },
  { type: DevType.GPS, index: 0, name: 'GPS' },
  { type: DevType.WIFI_GROUND, index: 0, name: 'Wi-Fi ground' },
  { type: DevType.SIG_CVT, index: 0, name: 'Signal converter' },
  { type: DevType.PMU, index: 0, name: 'PMU' },
];

interface CalibrationSpec {
  command: number;
  title: string;
  expectMs: number;
  /** Give up monitoring after this long. */
  maxMs: number;
  /** Give up monitoring when no report arrives for this long. */
  stallMs: number;
  /** Concluding status pair of the older (cmd 0x08) report format. */
  pass: [number, number];
}

const CALIBRATIONS: Record<Exclude<CalibrationKind, 'advanced'>, CalibrationSpec> = {
  jointCoarse: {
    command: 1,
    title: 'Joint Coarse',
    expectMs: 15000,
    maxMs: 22500,
    stallMs: 3750,
    pass: [16, 1],
  },
  linearHall: {
    command: 2,
    title: 'Linear Hall',
    expectMs: 200000,
    maxMs: 300000,
    stallMs: 50000,
    pass: [40, 1],
  },
};

/**
 * Development aid: every packet the parser accepts is printed in the
 * DevTools console. Off in packaged builds.
 */
const TRACE_PACKETS = !app.isPackaged;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function formatVersion(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    .map((part) => part.toString().padStart(2, '0'))
    .join('.');
}

/** Decodes a General/VersionInquiry (cmd 0x01) reply payload. */
function parseVersionReply(name: string, payload: Uint8Array): ModuleVersion | null {
  if (payload.length < 18) {
    return null;
  }
  const data = Buffer.from(payload);
  const hardwareBytes = data.subarray(2, 18);
  const end = hardwareBytes.indexOf(0);
  const hardware = hardwareBytes
    .toString('latin1', 0, end < 0 ? hardwareBytes.length : end)
    .trim();
  return {
    name,
    hardware: hardware || '—',
    loader: data.length >= 22 ? formatVersion(data.readUInt32LE(18)) : '—',
    firmware: data.length >= 26 ? formatVersion(data.readUInt32LE(22)) : '—',
  };
}

class DroneSession {
  private state: DroneState = { status: 'searching', scanning: false, modules: [] };
  private transport: BulkTransport | null = null;
  private readonly parser = new PacketParser();
  private readonly listeners = new Set<(packet: Packet) => void>();
  private seqNum = Math.floor(Date.now() / 10) & 0xffff;
  private timer: NodeJS.Timeout | null = null;
  private calibrating = false;
  /** Set when the operator asks a running IMU calibration to stop. */
  private imuStopRequested = false;
  /** Latest flight-controller status push on this connection, undecoded. */
  private fcStatusFrame: { payload: Uint8Array; at: number } | null = null;
  /** True while a battery read is collecting replies. */
  private batteryReading = false;
  /** The identified aircraft, once its factory code has been recognised. */
  private activeModel: DroneModel | null = null;
  private flashState: FlashState = { phase: 'idle', files: [], totalSize: 0, message: '' };
  private flashing = false;
  private flashCancelled = false;
  /** Removes the current connection's persistent HMS listener. */
  private hmsUnsubscribe: (() => void) | null = null;
  private hmsResolver: ((code: number) => string | undefined) | null = null;
  /** Set once an HMS push or telemetry fault has been seen on this connection. */
  private hmsReceived = false;
  /**
   * Set only once the 0x21/0x06 snapshot (the full fault list) has arrived. The
   * always-on 0x03/0xCE telemetry must NOT satisfy this, or it would short-
   * circuit subscribeHms before the enable that triggers the snapshot is sent.
   */
  private hmsSnapshotReceived = false;
  /**
   * Faults accumulated this connection, keyed by codeHex + ":" + sensor. Both
   * the 0x21/0x06 snapshot and the always-on 0x03/0xCE telemetry stream (one
   * record per frame) upsert here, so codes are collected over time rather than
   * each push replacing the list.
   */
  private hmsRecords = new Map<string, HmsFault>();
  /**
   * Conditions derived from live status pushes (gimbal self-check, GNSS), keyed
   * by source. Unlike hmsRecords these are replaced on every status frame.
   */
  private hmsLive = new Map<string, HmsFault[]>();
  /** Address of the module serving the config file, once found. */
  private configReceiver: number | null = null;
  /** Set once the gimbal has been told to accept test angle commands. */
  private gimbalTestEnabled = false;
  /** Answers the gimbal has sent to test commands on this connection. */
  private gimbalTestAcks = 0;
  private gimbalTestUnsubscribe: (() => void) | null = null;
  private propTesting = false;
  /** Motors (1–4) whose beep is on. */
  private readonly beeping = new Set<number>();
  /** True while the motor beep holds factory mode open. */
  private beepFactoryOpen = false;
  private diagnosing = false;
  private consoleUnsubscribe: (() => void) | null = null;
  private consoleTimer: NodeJS.Timeout | null = null;
  private consoleBuffer: ConsoleFrame[] = [];
  private propStopRequested = false;
  /** True while the aircraft is in the factory mode the propeller test opened. */
  private propFactoryOpen = false;
  /** Set once a propeller test has written to this aircraft, so Stop has something to undo. */
  private propTestTouched = false;

  start(): void {
    ipcMain.handle('drone:getState', () => this.state);
    ipcMain.handle('drone:calibrate', (_event, kind: CalibrationKind, allowRestricted?: boolean) => {
      if (kind !== 'advanced' && !(kind in CALIBRATIONS)) {
        throw new Error(`Unknown calibration: ${String(kind)}`);
      }
      if (!this.transport) {
        throw new Error('No drone connected.');
      }
      if (this.calibrating) {
        throw new Error('A calibration is already running.');
      }
      if (kind === 'advanced') {
        if (this.flashing) {
          throw new Error('A firmware flash is in progress.');
        }
        const choice = planAdvancedCalibration(this.state.modelCode, this.state.model, allowRestricted === true);
        if (!choice.plan) {
          throw new Error(choice.reason ?? 'Advanced calibration is not available for this aircraft.');
        }
        void this.runAdvancedCalibration(this.transport, choice.plan);
        return;
      }
      void this.runCalibration(this.transport, kind);
    });
    ipcMain.handle('imu:calibrate', () => {
      if (!this.transport) {
        throw new Error('No drone connected.');
      }
      if (this.calibrating) {
        throw new Error('A calibration is already running.');
      }
      if (this.flashing) {
        throw new Error('A firmware flash is in progress.');
      }
      if (this.propTesting) {
        throw new Error('A motor test is running.');
      }
      const choice = planImuCalibration(this.state.modelCode, this.state.model);
      if (!choice.plan) {
        throw new Error(choice.reason ?? 'IMU calibration is not available for this aircraft.');
      }
      void this.runImuCalibration(this.transport, choice.plan);
    });
    ipcMain.handle('battery:read', () => this.readBattery());
    ipcMain.handle('telemetry:get', (): TelemetryReading => {
      const frame = this.fcStatusFrame;
      const status = frame ? decodeFcStatus(frame.payload) : null;
      return status && frame ? { status, at: frame.at } : {};
    });
    ipcMain.handle('imu:stop', () => {
      if (this.state.imuCalibration?.phase === 'running') {
        this.imuStopRequested = true;
      }
    });
    ipcMain.handle('flash:getState', () => this.flashState);
    ipcMain.handle('flash:pick', () => this.pickFirmware());
    ipcMain.handle('flash:validate', (_event, packagePath: string) =>
      this.validateFlash(packagePath),
    );
    ipcMain.handle('flash:start', (_event, packagePath: string) => {
      if (this.flashing) {
        throw new Error('A flash is already running.');
      }
      void this.runFlash(packagePath);
    });
    ipcMain.handle('flash:cancel', () => {
      this.flashCancelled = true;
    });
    ipcMain.handle('service:run', (_event, action: ServiceAction) => this.runService(action));
    ipcMain.handle('param:read', (_event, name: string) => this.readParam(name));
    ipcMain.handle('param:readAll', () => this.readAllParams());
    ipcMain.handle('param:cancelRead', () => this.cancelReadParams());
    ipcMain.handle(
      'param:write',
      (_event, name: string, index: number, value: number, size: number, typeId: number) =>
        this.writeParam(name, index, value, size, typeId),
    );
    ipcMain.handle('partition:backup', (_event, id: number) => this.backupPartition(id));
    ipcMain.handle('hms:read', () => this.readHmsNow());
    ipcMain.handle('hms:clear', () => this.clearHms());
    ipcMain.handle('param:saveBackup', (_event, json: string) => this.saveParamBackup(json));
    ipcMain.handle('param:loadBackup', () => this.loadParamBackup());
    ipcMain.handle(
      'motor:gimbalMove',
      (_event, axis: GimbalAxis | null, target: GimbalAngles, seconds: number, allowUntested: boolean) =>
        this.gimbalTestMove(axis, target, seconds, allowUntested === true),
    );
    ipcMain.handle(
      'motor:gimbalJog',
      (_event, axis: GimbalAxis, delta: number, seconds: number, allowUntested: boolean) =>
        this.gimbalTestJog(axis, delta, seconds, allowUntested === true),
    );
    ipcMain.handle('motor:gimbalStop', () => this.gimbalTestStop());
    ipcMain.handle(
      'motor:propRun',
      (_event, motors: number[], percent: number, seconds: number, options: PropTestOptions) =>
        this.runPropTest(motors, percent, seconds, options),
    );
    ipcMain.handle('motor:propStop', () => this.stopPropTest());
    ipcMain.handle('motor:beep', (_event, motor: number, on: boolean, allowUntested: boolean) =>
      this.motorBeep(motor, on === true, allowUntested === true),
    );
    ipcMain.handle('motor:beepStop', () => this.motorBeepStop());
    ipcMain.handle('repair:gimbalImu', (_event, method: ImuRepairMethod) => this.repairGimbalImu(method));
    ipcMain.handle('serial:readAll', () => this.readSerials());
    ipcMain.handle('serial:write', (_event, component: SerialComponent, serial: string) =>
      this.writeSerial(component, serial),
    );
    ipcMain.handle('diag:run', () => this.runDiagnostics());
    ipcMain.handle('diag:saveReport', (_event, report: DiagnosticReport) => this.saveReport(report));
    ipcMain.handle('console:send', (_event, request: ConsoleRequest) => this.consoleSend(request));
    ipcMain.handle('console:watch', (_event, on: boolean) => this.consoleWatch(on === true));
    this.timer = setInterval(() => this.tryConnect(), CONNECT_INTERVAL_MS);
    this.tryConnect();
  }

  private async pickFirmware(): Promise<string | undefined> {
    const window = BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Select firmware package',
      filters: [
        { name: 'Firmware package', extensions: ['bin', 'tar', 'gz', 'tgz', 'zip'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile' as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  }

  /** Loads the bundled HMS fault database once and returns a code→text resolver. */
  private ensureHmsResolver(): (code: number) => string | undefined {
    if (!this.hmsResolver) {
      try {
        const file = app.isPackaged
          ? path.join(process.resourcesPath, 'hms.json')
          : path.join(app.getAppPath(), 'resources', 'hms.json');
        const db = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { en?: string }>;
        this.hmsResolver = makeHmsResolver(db);
      } catch {
        this.hmsResolver = () => undefined;
      }
    }
    return this.hmsResolver;
  }

  /**
   * Listens for HMS fault pushes (cmd set 0x21 / id 0x06) for the life of the
   * connection and records them in the state. Also nudges the aircraft to
   * start pushing; on many models the pushes are automatic. Read-only.
   */
  private startHmsListener(): void {
    const resolve = this.ensureHmsResolver();
    this.hmsReceived = false;
    this.hmsSnapshotReceived = false;
    this.hmsRecords.clear();
    this.hmsLive.clear();
    this.hmsUnsubscribe = this.subscribe((packet) => {
      let changed = false;
      if (packet.cmdSet === HMS_CMD_SET && packet.cmdId === HMS_CMD_ID) {
        // Binary HMS snapshot: a whole list of records in one push.
        this.hmsSnapshotReceived = true;
        for (const fault of decodeHmsPush(packet.payload, resolve)) {
          changed = this.upsertHmsRecord(fault) || changed;
        }
      } else if (packet.cmdSet === HMS_TELEMETRY_CMD_SET && packet.cmdId === HMS_TELEMETRY_CMD_ID) {
        const fault = decodeHmsTelemetry(packet.payload, resolve);
        if (fault) {
          changed = this.upsertHmsRecord(fault) || changed;
        }
      } else if (
        packet.cmdSet === GIMBAL_SELFCHECK_CMD_SET &&
        packet.cmdId === GIMBAL_SELFCHECK_CMD_ID &&
        packet.senderType === GIMBAL_SENDER_TYPE
      ) {
        // Live gimbal self-check bitmask (bit 7 = error 40021).
        changed = this.setHmsLive('gimbal', decodeGimbalSelfCheck(packet.payload));
      } else if (
        packet.cmdSet === FC_STATUS_CMD_SET &&
        packet.cmdId === FC_STATUS_CMD_ID &&
        packet.senderType === FC_SENDER_TYPE
      ) {
        // Kept for the telemetry page, which decodes it on request.
        this.fcStatusFrame = { payload: Uint8Array.from(packet.payload), at: Date.now() };
        // Live GNSS quality from the flight-controller status push.
        const gnss = decodeGnssStatus(packet.payload);
        changed = this.setHmsLive('gnss', gnss ? [gnss] : []);
      } else {
        return;
      }
      if (changed) {
        this.hmsReceived = true;
        this.publishHms();
      }
    });
  }

  /** Current faults: collected HMS records first, then the live conditions. */
  private hmsFaults(): HmsFault[] {
    const live = [...this.hmsLive.values()].flat();
    return [...this.hmsRecords.values(), ...live];
  }

  private publishHms(): void {
    this.setState({ hms: { faults: this.hmsFaults(), updatedAt: Date.now() } });
  }

  /**
   * Replaces one live source's rows (they follow the status frames, so a
   * condition that clears disappears). Returns true only if the rows changed,
   * so the steady stream of identical status frames does not republish.
   */
  private setHmsLive(source: string, faults: HmsFault[]): boolean {
    const signature = (list: HmsFault[]): string => list.map((f) => `${f.codeHex}|${f.text}`).join('\n');
    const previous = this.hmsLive.get(source) ?? [];
    if (signature(previous) === signature(faults)) {
      return false;
    }
    if (faults.length === 0) {
      this.hmsLive.delete(source);
    } else {
      this.hmsLive.set(source, faults);
    }
    return true;
  }

  /** Adds or refreshes one fault record; returns true if it was newly added. */
  private upsertHmsRecord(fault: HmsFault): boolean {
    const key = `${fault.codeHex}:${fault.sensorIndex}`;
    const existing = this.hmsRecords.get(key);
    if (existing) {
      existing.level = fault.level;
      return false;
    }
    this.hmsRecords.set(key, fault);
    return true;
  }

  /**
   * Nudges the aircraft to report HMS: a query (0x21/0x11) then an enable
   * (0x21/0x05) to the reporting modules plus the 0xFD broadcast, after an FC
   * status kick (0x00/0x52). Most of the live
   * faults actually arrive on the always-on 0x03/0xCE telemetry stream, which
   * needs no subscription — this just also lights up the 0x21/0x06 snapshot
   * path. Retries a few times until something arrives.
   */
  private async subscribeHms(transport: BulkTransport): Promise<void> {
    const send = (receiver: number, cmdSet: number, cmdId: number, payload: Uint8Array): Promise<Uint8Array | null> =>
      this.flashSendStep(
        transport,
        { sender: 0x2a, receiver, ackEnc: 0x40, cmdSet, cmdId, payload, expectReply: true },
        600,
      ).catch((): null => null);

    // 0xFD is the broadcast address; the FC kick wakes the status reporting.
    const enableTargets = [...HMS_TARGETS, 0xfd];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Gate on the SNAPSHOT, not on hmsReceived — the always-on 0x03/0xCE
      // telemetry sets hmsReceived instantly, which would skip the enable and
      // leave us with only the telemetry trickle instead of the full snapshot.
      if (this.transport !== transport || this.hmsSnapshotReceived) {
        return;
      }
      await send(0x02, 0x00, 0x52, new Uint8Array(0));
      for (const receiver of HMS_TARGETS) {
        if (this.transport !== transport) return;
        await send(receiver, HMS_CMD_SET, HMS_SUBSCRIBE_CMD_ID, new Uint8Array(0));
      }
      for (const receiver of enableTargets) {
        if (this.transport !== transport) return;
        await send(receiver, HMS_CMD_SET, HMS_ENABLE_CMD_ID, Uint8Array.of(0x01));
      }
      // Give the aircraft time to begin pushing the snapshot before retrying.
      for (let waited = 0; waited < 3000 && !this.hmsSnapshotReceived; waited += 300) {
        await sleep(300);
      }
    }
  }

  /**
   * On-demand HMS read (the "Read HMS" button): always sends the full
   * kick → query → enable burst, then collects for a few seconds while the
   * listener accumulates snapshot and telemetry records. Nothing is written to
   * the aircraft beyond the push-enable flag.
   */
  private async readHmsNow(): Promise<HmsReadResult> {
    const transport = this.transport;
    if (!transport) {
      return { ok: false, count: this.hmsRecords.size, message: 'No aircraft connected.' };
    }
    if (this.flashing) {
      return { ok: false, count: this.hmsRecords.size, message: 'A firmware flash is in progress.' };
    }
    const send = (receiver: number, cmdSet: number, cmdId: number, payload: Uint8Array): Promise<Uint8Array | null> =>
      this.flashSendStep(
        transport,
        { sender: 0x2a, receiver, ackEnc: 0x40, cmdSet, cmdId, payload, expectReply: true },
        600,
      ).catch((): null => null);

    const before = this.hmsRecords.size;
    await send(0x02, 0x00, 0x52, new Uint8Array(0));
    for (const receiver of HMS_TARGETS) {
      if (this.transport !== transport) break;
      await send(receiver, HMS_CMD_SET, HMS_SUBSCRIBE_CMD_ID, new Uint8Array(0));
    }
    for (const receiver of [...HMS_TARGETS, 0xfd]) {
      if (this.transport !== transport) break;
      await send(receiver, HMS_CMD_SET, HMS_ENABLE_CMD_ID, Uint8Array.of(0x01));
    }
    for (let waited = 0; waited < 3500 && this.transport === transport; waited += 250) {
      await sleep(250);
    }
    // Publish even when nothing new arrived, so the panel leaves "Listening"
    // and shows a fresh timestamp.
    this.publishHms();
    const stored = this.hmsRecords.size;
    const live = this.hmsFaults().length - stored;
    return {
      ok: true,
      count: stored + live,
      message: `${stored} stored (${stored - before} new this read), ${live} live.`,
    };
  }

  /**
   * Forgets the stored records collected so far (the "Clear" button). Live
   * conditions stay, since they reflect what the aircraft is reporting now.
   */
  private clearHms(): void {
    this.hmsRecords.clear();
    this.hmsSnapshotReceived = false;
    if (this.transport) {
      this.publishHms();
    }
  }

  /** Runs a one-shot service command (factory mode, ESC, pairing, reads). */
  private async runService(action: ServiceAction): Promise<ServiceResult> {
    const transport = this.transport;
    if (!transport) {
      return { action, ok: false, message: 'No aircraft connected.' };
    }
    if (this.flashing) {
      return { action, ok: false, message: 'A firmware flash is in progress.' };
    }
    const steps = serviceSteps(action);
    if (steps.length === 0) {
      return { action, ok: false, message: 'Unknown service action.' };
    }
    const details: string[] = [];
    const serials: string[] = [];
    let replies = 0;
    try {
      for (const serviceStep of steps) {
        const reply = await this.flashSendStep(transport, serviceStep, 1500);
        const name = receiverLabel(serviceStep.receiver);
        if (serviceStep.waitAfterMs) {
          await sleep(serviceStep.waitAfterMs);
        }
        if (action === 'vision-recover') {
          if (serviceStep.cmdSet === 0x24 && serviceStep.cmdId === 0x26) {
            const sensor =
              VISION_SENSORS.find((entry) => entry.mask === visionSensorOf(serviceStep))?.name ?? 'Sensor';
            const serial = reply ? visionSensorSerial(reply) : undefined;
            if (serial) {
              serials.push(serial);
            }
            details.push(`${sensor}: ${serial ?? (reply ? 'no serial reported' : 'no reply')}`);
          } else if (serviceStep.cmdSet === 0x24 && reply) {
            replies += 1;
          }
          continue;
        }
        if (reply) {
          replies += 1;
          if (action === 'camera-serials' || action === 'vision-scan' || action === 'camera-info') {
            const sn = serialFromReply(reply);
            if (sn) {
              serials.push(sn);
              details.push(`${name}: ${sn}`);
            } else {
              details.push(`${name}: responded (${reply.length} bytes)`);
            }
          } else if (action === 'vision-cal') {
            const code = reply[0] ?? 0xff;
            details.push(`${name}: ${code === 0 ? 'calibrated' : `not calibrated (code 0x${code.toString(16)})`}`);
          } else if (isReadService(action)) {
            const hex = toHex(reply.subarray(0, 32));
            details.push(`${name}: ${reply.length} bytes${hex ? ` [${hex}]` : ''}`);
          } else {
            details.push(`${name}: acknowledged`);
          }
        } else {
          details.push(`${name}: no reply`);
        }
      }
    } catch (err) {
      return {
        action,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        details,
      };
    } finally {
      for (const cleanup of serviceCleanupSteps(action)) {
        await this.flashWrite(transport, cleanup).catch((): void => undefined);
      }
    }
    return this.interpretService(action, replies, serials, details);
  }

  private interpretService(
    action: ServiceAction,
    replies: number,
    serials: string[],
    details: string[],
  ): ServiceResult {
    const acked = replies > 0;
    switch (action) {
      case 'factory-enter':
        return { action, ok: acked, details, message: acked ? 'Factory mode entered.' : 'No module acknowledged factory mode.' };
      case 'factory-exit':
        return { action, ok: acked, details, message: acked ? 'Factory mode exited.' : 'No module acknowledged the exit.' };
      case 'esc-repair':
        return {
          action,
          ok: acked,
          details,
          message: acked
            ? 'ESC repair command accepted. Restart the aircraft, then recheck the fault codes.'
            : 'The flight controller did not acknowledge the command.',
        };
      case 'rc-pair':
        return {
          action,
          ok: acked,
          details,
          message: acked
            ? 'Pairing started. Put the remote controller into pairing mode.'
            : 'The aircraft did not acknowledge pairing.',
        };
      case 'camera-serials':
        return {
          action,
          ok: serials.length > 0,
          details,
          message: serials.length ? `Camera serial: ${serials.join(', ')}` : 'No camera serial was reported.',
        };
      case 'link-test':
        return { action, ok: acked, details, message: `${replies} of 3 radios responded.` };
      case 'battery-info':
        return {
          action,
          ok: acked,
          details,
          message: acked ? 'Battery responded (see raw reply below).' : 'The battery did not respond.',
        };
      case 'imu-status':
        return {
          action,
          ok: acked,
          details,
          message: acked ? 'Flight controller IMU status returned.' : 'The flight controller did not respond.',
        };
      case 'vision-scan':
        return {
          action,
          ok: acked,
          details,
          message: serials.length
            ? `Vision/ToF serials: ${serials.join(', ')}`
            : acked
              ? `${replies} vision sensor(s) responded.`
              : 'No vision/ToF sensor responded.',
        };
      case 'fc-param-count':
        return {
          action,
          ok: acked,
          details,
          message: acked ? 'Parameter table info returned (see details below).' : 'The flight controller did not respond.',
        };
      case 'camera-info':
        return {
          action,
          ok: acked,
          details,
          message: serials.length
            ? `Camera serial: ${serials.join(', ')}. Calibration faults, if any, appear in the HMS scan.`
            : acked
              ? 'Camera responded. Calibration faults, if any, appear in the HMS scan.'
              : 'The camera did not respond.',
        };
      case 'vision-cal': {
        const notCal = details.filter((d) => d.includes('not calibrated')).length;
        return {
          action,
          ok: acked && notCal === 0,
          details,
          message: !acked
            ? 'No vision module reported calibration status.'
            : notCal === 0
              ? 'Vision sensors report calibrated.'
              : `${notCal} vision module(s) report NOT calibrated.`,
        };
      }
      case 'tof-reset':
        return {
          action,
          ok: acked,
          details,
          message: acked
            ? 'ToF calibration reset sent. Power-cycle the aircraft, then let it recalibrate on a flat, level surface.'
            : 'The ToF module did not acknowledge the reset.',
        };
      case 'vision-recover':
        return {
          action,
          ok: acked,
          details,
          message: acked
            ? `Vision recovery sent; ${serials.length} of ${VISION_SENSORS.length} sensors report a serial. Restart the aircraft, then read the fault codes again.`
            : 'The vision module did not acknowledge the recovery command.',
        };
      case 'aircraft-restart':
        return {
          action,
          ok: acked,
          message: acked ? 'The aircraft is restarting.' : 'The battery did not acknowledge the restart.',
        };
      case 'aircraft-power-off':
        return {
          action,
          ok: acked,
          message: acked ? 'The aircraft is switching off.' : 'The battery did not acknowledge the command.',
        };
      default:
        return { action, ok: acked, details, message: 'Done.' };
    }
  }

  /** Sends one FLYC parameter step and returns its reply payload, if any. */
  private async sendParamStep(step: DumlStep): Promise<Uint8Array | null> {
    const transport = this.transport;
    if (!transport) {
      throw new Error('No aircraft connected.');
    }
    if (this.flashing) {
      throw new Error('A firmware flash is in progress.');
    }
    return this.flashSendStep(transport, step, 1500);
  }

  private async readParam(name: string): Promise<ParamEntry> {
    const hashHex = `0x${djiParamHash(name).toString(16).padStart(8, '0')}`;
    const reply = await this.sendParamStep(paramReadByHashStep(name));
    if (!reply) {
      return { name, hashHex, valueHex: '', ok: false, note: 'no reply' };
    }
    const parsed = parseParamValueByHash(reply);
    return {
      name,
      hashHex,
      valueHex: toHex(parsed ? parsed.value : reply),
      ok: parsed !== null,
      note: parsed ? undefined : 'short reply',
    };
  }

  private paramReadActive = false;

  private emitParamProgress(progress: ParamProgress): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('drone:param-progress', progress);
      }
    }
  }

  /** Requests the running read-all stop at the next parameter. */
  private cancelReadParams(): void {
    this.paramReadActive = false;
  }

  /**
   * Reads the whole parameter table by index, streaming progress to the UI.
   * Reads the table-info count, then walks each index reading its name (0xE1)
   * and value (0xE2). Stops early if the aircraft stops answering, so an
   * unsupported protocol fails fast rather than timing out on every index.
   */
  private async readAllParams(): Promise<ParamScanResult> {
    const transport = this.transport;
    if (!transport) {
      return { ok: false, entries: [], error: 'No aircraft connected.' };
    }
    if (this.flashing) {
      return { ok: false, entries: [], error: 'A firmware flash is in progress.' };
    }
    this.paramReadActive = true;
    try {
      const tableReply = await this.flashSendStep(transport, paramTableInfoStep(), 1500);
      const table = tableReply ? parseParamTableInfo(tableReply) : null;
      const tableRaw = tableReply ? toHex(tableReply) : undefined;
      const HARD_CAP = 4096;
      const total = table && table.count > 0 ? Math.min(table.count, HARD_CAP) : HARD_CAP;
      const bounded = Boolean(table && table.count > 0);
      const entries: ParamEntry[] = [];
      let consecutiveEmpty = 0;
      let replied = 0;
      let lastReplyRaw: string | undefined;
      this.emitParamProgress({ phase: 'reading', done: 0, total: bounded ? total : 0 });

      for (let index = 0; index < total; index += 1) {
        if (!this.paramReadActive || this.transport !== transport) {
          break;
        }
        const infoReply = await this.flashSendStep(transport, paramInfoByIndexStep(index), 500);

        // Only an actual no-reply (timeout) counts toward giving up; a reply we
        // can't parse (e.g. an empty/short slot) is skipped but keeps the walk
        // going, since the aircraft is clearly still answering.
        if (!infoReply) {
          consecutiveEmpty += 1;
          if (consecutiveEmpty >= (bounded ? 48 : 16)) {
            break;
          }
          continue;
        }
        consecutiveEmpty = 0;
        replied += 1;
        lastReplyRaw = toHex(infoReply.subarray(0, 48));
        let info: ReturnType<typeof parseParamInfo> = null;
        try {
          info = parseParamInfo(infoReply);
        } catch {
          info = null;
        }
        if (!info || !info.name) {
          continue;
        }
        // 0xE1 carries metadata + the factory default. Read the LIVE value with
        // 0xE2 so the table shows what the aircraft is actually running (and so
        // values written earlier are reflected); fall back to the default if the
        // aircraft doesn't answer the value query.
        let current = info.value;
        try {
          const valueReply = await this.flashSendStep(transport, paramReadByIndexStep(index), 500);
          const parsed = valueReply ? parseParamValueByIndex(valueReply) : null;
          if (parsed && parsed.value.length > 0) {
            current = decodeParamValue(parsed.value, info.typeId);
          }
        } catch {
          // keep the default
        }
        entries.push({
          index: info.index,
          name: info.name,
          value: current,
          default: info.value,
          size: info.size,
          min: info.min,
          max: info.max,
          typeId: info.typeId,
          typeName: info.typeName,
          ok: true,
          raw: toHex(infoReply.subarray(0, 48)),
        });
        if (index % 8 === 0 || index === total - 1) {
          this.emitParamProgress({ phase: 'reading', done: entries.length, total: bounded ? total : 0 });
        }
      }
      this.emitParamProgress({ phase: 'done', done: entries.length, total: entries.length });
      const error =
        entries.length === 0
          ? replied > 0
            ? `Aircraft replied to ${replied} index queries but none parsed. Last reply: ${lastReplyRaw ?? '(none)'}`
            : 'The aircraft did not answer any index query (it may use hash-only parameter access).'
          : undefined;
      return { ok: true, count: table?.count, tableRaw, entries, error };
    } catch (error) {
      this.emitParamProgress({ phase: 'done', done: 0, total: 0 });
      return {
        ok: false,
        entries: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.paramReadActive = false;
    }
  }

  private async writeParam(
    name: string,
    index: number,
    value: number,
    size: number,
    typeId: number,
  ): Promise<ParamWriteResult> {
    if (!Number.isFinite(value)) {
      return { ok: false, message: 'Enter a numeric value.' };
    }
    const isFloat = typeId === 8 || typeId === 9;
    const tolerance = isFloat ? 1e-3 : 0.5;
    const target = isFloat ? value : Math.trunc(value);
    const bytes = encodeParamValue(value, size, typeId);

    // Verify by reading the CURRENT value back with 0xE2 (0xE1's value field is
    // the factory default and never changes on write — that is why read-back
    // "stayed at the old value" before).
    const readBack = async (): Promise<number | null> => {
      const reply = await this.sendParamStep(paramReadByIndexStep(index));
      const parsed = reply ? parseParamValueByIndex(reply) : null;
      if (!parsed || parsed.value.length === 0) {
        return null;
      }
      return decodeParamValue(parsed.value, typeId);
    };
    const matches = (v: number | null): boolean => v !== null && Math.abs(v - target) <= tolerance;
    const sameBytes = (a: Uint8Array | null, b: Uint8Array): boolean =>
      a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

    try {
      // Writing requires the 0x03/0xDF unlock immediately before the write;
      // without it the aircraft ignores the write.
      const unlock = await this.sendParamStep(paramWriteUnlockStep());
      const writeStep = paramWriteByIndexStep(index, bytes);
      const writeReply = await this.sendParamStep(writeStep);
      const after = await readBack();
      // The flight controller echoes the written request on success; that echo
      // can be treated as confirmation on its own, without a read-back. We honour
      // both: a matching 0xE2 read-back, OR the write-reply echoing exactly what
      // we sent.
      const echoOk = sameBytes(writeReply, writeStep.payload);
      const ok = matches(after) || echoOk;
      const diag =
        `unlock=${unlock ? toHex(unlock) : 'none'} ` +
        `sent=${toHex(writeStep.payload)} ` +
        `reply=${writeReply ? toHex(writeReply) : 'none'} ` +
        `e2=${after ?? 'none'}${echoOk ? ' echo=match' : ''}`;
      // eslint-disable-next-line no-console
      console.log(`[param:write] ${name} #${index} = ${target} → ${ok ? 'OK' : 'FAILED'} [${diag}]`);
      if (ok) {
        return { ok: true, message: `Saved ${name} = ${target}.` };
      }
      return {
        ok: false,
        message: `The aircraft did not accept the new value for ${name}.`,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Writes a parameter-backup JSON to a file the user picks. */
  private async saveParamBackup(json: string): Promise<ParamBackupFileResult> {
    const window = BrowserWindow.getAllWindows()[0];
    const model = this.state.model ? this.state.model.replace(/[^A-Za-z0-9]+/g, '') : 'dji';
    const serial = this.state.serial ? `-${this.state.serial}` : '';
    const date = new Date().toISOString().slice(0, 10);
    const options = {
      title: 'Save parameter backup',
      defaultPath: `params-${model}${serial}-${date}.json`,
      filters: [{ name: 'Parameter backup', extensions: ['json'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'cancelled' };
    }
    try {
      await writeFile(result.filePath, json, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Reads a parameter-backup JSON the user picks and returns its text. */
  private async loadParamBackup(): Promise<ParamBackupFileResult> {
    const window = BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Open parameter backup',
      filters: [
        { name: 'Parameter backup', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile' as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, error: 'cancelled' };
    }
    try {
      const text = await readFile(result.filePaths[0], 'utf8');
      return { ok: true, path: result.filePaths[0], text };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Reads a partition by paging its owner device's firmware-page query
   * (0x00/0x4F) until a page returns nothing or the page cap is hit, then offers
   * to save the concatenated bytes. Read-only — nothing is written to the
   * aircraft.
   */
  private async backupPartition(id: number): Promise<PartitionBackupResult> {
    const part = partitionById(id);
    if (!part) {
      return { ok: false, name: `#${id}`, pages: 0, bytes: 0, message: 'Unknown partition.' };
    }
    const transport = this.transport;
    if (!transport) {
      return { ok: false, name: part.name, pages: 0, bytes: 0, message: 'No aircraft connected.' };
    }
    if (this.flashing) {
      return { ok: false, name: part.name, pages: 0, bytes: 0, message: 'A firmware flash is in progress.' };
    }
    const MAX_PAGES = 64;
    const chunks: Uint8Array[] = [];
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const reply = await this.flashSendStep(transport, partitionPageStep(part.target, page), 1500);
        if (!reply || reply.length === 0) {
          break;
        }
        chunks.push(reply);
      }
    } catch (error) {
      return {
        ok: false,
        name: part.name,
        pages: chunks.length,
        bytes: chunks.reduce((n, c) => n + c.length, 0),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (chunks.length === 0 || total === 0) {
      // Diagnostic: show whether page 0 answers from the partition's target or
      // from 0x48 (the device this app's manifest read uses), to pin down which
      // address/format actually serves firmware pages on this aircraft.
      const probe = async (receiver: number): Promise<string> => {
        try {
          const reply = await this.flashSendStep(transport, partitionPageStep(receiver, 0), 1200);
          return reply && reply.length ? `0x${receiver.toString(16)}→${toHex(reply.subarray(0, 24))}` : `0x${receiver.toString(16)}→no reply`;
        } catch {
          return `0x${receiver.toString(16)}→error`;
        }
      };
      const probes = [await probe(part.target), await probe(0x48)];
      return {
        ok: false,
        name: part.name,
        pages: 0,
        bytes: 0,
        message: `${part.name} returned no data. Page-0 probe: ${probes.join(', ')}.`,
      };
    }
    const data = Buffer.concat(chunks.map((c) => Buffer.from(c)));

    const window = BrowserWindow.getAllWindows()[0];
    const slug = part.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const serial = this.state.serial ? `-${this.state.serial}` : '';
    const options = {
      title: `Save ${part.name} backup`,
      defaultPath: `partition-${slug}${serial}.bin`,
      filters: [{ name: 'Partition image', extensions: ['bin'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return {
        ok: true,
        name: part.name,
        pages: chunks.length,
        bytes: total,
        message: `Read ${total} bytes from ${part.name} over ${chunks.length} pages (save cancelled).`,
      };
    }
    await writeFile(result.filePath, data);
    return {
      ok: true,
      name: part.name,
      pages: chunks.length,
      bytes: total,
      savedPath: result.filePath,
      message: `Saved ${total} bytes from ${part.name} (${chunks.length} pages).`,
    };
  }

  private setFlash(patch: Partial<FlashState>): void {
    this.flashState = { ...this.flashState, ...patch };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('drone:flash', this.flashState);
      }
    }
  }

  private flashFail(message: string): void {
    this.setFlash({ phase: 'failed', error: message, message, finishedAt: Date.now() });
  }

  private fileInfo(files: FirmwareFile[]): FirmwareFileInfo[] {
    return files.map((f) => ({ name: f.name, size: f.bytes.length }));
  }

  /** Encodes and writes one flash step using its raw sender/receiver addresses. */
  private async flashWrite(transport: BulkTransport, step: DumlStep): Promise<void> {
    this.seqNum = (this.seqNum + 1) & 0xffff;
    const packet = encodePacket({
      senderType: step.sender & 0x1f,
      senderIndex: step.sender >> 5,
      receiverType: step.receiver & 0x1f,
      receiverIndex: step.receiver >> 5,
      seqNum: this.seqNum,
      packetType: 0,
      ackType: (step.ackEnc >> 5) & 3,
      encryptType: step.ackEnc & 7,
      cmdSet: step.cmdSet,
      cmdId: step.cmdId,
      payload: step.payload,
    });
    await transport.write(packet);
  }

  /** Sends a step and, if it expects a reply, waits for the matching payload. */
  private async flashSendStep(
    transport: BulkTransport,
    step: DumlStep,
    timeoutMs: number,
  ): Promise<Uint8Array | null> {
    if (!step.expectReply) {
      await this.flashWrite(transport, step);
      return null;
    }
    let unsubscribe: () => void = () => undefined;
    const reply = new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      unsubscribe = this.subscribe((packet) => {
        if (
          packet.cmdSet === step.cmdSet &&
          packet.cmdId === step.cmdId &&
          packet.senderInfo === step.receiver &&
          packet.receiverInfo === step.sender
        ) {
          clearTimeout(timer);
          resolve(packet.payload);
        }
      });
    });
    try {
      await this.flashWrite(transport, step);
      return await reply;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Dry run: reads the firmware package and plans the flash for the connected
   * aircraft without sending anything to the device.
   */
  private async validateFlash(packagePath: string): Promise<FlashValidation> {
    const empty: FirmwareFileInfo[] = [];
    const model = this.activeModel;
    const route = model ? flashRouteForCode(model.code) : null;
    if (!this.transport) {
      return { ok: false, files: empty, totalSize: 0, warnings: [], error: 'No aircraft connected.' };
    }
    if (!model) {
      return {
        ok: false,
        files: empty,
        totalSize: 0,
        warnings: [],
        error: 'Aircraft model has not been identified yet.',
      };
    }
    const head = { model: model.name, modelCode: model.code, droneType: route?.droneType };
    if (!route) {
      return {
        ok: false,
        ...head,
        files: empty,
        totalSize: 0,
        warnings: [],
        error: `Flashing is not supported for ${model.name} (${model.code}).`,
      };
    }
    let files: FirmwareFile[];
    try {
      files = readFirmwarePackage(await readFile(packagePath));
    } catch (err) {
      return {
        ok: false,
        ...head,
        files: empty,
        totalSize: 0,
        warnings: [],
        error: `Could not read firmware package: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (files.length === 0) {
      return {
        ok: false,
        ...head,
        files: empty,
        totalSize: 0,
        warnings: [],
        error: 'No .sig firmware modules were found in the package (expected a DJI .bin/tar/zip).',
      };
    }
    const totalSize = files.reduce((n, f) => n + f.bytes.length, 0);
    const warnings = [
      'Flashing is irreversible. A wrong package or an interruption can permanently brick the aircraft.',
    ];
    const manifest = this.state.manifest;
    if (manifest?.antiRollback != null) {
      warnings.push(
        `Aircraft anti-rollback level is ${manifest.antiRollback} (firmware ${manifest.formalVersion ?? '?'}). Flashing firmware built below this level will permanently brick the aircraft.`,
      );
    }
    if (model.needsFactoryMode) {
      warnings.push(`${model.name} normally requires factory mode before firmware service.`);
    }
    const prefix = model.code.slice(0, 5).toLowerCase();
    if (!files.some((f) => f.name.toLowerCase().includes(prefix))) {
      warnings.push(
        `None of the firmware files name "${model.code}" — confirm this package is for the connected aircraft.`,
      );
    }
    return { ok: true, ...head, files: this.fileInfo(files), totalSize, warnings };
  }

  /** True (and reports failure) when the flash should stop. */
  private flashAborted(transport: BulkTransport): boolean {
    if (this.transport !== transport) {
      this.flashFail('The aircraft disconnected during flashing.');
      return true;
    }
    if (this.flashCancelled) {
      this.setFlash({ phase: 'failed', error: 'Flash cancelled.', message: 'Flash cancelled.', finishedAt: Date.now() });
      return true;
    }
    return false;
  }

  private async flashEnterMode(transport: BulkTransport, route: FlashRoute): Promise<boolean> {
    const step = enterStep(route);
    const tries = route.family === 'new-m3' ? 10 : 3;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (this.transport !== transport) {
        return false;
      }
      const reply = await this.flashSendStep(transport, step, FLASH_ENTER_TIMEOUT_MS);
      if (route.family === 'new-m3') {
        if (reply && reply.length >= 1) {
          if (reply[0] === 0x00) return true;
          if (reply[0] === 0xc5) return false; // device wants a reboot first
        }
      } else if (reply) {
        return true; // legacy modules ack with any payload
      }
      await sleep(1000);
    }
    return false;
  }

  private async runFlash(packagePath: string): Promise<void> {
    const transport = this.transport;
    const model = this.activeModel;
    const route = model ? flashRouteForCode(model.code) : null;
    if (!transport) {
      this.flashFail('No aircraft connected.');
      return;
    }
    if (!model || !route) {
      this.flashFail('This aircraft is not supported for flashing.');
      return;
    }
    let files: FirmwareFile[];
    try {
      files = readFirmwarePackage(await readFile(packagePath));
    } catch (err) {
      this.flashFail(`Could not read firmware package: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (files.length === 0) {
      this.flashFail('No .sig firmware modules were found in the package.');
      return;
    }
    const totalSize = files.reduce((n, f) => n + f.bytes.length, 0);

    this.flashing = true;
    this.flashCancelled = false;
    this.setFlash({
      phase: 'entering',
      model: model.name,
      modelCode: model.code,
      droneType: route.droneType,
      packagePath,
      files: this.fileInfo(files),
      totalSize,
      fileIndex: 0,
      currentFile: undefined,
      fileProgress: 0,
      overallProgress: 0,
      message: 'Entering upgrade mode…',
      error: undefined,
      statusDetail: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
    });

    try {
      if (!(await this.flashEnterMode(transport, route))) {
        this.flashFail('The aircraft did not enter upgrade mode. Reboot it and try again.');
        return;
      }
      if (this.flashAborted(transport)) return;

      this.setFlash({ phase: 'preparing', message: 'Negotiating transfer…' });
      const prepReply = await this.flashSendStep(transport, prepareStep(route, totalSize), FLASH_STEP_TIMEOUT_MS);
      const prepBlock = blockSizeFromReply(prepReply);

      this.setFlash({ phase: 'transferring' });
      // M3 negotiates the block size per-file and locks it; legacy takes it here.
      let lockedBlock: number | null = route.family === 'new-m3' ? null : prepBlock;
      let sentTotal = 0;
      let lastOverall = -1;

      for (let i = 0; i < files.length; i += 1) {
        if (this.flashAborted(transport)) return;
        const file = files[i];
        const openReply = await this.flashSendStep(
          transport,
          fileOpenStep(route, file.name, file.bytes.length),
          FLASH_STEP_TIMEOUT_MS,
        );
        let blockSize = blockSizeFromReply(openReply) ?? prepBlock ?? lockedBlock;
        if (route.family === 'new-m3') {
          if (lockedBlock == null) lockedBlock = blockSize;
          else blockSize = lockedBlock;
        } else if (route.family === 'legacy-mini' && blockSize && blockSize > file.bytes.length) {
          blockSize = file.bytes.length;
        }
        if (!blockSize || blockSize <= 0) {
          this.flashFail('The aircraft did not negotiate a transfer block size.');
          return;
        }

        this.setFlash({
          fileIndex: i + 1,
          currentFile: file.name,
          fileProgress: 0,
          message: `Transferring ${file.name} (${i + 1}/${files.length})…`,
        });

        let index = 0;
        for (let offset = 0; offset < file.bytes.length; offset += blockSize) {
          if ((index & 0x1f) === 0 && this.flashAborted(transport)) return;
          const end = Math.min(offset + blockSize, file.bytes.length);
          const chunk = file.bytes.subarray(offset, end);
          await this.flashSendStep(transport, dataStep(route, index, chunk), FLASH_STEP_TIMEOUT_MS);
          index += 1;
          const overall = Math.round((100 * (sentTotal + end)) / totalSize);
          if (overall !== lastOverall) {
            lastOverall = overall;
            this.setFlash({
              fileProgress: Math.round((100 * end) / file.bytes.length),
              overallProgress: overall,
            });
          }
          // Yield so IPC/cancel stay responsive during fire-and-forget bursts.
          if ((index & 0x1f) === 0) {
            await sleep(0);
          }
        }
        sentTotal += file.bytes.length;

        const md5Reply = await this.flashSendStep(transport, md5Step(route, file.bytes), FLASH_STEP_TIMEOUT_MS);
        if (md5Reply && md5Reply.length >= 1) {
          const rejected = route.family === 'new-m3' ? md5Reply[0] === 0xe0 : md5Reply[0] !== 0x00;
          if (rejected) {
            this.flashFail(`The aircraft rejected the checksum of ${file.name}.`);
            return;
          }
        }
      }

      if (this.flashAborted(transport)) return;
      this.setFlash({ phase: 'finishing', overallProgress: 100, message: 'Committing firmware…' });
      await this.flashSendStep(transport, finishStep(route), FLASH_STEP_TIMEOUT_MS);

      this.setFlash({ phase: 'monitoring', message: 'The aircraft is installing the firmware. Do not disconnect it.' });
      await this.monitorUpgrade(transport);
    } catch (err) {
      this.flashFail(err instanceof Error ? err.message : String(err));
    } finally {
      this.flashing = false;
    }
  }

  /** Listens for GENERAL 0x42 upgrade-status reports until a verdict or timeout. */
  private monitorUpgrade(transport: BulkTransport): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + FLASH_MONITOR_MS;
      let settled = false;
      const finish = (patch: Partial<FlashState>): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        unsubscribe();
        this.setFlash({ ...patch, finishedAt: Date.now() });
        resolve();
      };
      const unsubscribe = this.subscribe((packet) => {
        if (packet.cmdSet !== 0x00 || packet.cmdId !== CMD_UPGRADE_STATUS) {
          return;
        }
        const status = decodeUpgradeStatus(packet.payload);
        if (status.phase === 'progress' && status.percent != null) {
          this.setFlash({ overallProgress: status.percent, statusDetail: `installing ${status.percent}%` });
        } else if (status.detail) {
          this.setFlash({ statusDetail: status.detail });
        }
        if (status.phase === 'success') {
          finish({ phase: 'done', overallProgress: 100, message: 'Firmware installed. The aircraft will reboot.' });
        } else if (status.phase === 'failed') {
          finish({ phase: 'failed', error: `Aircraft reported: ${status.detail ?? 'upgrade failed'}.` });
        }
      });
      const timer = setInterval(() => {
        if (this.transport !== transport) {
          finish({ phase: 'done', message: 'Firmware sent; the aircraft disconnected to reboot (status unconfirmed).' });
        } else if (Date.now() > deadline) {
          finish({ phase: 'done', message: 'Firmware sent. Installation status was not confirmed before monitoring ended.' });
        }
      }, 1000);
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.consoleWatch(false);
    const transport = this.transport;
    this.transport = null;
    await transport?.close();
  }

  private setState(patch: Partial<DroneState>): void {
    this.state = { ...this.state, ...patch };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('drone:state', this.state);
      }
    }
  }

  /** Sends the packets parsed from one USB read to the DevTools console. */
  private tracePackets(packets: Packet[]): void {
    if (!TRACE_PACKETS || packets.length === 0) {
      return;
    }
    const lines = packets.map(describePacket);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('drone:packets', lines);
      }
    }
  }

  private checkingAlive = false;
  /** Pending close of the previous link; reconnecting waits for it. */
  private closing: Promise<void> | null = null;

  private tryConnect(): void {
    const current = this.transport;
    if (current) {
      // Already connected: make sure the drone is still plugged in.
      if (!this.checkingAlive) {
        this.checkingAlive = true;
        void current
          .isAlive()
          .then((alive) => {
            if (!alive) {
              this.onLost(current, 'drone unplugged or powered off');
            }
          })
          .finally(() => {
            this.checkingAlive = false;
          });
      }
      return;
    }
    if (this.closing) {
      return; // the old handle is still being released
    }
    let error: string | undefined;
    try {
      const result = connectBulk([
        path.join(process.resourcesPath, 'libusb0.dll'),
        path.join(app.getAppPath(), 'resources', 'libusb0.dll'),
      ]);
      if (result.transport) {
        this.onConnected(result.transport);
        return;
      }
      error = result.error;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // Keep showing why the link dropped until something new happens.
    if (error && error !== this.state.error) {
      this.setState({ error });
    }
  }

  private onConnected(transport: BulkTransport): void {
    this.transport = transport;
    this.parser.reset();
    transport.start({
      onData: (data) => {
        if (this.transport !== transport) {
          return;
        }
        const packets = this.parser.feed(data);
        this.tracePackets(packets);
        for (const packet of packets) {
          for (const listener of [...this.listeners]) {
            listener(packet);
          }
        }
      },
      onLost: (reason) => this.onLost(transport, reason),
    });
    this.activeModel = null;
    this.configReceiver = null;
    this.fcStatusFrame = null;
    this.setState({
      status: 'connected',
      label: transport.label,
      error: undefined,
      scanning: true,
      model: transport.product || undefined,
      modelCode: undefined,
      modules: [],
      cameraSerial: undefined,
      serial: undefined,
      calibration: undefined,
      imuCalibration: undefined,
      repair: undefined,
      hms: undefined,
      manifest: undefined,
    });
    this.startHmsListener();
    // Identify the aircraft first (fast, like the reference tool shows it),
    // then read every module's version.
    void this.identifyThenScan(transport);
  }

  private async identifyThenScan(transport: BulkTransport): Promise<void> {
    await this.detectModel(transport).catch((): undefined => undefined);
    await this.scanUntilFound(transport);
    // Read the firmware manifest (authoritative model + anti-rollback), then
    // subscribe to HMS — the order the reference tool uses.
    await this.readConfig(transport).catch((): undefined => undefined);
    await this.subscribeHms(transport).catch((): undefined => undefined);
  }

  /** One paged config request (GENERAL 0x4F) at the given byte offset. */
  private configRequest(
    transport: BulkTransport,
    receiver: number,
    offset: number,
  ): Promise<Uint8Array | null> {
    const payload = new Uint8Array(9);
    payload[0] = 0x01;
    new DataView(payload.buffer).setUint32(1, offset >>> 0, true);
    payload[5] = 0xff;
    payload[6] = 0xff;
    payload[7] = 0xff;
    payload[8] = 0xff;
    return this.flashSendStep(
      transport,
      { sender: 0x2a, receiver, ackEnc: 0x40, cmdSet: CmdSet.GENERAL, cmdId: CMD_GENERAL_GET_CONFIG, payload, expectReply: true },
      1500,
    ).catch((): null => null);
  }

  /** Finds which module answers the config request for this aircraft. */
  private async findConfigReceiver(transport: BulkTransport): Promise<number | null> {
    for (const receiver of CONFIG_RECEIVERS) {
      if (this.transport !== transport) return null;
      const reply = await this.configRequest(transport, receiver, 0);
      if (reply && reply.length >= 9 && reply[0] === 0) {
        return receiver;
      }
    }
    return null;
  }

  /**
   * Reads the full firmware manifest (cfg.sig) to completion — until the device
   * reports zero bytes remaining — and parses it. The device id it states is
   * the authoritative model. Read-only.
   */
  private async readConfig(transport: BulkTransport): Promise<void> {
    const receiver = this.configReceiver ?? (await this.findConfigReceiver(transport));
    if (receiver == null || this.transport !== transport) {
      return;
    }
    this.configReceiver = receiver;

    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < 8192; i += 1) {
      if (this.transport !== transport) return;
      const reply = await this.configRequest(transport, receiver, offset);
      if (!reply || reply.length < 9 || reply[0] !== 0) {
        break;
      }
      const remaining = reply[5] | (reply[6] << 8) | (reply[7] << 16) | (reply[8] << 24);
      const chunk = reply.subarray(9);
      if (chunk.length === 0) {
        break;
      }
      parts.push(chunk);
      offset += chunk.length;
      if (remaining === 0 || offset > 2_000_000) {
        break;
      }
    }

    const manifest = parseConfig(Buffer.concat(parts));
    if (!manifest || this.transport !== transport) {
      return;
    }
    this.setState({ manifest });
    // The config states the device id authoritatively; map it to the model.
    const model = matchModelCode(manifest.deviceId);
    if (model) {
      this.activeModel = model;
      this.setState({ model: model.name, modelCode: model.code });
    }
  }

  /**
   * Identifies the aircraft the way the reference tool does: a GENERAL VersionInquiry
   * (cmd 0x01) sent to a short list of module addresses, reading the factory
   * code (e.g. "WM260") out of the first ASCII reply and mapping it to a
   * marketing name. Read-only.
   */
  private async detectModel(transport: BulkTransport): Promise<void> {
    for (const address of MODEL_PROBE_RECEIVERS) {
      if (this.transport !== transport) {
        return;
      }
      const reply = await this.request(
        transport,
        address & 0x1f,
        address >> 5,
        CmdSet.GENERAL,
        CMD_GENERAL_VERSION_INQUIRY,
        new Uint8Array(0),
        MODEL_PROBE_TIMEOUT_MS,
      ).catch((): null => null);
      if (!reply) {
        continue;
      }
      const text = Buffer.from(reply.payload).toString('latin1');
      const model = matchModelCode(text);
      if (model && this.transport === transport) {
        this.activeModel = model;
        this.setState({ model: model.name, modelCode: model.code });
        return;
      }
    }
  }

  private onLost(transport: BulkTransport, reason: string): void {
    if (this.transport !== transport) {
      return;
    }
    this.transport = null;
    this.activeModel = null;
    this.hmsUnsubscribe?.();
    this.hmsUnsubscribe = null;
    this.hmsRecords.clear();
    this.hmsLive.clear();
    this.gimbalTestUnsubscribe?.();
    this.gimbalTestUnsubscribe = null;
    this.gimbalTestEnabled = false;
    this.gimbalTestAcks = 0;
    this.propStopRequested = true;
    this.propFactoryOpen = false;
    this.propTestTouched = false;
    this.beeping.clear();
    this.beepFactoryOpen = false;
    this.closing = transport.close().finally(() => {
      this.closing = null;
    });
    console.log(`[drone] disconnected: ${reason}`);
    this.setState({
      status: 'searching',
      label: undefined,
      error: undefined,
      scanning: false,
      model: undefined,
      modelCode: undefined,
      modules: [],
      cameraSerial: undefined,
      serial: undefined,
      hms: undefined,
      manifest: undefined,
    });
  }

  private subscribe(listener: (packet: Packet) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async send(
    transport: BulkTransport,
    receiverType: number,
    receiverIndex: number,
    ackType: number,
    cmdSet: number,
    cmdId: number,
    payload: Uint8Array,
  ): Promise<void> {
    this.seqNum = (this.seqNum + 1) & 0xffff;
    const packet = encodePacket({
      senderType: DevType.PC,
      senderIndex: 0,
      receiverType,
      receiverIndex,
      seqNum: this.seqNum,
      packetType: 0,
      ackType,
      encryptType: 0,
      cmdSet,
      cmdId,
      payload,
    });
    try {
      await transport.write(packet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onLost(transport, message);
      throw error;
    }
  }

  /** Asks every known module for its version until at least one answers. */
  private async scanUntilFound(transport: BulkTransport): Promise<void> {
    while (this.transport === transport) {
      if (!this.calibrating) {
        try {
          await this.scanModules(transport);
        } catch {
          return; // link dropped; onLost already updated the state
        }
        if (this.transport !== transport) {
          return;
        }
        if (this.state.modules.length > 0) {
          const cameraSerial = await this.readCameraSerial(transport).catch(
            (): undefined => undefined,
          );
          const serial = await this.readDroneSerial(transport).catch(
            (): undefined => undefined,
          );
          if (this.transport === transport) {
            this.setState({ scanning: false, cameraSerial, serial });
          }
          return;
        }
      }
      await sleep(SCAN_RETRY_MS);
    }
  }

  /** Sends a request and waits for the matching reply from that module. */
  private async request(
    transport: BulkTransport,
    receiverType: number,
    receiverIndex: number,
    cmdSet: number,
    cmdId: number,
    payload: Uint8Array,
    timeoutMs: number,
  ): Promise<Packet | null> {
    const from = moduleInfo(receiverType, receiverIndex);
    let unsubscribe: () => void = () => undefined;
    const reply = new Promise<Packet | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      unsubscribe = this.subscribe((packet) => {
        if (
          packet.cmdSet === cmdSet &&
          packet.cmdId === cmdId &&
          packet.senderInfo === from &&
          packet.receiverInfo === PC
        ) {
          clearTimeout(timer);
          resolve(packet);
        }
      });
    });
    try {
      await this.send(
        transport,
        receiverType,
        receiverIndex,
        AckType.ACK_AFTER_EXEC,
        cmdSet,
        cmdId,
        payload,
      );
      return await reply;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Reads the camera's serial number with the camera command (0x02/0xB5 to
   * the camera, payload 00000000) the reference tool uses. The 0x51 "serial"
   * on module 0x68 is a different component's serial, so it is not used here.
   * The serial is the longest printable run in the reply.
   */
  private async readCameraSerial(transport: BulkTransport): Promise<string | undefined> {
    const multiple = (this.activeModel?.cameraCount ?? 1) > 1;
    const step = cameraSerialSteps(multiple)[0];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await this.flashSendStep(transport, step, 1000);
      if (!reply) {
        continue;
      }
      const serial = serialFromReply(reply);
      if (serial) {
        return serial;
      }
      if (reply.length > 2) {
        return `raw: ${toHex(reply)}`;
      }
    }
    return undefined;
  }

  /**
   * Reads the aircraft serial number (GENERAL 0x51 to module 0x68). This is the
   * drone's own serial, distinct from the camera serial. The serial is the
   * longest printable run in the reply.
   */
  private async readDroneSerial(transport: BulkTransport): Promise<string | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await this.flashSendStep(
        transport,
        {
          sender: 0x0a,
          receiver: 0x68,
          ackEnc: 0x40,
          cmdSet: CmdSet.GENERAL,
          cmdId: CMD_GENERAL_GET_SERIAL,
          payload: Uint8Array.of(0x04),
          expectReply: true,
        },
        1000,
      );
      if (!reply) {
        continue;
      }
      const serial = serialFromReply(reply);
      if (serial) {
        return serial;
      }
    }
    return undefined;
  }

  private async scanModules(transport: BulkTransport): Promise<void> {
    const byInfo = new Map<number, ScanTarget>();
    for (const target of SCAN_TARGETS) {
      byInfo.set(moduleInfo(target.type, target.index), target);
    }
    const found = new Map<number, ModuleVersion>();
    const unsubscribe = this.subscribe((packet) => {
      const target = byInfo.get(packet.senderInfo);
      if (
        !target ||
        packet.cmdSet !== CmdSet.GENERAL ||
        packet.cmdId !== CMD_GENERAL_VERSION_INQUIRY ||
        packet.receiverInfo !== PC
      ) {
        return;
      }
      const version = parseVersionReply(target.name, packet.payload);
      if (version && !found.has(packet.senderInfo)) {
        found.set(packet.senderInfo, version);
        this.publishModules(byInfo, found);
      }
    });
    try {
      for (const target of SCAN_TARGETS) {
        await this.send(
          transport,
          target.type,
          target.index,
          AckType.ACK_AFTER_EXEC,
          CmdSet.GENERAL,
          CMD_GENERAL_VERSION_INQUIRY,
          new Uint8Array(0),
        );
        await sleep(SCAN_SPACING_MS);
      }
      await sleep(SCAN_WAIT_MS);
    } finally {
      unsubscribe();
    }
  }

  private publishModules(
    byInfo: Map<number, ScanTarget>,
    found: Map<number, ModuleVersion>,
  ): void {
    const modules: ModuleVersion[] = [];
    for (const info of byInfo.keys()) {
      const version = found.get(info);
      if (version) {
        modules.push(version);
      }
    }
    // Fallback: if the dedicated probe did not recognise the aircraft, the
    // factory code is usually present in a module's hardware string anyway.
    if (!this.activeModel) {
      for (const module of modules) {
        const model = matchModelCode(module.hardware);
        if (model) {
          this.activeModel = model;
          this.setState({ model: model.name, modelCode: model.code, modules });
          return;
        }
      }
    }
    this.setState({ modules });
  }

  /**
   * Runs the advanced (full automatic) calibration: preparation steps, the
   * trigger, then the gimbal's own percentage reports (ZENMUSE 0x30) until it
   * reaches 100. Factory mode, where the plan enters
   * it, is deliberately left on when the run ends; the closing message says so
   * and the operator leaves it from the Service page.
   */
  private async runAdvancedCalibration(
    transport: BulkTransport,
    plan: AdvancedCalibrationPlan,
  ): Promise<void> {
    this.calibrating = true;

    let calibration: CalibrationState = {
      kind: 'advanced',
      phase: 'running',
      startedAt: Date.now(),
      expectMs: plan.expectMs,
      reports: 0,
      message: 'Preparing the aircraft…',
    };
    const update = (patch: Partial<CalibrationState>): void => {
      calibration = { ...calibration, ...patch };
      this.setState({ calibration });
    };
    // Set once the factory-mode request has gone out, so the closing message
    // can say the aircraft is still in factory mode.
    let factoryModeOn = false;
    const finish = (phase: CalibrationState['phase'], message: string): void =>
      update({
        phase,
        message: !factoryModeOn
          ? message
          : plan.variant === 'enterprise'
            ? // This variant enters factory mode through the flight controller,
              // which the Service page's exit does not address.
              `${message} The aircraft is still in factory mode.`
            : `${message} The aircraft is still in factory mode; leave it with Exit factory mode on the Service page when you are done.`,
        finishedAt: Date.now(),
      });
    update({});

    const queue: Packet[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((packet) => {
      if (
        packet.cmdSet === CmdSet.ZENMUSE &&
        (packet.cmdId === CMD_GIMBAL_CALIBRATION || packet.cmdId === CMD_GIMBAL_CALIBRATION_PROGRESS) &&
        packet.senderType === DevType.GIMBAL
      ) {
        queue.push(packet);
        wake?.();
      }
    });
    const nextReport = async (timeoutMs: number): Promise<Packet | null> => {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, timeoutMs));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
      return queue.shift() ?? null;
    };

    /**
     * Applies one gimbal report. Returns 'done' / 'error' when it ends the run.
     * A 0x08 answer of 0 means accepted and 1 or 3 mean in progress; anything
     * else is the gimbal refusing. A 0x30 report is [percent, flag].
     */
    const apply = (packet: Packet): 'continue' | 'done' | 'error' => {
      const first = packet.payload[0];
      if (first === undefined) {
        return 'continue';
      }
      if (packet.cmdId === CMD_GIMBAL_CALIBRATION) {
        if (first === 0 || first === 1 || first === 3) {
          return 'continue';
        }
        finish('failed', `The gimbal refused the calibration (code 0x${first.toString(16).padStart(2, '0')}).`);
        return 'error';
      }
      const flag = packet.payload[1] ?? 0;
      const pointUp = plan.asksPointUp && flag === 2 && first < 100;
      update({
        reports: calibration.reports + 1,
        lastReport: toHex(packet.payload.subarray(0, 2)),
        progress: Math.min(first, 100),
        message: pointUp
          ? 'Point the drone up toward the ceiling and hold it still.'
          : 'Calibrating; the gimbal is moving. Do not touch the drone.',
      });
      if (first >= 100) {
        finish('pass', 'The gimbal reported 100%; calibration finished.');
        return 'done';
      }
      return 'continue';
    };

    try {
      for (const prepareStep of plan.prepare) {
        await this.flashWrite(transport, prepareStep);
        factoryModeOn = factoryModeOn || entersFactoryMode(plan);
        await sleep(60);
      }
      if (plan.pauseMs > 0) {
        await sleep(plan.pauseMs);
      }
      update({ message: 'Calibration command sent; waiting for the gimbal to answer…' });
      await this.flashWrite(transport, plan.trigger);

      // First answer: either the 0x08 acknowledgement or a first 0x30 report.
      const ackDeadline = Date.now() + plan.ackTimeoutMs;
      let answered = false;
      while (!answered && Date.now() < ackDeadline) {
        if (this.transport !== transport) {
          finish('unsure', 'Connection lost before the gimbal answered.');
          return;
        }
        const packet = await nextReport(Math.min(500, ackDeadline - Date.now()));
        if (!packet) {
          continue;
        }
        answered = true;
        const outcome = apply(packet);
        if (outcome !== 'continue') {
          return;
        }
      }
      if (!answered) {
        finish('failed', 'The gimbal did not answer; the calibration may not have started.');
        return;
      }
      if (calibration.progress === undefined) {
        update({ message: 'Calibration started; waiting for progress. Keep the drone still and level.' });
      }

      const maxMs = Math.max(plan.expectMs * 3, 300000);
      const stallMs = 120000;
      const startTime = Date.now();
      let lastReportTime = startTime;
      for (;;) {
        const now = Date.now();
        if (this.transport !== transport) {
          finish('unsure', 'Connection lost while calibrating; completion unconfirmed.');
          return;
        }
        if (now - startTime > maxMs) {
          finish('unsure', 'Monitoring timed out; completion unconfirmed.');
          return;
        }
        if (now - lastReportTime > stallMs) {
          finish('unsure', 'Progress reports stopped; completion unconfirmed.');
          return;
        }
        const packet = await nextReport(500);
        if (!packet) {
          continue;
        }
        lastReportTime = Date.now();
        if (apply(packet) !== 'continue') {
          return;
        }
      }
    } catch (error) {
      finish('failed', error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
      this.calibrating = false;
    }
  }

  private async runCalibration(
    transport: BulkTransport,
    kind: Exclude<CalibrationKind, 'advanced'>,
  ): Promise<void> {
    const spec = CALIBRATIONS[kind];
    this.calibrating = true;

    let calibration: CalibrationState = {
      kind,
      phase: 'running',
      startedAt: Date.now(),
      expectMs: spec.expectMs,
      reports: 0,
      message: 'Sending calibration request…',
    };
    const update = (patch: Partial<CalibrationState>): void => {
      calibration = { ...calibration, ...patch };
      this.setState({ calibration });
    };
    const finish = (phase: CalibrationState['phase'], message: string): void =>
      update({ phase, message, finishedAt: Date.now() });
    update({});

    // Reports are queued so none is lost between two waits.
    const queue: Packet[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((packet) => {
      if (
        packet.cmdSet === CmdSet.ZENMUSE &&
        (packet.cmdId === CMD_GIMBAL_CALIBRATION ||
          packet.cmdId === CMD_GIMBAL_CALIBRATION_PROGRESS) &&
        packet.senderInfo === GIMBAL &&
        packet.receiverInfo === PC
      ) {
        queue.push(packet);
        wake?.();
      }
    });
    const nextReport = async (timeoutMs: number): Promise<Packet | null> => {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
      return queue.shift() ?? null;
    };

    try {
      // The gimbal answers the request (Zenmuse 0x08) either with a bare
      // one-byte acknowledgement followed by asynchronous Zenmuse 0x30
      // reports (Air 3), or directly with its first two-byte status report
      // (Spark, Mavic Air, Mavic 2).
      let reply: Packet | null = null;
      for (let attempt = 0; attempt < CALIB_ACK_RETRIES && !reply; attempt += 1) {
        await this.send(
          transport,
          DevType.GIMBAL,
          0,
          AckType.ACK_BEFORE_EXEC,
          CmdSet.ZENMUSE,
          CMD_GIMBAL_CALIBRATION,
          Uint8Array.of(spec.command),
        );
        const deadline = Date.now() + CALIB_ACK_TIMEOUT_MS;
        while (!reply && Date.now() < deadline) {
          const packet = await nextReport(deadline - Date.now());
          if (packet && packet.cmdId === CMD_GIMBAL_CALIBRATION) {
            reply = packet;
          }
        }
      }
      if (!reply) {
        finish('failed', 'The gimbal did not respond to the calibration request.');
        return;
      }

      update({ message: 'Calibration started; the gimbal is moving. Do not touch the drone.' });

      const isSuccess = (packet: Packet): boolean =>
        packet.cmdId === CMD_GIMBAL_CALIBRATION_PROGRESS
          ? packet.payload[0] === 0x64 && packet.payload[1] === 0x00
          : packet.payload[0] === spec.pass[0] && packet.payload[1] === spec.pass[1];

      let report: Packet | null = reply.payload.length >= 2 ? reply : null;
      const startTime = Date.now();
      let lastReportTime = startTime;
      for (;;) {
        const now = Date.now();
        if (report && report.payload.length >= 2) {
          lastReportTime = now;
          update({
            reports: calibration.reports + 1,
            lastReport: toHex(report.payload.subarray(0, 2)),
          });
          if (isSuccess(report)) {
            finish('pass', 'Concluding report received; calibration finished.');
            return;
          }
        }
        if (this.transport !== transport) {
          finish('unsure', 'Connection lost while calibrating; completion unconfirmed.');
          return;
        }
        if (now - startTime > spec.maxMs) {
          finish('unsure', 'Monitoring timed out; completion unconfirmed.');
          return;
        }
        if (now - lastReportTime > spec.stallMs) {
          finish('unsure', 'Progress reports stopped; completion unconfirmed.');
          return;
        }
        report = await nextReport(500);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish('failed', message);
    } finally {
      unsubscribe();
      this.calibrating = false;
    }
  }

  /**
   * Runs the IMU calibration: factory mode, the request, then the aircraft's
   * [percent, step] reports until 100. Factory mode is left again whenever the
   * run ends, and a refusal or silence ends the run instead of leaving it open.
   */
  private async runImuCalibration(transport: BulkTransport, plan: ImuCalibrationPlan): Promise<void> {
    this.calibrating = true;
    this.imuStopRequested = false;

    let run: ImuCalibrationState = {
      phase: 'running',
      startedAt: Date.now(),
      done: [],
      reports: 0,
      message: 'Preparing the aircraft…',
    };
    const update = (patch: Partial<ImuCalibrationState>): void => {
      run = { ...run, ...patch };
      this.setState({ imuCalibration: run });
    };
    const finish = (phase: ImuCalibrationState['phase'], message: string): void =>
      update({ phase, message, finishedAt: Date.now() });
    update({});

    const queue: Packet[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((packet) => {
      if (
        packet.cmdSet === CmdSet.ZENMUSE &&
        (packet.cmdId === CMD_GIMBAL_CALIBRATION || packet.cmdId === CMD_GIMBAL_CALIBRATION_PROGRESS) &&
        packet.senderType === DevType.GIMBAL
      ) {
        queue.push(packet);
        wake?.();
      }
    });
    const nextReport = async (timeoutMs: number): Promise<Packet | null> => {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, timeoutMs));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
      return queue.shift() ?? null;
    };

    /**
     * Applies one report. An answer to the request of 0 means accepted and 1
     * or 3 mean in progress, as for the other calibrations; anything else is a
     * refusal. A progress report is [percent, step].
     */
    const apply = (packet: Packet): 'continue' | 'done' | 'error' => {
      if (packet.cmdId === CMD_GIMBAL_CALIBRATION) {
        const code = packet.payload[0];
        if (code === undefined || code === 0 || code === 1 || code === 3) {
          return 'continue';
        }
        finish('failed', `The aircraft refused the calibration (code 0x${code.toString(16).padStart(2, '0')}).`);
        return 'error';
      }
      const progress = parseImuProgress(packet.payload);
      if (!progress) {
        return 'continue';
      }
      if (progress.percent >= 100) {
        update({ reports: run.reports + 1, progress: 100, done: IMU_POSITIONS.map((p) => p.id) });
        finish('pass', 'The aircraft reported 100%; calibration finished. Power-cycle the aircraft.');
        return 'done';
      }
      const position = progress.position;
      const asked = position === undefined ? undefined : IMU_POSITIONS[position];
      update({
        reports: run.reports + 1,
        progress: progress.percent,
        position,
        done:
          position !== undefined && progress.percent > 0
            ? IMU_POSITIONS.filter((p) => p.id < position).map((p) => p.id)
            : run.done,
        message: asked
          ? `Position ${asked.id + 1} of ${IMU_POSITIONS.length}: ${asked.label}. Hold the aircraft still until the next position is asked for.`
          : 'Calibrating; keep the aircraft still.',
      });
      return 'continue';
    };

    const stopped = (): boolean => {
      if (!this.imuStopRequested) {
        return false;
      }
      finish('stopped', 'Stopped, and factory mode was left. Power-cycle the aircraft before using it.');
      return true;
    };

    try {
      for (const prepareStep of plan.prepare) {
        await this.flashWrite(transport, prepareStep);
        await sleep(60);
      }
      await sleep(plan.pauseMs);
      if (stopped()) {
        return;
      }
      update({ message: 'Calibration request sent; waiting for the aircraft to answer…' });
      await this.flashWrite(transport, plan.trigger);

      const ackDeadline = Date.now() + plan.ackTimeoutMs;
      let answered = false;
      while (!answered) {
        if (this.transport !== transport) {
          finish('unsure', 'Connection lost before the aircraft answered.');
          return;
        }
        if (stopped()) {
          return;
        }
        if (Date.now() >= ackDeadline) {
          finish('failed', 'The aircraft did not answer; the calibration did not start.');
          return;
        }
        const packet = await nextReport(Math.min(500, ackDeadline - Date.now()));
        if (!packet) {
          continue;
        }
        answered = true;
        if (apply(packet) !== 'continue') {
          return;
        }
      }
      if (run.progress === undefined) {
        update({ message: 'Request accepted; waiting for the first position. Keep the aircraft level and still.' });
      }

      const firstProgressMs = 30000;
      const stallMs = 180000;
      const maxMs = 20 * 60000;
      const startTime = Date.now();
      let lastReportTime = startTime;
      for (;;) {
        const now = Date.now();
        if (this.transport !== transport) {
          finish('unsure', 'Connection lost while calibrating; completion unconfirmed.');
          return;
        }
        if (stopped()) {
          return;
        }
        if (run.progress === undefined && now - startTime > firstProgressMs) {
          finish('unsure', 'The aircraft accepted the request but reported no progress.');
          return;
        }
        if (now - lastReportTime > stallMs) {
          finish('unsure', 'Progress reports stopped; completion unconfirmed.');
          return;
        }
        if (now - startTime > maxMs) {
          finish('unsure', 'Monitoring timed out; completion unconfirmed.');
          return;
        }
        const packet = await nextReport(500);
        if (!packet) {
          continue;
        }
        if (packet.cmdId === CMD_GIMBAL_CALIBRATION_PROGRESS) {
          lastReportTime = Date.now();
        }
        if (apply(packet) !== 'continue') {
          return;
        }
      }
    } catch (error) {
      finish('failed', error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
      if (this.transport === transport) {
        for (const cleanupStep of plan.cleanup) {
          await this.flashWrite(transport, cleanupStep).catch((): undefined => undefined);
          await sleep(60);
        }
      }
      this.imuStopRequested = false;
      this.calibrating = false;
    }
  }

  // ── Battery ────────────────────────────────────────────────────────────────

  /**
   * Queries the battery once (four read requests) and returns
   * whatever answered within the wait. Read-only.
   */
  private async readBattery(): Promise<BatteryReading> {
    const battery: BatterySnapshot = {};
    const fail = (message: string): BatteryReading => ({ ok: false, message, at: Date.now(), battery });
    const transport = this.transport;
    if (!transport) {
      return fail('No aircraft connected.');
    }
    if (this.flashing) {
      return fail('A firmware flash is in progress.');
    }
    if (this.calibrating) {
      return fail('A calibration is running.');
    }
    if (this.batteryReading) {
      return fail('A battery read is already in progress.');
    }
    this.batteryReading = true;

    const answered = new Set<number>();
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((packet) => {
      if (
        packet.cmdSet === BATTERY_CMD_SET &&
        packet.cmdId >= BATTERY_CMD_STATIC &&
        packet.cmdId <= BATTERY_CMD_SERIAL &&
        packet.senderType === BATTERY_SENDER_TYPE &&
        applyBatteryReply(battery, packet.cmdId, packet.payload)
      ) {
        answered.add(packet.cmdId);
        wake?.();
      }
    });
    try {
      const steps = batteryRequestSteps();
      for (const requestStep of steps) {
        await this.flashWrite(transport, requestStep);
        await sleep(40);
      }
      const deadline = Date.now() + 900;
      while (answered.size < steps.length && Date.now() < deadline && this.transport === transport) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
      if (answered.size === 0) {
        return fail('The battery did not answer.');
      }
      return { ok: true, at: Date.now(), battery };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
      this.batteryReading = false;
    }
  }

  // ── Motor tests ────────────────────────────────────────────────────────────

  /** Why a motor test may not be sent right now, if anything stands in the way. */
  private motorTestBlock(): string | null {
    if (!this.transport) {
      return 'No aircraft connected.';
    }
    if (this.flashing) {
      return 'A firmware flash is in progress.';
    }
    if (this.calibrating) {
      return 'A calibration is running.';
    }
    return null;
  }

  /**
   * Sends one gimbal test command, enabling test control first if this
   * connection has not done so yet.
   */
  private async gimbalTestSend(
    allowUntested: boolean,
    build: (limits: GimbalLimits) => DumlStep,
  ): Promise<MotorTestResult> {
    const blocked = this.motorTestBlock();
    const transport = this.transport;
    if (blocked || !transport) {
      return { ok: false, message: blocked ?? 'No aircraft connected.' };
    }
    const support = gimbalTestSupport(this.state.modelCode);
    if (!support.validated && !allowUntested) {
      return { ok: false, message: 'The gimbal motor test has not been validated on this aircraft.' };
    }
    try {
      if (!this.gimbalTestUnsubscribe) {
        this.gimbalTestUnsubscribe = this.subscribe((packet) => {
          if (
            packet.senderType === DevType.GIMBAL &&
            packet.cmdSet === 0x04 &&
            (packet.cmdId === 0x14 || packet.cmdId === 0x1e)
          ) {
            this.gimbalTestAcks += 1;
          }
        });
      }
      if (!this.gimbalTestEnabled) {
        this.gimbalTestEnabled = true;
        try {
          await this.flashWrite(transport, gimbalEnableStep());
        } catch (error) {
          this.gimbalTestEnabled = false;
          throw error;
        }
      }
      await this.flashWrite(transport, build(support.limits));
      return { ok: true, message: '', acks: this.gimbalTestAcks };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Moves the gimbal to absolute angles, kept inside the aircraft's test travel. */
  private gimbalTestMove(
    axis: GimbalAxis | null,
    target: GimbalAngles,
    seconds: number,
    allowUntested: boolean,
  ): Promise<MotorTestResult> {
    if (axis !== null && !GIMBAL_AXES.some((known) => known.id === axis)) {
      return Promise.resolve({ ok: false, message: 'Unknown gimbal axis.' });
    }
    return this.gimbalTestSend(allowUntested, (limits) => {
      const bounded = { pitch: 0, roll: 0, yaw: 0 };
      for (const { id } of GIMBAL_AXES) {
        const wanted = Number(target?.[id]);
        bounded[id] = Math.max(limits[id].min, Math.min(limits[id].max, Number.isFinite(wanted) ? wanted : 0));
      }
      return gimbalAbsoluteStep(axis, bounded, Number.isFinite(seconds) ? seconds : 1);
    });
  }

  /** Nudges one gimbal axis; a delta of 0 holds it. */
  private gimbalTestJog(
    axis: GimbalAxis,
    delta: number,
    seconds: number,
    allowUntested: boolean,
  ): Promise<MotorTestResult> {
    if (!GIMBAL_AXES.some((known) => known.id === axis)) {
      return Promise.resolve({ ok: false, message: 'Unknown gimbal axis.' });
    }
    const bounded = Math.max(-GIMBAL_JOG_RATE, Math.min(GIMBAL_JOG_RATE, Number.isFinite(delta) ? delta : 0));
    return this.gimbalTestSend(allowUntested, () =>
      gimbalRelativeStep(axis, bounded, Number.isFinite(seconds) ? seconds : 0.1),
    );
  }

  /** Holds every gimbal axis where it is. Does nothing if no test has moved it. */
  private async gimbalTestStop(): Promise<MotorTestResult> {
    const transport = this.transport;
    if (!transport) {
      return { ok: false, message: 'No aircraft connected.' };
    }
    if (!this.gimbalTestEnabled) {
      return { ok: true, message: 'Nothing to stop.', acks: this.gimbalTestAcks };
    }
    try {
      for (const { id } of GIMBAL_AXES) {
        await this.flashWrite(transport, gimbalRelativeStep(id, 0, 0.1));
      }
      return { ok: true, message: 'All gimbal axes held.', acks: this.gimbalTestAcks };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Sends a flight-controller request and waits for the reply to that exact
   * request (same sequence number), so a late answer to an earlier one cannot
   * be mistaken for it.
   */
  private async propRequest(
    transport: BulkTransport,
    step: DumlStep,
    timeoutMs = 1200,
  ): Promise<Uint8Array | null> {
    let seq = -1;
    let unsubscribe: () => void = () => undefined;
    const reply = new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      unsubscribe = this.subscribe((packet) => {
        if (
          packet.senderInfo === step.receiver &&
          packet.cmdSet === step.cmdSet &&
          packet.cmdId === step.cmdId &&
          packet.seqNum === seq
        ) {
          clearTimeout(timer);
          resolve(packet.payload);
        }
      });
    });
    try {
      // flashWrite assigns the sequence number before its first await.
      const written = this.flashWrite(transport, step);
      seq = this.seqNum;
      await written;
      return await reply;
    } finally {
      unsubscribe();
    }
  }

  private async propWrite(
    transport: BulkTransport,
    hash: number[],
    value: number,
    width: 2 | 4,
  ): Promise<boolean> {
    return propWriteAccepted(await this.propRequest(transport, propWriteStep(hash, value, width)), value, width);
  }

  /** Ends a catalog-method test and puts its two parameters back. */
  private async propRestoreDefaults(transport: BulkTransport): Promise<void> {
    await this.propWrite(transport, PROP_PARAM_TIMER, 1, 2);
    await this.propWrite(transport, PROP_PARAM_OUTPUT, PROP_DEFAULT_OUTPUT, 2);
    await this.propWrite(transport, PROP_PARAM_TIMER, PROP_DEFAULT_TIMER, 2);
  }

  private async propFactory(transport: BulkTransport, open: boolean): Promise<void> {
    for (const step of propFactorySteps(open)) {
      await this.flashWrite(transport, step);
    }
    await sleep(PROP_FACTORY_SETTLE_MS);
    this.propFactoryOpen = open;
  }

  private emitPropTest(event: PropTestEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('drone:prop-test', event);
      }
    }
  }

  /** Waits out a spin, ending early on Stop or if the link drops. */
  private async propWait(transport: BulkTransport, endsAt: number): Promise<void> {
    while (!this.propStopRequested && this.transport === transport && Date.now() < endsAt) {
      await sleep(Math.min(100, Math.max(0, endsAt - Date.now())));
    }
  }

  /**
   * Catalog method: set the output level and timer, check that the flight
   * controller names the command as this motor's user test, then run it.
   * Returns why the motor was not run, or null once it has.
   */
  private async propSpinCatalog(
    transport: BulkTransport,
    motor: PropMotor,
    percent: number,
    seconds: number,
  ): Promise<string | null> {
    const fail = async (reason: string): Promise<string> => {
      await this.propRestoreDefaults(transport);
      return reason;
    };
    const accepted =
      (await this.propWrite(transport, PROP_PARAM_TIMER, 1, 2)) &&
      (await this.propWrite(transport, PROP_PARAM_OUTPUT, Math.round(percent * 100), 2)) &&
      (await this.propWrite(transport, PROP_PARAM_TIMER, Math.round((seconds * 1000) / PROP_TICK_MS), 2));
    if (!accepted) {
      return fail('the flight controller did not accept the test settings.');
    }
    const name = propCatalogName(await this.propRequest(transport, propCatalogStep(motor.ch)));
    if (name !== propCatalogExpected(motor.ch)) {
      return fail('the flight controller does not offer a motor test for this output, so the motor was not run.');
    }
    const run = await this.propRequest(transport, propRunStep(motor.ch));
    if (!run || run[0] !== 0) {
      return fail('the flight controller did not acknowledge the run command.');
    }
    const endsAt = Date.now() + seconds * 1000;
    this.emitPropTest({ motor: motor.n, phase: 'spinning', endsAt });
    await this.propWait(transport, endsAt);
    await this.propRestoreDefaults(transport);
    return null;
  }

  /**
   * Throttle method: write the motor's throttle and keep rewriting it inside
   * the watchdog window, then write zero.
   */
  private async propSpinThrottle(
    transport: BulkTransport,
    motor: PropMotor,
    percent: number,
    seconds: number,
  ): Promise<string | null> {
    const hash = propThrottleHash(motor.ch);
    const throttle = propThrottleValue(percent);
    if (!(await this.propWrite(transport, hash, throttle, 4))) {
      await this.propWrite(transport, hash, 0, 4);
      return 'the flight controller did not accept the throttle.';
    }
    const endsAt = Date.now() + seconds * 1000;
    this.emitPropTest({ motor: motor.n, phase: 'spinning', endsAt });
    while (!this.propStopRequested && this.transport === transport && Date.now() < endsAt) {
      const started = Date.now();
      await this.propWrite(transport, hash, throttle, 4);
      await sleep(Math.max(0, PROP_WATCHDOG_MS - (Date.now() - started)));
    }
    await this.propWrite(transport, hash, 0, 4);
    return null;
  }

  /** Spins the given motors one after another at a low output level. */
  private async runPropTest(
    motors: number[],
    percent: number,
    seconds: number,
    options: PropTestOptions,
  ): Promise<MotorTestResult> {
    const blocked = this.motorTestBlock();
    const transport = this.transport;
    if (blocked || !transport) {
      return { ok: false, message: blocked ?? 'No aircraft connected.' };
    }
    if (this.propTesting) {
      return { ok: false, message: 'A motor test is already running.' };
    }
    if (options?.propsRemoved !== true) {
      return { ok: false, message: 'Confirm that all propellers are removed first.' };
    }
    const support = propTestSupport(this.state.modelCode);
    if (!support.validated && options.allowUntested !== true) {
      return { ok: false, message: 'The propeller motor test has not been validated on this aircraft.' };
    }
    const list = (Array.isArray(motors) ? motors : []).map((n) => PROP_MOTORS.find((motor) => motor.n === n));
    if (list.length === 0 || list.length > PROP_MOTORS.length || list.some((motor) => !motor)) {
      return { ok: false, message: 'Unknown motor.' };
    }
    if (!(percent > 0 && percent <= PROP_MAX_PERCENT) || !(seconds > 0 && seconds <= PROP_MAX_SECONDS)) {
      return { ok: false, message: 'Output or duration is out of range.' };
    }

    this.propTesting = true;
    this.propStopRequested = false;
    this.propTestTouched = true;
    try {
      if (support.factoryMode && !this.propFactoryOpen) {
        await this.propFactory(transport, true);
      }
      for (const [index, motor] of (list as PropMotor[]).entries()) {
        if (index > 0) {
          await sleep(PROP_GAP_MS);
        }
        if (this.propStopRequested || this.transport !== transport) {
          break;
        }
        const failure =
          support.mode === 'throttle'
            ? await this.propSpinThrottle(transport, motor, percent, seconds)
            : await this.propSpinCatalog(transport, motor, percent, seconds);
        if (failure) {
          this.emitPropTest({ motor: motor.n, phase: 'failed', note: failure });
          return { ok: false, message: `M${motor.n}: ${failure}` };
        }
        if (this.propStopRequested) {
          this.emitPropTest({ motor: motor.n, phase: 'stopped' });
          break;
        }
        this.emitPropTest({ motor: motor.n, phase: 'done', note: `${percent} % · ${seconds} s` });
      }
      if (this.transport !== transport) {
        return { ok: false, message: 'The aircraft disconnected during the test.' };
      }
      if (this.propStopRequested) {
        return { ok: false, message: 'Motor test stopped.' };
      }
      return {
        ok: true,
        message:
          list.length === 1
            ? `M${(list[0] as PropMotor).n} ran at ${percent} % for ${seconds} s.`
            : `${list.length} motors ran one by one at ${percent} % for ${seconds} s each.`,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.propFactoryOpen && this.transport === transport) {
        await this.propFactory(transport, false).catch((): undefined => undefined);
      }
      this.propTesting = false;
    }
  }

  /**
   * Stops the propeller motors now. Only writes to the aircraft if a propeller
   * test has run on this connection, so there is something to stop or restore.
   */
  private async stopPropTest(): Promise<MotorTestResult> {
    this.propStopRequested = true;
    const transport = this.transport;
    if (!transport) {
      return { ok: false, message: 'No aircraft connected.' };
    }
    if (!this.propTestTouched) {
      return { ok: true, message: 'No motor test has run, nothing to stop.' };
    }
    try {
      if (propTestSupport(this.state.modelCode).mode === 'throttle') {
        for (const motor of PROP_MOTORS) {
          await this.propWrite(transport, propThrottleHash(motor.ch), 0, 4);
        }
        // A running test leaves factory mode itself once its loop sees the stop.
        if (!this.propTesting && this.propFactoryOpen) {
          await this.propFactory(transport, false);
        }
        return { ok: true, message: 'All motors set to zero.' };
      }
      await this.propRestoreDefaults(transport);
      return { ok: true, message: 'Motor test stopped and its settings restored.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Motor beep ─────────────────────────────────────────────────────────────

  /** Switches one motor's beep on or off; opens factory mode first where needed. */
  private async motorBeep(motorNumber: number, on: boolean, allowUntested: boolean): Promise<MotorTestResult> {
    const blocked = this.motorTestBlock() ?? (this.propTesting ? 'A propeller test is running.' : null);
    const transport = this.transport;
    if (blocked || !transport) {
      return { ok: false, message: blocked ?? 'No aircraft connected.' };
    }
    const motor = PROP_MOTORS.find((entry) => entry.n === motorNumber);
    if (!motor) {
      return { ok: false, message: 'Unknown motor.' };
    }
    const support = beepSupport(this.state.modelCode);
    if (on && !support.validated && !allowUntested) {
      return { ok: false, message: 'The motor beep was not validated on this aircraft.' };
    }
    try {
      if (on && support.factoryMode && !this.beepFactoryOpen) {
        await this.propFactory(transport, true);
        this.beepFactoryOpen = true;
      }
      await this.flashWrite(transport, beepStep(motor.ch, on));
      if (on) {
        this.beeping.add(motor.n);
      } else {
        this.beeping.delete(motor.n);
        await this.closeBeepFactory(transport);
      }
      return { ok: true, message: `M${motor.n} beep ${on ? 'on' : 'off'}.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Leaves the factory mode the beep opened, once no motor is beeping. */
  private async closeBeepFactory(transport: BulkTransport): Promise<void> {
    if (this.beepFactoryOpen && this.beeping.size === 0) {
      this.beepFactoryOpen = false;
      for (const factoryStep of propFactorySteps(false)) {
        await this.flashWrite(transport, factoryStep);
      }
    }
  }

  private async motorBeepStop(): Promise<MotorTestResult> {
    const transport = this.transport;
    if (!transport) {
      this.beeping.clear();
      return { ok: false, message: 'No aircraft connected.' };
    }
    if (this.beeping.size === 0 && !this.beepFactoryOpen) {
      return { ok: true, message: 'No motor is beeping.' };
    }
    try {
      for (const motor of PROP_MOTORS) {
        await this.flashWrite(transport, beepStep(motor.ch, false));
      }
      this.beeping.clear();
      await this.closeBeepFactory(transport);
      return { ok: true, message: 'All motors silenced.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Repairs ────────────────────────────────────────────────────────────────

  /**
   * Runs the gimbal IMU repair. The write to the calibration store
   * has to be acknowledged before anything after it is sent, so a gimbal that
   * refuses or ignores it is not put through a calibration for nothing.
   */
  private async repairGimbalImu(method: ImuRepairMethod): Promise<MotorTestResult> {
    const blocked = this.motorTestBlock() ?? (this.propTesting ? 'A propeller test is running.' : null);
    const transport = this.transport;
    if (blocked || !transport) {
      return { ok: false, message: blocked ?? 'No aircraft connected.' };
    }
    if (method !== 'value' && method !== 'calibrate') {
      return { ok: false, message: 'Unknown repair.' };
    }
    const choice = planImuRepair(method, this.state.modelCode, this.state.model);
    const plan = choice.plan;
    if (!plan) {
      return { ok: false, message: choice.reason ?? 'This repair is not available for this aircraft.' };
    }

    this.calibrating = true;
    const total = repairDurationMs(plan);
    let elapsed = 0;
    const publish = (phase: RepairState['phase'], message: string, percent?: number): void => {
      this.setState({
        repair: {
          kind: 'gimbal-imu',
          phase,
          percent: percent ?? Math.min(99, Math.round((elapsed / total) * 100)),
          message,
        },
      });
    };
    const fail = (message: string): MotorTestResult => {
      publish('failed', message);
      return { ok: false, message };
    };

    try {
      for (const [index, entry] of plan.steps.entries()) {
        if (this.transport !== transport) {
          return fail('The aircraft disconnected during the repair.');
        }
        publish('running', `${entry.label}…`);
        const reply = await this.flashSendStep(transport, entry.step, 2500);
        if (entry.write) {
          const more = index < plan.steps.length - 1 ? ' Nothing further was sent.' : '';
          if (!reply) {
            return fail(`The gimbal did not acknowledge the write, so it may not have been applied.${more}`);
          }
          if ((reply[0] ?? 0) !== 0) {
            return fail(`The gimbal refused the write (code ${reply[0]}).${more}`);
          }
        }
        elapsed += REPAIR_STEP_MS;
        const waitUntil = Date.now() + (entry.waitAfterMs ?? 0);
        while (Date.now() < waitUntil) {
          if (this.transport !== transport) {
            return fail('The aircraft disconnected during the repair.');
          }
          const slice = Math.min(500, waitUntil - Date.now());
          await sleep(slice);
          elapsed += slice;
          publish('running', `${entry.label}…`);
        }
      }
      const message =
        'Repair sent and acknowledged. Restart the aircraft, then read the fault codes again to see whether the fault has cleared.';
      publish('done', message, 100);
      return { ok: true, message };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.transport === transport) {
        for (const cleanupStep of plan.cleanup) {
          await this.flashWrite(transport, cleanupStep).catch((): undefined => undefined);
          await sleep(60);
        }
      }
      this.calibrating = false;
    }
  }

  /** Reads one module's serial number; undefined when it does not report one. */
  private async readModuleSerial(transport: BulkTransport, receiver: number): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reply = await this.flashSendStep(transport, serialReadStep(receiver), 900);
      const serial = reply ? serialFromReply(reply) : null;
      if (serial) {
        return serial;
      }
    }
    return undefined;
  }

  private async readSerials(): Promise<SerialRow[]> {
    const transport = this.transport;
    const rows: SerialRow[] = SERIAL_TARGETS.map((target) => ({
      component: target.id,
      label: target.label,
      writable: target.writable,
    }));
    if (!transport || this.flashing || this.calibrating) {
      return rows;
    }
    for (const row of rows) {
      const target = serialTarget(row.component);
      if (!target || this.transport !== transport) {
        break;
      }
      row.serial = await this.readModuleSerial(transport, target.receiver).catch((): undefined => undefined);
    }
    return rows;
  }

  /**
   * Writes a module's serial number: read the current one, enter factory mode,
   * write, leave factory mode, read again. Only a matching read-back counts as
   * success.
   */
  private async writeSerial(component: SerialComponent, value: string): Promise<SerialWriteResult> {
    const blocked = this.motorTestBlock() ?? (this.propTesting ? 'A propeller test is running.' : null);
    const transport = this.transport;
    if (blocked || !transport) {
      return { ok: false, message: blocked ?? 'No aircraft connected.' };
    }
    const target = serialTarget(component);
    if (!target || !target.writable) {
      return { ok: false, message: 'This module does not take a serial number write.' };
    }
    const serial = typeof value === 'string' ? value.trim() : '';
    const problem = serialProblem(serial);
    if (problem) {
      return { ok: false, message: problem };
    }

    this.calibrating = true;
    let before: string | undefined;
    try {
      before = await this.readModuleSerial(transport, target.receiver);
      if (before === undefined) {
        return {
          ok: false,
          message: `The ${target.label.toLowerCase()} did not report its current serial number, so nothing was written.`,
        };
      }
      if (before === serial) {
        return { ok: true, before, after: before, message: 'The module already has this serial number.' };
      }
      let code: number | undefined;
      try {
        for (const factoryStep of serialFactorySteps(true)) {
          await this.flashWrite(transport, factoryStep);
        }
        await sleep(SERIAL_FACTORY_SETTLE_MS);
        const reply = await this.flashSendStep(transport, serialWriteStep(target.receiver, serial), 2000);
        code = reply ? (reply[0] ?? 0) : undefined;
        await sleep(SERIAL_FACTORY_SETTLE_MS);
      } finally {
        if (this.transport === transport) {
          for (const factoryStep of serialFactorySteps(false)) {
            await this.flashWrite(transport, factoryStep).catch((): undefined => undefined);
          }
        }
      }
      await sleep(400);
      const after = await this.readModuleSerial(transport, target.receiver);
      if (after === serial) {
        return { ok: true, before, after, message: `Serial number written and read back. The previous one was ${before}.` };
      }
      const answer =
        code === undefined ? 'did not answer the write' : code === 0 ? 'acknowledged the write' : `refused the write (code ${code})`;
      return {
        ok: false,
        before,
        after,
        message: `The ${target.label.toLowerCase()} ${answer} and still reports ${after ?? 'no serial number'}.`,
      };
    } catch (error) {
      return { ok: false, before, message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.calibrating = false;
    }
  }

  // ── Full check ─────────────────────────────────────────────────────────────

  private emitDiagnosticProgress(done: number, label: string): void {
    const progress: DiagnosticProgress = { done, total: DIAGNOSTIC_STAGES.length, label };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('drone:diag-progress', progress);
      }
    }
  }

  /** Runs every read-only check in turn and returns one row per finding. */
  private async runDiagnostics(): Promise<DiagnosticReport | null> {
    const transport = this.transport;
    if (!transport || this.flashing || this.calibrating || this.diagnosing) {
      return null;
    }
    this.diagnosing = true;
    const checks: DiagnosticCheck[] = [];
    const linked = (): boolean => this.transport === transport;
    let stage = 0;
    const next = (): void => {
      this.emitDiagnosticProgress(stage, DIAGNOSTIC_STAGES[stage] ?? '');
      stage += 1;
    };
    try {
      next();
      const hms = await this.readHmsNow();
      const faults = this.hmsFaults();
      checks.push(...faultChecks(faults, hms.ok));

      next();
      let serial = this.state.serial;
      let cameraSerial = this.state.cameraSerial;
      if (linked() && !serial) {
        serial = await this.readDroneSerial(transport);
      }
      if (linked() && !cameraSerial) {
        cameraSerial = await this.readCameraSerial(transport);
      }
      checks.push(
        {
          group: 'Identity',
          name: 'Aircraft serial',
          status: serial ? 'ok' : 'warn',
          detail: serial ?? 'Not reported.',
        },
        {
          group: 'Identity',
          name: 'Camera serial',
          status: cameraSerial ? 'ok' : 'warn',
          detail: cameraSerial ?? 'Not reported.',
        },
      );

      next();
      for (const calStep of visionCalSteps()) {
        if (!linked()) break;
        const reply = await this.flashSendStep(transport, calStep, 1200);
        const code = reply ? (reply[0] ?? 0xff) : undefined;
        checks.push({
          group: 'Vision',
          name: `${receiverLabel(calStep.receiver)} calibration`,
          status: code === undefined ? 'info' : code === 0 ? 'ok' : 'fail',
          detail: code === undefined ? 'No answer.' : code === 0 ? 'Calibrated.' : `Not calibrated (code ${code}).`,
        });
      }

      next();
      const sensorRows: DiagnosticCheck[] = [];
      let sensorAnswers = 0;
      for (const sensor of VISION_SENSORS) {
        if (!linked()) break;
        const reply = await this.flashSendStep(transport, visionSensorStep(sensor.mask), 900);
        const sensorSerial = reply ? visionSensorSerial(reply) : undefined;
        if (reply) {
          sensorAnswers += 1;
        }
        sensorRows.push({
          group: 'Vision',
          name: `${sensor.name} sensor`,
          status: sensorSerial ? 'ok' : 'info',
          detail: sensorSerial ?? (reply ? 'No serial reported.' : 'No answer.'),
        });
      }
      checks.push(
        ...(sensorAnswers > 0
          ? sensorRows
          : [
              {
                group: 'Vision',
                name: 'Vision sensors',
                status: 'info' as const,
                detail: 'This aircraft did not answer the per-sensor query.',
              },
            ]),
      );

      next();
      const battery = linked() ? await this.readBattery() : null;
      checks.push(...batteryChecks(battery?.ok ? battery.battery : undefined));

      next();
      let radios = 0;
      const radioSteps = linkTestSteps();
      for (const radioStep of radioSteps) {
        if (!linked()) break;
        if (await this.flashSendStep(transport, radioStep, 1200)) {
          radios += 1;
        }
      }
      checks.push({
        group: 'Radio',
        name: 'Radio links',
        status: radios > 0 ? 'ok' : 'info',
        detail: `${radios} of ${radioSteps.length} answered.`,
      });
      this.emitDiagnosticProgress(DIAGNOSTIC_STAGES.length, 'Done');

      return {
        at: Date.now(),
        model: this.state.model,
        modelCode: this.state.modelCode,
        serial,
        cameraSerial,
        firmware: this.state.manifest?.formalVersion,
        modules: this.state.modules.map((module) => ({
          name: module.name,
          firmware: module.firmware,
          hardware: module.hardware,
        })),
        faults,
        battery: battery?.ok ? battery.battery : undefined,
        checks,
      };
    } catch (error) {
      console.log(`[drone] full check failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.diagnosing = false;
    }
  }

  private async saveReport(report: DiagnosticReport): Promise<ReportSaveResult> {
    if (!report || !Array.isArray(report.checks) || !Array.isArray(report.modules)) {
      return { ok: false, message: 'There is no report to save.' };
    }
    const window = BrowserWindow.getAllWindows()[0];
    const model = report.model ? report.model.replace(/[^A-Za-z0-9]+/g, '') : 'aircraft';
    const serial = report.serial ? `-${report.serial.replace(/[^A-Za-z0-9]+/g, '')}` : '';
    const options = {
      title: 'Save service report',
      defaultPath: `service-report-${model}${serial}-${reportFileStamp(report.at)}.txt`,
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { ok: false };
    }
    try {
      await writeFile(result.filePath, formatDiagnosticReport(report), 'utf8');
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Command console ────────────────────────────────────────────────────────

  private async consoleSend(request: ConsoleRequest): Promise<ConsoleReply> {
    const transport = this.transport;
    if (!transport) {
      return { ok: false, message: 'No aircraft connected.' };
    }
    if (this.flashing) {
      return { ok: false, message: 'A firmware flash is in progress.' };
    }
    if (this.calibrating) {
      return { ok: false, message: 'A calibration or repair is running.' };
    }
    const problem = consoleRequestProblem(request);
    if (problem) {
      return { ok: false, message: problem };
    }
    const expectReply = request.ackEnc !== 0x00;
    const startedAt = Date.now();
    try {
      const reply = await this.flashSendStep(
        transport,
        {
          sender: request.sender,
          receiver: request.receiver,
          ackEnc: request.ackEnc,
          cmdSet: request.cmdSet,
          cmdId: request.cmdId,
          payload: Uint8Array.from(request.payload),
          expectReply,
        },
        CONSOLE_REPLY_WAIT_MS,
      );
      if (!expectReply) {
        return { ok: true, message: 'Sent. No answer was requested.' };
      }
      if (!reply) {
        return { ok: false, message: 'Sent. No answer arrived.' };
      }
      return {
        ok: true,
        message: `Answered with ${reply.length} byte${reply.length === 1 ? '' : 's'}.`,
        reply: [...reply],
        ms: Date.now() - startedAt,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Starts or stops forwarding received frames to the console page, in batches. */
  private consoleWatch(on: boolean): void {
    this.consoleUnsubscribe?.();
    this.consoleUnsubscribe = null;
    if (this.consoleTimer) {
      clearInterval(this.consoleTimer);
      this.consoleTimer = null;
    }
    this.consoleBuffer = [];
    if (!on) {
      return;
    }
    this.consoleUnsubscribe = this.subscribe((packet) => {
      if (this.consoleBuffer.length >= CONSOLE_KEEP_FRAMES) {
        this.consoleBuffer.shift();
      }
      this.consoleBuffer.push({
        at: Date.now(),
        from: packet.senderInfo,
        to: packet.receiverInfo,
        cmdSet: packet.cmdSet,
        cmdId: packet.cmdId,
        ack: packet.packetType === 1,
        length: packet.payload.length,
        hex: hexBytes(packet.payload, CONSOLE_FRAME_BYTES),
      });
    });
    this.consoleTimer = setInterval(() => {
      if (this.consoleBuffer.length === 0) {
        return;
      }
      const frames = this.consoleBuffer;
      this.consoleBuffer = [];
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('drone:console-frames', frames);
        }
      }
    }, 200);
  }
}

let session: DroneSession | null = null;

export function startDroneSession(): void {
  if (!session) {
    session = new DroneSession();
    session.start();
  }
}

export async function stopDroneSession(): Promise<void> {
  await session?.stop();
}
