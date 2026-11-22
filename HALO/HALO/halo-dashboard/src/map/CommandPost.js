// Draggable command-post marker. Its position lives in localStorage (see MapPanel). The popup
// lists every positioned responder with distance and bearing from the CP. MapPanel renders it in
// its own pane under the responder markers, so a CP on a responder never hides that responder.

import React, { useMemo } from 'react';
import { Marker, Popup, Tooltip } from 'react-leaflet';
import { bearingDeg, fmtBearing, fmtDistance, haversineM, validLatLon } from '../lib/geo';
import { CP_ICON } from './mapIcons';
import { POPUP_PANE, TOOLTIP_PANE } from './mapData';

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function CommandPost({ cp, onMove, responders }) {
  const handlers = useMemo(
    () => ({
      dragend: (e) => {
        const ll = e.target.getLatLng();
        if (validLatLon(ll.lat, ll.lng)) onMove([round6(ll.lat), round6(ll.lng)]);
      },
    }),
    [onMove],
  );
  const rows = Object.keys(responders)
    .filter((id) => validLatLon(responders[id].lat, responders[id].lon))
    .sort()
    .map((id) => {
      const r = responders[id];
      return { id, d: haversineM(cp[0], cp[1], r.lat, r.lon), b: bearingDeg(cp[0], cp[1], r.lat, r.lon) };
    });
  return (
    <Marker position={cp} icon={CP_ICON} draggable eventHandlers={handlers} zIndexOffset={1000} keyboard={false}>
      <Tooltip pane={TOOLTIP_PANE} direction="top">Command post</Tooltip>
      <Popup pane={POPUP_PANE}>
        <div className="map-info">
          <div className="map-info-head">
            <span className="map-info-id">Command post</span>
          </div>
          {rows.length ? (
            <dl className="map-info-grid">
              {rows.map((row) => (
                <React.Fragment key={row.id}>
                  <dt>{row.id}</dt>
                  <dd>
                    {fmtDistance(row.d)} at {fmtBearing(row.b)}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          ) : (
            <div className="note">No responder position yet.</div>
          )}
        </div>
      </Popup>
    </Marker>
  );
}

export default React.memo(CommandPost);
