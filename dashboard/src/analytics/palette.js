// Chart colours for the ANALYTICS tab, derived from the theme.js tokens so the theme stays the
// single source, and built per theme: read them with chartColors() while rendering. Checked with
// the dataviz palette validator in both themes, against the card (bg2):
//   ZONE_COLORS z1..z5 and ACTIVITY_COLORS are one-hue ordinal ramps (monotone lightness,
//   adjacent step >= 0.06 L, the end nearest the card >= 2:1). The dark theme runs the same
//   formulas from the card towards the light ink, so more effort is still more contrast;
//   chest/arm and CO/TWA series pairs pass the categorical CVD and normal-vision checks;
//   every solid mark colour is >= 2:1 on the card (lines and bars carry labels or a legend too).
// Severity bands (PSI, heat) reuse the status colours, always next to a text label.

import { T, themed } from '../theme';

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Blend colour a toward colour b; w is the weight of a (1 = a, 0 = b).
export function mix(a, b, w) {
  const A = toRgb(a);
  const B = toRgb(b);
  return `#${A.map((v, i) => Math.round(v * w + B[i] * (1 - w)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export const chartColors = themed(() => {
  const SURFACE = T.bg2; // the card
  const INK = T.textStrong;
  return {
    SERIES: {
      ink: INK,                        // main measured line on banded charts (HR, PSI, heat)
      inkSecondary: T.grayFill,        // the matching max line
      rangeFill: T.grayFill,           // HR min-max band (drawn at low opacity)
      coAvg: T.orangeFill,
      coMax: mix(T.orangeFill, SURFACE, 0.65),
      twa: T.blueFill,
      dose: T.orangeFill,
      spo2Avg: mix(T.blueFill, SURFACE, 0.55),   // closer to the card: the average is context
      spo2Min: T.blue,                           // strong: the minimum is what crosses 94 / 90 %
      chest: T.blueFill,
      arm: T.tealFill,
      link: T.textMuted,
      emphasis: T.blueFill,
      deemphasis: T.borderStrong,
      hrrDrop: T.blueFill,
      hrrNone: T.borderStrong,
      warnLine: T.amberFill,
      critLine: T.redFill,
    },
    // Index = zone number. z0 (below 50 % HRmax) is neutral grey; z1..z5 gain contrast with effort.
    ZONE_COLORS: [
      T.borderStrong,
      mix(T.blueFill, SURFACE, 0.5),
      mix(T.blueFill, SURFACE, 0.7),
      T.blueFill,
      mix(T.blue, INK, 0.8),
      mix(T.blue, INK, 0.5),
    ],
    ACTIVITY_COLORS: {
      sedentary: mix(T.tealFill, SURFACE, 0.55),
      light: mix(T.tealFill, SURFACE, 0.75),
      moderate: T.tealFill,
      vigorous: mix(T.teal, INK, 0.7),
    },
    // Background washes, one per band in metrics.PSI_BANDS / HEAT_BANDS order (null = no wash).
    PSI_BAND_FILLS: [null, null, T.amberFill, T.orangeFill, T.redFill],
    HEAT_BAND_FILLS: [T.amberFill, T.amberFill, T.orangeFill, T.redFill],
    // Solid fills for the heat time-in-band bars.
    HEAT_BAR_COLORS: [mix(T.amberFill, SURFACE, 0.7), T.amberFill, T.orangeFill, T.redFill],
  };
});

export const HEAT_BAND_OPACITY = [0.06, 0.14, 0.14, 0.16];
