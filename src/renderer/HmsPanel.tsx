import { useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, HmsFault } from '../types';
import { hmsLevelLabel } from '../hms';
import { CheckIcon, CopyIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel, type Tone, useCopy } from './ui';

function levelTone(level: number): Tone {
  if (level >= 4) return 'danger';
  if (level === 3) return 'danger';
  if (level === 2) return 'warn';
  return 'accent';
}

const formatTime = (at: number): string => new Date(at).toLocaleTimeString('en-GB', { hour12: false });

function buildReport(drone: DroneState): string {
  const faults = drone.hms?.faults ?? [];
  const lines = [
    `HMS report — ${drone.model ?? 'aircraft'}${drone.modelCode ? ` (${drone.modelCode})` : ''}`,
    `Read at ${new Date().toISOString()}`,
    faults.length === 0 ? 'No active faults.' : `${faults.length} active fault(s):`,
    ...faults.map((f) => `  ${f.codeHex}  [${hmsLevelLabel(f.level)}]  ${f.text}`),
  ];
  return lines.join('\n');
}

function FaultRow({ fault }: { fault: HmsFault }) {
  const tone = levelTone(fault.level);
  return (
    <Flex
      gap="12px"
      align="flex-start"
      px="16px"
      py="11px"
      borderBottomWidth="1px"
      borderColor="border"
      _last={{ borderBottomWidth: 0 }}
    >
      <Box mt="2px" flexShrink={0}>
        <Chip tone={tone}>{hmsLevelLabel(fault.level)}</Chip>
      </Box>
      <Box minW="0" flex="1">
        <Text className="selectable" fontSize="13px">
          {fault.text}
        </Text>
        <Text mt="2px" fontFamily="mono" fontSize="11px" color="fg.subtle">
          {fault.codeHex}
          {fault.module ? ` · ${fault.module}` : ''}
          {fault.sensorIndex > 0 ? ` · sensor ${fault.sensorIndex}` : ''}
          {fault.live ? ' · live' : ''}
        </Text>
      </Box>
    </Flex>
  );
}

function HmsPanel({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const hms = drone.hms;
  const faults = hms?.faults ?? [];
  const { state: copyState, copy } = useCopy();
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<string | null>(null);

  const readHms = async (): Promise<void> => {
    setReading(true);
    setReadNote(null);
    try {
      const result = await window.drone.readHms();
      setReadNote(result.message);
    } catch (err) {
      setReadNote(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  };

  const clearHms = async (): Promise<void> => {
    setReadNote(null);
    await window.drone.clearHms();
  };

  return (
    <Box>
      <PageHeader
        title="HMS Reader"
        subtitle="Live Health-Management-System fault codes the aircraft reports over USB."
        actions={
          <Flex gap="8px">
            <Btn variant="primary" disabled={!connected || reading} onClick={() => void readHms()}>
              {reading ? 'Reading…' : 'Read HMS'}
            </Btn>
            <Btn disabled={!connected || reading || faults.length === 0} onClick={() => void clearHms()}>
              Clear
            </Btn>
            <Btn
              onClick={() => copy(buildReport(drone))}
              disabled={!hms}
              icon={copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
            >
              {copyState === 'copied' ? 'Copied' : 'Copy report'}
            </Btn>
          </Flex>
        }
      />

      {connected && readNote && (
        <Text fontSize="12px" color="fg.muted" mb="10px">
          Last read: {readNote}
        </Text>
      )}

      {!connected && (
        <Panel px="18px" py="22px">
          <Text color="fg.subtle">Connect an aircraft to read its fault codes.</Text>
        </Panel>
      )}

      {connected && !hms && (
        <Panel px="18px" py="22px">
          <Flex align="center" gap="10px">
            <Chip tone="accent" pulse>
              Listening
            </Chip>
            <Text color="fg.muted">Waiting for the aircraft to report its health status…</Text>
          </Flex>
        </Panel>
      )}

      {connected && hms && (
        <>
          <Flex align="center" gap="10px" mb="12px">
            <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
              {faults.length === 0 ? 'No active faults' : `${faults.length} active fault${faults.length === 1 ? '' : 's'}`}
            </chakra.h2>
            <Text fontFamily="mono" fontSize="11.5px" color="fg.subtle">
              updated {formatTime(hms.updatedAt)}
            </Text>
          </Flex>
          {faults.length === 0 ? (
            <Panel px="18px" py="22px">
              <Flex align="center" gap="10px" color="ok">
                <CheckIcon size={16} />
                <Text color="fg">The aircraft reports no active faults.</Text>
              </Flex>
            </Panel>
          ) : (
            <Panel overflow="hidden">
              {faults.map((fault) => (
                <FaultRow key={`${fault.codeHex}-${fault.sensorIndex}`} fault={fault} />
              ))}
            </Panel>
          )}
          <Flex gap="18px" mt="14px" fontSize="11.5px" color="fg.subtle" wrap="wrap">
            <Overline>Levels</Overline>
            <Flex align="center" gap="6px">
              <Box w="7px" h="7px" borderRadius="full" bg="accent" /> Notice
            </Flex>
            <Flex align="center" gap="6px">
              <Box w="7px" h="7px" borderRadius="full" bg="warn" /> Caution
            </Flex>
            <Flex align="center" gap="6px">
              <Box w="7px" h="7px" borderRadius="full" bg="danger" /> Warning / Serious
            </Flex>
          </Flex>
        </>
      )}
    </Box>
  );
}

export default HmsPanel;
