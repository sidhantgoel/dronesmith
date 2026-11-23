import { Flex, Text } from '@chakra-ui/react';
import type { DroneState } from '../types';
import { CALIBRATION_TITLES, PHASE_LABELS } from './labels';
import { StatusDot, type Tone } from './ui';

/** One sentence about what the app is doing right now. */
function currentActivity(drone: DroneState): { tone: Tone; pulse: boolean; text: string } {
  if (drone.status !== 'connected') {
    return { tone: 'warn', pulse: true, text: 'Searching for a DJI device over USB' };
  }
  if (drone.calibration?.phase === 'running') {
    return {
      tone: 'accent',
      pulse: true,
      text: `Calibrating, ${CALIBRATION_TITLES[drone.calibration.kind]}. Do not touch the drone.`,
    };
  }
  if (drone.scanning) {
    return { tone: 'accent', pulse: true, text: 'Reading module versions' };
  }
  return { tone: 'ok', pulse: false, text: 'Ready' };
}

function StatusBar({ drone }: { drone: DroneState }) {
  const activity = currentActivity(drone);
  const calibration = drone.calibration;

  return (
    <Flex
      as="footer"
      align="center"
      gap="16px"
      h="28px"
      px="14px"
      flexShrink={0}
      bg="bg.chrome"
      borderTopWidth="1px"
      borderColor="border"
      fontSize="11.5px"
      color="fg.muted"
    >
      <Flex align="center" gap="8px" flex="1" minW="0" role="status">
        <StatusDot tone={activity.tone} pulse={activity.pulse} />
        <Text truncate>{activity.text}</Text>
      </Flex>
      {calibration && calibration.phase !== 'running' && (
        <Text whiteSpace="nowrap">
          Last calibration: {CALIBRATION_TITLES[calibration.kind]},{' '}
          {PHASE_LABELS[calibration.phase].toLowerCase()}
        </Text>
      )}
      {drone.status === 'connected' && (
        <Text fontFamily="mono" whiteSpace="nowrap">
          {drone.label}
        </Text>
      )}
    </Flex>
  );
}

export default StatusBar;
