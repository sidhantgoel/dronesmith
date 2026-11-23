/**
 * DJI firmware flashing over DUML — a faithful TypeScript port of the DUML
 * upgrade routines of the reference servicing tool (the Python functions
 * Upgrade_Device / Upgrade_New_MINI2 / Upgrade_New_AIR2 / Upgrade_M3).
 *
 * This module is pure protocol: it builds the exact DUML steps and parses the
 * upgrade-status reports, with no device or UI dependency, so the byte layout
 * can be unit-tested against the original. The orchestration (sending the
 * steps over the transport and reporting progress) lives in drone.ts.
 *
 * DANGER: flashing is irreversible and can brick an aircraft. Every step here
 * writes to the device. The sequences are reproduced exactly from the original;
 * do not "improve" the byte layouts.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';

// ── Routing ────────────────────────────────────────────────────────────────

export type FlashFamily = 'legacy-mini' | 'legacy-air' | 'new-m3';

export interface FlashRoute {
  /** The engine's internal drone-type name (e.g. "MAVIC3"). */
  droneType: string;
  family: FlashFamily;
  /** Raw DUML address of the module that receives the upgrade. */
  receiver: number;
  /** Raw DUML address the PC sends as. */
  sender: number;
}

/**
 * Maps a factory code to its flashing route, exactly as the reference tool's
 * Get_devices_type + Upgrade_Device dispatch do. Only the models the engine
 * actually flashes are listed; anything else returns null (refuse to flash).
 */
export function flashRouteForCode(code: string | undefined | null): FlashRoute | null {
  if (!code) {
    return null;
  }
  const u = code.toUpperCase();
  const mini = (droneType: string): FlashRoute => ({
    droneType,
    family: 'legacy-mini',
    receiver: 0x01,
    sender: 0x2a,
  });
  const air = (droneType: string): FlashRoute => ({
    droneType,
    family: 'legacy-air',
    receiver: 0x28,
    sender: 0x2a,
  });
  const m3 = (droneType: string, receiver: number): FlashRoute => ({
    droneType,
    family: 'new-m3',
    receiver,
    sender: 0x2a,
  });

  // Order matches the engine: longer codes before their prefixes.
  if (u.includes('WM1615')) return mini('MINI2');
  if (u.includes('WM1605')) return mini('MINISE');
  if (u.includes('WM160')) return mini('MINI1');
  if (u.includes('WM161')) return mini('MINI2');
  if (u.includes('WM163')) return mini('MINI2');
  if (u.includes('WM162')) return m3('MINI3', 0x48);
  if (u.includes('WM231')) return air('AIR2');
  if (u.includes('WM232')) return air('AIR2S');
  if (u.includes('WM2605')) return m3('MAVIC3', 0x4f);
  if (u.includes('WM260')) return m3('MAVIC3', 0x4f);
  if (u.includes('WM261')) return m3('MAVIC3', 0x4f);
  return null;
}

// ── DUML step descriptors ────────────────────────────────────────────────────

const ACK_AFTER_EXEC = 0x40;
const NO_ACK = 0x00;
const CMD_SET_GENERAL = 0x00;
const CMD_FILE_TRANSFER = 0x2a;

/** The largest firmware block the engine will transfer in one packet. */
export const MAX_BLOCK_SIZE = 980;

export interface DumlStep {
  sender: number;
  receiver: number;
  /** ack/encryption byte: 0x40 = ACK after exec, 0x00 = no ack. */
  ackEnc: number;
  cmdSet: number;
  cmdId: number;
  payload: Uint8Array;
  /** Whether the engine waits for a reply to this step. */
  expectReply: boolean;
}

const u32le = (value: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, true);
  return b;
};

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

/** The per-family constants that differ between upgrade routines. */
interface FamilySpec {
  enterCmd: number;
  enterPayload: Uint8Array;
  prepareCmd: number;
  /** Trailer appended after the little-endian total size in the prepare payload. */
  prepareTail: Uint8Array;
  /** Sub-opcode byte of a data-transfer packet. */
  dataSubop: number;
  /** ack/enc byte used for data packets. */
  dataAckEnc: number;
  /** Whether the engine waits for a reply to each data packet. */
  dataExpectReply: boolean;
  /** Trailer appended after the NUL-terminated name in a file-open packet. */
  fileOpenTail: Uint8Array;
  finishCmd: number;
  finishPayload: Uint8Array;
}

