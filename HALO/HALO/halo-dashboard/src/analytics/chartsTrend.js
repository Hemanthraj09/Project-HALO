// Session comparison and LoRa link.

import { memo, useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { T, FONT, FS } from '../theme';
import {
  fmtFixed, fmtHM, fmtInt, fmtPpm, niceTicks, seriesExtent, seriesHas,
} from './metrics';
import { SERIES } from './palette';
import { BarTooltip, ChartCard, EmptyNote, TimeTooltip } from './ui';
import {
  BAR_CURSOR, GRID_PROPS, LINE_CURSOR, MARGIN,
  activeDot, compactTick, isolatedDot, timeAxisProps, yAxisProps,
} from './chartKit';

const missing = (v) => v === null || v === undefined;
const panelLabel = { fontSize: FS.sm, fontWeight: 500, color: T.textMuted, marginTop: 4 };

// ─── 9. SESSION COMPARISON ───────────────────────────────────────────────────
// Four metrics with different units, so one small bar chart per metric (each with its own axis)
// instead of one shared axis. Bars are sessions, oldest left; the selected session is highlighted.

// title: the mini chart's heading (with the unit where it has one); tip: the tooltip label.
const COMPARE_METRICS = [
  { key: 'trimp', title: 'Training load', tip: 'training load', fmt: (v) => fmtInt(v) },
  { key: 'psiMax', title: 'Peak PSI (est.)', tip: 'peak PSI', fmt: (v) => fmtFixed(v, 1) },
  { key: 'coDose', title: 'CO dose, ppm·min', tip: 'ppm·min', fmt: (v) => fmtInt(v) },
  { key: 'activeMin', title: 'Active minutes', tip: 'active min', fmt: (v) => fmtInt(v) },
];

function SessionTick({ x, y, payload, data }) {
  const row = data.find((d) => d.key === payload.value);
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill={T.textDim} fontSize={FS.xs} fontFamily={FONT.ui}>{row ? row.label : ''}</text>
      <text x={0} y={0} dy={26} textAnchor="middle" fill={T.textDim} fontSize={FS.xs} fontFamily={FONT.ui}>{row ? row.date : ''}</text>
    </g>
  );
}

function SelectedLabel({ x, y, width, value, index, data, fmt }) {
  const row = data[index];
  if (!row || !row.selected || missing(value)) return null;
  return (
    <text x={x + width / 2} y={y - 4} textAnchor="middle" fill={T.textStrong} fontSize={FS.xs} fontWeight={600} fontFamily={FONT.ui}>
      {fmt(value)}
    </text>
  );
}

function MiniBars({ data, metric, anySelected }) {
  const has = data.some((d) => !missing(d[metric.key]));
  const top = Math.max(0, ...data.map((d) => (missing(d[metric.key]) ? 0 : d[metric.key])));
  const axis = niceTicks(0, top > 0 ? top : 1, 4);
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: FS.sm, fontWeight: 600, color: T.textStrong }}>{metric.title}</div>
      {has ? (
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={data} margin={{ ...MARGIN, top: 18, right: 4 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="key" interval="preserveStartEnd" minTickGap={6} height={40} tickLine={false} axisLine={{ stroke: T.borderMid }} tick={<SessionTick data={data} />} />
            <YAxis {...yAxisProps({ width: 40, domain: axis.domain, ticks: axis.ticks, tickFormatter: metric.key === 'psiMax' ? (v) => String(v) : compactTick })} />
            <Tooltip cursor={BAR_CURSOR} isAnimationActive={false}
              content={<BarTooltip title={(r) => r.title}
                rowsOf={(r) => [{ key: metric.key, label: metric.tip, color: r.selected || !anySelected ? SERIES.emphasis : SERIES.deemphasis, value: metric.fmt(r[metric.key]) }]} />} />
            <Bar dataKey={metric.key} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((d) => <Cell key={d.key} fill={d.selected || !anySelected ? SERIES.emphasis : SERIES.deemphasis} />)}
              <LabelList dataKey={metric.key} content={<SelectedLabel data={data} fmt={metric.fmt} />} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : <EmptyNote>No values in these sessions.</EmptyNote>}
    </div>
  );
}

