/**
 * One-shot DUML service commands: factory mode, ESC fault repair,
 * remote-controller pairing, camera-serial read and RF link test.
 *
 * Every frame here is CRC-verified; the builders are pure so they can be
 * unit-tested against those exact frames.
 * Factory mode, ESC repair and pairing change device state — the UI confirms
 * them before sending.
 */
import type { DumlStep } from './flasher';

export type ServiceAction =
  | 'factory-enter'
  | 'factory-exit'
  | 'esc-repair'
  | 'rc-pair'
  | 'camera-serials'
  | 'link-test'
  | 'battery-info'
  | 'imu-status'
  | 'vision-scan'
  | 'fc-param-count'
  | 'camera-info'
  | 'vision-cal'
  | 'tof-reset'
  | 'vision-recover'
  | 'aircraft-restart'
  | 'aircraft-power-off';

/** A service step, optionally followed by a pause before the next one. */
export type ServiceStep = DumlStep & { waitAfterMs?: number };

const SENDER = 0x2a;
/** ack-after-exec, no encryption. */
const CONTROL = 0x40;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

const ascii = (text: string): Uint8Array => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

function step(
  receiver: number,
  cmdSet: number,
  cmdId: number,
  payload: Uint8Array,
  expectReply = true,
): DumlStep {
  return { sender: SENDER, receiver, ackEnc: CONTROL, cmdSet, cmdId, payload, expectReply };
}

// ── Factory mode (GENERAL 0x44, payload 0x80 0x0A + ASCII tag) ───────────────
// Sent to the gimbal/camera receiver 0x8F and then 0x68.

const FACTORY_RECEIVERS = [0x8f, 0x68];

function factorySteps(tag: string): DumlStep[] {
  const payload = concat(Uint8Array.of(0x80, 0x0a), ascii(tag));
  return FACTORY_RECEIVERS.map((receiver) => step(receiver, 0x00, 0x44, payload));
}

export const factoryEnterSteps = (): DumlStep[] => factorySteps('start_factory');
export const factoryExitSteps = (): DumlStep[] => factorySteps('stop_factory');

// ── ESC fault repair (cmd set 0x03 / id 0xF3 to the flight controller) ───────

export const escRepairSteps = (): DumlStep[] => [step(0x03, 0x03, 0xf3, new Uint8Array(0))];

// ── Remote-controller pairing (cmd set 0x06 / id 0x2F, payload 0x01) ─────────

export const pairSteps = (): DumlStep[] => [step(0x09, 0x06, 0x2f, Uint8Array.of(0x01))];

// ── Camera serial read (CAMERA 0xB5 to camera 0x01) ──────────────────────────
// payload 00000000 reads the single camera; 03000000 reads multi-camera rigs.

export const cameraSerialSteps = (multiple = false): DumlStep[] => [
  step(0x01, 0x02, 0xb5, multiple ? Uint8Array.of(0x03, 0x00, 0x00, 0x00) : new Uint8Array(4)),
];

// ── RF link test (GENERAL 0x5F to three radios; payload = recvType + FFFFFFFF)─

const LINK_TEST_RECEIVERS = [0xc3, 0x04, 0x12];

export const linkTestSteps = (): DumlStep[] =>
  LINK_TEST_RECEIVERS.map((receiver) =>
    step(receiver, 0x00, 0x5f, Uint8Array.of(receiver & 0x1f, 0xff, 0xff, 0xff, 0xff)),
  );

// ── Read-only diagnostics ────────────────────────────────────────────────────
//
// These change nothing on the aircraft; they query a subsystem and report the
// reply bytes. Receivers and commands:
//   battery     SMART_BATTERY 0x0D / 0x02 to the battery (0x0B), payload 0x01
//   imu status  GENERAL 0x00 / 0x52 to the flight controller (0x03)
//   vision/ToF  GENERAL 0x00 / 0x51 serial read to the monocular (0x11) and
//               binocular (0x12) vision sensors, payload 0x04
//   fc params   FLYC 0x03 / 0xE0 parameter-table info to the FC, payload 00 00