const FAMILIES: Record<FlashFamily, FamilySpec> = {
  'legacy-mini': {
    enterCmd: 0x07,
    enterPayload: new Uint8Array(9),
    prepareCmd: 0x08,
    prepareTail: Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02),
    dataSubop: 0x02,
    dataAckEnc: ACK_AFTER_EXEC,
    dataExpectReply: false, // Upgrade_New_MINI2 sends data fire-and-forget
    fileOpenTail: new Uint8Array(4),
    finishCmd: 0x0a,
    finishPayload: new Uint8Array(17),
  },
  'legacy-air': {
    enterCmd: 0x07,
    enterPayload: new Uint8Array(9),
    prepareCmd: 0x08,
    prepareTail: Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02),
    dataSubop: 0x02,
    dataAckEnc: ACK_AFTER_EXEC,
    dataExpectReply: true, // Upgrade_New_AIR2 waits on each data packet
    fileOpenTail: new Uint8Array(4),
    finishCmd: 0x0a,
    finishPayload: new Uint8Array(17),
  },
  'new-m3': {
    enterCmd: 0x83,
    enterPayload: Uint8Array.of(0x04),
    prepareCmd: 0x84,
    prepareTail: Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01),
    dataSubop: 0x04,
    dataAckEnc: NO_ACK,
    dataExpectReply: false,
    fileOpenTail: Uint8Array.of(0x00, 0x00, 0x01, 0x01),
    finishCmd: 0x85,
    finishPayload: new Uint8Array(16),
  },
};

export const familySpec = (family: FlashFamily): FamilySpec => FAMILIES[family];

const step = (
  route: FlashRoute,
  cmdId: number,
  payload: Uint8Array,
  opts: { ackEnc?: number; expectReply?: boolean } = {},
): DumlStep => ({
  sender: route.sender,
  receiver: route.receiver,
  ackEnc: opts.ackEnc ?? ACK_AFTER_EXEC,
  cmdSet: CMD_SET_GENERAL,
  cmdId,
  payload,
  expectReply: opts.expectReply ?? true,
});

/** Enter-upgrade-mode step (cmd 0x07 legacy / 0x83 M3). */
export function enterStep(route: FlashRoute): DumlStep {
  const f = FAMILIES[route.family];
  return step(route, f.enterCmd, f.enterPayload);
}

/** Prepare step carrying the total firmware size (cmd 0x08 legacy / 0x84 M3). */
export function prepareStep(route: FlashRoute, totalSize: number): DumlStep {
  const f = FAMILIES[route.family];
  return step(route, f.prepareCmd, concat(Uint8Array.of(0x00), u32le(totalSize), f.prepareTail));
}

/** File-open step: sub-op 0x01 + size + NUL-terminated name + family trailer. */
export function fileOpenStep(route: FlashRoute, name: string, size: number): DumlStep {
  const f = FAMILIES[route.family];
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length + 1 > 0xff) {
    throw new Error(`Firmware file name too long: ${name}`);
  }
  const payload = concat(
    Uint8Array.of(0x01),
    u32le(size),
    Uint8Array.of(nameBytes.length + 1),
    nameBytes,
    Uint8Array.of(0x00),
    f.fileOpenTail,
  );
  return step(route, CMD_FILE_TRANSFER, payload);
}

/** One data-transfer step: sub-op (0x02/0x04) + block index + chunk. */
export function dataStep(route: FlashRoute, index: number, chunk: Uint8Array): DumlStep {
  const f = FAMILIES[route.family];
  return step(route, CMD_FILE_TRANSFER, concat(Uint8Array.of(f.dataSubop), u32le(index), chunk), {
    ackEnc: f.dataAckEnc,
    expectReply: f.dataExpectReply,
  });
}

/** Whole-file MD5 verification step: sub-op 0x03 + 16-byte digest. */
export function md5Step(route: FlashRoute, fileBytes: Uint8Array): DumlStep {
  const digest = createHash('md5').update(fileBytes).digest();
  return step(route, CMD_FILE_TRANSFER, concat(Uint8Array.of(0x03), new Uint8Array(digest)));
}

/** Finish/commit step (cmd 0x0A legacy / 0x85 M3) — triggers install + reboot. */
export function finishStep(route: FlashRoute): DumlStep {
  const f = FAMILIES[route.family];
  return step(route, f.finishCmd, f.finishPayload);
}

