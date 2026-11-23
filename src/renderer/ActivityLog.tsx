import { useEffect, useRef } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import { CheckIcon, CopyIcon, TrashIcon } from './icons';
import { IconBtn, useCopy } from './ui';
import type { LogEntry, LogLevel } from './useActivityLog';

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: 'border.strong',
  ok: 'ok',
  warn: 'warn',
  error: 'danger',
};

const formatTime = (at: number): string =>
  new Date(at).toLocaleTimeString('en-GB', { hour12: false });

const toText = (entries: LogEntry[]): string =>
  entries
    .map(
      (entry) =>
        `${formatTime(entry.at)}  ${entry.text}${entry.detail ? `  (${entry.detail})` : ''}`,
    )
    .join('\n');

function ActivityLog({ entries, onClear }: { entries: LogEntry[]; onClear: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  // Follow new lines only while the reader is already at the bottom.
  const pinned = useRef(true);
  const { state: copyState, copy } = useCopy();

  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries]);

  return (
    <Flex
      as="aside"
      aria-label="Activity log"
      direction="column"
      w="320px"
      flexShrink={0}
      bg="bg.chrome"
      borderLeftWidth="1px"
      borderColor="border"
    >
      <Flex
        align="center"
        gap="8px"
        h="46px"
        pl="16px"
        pr="10px"
        flexShrink={0}
        borderBottomWidth="1px"
        borderColor="border"
      >
        <chakra.h2 fontFamily="heading" fontSize="13.5px" fontWeight="600">
          Activity
        </chakra.h2>
        <Text fontFamily="mono" fontSize="11.5px" color="fg.subtle" flex="1">
          {entries.length}
        </Text>
        <IconBtn
          label={copyState === 'failed' ? 'Copy failed' : 'Copy log'}
          onClick={() => copy(toText(entries))}
          disabled={entries.length === 0}
        >
          {copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
        </IconBtn>
        <IconBtn label="Clear log" onClick={onClear} disabled={entries.length === 0}>
          <TrashIcon />
        </IconBtn>
      </Flex>

      <Box
        ref={scroller}
        flex="1"
        minH="0"
        overflowY="auto"
        py="8px"
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {entries.length === 0 && (
          <Text px="16px" py="10px" color="fg.subtle">
            Log cleared. New events show up here as they happen.
          </Text>
        )}
        {entries.map((entry) => (
          <Flex key={entry.id} className="selectable" gap="10px" px="16px" py="5px">
            <Text
              fontFamily="mono"
              fontSize="11px"
              lineHeight="19px"
              color="fg.subtle"
              flexShrink={0}
            >
              {formatTime(entry.at)}
            </Text>
            <Box w="2px" borderRadius="full" bg={LEVEL_COLOR[entry.level]} flexShrink={0} />
            <Box minW="0">
              <Text
                fontSize="12.5px"
                lineHeight="19px"
                color={entry.level === 'error' ? 'danger' : 'fg'}
                wordBreak="break-word"
              >
                {entry.text}
              </Text>
              {entry.detail && (
                <Text
                  fontFamily="mono"
                  fontSize="11px"
                  color="fg.subtle"
                  wordBreak="break-word"
                >
                  {entry.detail}
                </Text>
              )}
            </Box>
          </Flex>
        ))}
      </Box>
    </Flex>
  );
}

export default ActivityLog;
