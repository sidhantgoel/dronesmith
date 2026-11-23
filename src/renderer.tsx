// Installs the Tauri compatibility bridge before anything touches window.drone.
// Inert under Electron (the preload already provides these globals).
import './renderer/tauriBridge';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider } from '@chakra-ui/react';
import App from './renderer/App';
import { system } from './renderer/theme';
import { initColorMode } from './renderer/colorMode';
import './index.css';

// Apply the remembered light/dark choice before the first paint.
initColorMode();

// Development aid: dump every packet received from the drone in the DevTools
// console. The main process only sends these in unpackaged builds.
window.drone.onPackets((lines) => {
  for (const line of lines) {
    console.log(`%cDUML rx%c ${line}`, 'color: #5ab0ff; font-weight: 600', '');
  }
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

createRoot(root).render(
  <React.StrictMode>
    <ChakraProvider value={system}>
      <App />
    </ChakraProvider>
  </React.StrictMode>,
);
