/**
 * Repairs that write to the aircraft.
 *
 * Gimbal IMU repair (fault 40021, "gimbal IMU data mismatch"). There are two
 * routines for it, both writing to the gimbal's IMU calibration store
 * (ZENMUSE 0x04/0x36):
 *
 *   value      one value is written and the gimbal is left to settle. On the
 *              Mini 4 Pro a complete 156-byte block is written instead; that
 *              block is a fixed copy taken from another aircraft, not data
 *              belonging to the one being repaired.
 *   calibrate  the value is written from the PC0 address and a coarse joint
 *              calibration follows, twice over.
 *
 * Neither reads the old data first and no read command is known, so the write
 * cannot be undone from here.
 *
 * Serial numbers. A module's serial is written with GENERAL 0x00/0x51 and
 * sub-command 5 (sub-command 4 reads it) inside factory mode. The module
 * addresses used here are the real ones (see gimbalCal.ts), and the write is
 * confirmed by reading the serial back.
 *
 * Pure, so the main process and the renderer share one definition.
 */
import type { DumlStep } from './flasher';
import { isFirmwareOnlyModel } from './gimbalCal';

const PC1 = 0x2a;
const PC0 = 0x0a;

const CAMERA = 0x01;
const FLIGHT_CONTROLLER = 0x03;
const GIMBAL = 0x04;
const CENTER_BOARD = 0x05;
const BATTERY = 0x0b;
const OSD3 = 0x68;
const FACTORY4 = 0x8f;

const ACK_AFTER = 0x40;
const ACK_BEFORE = 0x20;

const CMD_SET_GENERAL = 0x00;
const CMD_SET_CAMERA = 0x02;
const CMD_SET_ZENMUSE = 0x04;

const CMD_FACTORY = 0x44;
const CMD_SERIAL = 0x51;
const CMD_GIMBAL_CALIBRATE = 0x08;
const CMD_GIMBAL_IMU_PREPARE = 0x1d;
const CMD_GIMBAL_IMU_WRITE = 0x36;

function step(
  sender: number,
  receiver: number,
  ackEnc: number,
  cmdSet: number,
  cmdId: number,
  payload: number[],
  expectReply = false,
): DumlStep {
  return { sender, receiver, ackEnc, cmdSet, cmdId, payload: Uint8Array.from(payload), expectReply };
}

const text = (value: string): number[] => [...value].map((c) => c.charCodeAt(0));

const factoryStep = (receiver: number, open: boolean, subType = 0x0a, ackEnc = ACK_AFTER): DumlStep =>
  step(PC1, receiver, ackEnc, CMD_SET_GENERAL, CMD_FACTORY, [
    0x80,
    subType,
    ...text(open ? 'start_factory' : 'stop_factory'),
    0x00,
  ]);

// ── Gimbal IMU repair ────────────────────────────────────────────────────────

export type ImuRepairMethod = 'value' | 'calibrate';

/** One step of a repair, with the text shown while it runs and the pause after it. */
export interface RepairStep {
  step: DumlStep;
  label: string;
  waitAfterMs?: number;
  /** True for the step that writes to the calibration store. */
  write?: boolean;
}

export interface ImuRepairPlan {
  steps: RepairStep[];
  /** Sent when the run ends, however it ends. */
  cleanup: DumlStep[];
  /** True when the plan writes a whole calibration block taken from another aircraft. */
  foreignBlock: boolean;
  /** True when the gimbal moves through a calibration during the run. */
  moves: boolean;
}

export interface ImuRepairChoice {
  plan?: ImuRepairPlan;
  /** Why the repair is not offered, when it is not. */
  reason?: string;
}

/** The value written: 0.99966 as a little-endian float. */
const REPAIR_VALUE = [0x42, 0xe9, 0x7f, 0x3f];

/** Mini 4 Pro block: 39 floats (near-identity matrices and scale factors). */
const MINI4PRO_BLOCK_HEX =
  'b8e57f3fc72de63c89d2de39bc07e8bc2ee67f3fd66ebb3be65ab4ba4a792dbb47ff7f3ffce17f3fcf65ea3c4d2ec639bc22f8bc' +
  'ebe57f3f66d9133b52d243ba41ba583b6d00803f9c53c938368fc3b97b690a38bd3706b882a8fbb87233dcb8f6cf533941d7beb8' +
  'f6cfd3b89692e5bba12de73b348037bc3a3b19bd76896a3c9a5d77bc3a02803ff5d77f3f43ca7f3f001f803f9a41803fe010803f';

