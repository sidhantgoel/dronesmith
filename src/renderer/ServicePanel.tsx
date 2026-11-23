import { useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, ServiceResult } from '../types';
import { isDestructiveService, type ServiceAction } from '../service';
import { AlertIcon, CheckIcon } from './icons';
import { Btn, PageHeader, Panel, type Tone } from './ui';

interface ActionDef {
  action: ServiceAction;
  label: string;
  description: string;
}

interface Tab {
  key: string;
  title: string;
  note?: string;
  actions: ActionDef[];
}

const TABS: Tab[] = [
  {
    key: 'camera',
    title: 'Camera & vision',
    note: 'Camera and obstacle-avoidance sensor checks. Sensor-level optical calibration is not available (it needs factory per-module data).',
    actions: [
      { action: 'camera-info', label: 'Read camera info', description: 'Reads the camera serial and firmware. Calibration faults appear in the HMS scan.' },
      { action: 'vision-scan', label: 'Scan vision / ToF', description: 'Reads the monocular and binocular vision sensor serials.' },
      { action: 'vision-cal', label: 'Vision calibration status', description: 'Checks whether the vision sensors report calibrated.' },
      { action: 'tof-reset', label: 'Reset ToF calibration', description: 'Resets the downward ToF (landing) sensor calibration. Recalibrate on a flat surface after.' },
      { action: 'vision-recover', label: 'Recover vision sensors', description: 'Resets the vision module in factory mode and re-reads all eight sensors. For vision sensor faults; restart the aircraft after.' },
    ],
  },
  {
    key: 'fc',
    title: 'Flight controller',
    note: 'Flight-controller diagnostics and ESC fault repair.',
    actions: [
      { action: 'imu-status', label: 'IMU status', description: 'Reads the flight-controller IMU status.' },
      { action: 'fc-param-count', label: 'Parameter table', description: 'Reads the flight-controller parameter-table summary.' },
      { action: 'esc-repair', label: 'Repair ESC fault codes', description: 'Clears ESC faults on the flight controller; needs a reboot after.' },
    ],
  },
  {
    key: 'power',
    title: 'Power & radio',
    note: 'Battery status, radio-link checks, and restarting or switching off the aircraft.',
    actions: [
      { action: 'battery-info', label: 'Read battery', description: 'Reads smart-battery status.' },
      { action: 'link-test', label: 'Test RF links', description: 'Probes the aircraft radios for a response.' },
      { action: 'rc-pair', label: 'Pair remote controller', description: 'Starts the aircraft side of RC pairing.' },
      { action: 'aircraft-restart', label: 'Restart aircraft', description: 'Power-cycles the aircraft. The link drops and comes back by itself.' },
      { action: 'aircraft-power-off', label: 'Power off aircraft', description: 'Switches the aircraft off. Use the battery button to switch it on again.' },
    ],
  },
  {
    key: 'factory',
    title: 'Factory mode',
    note: 'Puts the aircraft into factory service mode. Exit it when finished.',
    actions: [
      { action: 'factory-enter', label: 'Enter factory mode', description: 'Unlocks factory service functions.' },
      { action: 'factory-exit', label: 'Exit factory mode', description: 'Returns the aircraft to normal operation.' },
    ],
  },
];

const ALL_ACTIONS: ActionDef[] = TABS.flatMap((t) => t.actions);

function ResultBar({ result }: { result: ServiceResult }) {
  const tone: Tone = result.ok ? 'ok' : 'danger';
  return (
    <Panel
      mt="14px"
      px="16px"
      py="12px"
      borderLeftWidth="2px"
      borderColor={tone === 'ok' ? 'ok' : 'danger'}
    >
      <Flex align="center" gap="8px">
        <Box color={tone === 'ok' ? 'ok' : 'danger'}>
          {result.ok ? <CheckIcon size={15} /> : <AlertIcon size={15} />}
        </Box>
        <Text fontSize="13px">{result.message}</Text>
      </Flex>
      {result.details && result.details.length > 0 && (
        <Flex direction="column" gap="2px" mt="8px" pl="23px">
          {result.details.map((d, i) => (
            <Text key={i} fontFamily="mono" fontSize="11px" color="fg.subtle">
              {d}
            </Text>
          ))}
        </Flex>
      )}
    </Panel>
  );
}

function ServicePanel({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const [tab, setTab] = useState<string>(TABS[0].key);
  const [busy, setBusy] = useState<ServiceAction | null>(null);
  const [confirming, setConfirming] = useState<ServiceAction | null>(null);
  const [result, setResult] = useState<ServiceResult | null>(null);
  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  const run = async (action: ServiceAction): Promise<void> => {
    setConfirming(null);
    setBusy(action);
    setResult(null);
    try {
      setResult(await window.drone.runService(action));
    } catch (err) {
      setResult({
        action,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const onClick = (action: ServiceAction): void => {
    if (isDestructiveService(action)) {
      setConfirming(action);
    } else {
      void run(action);
    }
  };

  return (
    <Box>
      <PageHeader
        title="Service"
        subtitle="Camera, vision, flight-controller, power and factory service commands."
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="16px" color="warn">
          <AlertIcon size={15} />
          <Text>Connect an aircraft to run service commands.</Text>
        </Flex>
      )}

      <Flex
        gap="4px"
        mb="14px"
        p="3px"
        bg="bg.raised"
        borderRadius="10px"
        borderWidth="1px"
        borderColor="border"
        wrap="wrap"
      >
        {TABS.map((t) => (
          <chakra.button
            key={t.key}
            onClick={() => setTab(t.key)}
            flex="1 1 auto"
            px="12px"
            h="30px"
            fontSize="12.5px"
            fontWeight={t.key === tab ? '600' : '500'}
            borderRadius="7px"
            bg={t.key === tab ? 'bg.surface' : 'transparent'}
            color={t.key === tab ? 'fg' : 'fg.muted'}
            borderWidth="1px"
            borderColor={t.key === tab ? 'border.strong' : 'transparent'}
            _hover={{ color: 'fg' }}
            _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
          >
            {t.title}
          </chakra.button>
        ))}
      </Flex>

      <Panel px="18px" py="16px">
        {active.note && (
          <Text fontSize="12px" color="fg.muted" mb="12px">
            {active.note}
          </Text>
        )}
        <Flex gap="10px" wrap="wrap">
          {active.actions.map((a) => (
            <Box key={a.action} flex="1 1 240px" minW="0">
              <Btn
                variant="quiet"
                disabled={!connected || busy !== null}
                onClick={() => onClick(a.action)}
              >
                {busy === a.action ? 'Running…' : a.label}
              </Btn>
              <Text fontSize="11.5px" color="fg.subtle" mt="5px">
                {a.description}
              </Text>
            </Box>
          ))}
        </Flex>
      </Panel>

      {confirming && (
        <Panel mt="14px" px="16px" py="14px" borderColor="danger">
          <Flex align="center" gap="8px" color="danger" mb="10px">
            <AlertIcon size={15} />
            <Text fontSize="13px" fontWeight="600">
              This changes the aircraft state.
            </Text>
          </Flex>
          <Text fontSize="12.5px" color="fg.muted" mb="12px">
            {ALL_ACTIONS.find((a) => a.action === confirming)?.description}
          </Text>
          <Flex gap="10px" justify="flex-end">
            <Btn variant="quiet" onClick={() => setConfirming(null)}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={() => void run(confirming)}>
              Confirm
            </Btn>
          </Flex>
        </Panel>
      )}

      {result && <ResultBar result={result} />}
    </Box>
  );
}

export default ServicePanel;
