import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend build for the Tauri shell. The Electron build keeps using
// vite.renderer.config.ts via electron-forge; this one outputs to dist/.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', target: 'esnext', emptyOutDir: true },
});
