/**
 * Advanced (full automatic) gimbal calibration. It is the routine DJI Fly
 * calls "Advanced Gimbal Calibration":
 * one trigger (ZENMUSE 0x04/0x08) after which the gimbal reports percentage
 * progress on 0x04/0x30 until it reaches 100.
 *
 * The sequence around the trigger depends on the aircraft, and on some models
 * a command calibration must not be sent at all, so the plan is chosen from the
 * factory code / model name. Pure, so it can be
 * shared by the main process (to run it) and the renderer (to describe it).
 */
import type { DumlStep } from './flasher';

/** Host addresses commands are sent from: the default (PC index 1) and PC0. */
const PC1 = 0x2a;
const PC0 = 0x0a;

const FLIGHT_CONTROLLER = 0x03;
const GIMBAL = 0x04;
const OSD3 = 0x68;
const FACTORY4 = 0x8f;

const ACK_AFTER = 0x40;
const ACK_BEFORE = 0x20;

const CMD_SET_GENERAL = 0x00;
const CMD_SET_ZENMUSE = 0x04;

/** Trigger payloads: full auto routine, and the enterprise gimbal's variant. */
const TRIGGER_ADVANCED = 0x71;
const TRIGGER_ENTERPRISE = 0x00;

const ENTERPRISE_CODES = new Set(['WM265T', 'WM265E', 'WM265M']);
/** Models that calibrate only by reflashing service firmware. */
const FIRMWARE_ONLY_CODES = new Set(['WM160', 'WM161', 'WM162', 'WM163']);

export type AdvancedVariant = 'standard' | 'command' | 'neo2' | 'lito' | 'enterprise';

export interface AdvancedCalibrationPlan {
  variant: AdvancedVariant;
  /** Short description of the sequence, for the UI. */
  label: string;
  /** Steps sent before the trigger (factory mode, or the captured preamble). */
  prepare: DumlStep[];
  /** Pause between the preparation and the trigger. */
  pauseMs: number;
  trigger: DumlStep;
  /** How long to wait for the gimbal's first answer. */
  ackTimeoutMs: number;
  /** Typical duration, for the progress display. */
  expectMs: number;
  /** Whether the gimbal asks for the aircraft to be pointed up part-way. */
  asksPointUp: boolean;
  /**
   * True when this plan is only reached by overriding the firmware-only block
   * (a command calibration on a model DJI services by reflashing). For testing.
   */
  restricted?: boolean;
}

/**
 * True when a plan puts the aircraft into factory mode. Nothing takes it out
 * again afterwards: the aircraft stays in factory mode once the run ends.
 */
export const entersFactoryMode = (plan: AdvancedCalibrationPlan): boolean =>
  plan.prepare.some((entry) => entry.cmdSet === CMD_SET_GENERAL && entry.cmdId === 0x44);

/** Either a plan to run, or the reason the routine must not be sent. */
export interface AdvancedCalibrationChoice {
  plan?: AdvancedCalibrationPlan;
  reason?: string;
}

function step(sender: number, receiver: number, ackEnc: number, cmdSet: number, cmdId: number, payload: number[]): DumlStep {
  return { sender, receiver, ackEnc, cmdSet, cmdId, payload: Uint8Array.from(payload), expectReply: false };
}

/** GENERAL 0x44 factory-mode request: 0x80, a sub-type byte, then a C string. */
function factory(receiver: number, tag: 'start_factory' | 'stop_factory', subType: number, ackEnc: number): DumlStep {
  const text = [...tag].map((c) => c.charCodeAt(0));
  return step(PC1, receiver, ackEnc, CMD_SET_GENERAL, 0x44, [0x80, subType, ...text, 0x00]);
}

const trigger = (sender: number, ackEnc: number, value: number): DumlStep =>
  step(sender, GIMBAL, ackEnc, CMD_SET_ZENMUSE, 0x08, [value]);

