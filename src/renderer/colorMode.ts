/**
 * Light/dark mode. Dark is the `dark` class on <html> (which drives both the
 * Chakra `_dark` tokens and the `--af-*` CSS variables in index.css); light is
 * its absence. The choice is remembered per machine in localStorage.
 */
export type ColorMode = 'light' | 'dark';

const STORAGE_KEY = 'af-color-mode';
const listeners = new Set<(mode: ColorMode) => void>();

export function getColorMode(): ColorMode {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function setColorMode(mode: ColorMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  // Repaint the native Windows caption buttons to match.
  window.chromeUi?.setTitleBarTheme(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode or blocked storage: the choice simply is not remembered.
  }
  for (const listener of listeners) {
    listener(mode);
  }
}

export function toggleColorMode(): void {
  setColorMode(getColorMode() === 'dark' ? 'light' : 'dark');
}

export function onColorModeChange(listener: (mode: ColorMode) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Applies the remembered mode (default dark) before React renders, so the
 * window never flashes the wrong theme. Call once at startup.
 */
export function initColorMode(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  setColorMode(stored === 'light' ? 'light' : 'dark');
}
