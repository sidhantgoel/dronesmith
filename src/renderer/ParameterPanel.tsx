import { useEffect, useMemo, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, ParamBackupFileResult, ParamEntry, ParamProgress } from '../types';
import type { LogDraft } from './useActivityLog';
import { AlertIcon, CheckIcon } from './icons';
import { Btn, Overline, PageHeader, Panel } from './ui';

const BACKUP_KIND = 'dji-param-backup';

interface BackupParam {
  index: number;
  name: string;
  value: number;
  size: number;
  typeId: number;
}

interface BackupFile {
  app: string;
  kind: string;
  savedAt: string;
  model?: string;
  serial?: string;
  count: number;
  params: BackupParam[];
}

/** One parameter whose backed-up value differs from the current live value. */
interface RestoreChange {
  index: number;
  name: string;
  from: number;
  to: number;
  size: number;
  typeId: number;
  selected: boolean;
}

interface RestorePlan {
  file: string;
  changes: RestoreChange[];
  /** In the file but not in the current table. */
  missing: number;
  /** Already equal to the live value. */
  unchanged: number;
}

function ValueInput({
  value,
  dirty,
  onChange,
}: {
  value: string;
  dirty: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <chakra.input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      w="full"
      h="26px"
      px="8px"
      fontFamily="mono"
      fontSize="11.5px"
      bg={dirty ? 'warn.soft' : 'bg.raised'}
      borderWidth="1px"
      borderColor={dirty ? 'warn' : 'border.strong'}
      borderRadius="6px"
      color="fg"
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
    />
  );
}

