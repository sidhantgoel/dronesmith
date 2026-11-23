/**
 * Live flight-controller status, for the telemetry page.
 *
 * The flight controller pushes FLYC 0x03/0x43 several times a second without
 * being asked. Its first 37 bytes follow the classic OSD layout, which a
 * capture from a Mavic 3 confirms for the attitude, state word and satellite
 * fields (the aircraft was on a bench, so position, height and speed were all
 * zero there and rest on the classic layout alone):
 *
 *   0  longitude  f64, radians        24 pitch  i16, 0.1°
 *   8  latitude   f64, radians        26 roll   i16, 0.1°
 *   16 height     i16, 0.1 m          28 yaw    i16, 0.1°
 *   18 speed x    i16, 0.1 m/s        30 flight mode in the low 7 bits
 *   20 speed y    i16, 0.1 m/s        32 state word u32
 *   22 speed z    i16, 0.1 m/s        36 satellites
 *
 * Bytes past 37 differ between firmware generations and are not decoded.
 *
 * An alternative layout (mode at 0, satellites at 1, integer coordinates at 2)
 * does not fit the observed frames, and 0x03/0xCE is not ESC telemetry: on the
 * aircraft that frame comes from the vision module. Neither is used here.
 */

export interface FcStatus {
  /** Degrees; undefined while the aircraft has no position. */
  latitude?: number;
  longitude?: number;
  /** Metres above the take-off point. */
  height: number;
  /** m/s over the ground. */
  horizontalSpeed: number;
  /** m/s, with the sign the aircraft reports. */
  verticalSpeed: number;
  /** Degrees. */
  pitch: number;
  roll: number;
  yaw: number;
  flightMode: number;
  /** Name of the flight mode, for the modes whose code is known. */
  flightModeName?: string;
  motorsOn: boolean;
  /** Undefined when the state is neither of the two known values. */
  inAir?: boolean;
  /** 0–5. */
  gpsLevel: number;
  satellites: number;
}

const FLIGHT_MODES: Record<number, string> = {
  0: 'Manual',
  1: 'Attitude',
  6: 'Positioning (normal)',
  10: 'Assisted take-off',
  11: 'Auto take-off',
  12: 'Auto landing',
  13: 'Attitude landing',
  14: 'Waypoint',
  15: 'Return to home',
  17: 'Joystick',
  31: 'Sport',
};

const MIN_LENGTH = 37;
const DEGREES = 180 / Math.PI;

export function decodeFcStatus(payload: Uint8Array): FcStatus | null {
  if (payload.length < MIN_LENGTH) {
    return null;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const longitude = view.getFloat64(0, true);
  const latitude = view.getFloat64(8, true);
  const hasPosition =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    (latitude !== 0 || longitude !== 0) &&
    Math.abs(latitude) <= Math.PI / 2 &&
    Math.abs(longitude) <= Math.PI;
  const speedX = view.getInt16(18, true) / 10;
  const speedY = view.getInt16(20, true) / 10;
  const flightMode = payload[30] & 0x7f;
  const state = view.getUint32(32, true);
  const airState = (state >>> 1) & 0x03;
  return {
    latitude: hasPosition ? latitude * DEGREES : undefined,
    longitude: hasPosition ? longitude * DEGREES : undefined,
    height: view.getInt16(16, true) / 10,
    horizontalSpeed: Math.hypot(speedX, speedY),
    verticalSpeed: view.getInt16(22, true) / 10,
    pitch: view.getInt16(24, true) / 10,
    roll: view.getInt16(26, true) / 10,
    yaw: view.getInt16(28, true) / 10,
    flightMode,
    flightModeName: FLIGHT_MODES[flightMode],
    motorsOn: ((state >>> 3) & 1) === 1,
    inAir: airState === 2 ? true : airState === 0 ? false : undefined,
    gpsLevel: (state >>> 18) & 0x0f,
    satellites: payload[36],
  };
}
