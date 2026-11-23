import { Box, Flex, Text } from '@chakra-ui/react';
import type { FirmwareManifest } from '../types';
import { Overline, Panel } from './ui';

const manifestBytes = (n?: number): string => {
  if (n == null) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

function Stat({ label, value, dim = false }: { label: string; value: string; dim?: boolean }) {
  return (
    <Box>
      <Overline>{label}</Overline>
      <Text className="selectable" mt="4px" fontFamily="mono" fontSize="13px" color={dim ? 'fg.subtle' : 'fg'}>
        {value}
      </Text>
    </Box>
  );
}

/**
 * The aircraft's installed firmware manifest: formal version, anti-rollback
 * level, validity dates and the module list. The module list scrolls within a
 * fixed height so the card never grows unbounded.
 */
function ManifestCard({ manifest }: { manifest: FirmwareManifest }) {
  return (
    <Panel px="18px" py="16px">
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap="18px">
        <Stat label="Formal version" value={manifest.formalVersion ?? '—'} dim={!manifest.formalVersion} />
        <Stat
          label="Anti-rollback"
          value={manifest.antiRollback != null ? String(manifest.antiRollback) : '—'}
          dim={manifest.antiRollback == null}
        />
        <Stat label="Built" value={manifest.from ?? '—'} dim={!manifest.from} />
        <Stat label="Valid until" value={manifest.expire ?? '—'} dim={!manifest.expire} />
      </Box>

      {manifest.modules.length > 0 && (
        <Box mt="16px" pt="14px" borderTopWidth="1px" borderColor="border">
          <Overline>Modules in this firmware ({manifest.modules.length})</Overline>
          <Box mt="8px" maxH="200px" overflowY="auto">
            {manifest.modules.map((module, index) => (
              <Flex
                key={`${module.id}-${module.name}`}
                justify="space-between"
                gap="12px"
                py="6px"
                borderBottomWidth={index === manifest.modules.length - 1 ? '0' : '1px'}
                borderColor="border"
                fontSize="12.5px"
              >
                <Text minW="0" truncate>
                  {module.name}
                  <Text as="span" fontFamily="mono" fontSize="11px" color="fg.subtle">
                    {'  '}
                    {module.id}
                  </Text>
                </Text>
                <Flex gap="18px" flexShrink={0}>
                  <Text fontFamily="mono" color="fg.muted">
                    {module.version}
                  </Text>
                  <Text fontFamily="mono" color="fg.subtle" w="64px" textAlign="right">
                    {manifestBytes(module.size)}
                  </Text>
                </Flex>
              </Flex>
            ))}
          </Box>
        </Box>
      )}
    </Panel>
  );
}

export default ManifestCard;
