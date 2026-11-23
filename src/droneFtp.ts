/**
 * Reads files from the aircraft over USB through the FTP server DJI drones
 * expose on their USB network interface (the drone appears as a USB network
 * adapter; the host is 192.168.42.1 and the drone is 192.168.42.2). The
 * mechanism used: log in, list directories, download files.
 * The login is `dji_ftp` / `Dji_dajiang001` (with an anonymous fallback) and
 * the files live under paths like `/blackbox/...`.
 *
 * It is strictly read-only: it lists, sizes and retrieves files and never
 * uploads, renames or deletes. A minimal FTP client is implemented over plain
 * sockets so the app needs no FTP dependency. It does not read raw block
 * partitions — those are not exposed over this link — but any image file the
 * drone does expose can be pulled here and opened in the Partition images
 * explorer.
 */
import net from 'node:net';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { BrowserWindow, dialog, ipcMain } from 'electron';

export const DRONE_FTP_HOST = '192.168.42.2';
export const DRONE_FTP_PORT = 21;

/** Login attempts tried in order. */
export const DRONE_FTP_LOGINS: readonly { user: string; password: string }[] = [
  { user: 'dji_ftp', password: 'Dji_dajiang001' },
  { user: 'anonymous', password: 'anonymous@' },
];

/** Directories DJI drones commonly expose, offered as starting points. */
export const DRONE_FTP_SUGGESTED_PATHS: readonly string[] = ['/', '/blackbox', '/blackbox/system', '/blackbox/camera'];

export type FtpEntryType = 'dir' | 'file' | 'link' | 'other';

export interface FtpEntry {
  name: string;
  type: FtpEntryType;
  size: number;
  /** Raw date text from the listing, left as the server gives it. */
  modified: string;
  target?: string;
}

export interface FtpConnectResult {
  ok: boolean;
  message: string;
  /** The login that was accepted, when one was. */
  user?: string;
  /** The server's greeting banner, for the log. */
  banner?: string;
}

export interface FtpListResult {
  ok: boolean;
  message?: string;
  path?: string;
  entries?: FtpEntry[];
}

export interface FtpDownloadResult {
  ok: boolean;
  message: string;
  /** Where the file was written, when it was. */
  file?: string;
  bytes?: number;
}

export interface FtpDownloadProgress {
  name: string;
  bytes: number;
  /** Total size when the server reported one, else 0. */
  total: number;
}

const CONTROL_TIMEOUT_MS = 8000;
const DATA_IDLE_TIMEOUT_MS = 20000;

/** One FTP reply: its numeric code and full text. */
interface Reply {
  code: number;
  text: string;
}

/** A tiny read-only FTP client (passive mode, binary transfers). */
class FtpClient {
  private control: net.Socket | null = null;
  private buffer = '';
  private waiter: ((reply: Reply) => void) | null = null;
  private pending: Reply[] = [];
  private host = DRONE_FTP_HOST;

  async connect(host: string, port: number): Promise<Reply> {
    this.host = host;
    this.control = net.createConnection({ host, port });
    this.control.setEncoding('latin1');
    this.control.on('data', (chunk: string) => this.onData(chunk));
    const connected = new Promise<void>((resolve, reject) => {
      this.control?.once('connect', resolve);
      this.control?.once('error', reject);
    });
    const timeout = this.timeout('Could not reach the drone FTP.');
    await Promise.race([connected, timeout.promise]);
    timeout.cancel();
    this.control?.setTimeout(0);
    return this.read();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      // A reply ends on a line like "230 text" (code then space); "230-" continues.
      const match = /^(\d{3}) /.exec(line);
      if (match) {
        this.deliver({ code: Number(match[1]), text: line });
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private deliver(reply: Reply): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(reply);
    } else {
      this.pending.push(reply);
    }
  }

