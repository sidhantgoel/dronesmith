import { useEffect, useState, type ReactNode } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, ImuCalibrationState } from '../types';
import { IMU_POSITIONS, planImuCalibration, type ImuPosition } from '../imuCal';
import { AlertIcon, CheckIcon, PlayIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel, type Tone } from './ui';

const PHASE_TONE: Record<ImuCalibrationState['phase'], Tone> = {
  running: 'accent',
  pass: 'ok',
  unsure: 'warn',
  failed: 'danger',
  stopped: 'neutral',
};

const PHASE_LABEL: Record<ImuCalibrationState['phase'], string> = {
  running: 'Running',
  pass: 'Passed',
  unsure: 'Unconfirmed',
  failed: 'Failed',
  stopped: 'Stopped',
};

const PREPARATION = [
  'Propellers removed',
  'Flat, firm surface',
  'Aircraft cool and still',
  'Room to stand it on each side',
];

function StopBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      h="32px"
      px="13px"
      borderRadius="8px"
      borderWidth="1px"
      borderColor="danger"
      bg="danger"
      color="white"
      fontSize="12.5px"
      fontWeight="600"
      whiteSpace="nowrap"
      cursor="pointer"
      _hover={{ opacity: 0.9 }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'danger', outlineOffset: '2px' }}
      _disabled={{ bg: 'bg.raised', borderColor: 'border', color: 'fg.subtle', cursor: 'not-allowed', opacity: 1 }}
    >
      {children}
    </chakra.button>
  );
}

function PositionCard({ position, active, done }: { position: ImuPosition; active: boolean; done: boolean }) {
  const tone = active ? 'accent' : done ? 'ok' : undefined;
  return (
    <Flex
      align="flex-start"
      gap="10px"
      p="12px"
      borderRadius="10px"
      borderWidth="1px"
      borderColor={tone ?? 'border'}
      bg={active ? 'accent.soft' : 'bg.panel'}
      aria-current={active ? 'step' : undefined}
    >
      <Flex
        align="center"
        justify="center"
        w="22px"
        h="22px"
        borderRadius="full"
        bg={done ? 'ok.soft' : 'bg.raised'}
        color={tone ?? 'fg.muted'}
        fontFamily="mono"
        fontSize="11.5px"
        flexShrink={0}
      >
        {done ? <CheckIcon size={13} /> : position.id + 1}
      </Flex>
      <Box minW="0">
        <Text fontWeight="600" color={tone ?? 'fg'}>
          {position.label}
        </Text>
        <Text fontSize="12.5px" color="fg.muted" mt="2px">
          {position.hint}
        </Text>
      </Box>
    </Flex>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Overline>{label}</Overline>
      <Text className="selectable" mt="4px" fontFamily="mono" fontSize="13px">
        {value}
      </Text>
    </Box>
  );
}

function RunStatus({ run }: { run: ImuCalibrationState }) {
  const running = run.phase === 'running';
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const elapsedMs = Math.max(0, (run.finishedAt ?? now) - run.startedAt);
  const percent = run.phase === 'pass' ? 100 : (run.progress ?? 0);
  const tone = PHASE_TONE[run.phase];
  const asked = run.position === undefined ? undefined : IMU_POSITIONS[run.position];

  return (
    <Panel p="18px">
      <Flex align="center" gap="10px">
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
          IMU calibration
        </chakra.h2>
        <Chip tone={tone} pulse={running}>
          {PHASE_LABEL[run.phase]}
        </Chip>
        <Text ml="auto" fontFamily="mono" fontSize="20px" lineHeight="1" whiteSpace="nowrap">
          {percent}
          <Text as="span" fontSize="12px" color="fg.subtle">
            {' '}
            %
          </Text>
        </Text>
      </Flex>

      <Box
        mt="14px"
        h="6px"
        borderRadius="full"
        bg="bg.raised"
        overflow="hidden"
        role="progressbar"
        aria-label="IMU calibration progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <Box
          h="full"
          w={`${percent}%`}
          borderRadius="full"
          bg={tone === 'neutral' ? 'fg.muted' : tone}
          transition="width 0.25s linear"
        />
      </Box>

      <Text mt="12px" color={running ? 'fg' : 'fg.muted'}>
        {run.message}
      </Text>

      <Flex gap="32px" mt="16px" pt="14px" borderTopWidth="1px" borderColor="border">
        <Stat label="Elapsed" value={`${(elapsedMs / 1000).toFixed(1)} s`} />
        <Stat label="Position" value={asked ? `${asked.id + 1} of ${IMU_POSITIONS.length}` : '—'} />
        <Stat label="Progress reports" value={String(run.reports)} />
      </Flex>
    </Panel>
  );
}

