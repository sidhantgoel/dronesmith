/**
 * The standard Android fastboot protocol, as DJI drones speak it once rebooted
 * into bootloader/fastboot mode (getvar, download, flash, erase, continue,
 * reboot, with the usual OKAY/FAIL/DATA/INFO replies).
 *
 * This is the on-the-wire protocol only; the USB transport that carries it is
 * in usb0.ts (connectFastboot). Keeping them apart lets the protocol be tested
 * against a mock transport.
 *
 * Reads (getvar, device info) are safe. Writes (flash, erase) can brick the
 * aircraft and are gated in the main process and the UI, not here.
 */
import type { FastbootTransport } from './usb0';

/** A fastboot reply: its 4-letter status and the text after it. */
export type FastbootStatus = 'OKAY' | 'FAIL' | 'DATA' | 'INFO';

export interface FastbootReply {
  status: FastbootStatus;
  text: string;
}

export class FastbootError extends Error {}

const COMMAND_TIMEOUT_MS = 8000;
const DATA_TIMEOUT_MS = 30000;
/** Fastboot replies are at most 256 bytes; commands at most 64. */
const REPLY_BYTES = 256;
const COMMAND_MAX = 64;
/** Default transfer chunk; the device's max-download-size caps a whole flash. */
const CHUNK_BYTES = 256 * 1024;

const STATUSES: FastbootStatus[] = ['OKAY', 'FAIL', 'DATA', 'INFO'];

/** Parses one raw reply packet into a status and its text. */
export function parseReply(packet: Uint8Array): FastbootReply {
  const prefix = String.fromCharCode(...packet.subarray(0, 4));
  const status = STATUSES.find((s) => s === prefix);
  if (!status) {
    throw new FastbootError(`Unexpected fastboot reply: ${prefix}`);
  }
  return { status, text: String.fromCharCode(...packet.subarray(4)).replace(/\0+$/, '') };
}

/** Rejects command text that is empty, too long, or not printable ASCII. */
export function commandProblem(command: string): string | null {
  if (command.length === 0 || command.length > COMMAND_MAX) {
    return `A fastboot command is 1 to ${COMMAND_MAX} characters.`;
  }
  if (!/^[\x20-\x7e]+$/.test(command)) {
    return 'A fastboot command is printable ASCII only.';
  }
  return null;
}

/** A partition name fastboot will accept: letters, digits, _ . -. */
export function partitionProblem(name: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,36}$/.test(name)) {
    return 'A partition name uses letters, digits, dot, dash or underscore.';
  }
  return null;
}

export interface FlashProgress {
  /** Bytes sent so far. */
  sent: number;
  total: number;
}

/** Drives the fastboot protocol over a transport. */
export class FastbootClient {
  /** INFO lines from the most recent command, in order. */
  private info: string[] = [];

  constructor(private readonly transport: FastbootTransport) {}

  /** INFO lines the device printed during the last command. */
  get lastInfo(): string[] {
    return this.info;
  }

  /**
   * Sends a command and reads replies until a terminal OKAY/FAIL (or DATA, when
   * expectData). INFO lines are collected into lastInfo. Returns the terminal
   * reply's text (the OKAY payload, or the DATA size word).
   */
  async command(command: string, expectData = false, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    const problem = commandProblem(command);
    if (problem) {
      throw new FastbootError(problem);
    }
    await this.transport.send(Buffer.from(command, 'latin1'), COMMAND_TIMEOUT_MS);
    this.info = [];
    // The device may emit any number of INFO lines before the terminal reply.
    for (let guard = 0; guard < 10000; guard += 1) {
      const packet = await this.transport.recv(REPLY_BYTES, timeoutMs);
      const reply = parseReply(packet);
      if (reply.status === 'INFO') {
        this.info.push(reply.text);
        continue;
      }
      if (reply.status === 'FAIL') {
        throw new FastbootError(reply.text || 'The device rejected the command.');
      }
      if (reply.status === 'DATA') {
        if (!expectData) {
          throw new FastbootError('The device asked for data unexpectedly.');
        }
        return reply.text;
      }
      return reply.text; // OKAY
    }
    throw new FastbootError('The device never finished answering.');
  }