  private read(): Promise<Reply> {
    const queued = this.pending.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private timeout(message: string, ms = CONTROL_TIMEOUT_MS): { promise: Promise<never>; cancel: () => void } {
    let timer: NodeJS.Timeout;
    const promise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return { promise, cancel: () => clearTimeout(timer) };
  }

  /** Sends a command and waits for its reply. */
  private async command(line: string): Promise<Reply> {
    if (!this.control) {
      throw new Error('The FTP connection is closed.');
    }
    this.control.write(`${line}\r\n`);
    const timeout = this.timeout(`The drone did not answer "${line.split(' ')[0]}".`);
    try {
      return await Promise.race([this.read(), timeout.promise]);
    } finally {
      timeout.cancel();
    }
  }

  async login(user: string, password: string): Promise<boolean> {
    const userReply = await this.command(`USER ${user}`);
    if (userReply.code === 230) {
      return true;
    }
    if (userReply.code !== 331 && userReply.code !== 332) {
      return false;
    }
    const passReply = await this.command(`PASS ${password}`);
    return passReply.code === 230 || passReply.code === 202;
  }

  async binary(): Promise<void> {
    await this.command('TYPE I');
  }

  /** Opens a passive data connection for the next transfer. */
  private async openPassive(): Promise<net.Socket> {
    const reply = await this.command('PASV');
    const match = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(reply.text);
    if (reply.code !== 227 || !match) {
      throw new Error('The drone refused a data connection (PASV).');
    }
    const parts = match.slice(1, 7).map(Number);
    // The server may advertise its own address; the drone's is more reliable.
    const port = parts[4] * 256 + parts[5];
    const socket = net.createConnection({ host: this.host, port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return socket;
  }

  /** Collects a directory listing (LIST) as raw text. */
  async list(dir: string): Promise<string> {
    const data = await this.openPassive();
    const chunks: string[] = [];
    data.setEncoding('latin1');
    data.on('data', (chunk: string) => chunks.push(chunk));
    const reply = await this.command(`LIST ${dir}`);
    if (reply.code >= 400) {
      data.destroy();
      throw new Error(`The drone could not list ${dir}.`);
    }
    await new Promise<void>((resolve) => {
      data.once('close', resolve);
      data.once('end', resolve);
    });
    await this.read(); // the 226 "transfer complete" that follows
    return chunks.join('');
  }

  /** Asks the server for a file's size; -1 when it will not say. */
  async size(file: string): Promise<number> {
    try {
      const reply = await this.command(`SIZE ${file}`);
      const value = Number(reply.text.slice(4).trim());
      return reply.code === 213 && Number.isFinite(value) ? value : -1;
    } catch {
      return -1;
    }
  }

  /** Streams a file to a local path, reporting bytes as they arrive. */
  async retrieve(remote: string, localPath: string, onBytes: (bytes: number) => void): Promise<number> {
    const data = await this.openPassive();
    const reply = await this.command(`RETR ${remote}`);
    if (reply.code >= 400) {
      data.destroy();
      throw new Error(`The drone could not read ${remote}.`);
    }
    const out = createWriteStream(localPath);
    let received = 0;
    data.setTimeout(DATA_IDLE_TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
      data.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onBytes(received);
      });
      data.on('timeout', () => {
        data.destroy();
        reject(new Error('The download stalled.'));
      });
      data.on('error', reject);
      out.on('error', reject);
      data.pipe(out);
      out.once('finish', resolve);
    });
    await this.read(); // trailing 226
    return received;
  }

  async quit(): Promise<void> {
    try {
      if (this.control) {
        await this.command('QUIT');
      }
    } catch {
      // closing anyway
    }
    this.control?.destroy();
    this.control = null;
  }
}

/**
 * Parses a Unix `ls -l` style FTP listing. Lines that do not match are skipped.
 * The name is taken whole (it may contain spaces) from after the time field.
 */
