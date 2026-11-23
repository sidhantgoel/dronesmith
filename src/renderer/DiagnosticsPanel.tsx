import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DiagnosticCheck, DroneState } from '../types';
import { diagnosticTotals, type CheckStatus } from '../diagnostics';
import { AlertIcon } from './icons';
import { Btn, Chip, PageHeader, Panel, StatusDot, type Tone } from './ui';
import type { DiagnosticsSession } from './useDiagnostics';

const STATUS_TONE: Record<CheckStatus, Tone> = { ok: 'ok', warn: 'warn', fail: 'danger', info: 'neutral' };
const STATUS_WORD: Record<CheckStatus, string> = { ok: 'OK', warn: 'Attention', fail: 'Fault', info: 'Info' };

function CheckRow({ check }: { check: DiagnosticCheck }) {
  return (
    <Flex align="flex-start" gap="10px" py="7px" borderTopWidth="1px" borderColor="border">
      <Box mt="5px">
        <StatusDot tone={STATUS_TONE[check.status]} />
      </Box>
      <Box flex="1" minW="0">
        <Text fontSize="13px" fontWeight="500">
          {check.name}
        </Text>
        <Text className="selectable" fontSize="12.5px" color="fg.muted">
          {check.detail}
        </Text>
      </Box>
      <Text fontSize="11.5px" fontWeight="600" color={check.status === 'info' ? 'fg.subtle' : STATUS_TONE[check.status]}>
        {STATUS_WORD[check.status]}
      </Text>
    </Flex>
  );
}

function Group({ title, checks }: { title: string; checks: DiagnosticCheck[] }) {
  return (
    <Panel px="18px" pt="14px" pb="8px">
      <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mb="8px">
        {title}
      </chakra.h2>
      {checks.map((check, index) => (
        <CheckRow key={`${check.name}-${index}`} check={check} />
      ))}
    </Panel>
  );
}

function DiagnosticsPanel({ drone, check }: { drone: DroneState; check: DiagnosticsSession }) {
  const connected = drone.status === 'connected';
  const { running, progress, report, note, run, setNote } = check;

  const save = async (): Promise<void> => {
    if (!report) {
      return;
    }
    const result = await window.drone.saveReport(report);
    if (result.ok) {
      setNote({ ok: true, text: `Report saved to ${result.path}` });
    } else if (result.message) {
      setNote({ ok: false, text: result.message });
    }
  };

  const totals = report ? diagnosticTotals(report.checks) : null;
  const groups: string[] = [];
  for (const check of report?.checks ?? []) {
    if (!groups.includes(check.group)) {
      groups.push(check.group);
    }
  }
  const percent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <Box>
      <PageHeader
        title="Full check"
        subtitle="Reads the fault codes, serial numbers, vision sensors, battery and radio links in one pass. Nothing on the aircraft is changed."
        actions={
          <Flex gap="8px">
            <Btn disabled={!report || running} onClick={() => void save()}>
              Save report
            </Btn>
            <Btn variant="primary" disabled={!connected || running} onClick={() => void run()}>
              {running ? 'Checking…' : report ? 'Run again' : 'Run full check'}
            </Btn>
          </Flex>
        }
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="14px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to run the check.</Text>
        </Flex>
      )}

      {running && progress && (
        <Panel px="18px" py="14px" mb="14px">
          <Flex align="center" justify="space-between" gap="12px" mb="8px">
            <Text fontSize="13px">{progress.label}</Text>
            <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
              {Math.min(progress.done + 1, progress.total)} of {progress.total}
            </Text>
          </Flex>
          <Box
            h="6px"
            borderRadius="full"
            bg="bg.raised"
            overflow="hidden"
            role="progressbar"
            aria-label="Check progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <Box h="full" w={`${percent}%`} borderRadius="full" bg="accent" transition="width 0.25s linear" />
          </Box>
        </Panel>
      )}

      {note && (
        <Box
          mb="14px"
          p="10px 12px"
          borderRadius="8px"
          bg={note.ok ? 'bg.raised' : 'danger.soft'}
          borderLeftWidth="2px"
          borderColor={note.ok ? 'ok' : 'danger'}
        >
          <Text className="selectable" fontSize="12.5px">
            {note.text}
          </Text>
        </Box>
      )}

      {report && totals ? (
        <>
          <Panel px="18px" py="14px" mb="14px">
            <Flex align="center" gap="10px" wrap="wrap">
              <Text fontSize="13px" flex="1" minW="200px">
                Checked {new Date(report.at).toLocaleString()}
              </Text>
              <Chip tone={totals.fail > 0 ? 'danger' : 'neutral'}>{totals.fail} fault</Chip>
              <Chip tone={totals.warn > 0 ? 'warn' : 'neutral'}>{totals.warn} attention</Chip>
              <Chip tone="ok">{totals.ok} OK</Chip>
            </Flex>
          </Panel>
          <Flex direction="column" gap="14px">
            {groups.map((group) => (
              <Group key={group} title={group} checks={report.checks.filter((check) => check.group === group)} />
            ))}
            <Panel px="18px" pt="14px" pb="10px">
              <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600" mb="8px">
                Modules
              </chakra.h2>
              {report.modules.length === 0 && <Text color="fg.subtle">No module has reported a version yet.</Text>}
              {report.modules.map((module) => (
                <Flex key={module.name} justify="space-between" gap="12px" py="5px" borderTopWidth="1px" borderColor="border">
                  <Text fontSize="13px">{module.name}</Text>
                  <Text className="selectable" fontFamily="mono" fontSize="12.5px" color="fg.muted">
                    {module.firmware || '—'}
                  </Text>
                </Flex>
              ))}
            </Panel>
          </Flex>
        </>
      ) : (
        !running && (
          <Box px="18px" py="22px" borderRadius="12px" borderWidth="1px" borderStyle="dashed" borderColor="border.strong">
            <Text color="fg.subtle">No check has run yet. It takes about twenty seconds.</Text>
          </Box>
        )
      )}
    </Box>
  );
}

export default DiagnosticsPanel;
