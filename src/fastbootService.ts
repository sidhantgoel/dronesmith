/**
 * Fastboot explorer IPC: finds a drone that is in fastboot/bootloader mode,
 * reads its variables, and — behind explicit confirmation in the renderer —
 * flashes or erases a partition. Entering fastboot is handled in drone.ts over
 * the DUML link; this module only talks to a device that is already in it.
 *
 * Reads are safe. Flash and erase can brick the aircraft; the renderer gates
 * them, and flash additionally refuses an image larger than the device's
 * reported max-download-size.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { connectFastboot, type FastbootTransport } from './usb0';
import { FastbootClient, FastbootError, partitionProblem } from './fastboot';

export interface FastbootScanResult {
  ok: boolean;
  message: string;
  /** Variables read from the device (product, version, partitions…). */
  variables?: Record<string, string>;
}

export interface FastbootActionResult {
  ok: boolean;
  message: string;
}

export interface FastbootFlashProgress {
  partition: string;
  sent: number;
  total: number;
}

function dllPaths(): string[] {
  return [
    path.join(process.resourcesPath, 'libusb0.dll'),
    path.join(app.getAppPath(), 'resources', 'libusb0.dll'),
  ];
}

let transport: FastbootTransport | null = null;
let client: FastbootClient | null = null;
let busy = false;
let watchTimer: NodeJS.Timeout | null = null;

/** How often to re-check for a fastboot device, and how long to keep watching. */
const WATCH_INTERVAL_MS = 150;
const WATCH_TIMEOUT_MS = 180000;

function disconnect(): void {
  const old = transport;
  transport = null;
  client = null;
  try {
    old?.close();
  } catch {
    // closing anyway
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function connect(): FastbootActionResult {
  disconnect();
  const result = connectFastboot(dllPaths());
  if (!result.transport) {
    return {
      ok: false,
      message:
        result.error ??
        'No device is in fastboot mode. Put the aircraft into fastboot first, and make sure its fastboot interface is bound to the libusb-win32 driver.',
    };
  }
  transport = result.transport;
  client = new FastbootClient(transport);
  return { ok: true, message: `Connected to ${transport.label}.` };
}

function emitFlashProgress(progress: FastbootFlashProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('fastboot:flash-progress', progress);
    }
  }
}

function emit(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function stopWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

/**
 * Polls for a device appearing in fastboot and grabs it the instant it does.
 * The boot-time recovery window is very short, so on the first successful
 * connection it immediately reads the variables — which sends getvar commands
 * that, on a standard bootloader, hold the device in fastboot instead of letting
 * it continue booting. Nothing here forces the device in; it only catches it.
 */
function startWatch(): void {
  stopWatch();
  const existing = client;
  const existingLabel = transport?.label;
  if (existing) {
    // Already connected; report it straight away.
    void (async () => {
      try {
        emit('fastboot:found', { ok: true, message: `Connected to ${existingLabel}.`, variables: await existing.getvarAll() });
      } catch (error) {
        emit('fastboot:found', { ok: false, message: describe(error) });
      }
    })();
    return;
  }
  const startedAt = Date.now();
  watchTimer = setInterval(() => {
    if (busy || client) {
      return;
    }
    if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
      stopWatch();
      emit('fastboot:watch-stopped', { reason: 'timeout' });
      return;
    }
    const result = connectFastboot(dllPaths());
    if (!result.transport) {
      return; // nothing in fastboot yet; keep polling
    }
    stopWatch();
    transport = result.transport;
    const caught = new FastbootClient(transport);
    client = caught;
    const label = transport.label;
    // Read immediately: this both holds the device and fills the inspection.
    void (async () => {
      try {
        const variables = await caught.getvarAll();
        emit('fastboot:found', { ok: true, message: `Caught ${label} in fastboot.`, variables });
      } catch (error) {
        emit('fastboot:found', { ok: false, message: `Caught a fastboot device but reading it failed: ${describe(error)}` });
      }
    })();
  }, WATCH_INTERVAL_MS);
}