/** The two-frame preamble captured ahead of the trigger on newer aircraft. */
const capturedPreamble = (): DumlStep[] => [
  step(PC0, OSD3, ACK_AFTER, CMD_SET_GENERAL, 0x51, [0x04]),
  step(PC0, OSD3, ACK_AFTER, CMD_SET_GENERAL, 0x36, [0x03, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
];

const has = (name: string, word: RegExp): boolean => word.test(name);

function isFirmwareOnly(code: string, name: string): boolean {
  if (FIRMWARE_ONLY_CODES.has(code)) {
    return true;
  }
  if (!name || name.includes('pro')) {
    return false;
  }
  if (name.includes('mini') && has(name, /\b5\b/)) {
    return false;
  }
  return name.includes('4k') || name.includes('mini');
}

/** True for aircraft that must not be sent a command calibration at all. */
export const isFirmwareOnlyModel = (modelCode?: string, modelName?: string): boolean =>
  isFirmwareOnly((modelCode ?? '').toUpperCase(), (modelName ?? '').toLowerCase());

function isCommandModel(code: string, name: string): boolean {
  if (['WA150', 'WA140', 'WA341', 'WA345'].some((prefix) => code.startsWith(prefix))) {
    return true;
  }
  if (name.includes('air') && has(name, /\b3s?\b/)) {
    return true;
  }
  return name.includes('mini') && has(name, /\b[45]\b/);
}

const isAir3 = (code: string, name: string): boolean =>
  code.startsWith('WA341') || code.startsWith('WA345') || (name.includes('air') && has(name, /\b3s?\b/));

const isNeo2 = (code: string, name: string): boolean =>
  code.startsWith('WA020') || (name.includes('neo') && has(name, /\b2\b/));

const isLito = (code: string, name: string): boolean =>
  code.startsWith('WA152') || (name.includes('lito') && has(name, /\b1\b/));

/**
 * Chooses the advanced-calibration sequence for an aircraft, or explains why
 * it must not be run. The model has to be known: without it there is no way to
 * rule out the models a command calibration can harm.
 */
export function planAdvancedCalibration(
  modelCode?: string,
  modelName?: string,
  /**
   * When true, a model that is normally refused because it calibrates by
   * reflashing (firmware-only) is given the standard command plan instead, so
   * it can be tested. The returned plan is marked `restricted`. The model must
   * still be identified; an unknown aircraft is never calibrated.
   */
  allowRestricted = false,
): AdvancedCalibrationChoice {
  const code = (modelCode ?? '').toUpperCase();
  const name = (modelName ?? '').toLowerCase();
  if (!code && !name) {
    return { reason: 'The aircraft model has not been identified yet.' };
  }
  const firmwareOnly = isFirmwareOnly(code, name);

  if (isLito(code, name)) {
    return {
      plan: {
        variant: 'lito',
        label: 'Direct calibration, two phases',
        prepare: capturedPreamble(),
        pauseMs: 0,
        trigger: trigger(PC0, ACK_BEFORE, TRIGGER_ADVANCED),
        ackTimeoutMs: 12000,
        expectMs: 110000,
        asksPointUp: true,
      },
    };
  }
  if (isNeo2(code, name)) {
    return {
      plan: {
        variant: 'neo2',
        label: 'Direct calibration in factory mode',
        prepare: [factory(OSD3, 'start_factory', 0x0a, ACK_AFTER)],
        pauseMs: 500,
        trigger: trigger(PC0, ACK_BEFORE, TRIGGER_ADVANCED),
        ackTimeoutMs: 12000,
        expectMs: 180000,
        asksPointUp: true,
      },
    };
  }
  if (isCommandModel(code, name)) {
    return {
      plan: {
        variant: 'command',
        label: 'Direct calibration, three stages',
        prepare: capturedPreamble(),
        pauseMs: 0,
        trigger: trigger(PC0, ACK_BEFORE, TRIGGER_ADVANCED),
        ackTimeoutMs: 12000,
        expectMs: 100000,
        asksPointUp: isAir3(code, name),
      },
    };
  }
  if (firmwareOnly && !allowRestricted) {
    return {
      reason:
        'This model calibrates by reflashing its service firmware, not by command. A command calibration can put its camera into download mode, so it is not sent.',
    };
  }
  if (ENTERPRISE_CODES.has(code)) {
    return {
      plan: {
        variant: 'enterprise',
        label: 'Enterprise gimbal, factory mode through the flight controller',
        prepare: [factory(FLIGHT_CONTROLLER, 'start_factory', 0x0e, ACK_BEFORE)],
        pauseMs: 1500,
        trigger: trigger(PC1, ACK_BEFORE, TRIGGER_ENTERPRISE),
        ackTimeoutMs: 40000,
        expectMs: 60000,
        asksPointUp: false,
      },
    };
  }
  return {
    plan: {
      variant: 'standard',
      label: 'Factory mode, then full auto calibration',
      prepare: [factory(FACTORY4, 'start_factory', 0x0a, ACK_AFTER), factory(OSD3, 'start_factory', 0x0a, ACK_AFTER)],
      pauseMs: 500,
      trigger: trigger(PC1, ACK_AFTER, TRIGGER_ADVANCED),
      ackTimeoutMs: 8000,
      expectMs: 95000,
      asksPointUp: false,
      restricted: firmwareOnly,
    },
  };
}
