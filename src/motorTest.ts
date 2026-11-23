/**
 * Bench tests for the gimbal motors and the propeller motors.
 *
 * Gimbal: one enable (ZENMUSE 0x04/0x1e), then angle commands (0x04/0x14) that
 * move a single axis while the other two are ignored.
 *
 * Propellers: the flight controller spins one motor at a time. Older flight
 * controllers run a built-in "MotorN user test" command with an output level
 * and a timer set through two parameters; newer ones take a per-motor throttle
 * parameter that has to be rewritten continuously or the motor stops.
 *
 * Pure, so the main process (to run the tests) and the renderer (to describe
 * and bound them) share one definition.
 */
import type { DumlStep } from './flasher';

/** Host addresses to send from: the default (PC index 1) and PC0. */
const PC1 = 0x2a;
const PC0 = 0x0a;

const FLIGHT_CONTROLLER = 0x03;
const GIMBAL = 0x04;
const OSD3 = 0x68;
const FACTORY4 = 0x8f;

const ACK_AFTER = 0x40;

const CMD_SET_GENERAL = 0x00;
const CMD_SET_FLYC = 0x03;
const CMD_SET_ZENMUSE = 0x04;

function step(
  sender: number,
  receiver: number,
  cmdSet: number,
  cmdId: number,
  payload: number[],
  expectReply: boolean,
): DumlStep {
  return { sender, receiver, ackEnc: ACK_AFTER, cmdSet, cmdId, payload: Uint8Array.from(payload), expectReply };
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const i16 = (value: number): number[] => u16(clamp(Math.round(value), -32768, 32767) & 0xffff);

const matches = (code: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => code.startsWith(prefix));

// ── Gimbal motors ────────────────────────────────────────────────────────────

export type GimbalAxis = 'pitch' | 'roll' | 'yaw';
export type GimbalAngles = Record<GimbalAxis, number>;

export interface AxisLimit {
  min: number;
  max: number;
}

export type GimbalLimits = Record<GimbalAxis, AxisLimit>;

export const GIMBAL_AXES: readonly { id: GimbalAxis; label: string; motor: number }[] = [
  { id: 'pitch', label: 'Pitch', motor: 1 },
  { id: 'roll', label: 'Roll', motor: 2 },
  { id: 'yaw', label: 'Yaw', motor: 3 },
];

export const GIMBAL_ZERO: GimbalAngles = { pitch: 0, roll: 0, yaw: 0 };
export const GIMBAL_SWEEP_SPEEDS = [5, 10, 15, 30, 45, 60];
/**
 * Amount sent on every jog tick, and how often a tick is sent. The gimbal
 * moves at roughly this many degrees per second while the ticks keep coming.
 */
export const GIMBAL_JOG_RATE = 1.5;
export const GIMBAL_JOG_INTERVAL_MS = 250;
export const GIMBAL_JOG_SECONDS = 0.3;

/** Control-byte bits: bit 0 = absolute angles, the others ignore one axis. */
const ABSOLUTE = 0x01;
const IGNORE_BIT: Record<GimbalAxis, number> = { pitch: 0x08, roll: 0x04, yaw: 0x02 };
const IGNORE_ALL = 0x0e;

/** Travel the test may command, per aircraft the routine was validated on. */
const GIMBAL_LIMITS: readonly [string, GimbalLimits][] = [
  ['WM162', { pitch: { min: -90, max: 60 }, roll: { min: -135, max: 45 }, yaw: { min: -30, max: 30 } }],
  ['WA152', { pitch: { min: -40, max: 30 }, roll: { min: -20, max: 20 }, yaw: { min: -20, max: 20 } }],
  ['WA140', { pitch: { min: -75, max: 45 }, roll: { min: -20, max: 20 }, yaw: { min: -20, max: 20 } }],
  ['WA150', { pitch: { min: -75, max: 45 }, roll: { min: -20, max: 20 }, yaw: { min: -20, max: 20 } }],
];

/** The tightest validated travel, used for an aircraft that was never tested. */
const GIMBAL_LIMITS_UNTESTED: GimbalLimits = {
  pitch: { min: -40, max: 30 },
  roll: { min: -20, max: 20 },
  yaw: { min: -20, max: 20 },
};

export interface GimbalTestSupport {
  /** True when the routine was validated on this aircraft. */
  validated: boolean;
  limits: GimbalLimits;
}

export function gimbalTestSupport(modelCode?: string): GimbalTestSupport {
  const code = (modelCode ?? '').toUpperCase();
  const known = GIMBAL_LIMITS.find(([prefix]) => code.startsWith(prefix));
  return known ? { validated: true, limits: known[1] } : { validated: false, limits: GIMBAL_LIMITS_UNTESTED };
}

/** Move duration in the command's unit of 0.1 s. */
const tenths = (seconds: number): number => clamp(Math.round(seconds * 10), 1, 255);

export const gimbalEnableStep = (): DumlStep => step(PC0, GIMBAL, CMD_SET_ZENMUSE, 0x1e, [0x01], false);

/**
 * Moves to absolute angles over `seconds`. With an axis only that axis moves
 * and the other two are ignored; without one all three are driven.
 */
export function gimbalAbsoluteStep(axis: GimbalAxis | null, target: GimbalAngles, seconds: number): DumlStep {
  const control = (axis ? IGNORE_ALL & ~IGNORE_BIT[axis] : 0) | ABSOLUTE;
  return step(
    PC0,
    GIMBAL,
    CMD_SET_ZENMUSE,
    0x14,
    [...i16(target.yaw * 10), ...i16(target.roll * 10), ...i16(target.pitch * 10), control, tenths(seconds)],
    false,
  );
}

/**
 * Non-absolute command for one axis: keeps it moving while `amount` is
 * non-zero, and an amount of 0 holds the axis where it is.
 */
export function gimbalRelativeStep(axis: GimbalAxis, amount: number, seconds: number): DumlStep {
  const moved: GimbalAngles = { ...GIMBAL_ZERO, [axis]: amount };
  return step(
    PC0,
    GIMBAL,
    CMD_SET_ZENMUSE,
    0x14,
    [
      ...i16(moved.yaw * 10),
      ...i16(moved.roll * 10),
      ...i16(moved.pitch * 10),
      IGNORE_ALL & ~IGNORE_BIT[axis],
      tenths(seconds),
    ],
    false,
  );
}

/**
 * Waypoints for a sweep: from the current angle to the minimum, across to the
 * maximum, then back to centre, in strides the gimbal covers at `speed` °/s.
 */
export function gimbalSweepPlan(
  from: number,
  min: number,
  max: number,
  speed: number,
): { points: number[]; stepSeconds: number } {
  const stride = Math.min(20, speed * 3.6);
  const points: number[] = [];
  const leg = (start: number, end: number): void => {
    const direction = Math.sign(end - start);
    for (let at = start + direction * stride; direction * (end - at) > 0; at += direction * stride) {
      points.push(at);
    }
    points.push(end);
  };
  leg(from, min);
  leg(min, max);
  leg(max, 0);
  return { points, stepSeconds: stride / speed };
}

// ── Propeller motors ─────────────────────────────────────────────────────────

export interface PropMotor {
  /** DJI motor number, 1–4. */
  n: number;
  /** Flight-controller output channel, 0–3. */
  ch: number;
  pos: 'FR' | 'FL' | 'RL' | 'RR';
  dir: 'CW' | 'CCW';
}

export const PROP_MOTORS: readonly PropMotor[] = [
  { n: 1, ch: 0, pos: 'FR', dir: 'CCW' },
  { n: 2, ch: 1, pos: 'FL', dir: 'CW' },
  { n: 3, ch: 2, pos: 'RL', dir: 'CCW' },
  { n: 4, ch: 3, pos: 'RR', dir: 'CW' },
];

export const PROP_OUTPUTS = [5, 10, 15, 20];
export const PROP_DURATIONS = [0.5, 1, 2, 3, 5, 10];
export const PROP_MAX_PERCENT = 20;
export const PROP_MAX_SECONDS = 10;
/** Pause between motors when several are tested in a row. */
export const PROP_GAP_MS = 600;

/** Aircraft that take a per-motor throttle parameter instead of the test command. */
const THROTTLE_CODES = ['WA152', 'WA140', 'WA150', 'WA521'];
/** Aircraft whose throttle parameters only respond in factory mode. */
const FACTORY_MODE_CODES = ['WA521'];
const PROP_VALIDATED_CODES = ['WM162', ...THROTTLE_CODES];

export type PropTestMode = 'catalog' | 'throttle';

export interface PropTestSupport {
  /** True when the routine was validated on this aircraft. */
  validated: boolean;
  mode: PropTestMode;
  factoryMode: boolean;
}

/**
 * How the propeller test runs on an aircraft. One that was never tested gets
 * the catalog method, which only spins a motor after the flight controller has
 * confirmed by name that the command is its user motor test.
 */
export function propTestSupport(modelCode?: string): PropTestSupport {
  const code = (modelCode ?? '').toUpperCase();
  return {
    validated: matches(code, PROP_VALIDATED_CODES),
    mode: matches(code, THROTTLE_CODES) ? 'throttle' : 'catalog',
    factoryMode: matches(code, FACTORY_MODE_CODES),
  };
}

/** Parameter hashes of the test's output level and its timer (catalog method). */
export const PROP_PARAM_OUTPUT = [0x20, 0x0a, 0x52, 0x24];
export const PROP_PARAM_TIMER = [0x06, 0xac, 0x2a, 0xf9];
export const PROP_DEFAULT_OUTPUT = 500;
export const PROP_DEFAULT_TIMER = 20;
/** The timer parameter counts in ticks of this length. */
export const PROP_TICK_MS = 20;

/** The throttle has to be rewritten at least this often or the motor stops. */
export const PROP_WATCHDOG_MS = 130;
export const PROP_FACTORY_SETTLE_MS = 400;
/** Raw throttle value that corresponds to the 20 % ceiling. */
const PROP_THROTTLE_MAX = 2571;

export const propThrottleHash = (ch: number): number[] => [0x8f, 0x74, 0x1c + ch, 0xaf];

export const propThrottleValue = (percent: number): number =>
  Math.min(PROP_THROTTLE_MAX, Math.round((percent / PROP_MAX_PERCENT) * PROP_THROTTLE_MAX));

/** FLYC 0xF9: write a parameter by hash. The reply echoes the hash and value. */
export function propWriteStep(hash: number[], value: number, width: 2 | 4): DumlStep {
  return step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xf9, [...hash, ...(width === 2 ? u16(value) : u32(value))], true);
}

