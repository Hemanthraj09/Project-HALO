// HALO dashboard design tokens: a light and a dark theme with the same token names.
//
// Contrast (WCAG 2.1, checked with the relative-luminance formula), in both themes:
//   every text colour is >= 4.5:1 against bg0, bg1, bg2 and bg3;
//   each status colour is also >= 4.5:1 on its own *Bg tint (badges, banners).
//   *Fill colours are for chart strokes, bars, dots, gauges and map shapes: >= 3:1 on white in
//   the light theme, and >= 3:1 on bg0 to bg3 in the dark theme.
// Do not use any other grey for text: #64748B, for example, is only 4.4:1 on the light bg0.
//
// T, SHADOW, STATUS and SEVERITY always hold the active theme: applyTheme() copies the values in
// place, so code that reads them while rendering gets the current colours. A colour kept from an
// earlier render goes stale on a theme switch, so values derived from the tokens outside a render
// are built per theme with themed(), and memos that hold colours depend on the theme (useTheme()
// in lib/themeMode.js).

export const LIGHT = Object.freeze({
  // surfaces
  bg0: '#F4F6F9',        // app background
  bg1: '#FFFFFF',        // panels
  bg2: '#FFFFFF',        // cards
  bg3: '#F8FAFC',        // nested surfaces, hover, table stripes
  border: '#E2E8F0',
  borderMid: '#CBD5E1',
  borderStrong: '#94A3B8',

  // text
  textStrong: '#0F172A', // headings, big numbers   17.9:1
  text: '#1F2937',       // body text               14.7:1
  textMuted: '#475569',  // secondary text           7.6:1
  textDim: '#5B6675',    // labels, captions         5.8:1 (5.4:1 on bg0)

  // status / semantic: text colour, background tint, graphic fill
  red: '#B91C1C',    redBg: '#FEF2F2',    redFill: '#DC2626',     // P0 / critical
  amber: '#92400E',  amberBg: '#FFFBEB',  amberFill: '#D97706',   // P1 / warning
  green: '#15803D',  greenBg: '#F0FDF4',  greenFill: '#16A34A',   // P2 / nominal / ok
  blue: '#1D4ED8',   blueBg: '#EFF6FF',   blueFill: '#2563EB',    // info, selection, links
  orange: '#C2410C', orangeBg: '#FFF7ED', orangeFill: '#EA580C',  // danger band between warning and critical
  purple: '#6D28D9', purpleBg: '#F5F3FF', purpleFill: '#7C3AED',  // air quality / smoke
  teal: '#0F766E',   tealBg: '#F0FDFA',   tealFill: '#0D9488',    // humidity, secondary series
  gray: '#5B6675',   grayBg: '#F1F5F9',   grayFill: '#64748B',    // offline, unknown, disabled
});

// Slate / navy surfaces, lighter towards the front. Worst pairs over bg0..bg3: text 5.7:1
// (textDim on bg3), status text 5.3:1 (red on bg3), status text on its own tint 5.4:1 (red,
// purple), fills 3.4:1 (grayFill, purpleFill on bg3). Each tint is 18 % of its hue over bg1.
export const DARK = Object.freeze({
  // surfaces
  bg0: '#0A101D',        // app background
  bg1: '#0F1729',        // panels
  bg2: '#152035',        // cards
  bg3: '#1B2940',        // nested surfaces, hover, table stripes
  border: '#243249',
  borderMid: '#33445E',
  borderStrong: '#51627E',

  // text
  textStrong: '#F1F5F9', // headings, big numbers   13.3:1 on bg3 (16.3:1 on bg1)
  text: '#DCE3EC',       // body text               11.3:1 on bg3
  textMuted: '#B3BFCE',  // secondary text           7.8:1 on bg3
  textDim: '#95A3B6',    // labels, captions         5.7:1 on bg3

  // status / semantic: text colour, background tint, graphic fill
  red: '#F87171',    redBg: '#371F2E',    redFill: '#EF4444',
  amber: '#FBBF24',  amberBg: '#332823',  amberFill: '#D97706',
  green: '#4ADE80',  greenBg: '#10302F',  greenFill: '#16A34A',
  blue: '#60A5FA',   blueBg: '#172A4E',   blueFill: '#3B82F6',
  orange: '#FB923C', orangeBg: '#362324', orangeFill: '#EA580C',
  purple: '#A78BFA', purpleBg: '#25234E', purpleFill: '#8B5CF6',
  teal: '#2DD4BF',   tealBg: '#0F2E3A',   tealFill: '#0D9488',
  gray: '#A1AEC0',   grayBg: '#273043',   grayFill: '#6B7C94',
});

