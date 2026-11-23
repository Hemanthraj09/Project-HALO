// HALO dashboard: light theme design tokens.
//
// Contrast (WCAG 2.1, checked with the relative-luminance formula):
//   every text colour below is >= 4.5:1 against bg0 (#F4F6F9), bg1/bg2 (#FFFFFF) and bg3 (#F8FAFC);
//   each status colour is also >= 4.5:1 on its own *Bg tint (badges, banners).
//   *Fill colours are for chart strokes, bars, dots, gauges and map shapes (>= 3:1 on white).
// Do not use any other grey for text: #64748B, for example, is only 4.4:1 on bg0.

export const T = {
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
};

export const FONT = {
  ui: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

// Font sizes in px. Nothing on screen goes below FS.xs (11 px).
export const FS = { xs: 11, sm: 12, md: 13, lg: 15, xl: 18, xxl: 24, num: 28 };

export const RADIUS = { sm: 4, md: 8, lg: 12 };

export const SHADOW = {
  card: '0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.08)',
  pop: '0 4px 16px rgba(15, 23, 42, 0.14)',
};

// Status presentation shared by cards, badges, the map and the alert feed.
// 'lost' = no packet for STALE_MS; the card keeps the last known priority colour as an outline.
export const STATUS = {
  critical: { label: 'CRITICAL', color: T.red, bg: T.redBg, fill: T.redFill },
  warning: { label: 'WARNING', color: T.amber, bg: T.amberBg, fill: T.amberFill },
  nominal: { label: 'NOMINAL', color: T.green, bg: T.greenBg, fill: T.greenFill },
  offline: { label: 'LINK LOST', color: T.gray, bg: T.grayBg, fill: T.grayFill },
};

// Severity (alert priority 0/1/2) to presentation.
export const SEVERITY = {
  0: { label: 'P0', name: 'MAYDAY', color: T.red, bg: T.redBg, fill: T.redFill },
  1: { label: 'P1', name: 'WARNING', color: T.amber, bg: T.amberBg, fill: T.amberFill },
  2: { label: 'P2', name: 'NOMINAL', color: T.green, bg: T.greenBg, fill: T.greenFill },
};
