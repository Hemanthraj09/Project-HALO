// Physiology charts: heart rate with zone bands, time in zones, physiological strain,
// SpO2 and HR recovery. Each chart takes pre-built rows (metrics.buildMinuteSeries) and is memoised.

import { memo, useMemo } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { T, FS, RADIUS } from '../theme';
import {
  CORE_CRIT_C, CORE_WARN_C, HR_ZONES, PSI_BANDS, SPO2_CRITICAL, SPO2_LOW,
  fmtFixed, fmtHM, fmtInt, fmtMinutes, hrDomain, niceTicks, seriesExtent, seriesHas, zoneBands, zoneBarData,
} from './metrics';
import { PSI_BAND_FILLS, SERIES, ZONE_COLORS } from './palette';
import { BarTooltip, ChartCard, EmptyNote, NUM, TimeTooltip } from './ui';
import {
  AXIS_TICK, BAR_CURSOR, GRID_PROPS, LINE_CURSOR, MARGIN, X_AXIS_HEIGHT,
  activeDot, bandLabel, bandPx, isolatedDot, refLineLabel, timeAxisProps, yAxisProps,
} from './chartKit';

const DOT_INK = isolatedDot(SERIES.ink);
const DOT_INK2 = isolatedDot(SERIES.inkSecondary);
const DOT_SPO2 = isolatedDot(SERIES.spo2Avg);
const DOT_SPO2_MIN = isolatedDot(SERIES.spo2Min);

const missing = (v) => v === null || v === undefined;
const bpm = (v) => (missing(v) ? '--' : `${Math.round(v)} bpm`);
const zoneText = (z) => (missing(z) ? '--' : `${HR_ZONES[z].label} ${HR_ZONES[z].name}`);

const panelLabel = { fontSize: FS.sm, fontWeight: 500, color: T.textMuted, marginTop: 4 };

// ─── 1. HEART RATE ───────────────────────────────────────────────────────────

const HR_HEIGHT = 240;

export const HrChart = memo(function HrChart({ rows, domain, ticks, withDate, hrMax, span }) {
  const hrMaxV = hrMax ? hrMax.value : null;
  const yAxis = useMemo(() => {
    const [lo, hi] = hrDomain(rows, hrMaxV);
    return niceTicks(lo, hi, 6);
  }, [rows, hrMaxV]);
  const yDomain = yAxis.domain;
  const bands = useMemo(() => zoneBands(hrMaxV, yDomain), [hrMaxV, yDomain]);
  const has = useMemo(() => seriesHas(rows, 'hr'), [rows]);
  const table = useMemo(() => ({
    columns: [
      { key: 't', label: 'Time', fmt: fmtHM },
      { key: 'hr', label: 'Avg (bpm)', fmt: fmtInt },
      { key: 'hrMin', label: 'Min (bpm)', fmt: fmtInt },
      { key: 'hrMax', label: 'Max (bpm)', fmt: fmtInt },
      { key: 'zone', label: 'Zone', fmt: (z) => (missing(z) ? '--' : HR_ZONES[z].label) },
    ],
    rows: rows.filter((r) => !r.gap && r.hr !== null),
  }), [rows]);
  const series = useMemo(() => [
    { key: 'hr', label: '1-min average', color: SERIES.ink, kind: 'line', fmt: bpm },
    { key: 'hrRange', label: 'min–max', color: SERIES.rangeFill, kind: 'bar', fmt: (v) => (v ? `${Math.round(v[0])}–${Math.round(v[1])} bpm` : '--') },
    { key: 'zone', label: 'zone', kind: 'bar', colorOf: (r) => (missing(r.zone) ? T.border : ZONE_COLORS[r.zone]), fmt: zoneText },
  ], []);
  const plotPx = HR_HEIGHT - X_AXIS_HEIGHT - MARGIN.top;
  const legend = [
    { label: '1-min average', color: SERIES.ink, kind: 'line' },
    { label: 'min–max in the minute', color: SERIES.rangeFill, kind: 'bar', opacity: 0.35 },
  ];
  if (bands.length) legend.push({ label: 'HR zone (Z0–Z5)', color: ZONE_COLORS[3], kind: 'band', opacity: 0.3 });
  return (
    <ChartCard title="Heart rate" subtitle={span} legend={legend} table={table}
      empty={has ? null : 'No valid heart rate in this window.'}>
      <ResponsiveContainer width="100%" height={HR_HEIGHT}>
        <ComposedChart data={rows} margin={MARGIN}>
          {bands.map((b) => (
            <ReferenceArea key={b.key} y1={b.y1} y2={b.y2} fill={ZONE_COLORS[b.z]} fillOpacity={0.16} stroke="none"
              ifOverflow="hidden" label={bandLabel(b.label, bandPx(b.y1, b.y2, yDomain, plotPx))} />
          ))}
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(domain, ticks)} />
          <YAxis {...yAxisProps({ domain: yDomain, ticks: yAxis.ticks, allowDecimals: false })} />
          <Tooltip content={<TimeTooltip series={series} withDate={withDate} />} cursor={LINE_CURSOR} isAnimationActive={false} />
          <Area type="linear" dataKey="hrRange" fill={SERIES.rangeFill} fillOpacity={0.22} stroke="none" isAnimationActive={false} activeDot={false} />
          <Line type="linear" dataKey="hr" stroke={SERIES.ink} strokeWidth={2} dot={DOT_INK} activeDot={activeDot(SERIES.ink)} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
});