export function parseFtpList(text: string): FtpEntry[] {
  const entries: FtpEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const match =
      /^([dlbcps-])([rwxsStT-]{9})\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, kind, , sizeText, modified, rest] = match;
    if (rest === '.' || rest === '..') {
      continue;
    }
    const type: FtpEntryType = kind === 'd' ? 'dir' : kind === 'l' ? 'link' : kind === '-' ? 'file' : 'other';
    let name = rest;
    let target: string | undefined;
    if (type === 'link') {
      const arrow = rest.indexOf(' -> ');
      if (arrow >= 0) {
        name = rest.slice(0, arrow);
        target = rest.slice(arrow + 4);
      }
    }
    entries.push({ name, type, size: Number(sizeText), modified, target });
  }
  return entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
}

const joinRemote = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`;
const safeName = (name: string): string => {
  const printable = [...name].map((char) => (char.charCodeAt(0) < 32 ? '_' : char)).join('');
  return printable.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'file';
};

let client: FtpClient | null = null;
let downloading = false;

async function disconnect(): Promise<void> {
  const old = client;
  client = null;
  await old?.quit().catch((): void => undefined);
}

function emitProgress(progress: FtpDownloadProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('ftp:progress', progress);
    }
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Registers all ftp:* IPC handlers. Call once at startup. */
export function registerDroneFtp(): void {
  ipcMain.handle(
    'ftp:connect',
    async (_event, options?: { host?: string; user?: string; password?: string }): Promise<FtpConnectResult> => {
      await disconnect();
      const host = options?.host?.trim() || DRONE_FTP_HOST;
      const logins =
        options?.user != null
          ? [{ user: options.user, password: options.password ?? '' }]
          : DRONE_FTP_LOGINS;
      const fresh = new FtpClient();
      let banner = '';
      try {
        const greeting = await fresh.connect(host, DRONE_FTP_PORT);
        banner = greeting.text;
        for (const login of logins) {
          if (await fresh.login(login.user, login.password)) {
            await fresh.binary();
            client = fresh;
            return { ok: true, message: `Signed in as ${login.user}.`, user: login.user, banner };
          }
        }
        await fresh.quit();
        return { ok: false, message: 'The drone refused the sign-in. Check the credentials.', banner };
      } catch (error) {
        await fresh.quit().catch((): void => undefined);
        return {
          ok: false,
          message: `${describe(error)} The drone must be on and showing as a USB network device (host 192.168.42.1).`,
          banner,
        };
      }
    },
  );

  ipcMain.handle('ftp:list', async (_event, dir: string): Promise<FtpListResult> => {
    if (!client) {
      return { ok: false, message: 'Not connected to the drone FTP.' };
    }
    const target = typeof dir === 'string' && dir.length > 0 ? dir : '/';
    try {
      return { ok: true, path: target, entries: parseFtpList(await client.list(target)) };
    } catch (error) {
      return { ok: false, message: describe(error) };
    }
  });

  ipcMain.handle('ftp:download', async (_event, dir: string, name: string): Promise<FtpDownloadResult> => {
    if (!client) {
      return { ok: false, message: 'Not connected to the drone FTP.' };
    }
    if (downloading) {
      return { ok: false, message: 'A download is already running.' };
    }
    const remote = joinRemote(String(dir), String(name));
    const window = BrowserWindow.getAllWindows()[0];
    const save = await dialog.showSaveDialog(window, { title: 'Save file from the drone', defaultPath: safeName(String(name)) });
    if (save.canceled || !save.filePath) {
      return { ok: false, message: '' };
    }
    downloading = true;
    try {
      const total = await client.size(remote);
      const bytes = await client.retrieve(remote, save.filePath, (received) =>
        emitProgress({ name: String(name), bytes: received, total: Math.max(0, total) }),
      );
      return { ok: true, message: `Saved ${bytes} bytes to ${save.filePath}`, file: save.filePath, bytes };
    } catch (error) {
      return { ok: false, message: describe(error) };
    } finally {
      downloading = false;
    }
  });

  ipcMain.handle('ftp:disconnect', async (): Promise<void> => {
    if (!downloading) {
      await disconnect();
    }
  });
}

export const _test = {
  parseFtpList,
  safeName,
  joinRemote: (d: string, n: string) => joinRemote(d, n),
  base: path.basename,
  /** The real client class, for tests to drive against a server. */
  FtpClient,
};
