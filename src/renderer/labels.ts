import type { CalibrationKind, CalibrationState } from '../types';

export const CALIBRATION_TITLES: Record<CalibrationKind, string> = {
  jointCoarse: 'Joint Coarse',
  linearHall: 'Linear Hall',
  advanced: 'Advanced (auto)',
};

export const PHASE_LABELS: Record<CalibrationState['phase'], string> = {
  running: 'Running',
  pass: 'Passed',
  unsure: 'Unconfirmed',
  failed: 'Failed',
};
