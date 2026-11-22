// Small presentational building blocks shared by the live views. Device-supplied strings are
// always passed as children (JSX text), never as markup.

import React from 'react';
import { T } from '../theme';
import { clamp, isNum } from '../lib/num';

export function Panel({ title, icon: Icon, meta, className, bodyClassName, children }) {
  return (
    <section className={`panel ${className || ''}`}>
      <header className="panel-head">
        <h2 className="panel-title">
          {Icon ? <Icon size={14} aria-hidden="true" /> : null}
          {title}
        </h2>
        {meta ? <div className="panel-meta">{meta}</div> : null}
      </header>
      <div className={bodyClassName || 'panel-body'}>{children}</div>
    </section>
  );
}

export function Card({ title, icon: Icon, meta, children, className }) {
  return (
    <div className={`card ${className || ''}`}>
      {title || meta ? (
        <div className="card-head">
          <span className="card-title">
            {Icon ? <Icon size={14} aria-hidden="true" /> : null}
            {title}
          </span>
          {meta ? <span className="card-meta">{meta}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Row({ label, value, note, color, title }) {
  return (
    <div className="row" title={title}>
      <span className="row-label">{label}</span>
      <span className="row-value" style={color ? { color } : undefined}>
        {value}
        {note ? <span className="row-note">{note}</span> : null}
      </span>
    </div>
  );
}

export function Badge({ color, bg, border, title, children }) {
  return (
    <span className="badge" title={title} style={{ color, background: bg, borderColor: border || color }}>
      {children}
    </span>
  );
}

export function SeverityChip({ sev }) {
  if (!sev) return null;
  return (
    <span className="sev-chip" style={{ color: sev.color, background: sev.bg, borderColor: sev.fill }}>
      {sev.label}
    </span>
  );
}

// Sentinel notes are dim, except the MQ warm-up, which is shown in amber.
const noteColor = (v) => (v.state === 'warming' ? T.amber : T.textDim);

// Value tile used in the responder card: label, number + unit, and a sentinel note when needed.
// The big "CAL" already says calibrating, and a 1440 px card is too narrow for "CALIBRATING".
export function Tile({ label, v, unit, color, title }) {
  const note = v.state === 'cal' ? null : v.note;
  return (
    <div title={title}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        <span className="tile-num" style={{ color: v.value === null ? T.textDim : color || T.textStrong }}>
          {v.text}
        </span>
        {v.value !== null && unit ? <span className="tile-unit">{unit}</span> : null}
      </div>
      {note ? (
        <div className="tile-note" style={{ color: noteColor(v) }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

// Bigger value block for the deep-dive tabs.
export function Stat({ label, v, unit, band, big, extra }) {
  const color = v.value === null ? T.textDim : band ? band.color : T.textStrong;
  const note = v.note || (band ? band.label : null);
  let nColor = T.textMuted;
  if (v.note) nColor = noteColor(v);
  else if (band && band.level > 0) nColor = band.color;
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`stat-num${big ? ' is-big' : ''}`} style={{ color }}>
        {v.text}
        {v.value !== null && unit ? <span className="stat-unit">{unit}</span> : null}
      </span>
      {note ? (
        <span className="stat-note" style={{ color: nColor }}>
          {note}
        </span>
      ) : null}
      {extra}
    </div>
  );
}

export function Banner({ tone, icon: Icon, live, children }) {
  return (
    <div className={`banner banner-${tone}${live ? ' is-live' : ''}`} role={tone === 'p0' ? 'alert' : undefined}>
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      <span>{children}</span>
    </div>
  );
}

export function Empty({ title, children, spinner }) {
  return (
    <div className="empty">
      {spinner ? <div className="spinner" aria-hidden="true" /> : null}
      {title ? <div className="empty-title">{title}</div> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function Flag({ on, warn, children, title }) {
  let cls = 'flag';
  if (warn) cls += ' is-warn';
  else if (on === true) cls += ' is-ok';
  else if (on === false) cls += ' is-off';
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

// Fill colour of the zone a value falls in (zones ascending; a value equal to `to` is in that zone,
// matching the backend's strict ">" thresholds). Values above the last zone use its colour.
export function zoneFill(value, zones) {
  if (!zones.length) return T.grayFill;
  if (!isNum(value)) return T.grayFill;
  const zone = zones.find((z) => value <= z.to);
  return zone ? zone.fill : zones[zones.length - 1].fill;
}

// Horizontal gauge with coloured zones. zones: [{ to, fill }] in ascending order up to max.
// The filled part uses the colour of the zone the value is in, so it always matches the number.
// `fill` overrides the zone colour (used when another rule, e.g. CO saturation, sets the band).
export function BandGauge({ value, max, zones, ticks, label, fill }) {
  const v = isNum(value) ? clamp(value, 0, max) : 0;
  const valueFill = fill || zoneFill(value, zones);
  let from = 0;
  return (
    <div className="gauge" role="img" aria-label={label}>
      <div className="gauge-track">
        {zones.map((z) => {
          const width = ((Math.min(z.to, max) - from) / max) * 100;
          from = Math.min(z.to, max);
          return <div key={z.to} className="gauge-zone" style={{ width: `${Math.max(0, width)}%`, background: z.fill }} />;
        })}
        {isNum(value) ? <div className="gauge-fill" style={{ width: `${(v / max) * 100}%`, background: valueFill }} /> : null}
      </div>
      <div className="gauge-ticks" aria-hidden="true">
        {(ticks || []).map((t) => (
          <span key={t} style={{ left: `${(t / max) * 100}%` }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
