import { useEffect, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, FlashState, FlashValidation } from '../types';
import { AlertIcon, CheckIcon, FileIcon, PlayIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel, type Tone } from './ui';
import ManifestCard from './ManifestCard';

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

const PHASE_LABEL: Record<FlashState['phase'], string> = {
  idle: 'Idle',
  ready: 'Ready',
  entering: 'Entering upgrade mode',
  preparing: 'Preparing',
  transferring: 'Transferring',
  finishing: 'Committing',
  monitoring: 'Installing',
  done: 'Done',
  failed: 'Failed',
};

const PHASE_TONE: Record<FlashState['phase'], Tone> = {
  idle: 'neutral',
  ready: 'neutral',
  entering: 'accent',
  preparing: 'accent',
  transferring: 'accent',
  finishing: 'accent',
  monitoring: 'accent',
  done: 'ok',
  failed: 'danger',
};

const ACTIVE_PHASES: FlashState['phase'][] = [
  'entering',
  'preparing',
  'transferring',
  'finishing',
  'monitoring',
];

function WarningRow({ children, tone = 'warn' }: { children: React.ReactNode; tone?: Tone }) {
  return (
    <Flex
      gap="9px"
      align="flex-start"
      p="10px 12px"
      borderRadius="8px"
      bg={tone === 'danger' ? 'danger.soft' : 'warn.soft'}
      borderLeftWidth="2px"
      borderColor={tone === 'danger' ? 'danger' : 'warn'}
    >
      <Box color={tone === 'danger' ? 'danger' : 'warn'} mt="1px" flexShrink={0}>
        <AlertIcon size={15} />
      </Box>
      <Text fontSize="12.5px">{children}</Text>
    </Flex>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Overline>{label}</Overline>
      <Text mt="4px" fontFamily="mono" fontSize="13px">
        {value}
      </Text>
    </Box>
  );
}

function ProgressBar({ percent, tone }: { percent: number; tone: Tone }) {
  return (
    <Box h="8px" borderRadius="full" bg="bg.raised" overflow="hidden">
      <Box
        h="full"
        w={`${Math.max(0, Math.min(100, percent))}%`}
        borderRadius="full"
        bg={tone === 'neutral' ? 'fg.muted' : tone}
        transition="width 0.2s linear"
      />
    </Box>
  );
}

function FlashProgress({ flash, onCancel }: { flash: FlashState; onCancel: () => void }) {
  const tone = PHASE_TONE[flash.phase];
  const active = ACTIVE_PHASES.includes(flash.phase);
  return (
    <Panel p="18px">
      <Flex align="center" gap="10px">
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
          {flash.model ?? 'Firmware'} update
        </chakra.h2>
        <Chip tone={tone} pulse={active}>
          {PHASE_LABEL[flash.phase]}
        </Chip>
        {flash.overallProgress != null && (
          <Text ml="auto" fontFamily="mono" fontSize="18px" lineHeight="1">
            {flash.overallProgress}
            <Text as="span" fontSize="12px" color="fg.subtle">
              {' '}
              %
            </Text>
          </Text>
        )}
      </Flex>

      <Box mt="14px">
        <ProgressBar percent={flash.overallProgress ?? 0} tone={tone} />
      </Box>

      {flash.currentFile && active && (
        <Box mt="12px">
          <Flex justify="space-between" fontSize="12px" color="fg.muted" mb="5px">
            <Text fontFamily="mono">
              {flash.currentFile}
              {flash.fileIndex ? ` (${flash.fileIndex}/${flash.files.length})` : ''}
            </Text>
            <Text fontFamily="mono">{flash.fileProgress ?? 0}%</Text>
          </Flex>
          <ProgressBar percent={flash.fileProgress ?? 0} tone="accent" />
        </Box>
      )}

      <Text mt="12px" color={flash.phase === 'failed' ? 'danger' : 'fg.muted'}>
        {flash.error ?? flash.message}
      </Text>
      {flash.statusDetail && (
        <Text mt="3px" fontFamily="mono" fontSize="11.5px" color="fg.subtle">
          aircraft: {flash.statusDetail}
        </Text>
      )}

      {active && (
        <Flex mt="16px" justify="flex-end">
          <Btn variant="quiet" onClick={onCancel}>
            Cancel
          </Btn>
        </Flex>
      )}
    </Panel>
  );
}

