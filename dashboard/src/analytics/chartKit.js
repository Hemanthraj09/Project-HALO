// Shared recharts settings for the analytics charts. recharts finds axes and reference marks by
// element type, so these are prop objects to spread onto <XAxis>/<YAxis>/<CartesianGrid>, not
// wrapper components. The coloured ones are built per theme: call them while rendering.

import { T, FONT, FS, themed } from '../theme';
import { fmtHM } from './metrics';

export const axisTick = themed(() => ({ fontSize: FS.xs, fill: T.textDim, fontFamily: FONT.ui }));
export const MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };
export const gridProps = themed(() => ({ vertical: false, stroke: T.border }));
export const lineCursor = themed(() => ({ stroke: T.borderStrong, strokeWidth: 1 }));
export const barCursor = themed(() => ({ fill: T.bg3 }));
export const X_AXIS_HEIGHT = 24;

// Time x axis from the minute start `t`, labelled HH:MM in local time.
export function timeAxisProps(domain, ticks) {
  return {
    dataKey: 't',
    type: 'number',
    scale: 'time',
    domain: domain || ['dataMin', 'dataMax'],
    ticks: ticks && ticks.length ? ticks : undefined,
    tickFormatter: fmtHM,
    tick: axisTick(),
    tickLine: false,
    axisLine: { stroke: T.borderMid },
    allowDataOverflow: true,
    height: X_AXIS_HEIGHT,
  };
}

export function yAxisProps(extra) {
  return { tick: axisTick(), tickLine: false, axisLine: false, width: 44, ...extra };
}

// A label inside the right edge of a reference band; skipped when the band is too thin to hold it.
// The halo in the card colour (stroke painted under the fill) keeps it legible where a data line
// crosses it.
export function bandLabel(text, bandHeightPx) {
  if (bandHeightPx < 14) return undefined;
  return {
    value: text, position: 'insideRight', fill: T.textDim, fontSize: FS.xs, fontFamily: FONT.ui,
    stroke: T.bg2, strokeWidth: 3, paintOrder: 'stroke',
  };
}

// Reference-line label. recharts puts 'insideTopLeft' just below a horizontal line and
// 'insideBottomLeft' just above it.
export function refLineLabel(text, position = 'insideTopLeft') {
  return {
    value: text, position, fill: T.textMuted, fontSize: FS.xs, fontFamily: FONT.ui,
    stroke: T.bg2, strokeWidth: 3, paintOrder: 'stroke',
  };
}

// Line dots only for a minute with no neighbour on either side, which a line alone cannot show.
export function isolatedDot(color) {
  return function IsolatedDot(props) {
    const { cx, cy, index, points, key } = props;
    if (cx === null || cx === undefined || cy === null || cy === undefined || !points) return null;
    const prev = points[index - 1];
    const next = points[index + 1];
    const prevMissing = !prev || prev.y === null || prev.y === undefined;
    const nextMissing = !next || next.y === null || next.y === undefined;
    if (!(prevMissing && nextMissing)) return null;
    return <circle key={key} cx={cx} cy={cy} r={3} fill={color} stroke={T.bg2} strokeWidth={1.5} />;
  };
}

export function activeDot(color) {
  return { r: 4, fill: color, stroke: T.bg2, strokeWidth: 2 };
}

// Full numbers under 10,000 and compact above, one style per axis.
export function compactTick(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  if (Math.abs(v) >= 10000) return `${Math.round(v / 1000)}K`;
  return Math.round(v).toLocaleString('en-US');
}

// Pixel height of a value band inside a plot of plotPx pixels spanning domain [lo, hi].
export function bandPx(y1, y2, domain, plotPx) {
  const span = domain[1] - domain[0];
  return span > 0 ? ((y2 - y1) / span) * plotPx : 0;
}