/** True when a 0xF9 reply reports success and echoes the value that was sent. */
export function propWriteAccepted(reply: Uint8Array | null, value: number, width: 2 | 4): boolean {
  if (!reply || reply[0] !== 0 || reply.length < 5 + width) {
    return false;
  }
  const echoed =
    width === 2
      ? reply[5] | (reply[6] << 8)
      : (reply[5] | (reply[6] << 8) | (reply[7] << 16) | (reply[8] << 24)) >>> 0;
  return echoed === value;
}

/** FLYC 0xE9: asks for the name of the command behind a motor's test entry. */
export const propCatalogStep = (ch: number): DumlStep =>
  step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xe9, u16(0xfffe - (ch + 1)), true);

/** FLYC 0xE9: runs a motor's test entry. */
export const propRunStep = (ch: number): DumlStep =>
  step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xe9, u16(ch + 1), true);

/** The name the flight controller must report before a motor is run. */
export const propCatalogExpected = (ch: number): string => `Motor${ch} user test`;

export function propCatalogName(reply: Uint8Array | null): string {
  if (!reply) {
    return '';
  }
  return String.fromCharCode(...[...reply.slice(4)].filter((byte) => byte >= 32 && byte < 127));
}

// ── Motor beep ───────────────────────────────────────────────────────────────
// ESC beep: the flight controller makes one ESC
// sound its motor (FLYC 0x03/0xED, [4 = start | 3 = stop, channel]), which
// tells the four motors apart without spinning them.