const BATTERY = 0x0b;
const FLIGHT_CONTROLLER = 0x03;
const CAMERA = 0x01;
const VISION_MONOCULAR = 0x11;
const VISION_BINOCULAR = 0x12;

export const batteryInfoSteps = (): DumlStep[] => [
  step(BATTERY, 0x0d, 0x02, Uint8Array.of(0x01)),
];

export const imuStatusSteps = (): DumlStep[] => [
  step(FLIGHT_CONTROLLER, 0x00, 0x52, new Uint8Array(0)),
];

export const visionScanSteps = (): DumlStep[] =>
  [VISION_MONOCULAR, VISION_BINOCULAR].map((receiver) =>
    step(receiver, 0x00, 0x51, Uint8Array.of(0x04)),
  );

export const fcParamCountSteps = (): DumlStep[] => [
  step(FLIGHT_CONTROLLER, 0x03, 0xe0, Uint8Array.of(0x00, 0x00)),
];

// ── Camera info: firmware (GENERAL 0x00/0x01) + serial (CAMERA 0x02/0xB5) ─────
// Calibration state itself is not a direct query — a camera/mainboard mismatch
// surfaces as an HMS fault, so the UI points there for calibration status.

export const cameraInfoSteps = (): DumlStep[] => [
  step(CAMERA, 0x00, 0x01, new Uint8Array(0)),
  step(CAMERA, 0x02, 0xb5, new Uint8Array(4)),
];

// ── Vision calibration status (0x0A/0x01 to each vision module) ──────────────
// Reply byte 0 is the calibration result: 0 = calibrated/pass, else an error
// code.

export const visionCalSteps = (): DumlStep[] =>
  [VISION_MONOCULAR, VISION_BINOCULAR].map((receiver) => step(receiver, 0x0a, 0x01, new Uint8Array(0)));

// ── ToF calibration reset (0x24/0x28 trigger, then 0x24/0x26 re-query) ───────
// "Fix ToF Sensors" sequence: send a reset to the monocular ToF then re-query
// the sensor. Changes device state, so the UI confirms it first.

export const tofResetSteps = (): DumlStep[] => [
  step(VISION_MONOCULAR, 0x24, 0x28, Uint8Array.of(0x01, 0x00, 0x00, 0x00)),
  step(
    VISION_MONOCULAR,
    0x24,
    0x26,
    Uint8Array.of(15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 161, 0, 1),
  ),
];

// ── Vision sensor recovery ("Fix Vision Sensors") ────────────────────────────
// Factory mode on the gimbal/camera module, a reset to the binocular vision
// module (0x24/0x20), then a re-query of each of the eight sensors. Factory
// mode is left again afterwards, also when a step in between fails.

/** Sensor ids the vision module reports serials for, as a two-byte bitmask. */
export const VISION_SENSORS: readonly { mask: number; name: string }[] = [
  { mask: 1, name: 'Front left' },
  { mask: 2, name: 'Front right' },
  { mask: 4, name: 'Rear left' },
  { mask: 8, name: 'Rear right' },
  { mask: 64, name: 'Bottom' },
  { mask: 128, name: 'Top' },
  { mask: 1024, name: 'ToF left' },
  { mask: 2048, name: 'ToF right' },
];

export const visionSensorStep = (mask: number): DumlStep =>
  step(
    VISION_BINOCULAR,
    0x24,
    0x26,
    Uint8Array.of(15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 161, (mask >> 8) & 0xff, mask & 0xff),
  );

/** The sensor a per-sensor query step asks about. */
export const visionSensorOf = (query: DumlStep): number =>
  ((query.payload[13] ?? 0) << 8) | (query.payload[14] ?? 0);

/**
 * Reads a per-sensor reply: the serial follows the four header bytes as text.
 * A sensor that is absent answers with a placeholder instead of a serial.
 */
