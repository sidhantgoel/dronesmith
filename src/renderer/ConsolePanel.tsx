import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { ConsoleFrame, ConsoleReply, DroneState } from '../types';
import {
  CONSOLE_ACKS,
  CONSOLE_KEEP_FRAMES,
  CONSOLE_RECEIVERS,
  CONSOLE_SENDERS,
  hexByte,
  hexBytes,
  parseHexByte,
  parseHexBytes,
} from '../consoleCmd';
import { AlertIcon } from './icons';
import { Btn, Chip, PageHeader, Panel } from './ui';

const FIELD = {
  h: '30px',
  px: '9px',
  fontFamily: 'mono',
  fontSize: '12.5px',
  bg: 'bg.raised',
  borderWidth: '1px',
  borderRadius: '7px',
  color: 'fg',
  _focusVisible: { outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' },
} as const;

function Field({
  label,
  value,
  onChange,
  invalid,
  width,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  width: string;
  placeholder?: string;
}) {
  return (
    <chakra.label display="block" flex={width === 'full' ? '1 1 260px' : '0 0 auto'}>
      <Text fontSize="11.5px" color="fg.muted" mb="4px">
        {label}
      </Text>
      <chakra.input
        {...FIELD}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        w={width}
        borderColor={invalid ? 'danger' : 'border.strong'}
      />
    </chakra.label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: readonly { value: number; label: string }[];
  onChange: (value: number) => void;
}) {
  return (
    <chakra.label display="block">
      <Text fontSize="11.5px" color="fg.muted" mb="4px">
        {label}
      </Text>
      <chakra.select
        {...FIELD}
        fontFamily="body"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        borderColor="border.strong"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </chakra.select>
    </chakra.label>
  );
}

const clock = (at: number): string => {
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

function ConsolePanel({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const [sender, setSender] = useState(CONSOLE_SENDERS[0].value);
  const [ackEnc, setAckEnc] = useState(CONSOLE_ACKS[0].value);
  const [receiver, setReceiver] = useState('03');
  const [cmdSet, setCmdSet] = useState('00');
  const [cmdId, setCmdId] = useState('01');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ConsoleReply | null>(null);

  const [watching, setWatching] = useState(true);
  const [frames, setFrames] = useState<ConsoleFrame[]>([]);
  const [filterSet, setFilterSet] = useState('');
  const [filterId, setFilterId] = useState('');
  const watchingRef = useRef(true);
  watchingRef.current = watching;

  useEffect(() => {
    const off = window.drone.onConsoleFrames((incoming) => {
      if (watchingRef.current) {
        setFrames((current) => [...current, ...incoming].slice(-CONSOLE_KEEP_FRAMES));
      }
    });
    return () => {
      off();
      void window.drone.consoleWatch(false);
    };
  }, []);

  useEffect(() => {
    void window.drone.consoleWatch(watching && connected);
  }, [watching, connected]);

  const receiverByte = parseHexByte(receiver);
  const setByte = parseHexByte(cmdSet);
  const idByte = parseHexByte(cmdId);
  const payloadBytes = parseHexBytes(payload);
  const valid = receiverByte !== null && setByte !== null && idByte !== null && payloadBytes !== null;

  const send = async (): Promise<void> => {
    if (receiverByte === null || setByte === null || idByte === null || payloadBytes === null) {
      return;
    }
    setBusy(true);
    setReply(null);
    try {
      setReply(
        await window.drone.consoleSend({
          sender,
          receiver: receiverByte,
          cmdSet: setByte,
          cmdId: idByte,
          ackEnc,
          payload: payloadBytes,
        }),
      );
    } catch (error) {
      setReply({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const wantSet = filterSet.trim() === '' ? undefined : parseHexByte(filterSet);
  const wantId = filterId.trim() === '' ? undefined : parseHexByte(filterId);
  const shown = useMemo(
    () =>
      frames
        .filter(
          (frame) =>
            (wantSet === undefined || wantSet === null || frame.cmdSet === wantSet) &&
            (wantId === undefined || wantId === null || frame.cmdId === wantId),
        )
        .slice(-200)
        .reverse(),
    [frames, wantSet, wantId],
  );

  return (
    <Box>
      <PageHeader
        title="Command console"
        subtitle="Sends one hand-built command to a module and lists the frames the aircraft sends. For protocol work."
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="14px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to use the console.</Text>
        </Flex>
      )}

      <Panel px="18px" py="14px" mb="14px" borderColor="border">
        <Flex align="flex-start" gap="8px" color="warn" mb="14px">
          <Box mt="2px" flexShrink={0}>
            <AlertIcon size={15} />
          </Box>
          <Text fontSize="12.5px">
            A command is sent exactly as written, with no checks. A wrong one can change settings,
            start a motor or leave a module needing a firmware reload.
          </Text>
        </Flex>

        <Flex gap="12px" wrap="wrap" align="flex-end">
          <Select label="Sent as" value={sender} options={CONSOLE_SENDERS} onChange={setSender} />
          <Field label="Receiver" value={receiver} onChange={setReceiver} invalid={receiverByte === null} width="70px" />
          <Field label="Command set" value={cmdSet} onChange={setCmdSet} invalid={setByte === null} width="70px" />
          <Field label="Command id" value={cmdId} onChange={setCmdId} invalid={idByte === null} width="70px" />
          <Select label="Acknowledge" value={ackEnc} options={CONSOLE_ACKS} onChange={setAckEnc} />
        </Flex>

        <Flex gap="6px" wrap="wrap" mt="10px">
          {CONSOLE_RECEIVERS.map((entry) => (
            <chakra.button
              key={entry.value}
              type="button"
              onClick={() => setReceiver(hexByte(entry.value))}
              h="24px"
              px="9px"
              borderRadius="full"
              borderWidth="1px"
              borderColor={receiverByte === entry.value ? 'accent' : 'border.strong'}
              color={receiverByte === entry.value ? 'fg' : 'fg.muted'}
              fontSize="11.5px"
              cursor="pointer"
              _hover={{ color: 'fg' }}
              _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
            >
              {entry.label}
            </chakra.button>
          ))}
        </Flex>

        <Flex gap="12px" wrap="wrap" align="flex-end" mt="12px">
          <Field
            label="Payload (hex bytes)"
            value={payload}
            onChange={setPayload}
            invalid={payloadBytes === null}
            width="full"
            placeholder="empty"
          />
          <Btn variant="primary" disabled={!connected || busy || !valid} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send'}
          </Btn>
        </Flex>

        {reply && (
          <Box
            mt="14px"
            p="10px 12px"
            borderRadius="8px"
            bg={reply.ok ? 'bg.raised' : 'danger.soft'}
            borderLeftWidth="2px"
            borderColor={reply.ok ? 'ok' : 'danger'}
          >
            <Text fontSize="12.5px">
              {reply.message}
              {reply.ms !== undefined ? ` ${reply.ms} ms.` : ''}
            </Text>
            {reply.reply && reply.reply.length > 0 && (
              <Text className="selectable" fontFamily="mono" fontSize="12px" mt="6px" wordBreak="break-all">
                {hexBytes(reply.reply)}
              </Text>
            )}
          </Box>
        )}
      </Panel>

      <Panel px="18px" pt="14px" pb="10px">
        <Flex align="flex-end" gap="12px" wrap="wrap" mb="10px">
          <Box flex="1" minW="160px">
            <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
              Received frames
            </chakra.h2>
            <Text fontSize="12px" color="fg.subtle">
              Newest first, last {shown.length} shown.
            </Text>
          </Box>
          <Field label="Only set" value={filterSet} onChange={setFilterSet} invalid={wantSet === null} width="64px" placeholder="any" />
          <Field label="Only id" value={filterId} onChange={setFilterId} invalid={wantId === null} width="64px" placeholder="any" />
          <Chip tone={watching && connected ? 'accent' : 'neutral'} pulse={watching && connected}>
            {watching ? 'Listening' : 'Paused'}
          </Chip>
          <Btn onClick={() => setWatching((on) => !on)}>{watching ? 'Pause' : 'Resume'}</Btn>
          <Btn disabled={frames.length === 0} onClick={() => setFrames([])}>
            Clear
          </Btn>
        </Flex>

        <Box maxH="420px" overflowY="auto" borderTopWidth="1px" borderColor="border">
          {shown.length === 0 && (
            <Text color="fg.subtle" py="12px">
              No frames yet.
            </Text>
          )}
          {shown.map((frame, index) => (
            <Flex
              key={`${frame.at}-${index}`}
              className="selectable"
              gap="10px"
              py="4px"
              fontFamily="mono"
              fontSize="11.5px"
              borderBottomWidth="1px"
              borderColor="border"
            >
              <Text color="fg.subtle" flexShrink={0}>
                {clock(frame.at)}
              </Text>
              <Text flexShrink={0}>
                {hexByte(frame.from)}→{hexByte(frame.to)}
              </Text>
              <Text flexShrink={0} color={frame.ack ? 'ok' : 'fg'}>
                {hexByte(frame.cmdSet)}/{hexByte(frame.cmdId)}
                {frame.ack ? ' ack' : ''}
              </Text>
              <Text color="fg.subtle" flexShrink={0}>
                {frame.length} B
              </Text>
              <Text color="fg.muted" truncate>
                {frame.hex}
              </Text>
            </Flex>
          ))}
        </Box>
      </Panel>
    </Box>
  );
}

export default ConsolePanel;
