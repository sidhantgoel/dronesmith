/**
 * Smart-battery readout.
 *
 * Four read requests go to the battery (0x0B) on the SMART_BATTERY set 0x0D,
 * each with payload [01]: 0x01 static data, 0x02 dynamic data, 0x03 cell
 * voltages, 0x04 serial. The reply layouts below follow the classic DJI
 * smart-battery layout. Read-only.
 *
 * Pure, so the main process (to query) and the renderer (to show) share it.
 * Not confirmed on hardware.
 */
import type { DumlStep } from './flasher';

/** Default host address (PC index 1). */
const PC1 = 0x2a;
const BATTERY = 0x0b;
const ACK_AFTER = 0x40;

export const BATTERY_CMD_SET = 0x0d;
export const BATTERY_SENDER_TYPE = 0x0b;
export const BATTERY_CMD_STATIC = 0x01;
export const BATTERY_CMD_DYNAMIC = 0x02;
export const BATTERY_CMD_CELLS = 0x03;
export const BATTERY_CMD_SERIAL = 0x04;

const REQUESTS = [BATTERY_CMD_STATIC, BATTERY_CMD_DYNAMIC, BATTERY_CMD_CELLS, BATTERY_CMD_SERIAL];

/** Data that does not change while the pack is in use. */
export interface BatteryPack {
  /** mAh */
  designCapacity: number;
  cycles: number;
  /** mV */
  designVoltage: number;
  /** Cell count estimated from the design voltage. */
  cells: number;
  /** ISO date, when the pack reports a plausible one. */
  manufactured?: string;
}

/** Live measurements. */
export interface BatteryLive {
  /** mV */
  voltage: number;
  /** mA; negative while discharging. */
  current: number;
  /** mAh the pack holds when full now. */
  fullCapacity: number;
  /** mAh */
  remaining: number;
  /** °C */
  temperature: number;
  cells: number;
  /** 0–100 */
  percent: number;
}

export interface BatterySnapshot {
  pack?: BatteryPack;
  live?: BatteryLive;
  /** mV per cell. */
  cellVoltages?: number[];
  serial?: string;
}

export function batteryRequestSteps(): DumlStep[] {
  return REQUESTS.map((cmdId) => ({
    sender: PC1,
    receiver: BATTERY,
    ackEnc: ACK_AFTER,
    cmdSet: BATTERY_CMD_SET,
    cmdId,
    payload: Uint8Array.of(0x01),
    expectReply: false,
  }));
}

const u16 = (p: Uint8Array, at: number): number => p[at] | (p[at + 1] << 8);
const s16 = (p: Uint8Array, at: number): number => (u16(p, at) << 16) >> 16;
const s32 = (p: Uint8Array, at: number): number =>
  p[at] | (p[at + 1] << 8) | (p[at + 2] << 16) | (p[at + 3] << 24);
const u32 = (p: Uint8Array, at: number): number => s32(p, at) >>> 0;

function parsePack(p: Uint8Array): BatteryPack | null {
  if (p.length < 14) {
    return null;
  }
  // Production date in the smart-battery packing: year-1980 | month | day.
  const date = u16(p, 12);
  const year = (date >> 9) + 1980;
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const designVoltage = u32(p, 8);
  const plausible = month >= 1 && month <= 12 && day >= 1 && year >= 2010 && year <= 2040;
  return {
    designCapacity: u32(p, 2),
    cycles: u16(p, 6),
    designVoltage,
    cells: designVoltage ? Math.round(designVoltage / 3800) : 0,
    manufactured: plausible
      ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : undefined,
  };
}

function parseLive(p: Uint8Array): BatteryLive | null {
  if (p.length < 22) {
    return null;
  }
  // The temperature is read as tenths of a degree Celsius. Packs
  // that report tenths of a kelvin would show ~298 °C that way, so a value no
  // pack can reach in Celsius is taken as kelvin instead.
  const rawTemperature = s16(p, 18);
  const temperature = rawTemperature > 2000 ? (rawTemperature - 2731) / 10 : rawTemperature / 10;
  return {
    voltage: u32(p, 2),
    current: s32(p, 6),
    fullCapacity: u32(p, 10),
    remaining: u32(p, 14),
    temperature,
    cells: p[20],
    percent: p[21],
  };
}

function parseCells(p: Uint8Array): number[] | null {
  if (p.length < 3) {
    return null;
  }
  const cells: number[] = [];
  for (let index = 0; index < p[2]; index += 1) {
    const at = 3 + index * 2;
    if (at + 2 <= p.length) {
      cells.push(u16(p, at));
    }
  }
  return cells.length >= 2 ? cells : null;
}

function parseSerial(p: Uint8Array): string | null {
  if (p.length < 3) {
    return null;
  }
  const text = [...p.subarray(2)]
    .filter((byte) => byte >= 0x20 && byte <= 0x7e)
    .map((byte) => String.fromCharCode(byte))
    .join('');
  return text.length >= 3 ? text : null;
}

/** Folds one battery reply into the snapshot. Returns true if it was usable. */
export function applyBatteryReply(snapshot: BatterySnapshot, cmdId: number, payload: Uint8Array): boolean {
  switch (cmdId) {
    case BATTERY_CMD_STATIC: {
      const pack = parsePack(payload);
      if (pack) {
        snapshot.pack = pack;
      }
      return pack !== null;
    }
    case BATTERY_CMD_DYNAMIC: {
      const live = parseLive(payload);
      if (live) {
        snapshot.live = live;
      }
      return live !== null;
    }
    case BATTERY_CMD_CELLS: {
      const cells = parseCells(payload);
      if (cells) {
        snapshot.cellVoltages = cells;
      }
      return cells !== null;
    }
    case BATTERY_CMD_SERIAL: {
      const serial = parseSerial(payload);
      if (serial) {
        snapshot.serial = serial;
      }
      return serial !== null;
    }
    default:
      return false;
  }
}

/**
 * Capacity the pack still holds against its design capacity, as a percentage.
 * Undefined when either figure is missing or they do not make sense together.
 */
export function batteryHealth(snapshot: BatterySnapshot): number | undefined {
  const design = snapshot.pack?.designCapacity ?? 0;
  const full = snapshot.live?.fullCapacity ?? 0;
  if (design <= 0 || full <= 0 || full > design * 1.2) {
    return undefined;
  }
  return Math.min(100, Math.round((full / design) * 100));
}
