import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalibrationState, DroneState } from '../types';
import { CALIBRATION_TITLES, PHASE_LABELS } from './labels';

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  /** Epoch milliseconds. */
  at: number;
  level: LogLevel;
  text: string;
  detail?: string;
}

export type LogDraft = Omit<LogEntry, 'id' | 'at'>;
type Draft = LogDraft;

const MAX_ENTRIES = 500;

const PHASE_LEVEL: Record<CalibrationState['phase'], LogLevel> = {
  running: 'info',
  pass: 'ok',
  unsure: 'warn',
  failed: 'error',
};

/** Turns the difference between two drone states into log lines. */
function describe(prev: DroneState, next: DroneState): Draft[] {
  const out: Draft[] = [];
  const wasConnected = prev.status === 'connected';
  const isConnected = next.status === 'connected';

  if (!wasConnected && isConnected) {
    out.push({
      level: 'ok',
      text: `Linked to ${next.label ?? 'aircraft'}`,
      detail: next.model ? `Model ${next.model}` : undefined,
    });
  }
  if (wasConnected && !isConnected) {
    out.push({ level: 'warn', text: 'Aircraft disconnected' });
  }
  if (next.error && next.error !== prev.error) {
    out.push({ level: 'error', text: next.error });
  }

  if (isConnected) {
    const known = new Set(wasConnected ? prev.modules.map((module) => module.name) : []);
    for (const module of next.modules) {
      if (!known.has(module.name)) {
        out.push({
          level: 'info',
          text: `${module.name} answered`,
          detail: `hw ${module.hardware} · fw ${module.firmware} · loader ${module.loader}`,
        });
      }
    }
    if (wasConnected && prev.scanning && !next.scanning) {
      const count = next.modules.length;
      out.push({
        level: 'ok',
        text: `Module scan finished, ${count} ${count === 1 ? 'module' : 'modules'}`,
      });
    }
    if (next.cameraSerial && next.cameraSerial !== prev.cameraSerial) {
      out.push({ level: 'info', text: `Camera serial ${next.cameraSerial}` });
    }
  }

  const before = prev.calibration;
  const after = next.calibration;
  if (after) {
    const title = CALIBRATION_TITLES[after.kind];
    const sameRun = before?.startedAt === after.startedAt;
    if (!sameRun) {
      out.push({ level: 'info', text: `${title} calibration started` });
    }
    const previousPhase = sameRun && before ? before.phase : 'running';
    if (after.phase !== previousPhase) {
      out.push({
        level: PHASE_LEVEL[after.phase],
        text: `${title}: ${PHASE_LABELS[after.phase].toLowerCase()}`,
        detail: after.message,
      });
    } else if (sameRun && before && before.message !== after.message) {
      out.push({ level: 'info', text: after.message });
    }
  }

  return out;
}

/** Session-only log of what happened to the link, the scan and calibrations. */
export function useActivityLog(drone: DroneState): {
  entries: LogEntry[];
  clear: () => void;
  add: (draft: Draft) => void;
} {
  const [entries, setEntries] = useState<LogEntry[]>(() => [
    {
      id: 0,
      at: Date.now(),
      level: 'info',
      text: 'Session started. Watching USB for a DJI device.',
    },
  ]);
  const previous = useRef(drone);
  const nextId = useRef(1);

  useEffect(() => {
    const drafts = describe(previous.current, drone);
    previous.current = drone;
    if (drafts.length === 0) {
      return;
    }
    const at = Date.now();
    const added = drafts.map((draft) => {
      const id = nextId.current;
      nextId.current += 1;
      return { ...draft, id, at };
    });
    setEntries((current) => [...current, ...added].slice(-MAX_ENTRIES));
  }, [drone]);

  const clear = useCallback(() => setEntries([]), []);

  const add = useCallback((draft: Draft) => {
    setEntries((current) => {
      const id = nextId.current;
      nextId.current += 1;
      return [...current, { ...draft, id, at: Date.now() }].slice(-MAX_ENTRIES);
    });
  }, []);

  return { entries, clear, add };
}
