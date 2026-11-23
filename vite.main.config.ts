import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Native modules cannot be bundled; they must be loaded from
      // node_modules at runtime.
      external: ['koffi'],
    },
  },
});