export const MINI4PRO_BLOCK: readonly number[] = (MINI4PRO_BLOCK_HEX.match(/.{2}/g) ?? []).map((pair) =>
  parseInt(pair, 16),
);

const ENTERPRISE_CODES = new Set(['WM265T', 'WM265E', 'WM265M']);

function isMini4Pro(code: string, name: string): boolean {
  return code.startsWith('WA140') || (name.includes('mini') && /\b4\b/.test(name));
}

const prepare = (): DumlStep => step(PC1, GIMBAL, ACK_AFTER, CMD_SET_ZENMUSE, CMD_GIMBAL_IMU_PREPARE, [0x43], true);

const writeValue = (sender: number, payload: readonly number[]): DumlStep =>
  step(sender, GIMBAL, ACK_AFTER, CMD_SET_ZENMUSE, CMD_GIMBAL_IMU_WRITE, [...payload], true);

/** Read-only warm-up before the repair (module versions and serials). */
const identify = (receivers: number[], cmdId: number, payload: number[]): RepairStep[] =>
  receivers.map((receiver) => ({
    step: step(PC1, receiver, ACK_AFTER, CMD_SET_GENERAL, cmdId, payload),
    label: 'Reading the aircraft identity',
  }));

export function planImuRepair(method: ImuRepairMethod, modelCode?: string, modelName?: string): ImuRepairChoice {
  const code = (modelCode ?? '').toUpperCase();
  const name = (modelName ?? '').toLowerCase();
  if (!code && !name) {
    return { reason: 'The aircraft model is not identified yet.' };
  }

  if (method === 'value') {
    if (isMini4Pro(code, name)) {
      const warmUp = [...identify([0x1f], 0x01, []), ...identify([OSD3], CMD_SERIAL, [0x04])];
      warmUp[warmUp.length - 1].waitAfterMs = 2000;
      return {
        plan: {
          steps: [
            ...warmUp,
            { step: prepare(), label: 'Preparing the gimbal', waitAfterMs: 3000 },
            {
              step: writeValue(PC1, MINI4PRO_BLOCK),
              label: 'Writing the calibration block',
              waitAfterMs: 6000,
              write: true,
            },
          ],
          cleanup: [],
          foreignBlock: true,
          moves: false,
        },
      };
    }
    const warmUp = [...identify([0x1f, 0x28], 0x01, []), ...identify([OSD3, 0xc3], CMD_SERIAL, [0x04])];
    warmUp[warmUp.length - 1].waitAfterMs = 3000;
    return {
      plan: {
        steps: [
          ...warmUp,
          {
            step: step(PC1, CAMERA, ACK_AFTER, CMD_SET_CAMERA, 0xb5, [0, 0, 0, 0]),
            label: 'Reading the camera serial',
            waitAfterMs: 3500,
          },
          { step: writeValue(PC1, REPAIR_VALUE), label: 'Writing the repair value', waitAfterMs: 6000, write: true },
        ],
        cleanup: [],
        foreignBlock: false,
        moves: false,
      },
    };
  }

  if (ENTERPRISE_CODES.has(code)) {
    return {
      plan: {
        steps: [
          {
            step: factoryStep(FLIGHT_CONTROLLER, true, 0x0e, ACK_BEFORE),
            label: 'Entering factory mode',
            waitAfterMs: 1500,
          },
          { step: prepare(), label: 'Preparing the gimbal' },
          {
            step: step(PC1, GIMBAL, ACK_AFTER, CMD_SET_ZENMUSE, 0x68, [0x2e, 0x02, 0x7f, 0x00]),
            label: 'Preparing the gimbal',
          },
          { step: writeValue(PC0, REPAIR_VALUE), label: 'Writing the repair value', write: true },
          {
            step: step(PC1, GIMBAL, ACK_BEFORE, CMD_SET_ZENMUSE, CMD_GIMBAL_CALIBRATE, [0x00]),
            label: 'Calibrating the gimbal',
            waitAfterMs: 40000,
          },
        ],
        cleanup: [
          factoryStep(FLIGHT_CONTROLLER, false, 0x0e, ACK_BEFORE),
          factoryStep(FACTORY4, false),
          factoryStep(OSD3, false),
        ],
        foreignBlock: false,
        moves: true,
      },
    };
  }

  if (isFirmwareOnlyModel(modelCode, modelName)) {
    return {
      reason:
        'This aircraft must not be sent a command calibration, so the repair that recalibrates is not available on it.',
    };
  }

  const pass = (n: number): RepairStep[] => [
    { step: writeValue(PC0, REPAIR_VALUE), label: `Writing the repair value (pass ${n} of 2)`, write: true },
    {
      step: step(PC0, GIMBAL, ACK_BEFORE, CMD_SET_ZENMUSE, CMD_GIMBAL_CALIBRATE, [0x01]),
      label: `Calibrating the gimbal (pass ${n} of 2)`,
      waitAfterMs: 18000,
    },
  ];
  return {
    plan: {
      steps: [{ step: prepare(), label: 'Preparing the gimbal' }, ...pass(1), ...pass(2)],
      cleanup: [factoryStep(FACTORY4, false), factoryStep(OSD3, false)],
      foreignBlock: false,
      moves: true,
    },
  };
}

