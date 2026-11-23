// Exposure and workload charts: heat index, CO, activity intensity. Memoised; each also re-renders
// on a theme switch (useTheme).

import { memo, useMemo } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useTheme } from '../lib/themeMode';
import { T, FS, RADIUS, themed } from '../theme';
import {
  ACTIVITY_BANDS, CO_CEILING_PPM, CO_REL_PPM, HEAT_BANDS,
  activityBuckets, fmtFixed, fmtHM, fmtInt, fmtMinutes, fmtPpm, niceTicks, seriesExtent, seriesHas,
} from './metrics';
import { chartColors, HEAT_BAND_OPACITY } from './palette';
import { BarTooltip, ChartCard, EmptyNote, NUM, TimeTooltip } from './ui';
import {
  MARGIN, X_AXIS_HEIGHT,
  activeDot, axisTick, bandLabel, bandPx, barCursor, compactTick, gridProps, isolatedDot, lineCursor, refLineLabel, timeAxisProps, yAxisProps,
} from './chartKit';

const dots = themed(() => {
  const { SERIES } = chartColors();
  return {
    ink: isolatedDot(SERIES.ink),
    ink2: isolatedDot(SERIES.inkSecondary),
    co: isolatedDot(SERIES.coAvg),
    coMax: isolatedDot(SERIES.coMax),
    twa: isolatedDot(SERIES.twa),
  };
});

const missing = (v) => v === null || v === undefined;
const degC = (v) => (missing(v) ? '--' : `${v.toFixed(1)} °C`);
const ppm = (v) => (missing(v) ? '--' : `${fmtPpm(v)} ppm`);
const panelLabel = themed(() => ({ fontSize: FS.sm, fontWeight: 500, color: T.textMuted, marginTop: 4 }));

