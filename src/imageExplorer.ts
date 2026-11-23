/**
 * Partition image explorer IPC: opens a partition dump file, finds the ext
 * filesystems in it and lets the renderer browse, preview and extract files.
 * The image is only ever opened for reading.
 */
import path from 'node:path';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { Ext4Volume, probePartitions, type FsEntry, type FsStats, type ImageSource, type PartitionCandidate } from './ext4';

export interface ImageOpenResult {
  ok: boolean;
  message?: string;
  path?: string;
  size?: number;
  partitions?: PartitionCandidate[];
}

export interface ImageMountResult {
  ok: boolean;
  message?: string;
  stats?: FsStats;
}

export interface ImageListResult {
  ok: boolean;
  message?: string;
  entries?: FsEntry[];
}

export interface ImagePreview {
  ok: boolean;
  message?: string;
  /** The start of the file as text, when it reads as text. */
  text?: string;
  /** The start of the file as a hex dump, when it does not. */
  hex?: string;
  /** True when the file is longer than the part shown. */
  truncated?: boolean;
}

export interface ImageExtractResult {
  ok: boolean;
  message: string;
  files?: number;
  bytes?: number;
}

export interface ImageExtractProgress {
  files: number;
  bytes: number;
  name: string;
}

const PREVIEW_BYTES = 64 * 1024;
const HEX_PREVIEW_BYTES = 2048;
/** Characters Windows does not allow in a file name (control characters are handled apart). */
const UNSAFE_NAME = /[<>:"/\\|?*]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

let handle: FileHandle | null = null;
let source: ImageSource | null = null;
let volume: Ext4Volume | null = null;
let extracting = false;

async function closeImage(): Promise<void> {
  volume = null;
  source = null;
  const old = handle;
  handle = null;
  await old?.close().catch((): void => undefined);
}

function fileSource(file: FileHandle, size: number): ImageSource {
  return {
    size,
    async read(offset: number, length: number): Promise<Buffer> {
      const wanted = Math.max(0, Math.min(length, size - offset));
      const buffer = Buffer.alloc(wanted);
      let done = 0;
      while (done < wanted) {
        const { bytesRead } = await file.read(buffer, done, wanted - done, offset + done);
        if (bytesRead === 0) {
          break;
        }
        done += bytesRead;
      }
      return done === wanted ? buffer : buffer.subarray(0, done);
    },
  };
}

/** A name that is safe to create on this computer. */
function safeName(name: string): string {
  const printable = [...name].map((char) => (char.charCodeAt(0) < 32 ? '_' : char)).join('');
  const cleaned = printable.replace(UNSAFE_NAME, '_').replace(/[. ]+$/, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return '_';
  }
  return RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

function looksTextual(data: Buffer): boolean {
  if (data.length === 0) {
    return true;
  }
  let odd = 0;
  for (const byte of data) {
    if (byte === 0) {
      return false;
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      odd += 1;
    }
  }
  return odd / data.length < 0.02;
}

function hexDump(data: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < data.length; offset += 16) {
    const row = data.subarray(offset, offset + 16);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const text = [...row].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${text}`);
  }
  return lines.join('\n');
}

function emitProgress(progress: ImageExtractProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('image:progress', progress);
    }
  }
}

const joinPath = (folder: string, name: string): string => `${folder.replace(/\/+$/, '')}/${name}`;

async function writeOut(mounted: Ext4Volume, remote: string, local: string, tally: ImageExtractProgress): Promise<void> {
  const out = await open(local, 'w');
  try {
    await mounted.readFile(remote, async (chunk) => {
      await out.write(chunk);
      tally.bytes += chunk.length;
      emitProgress(tally);
    });
  } finally {
    await out.close();
  }
  tally.files += 1;
}

/** Extracts a folder and everything under it; links and special files are skipped. */
async function extractTree(
  mounted: Ext4Volume,
  remote: string,
  local: string,
  tally: ImageExtractProgress,
  skipped: string[],
): Promise<void> {
  await mkdir(local, { recursive: true });
  for (const entry of await mounted.list(remote)) {
    const child = joinPath(remote, entry.name);
    const target = path.join(local, safeName(entry.name));
    tally.name = entry.name;
    if (entry.type === 'dir') {
      await extractTree(mounted, child, target, tally, skipped);
    } else if (entry.type === 'file' && !entry.inline) {
      try {
        await writeOut(mounted, child, target, tally);
      } catch {
        skipped.push(child);
      }
    } else {
      skipped.push(child);
    }
    emitProgress(tally);
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Registers all image:* IPC handlers. Call once at startup. */
export function registerImageExplorer(): void {
  ipcMain.handle('image:open', async (): Promise<ImageOpenResult> => {
    if (extracting) {
      return { ok: false, message: 'An extraction is still running.' };
    }
    const window = BrowserWindow.getAllWindows()[0];
    const picked = await dialog.showOpenDialog(window, {
      title: 'Open a partition image',
      properties: ['openFile'],
      filters: [
        { name: 'Partition images', extensions: ['img', 'bin', 'ext4', 'dd', 'raw', 'dump'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false };
    }
    await closeImage();
    try {
      const file = await open(picked.filePaths[0], 'r');
      handle = file;
      const { size } = await file.stat();
      source = fileSource(file, size);
      const partitions = await probePartitions(source);
      return { ok: true, path: picked.filePaths[0], size, partitions };
    } catch (error) {
      await closeImage();
      return { ok: false, message: describe(error) };
    }
  });

  ipcMain.handle('image:mount', async (_event, offset: number): Promise<ImageMountResult> => {
    if (!source) {
      return { ok: false, message: 'No image is open.' };
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return { ok: false, message: 'Unknown partition.' };
    }
    try {
      volume = await Ext4Volume.open(source, offset);
      return { ok: true, stats: volume.stats };
    } catch (error) {
      volume = null;
      return { ok: false, message: describe(error) };
    }
  });

  ipcMain.handle('image:list', async (_event, folder: string): Promise<ImageListResult> => {
    if (!volume) {
      return { ok: false, message: 'No filesystem is open.' };
    }
    try {
      return { ok: true, entries: await volume.list(String(folder)) };
    } catch (error) {
      return { ok: false, message: describe(error) };
    }
  });

  ipcMain.handle('image:preview', async (_event, file: string): Promise<ImagePreview> => {
    if (!volume) {
      return { ok: false, message: 'No filesystem is open.' };
    }
    try {
      const entry = await volume.stat(String(file));
      const head = await volume.readHead(String(file), PREVIEW_BYTES);
      if (looksTextual(head)) {
        return { ok: true, text: head.toString('utf8'), truncated: entry.size > head.length };
      }
      const shown = head.subarray(0, HEX_PREVIEW_BYTES);
      return { ok: true, hex: hexDump(shown), truncated: entry.size > shown.length };
    } catch (error) {
      return { ok: false, message: describe(error) };
    }
  });

  ipcMain.handle('image:extract', async (_event, remote: string): Promise<ImageExtractResult> => {
    const mounted = volume;
    if (!mounted) {
      return { ok: false, message: 'No filesystem is open.' };
    }
    if (extracting) {
      return { ok: false, message: 'An extraction is already running.' };
    }
    const window = BrowserWindow.getAllWindows()[0];
    const tally: ImageExtractProgress = { files: 0, bytes: 0, name: '' };
    try {
      const entry = await mounted.stat(String(remote));
      if (entry.type === 'file') {
        if (entry.inline) {
          return { ok: false, message: 'This file is stored inside its record, which is not supported.' };
        }
        const save = await dialog.showSaveDialog(window, { title: 'Extract file', defaultPath: safeName(entry.name) });
        if (save.canceled || !save.filePath) {
          return { ok: false, message: '' };
        }
        extracting = true;
        tally.name = entry.name;
        await writeOut(mounted, String(remote), save.filePath, tally);
        return { ok: true, message: `Extracted to ${save.filePath}`, files: 1, bytes: tally.bytes };
      }
      if (entry.type !== 'dir') {
        return { ok: false, message: 'Only files and folders can be extracted.' };
      }
      const pick = await dialog.showOpenDialog(window, {
        title: 'Choose where to extract the folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (pick.canceled || pick.filePaths.length === 0) {
        return { ok: false, message: '' };
      }
      extracting = true;
      const folderName = remote === '/' || remote === '' ? 'image-root' : safeName(entry.name);
      const target = path.join(pick.filePaths[0], folderName);
      const skipped: string[] = [];
      await extractTree(mounted, String(remote) || '/', target, tally, skipped);
      const note = skipped.length > 0 ? ` ${skipped.length} link or special entries were skipped.` : '';
      return {
        ok: true,
        message: `Extracted ${tally.files} file${tally.files === 1 ? '' : 's'} to ${target}.${note}`,
        files: tally.files,
        bytes: tally.bytes,
      };
    } catch (error) {
      return { ok: false, message: describe(error), files: tally.files, bytes: tally.bytes };
    } finally {
      extracting = false;
    }
  });

  ipcMain.handle('image:close', async (): Promise<void> => {
    if (!extracting) {
      await closeImage();
    }
  });
}
