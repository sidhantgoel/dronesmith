import { useEffect, useState, type ReactNode } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, FastbootFlashProgress } from '../types';
import { AlertIcon } from './icons';
import { Btn, Chip, PageHeader, Panel } from './ui';
import type { LogDraft } from './useActivityLog';

type Log = (draft: LogDraft) => void;

function Danger({ children }: { children: ReactNode }) {
  return (
    <Flex align="flex-start" gap="8px" color="danger">
      <Box mt="2px" flexShrink={0}>
        <AlertIcon size={15} />
      </Box>
      <Box fontSize="12.5px">{children}</Box>
    </Flex>
  );
}

function Result({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Box mt="12px" p="10px 12px" borderRadius="8px" bg={ok ? 'bg.raised' : 'danger.soft'} borderLeftWidth="2px" borderColor={ok ? 'ok' : 'danger'}>
      <Text className="selectable" fontSize="12.5px">
        {text}
      </Text>
    </Box>
  );
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(1)} ${units[unit]}`;
}

/** A destructive action behind a typed confirmation. */
function DangerAction({
  verb,
  partition,
  setPartition,
  onRun,
  disabled,
  children,
}: {
  verb: string;
  partition: string;
  setPartition: (value: string) => void;
  onRun: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  const [confirm, setConfirm] = useState('');
  const ready = partition.trim().length > 0 && confirm.trim().toUpperCase() === verb.toUpperCase();
  return (
    <Panel px="18px" py="14px" borderColor="danger">
      <Text fontFamily="heading" fontSize="14px" fontWeight="600" mb="6px">
        {verb} a partition
      </Text>
      <Box mb="10px">{children}</Box>
      <Flex gap="8px" wrap="wrap" align="center">
        <chakra.input
          aria-label="Partition name"
          value={partition}
          onChange={(e) => setPartition(e.target.value.trim())}
          placeholder="partition"
          spellCheck={false}
          h="30px"
          px="10px"
          w="160px"
          fontFamily="mono"
          fontSize="12.5px"
          bg="bg.raised"
          borderWidth="1px"
          borderColor="border.strong"
          borderRadius="7px"
          color="fg"
          _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
        />
        <chakra.input
          aria-label={`Type ${verb} to confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={`type ${verb}`}
          spellCheck={false}
          h="30px"
          px="10px"
          w="140px"
          fontFamily="mono"
          fontSize="12.5px"
          bg="bg.raised"
          borderWidth="1px"
          borderColor="border.strong"
          borderRadius="7px"
          color="fg"
          _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
        />
        <Btn
          variant="primary"
          disabled={disabled || !ready}
          onClick={() => {
            onRun();
            setConfirm('');
          }}
        >
          {verb}
        </Btn>
      </Flex>
    </Panel>
  );
}