function ParameterPanel({ drone, onLog }: { drone: DroneState; onLog?: (draft: LogDraft) => void }) {
  const connected = drone.status === 'connected';
  const [entries, setEntries] = useState<ParamEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ParamProgress | null>(null);
  const [filter, setFilter] = useState('');
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestorePlan | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => window.drone.onParamProgress((p) => setProgress(p as ParamProgress)), []);

  const readAll = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setEntries([]);
    setEdits({});
    setStatus({});
    setProgress({ phase: 'reading', done: 0, total: 0 });
    try {
      const result = await window.drone.readAllParams();
      setEntries(result.entries);
      if (!result.ok || result.entries.length === 0) {
        setError(result.error ?? 'The aircraft returned no parameters.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const save = async (entry: ParamEntry): Promise<void> => {
    const key = entry.index as number;
    const next = edits[key];
    if (!entry.name || next === undefined || entry.size === undefined) return;
    const num = Number(next.trim());
    if (!Number.isFinite(num)) {
      setStatus((s) => ({ ...s, [key]: 'not a number' }));
      return;
    }
    setStatus((s) => ({ ...s, [key]: 'saving' }));
    try {
      const result = await window.drone.writeParam(entry.name, key, num, entry.size, entry.typeId ?? 2);
      setStatus((s) => ({ ...s, [key]: result.ok ? 'ok' : result.message }));
      onLog?.({
        level: result.ok ? 'ok' : 'error',
        text: `Write ${entry.name} = ${num}`,
        detail: result.message,
      });
      if (result.ok) {
        setEntries((list) =>
          list.map((e) => (e.index === key ? { ...e, value: Math.trunc(num) } : e)),
        );
        setEdits((m) => {
          const rest = { ...m };
          delete rest[key];
          return rest;
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({ ...s, [key]: msg }));
      onLog?.({ level: 'error', text: `Write ${entry.name} = ${num}`, detail: msg });
    }
  };

  const exportBackup = async (): Promise<void> => {
    const params: BackupParam[] = entries
      .filter((e) => e.name && e.index !== undefined && e.value !== undefined && e.size !== undefined)
      .map((e) => ({
        index: e.index as number,
        name: e.name as string,
        value: e.value as number,
        size: e.size as number,
        typeId: e.typeId ?? 2,
      }));
    const backup: BackupFile = {
      app: 'dronesmith',
      kind: BACKUP_KIND,
      savedAt: new Date().toISOString(),
      model: drone.model,
      serial: drone.serial,
      count: params.length,
      params,
    };
    const result = (await window.drone.saveParamBackup(
      JSON.stringify(backup, null, 2),
    )) as ParamBackupFileResult;
    if (result.ok) {
      onLog?.({ level: 'ok', text: `Exported ${params.length} parameters`, detail: result.path });
    } else if (result.error && result.error !== 'cancelled') {
      onLog?.({ level: 'error', text: 'Export failed', detail: result.error });
    }
  };

  const importBackup = async (): Promise<void> => {
    const result = (await window.drone.loadParamBackup()) as ParamBackupFileResult;
    if (!result.ok) {
      if (result.error && result.error !== 'cancelled') {
        setError(`Could not open backup: ${result.error}`);
      }
      return;
    }
    let file: BackupFile;
    try {
      file = JSON.parse(result.text ?? '') as BackupFile;
    } catch {
      setError('That file is not valid JSON.');
      return;
    }
    if (file.kind !== BACKUP_KIND || !Array.isArray(file.params)) {
      setError('That file is not a DJI parameter backup.');
      return;
    }
    // Match by name against the current table; use the LIVE table's index/size/
    // typeId (firmware can differ from the backup), and only propose params that
    // actually differ from the current value.
    const byName = new Map(entries.filter((e) => e.name).map((e) => [e.name as string, e]));
    const changes: RestoreChange[] = [];
    let missing = 0;
    let unchanged = 0;
    for (const p of file.params) {
      const current = byName.get(p.name);
      if (!current || current.index === undefined || current.size === undefined) {
        missing += 1;
        continue;
      }
      const isFloat = (current.typeId ?? 2) === 8 || (current.typeId ?? 2) === 9;
      const tol = isFloat ? 1e-3 : 0.5;
      if (current.value !== undefined && Math.abs(current.value - p.value) <= tol) {
        unchanged += 1;
        continue;
      }
      changes.push({
        index: current.index,
        name: p.name,
        from: current.value ?? Number.NaN,
        to: p.value,
        size: current.size,
        typeId: current.typeId ?? 2,
        selected: true,
      });
    }
    setError(null);
    const fileName = (result.path ?? 'backup').split(/[\\/]/).pop() ?? 'backup';
    setRestore({ file: fileName, changes, missing, unchanged });
    onLog?.({
      level: 'info',
      text: `Loaded backup ${fileName}`,
      detail: `${changes.length} differ · ${unchanged} unchanged · ${missing} not on this aircraft`,
    });
  };

  const applyRestore = async (): Promise<void> => {
    if (!restore) return;
    const selected = restore.changes.filter((c) => c.selected);
    setApplying(true);
    let done = 0;
    let failed = 0;
    for (const change of selected) {
      try {
        const result = await window.drone.writeParam(
          change.name,
          change.index,
          change.to,
          change.size,
          change.typeId,
        );
        if (result.ok) {
          done += 1;
          setEntries((list) =>
            list.map((e) => (e.index === change.index ? { ...e, value: change.to } : e)),
          );
        } else {
          failed += 1;
        }
        onLog?.({
          level: result.ok ? 'ok' : 'error',
          text: `Restore ${change.name} = ${change.to}`,
          detail: result.message,
        });
      } catch (err) {
        failed += 1;
        onLog?.({
          level: 'error',
          text: `Restore ${change.name} = ${change.to}`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setApplying(false);
    onLog?.({
      level: failed === 0 ? 'ok' : 'warn',
      text: `Restore complete: ${done} written${failed ? `, ${failed} failed` : ''}`,
    });
    setRestore(null);
  };

  const toggleChange = (index: number): void =>
    setRestore((plan) =>
      plan
        ? { ...plan, changes: plan.changes.map((c) => (c.index === index ? { ...c, selected: !c.selected } : c)) }
        : plan,
    );

  const setAllChanges = (selected: boolean): void =>
    setRestore((plan) => (plan ? { ...plan, changes: plan.changes.map((c) => ({ ...c, selected })) } : plan));

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const named = entries.filter((e) => e.name);
    if (!q) return named;
    return named.filter((e) => (e.name ?? '').toLowerCase().includes(q));
  }, [entries, filter]);
  const shown = filtered;

  return (
    <Box>
      <PageHeader
        title="Parameters"
        subtitle="Read the flight-controller parameter table and edit values inline."
        actions={
          loading ? (
            <Btn onClick={() => void window.drone.cancelReadParams()}>Stop</Btn>
          ) : (
            <Flex gap="8px">
              <Btn disabled={entries.length === 0} onClick={() => void exportBackup()}>
                Export…
              </Btn>
              <Btn disabled={!connected || entries.length === 0} onClick={() => void importBackup()}>
                Import…
              </Btn>
              <Btn variant="primary" disabled={!connected} onClick={() => void readAll()}>
                Read all parameters
              </Btn>
            </Flex>
          )
        }
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="16px" color="warn">
          <AlertIcon size={15} />
          <Text>Connect an aircraft to read parameters.</Text>
        </Flex>
      )}

      {loading && (
        <Panel px="16px" py="12px" mb="14px">
          <Flex align="center" justify="space-between" gap="10px">
            <Text fontSize="12.5px" color="fg.muted">
              Reading parameters…{' '}
              {progress ? (progress.total ? `${progress.done} / ${progress.total}` : `${progress.done}`) : ''}
            </Text>
          </Flex>
          <Box mt="8px" h="4px" borderRadius="full" bg="bg.raised" overflow="hidden">
            <Box
              h="full"
              bg="accent"
              w={progress && progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : '40%'}
              transition="width 0.2s"
            />
          </Box>
        </Panel>
      )}

      {error && (
        <Flex align="center" gap="8px" mb="14px" color="danger">
          <AlertIcon size={15} />
          <Text fontSize="12.5px">{error}</Text>
        </Flex>
      )}

      {restore && (
        <Panel px="16px" py="14px" mb="16px">
          <Flex align="center" justify="space-between" gap="10px" mb="8px">
            <Box>
              <Text fontSize="13px" fontWeight="600">
                Restore from {restore.file}
              </Text>
              <Text fontSize="11px" color="fg.muted" mt="1px">
                {restore.changes.length} differ · {restore.unchanged} already match · {restore.missing} not on this aircraft
              </Text>
            </Box>
            <Flex gap="8px" align="center">
              {restore.changes.length > 0 && (
                <>
                  <Btn onClick={() => setAllChanges(true)} disabled={applying}>All</Btn>
                  <Btn onClick={() => setAllChanges(false)} disabled={applying}>None</Btn>
                </>
              )}
              <Btn onClick={() => setRestore(null)} disabled={applying}>Cancel</Btn>
              <Btn
                variant="primary"
                disabled={applying || restore.changes.every((c) => !c.selected)}
                onClick={() => void applyRestore()}
              >
                {applying
                  ? 'Writing…'
                  : `Apply ${restore.changes.filter((c) => c.selected).length} change${
                      restore.changes.filter((c) => c.selected).length === 1 ? '' : 's'
                    }`}
              </Btn>
            </Flex>
          </Flex>
          {restore.changes.length === 0 ? (
            <Flex align="center" gap="8px" color="ok">
              <CheckIcon size={14} />
              <Text fontSize="12px">Every backed-up value already matches the aircraft. Nothing to write.</Text>
            </Flex>
          ) : (
            <Box maxH="260px" overflowY="auto" borderWidth="1px" borderColor="border" borderRadius="8px">
              {restore.changes.map((c) => (
                <Flex
                  key={c.index}
                  align="center"
                  gap="10px"
                  px="12px"
                  py="5px"
                  borderBottomWidth="1px"
                  borderColor="border"
                  _hover={{ bg: 'bg.hover' }}
                >
                  <chakra.input
                    type="checkbox"
                    checked={c.selected}
                    onChange={() => toggleChange(c.index)}
                    w="14px"
                    h="14px"
                    accentColor="var(--chakra-colors-accent)"
                  />
                  <Text flex="1" fontFamily="mono" fontSize="11.5px" truncate title={c.name}>
                    {c.name}
                  </Text>
                  <Text fontFamily="mono" fontSize="11px" color="fg.subtle">
                    {Number.isNaN(c.from) ? '—' : c.from}
                  </Text>
                  <Text fontSize="11px" color="fg.subtle">→</Text>
                  <Text fontFamily="mono" fontSize="11px" color="warn" w="72px" truncate title={String(c.to)}>
                    {c.to}
                  </Text>
                </Flex>
              ))}
            </Box>
          )}
        </Panel>
      )}

      {entries.length > 0 && (
        <>
          <Flex align="center" gap="10px" mb="10px">
            <chakra.input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name…"
              flex="1"
              h="32px"
              px="10px"
              fontSize="12.5px"
              bg="bg.raised"
              borderWidth="1px"
              borderColor="border.strong"
              borderRadius="8px"
              color="fg"
              _placeholder={{ color: 'fg.subtle' }}
              _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
            />
            <Text fontSize="11.5px" color="fg.subtle" whiteSpace="nowrap">
              {filtered.length} params
            </Text>
          </Flex>

          <Panel overflow="hidden">
            <Box display="grid" gridTemplateColumns="44px 1fr 52px 100px 64px 64px 64px 78px" px="14px" py="8px" gap="8px" borderBottomWidth="1px" borderColor="border">
              {['#', 'Name', 'Type', 'Value', 'Default', 'Min', 'Max', ''].map((h, i) => (
                <Overline key={i}>{h}</Overline>
              ))}
            </Box>
            <Box maxH="calc(100vh - 320px)" overflowY="auto">
              {shown.map((entry) => {
                const key = entry.index as number;
                const edited = edits[key];
                const dirty = edited !== undefined && edited.trim() !== String(entry.value ?? '');
                const rowStatus = status[key];
                const fmt = (n?: number): string => (n === undefined ? '' : String(n));
                return (
                  <Box key={key} borderBottomWidth="1px" borderColor="border" _hover={{ bg: 'bg.hover' }}>
                  <Box
                    display="grid"
                    gridTemplateColumns="44px 1fr 52px 100px 64px 64px 64px 78px"
                    alignItems="center"
                    gap="8px"
                    px="14px"
                    py="5px"
                  >
                    <Text fontFamily="mono" fontSize="11px" color="fg.subtle">
                      {key}
                    </Text>
                    <Text className="selectable" fontFamily="mono" fontSize="11.5px" truncate title={entry.name}>
                      {entry.name}
                    </Text>
                    <Text fontFamily="mono" fontSize="10.5px" color="fg.subtle">
                      {entry.typeName ?? ''}
                    </Text>
                    <ValueInput
                      value={edited ?? String(entry.value ?? '')}
                      dirty={dirty}
                      onChange={(v) => setEdits((m) => ({ ...m, [key]: v }))}
                    />
                    <Text
                      fontFamily="mono"
                      fontSize="10.5px"
                      color={entry.default !== undefined && entry.default !== entry.value ? 'warn' : 'fg.subtle'}
                      truncate
                      title={fmt(entry.default)}
                    >
                      {fmt(entry.default)}
                    </Text>
                    <Text fontFamily="mono" fontSize="10.5px" color="fg.subtle" truncate title={fmt(entry.min)}>
                      {fmt(entry.min)}
                    </Text>
                    <Text fontFamily="mono" fontSize="10.5px" color="fg.subtle" truncate title={fmt(entry.max)}>
                      {fmt(entry.max)}
                    </Text>
                    <Flex align="center" gap="6px" justify="flex-end">
                      {rowStatus === 'ok' && <Box color="ok"><CheckIcon size={14} /></Box>}
                      {rowStatus && rowStatus !== 'ok' && rowStatus !== 'saving' && (
                        <Box color="danger" title={rowStatus}><AlertIcon size={14} /></Box>
                      )}
                      <Btn disabled={!dirty || rowStatus === 'saving'} onClick={() => void save(entry)}>
                        {rowStatus === 'saving' ? '…' : 'Save'}
                      </Btn>
                    </Flex>
                  </Box>
                  </Box>
                );
              })}
            </Box>
          </Panel>

          <Flex align="center" gap="8px" mt="12px" color="warn">
            <AlertIcon size={14} />
            <Text fontSize="11.5px" color="fg.muted">
              Editing writes directly to the flight controller. A wrong value can misconfigure the aircraft — change one thing at a time and note the original value before you change it.
            </Text>
          </Flex>
        </>
      )}
    </Box>
  );
}

export default ParameterPanel;
