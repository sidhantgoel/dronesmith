import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

/**
 * The app has two palettes. Chakra semantic tokens and the raw SVG schematic
 * both read from them: Chakra through the `_light`/`_dark` conditions below,
 * the SVG through the matching CSS variables in index.css. Dark mode is the
 * `dark` class on <html> (see colorMode.ts); without it, light values apply.
 */
export const darkPalette = {
  canvas: '#0a0d12',
  chrome: '#0d1117',
  panel: '#121821',
  raised: '#18202b',
  hover: '#161d27',
  line: '#1f2835',
  lineStrong: '#2c3848',
  text: '#e7ecf3',
  textMuted: '#8d99ab',
  textSubtle: '#6b788b',
  accent: '#5ab0ff',
  accentHover: '#7cc1ff',
  accentSoft: 'rgba(90, 176, 255, 0.12)',
  onAccent: '#06121f',
  ok: '#3ecf8e',
  okSoft: 'rgba(62, 207, 142, 0.12)',
  warn: '#f0b24a',
  warnSoft: 'rgba(240, 178, 74, 0.12)',
  danger: '#f2665c',
  dangerSoft: 'rgba(242, 102, 92, 0.12)',
} as const;

export const lightPalette: Record<keyof typeof darkPalette, string> = {
  canvas: '#eef1f6',
  chrome: '#ffffff',
  panel: '#ffffff',
  raised: '#eef1f7',
  hover: '#f1f4f9',
  line: '#e3e8f0',
  lineStrong: '#cfd7e2',
  text: '#131822',
  textMuted: '#59647a',
  textSubtle: '#8a93a3',
  accent: '#2f6fdb',
  accentHover: '#2560c4',
  accentSoft: 'rgba(47, 111, 219, 0.11)',
  onAccent: '#ffffff',
  ok: '#159c63',
  okSoft: 'rgba(21, 156, 99, 0.12)',
  warn: '#b0771a',
  warnSoft: 'rgba(176, 119, 26, 0.13)',
  danger: '#d23f36',
  dangerSoft: 'rgba(210, 63, 54, 0.11)',
} as const;

type PaletteKey = keyof typeof darkPalette;

/** A semantic color token carrying the light and dark values for one palette key. */
const c = (key: PaletteKey) => ({
  value: { _light: lightPalette[key], _dark: darkPalette[key] },
});

const config = defineConfig({
  globalCss: {
    body: {
      bg: 'bg',
      color: 'fg',
      fontSize: '13px',
      lineHeight: '1.45',
    },
  },
  theme: {
    tokens: {
      fonts: {
        body: {
          value: `'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif`,
        },
        heading: {
          value: `'Segoe UI Variable Display', 'Segoe UI', system-ui, -apple-system, sans-serif`,
        },
        mono: {
          value: `'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace`,
        },
      },
    },
    semanticTokens: {
      colors: {
        bg: {
          DEFAULT: c('canvas'),
          chrome: c('chrome'),
          panel: c('panel'),
          raised: c('raised'),
          hover: c('hover'),
          muted: c('raised'),
        },
        fg: {
          DEFAULT: c('text'),
          muted: c('textMuted'),
          subtle: c('textSubtle'),
          onAccent: c('onAccent'),
        },
        border: {
          DEFAULT: c('line'),
          muted: c('line'),
          strong: c('lineStrong'),
        },
        accent: {
          DEFAULT: c('accent'),
          hover: c('accentHover'),
          soft: c('accentSoft'),
        },
        ok: {
          DEFAULT: c('ok'),
          soft: c('okSoft'),
        },
        warn: {
          DEFAULT: c('warn'),
          soft: c('warnSoft'),
        },
        danger: {
          DEFAULT: c('danger'),
          soft: c('dangerSoft'),
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