// ─── 2. TIME IN HR ZONES ─────────────────────────────────────────────────────

const ZONE_TICK = { ...AXIS_TICK, fill: T.textMuted, fontWeight: 600 };

const zoneRowsOf = (r) => [
  { key: 'm', label: 'minutes', color: ZONE_COLORS[r.z], value: fmtMinutes(r.minutes) },
  { key: 's', label: 'of HR time', color: ZONE_COLORS[r.z], value: r.share === null ? '--' : `${Math.round(r.share * 100)}%` },
  ...(r.bpm ? [{ key: 'b', label: 'zone range', color: ZONE_COLORS[r.z], value: r.bpm }] : []),
];

export const ZoneChart = memo(function ZoneChart({ zonesS, hrMax }) {
  const hrMaxV = hrMax ? hrMax.value : null;
  const data = useMemo(() => zoneBarData(zonesS, hrMaxV), [zonesS, hrMaxV]);
  const has = Boolean(zonesS) && data.some((d) => d.minutes > 0);
  const table = {
    columns: [
      { key: 'label', label: 'Zone' },
      { key: 'name', label: 'Effort' },
      { key: 'range', label: '% HRmax' },
      { key: 'bpm', label: 'bpm' },
      { key: 'minutes', label: 'Minutes', fmt: fmtMinutes },
    ],
    rows: data,
  };
  return (
    <ChartCard title="Time in HR zones" subtitle="Minutes per zone" table={table}
      empty={has ? null : 'No valid heart rate in this window.'}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ ...MARGIN, top: 20 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis dataKey="label" interval={0} height={X_AXIS_HEIGHT} tickLine={false} axisLine={{ stroke: T.borderMid }} tick={ZONE_TICK} />
          <YAxis {...yAxisProps({ allowDecimals: false })} />
          <Tooltip cursor={BAR_CURSOR} isAnimationActive={false}
            content={<BarTooltip title={(r) => `${r.label} · ${r.name} (${r.range} HRmax)`} rowsOf={zoneRowsOf} />} />
          <Bar dataKey="minutes" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.key} fill={ZONE_COLORS[d.z]} />)}
            <LabelList dataKey="minutes" position="top" formatter={fmtMinutes} fill={T.textMuted} fontSize={FS.xs} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
});

// ─── 3. PHYSIOLOGICAL STRAIN ─────────────────────────────────────────────────
// PSI and estimated core temperature share the time axis but not a y axis: they are two
// panels with a synchronised cursor, so the core line never reads as sitting in a PSI band.

const PSI_HEIGHT = 190;
const CORE_HEIGHT = 150;
const PSI_DOMAIN = [0, 10];

const strainSeries = [
  { key: 'psi', label: 'PSI 1-min average', color: SERIES.ink, kind: 'line', fmt: (v) => fmtFixed(v, 1) },
  { key: 'psiMax', label: 'PSI 1-min max', color: SERIES.inkSecondary, kind: 'thin', fmt: (v) => fmtFixed(v, 1) },
  { key: 'core', label: 'core temperature (est.)', color: SERIES.ink, kind: 'line', fmt: (v) => (missing(v) ? '--' : `${v.toFixed(2)} °C`) },
];

