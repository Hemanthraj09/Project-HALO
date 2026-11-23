// Presentational pieces shared by the analytics charts: cards, legend, tooltips, KPI tiles,
// controls and notices. Text from the database (ids, method strings) is rendered as JSX text only.

import { memo, useState } from 'react';
import { AlertTriangle, Info, RefreshCw, Table2 } from 'lucide-react';
import { T, FONT, FS, RADIUS, SHADOW, SEVERITY } from '../theme';
import { fmtDate, fmtHM } from './metrics';

export const NUM = { fontVariantNumeric: 'tabular-nums' };

const cardStyle = {
  background: T.bg2,
  border: `1px solid ${T.border}`,
  borderRadius: RADIUS.md,
  boxShadow: SHADOW.card,
  padding: 16,
  minWidth: 0,
};

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  border: `1px solid ${T.borderMid}`,
  borderRadius: RADIUS.sm,
  background: T.bg2,
  color: T.text,
  fontFamily: FONT.ui,
  fontSize: FS.sm,
  fontWeight: 500,
  cursor: 'pointer',
};

export function Card({ title, icon: Icon, children, style }) {
  return (
    <section style={{ ...cardStyle, ...style }} aria-label={title}>
      {title && (
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', fontSize: FS.lg, fontWeight: 600, color: T.textStrong }}>
          {Icon && <Icon size={16} color={T.textMuted} aria-hidden="true" />}
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

// A chart card: title, subtitle, legend, and the plot (or its table view).
// `empty` replaces the plot with a one-line note when there is nothing to draw.
export function ChartCard({ title, subtitle, legend, table, empty, children, style }) {
  const [showTable, setShowTable] = useState(false);
  const canTable = Boolean(table && table.rows && table.rows.length) && !empty;
  return (
    <section style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8, ...style }} aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: FS.lg, fontWeight: 600, color: T.textStrong }}>{title}</h3>
          {subtitle && <div style={{ marginTop: 2, fontSize: FS.sm, color: T.textDim, ...NUM }}>{subtitle}</div>}
        </div>
        {canTable && (
          <button type="button" style={buttonStyle} aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
            <Table2 size={14} aria-hidden="true" />
            {showTable ? 'Chart' : 'Table'}
          </button>
        )}
      </div>
      {legend && legend.length > 0 && !empty && !showTable && <Legend items={legend} />}
      {empty ? <EmptyNote>{empty}</EmptyNote> : (showTable && canTable ? <TableView {...table} caption={title} /> : children)}
    </section>
  );
}

export function EmptyNote({ children }) {
  return (
    <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: FS.md, color: T.textDim, background: T.bg3, borderRadius: RADIUS.sm }}>
      {children}
    </div>
  );
}

