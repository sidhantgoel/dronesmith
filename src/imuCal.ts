/**
 * IMU calibration.
 *
 * Although presented as the aircraft's six-position IMU calibration, what is
 * sent is the gimbal's calibration command (ZENMUSE 0x04/0x08) with mode 5,
 * inside factory mode. Nothing goes to the flight controller: a copy addressed
 * to "FC" would use device 0x02, which is the mobile-app address and reaches no
 * module, so that copy is not sent here. Progress comes back on ZENMUSE 0x30 as
 * [percent, step], where the step is the position the aircraft should be held
 * in.
 *
 * Pure, so the main process (to run it) and the renderer (to describe it) can
 * share it. Not confirmed on hardware.
 */
import type { DumlStep } from './flasher';
import { isFirmwareOnlyModel } from './gimbalCal';

/** Default host address (PC index 1). */
const PC1 = 0x2a;
const GIMBAL = 0x04;
const OSD3 = 0x68;
const FACTORY4 = 0x8f;
const ACK_AFTER = 0x40;

const CMD_SET_GENERAL = 0x00;
const CMD_SET_ZENMUSE = 0x04;
const CMD_FACTORY_MODE = 0x44;
const CMD_CALIBRATION = 0x08;

/** Calibration mode byte sent for this routine. */
const MODE_IMU = 0x05;

export interface ImuPosition {
  /** Step value the aircraft reports while it wants this position. */
  id: number;
  label: string;
  hint: string;
}

export const IMU_POSITIONS: ImuPosition[] = [
  { id: 0, label: 'Level, top up', hint: 'On a flat surface, right side up.' },
  { id: 1, label: 'Inverted, top down', hint: 'Upside down on a flat surface.' },
  { id: 2, label: 'Nose down', hint: 'Standing on its nose, tail pointing up.' },
  { id: 3, label: 'Nose up', hint: 'Standing on its tail, nose pointing up.' },
  { id: 4, label: 'Left side', hint: 'Lying on its left side.' },
  { id: 5, label: 'Right side', hint: 'Lying on its right side.' },
];

export interface ImuCalibrationPlan {
  /** Steps sent before the request (enter factory mode). */
  prepare: DumlStep[];
  /** Pause between the preparation and the request. */
  pauseMs: number;
  trigger: DumlStep;
  /** Steps sent once the run ends, whatever the outcome (leave factory mode). */
  cleanup: DumlStep[];
  /** How long to wait for the aircraft's first answer. */
  ackTimeoutMs: number;
}

/** Either a plan to run, or the reason the routine must not be sent. */
export interface ImuCalibrationChoice {
  plan?: ImuCalibrationPlan;
  reason?: string;
}

function step(receiver: number, cmdSet: number, cmdId: number, payload: number[]): DumlStep {
  return {
    sender: PC1,
    receiver,
    ackEnc: ACK_AFTER,
    cmdSet,
    cmdId,
    payload: Uint8Array.from(payload),
    expectReply: false,
  };
}

function factory(receiver: number, tag: 'start_factory' | 'stop_factory'): DumlStep {
  const text = [...tag].map((c) => c.charCodeAt(0));
  return step(receiver, CMD_SET_GENERAL, CMD_FACTORY_MODE, [0x80, 0x0a, ...text, 0x00]);
}

/**
 * Chooses the IMU-calibration sequence, or explains why it must not be run.
 * The same sequence applies to every aircraft; the one restriction added here
 * is the block the gimbal page applies to command calibrations on models that
 * calibrate by firmware only, since this is the same command.
 */
export function planImuCalibration(modelCode?: string, modelName?: string): ImuCalibrationChoice {
  if (!modelCode && !modelName) {
    return { reason: 'The aircraft model has not been identified yet.' };
  }
  if (isFirmwareOnlyModel(modelCode, modelName)) {
    return {
      reason:
        'This model calibrates by reflashing its service firmware, not by command. A command calibration can put its camera into download mode, so it is not sent.',
    };
  }
  return {
    plan: {
      prepare: [factory(FACTORY4, 'start_factory'), factory(OSD3, 'start_factory')],
      pauseMs: 500,
      trigger: step(GIMBAL, CMD_SET_ZENMUSE, CMD_CALIBRATION, [MODE_IMU]),
      cleanup: [factory(FACTORY4, 'stop_factory'), factory(OSD3, 'stop_factory')],
      ackTimeoutMs: 10000,
    },
  };
}

export interface ImuProgress {
  percent: number;
  /** Position being asked for, when the step byte names one of the six. */
  position?: number;
}

/** Decodes a progress report: [percent, step]. */
export function parseImuProgress(payload: Uint8Array): ImuProgress | null {
  if (payload.length < 1) {
    return null;
  }
  const stepValue = payload.length >= 2 ? payload[1] : 0;
  return {
    percent: payload[0],
    position: stepValue < IMU_POSITIONS.length ? stepValue : undefined,
  };
}
