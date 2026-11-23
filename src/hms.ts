/**
 * Health Management System (HMS) fault decoding.
 *
 * The flight
 * controller pushes GENERAL-set 0x21 / id 0x06 frames whose payload is a
 * 3-byte header followed by 6-byte fault records. Each record is a 32-bit
 * little-endian fault code plus a sensor index and a severity level. The code
 * resolves to human-readable text through the bundled hms.json database
 * (keys like "fpv_tip_0x16100089").
 *
 * This is read-only: the app only listens for the pushes.
 */

/** Binary HMS snapshot push (0x21/0x06), a 3-byte header + 6-byte records. */
export const HMS_CMD_SET = 0x21;
export const HMS_CMD_ID = 0x06;

/**
 * 0x03/0xCE push. This channel is also treated as a fault
 * channel carrying one 6-byte record [code u32][sensor u8][level u8] per frame.
 * That is unverified here: on the one aircraft captured it is a fixed 28-byte
 * status frame from the vision module, which the code-class check rejects, so
 * this path contributes nothing there. Kept because it is harmless when the
 * frame is not a fault record.
 */
export const HMS_TELEMETRY_CMD_SET = 0x03;
export const HMS_TELEMETRY_CMD_ID = 0xce;

/**
 * Gimbal self-check status: the gimbal (sender type 0x04) broadcasts
 * GENERAL 0x00/0xF1 with a little-endian u32 bitmask. Captured as 00 00 00 00
 * for the first frames after power-up, then 80 00 00 00 on an aircraft
 * reporting "gimbal self-check bit 7" = error 40021 (gimbal IMU
 * data mismatch). Only bit 7's meaning is known.
 */
export const GIMBAL_SELFCHECK_CMD_SET = 0x00;
export const GIMBAL_SELFCHECK_CMD_ID = 0xf1;
export const GIMBAL_SENDER_TYPE = 0x04;

/**
 * Flight-controller status push (0x03/0x43), the classic 70-byte OSD layout:
 * attitude at 24..29, a u32 state word at 32 whose bits 18..21 are the 0–5 GPS
 * signal level, and the satellite count at 36.
 */
export const FC_STATUS_CMD_SET = 0x03;
export const FC_STATUS_CMD_ID = 0x43;
export const FC_SENDER_TYPE = 0x03;

const HEADER_LENGTH = 3;
const RECORD_LENGTH = 6;

export interface HmsFault {
  /** 32-bit fault code, e.g. 0x16100089. */
  code: number;
  /** Zero-padded hex form, e.g. "0x16100089". */
  codeHex: string;
  /** Severity level reported by the aircraft (higher is worse). */
  level: number;
  /** Which sensor instance the fault refers to. */
  sensorIndex: number;
  /** Subsystem the code belongs to, from its device-class byte. */
  module: string;
  /** Resolved English description, or a placeholder when unknown. */
  text: string;
  /**
   * True for a condition derived from live status pushes (gimbal self-check,
   * GNSS quality) rather than an HMS catalog record. These come and go with the
   * status frames instead of accumulating.
   */
  live?: boolean;
}

/**
 * A plausible HMS code has its device-class (high) byte in 0x10–0x1F. This
 * filters telemetry bytes that happen to align into non-fault 32-bit values.
 */
export function looksLikeHmsCode(code: number): boolean {
  const deviceClass = (code >>> 24) & 0xff;
  return deviceClass >= 0x10 && deviceClass <= 0x1f;
}

/** Maps a code's device-class byte to a readable subsystem name. */
export function moduleForCode(code: number): string {
  switch ((code >>> 24) & 0xff) {
    case 0x16:
      return 'Flight controller';
    case 0x1a:
      return 'Vision system';
    case 0x1d:
      return 'Gimbal';
    case 0x1c:
      return 'Camera';
    case 0x11:
    case 0x12:
      return 'Vision sensor';
    case 0x15:
      return 'ESC / motor';
    case 0x17:
      return 'Remote controller';
    default:
      return 'Aircraft';
  }
}

/** Severity label for an HMS level. */
export function hmsLevelLabel(level: number): string {
  switch (level) {
    case 0:
      return 'Notice';
    case 1:
      return 'Notice';
    case 2:
      return 'Caution';
    case 3:
      return 'Warning';
    default:
      return level >= 4 ? 'Serious' : `Level ${level}`;
  }
}

/**
 * Decodes an HMS push payload into its fault records. `resolve` maps a code to
 * its description (from hms.json). Returns an empty array for the "no faults"
 * push (header only).
 */