export const SessionCompareChart = memo(function SessionCompareChart({ data, style }) {
  const anySelected = data.some((d) => d.selected);
  const table = {
    columns: [
      { key: 'title', label: 'Session' },
      { key: 'trimp', label: 'TRIMP', fmt: fmtInt },
      { key: 'psiMax', label: 'Peak PSI', fmt: (v) => fmtFixed(v, 1) },
      { key: 'coDose', label: 'CO dose (ppm·min)', fmt: fmtInt },
      { key: 'activeMin', label: 'Active min', fmt: fmtInt },
    ],
    rows: data,
  };
  return (
    <ChartCard style={style} title="Session comparison"
      subtitle={`Last ${data.length} ${data.length === 1 ? 'session' : 'sessions'}`}
      table={table}
      empty={data.length ? null : 'No sessions yet.'}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 16 }}>
        {COMPARE_METRICS.map((m) => <MiniBars key={m.key} data={data} metric={m} anySelected={anySelected} />)}
      </div>
    </ChartCard>
  );
});

// ─── 10. DEVICE HEALTH ───────────────────────────────────────────────────────

const DOT_LINK = isolatedDot(SERIES.link);

const deviceSeries = [
  { key: 'rssi', label: 'LoRa RSSI', color: SERIES.link, kind: 'line', fmt: (v) => (missing(v) ? '--' : `${Math.round(v)} dBm`) },
  { key: 'snr', label: 'LoRa SNR', color: T.borderMid, kind: 'bar', fmt: (v) => (missing(v) ? '--' : `${v.toFixed(1)} dB`) },
  { key: 'loss', label: 'LoRa packet loss', color: SERIES.link, kind: 'line', fmt: (v) => (missing(v) ? '--' : `${fmtPpm(v)}%`) },
];

export const DeviceHealthChart = memo(function DeviceHealthChart({ rows, domain, ticks, withDate, span }) {
  const hasRssi = useMemo(() => seriesHas(rows, 'rssi'), [rows]);
  const hasLoss = useMemo(() => seriesHas(rows, 'loss'), [rows]);
  const rssiAxis = useMemo(() => {
    const e = seriesExtent(rows, ['rssi']);
    return e ? niceTicks(e[0] - 3, Math.min(0, e[1] + 3), 3) : niceTicks(-120, -40, 4);
  }, [rows]);
  const lossAxis = useMemo(() => {
    const e = seriesExtent(rows, ['loss']);
    return niceTicks(0, Math.min(100, Math.max(10, e ? e[1] * 1.1 : 10)), 3);
  }, [rows]);
  const table = useMemo(() => ({
    columns: [
      { key: 't', label: 'Time', fmt: fmtHM },
      { key: 'rssi', label: 'RSSI (dBm)', fmt: fmtInt },
      { key: 'snr', label: 'SNR (dB)', fmt: (v) => fmtFixed(v, 1) },
      { key: 'loss', label: 'Loss (%)', fmt: (v) => fmtFixed(v, 1) },
    ],
    rows: rows.filter((r) => !r.gap && (r.rssi !== null || r.loss !== null)),
  }), [rows]);
  const tooltip = <TimeTooltip series={deviceSeries} withDate={withDate} />;
  const anything = hasRssi || hasLoss;
  return (
    <ChartCard title="LoRa link" subtitle={span} table={table}
      empty={anything ? null : 'No LoRa link data in this window.'}>
      <div style={panelLabel}>LoRa RSSI, dBm</div>
      {hasRssi ? (
        <ResponsiveContainer width="100%" height={120}>
          <ComposedChart data={rows} margin={MARGIN} syncId="halo-analytics-device">
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxisProps(domain, ticks)} />
            <YAxis {...yAxisProps({ domain: rssiAxis.domain, ticks: rssiAxis.ticks, allowDecimals: false })} />
            <Tooltip content={tooltip} cursor={LINE_CURSOR} isAnimationActive={false} />
            <Line type="linear" dataKey="rssi" stroke={SERIES.link} strokeWidth={2} dot={DOT_LINK} activeDot={activeDot(SERIES.link)} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : <EmptyNote>No RSSI in this window.</EmptyNote>}
      <div style={panelLabel}>LoRa packet loss, %</div>
      {hasLoss ? (
        <ResponsiveContainer width="100%" height={120}>
          <ComposedChart data={rows} margin={MARGIN} syncId="halo-analytics-device">
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxisProps(domain, ticks)} />
            <YAxis {...yAxisProps({ domain: lossAxis.domain, ticks: lossAxis.ticks })} />
            <Tooltip content={tooltip} cursor={LINE_CURSOR} isAnimationActive={false} />
            <Line type="linear" dataKey="loss" stroke={SERIES.link} strokeWidth={2} dot={DOT_LINK} activeDot={activeDot(SERIES.link)} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : <EmptyNote>No packet loss data in this window.</EmptyNote>}
    </ChartCard>
  );
});