export const PALETTES = Object.freeze({ light: LIGHT, dark: DARK });

const SHADOWS = {
  light: {
    card: '0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.08)',
    pop: '0 4px 16px rgba(15, 23, 42, 0.14)',
  },
  dark: {
    card: '0 1px 2px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.24)',
    pop: '0 6px 20px rgba(0, 0, 0, 0.5)',
  },
};

// Map marker chrome, the same in both themes: the white ring, tip and glyph of hazard pins and
// responder dots, and the command-post badge. Only the OSM tiles are darkened in the dark theme.
export const MARKER = Object.freeze({ ring: '#FFFFFF', ink: '#0F172A' });

export const FONT = {
  ui: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

// Font sizes in px. Nothing on screen goes below FS.xs (11 px).
export const FS = { xs: 11, sm: 12, md: 13, lg: 15, xl: 18, xxl: 24, num: 28 };

export const RADIUS = { sm: 4, md: 8, lg: 12 };

// Live token objects (see the header).
export const T = { ...LIGHT };
export const SHADOW = { ...SHADOWS.light };

// Status presentation shared by cards, badges, the map and the alert feed.
// 'lost' = no packet for STALE_MS; the card keeps the last known priority colour as an outline.
export const STATUS = {
  critical: { label: 'CRITICAL' },
  warning: { label: 'WARNING' },
  nominal: { label: 'NOMINAL' },
  offline: { label: 'LINK LOST' },
};

// Severity (alert priority 0/1/2) to presentation.
export const SEVERITY = {
  0: { label: 'P0', name: 'MAYDAY' },
  1: { label: 'P1', name: 'WARNING' },
  2: { label: 'P2', name: 'NOMINAL' },
};

const STATUS_HUE = { critical: 'red', warning: 'amber', nominal: 'green', offline: 'gray' };
const SEVERITY_HUE = { 0: 'red', 1: 'amber', 2: 'green' };
const paint = (entry, hue) => Object.assign(entry, { color: T[hue], bg: T[`${hue}Bg`], fill: T[`${hue}Fill`] });

let activeMode = 'light';

// Makes `mode` ('light' | 'dark') the active theme. lib/themeMode.js calls it before React renders.
export function applyTheme(mode) {
  activeMode = mode === 'dark' ? 'dark' : 'light';
  Object.assign(T, PALETTES[activeMode]);
  Object.assign(SHADOW, SHADOWS[activeMode]);
  Object.keys(STATUS).forEach((k) => paint(STATUS[k], STATUS_HUE[k]));
  Object.keys(SEVERITY).forEach((k) => paint(SEVERITY[k], SEVERITY_HUE[k]));
}

export function themeMode() {
  return activeMode;
}

// A value derived from the tokens, built once per theme: const X = themed(() => ...), read X().
// Within one theme X() keeps its identity, so memoised charts skip re-rendering on new packets.
export function themed(build) {
  const cache = {};
  return () => {
    if (!cache[activeMode]) cache[activeMode] = build();
    return cache[activeMode];
  };
}

// '#RRGGBB' + alpha -> 'rgba(r, g, b, a)'
export function alpha(hex, a) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

applyTheme('light');