export function visionSensorSerial(reply: Uint8Array): string | undefined {
  const text = String.fromCharCode(...[...reply.slice(4)].filter((byte) => byte >= 32 && byte <= 126));
  return text.length >= 6 && !text.startsWith('???') ? text : undefined;
}

const FACTORY_MODULE = 0x8f;

const factoryStepFor = (receiver: number, tag: string): DumlStep =>
  step(receiver, 0x00, 0x44, concat(Uint8Array.of(0x80, 0x0a), ascii(tag)));

export const visionRecoverSteps = (): ServiceStep[] => [
  { ...factoryStepFor(FACTORY_MODULE, 'start_factory'), waitAfterMs: 500 },
  { ...step(VISION_BINOCULAR, 0x24, 0x20, Uint8Array.of(0x01, 0x00, 0x00, 0x00)), waitAfterMs: 1000 },
  ...VISION_SENSORS.map((sensor): ServiceStep => visionSensorStep(sensor.mask)),
];

// ── Restart / power off (GENERAL 0x0B to the battery) ────────────────────────
// Byte 1 selects the action: 1 restarts the aircraft, 2 switches it off.

const powerStep = (mode: number): DumlStep =>
  step(BATTERY, 0x00, 0x0b, Uint8Array.of(0, mode, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));

export const restartSteps = (): DumlStep[] => [powerStep(1)];
export const powerOffSteps = (): DumlStep[] => [powerStep(2)];

/** Steps sent after an action whether or not it completed. */
export function serviceCleanupSteps(action: ServiceAction): DumlStep[] {
  return action === 'vision-recover' ? [factoryStepFor(FACTORY_MODULE, 'stop_factory')] : [];
}

/** Read-only actions: they only query the aircraft and never change its state. */
export function isReadService(action: ServiceAction): boolean {
  return (
    action === 'camera-serials' ||
    action === 'link-test' ||
    action === 'battery-info' ||
    action === 'imu-status' ||
    action === 'vision-scan' ||
    action === 'fc-param-count' ||
    action === 'camera-info' ||
    action === 'vision-cal'
  );
}

/** The steps for a service action. */
export function serviceSteps(action: ServiceAction): ServiceStep[] {
  switch (action) {
    case 'factory-enter':
      return factoryEnterSteps();
    case 'factory-exit':
      return factoryExitSteps();
    case 'esc-repair':
      return escRepairSteps();
    case 'rc-pair':
      return pairSteps();
    case 'camera-serials':
      return cameraSerialSteps();
    case 'link-test':
      return linkTestSteps();
    case 'battery-info':
      return batteryInfoSteps();
    case 'imu-status':
      return imuStatusSteps();
    case 'vision-scan':
      return visionScanSteps();
    case 'fc-param-count':
      return fcParamCountSteps();
    case 'camera-info':
      return cameraInfoSteps();
    case 'vision-cal':
      return visionCalSteps();
    case 'tof-reset':
      return tofResetSteps();
    case 'vision-recover':
      return visionRecoverSteps();
    case 'aircraft-restart':
      return restartSteps();
    case 'aircraft-power-off':
      return powerOffSteps();
    default:
      return [];
  }
}

/** Whether an action changes device state (and so warrants a confirmation). */
export function isDestructiveService(action: ServiceAction): boolean {
  return (
    action === 'factory-enter' ||
    action === 'factory-exit' ||
    action === 'esc-repair' ||
    action === 'rc-pair' ||
    action === 'tof-reset' ||
    action === 'vision-recover' ||
    action === 'aircraft-restart' ||
    action === 'aircraft-power-off'
  );
}

/**
 * Extracts a plausible serial number from a camera reply: the longest run of
 * printable identifier characters, as the existing serial read does.
 */
export function serialFromReply(payload: Uint8Array): string | null {
  const text = String.fromCharCode(...payload);
  const runs = text.match(/[0-9A-Za-z_-]{6,}/g);
  if (!runs) {
    return null;
  }
  return runs.reduce((a, b) => (b.length > a.length ? b : a));
}