export const StrainChart = memo(function StrainChart({ rows, domain, ticks, withDate, span }) {
  const hasPsi = useMemo(() => seriesHas(rows, 'psi') || seriesHas(rows, 'psiMax'), [rows]);
  const hasCore = useMemo(() => seriesHas(rows, 'core'), [rows]);
  const coreAxis = useMemo(() => {
    const e = seriesExtent(rows, ['core']);
    return niceTicks(e ? Math.min(36.5, e[0]) : 36.5, e ? Math.max(40, e[1]) : 40, 4);
  }, [rows]);
  const table = useMemo(() => ({
    columns: [
      { key: 't', label: 'Time', fmt: fmtHM },
      { key: 'psi', label: 'PSI avg', fmt: (v) => fmtFixed(v, 1) },
      { key: 'psiMax', label: 'PSI max', fmt: (v) => fmtFixed(v, 1) },
      { key: 'core', label: 'Core est. (°C)', fmt: (v) => fmtFixed(v, 2) },
    ],
    rows: rows.filter((r) => !r.gap && (r.psi !== null || r.psiMax !== null || r.core !== null)),
  }), [rows]);
  const plotPx = PSI_HEIGHT - X_AXIS_HEIGHT - MARGIN.top;
  const tooltip = <TimeTooltip series={strainSeries} withDate={withDate} />;
  return (
    <ChartCard title="Physiological strain" subtitle={span} table={table}
      legend={hasPsi ? [
        { label: 'PSI 1-min average', color: SERIES.ink, kind: 'line' },
        { label: 'PSI 1-min max', color: SERIES.inkSecondary, kind: 'thin' },
      ] : null}
      empty={hasPsi || hasCore ? null : 'No PSI or core temperature in this window.'}>
      <div style={panelLabel}>PSI (est.)</div>
      {hasPsi ? (
        <ResponsiveContainer width="100%" height={PSI_HEIGHT}>
          <ComposedChart data={rows} margin={MARGIN} syncId="halo-analytics-strain">
            {PSI_BANDS.map((b, i) => {
              const y1 = Math.max(PSI_DOMAIN[0], b.lo);
              const y2 = Math.min(PSI_DOMAIN[1], b.hi);
              return (
                <ReferenceArea key={b.key} y1={y1} y2={y2} fill={PSI_BAND_FILLS[i] || 'none'} fillOpacity={PSI_BAND_FILLS[i] ? 0.12 : 0}
                  stroke="none" ifOverflow="hidden" label={bandLabel(b.label, bandPx(y1, y2, PSI_DOMAIN, plotPx))} />
              );
            })}
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxisProps(domain, ticks)} />
            <YAxis {...yAxisProps({ domain: PSI_DOMAIN, ticks: [0, 3, 5, 7, 9] })} />
            <Tooltip content={tooltip} cursor={LINE_CURSOR} isAnimationActive={false} />
            <Line type="linear" dataKey="psiMax" stroke={SERIES.inkSecondary} strokeWidth={1.5} dot={DOT_INK2} activeDot={activeDot(SERIES.inkSecondary)} isAnimationActive={false} />
            <Line type="linear" dataKey="psi" stroke={SERIES.ink} strokeWidth={2} dot={DOT_INK} activeDot={activeDot(SERIES.ink)} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : <EmptyNote>No PSI in this window.</EmptyNote>}
      <div style={panelLabel}>Core temperature (est.), °C</div>
      {hasCore ? (
        <ResponsiveContainer width="100%" height={CORE_HEIGHT}>
          <ComposedChart data={rows} margin={MARGIN} syncId="halo-analytics-strain">
            <CartesianGrid {...GRID_PROPS} />
            <XAxis {...timeAxisProps(domain, ticks)} />
            <YAxis {...yAxisProps({ domain: coreAxis.domain, ticks: coreAxis.ticks, tickFormatter: (v) => v.toFixed(1) })} />
            <Tooltip content={tooltip} cursor={LINE_CURSOR} isAnimationActive={false} />
            <ReferenceLine y={CORE_WARN_C} stroke={SERIES.warnLine} strokeDasharray="4 3" ifOverflow="extendDomain" label={refLineLabel(`${CORE_WARN_C} °C (P1)`)} />
            <ReferenceLine y={CORE_CRIT_C} stroke={SERIES.critLine} strokeDasharray="4 3" ifOverflow="extendDomain" label={refLineLabel(`${CORE_CRIT_C} °C (P0)`)} />
            <Line type="linear" dataKey="core" stroke={SERIES.ink} strokeWidth={2} dot={DOT_INK} activeDot={activeDot(SERIES.ink)} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : <EmptyNote>No core temperature in this window.</EmptyNote>}
    </ChartCard>
  );
});

// ─── 7. SPO2 ─────────────────────────────────────────────────────────────────

const spo2Series = [
  { key: 'spo2', label: '1-min average', color: SERIES.spo2Avg, kind: 'line', fmt: (v) => (missing(v) ? '--' : `${Math.round(v)}%`) },
  { key: 'spo2Min', label: '1-min minimum', color: SERIES.spo2Min, kind: 'line', fmt: (v) => (missing(v) ? '--' : `${Math.round(v)}%`) },
];

export const Spo2Chart = memo(function Spo2Chart({ rows, domain, ticks, withDate, span }) {
  const has = useMemo(() => seriesHas(rows, 'spo2') || seriesHas(rows, 'spo2Min'), [rows]);
  const yAxis = useMemo(() => {
    const e = seriesExtent(rows, ['spo2', 'spo2Min']);
    return niceTicks(e ? Math.max(50, Math.min(85, e[0] - 2)) : 85, 100, 4);
  }, [rows]);
  const table = useMemo(() => ({
    columns: [
      { key: 't', label: 'Time', fmt: fmtHM },
      { key: 'spo2', label: 'Avg (%)', fmt: fmtInt },
      { key: 'spo2Min', label: 'Min (%)', fmt: fmtInt },
    ],
    rows: rows.filter((r) => !r.gap && (r.spo2 !== null || r.spo2Min !== null)),
  }), [rows]);
  return (
    <ChartCard title="SpO2" subtitle={span} table={table}
      legend={[
        { label: '1-min minimum', color: SERIES.spo2Min, kind: 'line' },
        { label: '1-min average', color: SERIES.spo2Avg, kind: 'line' },
      ]}
      empty={has ? null : 'No valid SpO2 in this window.'}>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={rows} margin={MARGIN}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis {...timeAxisProps(domain, ticks)} />
          <YAxis {...yAxisProps({ domain: yAxis.domain, ticks: yAxis.ticks, allowDecimals: false })} />
          <Tooltip content={<TimeTooltip series={spo2Series} withDate={withDate} />} cursor={LINE_CURSOR} isAnimationActive={false} />
          <ReferenceLine y={SPO2_LOW} stroke={SERIES.warnLine} strokeDasharray="4 3" ifOverflow="extendDomain" label={refLineLabel(`${SPO2_LOW}% (P1)`, 'insideBottomLeft')} />
          <ReferenceLine y={SPO2_CRITICAL} stroke={SERIES.critLine} strokeDasharray="4 3" ifOverflow="extendDomain" label={refLineLabel(`${SPO2_CRITICAL}% (P0)`, 'insideBottomLeft')} />
          <Line type="linear" dataKey="spo2" stroke={SERIES.spo2Avg} strokeWidth={2} dot={DOT_SPO2} activeDot={activeDot(SERIES.spo2Avg)} isAnimationActive={false} />
          <Line type="linear" dataKey="spo2Min" stroke={SERIES.spo2Min} strokeWidth={2} dot={DOT_SPO2_MIN} activeDot={activeDot(SERIES.spo2Min)} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
});

// ─── 8. HR RECOVERY ──────────────────────────────────────────────────────────

export const HrRecoveryCard = memo(function HrRecoveryCard({ hrr, span }) {
  const scale = Math.max(30, ...hrr.map((h) => h.hrr1));
  const table = {
    columns: [
      { key: 'boutStart', label: 'Bout', fmt: (v, r) => `${fmtHM(v)}–${fmtHM(r.boutEnd)}` },
      { key: 'boutMin', label: 'Minutes' },
      { key: 'peakHr', label: 'Peak (bpm)', fmt: fmtInt },
      { key: 'hrEnd', label: 'Last bout min (bpm)', fmt: fmtInt },
      { key: 'hrNext', label: 'Next min (bpm)', fmt: fmtInt },
      { key: 'hrr1', label: 'HRR1 (bpm)', fmt: fmtInt },
    ],
    rows: hrr.map((h) => ({ ...h, key: h.t })),
  };
  return (
    <ChartCard title="HR recovery (HRR1)" subtitle={span} table={table}
      empty={hrr.length ? null : 'No HR recovery bouts in this window.'}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
        {hrr.map((h) => {
          const drop = Math.round(h.hrr1);
          const width = drop > 0 ? Math.max(2, Math.min(100, (drop / scale) * 100)) : 0;
          return (
            <li key={h.t} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1.2fr) 2fr 72px', alignItems: 'center', gap: 10, fontSize: FS.sm, ...NUM }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: T.textStrong, fontWeight: 500 }}>{fmtHM(h.boutStart)}–{fmtHM(h.boutEnd)}</div>
                <div style={{ color: T.textDim, fontSize: FS.xs }}>{h.boutMin} min bout, peak {fmtInt(h.peakHr)} bpm</div>
              </div>
              <div style={{ height: 10, background: T.bg3, borderRadius: RADIUS.sm, overflow: 'hidden' }} aria-hidden="true">
                <div style={{ width: `${width}%`, height: '100%', background: drop > 0 ? SERIES.hrrDrop : SERIES.hrrNone, borderRadius: `0 ${RADIUS.sm}px ${RADIUS.sm}px 0` }} />
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: T.textStrong, fontWeight: 600 }}>{drop > 0 ? `−${drop}` : 'no drop'}{drop > 0 ? ' bpm' : ''}</div>
                <div style={{ color: T.textDim, fontSize: FS.xs }}>{fmtInt(h.hrEnd)} → {fmtInt(h.hrNext)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </ChartCard>
  );
});