/** Registers all fastboot:* IPC handlers. Call once at startup. */
export function registerFastboot(): void {
  ipcMain.handle('fastboot:scan', async (): Promise<FastbootScanResult> => {
    if (busy) {
      return { ok: false, message: 'A fastboot operation is already running.' };
    }
    const connected = connect();
    if (!connected.ok || !client) {
      return { ok: false, message: connected.message };
    }
    try {
      return { ok: true, message: connected.message, variables: await client.getvarAll() };
    } catch (error) {
      return { ok: false, message: `Connected, but reading the device failed: ${describe(error)}` };
    }
  });

  ipcMain.handle('fastboot:reboot', async (_event, target: string): Promise<FastbootActionResult> => {
    if (!client) {
      return { ok: false, message: 'Not connected to a fastboot device.' };
    }
    const allowed = ['reboot', 'reboot-bootloader', 'reboot-fastboot', 'continue'] as const;
    const choice = allowed.find((value) => value === target);
    if (!choice) {
      return { ok: false, message: 'Unknown reboot target.' };
    }
    try {
      await client.reboot(choice);
      disconnect(); // the device leaves fastboot (or re-enumerates) after a reboot
      return { ok: true, message: `Sent "${choice}". The device is leaving fastboot.` };
    } catch (error) {
      return { ok: false, message: describe(error) };
    }
  });

  ipcMain.handle('fastboot:erase', async (_event, partition: string): Promise<FastbootActionResult> => {
    if (!client) {
      return { ok: false, message: 'Not connected to a fastboot device.' };
    }
    if (busy) {
      return { ok: false, message: 'A fastboot operation is already running.' };
    }
    const problem = partitionProblem(String(partition));
    if (problem) {
      return { ok: false, message: problem };
    }
    busy = true;
    try {
      await client.erase(String(partition));
      return { ok: true, message: `Erased "${partition}".` };
    } catch (error) {
      return { ok: false, message: error instanceof FastbootError ? error.message : describe(error) };
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('fastboot:flash', async (_event, partition: string): Promise<FastbootActionResult> => {
    if (!client) {
      return { ok: false, message: 'Not connected to a fastboot device.' };
    }
    if (busy) {
      return { ok: false, message: 'A fastboot operation is already running.' };
    }
    const problem = partitionProblem(String(partition));
    if (problem) {
      return { ok: false, message: problem };
    }
    const window = BrowserWindow.getAllWindows()[0];
    const picked = await dialog.showOpenDialog(window, {
      title: `Choose the image to write to "${partition}"`,
      properties: ['openFile'],
      filters: [
        { name: 'Partition image', extensions: ['img', 'bin', 'mbn', 'elf', 'raw'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, message: '' };
    }
    busy = true;
    try {
      const image = await readFile(picked.filePaths[0]);
      const max = await client.maxDownloadSize();
      if (max !== undefined && image.length > max) {
        return {
          ok: false,
          message: `The image is ${image.length} bytes but the device accepts at most ${max}. A larger partition needs a sparse image, which this tool does not build.`,
        };
      }
      await client.flash(String(partition), image, (progress) =>
        emitFlashProgress({ partition: String(partition), sent: progress.sent, total: progress.total }),
      );
      return { ok: true, message: `Wrote ${image.length} bytes to "${partition}".` };
    } catch (error) {
      return { ok: false, message: error instanceof FastbootError ? error.message : describe(error) };
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('fastboot:watch', (_event, on: boolean): FastbootActionResult => {
    if (on === true) {
      startWatch();
      return { ok: true, message: 'Waiting for a fastboot device — power-cycle the aircraft now.' };
    }
    stopWatch();
    return { ok: true, message: 'Stopped waiting.' };
  });

  ipcMain.handle('fastboot:disconnect', (): void => {
    stopWatch();
    if (!busy) {
      disconnect();
    }
  });
}
