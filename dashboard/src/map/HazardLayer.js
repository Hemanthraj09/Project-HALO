// Hazard overlays from hazards/. Each zone is a circle of radius
// max(acc_m, 20 m) around the point where a responder measured the hazard. Active zones that are
// still being updated pulse; cleared ones are lighter; a stale GPS position draws dashed.
// Hazard names show on hover only: the backend opens hazards at the responder's own position, so
// permanent labels would stack on the responder's label.

import React, { useMemo } from 'react';
import { Circle, Marker, Popup, Tooltip } from 'react-leaflet';
import { SEVERITY, T } from '../theme';
import { fmtHazardValue, HAZARD_META, hazardLabel, hazardRadius, isHazardLive } from '../lib/hazards';
import { fmtDuration, fmtStamp } from '../lib/time';
import { HAZARD_ICONS, sidePinIcon } from './mapIcons';
import { hazardStyle, layoutPins, POPUP_PANE, TOOLTIP_PANE } from './mapData';

const stamp = (ms) => (ms === null ? '--' : fmtStamp(ms));

function shortText(h) {
  const meta = HAZARD_META[h.type];
  const name = meta ? meta.short : h.type;
  return h.type === 'FALL' ? name : `${name} ${fmtHazardValue(h.type, h.peak, h.sat)}`;
}

export function HazardInfo({ h, now }) {
  const sev = SEVERITY[h.severity];
  const live = isHazardLive(h, now);
  let status = 'CLEARED';
  if (h.active) status = live ? 'ACTIVE' : 'ACTIVE · NO UPDATE 2 MIN';
  const spanS = h.startMs !== null && h.lastMs !== null ? (h.lastMs - h.startMs) / 1000 : null;
  return (
    <div className="map-info">
      <div className="map-info-head">
        <span className="map-info-id">{hazardLabel(h.type)}</span>
        <span className="sev-chip" style={{ color: sev.color, background: sev.bg, borderColor: sev.fill }}>
          {sev.label}
        </span>
        <span className="label" style={{ color: h.active ? T.textStrong : T.textDim }}>
          {status}
        </span>
      </div>
      <dl className="map-info-grid">
        {h.type !== 'FALL' ? (
          <>
            <dt>Peak</dt>
            <dd>{fmtHazardValue(h.type, h.peak, h.sat)}</dd>
          </>
        ) : null}
        {h.type !== 'FALL' && h.value !== null && h.value !== h.peak ? (
          <>
            <dt>Latest</dt>
            <dd>{fmtHazardValue(h.type, h.value, h.sat)}</dd>
          </>
        ) : null}
        <dt>Time</dt>
        <dd>
          {stamp(h.startMs)} – {stamp(h.lastMs)}
          {spanS !== null && spanS > 0 ? ` · ${fmtDuration(spanS)}` : ''}
        </dd>
        <dt>Responder</dt>
        <dd>{h.responderId || '--'}</dd>
        <dt>Zone</dt>
        <dd>
          {Math.round(hazardRadius(h))} m radius
          {h.posStale ? ' · stale fix' : ''}
        </dd>
      </dl>
    </div>
  );
}

const HazardZone = React.memo(function HazardZone({ h, now }) {
  const live = isHazardLive(h, now);
  const style = hazardStyle(h, live);
  const center = useMemo(() => [h.lat, h.lon], [h.lat, h.lon]);
  return (
    <Circle
      center={center}
      radius={hazardRadius(h)}
      className={live ? 'map-hz-pulse' : undefined}
      {...style}
      pathOptions={style}
    >
      <Tooltip pane={TOOLTIP_PANE} direction="top" offset={[0, -6]}>
        <span style={{ color: style.color, fontWeight: 700 }}>{shortText(h)}</span>
        {h.active ? null : <span> (cleared)</span>}
      </Tooltip>
      <Popup pane={POPUP_PANE}>
        <HazardInfo h={h} now={now} />
      </Popup>
    </Circle>
  );
});

// Circles, in the hazard pane. `hazards` is already filtered by the time window.
export function HazardZones({ hazards, now }) {
  return hazards.map((h) => <HazardZone key={`${h.key}-${isHazardLive(h, now) ? 'l' : 's'}`} h={h} now={now} />);
}

// Pins for possible fire (flame), fall and no motion, in the pane just below the responders.
// Pins that share a point fan out (layoutPins); cleared pins stay under active ones.
export function HazardPins({ hazards, now }) {
  const pins = useMemo(() => layoutPins(hazards), [hazards]);
  return pins.map(({ h, slot }) => (
    <Marker
      key={h.key}
      position={[h.lat, h.lon]}
      icon={slot === 0 ? HAZARD_ICONS[h.type] : sidePinIcon(h.type, slot)}
      opacity={h.active ? 1 : 0.5}
      zIndexOffset={h.active ? 0 : -1000}
    >
      <Tooltip pane={TOOLTIP_PANE} direction="top">
        {hazardLabel(h.type)}
        {h.active ? '' : ' (cleared)'}
      </Tooltip>
      <Popup pane={POPUP_PANE}>
        <HazardInfo h={h} now={now} />
      </Popup>
    </Marker>
  ));
}