function ImuCalibrationPanel({ drone }: { drone: DroneState }) {
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const connected = drone.status === 'connected';
  const run = drone.imuCalibration;
  const running = run?.phase === 'running';
  const otherRunning = drone.calibration?.phase === 'running';
  const choice = connected ? planImuCalibration(drone.modelCode, drone.model) : null;
  const canStart = connected && !running && !otherRunning && Boolean(choice?.plan);

  // Faults the HMS reader currently holds that concern an IMU.
  const imuFaults = (drone.hms?.faults ?? []).filter((fault) => /\bimu\b/i.test(fault.text));

  const start = async (): Promise<void> => {
    setError('');
    setConfirming(false);
    try {
      await window.drone.imuCalibrate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async (): Promise<void> => {
    try {
      await window.drone.imuCalibrateStop();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Box>
      <PageHeader
        title="IMU calibration"
        subtitle="Six-position calibration. The aircraft asks for each position in turn; hold it still until the next one is asked for."
        actions={
          drone.hms ? (
            <Chip tone={imuFaults.length > 0 ? 'danger' : 'ok'}>
              {imuFaults.length > 0
                ? `${imuFaults.length} IMU fault${imuFaults.length === 1 ? '' : 's'} in HMS`
                : 'No IMU faults in HMS'}
            </Chip>
          ) : undefined
        }
      />

      <Panel px="18px" py="14px">
        <Overline>Before you start</Overline>
        <Flex wrap="wrap" gap="8px 22px" mt="9px">
          {PREPARATION.map((item) => (
            <Flex key={item} align="center" gap="8px">
              <Box w="5px" h="5px" borderRadius="full" bg="fg.subtle" />
              <Text>{item}</Text>
            </Flex>
          ))}
        </Flex>
      </Panel>

      <Flex align="flex-start" gap="8px" mt="14px" color="warn">
        <Box mt="2px" flexShrink={0}>
          <AlertIcon size={15} />
        </Box>
        <Text fontSize="12.5px">
          This routine has not been confirmed on an aircraft with this app. It is handled by the
          gimbal controller, so an aircraft that does not support it refuses or does not answer.
        </Text>
      </Flex>

      {!connected && (
        <Flex align="center" gap="8px" mt="14px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to enable the calibration.</Text>
        </Flex>
      )}

      {choice && !choice.plan && (
        <Flex align="flex-start" gap="8px" mt="14px" color="warn">
          <Box mt="2px" flexShrink={0}>
            <AlertIcon size={15} />
          </Box>
          <Text fontSize="12.5px">{choice.reason}</Text>
        </Flex>
      )}

      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mt="22px" mb="10px">
        Positions
      </chakra.h2>
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(230px, 1fr))" gap="10px">
        {IMU_POSITIONS.map((position) => (
          <PositionCard
            key={position.id}
            position={position}
            active={running === true && run?.position === position.id}
            done={run?.done.includes(position.id) ?? false}
          />
        ))}
      </Box>

      {confirming && (
        <Box mt="16px" p="10px 12px" borderRadius="8px" borderWidth="1px" borderColor="warn">
          <Text fontSize="12.5px">
            This puts the aircraft into factory mode, starts the calibration, then leaves factory
            mode again when the run ends. Keep the aircraft level and still until the first
            position is asked for.
          </Text>
          <Flex gap="8px" justify="flex-end" mt="10px">
            <Btn onClick={() => setConfirming(false)}>Cancel</Btn>
            <Btn variant="primary" disabled={!canStart} onClick={() => void start()}>
              Start calibration
            </Btn>
          </Flex>
        </Box>
      )}

      <Flex gap="8px" mt="16px" wrap="wrap">
        <Btn
          variant="primary"
          disabled={!canStart || confirming}
          onClick={() => setConfirming(true)}
          icon={<PlayIcon size={14} />}
        >
          {running ? 'Running…' : run ? 'Run again' : 'Start IMU calibration'}
        </Btn>
        <StopBtn disabled={!running} onClick={() => void stop()}>
          Stop calibration
        </StopBtn>
      </Flex>

      {otherRunning && (
        <Text mt="10px" fontSize="12.5px" color="fg.muted">
          A gimbal calibration is running; wait for it to finish.
        </Text>
      )}

      {error && (
        <Box mt="14px" p="10px 12px" borderRadius="8px" bg="danger.soft" borderLeftWidth="2px" borderColor="danger">
          <Text className="selectable" fontSize="12.5px">
            {error}
          </Text>
        </Box>
      )}

      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mt="26px" mb="10px">
        Latest run
      </chakra.h2>
      {run ? (
        <RunStatus run={run} />
      ) : (
        <Box px="18px" py="22px" borderRadius="12px" borderWidth="1px" borderStyle="dashed" borderColor="border.strong">
          <Text color="fg.subtle">
            No calibration has run in this session. Progress, the position being asked for and the
            result show up here.
          </Text>
        </Box>
      )}
    </Box>
  );
}

export default ImuCalibrationPanel;
