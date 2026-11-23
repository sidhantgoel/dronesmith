/**
 * The full check and the service report built from it.
 *
 * Runs one long burst of queries (fault codes, vision calibration, the eight
 * vision sensors, battery, module versions and serials), turns each answer
 * into a pass / attention / fail row, and produces a plain-text report of the
 * rows for a job sheet.
 *
 * Pure, so the main process (to write the file) and the renderer (to show the
 * rows) share one definition.
 */
import { batteryHealth, type BatterySnapshot } from './battery';
import type { HmsFault } from './hms';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DiagnosticCheck {
  group: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DiagnosticModule {
  name: string;
  firmware: string;
  hardware: string;
}

export interface DiagnosticReport {
  /** Epoch milliseconds the check finished. */
  at: number;
  model?: string;
  modelCode?: string;
  serial?: string;
  cameraSerial?: string;
  firmware?: string;
  modules: DiagnosticModule[];
  faults: HmsFault[];
  battery?: BatterySnapshot;
  checks: DiagnosticCheck[];
}

export interface DiagnosticProgress {
  done: number;
  total: number;
  label: string;
}

/** The sweep's stages, in order. */
export const DIAGNOSTIC_STAGES = [
  'Fault codes',
  'Serial numbers',
  'Vision calibration',
  'Vision sensors',
  'Battery',
  'Radio links',
] as const;

/** Health below this is flagged for attention; below the lower one, as a fault. */
export const HEALTH_WARN = 80;
export const HEALTH_FAIL = 60;
/** Spread between the highest and lowest cell, in millivolts. */
export const CELL_SPREAD_WARN_MV = 50;
export const CELL_SPREAD_FAIL_MV = 100;

/** HMS levels, as the aircraft reports them. */
const LEVEL_WARNING = 2;
const LEVEL_CRITICAL = 3;

export function faultChecks(faults: HmsFault[], answered: boolean): DiagnosticCheck[] {
  const group = 'Fault codes';
  if (!answered && faults.length === 0) {
    return [{ group, name: 'Fault codes', status: 'info', detail: 'The aircraft did not report its fault list.' }];
  }
  if (faults.length === 0) {
    return [{ group, name: 'Fault codes', status: 'ok', detail: 'No faults reported.' }];
  }
  return faults.map((fault) => ({
    group,
    name: `${fault.codeHex} · ${fault.module}`,
    status: fault.level >= LEVEL_CRITICAL ? 'fail' : fault.level >= LEVEL_WARNING ? 'warn' : 'info',
    detail: fault.text,
  }));
}

export function batteryChecks(battery: BatterySnapshot | undefined): DiagnosticCheck[] {
  const group = 'Battery';
  if (!battery || (!battery.live && !battery.pack && !battery.cellVoltages)) {
    return [{ group, name: 'Battery', status: 'info', detail: 'The battery did not answer.' }];
  }
  const checks: DiagnosticCheck[] = [];
  if (battery.live) {
    checks.push({
      group,
      name: 'Charge',
      status: 'info',
      detail: `${battery.live.percent} % · ${(battery.live.voltage / 1000).toFixed(2)} V · ${battery.live.temperature.toFixed(1)} °C`,
    });
  }
  const health = batteryHealth(battery);
  if (health !== undefined) {
    checks.push({
      group,
      name: 'Health',
      status: health < HEALTH_FAIL ? 'fail' : health < HEALTH_WARN ? 'warn' : 'ok',
      detail: `${health.toFixed(0)} % of design capacity${battery.pack ? ` · ${battery.pack.cycles} cycles` : ''}`,
    });
  } else if (battery.pack) {
    checks.push({ group, name: 'Cycles', status: 'info', detail: String(battery.pack.cycles) });
  }
  const cells = battery.cellVoltages ?? [];
  if (cells.length >= 2) {
    const spread = Math.max(...cells) - Math.min(...cells);
    checks.push({
      group,
      name: 'Cell balance',
      status: spread >= CELL_SPREAD_FAIL_MV ? 'fail' : spread >= CELL_SPREAD_WARN_MV ? 'warn' : 'ok',
      detail: `${cells.length} cells, ${spread} mV between the highest and lowest`,
    });
  }
  if (battery.serial) {
    checks.push({ group, name: 'Serial', status: 'info', detail: battery.serial });
  }
  return checks;
}

export interface DiagnosticTotals {
  ok: number;
  warn: number;
  fail: number;
  info: number;
}

export function diagnosticTotals(checks: DiagnosticCheck[]): DiagnosticTotals {
  const totals: DiagnosticTotals = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) {
    totals[check.status] += 1;
  }
  return totals;
}

const STATUS_WORD: Record<CheckStatus, string> = { ok: 'OK', warn: 'ATTENTION', fail: 'FAULT', info: 'INFO' };

const pad = (value: number): string => String(value).padStart(2, '0');

function timestamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A file-name-safe stamp for the report, e.g. "2026-11-22-1843". */
export function reportFileStamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** The report as plain text, one section per group. */
export function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  const row = (label: string, value: string | undefined): void => {
    lines.push(`${`${label}:`.padEnd(18)}${value && value.length > 0 ? value : '—'}`);
  };
  const totals = diagnosticTotals(report.checks);

  lines.push('AIRCRAFT SERVICE REPORT');
  lines.push('=======================');
  row('Date', timestamp(report.at));
  row('Aircraft', report.model);
  row('Factory code', report.modelCode);
  row('Serial', report.serial);
  row('Camera serial', report.cameraSerial);
  row('Firmware', report.firmware);
  row('Result', `${totals.fail} fault, ${totals.warn} attention, ${totals.ok} OK`);

  const groups: string[] = [];
  for (const check of report.checks) {
    if (!groups.includes(check.group)) {
      groups.push(check.group);
    }
  }
  for (const group of groups) {
    lines.push('');
    lines.push(group.toUpperCase());
    lines.push('-'.repeat(group.length));
    for (const check of report.checks.filter((entry) => entry.group === group)) {
      lines.push(`[${STATUS_WORD[check.status].padEnd(9)}] ${check.name}: ${check.detail}`);
    }
  }

  lines.push('');
  lines.push('MODULES');
  lines.push('-------');
  if (report.modules.length === 0) {
    lines.push('No module reported a version.');
  }
  for (const module of report.modules) {
    lines.push(`${module.name.padEnd(26)}firmware ${module.firmware || '—'}   hardware ${module.hardware || '—'}`);
  }
  lines.push('');
  return lines.join('\r\n');
}
