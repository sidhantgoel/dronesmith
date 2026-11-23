import type { ReactNode } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, ModuleVersion } from '../types';
import AircraftSchematic from './AircraftSchematic';
import { CheckIcon, CopyIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel, useCopy } from './ui';

const CONNECT_STEPS = [
  'Connect the drone to this PC with a USB cable.',
  'Power the drone on.',
  'Wait a moment. Detection is automatic, there is nothing to press.',
];

/** Module name the drone session gives the camera (see SCAN_TARGETS). */
const CAMERA = 'Camera';

/**
 * The modules to list. The serial number is read through a different module
 * than the camera's version, so if the camera itself did not answer the scan
 * it still gets a row to carry its serial.
 */
function moduleRows(drone: DroneState): ModuleVersion[] {
  if (!drone.cameraSerial || drone.modules.some((module) => module.name === CAMERA)) {
    return drone.modules;
  }
  return [...drone.modules, { name: CAMERA, hardware: '—', firmware: '—', loader: '—' }];
}

function buildReport(drone: DroneState): string {
  const rows = [
    ['Module', 'Hardware', 'Firmware', 'Loader', 'Serial'],
    ...moduleRows(drone).map((module) => [
      module.name,
      module.hardware,
      module.firmware,
      module.loader,
      module.name === CAMERA ? (drone.cameraSerial ?? 'not reported') : '',
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const table = rows.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd(),
  );
  return [
    'Dronesmith - device report',
    `Generated     ${new Date().toISOString()}`,
    `Model         ${drone.model ?? 'not reported'}`,
    `Serial        ${drone.serial ?? 'not reported'}`,
    `Firmware      ${drone.manifest?.formalVersion ?? 'not reported'}`,
    `Anti-rollback ${drone.manifest?.antiRollback ?? 'not reported'}`,
    `USB endpoint  ${drone.label ?? 'unknown'}`,
    '',
    ...table,
    '',
  ].join('\n');
}

function Fact({
  label,
  children,
  dim = false,
}: {
  label: string;
  children: ReactNode;
  dim?: boolean;
}) {
  return (
    <Box minW="0">
      <Overline>{label}</Overline>
      <Text
        className="selectable"
        mt="5px"
        fontFamily="mono"
        fontSize="13px"
        color={dim ? 'fg.subtle' : 'fg'}
        wordBreak="break-word"
      >
        {children}
      </Text>
    </Box>
  );
}

function WaitingForAircraft({ error }: { error?: string }) {
  return (
    <Box>
      <chakra.h2 fontFamily="heading" fontSize="16px" fontWeight="600">
        Waiting for an aircraft
      </chakra.h2>
      <chakra.ol mt="14px" display="grid" gap="11px">
        {CONNECT_STEPS.map((step, index) => (
          <chakra.li key={step} display="flex" gap="11px" alignItems="baseline">
            <Text fontFamily="mono" fontSize="11.5px" color="accent" flexShrink={0}>
              {index + 1}
            </Text>
            <Text color="fg.muted">{step}</Text>
          </chakra.li>
        ))}
      </chakra.ol>
      {error && (
        <Box
          mt="18px"
          p="10px 12px"
          borderRadius="8px"
          bg="danger.soft"
          borderLeftWidth="2px"
          borderColor="danger"
        >
          <Overline>Last attempt</Overline>
          <Text className="selectable" mt="3px" fontSize="12.5px">
            {error}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function Identity({ drone }: { drone: DroneState }) {
  const count = drone.modules.length;
  return (
    <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(136px, 1fr))" gap="20px">
      <Fact label="Model" dim={!drone.model}>
        {drone.model ?? 'Not reported by the drone'}
        {drone.modelCode && (
          <Text as="span" color="fg.subtle">
            {'  '}
            {drone.modelCode}
          </Text>
        )}
      </Fact>
      <Fact label="USB endpoint" dim={!drone.label}>
        {drone.label ?? 'Unknown'}
      </Fact>
      <Fact label="Modules answering" dim={count === 0}>
        {count === 0 ? 'None yet' : String(count)}
      </Fact>
    </Box>
  );
}

const CELL = { px: '16px', py: '9px', textAlign: 'left', verticalAlign: 'top' } as const;

function ModuleTable({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const rows = moduleRows(drone);

  if (rows.length === 0) {
    return (
      <Text px="16px" py="22px" color="fg.subtle">
        {connected
          ? 'Reading module versions…'
          : 'Hardware, firmware and loader versions are listed here once an aircraft is linked.'}
      </Text>
    );
  }

  return (
    <chakra.table w="full" borderCollapse="collapse">
      <thead>
        <tr>
          {['Module', 'Hardware', 'Firmware', 'Loader'].map((heading) => (
            <chakra.th
              key={heading}
              {...CELL}
              py="8px"
              fontSize="10.5px"
              fontWeight="600"
              letterSpacing="0.09em"
              textTransform="uppercase"
              color="fg.subtle"
              borderBottomWidth="1px"
              borderColor="border"
            >
              {heading}
            </chakra.th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((module, index) => {
          const last = index === rows.length - 1;
          const border = { borderBottomWidth: last ? '0' : '1px', borderColor: 'border' };
          return (
            <chakra.tr key={module.name} _hover={{ bg: 'bg.hover' }}>
              <chakra.td {...CELL} {...border} fontWeight="500">
                {module.name}
                {module.name === CAMERA && (
                  <Text
                    className="selectable"
                    mt="2px"
                    fontFamily="mono"
                    fontSize="11.5px"
                    fontWeight="400"
                    color={drone.cameraSerial ? 'fg.muted' : 'fg.subtle'}
                    wordBreak="break-word"
                  >
                    SN{' '}
                    {drone.cameraSerial ?? (drone.scanning ? 'reading…' : 'not reported')}
                  </Text>
                )}
              </chakra.td>
              {(['hardware', 'firmware', 'loader'] as const).map((field) => {
                const value = module[field];
                return (
                <chakra.td
                  key={field}
                  className="selectable"
                  {...CELL}
                  {...border}
                  fontFamily="mono"
                  fontSize="12.5px"
                  color={value === '—' ? 'fg.subtle' : 'fg'}
                >
                  {value}
                </chakra.td>
                );
              })}
            </chakra.tr>
          );
        })}
      </tbody>
    </chakra.table>
  );
}

function DronePanel({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const { state: copyState, copy } = useCopy();

  return (
    <Box>
      <PageHeader
        title="Device info"
        subtitle="Identity of the linked aircraft and the version of every module that answers."
        actions={
          <Btn
            onClick={() => copy(buildReport(drone))}
            disabled={drone.modules.length === 0}
            icon={copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
          >
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? 'Copy failed'
                : 'Copy report'}
          </Btn>
        }
      />

      <Panel overflow="hidden">
        {/* Side by side while there is room, stacked in a narrow window. */}
        <Flex
          wrap="wrap"
          bg="radial-gradient(55% 110% at 24% 45%, rgba(90, 176, 255, 0.08), transparent 72%)"
        >
          <Flex
            flex="1 1 280px"
            direction="column"
            align="center"
            justify="center"
            gap="6px"
            px="20px"
            py="18px"
          >
            <AircraftSchematic drone={drone} />
            <Flex gap="16px" fontSize="11.5px" color="fg.subtle">
              <Flex align="center" gap="6px">
                <Box w="7px" h="7px" borderRadius="full" bg="accent" />
                Answered
              </Flex>
              <Flex align="center" gap="6px">
                <Box
                  w="7px"
                  h="7px"
                  borderRadius="full"
                  borderWidth="1px"
                  borderColor="border.strong"
                />
                No reply
              </Flex>
              <Text>M1–M4 are the ESCs</Text>
            </Flex>
          </Flex>
          <Flex flex="2 1 300px" minW="0" direction="column" justify="center" p="24px">
            {connected ? <Identity drone={drone} /> : <WaitingForAircraft error={drone.error} />}
          </Flex>
        </Flex>
      </Panel>

      <Flex align="center" gap="10px" mt="26px" mb="10px">
        <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
          Modules
        </chakra.h2>
        {drone.modules.length > 0 && (
          <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
            {drone.modules.length}
          </Text>
        )}
        {connected && drone.scanning && (
          <Chip tone="accent" pulse>
            Scanning
          </Chip>
        )}
      </Flex>
      <Panel overflow="hidden">
        <ModuleTable drone={drone} />
      </Panel>
    </Box>
  );
}

export default DronePanel;