export function decodeHmsPush(
  payload: Uint8Array,
  resolve: (code: number) => string | undefined,
): HmsFault[] {
  const faults: HmsFault[] = [];
  for (let off = HEADER_LENGTH; off + RECORD_LENGTH <= payload.length; off += RECORD_LENGTH) {
    const code =
      ((payload[off] |
        (payload[off + 1] << 8) |
        (payload[off + 2] << 16) |
        (payload[off + 3] << 24)) >>>
      0);
    // The 0x21/0x06 snapshot is a structured record list, so every non-empty
    // record is a real fault — do NOT apply the looksLikeHmsCode heuristic here
    // (it is only needed to sift the mixed 0x03/0xCE telemetry stream). Filtering
    // it dropped valid codes whose class byte falls outside 0x10–0x1F.
    if (code === 0) {
      continue;
    }
    const sensorIndex = payload[off + 4];
    const level = payload[off + 5];
    const codeHex = `0x${code.toString(16).padStart(8, '0')}`;
    faults.push({
      code,
      codeHex,
      level,
      sensorIndex,
      module: moduleForCode(code),
      text: resolve(code) ?? `Unknown fault ${codeHex}`,
    });
  }
  return faults;
}

/**
 * Decodes one FC telemetry (0x03/0xCE) frame into a single fault record, or null
 * when the frame does not carry a plausible HMS code. The record layout is
 * [code u32 LE][sensor u8][level u8] at the start of the payload.
 */
export function decodeHmsTelemetry(
  payload: Uint8Array,
  resolve: (code: number) => string | undefined,
): HmsFault | null {
  if (payload.length < RECORD_LENGTH) {
    return null;
  }
  const code =
    ((payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0);
  if (!looksLikeHmsCode(code)) {
    return null;
  }
  const codeHex = `0x${code.toString(16).padStart(8, '0')}`;
  return {
    code,
    codeHex,
    level: payload[5],
    sensorIndex: payload[4],
    module: moduleForCode(code),
    text: resolve(code) ?? `Unknown fault ${codeHex}`,
  };
}

/** GPS signal levels below this (of 5) are reported as weak. */
const GNSS_WEAK_BELOW = 3;

/**
 * Turns a gimbal self-check bitmask frame into live fault rows: bit 7 is error
 * 40021; any other set bit is listed by number, since its meaning is unknown.
 */
export function decodeGimbalSelfCheck(payload: Uint8Array): HmsFault[] {
  if (payload.length < 4) {
    return [];
  }
  const mask = (payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0;
  const faults: HmsFault[] = [];
  for (let bit = 0; bit < 32; bit += 1) {
    if (((mask >>> bit) & 1) === 0) {
      continue;
    }
    if (bit === 7) {
      faults.push({
        code: 40021,
        codeHex: '40021',
        level: 2,
        sensorIndex: 0,
        module: 'Gimbal (self-check)',
        text: 'Gimbal IMU data mismatch (gimbal self-check bit 7).',
        live: true,
      });
    } else {
      faults.push({
        code: 0,
        codeHex: `GIMBAL-BIT${bit}`,
        level: 1,
        sensorIndex: 0,
        module: 'Gimbal (self-check)',
        text: `Gimbal self-check flag set (bit ${bit}); its meaning is not identified.`,
        live: true,
      });
    }
  }
  return faults;
}

/**
 * Reads the GPS level and satellite count from a flight-controller status push
 * and returns a live row when the signal is weak, or null when it is fine or
 * the frame is too short to carry the fields.
 */
export function decodeGnssStatus(payload: Uint8Array): HmsFault | null {
  if (payload.length < 37) {
    return null;
  }
  const state =
    (payload[32] | (payload[33] << 8) | (payload[34] << 16) | (payload[35] << 24)) >>> 0;
  const level = (state >>> 18) & 0x0f;
  const satellites = payload[36];
  if (level >= GNSS_WEAK_BELOW) {
    return null;
  }
  return {
    code: 0,
    codeHex: 'GNSS',
    level: 2,
    sensorIndex: 0,
    module: 'GNSS / positioning',
    text: `GPS / GNSS signal weak: quality ${level}/5, ${satellites} satellite${satellites === 1 ? '' : 's'}.`,
    live: true,
  };
}

/**
 * Builds a code→text resolver from the parsed hms.json object. Tries the
 * "fpv_tip_" device class first (covers aircraft), then "dock_tip_".
 */
export function makeHmsResolver(
  db: Record<string, { en?: string } | string>,
): (code: number) => string | undefined {
  const text = (entry: { en?: string } | string | undefined): string | undefined => {
    if (!entry) return undefined;
    return typeof entry === 'string' ? entry : entry.en;
  };
  return (code: number): string | undefined => {
    const hex = code.toString(16).padStart(8, '0');
    return text(db[`fpv_tip_0x${hex}`]) ?? text(db[`dock_tip_0x${hex}`]);
  };
}
