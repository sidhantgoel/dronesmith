/**
 * The command console: one hand-built command to a module, and the frames the
 * aircraft sends while the console is open.
 *
 * Pure, so the main process and the renderer share the parsing and limits.
 */

export interface ConsoleRequest {
  sender: number;
  receiver: number;
  cmdSet: number;
  cmdId: number;
  /** 0x40 = acknowledge after running, 0x20 = before, 0x00 = none. */
  ackEnc: number;
  payload: number[];
}

export interface ConsoleReply {
  ok: boolean;
  message: string;
  /** The answer's payload, when one arrived. */
  reply?: number[];
  /** Milliseconds the answer took. */
  ms?: number;
}

export interface ConsoleFrame {
  /** Epoch milliseconds. */
  at: number;
  from: number;
  to: number;
  cmdSet: number;
  cmdId: number;
  /** True for an answer, false for a request or an unsolicited push. */
  ack: boolean;
  length: number;
  /** The first bytes of the payload as spaced hex. */
  hex: string;
}

export const CONSOLE_PAYLOAD_MAX = 512;
export const CONSOLE_FRAME_BYTES = 48;
export const CONSOLE_KEEP_FRAMES = 500;
export const CONSOLE_REPLY_WAIT_MS = 2000;

export const CONSOLE_SENDERS: readonly { value: number; label: string }[] = [
  { value: 0x2a, label: 'PC 1' },
  { value: 0x0a, label: 'PC 0' },
];

export const CONSOLE_ACKS: readonly { value: number; label: string }[] = [
  { value: 0x40, label: 'After running' },
  { value: 0x20, label: 'Before running' },
  { value: 0x00, label: 'None' },
];

/** Module addresses offered as shortcuts for the receiver field. */
export const CONSOLE_RECEIVERS: readonly { value: number; label: string }[] = [
  { value: 0x01, label: 'Camera' },
  { value: 0x03, label: 'Flight controller' },
  { value: 0x04, label: 'Gimbal' },
  { value: 0x05, label: 'Center board' },
  { value: 0x09, label: 'Radio link' },
  { value: 0x0b, label: 'Battery' },
  { value: 0x0c, label: 'ESC' },
  { value: 0x11, label: 'Monocular vision' },
  { value: 0x12, label: 'Binocular vision' },
];

/** Parses one hex byte ("2a", "0x2A"); null when it is not one. */
export function parseHexByte(input: string): number | null {
  const trimmed = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,2}$/.test(trimmed)) {
    return null;
  }
  return parseInt(trimmed, 16);
}

/** Parses a payload written as hex bytes, with or without separators; null when malformed. */
export function parseHexBytes(input: string): number[] | null {
  const cleaned = input.replace(/0x/gi, '').replace(/[\s,:-]+/g, ' ').trim();
  if (cleaned.length === 0) {
    return [];
  }
  const out: number[] = [];
  for (const token of cleaned.split(' ')) {
    if (!/^[0-9a-fA-F]+$/.test(token) || token.length % 2 !== 0) {
      return null;
    }
    for (let i = 0; i < token.length; i += 2) {
      out.push(parseInt(token.slice(i, i + 2), 16));
    }
  }
  return out.length <= CONSOLE_PAYLOAD_MAX ? out : null;
}

export const hexByte = (value: number): string => value.toString(16).padStart(2, '0');

export const hexBytes = (bytes: ArrayLike<number>, limit = bytes.length): string =>
  Array.from({ length: Math.min(bytes.length, limit) }, (_, i) => hexByte(bytes[i])).join(' ');

const isByte = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xff;

/** Returns why a request cannot be sent, or null when it can. */
export function consoleRequestProblem(request: ConsoleRequest): string | null {
  if (!isByte(request.sender) || !isByte(request.receiver)) {
    return 'The sender and receiver are one byte each.';
  }
  if (!isByte(request.cmdSet) || !isByte(request.cmdId)) {
    return 'The command set and command id are one byte each.';
  }
  if (!CONSOLE_ACKS.some((ack) => ack.value === request.ackEnc)) {
    return 'Choose how the command is acknowledged.';
  }
  if (!Array.isArray(request.payload) || request.payload.length > CONSOLE_PAYLOAD_MAX || !request.payload.every(isByte)) {
    return `The payload is up to ${CONSOLE_PAYLOAD_MAX} bytes.`;
  }
  return null;
}