const BEEP_VALIDATED_CODES = ['WM162', 'WA152', 'WA140', 'WA150', 'WA521'];
const BEEP_FACTORY_CODES = ['WA521'];
const BEEP_START = 4;
const BEEP_STOP = 3;

export interface BeepSupport {
  /** True when the routine was validated on this aircraft. */
  validated: boolean;
  /** True when the aircraft stays silent unless factory mode is open. */
  factoryMode: boolean;
}

export function beepSupport(modelCode?: string): BeepSupport {
  const code = (modelCode ?? '').toUpperCase();
  return { validated: matches(code, BEEP_VALIDATED_CODES), factoryMode: matches(code, BEEP_FACTORY_CODES) };
}

export const beepStep = (ch: number, on: boolean): DumlStep =>
  step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xed, [on ? BEEP_START : BEEP_STOP, ch & 0x03], false);

/** GENERAL 0x44 factory-mode request to the two modules that gate the throttle. */
export function propFactorySteps(open: boolean): DumlStep[] {
  const tag = [...(open ? 'start_factory' : 'stop_factory')].map((c) => c.charCodeAt(0));
  return [FACTORY4, OSD3].map((receiver) =>
    step(PC1, receiver, CMD_SET_GENERAL, 0x44, [0x80, 0x0a, ...tag, 0x00], false),
  );
}