// Legend swatches mirror the mark: a stroke for lines, a block for bars/areas, a dashed stroke
// for reference lines.
function Swatch({ color, kind, opacity }) {
  if (kind === 'line' || kind === 'thin' || kind === 'ref') {
    return (
      <svg width="18" height="10" aria-hidden="true" style={{ flexShrink: 0 }}>
        <line x1="1" y1="5" x2="17" y2="5" stroke={color} strokeWidth={kind === 'thin' ? 1.5 : 2}
          strokeDasharray={kind === 'ref' ? '4 3' : undefined} strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <span aria-hidden="true" style={{
      width: 12, height: 12, borderRadius: 3, flexShrink: 0, background: color,
      opacity: opacity == null ? 1 : opacity, border: kind === 'band' ? `1px solid ${T.borderMid}` : 'none',
    }} />
  );
}

export function Legend({ items }) {
  return (
    <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', margin: 0, padding: 0, listStyle: 'none' }}>
      {items.map((it) => (
        <li key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.xs, color: T.textMuted }}>
          <Swatch color={it.color} kind={it.kind} opacity={it.opacity} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// Table view of a chart (the accessible twin). columns: [{ key, label, fmt? }].
export function TableView({ caption, columns, rows }) {
  return (
    <div style={{ maxHeight: 300, overflow: 'auto', border: `1px solid ${T.border}`, borderRadius: RADIUS.sm }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.sm, ...NUM }}>
        <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c.key} scope="col" style={{
                position: 'sticky', top: 0, background: T.bg3, color: T.textMuted, fontWeight: 600,
                textAlign: i === 0 ? 'left' : 'right', padding: '6px 10px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.key || r.t || ri} style={{ background: ri % 2 ? T.bg3 : T.bg2 }}>
              {columns.map((c, i) => {
                const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
                return (
                  <td key={c.key} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '4px 10px', color: T.text, whiteSpace: 'nowrap' }}>
                    {v === null || v === undefined || v === '' ? '--' : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const tooltipBox = {
  background: T.bg2,
  border: `1px solid ${T.borderMid}`,
  borderRadius: RADIUS.sm,
  boxShadow: SHADOW.pop,
  padding: '8px 10px',
  fontFamily: FONT.ui,
  fontSize: FS.sm,
  color: T.text,
  minWidth: 150,
  ...NUM,
};

function TooltipRow({ color, kind, value, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 1.6 }}>
      <Swatch color={color} kind={kind || 'line'} />
      <span style={{ fontWeight: 600, color: T.textStrong }}>{value}</span>
      <span style={{ color: T.textMuted }}>{label}</span>
    </div>
  );
}

// Tooltip for the time charts. Lists every series at the hovered minute, value first.
// series: [{ key, label, color | colorOf(row), kind, fmt(value, row) -> string }]
export function TimeTooltip({ active, payload, series, withDate }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0] && payload[0].payload;
  if (!row || row.gap) return null;
  return (
    <div style={tooltipBox}>
      <div style={{ fontWeight: 600, color: T.textStrong, marginBottom: 4 }}>
        {withDate ? `${fmtDate(row.t)} ` : ''}{fmtHM(row.t)}
      </div>
      {series.map((s) => (
        <TooltipRow key={s.key} color={s.colorOf ? s.colorOf(row) : s.color} kind={s.kind} label={s.label}
          value={s.fmt(row[s.key], row)} />
      ))}
    </div>
  );
}

// Tooltip for category bars. rowsOf(row) -> [{ key, label, color, kind, value }]; title(row) -> string.
export function BarTooltip({ active, payload, title, rowsOf }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0] && payload[0].payload;
  if (!row) return null;
  return (
    <div style={tooltipBox}>
      <div style={{ fontWeight: 600, color: T.textStrong, marginBottom: 4 }}>{title(row)}</div>
      {rowsOf(row).map((r) => <TooltipRow key={r.key} color={r.color} kind={r.kind || 'bar'} label={r.label} value={r.value} />)}
    </div>
  );
}

export function StatusChip({ level, text }) {
  const sev = level === 'critical' ? SEVERITY[0] : SEVERITY[1];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px', borderRadius: RADIUS.sm,
      background: sev.bg, color: sev.color, fontSize: FS.xs, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <AlertTriangle size={12} aria-hidden="true" />
      {text}
    </span>
  );
}

// One KPI tile, a list item of KpiGrid. It spans three rows of the grid as a subgrid (label row,
// value, sub-line), so values and sub-lines line up across a row of tiles even when one label row
// wraps. A status chip that does not fit beside the label wraps under it instead of squeezing it.
export const KpiTile = memo(function KpiTile({ tile }) {
  return (
    <div role="listitem" style={{
      ...cardStyle, padding: '12px 14px', display: 'grid', gridRow: 'span 3', gridTemplateRows: 'subgrid', rowGap: 4, alignContent: 'start',
    }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', alignContent: 'flex-start', justifyContent: 'space-between', gap: '4px 6px', minHeight: 18,
      }}>
        <span style={{ flex: '1 0 auto', maxWidth: '100%', fontSize: FS.sm, fontWeight: 500, color: T.textMuted }}>{tile.label}</span>
        {tile.status && <StatusChip level={tile.status.level} text={tile.status.text} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, color: T.textStrong, ...NUM }}>
        <span style={{ fontSize: FS.xxl, fontWeight: 600, lineHeight: 1.15 }}>{tile.value}</span>
        {tile.unit && <span style={{ fontSize: FS.sm, color: T.textDim }}>{tile.unit}</span>}
      </div>
      <div style={{ fontSize: FS.xs, lineHeight: 1.4, color: T.textDim, ...NUM }}>{tile.sub}</div>
    </div>
  );
});

// The KPI row: a list of KpiTile.
export function KpiGrid({ tiles }) {
  return (
    <div role="list" aria-label="Key figures"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', columnGap: 12, rowGap: 12 }}>
      {tiles.map((k) => <KpiTile key={k.id} tile={k} />)}
    </div>
  );
}

// Two-button (or more) toggle. options: [{ value, label, disabled? }]
export function Segmented({ label, options, value, onChange }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-flex', border: `1px solid ${T.borderMid}`, borderRadius: RADIUS.sm, overflow: 'hidden' }}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} disabled={o.disabled} onClick={() => onChange(o.value)}
            style={{
              height: 28, padding: '0 12px', border: 'none', borderLeft: i ? `1px solid ${T.borderMid}` : 'none',
              background: on ? T.blueBg : T.bg2, color: on ? T.blue : T.text, fontFamily: FONT.ui, fontSize: FS.sm,
              fontWeight: on ? 600 : 500, cursor: o.disabled ? 'not-allowed' : 'pointer', opacity: o.disabled ? 0.6 : 1,
            }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Labelled native select. options: [{ value, label }]
export function SelectField({ label, value, options, onChange, disabled, minWidth }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: FS.sm, color: T.textMuted }}>
      {label}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        style={{
          height: 28, minWidth: minWidth || 0, maxWidth: '100%', padding: '0 8px', border: `1px solid ${T.borderMid}`,
          borderRadius: RADIUS.sm, background: T.bg2, color: T.text, fontFamily: FONT.ui, fontSize: FS.sm, ...NUM,
        }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Notice({ kind, title, children, action }) {
  const tone = kind === 'error'
    ? { color: T.red, bg: T.redBg, Icon: AlertTriangle }
    : { color: T.blue, bg: T.blueBg, Icon: Info };
  const { Icon } = tone;
  return (
    <div role={kind === 'error' ? 'alert' : 'status'}
      style={{ ...cardStyle, display: 'flex', gap: 12, alignItems: children || action ? 'flex-start' : 'center' }}>
      <span style={{ display: 'inline-flex', padding: 6, borderRadius: RADIUS.sm, background: tone.bg }}>
        <Icon size={18} color={tone.color} aria-hidden="true" />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: FS.lg, fontWeight: 600, color: T.textStrong }}>{title}</div>
        {children && <div style={{ marginTop: 4, fontSize: FS.md, lineHeight: 1.5, color: T.text }}>{children}</div>}
        {action && <div style={{ marginTop: 12 }}>{action}</div>}
      </div>
    </div>
  );
}

export function RetryButton({ onClick }) {
  return (
    <button type="button" style={buttonStyle} onClick={onClick}>
      <RefreshCw size={14} aria-hidden="true" />
      Retry
    </button>
  );
}
