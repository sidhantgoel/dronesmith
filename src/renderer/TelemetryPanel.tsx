import { useEffect, useState, type ReactNode } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, FcStatus, TelemetryReading } from '../types';
import { AlertIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel } from './ui';

/** How often the latest status is fetched while the view is live. */
const REFRESH_MS = 500;
/** A status older than this is shown as stale. */
const STALE_MS = 3000;

function Value({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <Box>
      <Overline>{label}</Overline>
      <Text className="selectable" mt="5px" fontFamily="mono" fontSize="20px" lineHeight="1.1">
        {value}
        {unit && (
          <Text as="span" fontSize="12px" color="fg.subtle">
            {' '}
            {unit}
          </Text>
        )}
      </Text>
    </Box>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel p="18px">
      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
        {title}
      </chakra.h2>
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap="16px" mt="14px">
        {children}
      </Box>
    </Panel>
  );
}

const degrees = (value: number): string => value.toFixed(1);

function flightState(status: FcStatus): string {
  if (status.inAir === true) {
    return 'In the air';
  }
  if (status.inAir === false) {
    return 'On the ground';
  }
  return '—';
}

function TelemetryPanel({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const [live, setLive] = useState(true);
  const [reading, setReading] = useState<TelemetryReading>({});
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!connected) {
      setReading({});
      return undefined;
    }
    if (!live) {
      return undefined;
    }
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.drone.getTelemetry();
        if (!cancelled) {
          setReading(next);
          setNow(Date.now());
        }
      } catch {
        // The next tick tries again.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected, live]);

  const status = reading.status;
  const stale = reading.at !== undefined && now - reading.at > STALE_MS;
  const dash = '—';

  return (
    <Box>
      <PageHeader
        title="Telemetry"
        subtitle="Live status the flight controller reports on its own: attitude, position, motion and flight state. Read-only."
        actions={
          <Flex align="center" gap="8px">
            {status && (
              <Chip tone={!live ? 'neutral' : stale ? 'warn' : 'ok'} pulse={live && !stale}>
                {!live ? 'Paused' : stale ? 'No recent data' : 'Live'}
              </Chip>
            )}
            <Btn disabled={!connected} onClick={() => setLive((on) => !on)}>
              {live ? 'Pause' : 'Resume'}
            </Btn>
          </Flex>
        }
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="14px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to see its telemetry.</Text>
        </Flex>
      )}

      {connected && !status && (
        <Box mb="14px" px="18px" py="22px" borderRadius="12px" borderWidth="1px" borderStyle="dashed" borderColor="border.strong">
          <Text color="fg.subtle">
            The flight controller has not reported its status yet. It usually starts within a few
            seconds of linking.
          </Text>
        </Box>
      )}

      <Flex direction="column" gap="14px">
        <Group title="Attitude">
          <Value label="Pitch" value={status ? degrees(status.pitch) : dash} unit="°" />
          <Value label="Roll" value={status ? degrees(status.roll) : dash} unit="°" />
          <Value label="Heading" value={status ? degrees(status.yaw) : dash} unit="°" />
        </Group>

        <Group title="Motion">
          <Value label="Height" value={status ? status.height.toFixed(1) : dash} unit="m" />
          <Value label="Ground speed" value={status ? status.horizontalSpeed.toFixed(1) : dash} unit="m/s" />
          <Value label="Vertical speed" value={status ? status.verticalSpeed.toFixed(1) : dash} unit="m/s" />
        </Group>

        <Group title="Position">
          <Value label="Satellites" value={status ? String(status.satellites) : dash} />
          <Value label="GPS signal" value={status ? `${status.gpsLevel} / 5` : dash} />
          <Value
            label="Latitude"
            value={status?.latitude !== undefined ? status.latitude.toFixed(6) : dash}
            unit={status?.latitude !== undefined ? '°' : undefined}
          />
          <Value
            label="Longitude"
            value={status?.longitude !== undefined ? status.longitude.toFixed(6) : dash}
            unit={status?.longitude !== undefined ? '°' : undefined}
          />
        </Group>

        <Group title="Flight state">
          <Value
            label="Flight mode"
            value={status ? (status.flightModeName ?? `Mode ${status.flightMode}`) : dash}
          />
          <Value label="State" value={status ? flightState(status) : dash} />
          <Value label="Motors" value={status ? (status.motorsOn ? 'Running' : 'Stopped') : dash} />
        </Group>
      </Flex>
    </Box>
  );
}

export default TelemetryPanel;
