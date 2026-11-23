/**
 * DUML ("DUPC") v1 packet encoding and stream parsing.
 *
 * Ported from dji-firmware-tools (comm_mkdupc.py / comm_dat2pcap.py).
 *
 * Frame layout (little endian):
 *   0      sof            0x55
 *   1..2   ver_length     bits 0-9 whole packet length, bits 10-15 version (1)
 *   3      header_crc8    CRC8 (seed 0x77) of bytes 0..2
 *   4      sender         bits 0-4 module type, bits 5-7 module index
 *   5      receiver       bits 0-4 module type, bits 5-7 module index
 *   6..7   seq_num
 *   8      cmd_type       bit 7 response, bits 5-6 ack type, bits 0-2 encryption
 *   9      cmd_set
 *   10     cmd_id
 *   11..   payload
 *   last 2 crc16          CRC16 (seed 0x3692) of everything before it
 */

export const HEADER_LENGTH = 11;
export const FOOTER_LENGTH = 2;
const MAX_PACKET_LENGTH = 0x3ff;

export const DevType = {
  ANY: 0,
  CAMERA: 1,
  MOBILE_APP: 2,
  FLYCONTROLLER: 3,
  GIMBAL: 4,
  CENTER_BOARD: 5,
  REMOTE_RADIO: 6,
  WIFI: 7,
  LB_DM3XX_SKY: 8,
  LB_MCU_SKY: 9,
  PC: 10,
  BATTERY: 11,
  ESC: 12,
  DM368_GROUND: 13,
  OFDM_GROUND: 14,
  LB_68013_SKY: 15,
  SER_68013_GROUND: 16,
  MVO: 17,
  SVO: 18,
  LB_FPGA_SKY: 19,
  FPGA_GROUND: 20,
  FPGA_SIM: 21,
  STATION: 22,
  XU: 23,
  WTF: 24,
  IMU: 25,
  GPS: 26,
  WIFI_GROUND: 27,
  SIG_CVT: 28,
  PMU: 29,
} as const;

export const AckType = {
  NO_ACK_NEEDED: 0,
  ACK_BEFORE_EXEC: 1,
  ACK_AFTER_EXEC: 2,
} as const;

export const CmdSet = {
  GENERAL: 0,
  SPECIAL: 1,
  CAMERA: 2,
  FLYCONTROLLER: 3,
  ZENMUSE: 4,
  CENTER_BOARD: 5,
} as const;

export interface PacketFields {
  senderType: number;
  senderIndex: number;
  receiverType: number;
  receiverIndex: number;
  seqNum: number;
  /** 0 = request, 1 = response. */
  packetType: number;
  ackType: number;
  encryptType: number;
  cmdSet: number;
  cmdId: number;
  payload: Uint8Array;
}

export interface Packet extends PacketFields {
  /** Raw sender byte (type | index << 5). */
  senderInfo: number;
  /** Raw receiver byte (type | index << 5). */
  receiverInfo: number;
  raw: Buffer;
}

const CRC8_TABLE = new Uint8Array(256);
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i += 1) {
  let c8 = i;
  let c16 = i;
  for (let bit = 0; bit < 8; bit += 1) {
    c8 = c8 & 1 ? (c8 >>> 1) ^ 0x8c : c8 >>> 1;
    c16 = c16 & 1 ? (c16 >>> 1) ^ 0x8408 : c16 >>> 1;
  }
  CRC8_TABLE[i] = c8;
  CRC16_TABLE[i] = c16;
}

export function headerCrc8(data: Uint8Array, length: number): number {
  let crc = 0x77;
  for (let i = 0; i < length; i += 1) {
    crc = CRC8_TABLE[(data[i] ^ crc) & 0xff];
  }
  return crc;
}

export function packetCrc16(data: Uint8Array, length: number): number {
  let crc = 0x3692; // seed used by P3/P4/Mavic and newer
  for (let i = 0; i < length; i += 1) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(data[i] ^ crc) & 0xff];
  }
  return crc;
}

export function moduleInfo(type: number, index: number): number {
  return (type & 0x1f) | ((index & 0x07) << 5);
}

