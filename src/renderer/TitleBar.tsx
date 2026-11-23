import { useSyncExternalStore } from 'react';
import { Flex, Text } from '@chakra-ui/react';
import { getColorMode, onColorModeChange, toggleColorMode } from './colorMode';
import { DroneIcon, MoonIcon, PanelRightIcon, SunIcon } from './icons';
import { IconBtn } from './ui';

/**
 * Replaces the native title bar (see `titleBarOverlay` in main.ts). The
 * system window buttons are drawn over the right end of this bar; the
 * `titlebar-area-*` variables say how much room they take.
 */
function TitleBar({ logOpen, onToggleLog }: { logOpen: boolean; onToggleLog: () => void }) {
  const mode = useSyncExternalStore(onColorModeChange, getColorMode);
  const dark = mode === 'dark';

  return (
    <Flex
      as="header"
      className="drag"
      align="center"
      gap="10px"
      h="40px"
      flexShrink={0}
      bg="bg.chrome"
      borderBottomWidth="1px"
      borderColor="border"
      pl="calc(env(titlebar-area-x, 0px) + 12px)"
      pr="calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 8px)"
    >
      <Flex
        align="center"
        justify="center"
        w="24px"
        h="24px"
        borderRadius="7px"
        bg="accent.soft"
        color="accent"
      >
        <DroneIcon size={15} />
      </Flex>
      <Text fontSize="12.5px" fontWeight="600" letterSpacing="0.01em" flex="1">
        Dronesmith
      </Text>
      <IconBtn
        className="no-drag"
        label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={toggleColorMode}
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </IconBtn>
      <IconBtn
        className="no-drag"
        label={logOpen ? 'Hide activity log' : 'Show activity log'}
        pressed={logOpen}
        onClick={onToggleLog}
      >
        <PanelRightIcon />
      </IconBtn>
    </Flex>
  );
}

export default TitleBar;
