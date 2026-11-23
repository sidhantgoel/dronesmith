import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiagnosticProgress, DiagnosticReport } from '../types';
import { DIAGNOSTIC_STAGES, diagnosticTotals } from '../diagnostics';
import type { LogDraft } from './useActivityLog';

export interface DiagnosticsNote {
  ok: boolean;
  text: string;
}

/** The full check's state, held above the pages so it outlives navigation. */
export interface DiagnosticsSession {
  running: boolean;
  progress: DiagnosticProgress | null;
  report: DiagnosticReport | null;
  note: DiagnosticsNote | null;
  run: () => Promise<void>;
  setNote: (note: DiagnosticsNote | null) => void;
}

/**
 * Runs the full check and keeps its progress and result. It lives in the app
 * shell, not in the Full check page, so leaving the page while a check runs,
 * or after it has finished, loses nothing.
 */
export function useDiagnostics(onLog: (draft: LogDraft) => void): DiagnosticsSession {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DiagnosticProgress | null>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [note, setNote] = useState<DiagnosticsNote | null>(null);
  const runningRef = useRef(false);

  useEffect(
    () =>
      window.drone.onDiagnosticProgress((next) => {
        if (runningRef.current) {
          setProgress(next);
        }
      }),
    [],
  );

  const run = useCallback(async (): Promise<void> => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setNote(null);
    setProgress({ done: 0, total: DIAGNOSTIC_STAGES.length, label: DIAGNOSTIC_STAGES[0] });
    try {
      const result = await window.drone.runDiagnostics();
      if (result) {
        setReport(result);
        const totals = diagnosticTotals(result.checks);
        onLog({
          level: totals.fail > 0 ? 'error' : totals.warn > 0 ? 'warn' : 'ok',
          text: `Full check: ${totals.fail} fault, ${totals.warn} attention, ${totals.ok} OK.`,
        });
      } else {
        setNote({ ok: false, text: 'The check could not run. Another operation may be using the aircraft.' });
      }
    } catch (error) {
      setNote({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      runningRef.current = false;
      setRunning(false);
      setProgress(null);
    }
  }, [onLog]);

  return { running, progress, report, note, run, setNote };
}
