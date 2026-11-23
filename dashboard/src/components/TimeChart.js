// Time-axis line chart (recharts). x = reading time from ts_ms, so pauses in the data show as
// gaps. Memoised: it re-renders only when its data or props change, not on the 1 s tick.

import React from 'react';
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FS, T } from '../theme';
import { isNum } from '../lib/num';
import { fmtClock, fmtHM } from '../lib/time';
import { Card } from './ui';

const TICK = { fontSize: FS.xs, fill: T.textDim };
const MARGIN_ONE_AXIS = { top: 8, right: 12, bottom: 0, left: 0 };
const MARGIN_TWO_AXES = { top: 8, right: 0, bottom: 0, left: 0 };

function ChartTip({ active, payload, label, series }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-time">{isNum(label) ? fmtClock(label) : ''}</div>
      {payload.map((p) => {
        const s = series.find((x) => x.key === p.dataKey);
        if (!s || !isNum(p.value)) return null;
        return (
          <div key={p.dataKey} className="chart-tip-row">
            <span className="chart-tip-swatch" style={{ background: s.color }} />
            <span>
              {s.name}: <strong>{p.value.toFixed(s.digits === undefined ? 1 : s.digits)}</strong> {s.unit || ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// series: [{ key, name, color, unit, digits, axis: 'left'|'right', dashed }]
// refLines: [{ y, label, color, overflow }]   bands: [{ y1, y2, fill, opacity }]
function TimeChart({ data, series, height = 120, yDomain, yDomainRight, refLines, bands }) {
  const hasValues = data.some((p) => series.some((s) => isNum(p[s.key])));
  if (data.length < 2 || !hasValues) {
    return (
      <div className="chart-empty" style={{ height }}>
        {data.length < 2 ? 'Not enough readings for a chart yet' : 'No values in this window'}
      </div>
    );
  }
  const spanMs = data[data.length - 1].t - data[0].t;
  const tickFormatter = spanMs < 10 * 60 * 1000 ? fmtClock : fmtHM;
  const hasRight = series.some((s) => s.axis === 'right');
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={hasRight ? MARGIN_TWO_AXES : MARGIN_ONE_AXIS}>
        <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={tickFormatter}
          tick={TICK}
          stroke={T.borderMid}
          tickLine={false}
          minTickGap={56}
        />
        <YAxis yAxisId="left" domain={yDomain || ['auto', 'auto']} tick={TICK} stroke={T.borderMid} tickLine={false} width={40} />
        {hasRight ? (
          <YAxis yAxisId="right" orientation="right" domain={yDomainRight || ['auto', 'auto']} tick={TICK} stroke={T.borderMid} tickLine={false} width={36} />
        ) : null}
        {(bands || []).map((b) => (
          <ReferenceArea key={`band-${b.y1}-${b.y2}`} yAxisId="left" y1={b.y1} y2={b.y2} fill={b.fill} fillOpacity={b.opacity || 0.1} stroke="none" ifOverflow="hidden" />
        ))}
        {(refLines || []).map((l) => (
          <ReferenceLine
            key={`ref-${l.y}`}
            yAxisId="left"
            y={l.y}
            stroke={l.color}
            strokeDasharray="4 3"
            ifOverflow={l.overflow || 'extendDomain'}
            label={l.label ? { value: l.label, position: 'insideTopLeft', fill: l.color, fontSize: FS.xs } : undefined}
          />
        ))}
        <Tooltip content={<ChartTip series={series} />} isAnimationActive={false} />
        {series.map((s) => (
          <Line
            key={s.key}
            yAxisId={s.axis || 'left'}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={1.75}
            strokeDasharray={s.dashed ? '5 3' : undefined}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export const MemoTimeChart = React.memo(TimeChart);

// Chart in a card whose title states the real span of the plotted readings.
export function ChartCard({ title, span, note, children }) {
  return (
    <Card title={title} meta={span}>
      {children}
      {note ? <div className="note">{note}</div> : null}
    </Card>
  );
}

export default MemoTimeChart;
