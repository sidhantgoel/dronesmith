/**
 * ADB (Android Debug Bridge) wrapper for the DJI smart-controller service tools
 * (RC, RC 2, RC Pro, RC Plus). It shells out to a bundled `adb.exe`
 * (Android platform-tools, Apache-2.0) and
 * exposes device info, package management, install/uninstall, APK pull, launcher
 * replacement, a shell runner, file transfer and settings read/write.
 *
 * Pure of Electron so the command building stays testable; the IPC layer and
 * file dialogs live in rc.ts.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AdbResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface RcDevice {
  serial: string;
  state: string;
}

export interface RcInfo {
  serial: string;
  state: string;
  model: string;
  android: string;
  sdk: string;
  firmware: string;
  battery: number;
  root: boolean;
}

export interface RcPackage {
  pkg: string;
  apkPath: string;
  system: boolean;
}

/** Resolves the bundled adb executable, falling back to PATH. */
export function adbPath(resourcesDir: string): string {
  const bundled = path.join(resourcesDir, 'adb', process.platform === 'win32' ? 'adb.exe' : 'adb');
  if (existsSync(bundled)) {
    return bundled;
  }
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

/** Runs one adb invocation and resolves with its captured output. */
export function runAdb(exe: string, args: string[], timeoutMs = 20000): Promise<AdbResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd: exe.includes('adb') ? path.dirname(exe) : undefined,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: `adb not available: ${String(err)}`, code: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Largest screen capture accepted, as a guard against runaway output. */
const SCREENCAP_MAX_BYTES = 32 * 1024 * 1024;

/** An adb client bound to one bundled executable. */
export class Adb {
  constructor(private readonly exe: string) {}

  run(args: string[], timeoutMs?: number): Promise<AdbResult> {
    return runAdb(this.exe, args, timeoutMs);
  }

  startServer(): Promise<AdbResult> {
    return this.run(['start-server'], 15000);
  }

  killServer(): Promise<AdbResult> {
    return this.run(['kill-server'], 10000);
  }

  async listDevices(): Promise<RcDevice[]> {
    const res = await this.run(['devices', '-l'], 10000);
    if (!res.ok && !res.stdout) {
      return [];
    }
    return res.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state] = line.split(/\s+/);
        return { serial, state: state || 'unknown' };
      })
      .filter((d) => d.serial && !d.serial.startsWith('*'));
  }

  /**
   * Captures the controller's screen as a PNG (`exec-out screencap -p`).
   * Resolves with null when the capture fails or the output is not a PNG.
   */
  screencap(serial: string, timeoutMs = 8000): Promise<Buffer | null> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.exe, ['-s', serial, 'exec-out', 'screencap', '-p'], {
          cwd: this.exe.includes('adb') ? path.dirname(this.exe) : undefined,
          windowsHide: true,
        });
      } catch {
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const png = Buffer.concat(chunks);
        const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
        resolve(ok && isPng ? png : null);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(false);
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= SCREENCAP_MAX_BYTES) {
          chunks.push(chunk);
        }
      });
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0 && size <= SCREENCAP_MAX_BYTES));
    });
  }

  private async prop(serial: string, key: string): Promise<string> {
    const res = await this.run(['-s', serial, 'shell', 'getprop', key], 8000);
    return res.ok ? res.stdout.trim() : '';
  }

  async deviceInfo(serial: string): Promise<RcInfo> {
    const info: RcInfo = {
      serial,
      state: 'device',
      model: '',
      android: '',
      sdk: '',
      firmware: '',
      battery: 0,
      root: false,
    };
    info.model = (await this.prop(serial, 'ro.product.model')) || (await this.prop(serial, 'ro.product.name'));
    info.android = await this.prop(serial, 'ro.build.version.release');
    info.sdk = await this.prop(serial, 'ro.build.version.sdk');
    info.firmware =
      (await this.prop(serial, 'ro.dji.device.version')) ||
      (await this.prop(serial, 'persist.sys.dji.version')) ||
      (await this.prop(serial, 'ro.build.display.id'));
    const battery = await this.run(['-s', serial, 'shell', 'dumpsys', 'battery'], 8000);
    const level = /level:\s*(\d+)/.exec(battery.stdout);
    if (level) {
      info.battery = parseInt(level[1], 10);
    }
    const id = await this.run(['-s', serial, 'shell', 'id'], 8000);
    info.root = /uid=0\(root\)/.test(id.stdout);
    return info;
  }

  async listPackages(serial: string, thirdPartyOnly = true): Promise<RcPackage[]> {
    const args = ['-s', serial, 'shell', 'pm', 'list', 'packages', '-f'];
    if (thirdPartyOnly) {
      args.push('-3');
    }
    const res = await this.run(args, 20000);
    return res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => {
        const body = line.slice('package:'.length);
        const eq = body.lastIndexOf('=');
        const apkPath = eq > 0 ? body.slice(0, eq) : '';
        const pkg = eq > 0 ? body.slice(eq + 1) : body;
        return { pkg, apkPath, system: apkPath.startsWith('/system') || apkPath.startsWith('/product') };
      })
      .filter((p) => p.pkg);
  }

  install(serial: string, apkPath: string, grantPerms = false, downgrade = false): Promise<AdbResult> {
    const args = ['-s', serial, 'install', '-r'];
    if (grantPerms) {
      args.push('-g');
    }
    if (downgrade) {
      args.push('-d');
    }
    args.push(apkPath);
    return this.run(args, 180000);
  }

  uninstall(serial: string, pkg: string): Promise<AdbResult> {
    return this.run(['-s', serial, 'uninstall', pkg], 30000);
  }

  setHomeActivity(serial: string, component: string): Promise<AdbResult> {
    return this.run(['-s', serial, 'shell', 'cmd', 'package', 'set-home-activity', component], 15000);
  }

  /** Lists activities that can act as the Android home/launcher. */
  async listLaunchers(serial: string): Promise<string[]> {
    const res = await this.run(
      ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'],
      15000,
    );
    const out = new Set<string>();
    for (const m of res.stdout.matchAll(/([a-zA-Z0-9_.]+\/[a-zA-Z0-9_.$]+)/g)) {
      out.add(m[1]);
    }
    return [...out];
  }

  shell(serial: string, command: string): Promise<AdbResult> {
    return this.run(['-s', serial, 'shell', command], 30000);
  }

  launchApp(serial: string, pkg: string): Promise<AdbResult> {
    return this.shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  }

  forceStop(serial: string, pkg: string): Promise<AdbResult> {
    return this.shell(serial, `am force-stop ${pkg}`);
  }

  setEnabled(serial: string, pkg: string, enabled: boolean): Promise<AdbResult> {
    return this.shell(serial, enabled ? `pm enable ${pkg}` : `pm disable-user --user 0 ${pkg}`);
  }

  clearData(serial: string, pkg: string): Promise<AdbResult> {
    return this.shell(serial, `pm clear ${pkg}`);
  }

  async pullApk(
    serial: string,
    pkg: string,
    outDir: string,
  ): Promise<{ ok: boolean; file?: string; split?: boolean; error?: string }> {
    const res = await this.run(['-s', serial, 'shell', 'pm', 'path', pkg], 15000);
    const paths = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('package:'))
      .map((l) => l.slice('package:'.length));
    if (paths.length === 0) {
      return { ok: false, error: `No APK path for ${pkg}` };
    }
    const src = paths.find((p) => p.endsWith('base.apk')) ?? paths[0];
    const dest = path.join(outDir, `${pkg}.apk`);
    const pull = await this.run(['-s', serial, 'pull', src, dest], 180000);
    if (!existsSync(dest)) {
      return { ok: false, error: `${pkg}: ${pull.stderr || pull.stdout || 'pull failed'}` };
    }
    return { ok: true, file: dest, split: paths.length > 1 };
  }

  pull(serial: string, remote: string, local: string): Promise<AdbResult> {
    return this.run(['-s', serial, 'pull', remote, local], 180000);
  }

  push(serial: string, local: string, remote: string): Promise<AdbResult> {
    return this.run(['-s', serial, 'push', local, remote], 180000);
  }

  async listDir(serial: string, dir: string): Promise<AdbResult> {
    return this.shell(serial, `ls -la ${shellQuote(dir)}`);
  }

  settingsGet(serial: string, namespace: string, key: string): Promise<AdbResult> {
    return this.shell(serial, `settings get ${namespace} ${key}`);
  }

  settingsPut(serial: string, namespace: string, key: string, value: string): Promise<AdbResult> {
    return this.shell(serial, `settings put ${namespace} ${key} ${shellQuote(value)}`);
  }

  async tryRoot(serial: string): Promise<{ root: boolean; message: string }> {
    const root = await this.run(['-s', serial, 'root'], 15000);
    const out = `${root.stdout} ${root.stderr}`.trim();
    if (/cannot run as root/i.test(out)) {
      return { root: false, message: out };
    }
    const id = await this.run(['-s', serial, 'shell', 'id'], 10000);
    return { root: /uid=0\(root\)/.test(id.stdout), message: out || id.stdout };
  }
}

/** Wraps a value in single quotes for an adb shell command, escaping quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
