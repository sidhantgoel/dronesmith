import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, ImuRepairMethod, SerialComponent, SerialRow, SerialWriteResult } from '../types';
import { SERIAL_MAX_LENGTH, SERIAL_TARGETS, planImuRepair, repairDurationMs, serialProblem } from '../repair';
import { AlertIcon } from './icons';
import { Btn, Chip, PageHeader, Panel } from './ui';
import type { LogDraft } from './useActivityLog';

type Log = (draft: LogDraft) => void;
type TabKey = 'imu' | 'serial';

const TABS: { key: TabKey; title: string }[] = [
  { key: 'imu', title: 'Gimbal IMU repair' },
  { key: 'serial', title: 'Serial numbers' },
];

const METHODS: { id: ImuRepairMethod; title: string; summary: string }[] = [
  {
    id: 'value',
    title: 'Write repair data',
    summary: 'Writes the repair data to the gimbal and lets it settle. The gimbal does not move.',
  },
  {
    id: 'calibrate',
    title: 'Write and recalibrate',
    summary: 'Writes the repair value, then runs a coarse gimbal calibration, twice over. The gimbal moves.',
  },
];

function Warning({ children }: { children: ReactNode }) {
  return (
    <Flex align="flex-start" gap="8px" color="warn">
      <Box mt="2px" flexShrink={0}>
        <AlertIcon size={15} />
      </Box>
      <Box fontSize="12.5px">{children}</Box>
    </Flex>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <chakra.label display="flex" alignItems="flex-start" gap="8px" cursor="pointer" mt="10px">
      <chakra.input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} mt="2px" />
      <Text fontSize="12.5px" color="fg">
        {children}
      </Text>
    </chakra.label>
  );
}

function ResultLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Box
      mt="14px"
      p="10px 12px"
      borderRadius="8px"
      bg={ok ? 'bg.raised' : 'danger.soft'}
      borderLeftWidth="2px"
      borderColor={ok ? 'ok' : 'danger'}
    >
      <Text className="selectable" fontSize="12.5px">
        {text}
      </Text>
    </Box>
  );
}

// ── Gimbal IMU repair ────────────────────────────────────────────────────────

function ImuRepair({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  const connected = drone.status === 'connected';
  const [method, setMethod] = useState<ImuRepairMethod>('value');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const choice = useMemo(
    () => planImuRepair(method, drone.modelCode, drone.model),
    [method, drone.modelCode, drone.model],
  );
  const plan = choice.plan;
  const repair = drone.repair;
  const running = busy || repair?.phase === 'running';
  const imuFaults = (drone.hms?.faults ?? []).filter((fault) => /\bimu\b/i.test(fault.text)).length;

  useEffect(() => setConfirmed(false), [method, drone.modelCode]);

  const run = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    onLog?.({ level: 'warn', text: `Gimbal IMU repair started (${method === 'value' ? 'write only' : 'write and recalibrate'})` });
    try {
      const outcome = await window.drone.repairGimbalImu(method);
      setResult({ ok: outcome.ok, text: outcome.message });
      onLog?.({ level: outcome.ok ? 'ok' : 'error', text: `Gimbal IMU repair: ${outcome.message}` });
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setConfirmed(false);
    }
  };

  return (
    <Box>
      <Panel px="18px" py="14px" mb="14px">
        <Flex align="center" gap="10px" mb="8px" wrap="wrap">
          <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" flex="1">
            For the fault “gimbal IMU data mismatch” (40021)
          </chakra.h2>
          <Chip tone={imuFaults > 0 ? 'danger' : 'neutral'}>
            {imuFaults > 0 ? `${imuFaults} IMU fault${imuFaults === 1 ? '' : 's'} reported` : 'No IMU fault reported'}
          </Chip>
        </Flex>
        <Warning>
          This overwrites calibration data stored in the gimbal. The old data is not read first and
          cannot be put back from this app. The routine has not been confirmed on an aircraft with this
          app; use it only on a gimbal that already reports the fault.
        </Warning>
      </Panel>

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" gap="12px" mb="14px">
        {METHODS.map((entry) => {
          const active = entry.id === method;
          return (
            <chakra.button
              key={entry.id}
              type="button"
              aria-pressed={active}
              disabled={running}
              onClick={() => setMethod(entry.id)}
              textAlign="left"
              p="16px"
              borderRadius="12px"
              borderWidth="1px"
              borderColor={active ? 'accent' : 'border'}
              bg="bg.panel"
              cursor="pointer"
              _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
              _disabled={{ cursor: 'not-allowed' }}
            >
              <Text fontFamily="heading" fontSize="14px" fontWeight="600">
                {entry.title}
              </Text>
              <Text fontSize="12.5px" color="fg.muted" mt="4px">
                {entry.summary}
              </Text>
            </chakra.button>
          );
        })}
      </Box>

      <Panel px="18px" py="14px">
        {!plan && <Warning>{choice.reason ?? 'This repair is not available for this aircraft.'}</Warning>}
        {plan && (
          <>
            <Text fontSize="12.5px" color="fg.muted">
              Takes about {Math.round(repairDurationMs(plan) / 1000)} seconds.
              {plan.moves ? ' Set the aircraft on a level surface with the gimbal free to move.' : ''}
            </Text>
            {plan.foreignBlock && (
              <Box mt="10px">
                <Warning>
                  On this model the whole calibration block is replaced with a fixed block that was read
                  from a different aircraft. The gimbal will then run on another unit’s calibration.
                </Warning>
              </Box>
            )}
            <Check checked={confirmed} onChange={setConfirmed}>
              I understand that the stored calibration data is overwritten and cannot be restored
            </Check>
            <Flex justify="flex-end" mt="12px">
              <Btn variant="primary" disabled={!connected || !confirmed || running} onClick={() => void run()}>
                {running ? 'Repairing…' : 'Start repair'}
              </Btn>
            </Flex>
          </>
        )}
      </Panel>

      {repair && (
        <Panel px="18px" py="14px" mt="14px">
          <Flex align="center" justify="space-between" gap="12px" mb="8px">
            <Text fontSize="13px">{repair.message}</Text>
            <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
              {repair.percent} %
            </Text>
          </Flex>
          <Box
            h="6px"
            borderRadius="full"
            bg="bg.raised"
            overflow="hidden"
            role="progressbar"
            aria-label="Repair progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={repair.percent}
          >
            <Box
              h="full"
              w={`${repair.percent}%`}
              borderRadius="full"
              bg={repair.phase === 'failed' ? 'danger' : repair.phase === 'done' ? 'ok' : 'accent'}
              transition="width 0.25s linear"
            />
          </Box>
        </Panel>
      )}

      {result && !repair && <ResultLine ok={result.ok} text={result.text} />}
    </Box>
  );
}

