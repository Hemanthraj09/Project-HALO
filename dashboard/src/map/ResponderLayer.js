// Responder layers: status markers (pulsing ring at P0, grey dashed "last known" when the link is
// lost), permanent ID labels, GPS accuracy circles and the live sensing halo.

import React, { useMemo } from 'react';
import { Circle, CircleMarker, Popup, Tooltip } from 'react-leaflet';
import { useTheme } from '../lib/themeMode';
import { MARKER, T, themed } from '../theme';
import { coValue, ppgValue } from '../lib/format';
import { gpsState, validLatLon } from '../lib/geo';
import { isNum } from '../lib/num';
import { imuDown } from '../lib/sensors';
import { noMotionState, responderStatus } from '../lib/status';
import { envWorst } from '../lib/thresholds';
import { recordMs } from '../lib/time';
import { Age } from '../components/TimeText';
import { POPUP_PANE, TOOLTIP_PANE } from './mapData';
import ResponderInfo from './ResponderInfo';

const HIDDEN = { stroke: false, fill: false, opacity: 0, fillOpacity: 0 };
const ring = themed(() => ({ color: T.redFill, weight: 2, fill: false, opacity: 0.9 }));

function markerStyle(st, fresh, selected) {
  if (st.lost) {
    return { color: st.last.fill, weight: 2, dashArray: '4 3', fillColor: T.grayFill, fillOpacity: 0.5, opacity: 0.95 };
  }
  return {
    color: selected ? T.blueFill : MARKER.ring,
    weight: selected ? 3 : 2,
    dashArray: fresh ? null : '3 3',
    fillColor: st.fill,
    fillOpacity: fresh ? 0.95 : 0.55,
    opacity: 1,
  };
}

function Label({ id, r, st, fresh, packetMs }) {
  const hr = ppgValue(r, 'hr');
  const co = coValue(r);
  const still = noMotionState(r);
  const g = gpsState(r, st.lost);
  let device = null;
  if (!st.lost && r.arm_ok === false) device = 'ARM OFFLINE';
  else if (!st.lost && imuDown(r)) device = 'IMU OFFLINE';
  return (
    <div>
      <div>
        <span className="map-label-id">{id}</span> <span style={{ color: st.lost ? st.last.color : st.color, fontWeight: 600 }}>{st.lost ? 'LINK LOST' : st.label}</span>
      </div>
      {st.lost ? (
        <div>
          <Age since={packetMs} suffix=" ago" /> · last: {st.last.name}
        </div>
      ) : (
        <div>
          HR {hr.text} · CO{' '}
          {co.state === 'warming' ? (
            <span style={{ color: T.amber, fontWeight: 600 }}>{co.note}</span>
          ) : (
            `${co.text}${co.value !== null ? ' ppm' : ''}`
          )}
        </div>
      )}
      {device ? <div style={{ color: T.amber, fontWeight: 700 }}>{device}</div> : null}
      {r.fall === true ? <div style={{ color: T.red, fontWeight: 700 }}>FALL</div> : null}
      {still ? (
        <div style={{ color: still.severity === 0 ? T.red : T.amber, fontWeight: 700 }}>
          NO MOTION{still.still !== null ? ` ${Math.round(still.still)} s` : ''}
        </div>
      ) : null}
      {!st.lost && !fresh && g.fixMs !== null ? (
        <div style={{ color: T.amber }}>
          <Age since={g.fixMs} prefix="fix " suffix=" old" />
        </div>
      ) : null}
    </div>
  );
}

const ResponderMarker = React.memo(function ResponderMarker({ id, r, lost, selected, cp, showLabel, onSelect }) {
  useTheme();
  const st = responderStatus(r, lost);
  const fresh = r.gps_ok === true && !lost;
  const { lat, lon } = r;
  const center = useMemo(() => [lat, lon], [lat, lon]);
  const handlers = useMemo(() => ({ click: () => onSelect(id) }), [id, onSelect]);
  const style = markerStyle(st, fresh, selected);
  const packetMs = recordMs(r);
  return (
    <>
      {!lost && st.priority === 0 ? <CircleMarker center={center} radius={13} interactive={false} className="map-pulse-ring" {...ring()} pathOptions={ring()} /> : null}
      <CircleMarker center={center} radius={selected ? 10 : 8} {...style} pathOptions={style} eventHandlers={handlers}>
        <Tooltip pane={TOOLTIP_PANE} direction="top" offset={[0, -10]} opacity={1}>
          <ResponderInfo id={id} r={r} st={st} />
        </Tooltip>
        <Popup pane={POPUP_PANE}>
          <ResponderInfo id={id} r={r} st={st} cp={cp} />
        </Popup>
      </CircleMarker>
      {showLabel ? (
        <CircleMarker center={center} radius={0} interactive={false} {...HIDDEN} pathOptions={HIDDEN}>
          <Tooltip pane={TOOLTIP_PANE} permanent direction="bottom" offset={[0, 12]} className="map-label" opacity={0.95}>
            <Label id={id} r={r} st={st} fresh={fresh} packetMs={packetMs} />
          </Tooltip>
        </CircleMarker>
      ) : null}
    </>
  );
});

export function ResponderMarkers({ responders, lostIds, selectedId, cp, showLabels, onSelect }) {
  return Object.keys(responders)
    .filter((id) => validLatLon(responders[id].lat, responders[id].lon))
    .map((id) => (
      <ResponderMarker
        key={id}
        id={id}
        r={responders[id]}
        lost={lostIds.has(id)}
        selected={id === selectedId}
        cp={cp}
        showLabel={showLabels}
        onSelect={onSelect}
      />
    ));
}

// GPS accuracy circle (radius gps_acc_m). Dashed when the fix is not fresh.
export function AccuracyCircles({ responders, lostIds }) {
  return Object.keys(responders).map((id) => {
    const r = responders[id];
    if (!validLatLon(r.lat, r.lon) || !isNum(r.gps_acc_m) || r.gps_acc_m <= 0) return null;
    const fresh = r.gps_ok === true && !lostIds.has(id);
    const style = { color: T.blueFill, weight: 1, opacity: fresh ? 0.7 : 0.4, dashArray: fresh ? null : '4 4', fillColor: T.blueFill, fillOpacity: fresh ? 0.06 : 0.03 };
    return <Circle key={id} center={[r.lat, r.lon]} radius={r.gps_acc_m} interactive={false} {...style} pathOptions={style} />;
  });
}

// Live sensing halo: radius max(accuracy, 25 m), coloured by the worst current CO / heat index /
// AQI band at the responder (CO and AQI left out while the MQ sensors warm up). Faded and dashed
// when the link is lost or the fix is stale, because the reading then may not belong to that spot.
export function SensingHalos({ responders, lostIds }) {
  return Object.keys(responders).map((id) => {
    const r = responders[id];
    if (!validLatLon(r.lat, r.lon)) return null;
    const env = envWorst(r);
    if (!env) return null;
    const current = r.gps_ok === true && !lostIds.has(id);
    const radius = Math.max(isNum(r.gps_acc_m) ? r.gps_acc_m : 0, 25);
    const style = {
      color: env.fill,
      weight: 1,
      opacity: current ? 0.6 : 0.3,
      dashArray: current ? null : '4 4',
      fillColor: env.fill,
      fillOpacity: current ? 0.16 : 0.06,
    };
    return <Circle key={id} center={[r.lat, r.lon]} radius={radius} interactive={false} {...style} pathOptions={style} />;
  });
}
