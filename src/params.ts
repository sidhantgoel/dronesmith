/**
 * DJI flight-controller parameter protocol (FLYC cmd set 0x03).
 *
 * Two addressing schemes exist, each selected by the `read_param_by_index` /
 * `read_param_by_hash` style of request:
 *
 *   by index  (older firmware, receiver 0x02)
 *     0xE0  table info      req [00 00]                → u16 count, u16 size
 *     0xE1  info by index   req [idx:u16, 00 00]       → u16 index, u32 hash, ASCII name
 *     0xE2  read by index   req [idx:u16, 00 00]       → u16 index, value bytes
 *
 *   by hash   (newer firmware, receiver 0x03)
 *     0xF8  read by hash     req [hash:u32]            → u32 hash, value bytes
 *     0xF9  write by hash    req [hash:u32, value...]  → reply[0] == 0 means OK
 *
 * The hash is DJI's rolling name hash: fold each UTF-8 byte as
 * h = (h << 8 + byte) mod (2^32 - 5). Builders are pure so they can be
 * unit-tested against the captured frames.
 */
import type { DumlStep } from './flasher';

export const FLYC = 0x03;
/**
 * Flight-controller address for the parameter commands. The flight controller
 * is DUML device type 0x03 (the address this app's ESC-repair command already
 * uses). Device 0x02 is the camera and does not answer FLYC commands, so the
 * by-index scan must not be addressed there — we send both schemes to the FC
 * at 0x03.
 */
export const FC_HASH_RECEIVER = 0x03;
export const FC_INDEX_RECEIVER = 0x03;

const SENDER = 0x2a;
/** ack-after-exec, no encryption. */
const CONTROL = 0x40;

/** DJI parameter name hash: rolling fold mod (2^32 - 5). */
export function djiParamHash(name: string): number {
  let h = 0n;
  for (const byte of new TextEncoder().encode(name)) {
    h = ((h << 8n) + BigInt(byte)) % 0xfffffffbn;
  }
  return Number(h);
}

const u32le = (value: number): Uint8Array =>
  Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);

const u16le = (value: number): Uint8Array => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);

function step(receiver: number, cmdId: number, payload: Uint8Array): DumlStep {
  return { sender: SENDER, receiver, ackEnc: CONTROL, cmdSet: FLYC, cmdId, payload, expectReply: true };
}

// ── Request builders ─────────────────────────────────────────────────────────

export const paramTableInfoStep = (): DumlStep =>
  step(FC_INDEX_RECEIVER, 0xe0, Uint8Array.of(0x00, 0x00));

// The by-index request is [table_number: u16][param_index: u16]. Sending
// [index, 00 00] instead would address table=index, param 0 — wrong, and the
// scan returns nothing.
export const paramInfoByIndexStep = (index: number, table = 0): DumlStep =>
  step(FC_INDEX_RECEIVER, 0xe1, new Uint8Array([...u16le(table), ...u16le(index)]));

// Read the CURRENT value by index (0xE2). Captured request is
// [table u16][01 00][index u16] — the middle 01 00 (count = 1) is required;
// without it the aircraft returns zeros. The reply is [ret u32][index u16][value…],
// i.e. the live value, which 0xE1 does NOT carry (0xE1's value field is the
// factory default and never changes on write).
export const paramReadByIndexStep = (index: number, table = 0): DumlStep =>
  step(FC_INDEX_RECEIVER, 0xe2, new Uint8Array([...u16le(table), 0x01, 0x00, ...u16le(index)]));

export const paramReadByHashStep = (name: string): DumlStep =>
  step(FC_HASH_RECEIVER, 0xf8, u32le(djiParamHash(name)));

export const paramWriteByHashStep = (name: string, value: Uint8Array): DumlStep =>
  step(FC_HASH_RECEIVER, 0xf9, new Uint8Array([...u32le(djiParamHash(name)), ...value]));

/**
 * Enables parameter writing. Captured as 0x03/0xDF with payload 01 00 00 00,
 * sent immediately before each write; the aircraft rejects writes without it
 * (which is why writes failed even in factory mode).
 */
export const paramWriteUnlockStep = (): DumlStep =>
  step(FC_INDEX_RECEIVER, 0xdf, Uint8Array.of(0x01, 0x00, 0x00, 0x00));

/**
 * Write a parameter by index (0x03/0xE3). Captured payload is
 * [reserved u32 = 0][index u16][value…], matching the read-value reply shape.
 * The reply echoes the request on success.
 */
export const paramWriteByIndexStep = (index: number, value: Uint8Array): DumlStep =>
  step(FC_INDEX_RECEIVER, 0xe3, new Uint8Array([0, 0, 0, 0, ...u16le(index), ...value]));

// ── Reply parsers ────────────────────────────────────────────────────────────

export interface ParamTableInfo {
  count: number;
  /** Table CRC/hash the aircraft reports, for change detection. */
  tableCrc: number;
}

/**
 * Table-info (0xE0) reply. Observed on a Mavic-class aircraft as
 *   00 00 00 00  <u32 table-crc>  <u16 count>  00 00
 * i.e. a reserved u32, the table CRC at offset 4, and the parameter count at
 * offset 8. Older firmware that answered at offset 0 falls back to that.
 */