function FlashPanel({ drone, flash }: { drone: DroneState; flash: FlashState }) {
  const [packagePath, setPackagePath] = useState<string | undefined>(flash.packagePath);
  const [validation, setValidation] = useState<FlashValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);

  const connected = drone.status === 'connected';
  const running = ACTIVE_PHASES.includes(flash.phase);

  // A fresh validation is required whenever the package or the aircraft changes.
  useEffect(() => {
    setValidation(null);
    setAck(false);
  }, [packagePath, drone.modelCode]);

  const choose = async (): Promise<void> => {
    const picked = await window.drone.pickFirmware();
    if (picked) {
      setPackagePath(picked);
    }
  };

  const validate = async (): Promise<void> => {
    if (!packagePath) return;
    setBusy(true);
    try {
      setValidation(await window.drone.validateFlash(packagePath));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!packagePath) return;
    await window.drone.startFlash(packagePath);
  };

  const armed = validation?.ok === true && ack && !running;

  return (
    <Box>
      <PageHeader
        title="Firmware"
        subtitle="Flash DJI aircraft firmware over USB. This is irreversible — read the warnings."
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="16px" color="warn">
          <AlertIcon size={15} />
          <Text>Connect an aircraft to flash firmware.</Text>
        </Flex>
      )}

      {/* Target */}
      <Panel px="18px" py="16px" mb="14px">
        <Flex align="center" justify="space-between" gap="12px" wrap="wrap">
          <Box>
            <Overline>Target aircraft</Overline>
            <Text mt="4px" fontFamily="heading" fontSize="16px" fontWeight="600">
              {connected ? (drone.model ?? 'Unidentified aircraft') : 'No aircraft'}
              {drone.modelCode && (
                <Text as="span" color="fg.subtle" fontFamily="mono" fontSize="13px">
                  {'  '}
                  {drone.modelCode}
                </Text>
              )}
            </Text>
          </Box>
          {connected && drone.modelCode && (
            <Chip tone={validation && !validation.ok && validation.droneType == null ? 'danger' : 'neutral'}>
              {validation?.droneType ? `route ${validation.droneType}` : 'route checked on validate'}
            </Chip>
          )}
        </Flex>
      </Panel>

      {/* Installed firmware manifest (version + anti-rollback). */}
      {connected && drone.manifest && (
        <Box mb="14px">
          <Flex align="center" gap="10px" mb="10px">
            <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
              Installed firmware
            </chakra.h2>
            <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
              {drone.manifest.formalVersion ?? '—'}
            </Text>
          </Flex>
          <ManifestCard manifest={drone.manifest} />
        </Box>
      )}

      {/* Package selection + validation */}
      <Panel px="18px" py="16px" mb="14px">
        <Overline>Firmware package</Overline>
        <Flex gap="10px" mt="9px" align="center" wrap="wrap">
          <Btn variant="quiet" icon={<FileIcon size={14} />} onClick={() => void choose()} disabled={running}>
            Choose package…
          </Btn>
          <Text fontFamily="mono" fontSize="12px" color={packagePath ? 'fg' : 'fg.subtle'} truncate flex="1" minW="0">
            {packagePath ?? 'No package selected (.bin / .tar / .tgz / .zip)'}
          </Text>
          <Btn
            variant="quiet"
            onClick={() => void validate()}
            disabled={!packagePath || !connected || busy || running}
          >
            {busy ? 'Validating…' : 'Validate'}
          </Btn>
        </Flex>

        {validation && (
          <Box mt="14px" pt="14px" borderTopWidth="1px" borderColor="border">
            {validation.ok ? (
              <>
                <Flex gap="28px" wrap="wrap" mb="12px">
                  <Stat label="Modules" value={String(validation.files.length)} />
                  <Stat label="Total size" value={formatBytes(validation.totalSize)} />
                  <Stat label="Route" value={validation.droneType ?? '—'} />
                </Flex>
                <Box
                  maxH="160px"
                  overflowY="auto"
                  borderWidth="1px"
                  borderColor="border"
                  borderRadius="8px"
                >
                  {validation.files.map((f, i) => (
                    <Flex
                      key={f.name}
                      justify="space-between"
                      px="12px"
                      py="6px"
                      borderBottomWidth={i === validation.files.length - 1 ? '0' : '1px'}
                      borderColor="border"
                      fontSize="12px"
                    >
                      <Text fontFamily="mono" truncate>
                        {f.name}
                      </Text>
                      <Text fontFamily="mono" color="fg.subtle" flexShrink={0} ml="12px">
                        {formatBytes(f.size)}
                      </Text>
                    </Flex>
                  ))}
                </Box>
                <Flex direction="column" gap="8px" mt="12px">
                  {validation.warnings.map((w) => (
                    <WarningRow key={w}>{w}</WarningRow>
                  ))}
                </Flex>
              </>
            ) : (
              <WarningRow tone="danger">{validation.error}</WarningRow>
            )}
          </Box>
        )}
      </Panel>

      {/* Arm + flash */}
      {validation?.ok && !running && flash.phase !== 'done' && (
        <Panel px="18px" py="16px" mb="14px" borderColor="danger">
          <Flex align="center" gap="8px" color="danger" mb="10px">
            <AlertIcon size={16} />
            <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
              Danger zone — irreversible
            </chakra.h2>
          </Flex>
          <chakra.label display="flex" gap="9px" alignItems="flex-start" cursor="pointer" mb="14px">
            <chakra.input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.currentTarget.checked)}
              mt="2px"
              accentColor="#f2665c"
            />
            <Text fontSize="12.5px">
              I understand that flashing the wrong package, or interrupting it, can permanently brick
              this aircraft, and I have verified the package matches {drone.model ?? 'the aircraft'}.
            </Text>
          </chakra.label>
          <Flex justify="flex-end">
            <Btn
              variant="primary"
              icon={<PlayIcon size={14} />}
              disabled={!armed}
              onClick={() => void start()}
            >
              Flash firmware
            </Btn>
          </Flex>
        </Panel>
      )}

      {/* Progress / result */}
      {flash.phase !== 'idle' && (
        <FlashProgress flash={flash} onCancel={() => void window.drone.cancelFlash()} />
      )}

      {flash.phase === 'done' && (
        <Flex align="center" gap="8px" mt="12px" color="ok">
          <CheckIcon size={15} />
          <Text>{flash.message}</Text>
        </Flex>
      )}
    </Box>
  );
}

export default FlashPanel;