// ── Serial numbers ───────────────────────────────────────────────────────────

const WRITABLE = SERIAL_TARGETS.filter((target) => target.writable);

function SerialNumbers({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  const connected = drone.status === 'connected';
  const [rows, setRows] = useState<SerialRow[] | null>(null);
  const [reading, setReading] = useState(false);
  const [component, setComponent] = useState<SerialComponent>(WRITABLE[0].id);
  const [value, setValue] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [writing, setWriting] = useState(false);
  const [result, setResult] = useState<SerialWriteResult | null>(null);

  useEffect(() => {
    if (!connected) {
      setRows(null);
      setResult(null);
    }
  }, [connected]);

  const read = async (): Promise<void> => {
    setReading(true);
    try {
      setRows(await window.drone.readSerials());
    } finally {
      setReading(false);
    }
  };

  const current = rows?.find((row) => row.component === component)?.serial;
  const problem = value.length > 0 ? serialProblem(value) : null;
  const label = WRITABLE.find((target) => target.id === component)?.label ?? '';

  const write = async (): Promise<void> => {
    setWriting(true);
    setResult(null);
    onLog?.({ level: 'warn', text: `Serial number write to the ${label.toLowerCase()} started` });
    try {
      const outcome = await window.drone.writeSerial(component, value);
      setResult(outcome);
      onLog?.({
        level: outcome.ok ? 'ok' : 'error',
        text: `Serial number write: ${outcome.message}`,
        detail: outcome.before ? `Previous serial: ${outcome.before}` : undefined,
      });
      if (outcome.ok) {
        setValue('');
        await read();
      }
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setWriting(false);
      setConfirmed(false);
    }
  };

  return (
    <Box>
      <Panel px="18px" pt="14px" pb="10px" mb="14px">
        <Flex align="center" justify="space-between" gap="12px" mb="8px">
          <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
            Module serial numbers
          </chakra.h2>
          <Btn disabled={!connected || reading || writing} onClick={() => void read()}>
            {reading ? 'Reading…' : rows ? 'Read again' : 'Read all'}
          </Btn>
        </Flex>
        {(rows ?? []).map((row) => (
          <Flex key={row.component} justify="space-between" gap="12px" py="6px" borderTopWidth="1px" borderColor="border">
            <Text fontSize="13px">{row.label}</Text>
            <Text className="selectable" fontFamily="mono" fontSize="12.5px" color={row.serial ? 'fg' : 'fg.subtle'}>
              {row.serial ?? 'Not reported'}
            </Text>
          </Flex>
        ))}
        {!rows && <Text color="fg.subtle">Not read yet.</Text>}
      </Panel>

      <Panel px="18px" py="14px" borderColor="danger">
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mb="8px">
          Write a serial number
        </chakra.h2>
        <Warning>
          For re-keying a replaced module to its aircraft. A wrong serial number can stop the module
          from pairing or activating. The write has not been confirmed on an aircraft with this app;
          it is checked by reading the serial back, and the previous serial is recorded in the
          activity log.
        </Warning>

        <Flex gap="6px" wrap="wrap" mt="14px">
          {WRITABLE.map((target) => {
            const active = target.id === component;
            return (
              <chakra.button
                key={target.id}
                type="button"
                aria-pressed={active}
                disabled={writing}
                onClick={() => {
                  setComponent(target.id);
                  setConfirmed(false);
                }}
                h="28px"
                px="12px"
                borderRadius="full"
                borderWidth="1px"
                borderColor={active ? 'accent' : 'border.strong'}
                bg={active ? 'accent' : 'transparent'}
                color={active ? 'fg.onAccent' : 'fg.muted'}
                fontSize="12px"
                fontWeight="600"
                cursor="pointer"
                _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
              >
                {target.label}
              </chakra.button>
            );
          })}
        </Flex>

        <Text fontSize="12.5px" color="fg.muted" mt="12px">
          Current: {current ?? (rows ? 'not reported' : 'read the serial numbers first')}
        </Text>
        <chakra.input
          aria-label={`New serial number for the ${label.toLowerCase()}`}
          value={value}
          maxLength={SERIAL_MAX_LENGTH}
          disabled={writing}
          placeholder="New serial number"
          onChange={(e) => {
            setValue(e.target.value.toUpperCase().replace(/\s+/g, ''));
            setConfirmed(false);
          }}
          mt="8px"
          w="full"
          maxW="340px"
          h="32px"
          px="10px"
          fontFamily="mono"
          fontSize="13px"
          bg="bg.raised"
          borderWidth="1px"
          borderColor={problem ? 'danger' : 'border.strong'}
          borderRadius="8px"
          color="fg"
          _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
        />
        {problem && (
          <Text fontSize="12px" color="danger" mt="6px">
            {problem}
          </Text>
        )}
        <Check checked={confirmed} onChange={setConfirmed}>
          Write {value || 'this serial number'} to the {label.toLowerCase()}
        </Check>
        <Flex justify="flex-end" mt="12px">
          <Btn
            variant="primary"
            disabled={!connected || writing || !confirmed || value.length === 0 || problem !== null}
            onClick={() => void write()}
          >
            {writing ? 'Writing…' : 'Write serial number'}
          </Btn>
        </Flex>
      </Panel>

      {result && <ResultLine ok={result.ok} text={result.message} />}
    </Box>
  );
}

function RepairPanel({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  const [tab, setTab] = useState<TabKey>('imu');
  const connected = drone.status === 'connected';

  return (
    <Box>
      <PageHeader
        title="Repairs"
        subtitle="Repairs that write to the aircraft: the gimbal IMU data repair and module serial numbers."
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="14px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to run a repair.</Text>
        </Flex>
      )}

      <Flex gap="4px" mb="14px" p="3px" bg="bg.raised" borderRadius="10px" borderWidth="1px" borderColor="border" wrap="wrap">
        {TABS.map((entry) => (
          <chakra.button
            key={entry.key}
            type="button"
            aria-pressed={entry.key === tab}
            onClick={() => setTab(entry.key)}
            flex="1 1 auto"
            px="12px"
            h="30px"
            fontSize="12.5px"
            fontWeight={entry.key === tab ? '600' : '500'}
            borderRadius="7px"
            bg={entry.key === tab ? 'bg.surface' : 'transparent'}
            color={entry.key === tab ? 'fg' : 'fg.muted'}
            borderWidth="1px"
            borderColor={entry.key === tab ? 'border.strong' : 'transparent'}
            cursor="pointer"
            _hover={{ color: 'fg' }}
            _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
          >
            {entry.title}
          </chakra.button>
        ))}
      </Flex>

      {tab === 'imu' ? <ImuRepair drone={drone} onLog={onLog} /> : <SerialNumbers drone={drone} onLog={onLog} />}
    </Box>
  );
}

export default RepairPanel;