/**
 * The block size negotiated from a prepare/file-open reply (reply bytes[1:3],
 * little-endian), clamped to MAX_BLOCK_SIZE. Returns null when the reply is too
 * short to carry one.
 */
export function blockSizeFromReply(reply: Uint8Array | null | undefined): number | null {
  if (!reply || reply.length < 3) {
    return null;
  }
  const value = reply[1] | (reply[2] << 8);
  if (value <= 0) {
    return null;
  }
  return Math.min(value, MAX_BLOCK_SIZE);
}

// ── Upgrade status (cmd 0x42) ────────────────────────────────────────────────

export type UpgradePhase = 'verify' | 'confirm' | 'progress' | 'success' | 'failed' | 'unknown';

export interface UpgradeStatus {
  phase: UpgradePhase;
  /** 0–100 while phase is "progress". */
  percent?: number;
  /** Human-readable result for terminal phases. */
  detail?: string;
}

const RESULT_TEXT: Record<number, string> = {
  1: 'success',
  2: 'upgrade failed',
  3: 'firmware error',
  4: 'same version',
  5: 'cancelled',
  6: 'timed out',
  7: 'motors running',
  8: 'firmware mismatch',
  9: 'downgrade rejected',
  10: 'remote controller not connected',
};

/**
 * Decodes a GENERAL 0x42 upgrade-status report (DumlStatusParser in the
 * original). payload[0] is the state; for progress payload[1] is the percent,
 * for completion payload[1] is the result code.
 */
export function decodeUpgradeStatus(payload: Uint8Array): UpgradeStatus {
  if (payload.length === 0) {
    return { phase: 'unknown' };
  }
  switch (payload[0]) {
    case 1:
      return { phase: 'verify', detail: 'verifying firmware' };
    case 2:
      return { phase: 'confirm', detail: 'confirming firmware' };
    case 3:
      return { phase: 'progress', percent: payload.length > 1 ? payload[1] : undefined };
    case 4: {
      const code = payload.length > 1 ? payload[1] : 0;
      const detail = RESULT_TEXT[code] ?? `result code ${code}`;
      return { phase: code === 1 ? 'success' : 'failed', detail };
    }
    default:
      return { phase: 'unknown' };
  }
}

// ── Firmware package extraction ──────────────────────────────────────────────

export interface FirmwareFile {
  name: string;
  bytes: Uint8Array;
}

const SIG_RE = /\.sig$/i;

/** True if the bytes start with the local-file-header signature of a ZIP. */
const isZip = (b: Uint8Array): boolean =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x01 || b[2] === 0x05);

const isGzip = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Extracts members of an uncompressed tar whose names end in .sig. */
function readTarSigs(buf: Buffer): FirmwareFile[] {
  const files: FirmwareFile[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two zero blocks mark the end of the archive.
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeField = header.toString('ascii', 124, 136).replace(/[\0 ]+$/, '');
    const size = parseInt(sizeField, 8) || 0;
    const dataStart = offset + 512;
    if (SIG_RE.test(name) && size > 0) {
      files.push({
        name: name.split('/').pop() ?? name,
        bytes: new Uint8Array(buf.subarray(dataStart, dataStart + size)),
      });
    }
    // Entries are padded to a 512-byte boundary.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Extracts members of a ZIP whose names end in .sig (stored or deflated). */
function readZipSigs(buf: Buffer): FirmwareFile[] {
  const EOCD = 0x06054b50;
  // Find the End Of Central Directory record near the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return [];
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files: FirmwareFile[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      break;
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!SIG_RE.test(name)) {
      continue;
    }
    // Read the local header to find where the data actually starts.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      continue;
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let bytes: Buffer;
    if (method === 0) {
      bytes = comp;
    } else if (method === 8) {
      bytes = inflateRawSync(comp);
    } else {
      continue; // unsupported compression
    }
    files.push({ name: name.split('/').pop() ?? name, bytes: new Uint8Array(bytes) });
  }
  return files;
}

/**
 * Reads the firmware modules (.sig files) from a package buffer. Supports tar,
 * tar.gz/tgz and zip, mirroring the reference tool's extraction. Returns the
 * files sorted by name for a deterministic transfer order.
 */
export function readFirmwarePackage(buffer: Buffer): FirmwareFile[] {
  let data = buffer;
  if (isGzip(data)) {
    data = gunzipSync(data);
  }
  let files: FirmwareFile[];
  if (isZip(data)) {
    files = readZipSigs(data);
  } else {
    files = readTarSigs(data);
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
