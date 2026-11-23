import type { ReactNode } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState } from '../types';
import {
  BatteryIcon,
  CalibrateIcon,
  ChecklistIcon,
  ConsoleIcon,
  DroneIcon,
  FolderIcon,
  FirmwareIcon,
  HealthIcon,
  ImuIcon,
  MotorIcon,
  ParamIcon,
  PartitionIcon,
  RemoteIcon,
  RepairIcon,
  TelemetryIcon,
  ToolsIcon,
} from './icons';
import { Chip, Overline, StatusDot } from './ui';

export type Page =
  | 'device'
  | 'calibration'
  | 'imu'
  | 'motors'
  | 'hms'
  | 'battery'
  | 'telemetry'
  | 'diagnostics'
  | 'service'
  | 'repairs'
  | 'parameters'
  | 'remote'
  | 'images'
  | 'dronefiles'
  | 'console'
  | 'fastboot'
  | 'firmware';

interface NavEntry {
  page: Page;
  label: string;
  icon: ReactNode;
}

const GROUPS: { title: string; items: NavEntry[] }[] = [
  {
    title: 'Aircraft',
    items: [
      { page: 'device', label: 'Device info', icon: <DroneIcon /> },
      { page: 'diagnostics', label: 'Full check', icon: <ChecklistIcon /> },
      { page: 'hms', label: 'HMS Reader', icon: <HealthIcon /> },
      { page: 'battery', label: 'Battery', icon: <BatteryIcon /> },
      { page: 'telemetry', label: 'Telemetry', icon: <TelemetryIcon /> },
    ],
  },
  {
    title: 'Calibration and tests',
    items: [
      { page: 'calibration', label: 'Gimbal calibration', icon: <CalibrateIcon /> },
      { page: 'imu', label: 'IMU calibration', icon: <ImuIcon /> },
      { page: 'motors', label: 'Motor test', icon: <MotorIcon /> },
    ],
  },
  {
    title: 'Service',
    items: [
      { page: 'service', label: 'Service', icon: <ToolsIcon /> },
      { page: 'repairs', label: 'Repairs', icon: <RepairIcon /> },
      { page: 'parameters', label: 'Parameters', icon: <ParamIcon /> },
      { page: 'firmware', label: 'Firmware', icon: <FirmwareIcon /> },
    ],
  },
  {
    title: 'Tools',
    items: [
      { page: 'remote', label: 'Remote controller', icon: <RemoteIcon /> },
      { page: 'images', label: 'Partition images', icon: <PartitionIcon /> },
      { page: 'dronefiles', label: 'Drone files', icon: <FolderIcon /> },
      { page: 'console', label: 'Command console', icon: <ConsoleIcon /> },
      { page: 'fastboot', label: 'Fastboot', icon: <FirmwareIcon /> },
    ],
  },
];

function Row({ label, children }: { label: string; children: string }) {
  return (
    <Flex justify="space-between" gap="12px" fontSize="12px">
      <Text color="fg.subtle" flexShrink={0}>
        {label}
      </Text>
      <Text
        className="selectable"
        title={children}
        fontFamily="mono"
        color="fg.muted"
        textAlign="right"
        truncate
      >
        {children}
      </Text>
    </Flex>
  );
}

function NavItem({
  active,
  icon,
  label,
  trailing,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <chakra.button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      position="relative"
      display="flex"
      alignItems="center"
      gap="10px"
      w="full"
      h="34px"
      px="11px"
      borderRadius="8px"
      textAlign="left"
      fontSize="13px"
      fontWeight={active ? '600' : '500'}
      cursor="pointer"
      color={active ? 'fg' : 'fg.muted'}
      bg={active ? 'bg.raised' : 'transparent'}
      transition="background 0.12s, color 0.12s"
      _hover={{ bg: active ? 'bg.raised' : 'bg.hover', color: 'fg' }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
    >
      {active && (
        <Box
          position="absolute"
          left="0"
          top="9px"
          bottom="9px"
          w="2px"
          borderRadius="full"
          bg="accent"
        />
      )}
      <Box color={active ? 'accent' : 'inherit'} display="flex">
        {icon}
      </Box>
      <Text flex="1" truncate>
        {label}
      </Text>
      {trailing}
    </chakra.button>
  );
}

function Sidebar({
  drone,
  page,
  onNavigate,
  flashing = false,
  checking = false,
}: {
  drone: DroneState;
  page: Page;
  onNavigate: (page: Page) => void;
  flashing?: boolean;
  /** True while a full check is running. */
  checking?: boolean;
}) {
  const connected = drone.status === 'connected';
  const hmsFaults = drone.hms?.faults.length ?? 0;
  const busyDot = <StatusDot tone="accent" pulse />;
  const trailing: Partial<Record<Page, ReactNode>> = {
    diagnostics: checking ? busyDot : undefined,
    calibration: drone.calibration?.phase === 'running' ? busyDot : undefined,
    imu: drone.imuCalibration?.phase === 'running' ? busyDot : undefined,
    repairs: drone.repair?.phase === 'running' ? busyDot : undefined,
    hms: hmsFaults > 0 ? <Chip tone="danger">{String(hmsFaults)}</Chip> : undefined,
    firmware: flashing ? busyDot : undefined,
  };

  return (
    <Flex
      as="nav"
      aria-label="Workspace"
      direction="column"
      gap="18px"
      w="244px"
      flexShrink={0}
      p="14px"
      bg="bg.chrome"
      borderRightWidth="1px"
      borderColor="border"
      overflowY="auto"
    >
      <Box p="14px" borderRadius="12px" bg="bg.panel" borderWidth="1px" borderColor="border">
        <Flex align="center" justify="space-between" gap="8px">
          <Overline>Aircraft</Overline>
          <Chip tone={connected ? 'ok' : 'warn'} pulse={!connected}>
            {connected ? 'Linked' : 'Searching'}
          </Chip>
        </Flex>
        <Text
          className="selectable"
          mt="10px"
          fontFamily="heading"
          fontSize="16px"
          fontWeight="600"
          lineHeight="1.25"
          color={connected ? 'fg' : 'fg.subtle'}
          wordBreak="break-word"
        >
          {connected ? (drone.model ?? 'Unnamed aircraft') : 'No aircraft'}
        </Text>
        <Flex direction="column" gap="6px" mt="12px" pt="12px" borderTopWidth="1px" borderColor="border">
          <Row label="Serial">{drone.serial ?? '—'}</Row>
          <Row label="Firmware">{drone.manifest?.formalVersion ?? '—'}</Row>
          <Row label="Anti-rollback">
            {drone.manifest?.antiRollback != null ? String(drone.manifest.antiRollback) : '—'}
          </Row>
          <Row label="Factory code">{drone.modelCode ?? '—'}</Row>
          <Row label="Endpoint">{drone.label ?? '—'}</Row>
          <Row label="Modules">{connected ? String(drone.modules.length) : '—'}</Row>
        </Flex>
      </Box>

      {GROUPS.map((group) => (
        <Box key={group.title}>
          <Box px="11px" mb="8px">
            <Overline>{group.title}</Overline>
          </Box>
          <Flex direction="column" gap="2px">
            {group.items.map((item) => (
              <NavItem
                key={item.page}
                active={page === item.page}
                icon={item.icon}
                label={item.label}
                trailing={trailing[item.page]}
                onClick={() => onNavigate(item.page)}
              />
            ))}
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}

export default Sidebar;