export function encodePacket(fields: PacketFields): Buffer {
  const length = HEADER_LENGTH + fields.payload.length + FOOTER_LENGTH;
  if (length > MAX_PACKET_LENGTH) {
    throw new Error(`DUML payload too long (${fields.payload.length} bytes).`);
  }
  const buf = Buffer.alloc(length);
  buf[0] = 0x55;
  buf.writeUInt16LE((length & 0x3ff) | (1 << 10), 1);
  buf[3] = headerCrc8(buf, 3);
  buf[4] = moduleInfo(fields.senderType, fields.senderIndex);
  buf[5] = moduleInfo(fields.receiverType, fields.receiverIndex);
  buf.writeUInt16LE(fields.seqNum & 0xffff, 6);
  buf[8] =
    ((fields.packetType & 1) << 7) |
    ((fields.ackType & 3) << 5) |
    (fields.encryptType & 7);
  buf[9] = fields.cmdSet;
  buf[10] = fields.cmdId;
  buf.set(fields.payload, HEADER_LENGTH);
  buf.writeUInt16LE(packetCrc16(buf, length - 2), length - 2);
  return buf;
}

const DEV_NAMES = new Map<number, string>(
  Object.entries(DevType).map(([name, type]) => [type, name]),
);

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

const byteHex = (value: number): string => `0x${value.toString(16).padStart(2, '0')}`;

const moduleName = (type: number, index: number): string =>
  `${DEV_NAMES.get(type) ?? `TYPE_${type}`}:${index}`;

/** One-line dump of a parsed packet: decoded header fields, then the raw bytes. */
export function describePacket(packet: Packet): string {
  return [
    `${moduleName(packet.senderType, packet.senderIndex)} -> ${moduleName(packet.receiverType, packet.receiverIndex)}`,
    `seq ${packet.seqNum}`,
    packet.packetType === 1 ? 'response' : 'request',
    `ack ${packet.ackType}`,
    `enc ${packet.encryptType}`,
    `set ${byteHex(packet.cmdSet)}`,
    `id ${byteHex(packet.cmdId)}`,
    `payload[${packet.payload.length}] ${toHex(packet.payload)}`.trimEnd(),
    `| raw ${toHex(packet.raw)}`,
  ].join('  ');
}

function decodePacket(raw: Buffer): Packet {
  return {
    senderInfo: raw[4],
    receiverInfo: raw[5],
    senderType: raw[4] & 0x1f,
    senderIndex: raw[4] >> 5,
    receiverType: raw[5] & 0x1f,
    receiverIndex: raw[5] >> 5,
    seqNum: raw.readUInt16LE(6),
    packetType: raw[8] >> 7,
    ackType: (raw[8] >> 5) & 3,
    encryptType: raw[8] & 7,
    cmdSet: raw[9],
    cmdId: raw[10],
    payload: raw.subarray(HEADER_LENGTH, raw.length - FOOTER_LENGTH),
    raw,
  };
}

/**
 * Incremental parser: feed it bytes as they arrive from the transport and it
 * returns every complete, checksum-valid v1 packet found so far.
 */
export class PacketParser {
  private buffer: Buffer = Buffer.alloc(0);

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk: Uint8Array): Packet[] {
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);
    const packets: Packet[] = [];
    let pos = 0;

    for (;;) {
      const start = this.buffer.indexOf(0x55, pos);
      if (start < 0) {
        pos = this.buffer.length;
        break;
      }
      pos = start;
      if (this.buffer.length - pos < 4) {
        break; // wait for the rest of the header
      }
      if (headerCrc8(this.buffer.subarray(pos), 3) !== this.buffer[pos + 3]) {
        pos += 1;
        continue;
      }
      const verLength = this.buffer.readUInt16LE(pos + 1);
      const length = verLength & 0x3ff;
      if (length < HEADER_LENGTH + FOOTER_LENGTH) {
        pos += 1;
        continue;
      }
      if (this.buffer.length - pos < length) {
        break; // wait for the rest of the body
      }
      const raw = this.buffer.subarray(pos, pos + length);
      if (packetCrc16(raw, length - 2) !== raw.readUInt16LE(length - 2)) {
        pos += 1;
        continue;
      }
      if (verLength >> 10 === 1) {
        packets.push(decodePacket(Buffer.from(raw)));
      }
      pos += length;
    }

    this.buffer = this.buffer.subarray(pos);
    return packets;
  }
}