/** Time allowed for each step's own exchange, on top of its pause. */
export const REPAIR_STEP_MS = 150;

/** Total time a plan takes, for the progress bar. */
export const repairDurationMs = (plan: ImuRepairPlan): number =>
  plan.steps.reduce((total, entry) => total + (entry.waitAfterMs ?? 0) + REPAIR_STEP_MS, 0);

// ── Serial numbers ───────────────────────────────────────────────────────────

export type SerialComponent = 'aircraft' | 'camera' | 'flight-controller' | 'gimbal' | 'center-board' | 'battery';

export interface SerialTarget {
  id: SerialComponent;
  label: string;
  receiver: number;
  /** True when a write is offered for this module. */
  writable: boolean;
}

export const SERIAL_TARGETS: readonly SerialTarget[] = [
  { id: 'aircraft', label: 'Aircraft', receiver: OSD3, writable: false },
  { id: 'camera', label: 'Camera', receiver: CAMERA, writable: true },
  { id: 'flight-controller', label: 'Flight controller', receiver: FLIGHT_CONTROLLER, writable: true },
  { id: 'gimbal', label: 'Gimbal', receiver: GIMBAL, writable: true },
  { id: 'center-board', label: 'Center board', receiver: CENTER_BOARD, writable: true },
  { id: 'battery', label: 'Battery', receiver: BATTERY, writable: false },
];

export const serialTarget = (id: string): SerialTarget | undefined =>
  SERIAL_TARGETS.find((target) => target.id === id);

export const SERIAL_MIN_LENGTH = 6;
export const SERIAL_MAX_LENGTH = 24;
const SERIAL_PAD_LENGTH = 16;

/** Returns why a serial cannot be written, or null when it can. */
export function serialProblem(value: string): string | null {
  if (value.length < SERIAL_MIN_LENGTH || value.length > SERIAL_MAX_LENGTH) {
    return `A serial number has ${SERIAL_MIN_LENGTH} to ${SERIAL_MAX_LENGTH} characters.`;
  }
  if (!/^[0-9A-Z]+$/.test(value)) {
    return 'A serial number uses only the digits 0–9 and the capital letters A–Z.';
  }
  return null;
}

export const serialReadStep = (receiver: number): DumlStep =>
  step(PC1, receiver, ACK_AFTER, CMD_SET_GENERAL, CMD_SERIAL, [0x04], true);

export function serialWriteStep(receiver: number, serial: string): DumlStep {
  const bytes = text(serial);
  while (bytes.length < SERIAL_PAD_LENGTH) {
    bytes.push(0);
  }
  return step(PC1, receiver, ACK_AFTER, CMD_SET_GENERAL, CMD_SERIAL, [0x05, ...bytes], true);
}

export const serialFactorySteps = (open: boolean): DumlStep[] => [factoryStep(FACTORY4, open), factoryStep(OSD3, open)];
export const SERIAL_FACTORY_SETTLE_MS = 500;
