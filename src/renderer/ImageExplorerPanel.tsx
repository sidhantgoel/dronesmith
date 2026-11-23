import { useEffect, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { FsEntry, FsStats, ImageExtractProgress, ImagePreview, PartitionCandidate } from '../types';
import { modeString } from '../ext4';
import { AlertIcon, FileIcon, PartitionIcon } from './icons';
import { Btn, Chip, PageHeader, Panel } from './ui';

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

const when = (seconds: number): string => (seconds > 0 ? new Date(seconds * 1000).toLocaleDateString() : '—');

const join = (folder: string, name: string): string => `${folder === '/' ? '' : folder}/${name}`;

function parentOf(folder: string): string {
  const parts = folder.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
}

function ImageExplorerPanel() {
  const [file, setFile] = useState<{ path: string; size: number } | null>(null);
  const [partitions, setPartitions] = useState<PartitionCandidate[]>([]);
  const [mounted, setMounted] = useState<number | null>(null);
  const [stats, setStats] = useState<FsStats | null>(null);
  const [folder, setFolder] = useState('/');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<FsEntry | null>(null);
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImageExtractProgress | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const off = window.imageTool.onProgress(setProgress);
    return () => {
      off();
      void window.imageTool.close();
    };
  }, []);

  const browse = async (target: string): Promise<void> => {
    const listed = await window.imageTool.list(target);
    if (!listed.ok || !listed.entries) {
      setNote({ ok: false, text: listed.message ?? 'The folder could not be read.' });
      return;
    }
    setFolder(target);
    setEntries(listed.entries);
    setSelected(null);
    setPreview(null);
  };

  const mount = async (partition: PartitionCandidate): Promise<void> => {
    setNote(null);
    const result = await window.imageTool.mount(partition.offset);
    if (!result.ok || !result.stats) {
      setMounted(null);
      setStats(null);
      setNote({ ok: false, text: result.message ?? 'The filesystem could not be opened.' });
      return;
    }
    setMounted(partition.offset);
    setStats(result.stats);
    await browse('/');
  };

  const openImage = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await window.imageTool.open();
      if (!result.ok || !result.path) {
        if (result.message) {
          setNote({ ok: false, text: result.message });
        }
        return;
      }
      const found = result.partitions ?? [];
      setFile({ path: result.path, size: result.size ?? 0 });
      setPartitions(found);
      setMounted(null);
      setStats(null);
      setEntries([]);
      setSelected(null);
      setPreview(null);
      const first = found.find((partition) => partition.ext);
      if (first) {
        await mount(first);
      } else {
        setNote({ ok: false, text: 'No ext filesystem was found in this file.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const select = async (entry: FsEntry): Promise<void> => {
    if (entry.type === 'dir') {
      await browse(join(folder, entry.name));
      return;
    }
    setSelected(entry);
    setPreview(entry.type === 'file' && !entry.inline ? await window.imageTool.preview(join(folder, entry.name)) : null);
  };

  const extract = async (remote: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    setProgress(null);
    try {
      const result = await window.imageTool.extract(remote);
      if (result.message) {
        setNote({ ok: result.ok, text: result.message });
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const crumbs = folder.split('/').filter(Boolean);

  return (
    <Box>
      <PageHeader
        title="Partition images"
        subtitle="Opens a partition dump file and browses the ext filesystem inside it. The file is only read, never changed."
        actions={
          <Btn variant="primary" disabled={busy} onClick={() => void openImage()}>
            {file ? 'Open another image' : 'Open image'}
          </Btn>
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

      {!file && (
        <Box px="18px" py="22px" borderRadius="12px" borderWidth="1px" borderStyle="dashed" borderColor="border.strong">
          <Text color="fg.subtle">
            No image is open. Dumps of calibration, factory and similar partitions work, with or
            without a partition table.
          </Text>
        </Box>
      )}

      {file && (
        <Panel px="18px" py="14px" mb="14px">
          <Text className="selectable" fontFamily="mono" fontSize="12px" color="fg.muted" wordBreak="break-all">
            {file.path} · {bytes(file.size)}
          </Text>
          <Flex gap="8px" wrap="wrap" mt="10px">
            {partitions.map((partition) => {
              const active = partition.offset === mounted;
              return (
                <chakra.button
                  key={partition.offset}
                  type="button"
                  disabled={!partition.ext || busy}
                  aria-pressed={active}
                  onClick={() => void mount(partition)}
                  display="flex"
                  alignItems="center"
                  gap="7px"
                  h="30px"
                  px="11px"
                  borderRadius="8px"
                  borderWidth="1px"
                  borderColor={active ? 'accent' : 'border.strong'}
                  color={partition.ext ? 'fg' : 'fg.subtle'}
                  fontSize="12.5px"
                  cursor="pointer"
                  _disabled={{ cursor: 'not-allowed' }}
                  _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
                >
                  <PartitionIcon size={14} />
                  {partition.volumeName || partition.label}
                  {!partition.ext && ' (not ext)'}
                </chakra.button>
              );
            })}
          </Flex>
          {stats && (
            <Flex gap="8px" wrap="wrap" mt="10px">
              <Chip tone="neutral">{bytes(stats.totalBytes)} total</Chip>
              <Chip tone="neutral">{bytes(stats.freeBytes)} free</Chip>
              <Chip tone="neutral">{stats.blockSize} B blocks</Chip>
              {stats.lastMounted && <Chip tone="neutral">Last mounted at {stats.lastMounted}</Chip>}
            </Flex>
          )}
        </Panel>
      )}

      {mounted !== null && (
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
            <Btn disabled={folder === '/' || busy} onClick={() => void browse(parentOf(folder))}>
              Up
            </Btn>
            <Btn disabled={busy} onClick={() => void extract(folder)}>
              Extract this folder
            </Btn>
          </Flex>

          {busy && progress && (
            <Text fontFamily="mono" fontSize="12px" color="fg.muted" mb="8px">
              Extracting {progress.name} · {progress.files} files · {bytes(progress.bytes)}
            </Text>
          )}

          <Box maxH="380px" overflowY="auto" borderTopWidth="1px" borderColor="border">
            {entries.length === 0 && (
              <Text color="fg.subtle" py="12px">
                This folder is empty.
              </Text>
            )}
            {entries.map((entry) => {
              const active = selected?.inode === entry.inode && selected.name === entry.name;
              return (
                <chakra.button
                  key={`${entry.inode}-${entry.name}`}
                  type="button"
                  onClick={() => void select(entry)}
                  display="flex"
                  alignItems="center"
                  gap="10px"
                  w="full"
                  py="5px"
                  px="6px"
                  textAlign="left"
                  borderBottomWidth="1px"
                  borderColor="border"
                  bg={active ? 'bg.raised' : 'transparent'}
                  cursor="pointer"
                  _hover={{ bg: 'bg.hover' }}
                  _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '-2px' }}
                >
                  <Box color={entry.type === 'dir' ? 'accent' : 'fg.subtle'} display="flex">
                    {entry.type === 'dir' ? <PartitionIcon size={14} /> : <FileIcon size={14} />}
                  </Box>
                  <Text flex="1" minW="0" fontSize="13px" truncate>
                    {entry.name}
                    {entry.type === 'link' && entry.target ? ` → ${entry.target}` : ''}
                  </Text>
                  <Text fontFamily="mono" fontSize="11.5px" color="fg.subtle" flexShrink={0}>
                    {modeString(entry.mode)}
                  </Text>
                  <Text fontFamily="mono" fontSize="11.5px" color="fg.muted" w="74px" textAlign="right" flexShrink={0}>
                    {entry.type === 'dir' ? '' : bytes(entry.size)}
                  </Text>
                  <Text fontFamily="mono" fontSize="11.5px" color="fg.subtle" w="84px" textAlign="right" flexShrink={0}>
                    {when(entry.modified)}
                  </Text>
                </chakra.button>
              );
            })}
          </Box>
        </Panel>
      )}

      {selected && (
        <Panel px="18px" py="14px" mt="14px">
          <Flex align="center" gap="10px" wrap="wrap" mb="10px">
            <chakra.h2 className="selectable" fontFamily="heading" fontSize="15px" fontWeight="600" flex="1" minW="0">
              {selected.name}
            </chakra.h2>
            <Text fontFamily="mono" fontSize="12px" color="fg.subtle">
              {bytes(selected.size)}
            </Text>
            <Btn
              variant="primary"
              disabled={busy || selected.type !== 'file' || selected.inline === true}
              onClick={() => void extract(join(folder, selected.name))}
            >
              Extract file
            </Btn>
          </Flex>
          {selected.inline && (
            <Flex align="center" gap="8px" color="warn">
              <AlertIcon size={15} />
              <Text fontSize="12.5px">This file is stored inside its record and cannot be read here.</Text>
            </Flex>
          )}
          {selected.type === 'link' && <Text fontSize="12.5px">Link to {selected.target ?? 'an unreadable target'}.</Text>}
          {preview && !preview.ok && <Text fontSize="12.5px">{preview.message}</Text>}
          {preview?.ok && (
            <>
              <chakra.pre
                className="selectable"
                maxH="320px"
                overflow="auto"
                p="10px 12px"
                borderRadius="8px"
                bg="bg.raised"
                fontFamily="mono"
                fontSize="11.5px"
                whiteSpace="pre"
              >
                {preview.text ?? preview.hex ?? ''}
              </chakra.pre>
              {preview.truncated && (
                <Text fontSize="12px" color="fg.subtle" mt="6px">
                  Only the start of the file is shown. Extract it to see the rest.
                </Text>
              )}
            </>
          )}
        </Panel>
      )}
    </Box>
  );
}

export default ImageExplorerPanel;