function FastbootPanel({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  void drone;
  const [variables, setVariables] = useState<Record<string, string> | null>(null);
  const [inFastboot, setInFastboot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flashPartition, setFlashPartition] = useState('');
  const [erasePartition, setErasePartition] = useState('');
  const [progress, setProgress] = useState<FastbootFlashProgress | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const offProgress = window.fastboot.onFlashProgress(setProgress);
    const offFound = window.fastboot.onFound((result) => {
      setWaiting(false);
      if (result.ok) {
        setInFastboot(true);
        setVariables(result.variables ?? {});
        setNote({ ok: true, text: result.message });
      } else {
        setNote({ ok: false, text: result.message });
      }
    });
    const offStopped = window.fastboot.onWatchStopped(() => {
      setWaiting(false);
      setNote({ ok: false, text: 'No fastboot device appeared. The boot window may be too short to catch without holding the board boot pad.' });
    });
    return () => {
      offProgress();
      offFound();
      offStopped();
      void window.fastboot.watch(false);
      void window.fastboot.disconnect();
    };
  }, []);

  const wait = async (): Promise<void> => {
    if (waiting) {
      setWaiting(false);
      await window.fastboot.watch(false);
      return;
    }
    setNote(null);
    setWaiting(true);
    const result = await window.fastboot.watch(true);
    if (!result.ok) {
      setWaiting(false);
      setNote({ ok: false, text: result.message });
    }
  };

  const scan = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await window.fastboot.scan();
      if (result.ok) {
        setInFastboot(true);
        setVariables(result.variables ?? {});
        setNote({ ok: true, text: result.message });
      } else {
        setInFastboot(false);
        setVariables(null);
        setNote({ ok: false, text: result.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const reboot = async (target: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.fastboot.reboot(target);
      setNote({ ok: result.ok, text: result.message });
      if (result.ok) {
        setInFastboot(false);
        setVariables(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const flash = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    setProgress(null);
    try {
      const result = await window.fastboot.flash(flashPartition);
      if (result.message) {
        setNote({ ok: result.ok, text: result.message });
        onLog?.({ level: result.ok ? 'warn' : 'error', text: `Fastboot flash ${flashPartition}: ${result.message}` });
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const erase = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await window.fastboot.erase(erasePartition);
      setNote({ ok: result.ok, text: result.message });
      onLog?.({ level: result.ok ? 'warn' : 'error', text: `Fastboot erase ${erasePartition}: ${result.message}` });
    } finally {
      setBusy(false);
    }
  };

  const varRows = variables ? Object.entries(variables) : [];

  return (
    <Box>
      <PageHeader
        title="Fastboot"
        subtitle="Reboots the aircraft into fastboot, then inspects and (with confirmation) flashes it. For unbricking and low-level repair."
      />

      <Panel px="18px" py="14px" mb="14px" borderColor="danger">
        <Danger>
          Fastboot is the unbrick path. Erasing or flashing the wrong partition, or an interrupted
          write, can permanently brick the aircraft. Only flash images meant for this exact model.
        </Danger>
      </Panel>

      {note && <Result ok={note.ok} text={note.text} />}

      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mt="18px" mb="10px">
        1 · Put the aircraft into fastboot
      </chakra.h2>
      <Panel px="18px" py="14px">
        <Text fontSize="12.5px" color="fg.muted" mb="10px">
          There is no confirmed command that forces a healthy aircraft into fastboot, and this app does
          not send one. The reference servicing tool does not do it either — it waits for the aircraft
          to appear in DJI recovery (USB 2CA3:0040) and otherwise tells you to reboot and retry. A soft
          reboot of the flight controller is not used here: it does not reach fastboot and it can leave
          the aircraft with an &quot;IMU error, unable to take off&quot; until the next full power cycle.
        </Text>
        <Text fontSize="12.5px" color="fg.muted" mb="4px" fontWeight="600">
          Ways to enter recovery:
        </Text>
        <Box as="ul" pl="18px" fontSize="12.5px" color="fg.muted">
          <li>DJI Assistant 2&apos;s firmware-recovery flow.</li>
          <li>The hardware test-point / button method for this model.</li>
          <li>A tool with a model-specific exploit that forces it.</li>
        </Box>
        <Text fontSize="12.5px" color="fg.subtle" mt="10px">
          Once the aircraft shows up in recovery by any of these, go to step 2.
        </Text>
      </Panel>

      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mt="18px" mb="10px">
        2 · Inspect the device in fastboot
      </chakra.h2>
      <Panel px="18px" pt="14px" pb="10px">
        <Text fontSize="12.5px" color="fg.muted" mb="10px">
          Works only for a device that speaks <strong>standard</strong> fastboot. Note: current DJI
          drones (tested on a Mini 3 Pro) show DJI recovery at USB 2CA3:0040 only briefly at boot, and
          that interface is a proprietary bootrom — it answers neither fastboot nor DUML and cannot be
          driven here. This page is useful for a device that genuinely exposes standard fastboot. The
          fastboot interface must be bound to the libusb-win32 driver. Wait for device polls and grabs
          one the instant it appears.
        </Text>
        <Flex align="center" gap="10px" mb="10px" wrap="wrap">
          <Btn variant={waiting ? undefined : 'primary'} disabled={busy} onClick={() => void wait()}>
            {waiting ? 'Waiting… power-cycle now (cancel)' : 'Wait for device'}
          </Btn>
          <Btn disabled={busy || waiting} onClick={() => void scan()}>
            {busy ? 'Scanning…' : inFastboot ? 'Re-read device' : 'Scan once'}
          </Btn>
          {waiting && <Chip tone="accent" pulse>Waiting</Chip>}
          {inFastboot && <Chip tone="ok">In fastboot</Chip>}
          <Box flex="1" />
          <Btn disabled={!inFastboot || busy} onClick={() => void reboot('reboot')}>
            Reboot to system
          </Btn>
          <Btn disabled={!inFastboot || busy} onClick={() => void reboot('continue')}>
            Continue boot
          </Btn>
        </Flex>
        {varRows.length > 0 ? (
          <Box borderTopWidth="1px" borderColor="border">
            {varRows.map(([name, value]) => (
              <Flex key={name} justify="space-between" gap="12px" py="5px" borderBottomWidth="1px" borderColor="border">
                <Text fontFamily="mono" fontSize="12px" color="fg.muted">
                  {name}
                </Text>
                <Text className="selectable" fontFamily="mono" fontSize="12px" textAlign="right" wordBreak="break-all">
                  {value || '—'}
                </Text>
              </Flex>
            ))}
          </Box>
        ) : (
          <Text fontSize="12.5px" color="fg.subtle">
            {inFastboot ? 'The device reported no variables.' : 'Not connected to a fastboot device yet.'}
          </Text>
        )}
      </Panel>

      {inFastboot && (
        <>
          <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mt="18px" mb="10px">
            3 · Flash or erase (danger)
          </chakra.h2>
          {busy && progress && (
            <Text fontFamily="mono" fontSize="12px" color="fg.muted" mb="8px">
              Writing {progress.partition}: {bytes(progress.sent)} of {bytes(progress.total)} (
              {Math.round((progress.sent / Math.max(1, progress.total)) * 100)} %)
            </Text>
          )}
          <Flex direction="column" gap="12px">
            <DangerAction verb="Flash" partition={flashPartition} setPartition={setFlashPartition} onRun={() => void flash()} disabled={busy}>
              <Danger>Writes a chosen image file to this partition, replacing it. Use only an image built for this model.</Danger>
            </DangerAction>
            <DangerAction verb="Erase" partition={erasePartition} setPartition={setErasePartition} onRun={() => void erase()} disabled={busy}>
              <Danger>Wipes this partition. The data cannot be recovered.</Danger>
            </DangerAction>
          </Flex>
        </>
      )}
    </Box>
  );
}

export default FastbootPanel;