  /** Reads one variable (getvar); empty string when the device has no value. */
  async getvar(name: string): Promise<string> {
    try {
      return await this.command(`getvar:${name}`);
    } catch (error) {
      if (error instanceof FastbootError) {
        return '';
      }
      throw error;
    }
  }

  /**
   * Reads every variable the device will list. `getvar:all` reports each one as
   * an INFO line "name: value"; devices vary, so unparsed lines are kept raw.
   */
  async getvarAll(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try {
      await this.command('getvar:all');
    } catch {
      // Some devices FAIL `all`; fall back to a few well-known variables below.
    }
    for (const raw of this.info) {
      // getvar:all variable names themselves contain colons (e.g.
      // "partition-size:boot: 0x...") while values do not, so the last colon
      // is the name/value boundary. A leading "(bootloader) " tag is dropped.
      const line = raw.replace(/^\(bootloader\)\s*/, '');
      const colon = line.lastIndexOf(':');
      if (colon > 0) {
        out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      } else if (line.length > 0) {
        out[line] = '';
      }
    }
    if (Object.keys(out).length === 0) {
      for (const name of ['product', 'version', 'version-bootloader', 'serialno', 'secure', 'max-download-size', 'current-slot', 'slot-count']) {
        const value = await this.getvar(name);
        if (value) {
          out[name] = value;
        }
      }
    }
    return out;
  }

  /** The largest single download the device accepts, if it reports one. */
  async maxDownloadSize(): Promise<number | undefined> {
    const raw = await this.getvar('max-download-size');
    const value = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /** Uploads an image into the device's download buffer (no flash yet). */
  async download(data: Uint8Array, onProgress?: (progress: FlashProgress) => void): Promise<void> {
    const size = data.length.toString(16).padStart(8, '0');
    const reply = await this.command(`download:${size}`, true);
    const expected = parseInt(reply, 16);
    if (!Number.isFinite(expected) || expected !== data.length) {
      throw new FastbootError(`The device expected ${reply} bytes for the download.`);
    }
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.length));
      await this.transport.send(Buffer.from(chunk), DATA_TIMEOUT_MS);
      onProgress?.({ sent: Math.min(offset + chunk.length, data.length), total: data.length });
    }
    // The device answers OKAY once it has taken the whole image.
    const done = await this.transport.recv(REPLY_BYTES, DATA_TIMEOUT_MS);
    const final = parseReply(done);
    if (final.status === 'FAIL') {
      throw new FastbootError(final.text || 'The device rejected the download.');
    }
    if (final.status !== 'OKAY') {
      throw new FastbootError(`Unexpected reply after the download: ${final.status}.`);
    }
  }

  /** Writes a previously downloaded image to a partition. Destructive. */
  async flash(partition: string, data: Uint8Array, onProgress?: (progress: FlashProgress) => void): Promise<void> {
    const problem = partitionProblem(partition);
    if (problem) {
      throw new FastbootError(problem);
    }
    await this.download(data, onProgress);
    await this.command(`flash:${partition}`, false, DATA_TIMEOUT_MS);
  }

  /** Erases a partition. Destructive. */
  async erase(partition: string): Promise<void> {
    const problem = partitionProblem(partition);
    if (problem) {
      throw new FastbootError(problem);
    }
    await this.command(`erase:${partition}`, false, DATA_TIMEOUT_MS);
  }

  /** reboot | reboot-bootloader | reboot-fastboot | continue. */
  async reboot(target: 'reboot' | 'reboot-bootloader' | 'reboot-fastboot' | 'continue'): Promise<void> {
    await this.command(target);
  }
}
