// Trail of the selected responder from readings/<id> (gps_ok points only, GPS jitter merged by
// buildTrail): polyline segments coloured by CO band, with small dots on trail points where CO
// went above 35 ppm (hover shows the highest value there and when it was read).

import React, { useMemo } from 'react';
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet';
import { useTheme } from '../lib/themeMode';
import { fmtStamp } from '../lib/time';
import { buildTrail, TOOLTIP_PANE } from './mapData';

function TrailLayer({ readings }) {
  const { tokens } = useTheme();
  const trail = useMemo(() => buildTrail(readings, tokens), [readings, tokens]);
  return (
    <>
      {trail.lines.map((l, i) => {
        // Index keys: the trail is rebuilt every reading and reused layers are updated in place.
        const style = { color: l.color, weight: 4, opacity: 0.85, lineCap: 'round', lineJoin: 'round' };
        return <Polyline key={`seg-${i}`} positions={l.positions} interactive={false} {...style} pathOptions={style} />;
      })}
      {trail.dots.map((d) => {
        const style = { color: d.color, weight: 1, fillColor: d.color, fillOpacity: 1 };
        return (
          <CircleMarker key={d.key} center={[d.lat, d.lon]} radius={4} {...style} pathOptions={style}>
            <Tooltip pane={TOOLTIP_PANE} direction="top">
              CO {d.sat ? '≥' : ''}
              {Math.round(d.co)} ppm at {d.t !== null ? fmtStamp(d.t) : 'unknown time'}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

export default React.memo(TrailLayer);