// A name, a bar and a figure per row (time-in-band lists).
function BarList({ rows, scaleMax, valueText }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => (
        <li key={r.key} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 64px', alignItems: 'center', gap: 10, fontSize: FS.sm, ...NUM }}>
          <span style={{ color: T.text }}>{r.label}</span>
          <span style={{ height: 10, background: T.bg3, borderRadius: RADIUS.sm, overflow: 'hidden' }} aria-hidden="true">
            <span style={{
              display: 'block', height: '100%', borderRadius: `0 ${RADIUS.sm}px ${RADIUS.sm}px 0`, background: r.color,
              width: `${scaleMax > 0 && r.value > 0 ? Math.max(2, (r.value / scaleMax) * 100) : 0}%`,
            }} />
          </span>
          <span style={{ textAlign: 'right', color: T.textStrong, fontWeight: 600 }}>{valueText(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── 4. HEAT EXPOSURE ────────────────────────────────────────────────────────

const HEAT_HEIGHT = 210;

const heatSeries = themed(() => {
  const { SERIES } = chartColors();
  return [
    { key: 'heat', label: 'heat index, 1-min average', color: SERIES.ink, kind: 'line', fmt: degC },
    { key: 'heatMax', label: 'heat index, 1-min max', color: SERIES.inkSecondary, kind: 'thin', fmt: degC },
    { key: 'temp', label: 'ambient air', color: T.borderMid, kind: 'bar', fmt: degC },
    { key: 'hum', label: 'humidity', color: T.borderMid, kind: 'bar', fmt: (v) => (missing(v) ? '--' : `${Math.round(v)}%`) },
  ];
});

export const HeatChart = memo(function HeatChart({ rows, domain, ticks, withDate, span, bandsS }) {
  useTheme();
  const { SERIES, HEAT_BAND_FILLS, HEAT_BAR_COLORS } = chartColors();
  const dot = dots();
  const has = useMemo(() => seriesHas(rows, 'heat') || seriesHas(rows, 'heatMax'), [rows]);
  const yAxis = useMemo(() => {
    const e = seriesExtent(rows, ['heat', 'heatMax']);
    return niceTicks(e ? Math.min(24, e[0] - 1) : 24, e ? Math.max(42, e[1] + 1) : 42, 5);
  }, [rows]);
  const yDomain = yAxis.domain;
  const plotPx = HEAT_HEIGHT - X_AXIS_HEIGHT - MARGIN.top;
  const bandRows = HEAT_BANDS.map((b, i) => ({ key: b.key, label: b.label, color: HEAT_BAR_COLORS[i], value: bandsS ? (bandsS[i] || 0) / 60 : 0 }));
  const bandMax = Math.max(0, ...bandRows.map((r) => r.value));
  const table = useMemo(() => ({
    columns: [
      { key: 't', label: 'Time', fmt: fmtHM },
      { key: 'heat', label: 'Heat index avg (°C)', fmt: (v) => fmtFixed(v, 1) },
      { key: 'heatMax', label: 'Heat index max (°C)', fmt: (v) => fmtFixed(v, 1) },
      { key: 'temp', label: 'Air (°C)', fmt: (v) => fmtFixed(v, 1) },
      { key: 'hum', label: 'Humidity (%)', fmt: fmtInt },
    ],
    rows: rows.filter((r) => !r.gap && (r.heat !== null || r.heatMax !== null)),
  }), [rows]);
  return (
    <ChartCard title="Heat exposure" subtitle={span} table={table}
      legend={[
        { label: 'heat index, 1-min average', color: SERIES.ink, kind: 'line' },
        { label: 'heat index, 1-min max', color: SERIES.inkSecondary, kind: 'thin' },
      ]}
      empty={has ? null : 'No heat index in this window.'}>
      <ResponsiveContainer width="100%" height={HEAT_HEIGHT}>
        <ComposedChart data={rows} margin={MARGIN}>
          {HEAT_BANDS.map((b, i) => {
            const y1 = Math.max(yDomain[0], b.lo);
            const y2 = Math.min(yDomain[1], b.hi);
            if (y2 <= y1) return null;
            return (
              <ReferenceArea key={b.key} y1={y1} y2={y2} fill={HEAT_BAND_FILLS[i]} fillOpacity={HEAT_BAND_OPACITY[i]} stroke="none"
                ifOverflow="hidden" label={bandLabel(b.label.toLowerCase(), bandPx(y1, y2, yDomain, plotPx))} />
            );
          })}
          <CartesianGrid {...gridProps()} />
          <XAxis {...timeAxisProps(domain, ticks)} />
          <YAxis {...yAxisProps({ domain: yDomain, ticks: yAxis.ticks, allowDecimals: false })} />
          <Tooltip content={<TimeTooltip series={heatSeries()} withDate={withDate} />} cursor={lineCursor()} isAnimationActive={false} />
          <Line type="linear" dataKey="heatMax" stroke={SERIES.inkSecondary} strokeWidth={1.5} dot={dot.ink2} activeDot={activeDot(SERIES.inkSecondary)} isAnimationActive={false} />
          <Line type="linear" dataKey="heat" stroke={SERIES.ink} strokeWidth={2} dot={dot.ink} activeDot={activeDot(SERIES.ink)} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={panelLabel()}>Time in band</div>
      {bandsS ? <BarList rows={bandRows} scaleMax={bandMax} valueText={(v) => `${fmtMinutes(v)} min`} />
        : <EmptyNote>No heat index readings.</EmptyNote>}
    </ChartCard>
  );
});

// ─── 5. CO EXPOSURE ──────────────────────────────────────────────────────────

const coSeries = themed(() => {
  const { SERIES } = chartColors();
  return [
    { key: 'co', label: 'CO 1-min average', color: SERIES.coAvg, kind: 'line', fmt: ppm },
    { key: 'coMax', label: 'CO 1-min max', color: SERIES.coMax, kind: 'thin', fmt: ppm },
    { key: 'twa', label: '15-min TWA', color: SERIES.twa, kind: 'line', fmt: ppm },
    { key: 'dose', label: 'cumulative dose', color: SERIES.dose, kind: 'bar', fmt: (v) => (missing(v) ? '--' : `${fmtInt(v)} ppm·min`) },
  ];
});

export const CoChart = memo(function CoChart({ rows, domain, ticks, withDate, span }) {
  useTheme();
  const { SERIES } = chartColors();
  const dot = dots();
  const has = useMemo(() => seriesHas(rows, 'co') || seriesHas(rows, 'coMax') || seriesHas(rows, 'twa'), [rows]);
  const hasDose = useMemo(() => seriesHas(rows, 'dose'), [rows]);
  const coAxis = useMemo(() => {
    const e = seriesExtent(rows, ['co', 'coMax', 'twa']);
    return niceTicks(0, Math.max(220, e ? e[1] * 1.05 : 0), 5);
  }, [rows]);
  const doseAxis = useMemo(() => {
    const e = seriesExtent(rows, ['dose']);
    return niceTicks(0, e && e[1] > 0 ? e[1] : 1, 4);
  }, [rows]);
  const table = useMemo(() => ({
    columns: [
      { key: 't', label: 'Time', fmt: fmtHM },
      { key: 'co', label: 'CO avg (ppm)', fmt: fmtPpm },
      { key: 'coMax', label: 'CO max (ppm)', fmt: fmtPpm },
      { key: 'twa', label: '15-min TWA (ppm)', fmt: fmtPpm },
      { key: 'dose', label: 'Dose (ppm·min)', fmt: fmtInt },
    ],
    rows: rows.filter((r) => !r.gap && (r.co !== null || r.coMax !== null || r.twa !== null)),
  }), [rows]);
  const tooltip = <TimeTooltip series={coSeries()} withDate={withDate} />;
  return (
    <ChartCard title="CO exposure" subtitle={span} table={table}
      legend={[
        { label: 'CO 1-min average', color: SERIES.coAvg, kind: 'line' },
        { label: 'CO 1-min max', color: SERIES.coMax, kind: 'thin' },
        { label: '15-min TWA', color: SERIES.twa, kind: 'line' },
      ]}
      empty={has ? null : 'No CO data in this window.'}>
      <div style={panelLabel()}>CO, ppm</div>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={rows} margin={MARGIN} syncId="halo-analytics-co">
          <CartesianGrid {...gridProps()} />
          <XAxis {...timeAxisProps(domain, ticks)} />
          <YAxis {...yAxisProps({ domain: coAxis.domain, ticks: coAxis.ticks, allowDecimals: false, tickFormatter: compactTick })} />
          <Tooltip content={tooltip} cursor={lineCursor()} isAnimationActive={false} />
          <ReferenceLine y={CO_REL_PPM} stroke={SERIES.warnLine} strokeDasharray="4 3" ifOverflow="extendDomain" label={refLineLabel(`${CO_REL_PPM} ppm (P1)`)} />
          <ReferenceLine y={CO_CEILING_PPM} stroke={SERIES.critLine} strokeDasharray="4 3" ifOverflow="extendDomain" label={refLineLabel(`${CO_CEILING_PPM} ppm (P0)`)} />
          <Line type="linear" dataKey="coMax" stroke={SERIES.coMax} strokeWidth={1.5} dot={dot.coMax} activeDot={activeDot(SERIES.coMax)} isAnimationActive={false} />
          <Line type="linear" dataKey="co" stroke={SERIES.coAvg} strokeWidth={2} dot={dot.co} activeDot={activeDot(SERIES.coAvg)} isAnimationActive={false} />
          <Line type="linear" dataKey="twa" stroke={SERIES.twa} strokeWidth={2} dot={dot.twa} activeDot={activeDot(SERIES.twa)} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={panelLabel()}>Cumulative CO dose, ppm·min</div>
      {hasDose ? (
        <ResponsiveContainer width="100%" height={130}>
          <ComposedChart data={rows} margin={MARGIN} syncId="halo-analytics-co">
            <CartesianGrid {...gridProps()} />
            <XAxis {...timeAxisProps(domain, ticks)} />
            <YAxis {...yAxisProps({ domain: doseAxis.domain, ticks: doseAxis.ticks, tickFormatter: compactTick })} />
            <Tooltip content={tooltip} cursor={lineCursor()} isAnimationActive={false} />
            <Area type="linear" dataKey="dose" stroke={SERIES.dose} strokeWidth={2} fill={SERIES.dose} fillOpacity={0.1} isAnimationActive={false} activeDot={activeDot(SERIES.dose)} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : <EmptyNote>No CO dose in this window.</EmptyNote>}
    </ChartCard>
  );
});

// ─── 6. ACTIVITY INTENSITY ───────────────────────────────────────────────────

const activityRowsOf = (r) => ACTIVITY_BANDS.slice().reverse().map((b) => ({
  key: b.key, label: b.label.toLowerCase(), color: chartColors().ACTIVITY_COLORS[b.key], value: `${r[b.key]} min`,
}));

export const ActivityChart = memo(function ActivityChart({ minutes, span, bandsS }) {
  useTheme();
  const { ACTIVITY_COLORS } = chartColors();
  const buckets = useMemo(() => activityBuckets(minutes), [minutes]);
  const share = useMemo(() => {
    const total = bandsS ? bandsS.reduce((s, x) => s + (x || 0), 0) : 0;
    return ACTIVITY_BANDS.map((b, i) => ({
      key: b.key,
      label: b.label,
      color: ACTIVITY_COLORS[b.key],
      minutes: bandsS ? (bandsS[i] || 0) / 60 : 0,
      pct: total > 0 ? ((bandsS[i] || 0) / total) * 100 : 0,
    }));
  }, [bandsS, ACTIVITY_COLORS]);
  const pieData = share.filter((s) => s.minutes > 0);
  const table = {
    columns: [
      { key: 'label', label: '10 min from' },
      ...ACTIVITY_BANDS.map((b) => ({ key: b.key, label: `${b.label} (min)` })),
    ],
    rows: buckets.map((b) => ({ ...b, key: b.t })),
  };
  const has = buckets.some((b) => b.n > 0);
  return (
    <ChartCard title="Activity intensity" subtitle={span} table={table}
      legend={ACTIVITY_BANDS.map((b) => ({ label: b.label, color: ACTIVITY_COLORS[b.key], kind: 'bar' }))}
      empty={has ? null : 'No activity data in this window.'}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <div style={panelLabel()}>Minutes per band, 10-minute buckets</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={buckets} margin={MARGIN} barCategoryGap="15%">
              <CartesianGrid {...gridProps()} />
              <XAxis dataKey="label" tick={axisTick()} tickLine={false} axisLine={{ stroke: T.borderMid }} interval="preserveStartEnd" minTickGap={16} height={X_AXIS_HEIGHT} />
              <YAxis {...yAxisProps({ allowDecimals: false, domain: [0, 10], ticks: [0, 5, 10] })} />
              <Tooltip cursor={barCursor()} isAnimationActive={false}
                content={<BarTooltip title={(r) => `${r.label}–${fmtHM(r.t + 10 * 60 * 1000)}`} rowsOf={activityRowsOf} />} />
              {ACTIVITY_BANDS.map((b) => (
                <Bar key={b.key} dataKey={b.key} stackId="act" fill={ACTIVITY_COLORS[b.key]} maxBarSize={24} stroke={T.bg2} strokeWidth={2} isAnimationActive={false}>
                  {buckets.map((bucket) => <Cell key={bucket.t} radius={bucket.top === b.key ? [4, 4, 0, 0] : 0} />)}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {pieData.length ? (
            <PieChart width={120} height={120}>
              <Pie data={pieData} dataKey="minutes" nameKey="label" cx="50%" cy="50%" innerRadius={34} outerRadius={56}
                stroke={T.bg2} strokeWidth={2} startAngle={90} endAngle={-270} isAnimationActive={false}>
                {pieData.map((s) => <Cell key={s.key} fill={s.color} />)}
              </Pie>
            </PieChart>
          ) : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.sm, ...NUM }}>
            {share.slice().reverse().map((s) => (
              <li key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                <span style={{ color: T.text, minWidth: 70 }}>{s.label}</span>
                <span style={{ color: T.textStrong, fontWeight: 600 }}>{Math.round(s.pct)}%</span>
                <span style={{ color: T.textDim }}>{fmtMinutes(s.minutes)} min</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ChartCard>
  );
});
