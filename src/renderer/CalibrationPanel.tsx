import { useEffect, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { CalibrationKind, CalibrationState, DroneState } from '../types';
import { entersFactoryMode, planAdvancedCalibration } from '../gimbalCal';
import { AlertIcon, PlayIcon } from './icons';
import { CALIBRATION_TITLES, PHASE_LABELS } from './labels';
import { Btn, Chip, Overline, PageHeader, Panel, type Tone } from './ui';

const PHASE_TONE: Record<CalibrationState['phase'], Tone> = {
  running: 'accent',
  pass: 'ok',
  unsure: 'warn',
  failed: 'danger',
};

type BasicKind = Exclude<CalibrationKind, 'advanced'>;

const ROUTINES: { kind: BasicKind; duration: string; summary: string }[] = [
  {
    kind: 'jointCoarse',
    duration: 'About 15 s',
    summary: 'Coarse calibration of the gimbal joints. Run this one first.',
  },
  {
    kind: 'linearHall',
    duration: 'A few minutes',
    summary: 'Linearity calibration of the Hall sensors. Run it after Joint Coarse.',
  },
];

const PREPARATION = [
  'Drone on a level surface',
  'Gimbal cover removed',
  'Gimbal free to move',
  'Hands off while a routine runs',
];

function RoutineCard({
  step,
  kind,
  duration,
  summary,
  calibration,
  disabled,
  onStart,
}: {
  step: number;
  kind: CalibrationKind;
  duration: string;
  summary: string;
  calibration?: CalibrationState;
  disabled: boolean;
  onStart: () => void;
}) {
  const own = calibration?.kind === kind ? calibration : undefined;
  const running = own?.phase === 'running';

  return (
    <Panel p="18px" display="flex" flexDirection="column" gap="10px">
      <Flex align="center" gap="10px">
        <Flex
          align="center"
          justify="center"
          w="22px"
          h="22px"
          borderRadius="full"
          bg="bg.raised"
          fontFamily="mono"
          fontSize="11.5px"
          color="fg.muted"
          flexShrink={0}
        >
          {step}
        </Flex>
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" flex="1" minW="0">
          {CALIBRATION_TITLES[kind]}
        </chakra.h2>
        {own && (
          <Chip tone={PHASE_TONE[own.phase]} pulse={running}>
            {PHASE_LABELS[own.phase]}
          </Chip>
        )}
      </Flex>
      <Text color="fg.muted" flex="1">
        {summary}
      </Text>
      <Flex align="center" justify="space-between" gap="12px" mt="4px">
        <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
          {duration}
        </Text>
        <Btn variant="primary" disabled={disabled} onClick={onStart} icon={<PlayIcon size={14} />}>
          {running ? 'Running…' : own ? 'Run again' : 'Start'}
        </Btn>
      </Flex>
    </Panel>
  );
}

/**
 * The one-step full automatic routine. Which sequence it uses, and whether it
 * may run at all, depends on the aircraft, so the card says so before Start.
 */
function AdvancedCard({
  drone,
  disabled,
  onStart,
}: {
  drone: DroneState;
  disabled: boolean;
  onStart: (allowRestricted: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [allowRestricted, setAllowRestricted] = useState(false);
  const connected = drone.status === 'connected';
  const choice = connected ? planAdvancedCalibration(drone.modelCode, drone.model) : null;
  const own = drone.calibration?.kind === 'advanced' ? drone.calibration : undefined;
  const running = own?.phase === 'running';
  // When the model is refused as firmware-only, see whether an override produces
  // a plan; if so, offer a testing toggle rather than a flat block.
  const overridePlan =
    connected && choice && !choice.plan
      ? planAdvancedCalibration(drone.modelCode, drone.model, true).plan ?? null
      : null;
  const plan = choice?.plan ?? (allowRestricted ? overridePlan : null);
  const usesFactoryMode = plan ? entersFactoryMode(plan) : false;

  return (
    <Panel p="18px" display="flex" flexDirection="column" gap="10px">
      <Flex align="center" gap="10px">
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" flex="1" minW="0">
          {CALIBRATION_TITLES.advanced}
        </chakra.h2>
        {own && (
          <Chip tone={PHASE_TONE[own.phase]} pulse={running}>
            {PHASE_LABELS[own.phase]}
          </Chip>
        )}
      </Flex>
      <Text color="fg.muted">
        Full automatic calibration in one step, the routine DJI Fly offers as advanced gimbal
        calibration. Keep the drone on a flat, level surface and follow any prompt in the status
        below; some models ask you to reposition the drone part-way through.
      </Text>

      {choice && !choice.plan && (
        <Flex align="flex-start" gap="8px" color="warn">
          <Box mt="2px" flexShrink={0}>
            <AlertIcon size={15} />
          </Box>
          <Text fontSize="12.5px">{choice.reason}</Text>
        </Flex>
      )}

      {overridePlan && (
        <chakra.label display="flex" alignItems="flex-start" gap="8px" cursor="pointer">
          <chakra.input
            type="checkbox"
            checked={allowRestricted}
            onChange={(e) => setAllowRestricted(e.currentTarget.checked)}
            mt="3px"
          />
          <Text fontSize="12.5px" color="fg">
            Run it anyway on this model for testing. It sends the standard command calibration; on this
            model that can leave the camera in download mode and need a service-firmware reload.
          </Text>
        </chakra.label>
      )}

      {confirming && plan && (
        <Box p="10px 12px" borderRadius="8px" borderWidth="1px" borderColor="warn">
          <Text fontSize="12.5px">
            {plan.restricted
              ? 'This model is normally not calibrated by command. '
              : ''}
            {usesFactoryMode
              ? 'This puts the aircraft into factory mode and runs the calibration. The aircraft stays in factory mode afterwards.'
              : 'This starts the calibration on the gimbal directly.'}{' '}
            The gimbal moves through its full range for about {Math.round(plan.expectMs / 1000)} s
            and it cannot be stopped from here once started.
          </Text>
          <Flex gap="8px" justify="flex-end" mt="10px">
            <Btn onClick={() => setConfirming(false)}>Cancel</Btn>
            <Btn
              variant="primary"
              disabled={disabled}
              onClick={() => {
                setConfirming(false);
                onStart(plan.restricted === true);
              }}
            >
              Start calibration
            </Btn>
          </Flex>
        </Box>
      )}

      <Flex align="center" justify="space-between" gap="12px" mt="4px">
        <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
          {plan ? `${plan.label} · about ${Math.round(plan.expectMs / 1000)} s` : 'Model-dependent'}
        </Text>
        <Btn
          variant="primary"
          disabled={disabled || !plan || confirming}
          onClick={() => setConfirming(true)}
          icon={<PlayIcon size={14} />}
        >
          {running ? 'Running…' : own ? 'Run again' : 'Start'}
        </Btn>
      </Flex>
    </Panel>
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

function CalibrationStatus({ calibration }: { calibration: CalibrationState }) {
  const running = calibration.phase === 'running';
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const end = calibration.finishedAt ?? now;
  const elapsedMs = Math.max(0, end - calibration.startedAt);
  // The advanced routine reports a real percentage. The two basic routines
  // report an internal phase value instead, so for them the bar only tracks
  // elapsed time against the expected duration.
  const fraction =
    calibration.phase === 'pass'
      ? 1
      : calibration.progress !== undefined
        ? calibration.progress / 100
        : Math.min(elapsedMs / calibration.expectMs, running ? 0.97 : 1);
  const tone = PHASE_TONE[calibration.phase];

  return (
    <Panel p="18px">
      <Flex align="center" gap="10px">
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
          {CALIBRATION_TITLES[calibration.kind]}
        </chakra.h2>
        <Chip tone={tone} pulse={running}>
          {PHASE_LABELS[calibration.phase]}
        </Chip>
        <Text ml="auto" fontFamily="mono" fontSize="20px" lineHeight="1" whiteSpace="nowrap">
          {(elapsedMs / 1000).toFixed(1)}
          <Text as="span" fontSize="12px" color="fg.subtle">
            {' '}
            s of ~{Math.round(calibration.expectMs / 1000)} s
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
        aria-label={`${CALIBRATION_TITLES[calibration.kind]} elapsed time`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <Box
          h="full"
          w={`${fraction * 100}%`}
          borderRadius="full"
          bg={tone === 'neutral' ? 'fg.muted' : tone}
          transition="width 0.25s linear"
        />
      </Box>

      <Text mt="12px" color={running ? 'fg' : 'fg.muted'}>
        {calibration.message}
      </Text>

      <Flex gap="32px" mt="16px" pt="14px" borderTopWidth="1px" borderColor="border">
        {calibration.progress !== undefined && (
          <Stat label="Gimbal progress" value={`${calibration.progress}%`} />
        )}
        <Stat label="Progress reports" value={String(calibration.reports)} />
        <Stat label="Last report" value={calibration.lastReport ?? '—'} />
      </Flex>
    </Panel>
  );
}

function CalibrationPanel({ drone }: { drone: DroneState }) {
  const [error, setError] = useState('');
  const connected = drone.status === 'connected';
  const running = drone.calibration?.phase === 'running';
  const disabled = !connected || running;

  const start = async (kind: CalibrationKind, allowRestricted = false): Promise<void> => {
    setError('');
    try {
      await window.drone.calibrate(kind, allowRestricted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Box>
      <PageHeader
        title="Gimbal calibration"
        subtitle="Two basic routines run in order, or the one-step advanced routine. The gimbal moves on its own while they run."
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

      {!connected && (
        <Flex align="center" gap="8px" mt="16px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to enable the routines.</Text>
        </Flex>
      )}

      <Box
        display="grid"
        gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))"
        gap="14px"
        mt="16px"
      >
        {ROUTINES.map((routine, index) => (
          <RoutineCard
            key={routine.kind}
            step={index + 1}
            {...routine}
            calibration={drone.calibration}
            disabled={disabled}
            onStart={() => void start(routine.kind)}
          />
        ))}
      </Box>

      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mt="22px" mb="10px">
        Advanced calibration
      </chakra.h2>
      <AdvancedCard
        drone={drone}
        disabled={disabled}
        onStart={(allowRestricted) => void start('advanced', allowRestricted)}
      />

      {error && (
        <Box
          mt="14px"
          p="10px 12px"
          borderRadius="8px"
          bg="danger.soft"
          borderLeftWidth="2px"
          borderColor="danger"
        >
          <Text className="selectable" fontSize="12.5px">
            {error}
          </Text>
        </Box>
      )}

      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mt="26px" mb="10px">
        Latest run
      </chakra.h2>
      {drone.calibration ? (
        <CalibrationStatus calibration={drone.calibration} />
      ) : (
        <Box
          px="18px"
          py="22px"
          borderRadius="12px"
          borderWidth="1px"
          borderStyle="dashed"
          borderColor="border.strong"
        >
          <Text color="fg.subtle">
            No routine has run in this session. Timing, progress reports and the result show up
            here.
          </Text>
        </Box>
      )}
    </Box>
  );
}

export default CalibrationPanel;
