/**
 * Read-only partition dump.
 *
 * A partition is read by paging the aircraft's firmware-page query
 * (GENERAL 0x00 / 0x4F) with a one-byte page index, 0, 1, 2 … , against the
 * device that owns it (the flight controller 0x02 or the centre board 0x04).
 * Each reply carries that page's bytes; concatenating them backs up the
 * partition. This only ever reads — there is no write command, so it is a safe
 * diagnostic. The builders are pure for unit testing.
 */
import type { DumlStep } from './flasher';

/** Device that owns a partition. */
export const PART_FC = 0x02;
export const PART_CENTER = 0x04;

export interface PartitionDef {
  id: number;
  name: string;
  /** Owning device address. */
  target: number;
}

/** The ten partitions that can be read. */
export const PARTITIONS: readonly PartitionDef[] = [
  { id: 1, name: 'Bootloader', target: PART_FC },
  { id: 2, name: 'Flight Controller FW', target: PART_FC },
  { id: 3, name: 'FC Parameters', target: PART_FC },
  { id: 4, name: 'Gimbal Params', target: PART_CENTER },
  { id: 5, name: 'Camera Params', target: PART_CENTER },
  { id: 6, name: 'Vision Calibration', target: PART_CENTER },
  { id: 7, name: 'NFZ Database', target: PART_FC },
  { id: 8, name: 'Serial Numbers', target: PART_FC },
  { id: 9, name: 'Factory Data', target: PART_FC },
  { id: 10, name: 'Flight Logs Index', target: PART_FC },
];

export function partitionById(id: number): PartitionDef | undefined {
  return PARTITIONS.find((p) => p.id === id);
}

const SENDER = 0x2a;
/** ack-after-exec, no encryption. */
const CONTROL = 0x40;
const CMD_GENERAL_GET_CONFIG = 0x4f;

/** The firmware-page query for one page of a partition's target device. */
export function partitionPageStep(target: number, page: number): DumlStep {
  return {
    sender: SENDER,
    receiver: target,
    ackEnc: CONTROL,
    cmdSet: 0x00,
    cmdId: CMD_GENERAL_GET_CONFIG,
    payload: Uint8Array.of(page & 0xff),
    expectReply: true,
  };
}
