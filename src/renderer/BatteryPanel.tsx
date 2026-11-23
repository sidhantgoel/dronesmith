import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { BatterySnapshot, DroneState } from '../types';
import { batteryHealth } from '../battery';
import { AlertIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel, type Tone } from './ui';

/** How often the battery is queried while polling. */
const POLL_MS = 2000;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Flex justify="space-between" gap="12px" py="5px">
      <Text color="fg.muted">{label}</Text>
      <Text className="selectable" fontFamily="mono" fontSize="13px" textAlign="right">
        {value}
      </Text>
    </Flex>
  );
}

function Bar({ label, percent, tone }: { label: string; percent: number; tone: Tone }) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <Box
      h="6px"
      borderRadius="full"
      bg="bg.raised"
      overflow="hidden"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <Box h="full" w={`${value}%`} borderRadius="full" bg={tone} transition="width 0.25s linear" />
    </Box>
  );
}

const chargeTone = (percent: number): Tone => (percent > 30 ? 'ok' : percent > 10 ? 'warn' : 'danger');
const cellTone = (volts: number): Tone => (volts < 3.3 ? 'danger' : volts < 3.6 ? 'warn' : 'ok');

function Cells({ voltages }: { voltages: number[] }) {
  const total = voltages.reduce((sum, value) => sum + value, 0);
  const spread = Math.max(...voltages) - Math.min(...voltages);
  return (
    <Panel p="18px" mt="14px">
      <Flex align="baseline" justify="space-between" gap="12px" wrap="wrap">
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
          Cell voltages
        </chakra.h2>
        <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
          Spread {(spread / 1000).toFixed(3)} V · average {(total / voltages.length / 1000).toFixed(3)} V
          · total {(total / 1000).toFixed(3)} V
        </Text>
      </Flex>
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap="10px" mt="12px">
        {voltages.map((millivolts, index) => {
          const volts = millivolts / 1000;
          return (
            // Cells are identified by their position in the pack.
            <Box key={index} p="12px" borderRadius="10px" borderWidth="1px" borderColor="border" textAlign="center">
              <Overline>Cell {index + 1}</Overline>
              <Text mt="6px" fontFamily="mono" fontSize="18px" fontWeight="600" color={cellTone(volts)}>
                {volts.toFixed(3)} V
              </Text>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}

function BatteryPanel({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const [battery, setBattery] = useState<BatterySnapshot>({});
  const [readAt, setReadAt] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const read = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const reading = await window.drone.readBattery();
      if (reading.ok) {
        // Keep earlier answers for the parts that did not reply this time.
        setBattery((previous) => ({ ...previous, ...reading.battery }));
        setReadAt(reading.at);
        setError('');
      } else {
        setError(reading.message ?? 'The battery could not be read.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!polling || !connected) {
      return undefined;
    }
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, connected, read]);

  // A different aircraft, or none: what was read no longer applies.
  useEffect(() => {
    if (!connected) {
      setPolling(false);
      setBattery({});
      setReadAt(null);
      setError('');
    }
  }, [connected]);

  const { pack, live, cellVoltages, serial } = battery;
  const health = batteryHealth(battery);
  const volts = live ? live.voltage / 1000 : 0;
  const amps = live ? live.current / 1000 : 0;
  const cells = live?.cells || pack?.cells || 0;
  const dash = '—';

  return (
    <Box>
      <PageHeader
        title="Battery"
        subtitle="Charge, health, cell voltages and identity read from the flight battery. Read-only."
        actions={
          <Flex align="center" gap="8px">
            {readAt && (
              <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
                Read {new Date(readAt).toLocaleTimeString()}
              </Text>
            )}
            <Btn disabled={!connected || busy || polling} onClick={() => void read()}>
              Read once
            </Btn>
            <Btn variant="primary" disabled={!connected} onClick={() => setPolling((on) => !on)}>
              {polling ? 'Stop polling' : 'Start polling'}
            </Btn>
          </Flex>
        }
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="14px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to read its battery.</Text>
        </Flex>
      )}

      {error && (
        <Box mb="14px" p="10px 12px" borderRadius="8px" bg="danger.soft" borderLeftWidth="2px" borderColor="danger">
          <Text className="selectable" fontSize="12.5px">
            {error}
          </Text>
        </Box>
      )}

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap="14px">
        <Panel p="18px">
          <Flex align="center" gap="10px">
            <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" flex="1">
              Charge
            </chakra.h2>
            {polling && (
              <Chip tone="accent" pulse>
                Polling
              </Chip>
            )}
          </Flex>
          <Text mt="10px" fontFamily="mono" fontSize="30px" lineHeight="1">
            {live ? live.percent : dash}
            <Text as="span" fontSize="14px" color="fg.subtle">
              {' '}
              %
            </Text>
          </Text>
          <Box mt="12px" mb="8px">
            <Bar label="Charge level" percent={live?.percent ?? 0} tone={chargeTone(live?.percent ?? 0)} />
          </Box>
          <Row label="Remaining" value={live ? `${live.remaining} mAh` : dash} />
          <Row label="Full charge" value={live ? `${live.fullCapacity} mAh` : dash} />
          <Row label="Pack voltage" value={live ? `${volts.toFixed(2)} V` : dash} />
          <Row label="Current" value={live ? `${amps.toFixed(2)} A` : dash} />
          <Row label="Power" value={live ? `${Math.abs(volts * amps).toFixed(1)} W` : dash} />
          <Row label="Temperature" value={live ? `${live.temperature.toFixed(1)} °C` : dash} />
        </Panel>

        <Panel p="18px">
          <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
            Health and identity
          </chakra.h2>
          <Text mt="10px" fontFamily="mono" fontSize="30px" lineHeight="1">
            {health ?? dash}
            <Text as="span" fontSize="14px" color="fg.subtle">
              {' '}
              % of design capacity
            </Text>
          </Text>
          <Box mt="12px" mb="8px">
            <Bar label="Battery health" percent={health ?? 0} tone={(health ?? 0) > 80 ? 'ok' : 'warn'} />
          </Box>
          <Row label="Charge cycles" value={pack ? String(pack.cycles) : dash} />
          <Row label="Design capacity" value={pack ? `${pack.designCapacity} mAh` : dash} />
          <Row label="Cells" value={cells ? `${cells} in series` : dash} />
          <Row label="Manufactured" value={pack?.manufactured ?? dash} />
          <Row label="Serial" value={serial ?? dash} />
        </Panel>
      </Box>

      {cellVoltages && cellVoltages.length > 0 ? (
        <Cells voltages={cellVoltages} />
      ) : (
        <Box mt="14px" px="18px" py="22px" borderRadius="12px" borderWidth="1px" borderStyle="dashed" borderColor="border.strong">
          <Text color="fg.subtle">No cell voltages yet. Read once or start polling.</Text>
        </Box>
      )}
    </Box>
  );
}

export default BatteryPanel;