export function parseParamTableInfo(payload: Uint8Array): ParamTableInfo | null {
  if (payload.length >= 10) {
    const tableCrc =
      (payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)) >>> 0;
    return { count: payload[8] | (payload[9] << 8), tableCrc };
  }
  if (payload.length >= 4) {
    return { count: payload[0] | (payload[1] << 8), tableCrc: 0 };
  }
  return null;
}

/** DJI parameter type ids → readable names. */
const TYPE_NAMES: Record<number, string> = {
  0: 'u8',
  1: 'u16',
  2: 'u32',
  3: 'u64',
  4: 'i8',
  5: 'i16',
  6: 'i32',
  7: 'i64',
  8: 'float',
  9: 'double',
};

export function paramTypeName(typeId: number): string {
  return TYPE_NAMES[typeId] ?? `type${typeId}`;
}

const isSigned = (typeId: number): boolean => typeId >= 4 && typeId <= 7;
const isFloat = (typeId: number): boolean => typeId === 8 || typeId === 9;

export interface ParamInfo {
  index: number;
  typeId: number;
  typeName: string;
  /** Value width in bytes (1, 2, 4, 8). */
  size: number;
  /** Current value, decoded per type. */
  value: number;
  min: number;
  max: number;
  name: string;
}

/**
 * Parses a by-index info reply (0xE1). Observed layout:
 *   [status u16][reserved u16][index u16][type u16][size u16]
 *   [value u32][min u32][max u32][name…]
 * where value/min/max use the low `size` bytes of each 4-byte slot and the
 * name is ASCII from offset 22. (Reading the name at offset 6 / hash at offset
 * 2 is wrong and never produces usable values.)
 */
export function parseParamInfo(payload: Uint8Array): ParamInfo | null {
  if (payload.length < 23) {
    return null;
  }
  const u16 = (o: number): number => payload[o] | (payload[o + 1] << 8);
  const typeId = u16(6);
  const size = u16(8);
  const sz = size >= 1 && size <= 4 ? size : 4;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const field = (o: number): number => {
    if (isFloat(typeId) && sz === 4) {
      return view.getFloat32(o, true);
    }
    let v = 0;
    for (let i = 0; i < sz; i += 1) {
      v += payload[o + i] * 2 ** (8 * i);
    }
    if (isSigned(typeId) && sz < 8) {
      const span = 2 ** (8 * sz);
      if (v >= span / 2) {
        v -= span;
      }
    }
    return v;
  };
  const name = String.fromCharCode(...payload.slice(22).filter((b) => b >= 32 && b <= 126));
  if (!name) {
    return null;
  }
  return {
    index: u16(4),
    typeId,
    typeName: paramTypeName(typeId),
    size,
    value: field(10),
    min: field(14),
    max: field(18),
    name,
  };
}

/** Encodes a value as little-endian bytes for a parameter write, per its type. */
export function encodeParamValue(value: number, size: number, typeId = 2): Uint8Array {
  const sz = size >= 1 && size <= 4 ? size : 4;
  const out = new Uint8Array(sz);
  if (isFloat(typeId) && sz === 4) {
    new DataView(out.buffer).setFloat32(0, value, true);
    return out;
  }
  let v = Math.trunc(value);
  if (v < 0) {
    v += 2 ** (8 * sz);
  }
  for (let i = 0; i < sz; i += 1) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

export interface ParamValueByIndex {
  index: number;
  value: Uint8Array;
}

/**
 * Parses a read-value-by-index reply (0xE2). Observed layout:
 *   [ret u32][index u16][value…]
 * so the live value bytes start at offset 6. (The earlier parser read index@0
 * and value@2, which skewed every field — that is why 0xE2 "returned zeros".)
 */
export function parseParamValueByIndex(payload: Uint8Array): ParamValueByIndex | null {
  if (payload.length < 6) {
    return null;
  }
  return { index: payload[4] | (payload[5] << 8), value: payload.slice(6) };
}

/** Decodes raw little-endian value bytes into a number, per DJI type id. */
export function decodeParamValue(bytes: Uint8Array, typeId = 2): number {
  const sz = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isFloat(typeId) && sz === 4) {
    return view.getFloat32(0, true);
  }
  if (isFloat(typeId) && sz === 8) {
    return view.getFloat64(0, true);
  }
  let v = 0;
  for (let i = 0; i < sz; i += 1) {
    v += bytes[i] * 2 ** (8 * i);
  }
  if (isSigned(typeId) && sz < 8) {
    const span = 2 ** (8 * sz);
    if (v >= span / 2) {
      v -= span;
    }
  }
  return v;
}

export interface ParamValueByHash {
  hash: number;
  value: Uint8Array;
}

export function parseParamValueByHash(payload: Uint8Array): ParamValueByHash | null {
  if (payload.length < 4) {
    return null;
  }
  const hash =
    (payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0;
  return { hash, value: payload.slice(4) };
}

/** A write reply is OK when its first byte is zero. */
export function parseParamWriteResult(payload: Uint8Array): { ok: boolean; code: number } {
  const code = payload[0] ?? 0xff;
  return { ok: code === 0, code };
}

/** Parses a space-separated hex byte string, e.g. "01 00 ff", into bytes. */
export function parseHexBytes(text: string): Uint8Array {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const bytes = parts.map((p) => parseInt(p, 16));
  if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 0xff)) {
    throw new Error('Value must be space-separated hex bytes, e.g. "01 00 ff".');
  }
  return Uint8Array.from(bytes);
}
