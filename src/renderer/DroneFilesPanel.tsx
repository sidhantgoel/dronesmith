import { useEffect, useRef, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { FtpDownloadProgress, FtpEntry } from '../types';
import { FileIcon, PartitionIcon } from './icons';
import { Btn, Chip, PageHeader, Panel } from './ui';

/** Directories DJI drones commonly expose, offered as shortcuts (kept in step with droneFtp.ts). */
const SUGGESTED_PATHS = ['/', '/blackbox', '/blackbox/system', '/blackbox/camera'];

function bytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
}

const join = (dir: string, name: string): string => `${dir === '/' ? '' : dir}/${name}`;

function parentOf(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
}

function DroneFilesPanel() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [who, setWho] = useState<string | null>(null);
  const [dir, setDir] = useState('/');
  const [entries, setEntries] = useState<FtpEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<FtpDownloadProgress | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [host, setHost] = useState('192.168.42.2');
  const connectedRef = useRef(false);
  connectedRef.current = connected;

  useEffect(() => {
    const off = window.droneFs.onProgress(setProgress);
    return () => {
      off();
      if (connectedRef.current) {
        void window.droneFs.disconnect();
      }
    };
  }, []);

  const browse = async (target: string): Promise<void> => {
    const listed = await window.droneFs.list(target);
    if (!listed.ok || !listed.entries) {
      setNote({ ok: false, text: listed.message ?? 'The folder could not be listed.' });
      return;
    }
    setDir(listed.path ?? target);
    setEntries(listed.entries);
  };

  const connect = async (): Promise<void> => {
    setConnecting(true);
    setNote(null);
    try {
      const result = await window.droneFs.connect({ host: host.trim() || undefined });
      if (result.ok) {
        setConnected(true);
        setWho(result.user ?? null);
        await browse('/');
      } else {
        setConnected(false);
        setNote({ ok: false, text: result.message });
      }
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    await window.droneFs.disconnect();
    setConnected(false);
    setWho(null);
    setEntries([]);
    setDir('/');
  };

  const open = async (entry: FtpEntry): Promise<void> => {
    if (entry.type === 'dir' || entry.type === 'link') {
      await browse(join(dir, entry.name));
    }
  };

  const download = async (entry: FtpEntry): Promise<void> => {
    setBusy(true);
    setNote(null);
    setProgress(null);
    try {
      const result = await window.droneFs.download(dir, entry.name);
      if (result.message) {
        setNote({ ok: result.ok, text: result.message });
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const crumbs = dir.split('/').filter(Boolean);

  return (
    <Box>
      <PageHeader
        title="Drone files"
        subtitle="Reads files from the aircraft over its USB network link (flight logs, blackbox, config). Read-only; it does not change anything on the drone."
        actions={
          connected ? (
            <Btn onClick={() => void disconnect()}>Disconnect</Btn>
          ) : (
            <Btn variant="primary" disabled={connecting} onClick={() => void connect()}>
              {connecting ? 'Connecting…' : 'Connect'}
            </Btn>
          )
        }
      />

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

      {!connected && (
        <Panel px="18px" py="16px">
          <Text fontSize="12.5px" color="fg.muted" mb="12px">
            The drone must be switched on and showing on this computer as a USB network device (the host
            gets 192.168.42.1). This reads the drone&apos;s exposed files; it is not a raw block-partition
            dump. Any image file you pull can be opened on the Partition images page.
          </Text>
          <Flex gap="10px" align="flex-end" wrap="wrap">
            <chakra.label display="block">
              <Text fontSize="11.5px" color="fg.muted" mb="4px">
                Drone address
              </Text>
              <chakra.input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                spellCheck={false}
                h="30px"
                px="10px"
                w="180px"
                fontFamily="mono"
                fontSize="12.5px"
                bg="bg.raised"
                borderWidth="1px"
                borderColor="border.strong"
                borderRadius="7px"
                color="fg"
                _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
              />
            </chakra.label>
            <Text fontSize="11.5px" color="fg.subtle">
              Signs in as dji_ftp, then anonymous.
            </Text>
          </Flex>
        </Panel>
      )}

      {connected && (
        <Panel px="18px" pt="14px" pb="10px">
          <Flex align="center" gap="8px" wrap="wrap" mb="10px">
            <Flex align="center" gap="4px" flex="1" minW="200px" wrap="wrap" fontFamily="mono" fontSize="12.5px">
              <chakra.button type="button" onClick={() => void browse('/')} cursor="pointer" color="accent">
                /
              </chakra.button>
              {crumbs.map((part, index) => (
                <Flex key={`${part}-${index}`} align="center" gap="4px">
                  <chakra.button
                    type="button"
                    onClick={() => void browse(`/${crumbs.slice(0, index + 1).join('/')}`)}
                    cursor="pointer"
                    color={index === crumbs.length - 1 ? 'fg' : 'accent'}
                  >
                    {part}
                  </chakra.button>
                  <Text color="fg.subtle">/</Text>
                </Flex>
              ))}
            </Flex>
            {who && <Chip tone="ok">{who}</Chip>}
            <Btn disabled={dir === '/' || busy} onClick={() => void browse(parentOf(dir))}>
              Up
            </Btn>
            <Btn disabled={busy} onClick={() => void browse(dir)}>
              Refresh
            </Btn>
          </Flex>

          <Flex gap="6px" wrap="wrap" mb="10px">
            {SUGGESTED_PATHS.map((suggested) => (
              <chakra.button
                key={suggested}
                type="button"
                onClick={() => void browse(suggested)}
                h="24px"
                px="9px"
                borderRadius="full"
                borderWidth="1px"
                borderColor={dir === suggested ? 'accent' : 'border.strong'}
                color={dir === suggested ? 'fg' : 'fg.muted'}
                fontFamily="mono"
                fontSize="11.5px"
                cursor="pointer"
                _hover={{ color: 'fg' }}
                _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
              >
                {suggested}
              </chakra.button>
            ))}
          </Flex>

          {busy && progress && (
            <Text fontFamily="mono" fontSize="12px" color="fg.muted" mb="8px">
              Downloading {progress.name} · {bytes(progress.bytes)}
              {progress.total > 0 ? ` of ${bytes(progress.total)} (${Math.round((progress.bytes / progress.total) * 100)} %)` : ''}
            </Text>
          )}

          <Box maxH="440px" overflowY="auto" borderTopWidth="1px" borderColor="border">
            {entries.length === 0 && (
              <Text color="fg.subtle" py="12px">
                This folder is empty, or the drone did not list it.
              </Text>
            )}
            {entries.map((entry) => (
              <Flex
                key={`${entry.name}-${entry.size}`}
                align="center"
                gap="10px"
                py="5px"
                px="6px"
                borderBottomWidth="1px"
                borderColor="border"
                _hover={{ bg: 'bg.hover' }}
              >
                <Box color={entry.type === 'dir' ? 'accent' : 'fg.subtle'} display="flex">
                  {entry.type === 'dir' ? <PartitionIcon size={14} /> : <FileIcon size={14} />}
                </Box>
                {entry.type === 'dir' || entry.type === 'link' ? (
                  <chakra.button
                    type="button"
                    onClick={() => void open(entry)}
                    flex="1"
                    minW="0"
                    textAlign="left"
                    fontSize="13px"
                    cursor="pointer"
                    color="fg"
                    _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '-2px' }}
                  >
                    <chakra.span truncate display="block">
                      {entry.name}
                      {entry.type === 'link' && entry.target ? ` → ${entry.target}` : ''}
                    </chakra.span>
                  </chakra.button>
                ) : (
                  <Text flex="1" minW="0" fontSize="13px" truncate>
                    {entry.name}
                  </Text>
                )}
                <Text fontFamily="mono" fontSize="11.5px" color="fg.subtle" flexShrink={0}>
                  {entry.modified}
                </Text>
                <Text fontFamily="mono" fontSize="11.5px" color="fg.muted" w="74px" textAlign="right" flexShrink={0}>
                  {entry.type === 'dir' ? '' : bytes(entry.size)}
                </Text>
                <Box w="92px" flexShrink={0} textAlign="right">
                  {entry.type === 'file' && (
                    <Btn disabled={busy} onClick={() => void download(entry)}>
                      Download
                    </Btn>
                  )}
                </Box>
              </Flex>
            ))}
          </Box>
        </Panel>
      )}
    </Box>
  );
}

export default DroneFilesPanel;
