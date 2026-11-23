// Responder tooltip / popup body. Uses the same formatters as the cards, so sentinels read the
// same everywhere. All device data is rendered as JSX text.

import React from 'react';
import { T } from '../theme';
import { aqValue, coValue, heatIndexValue, ppgValue } from '../lib/format';
import { bearingDeg, fmtBearing, fmtDistance, gpsState, haversineM, validLatLon } from '../lib/geo';
import { imuDown } from '../lib/sensors';
import { aqBand, coBand, heatBand, hrBand, spo2Band } from '../lib/thresholds';
import { recordMs } from '../lib/time';
import StatusBadge from '../components/StatusBadge';
import { Age } from '../components/TimeText';
import { SatsNote } from '../components/ui';

function Val({ v, unit, band }) {
  if (v.state === 'warming') return <span style={{ color: T.amber, fontWeight: 600 }}>{v.note}</span>;
  const color = v.value === null ? T.textDim : band && band.level > 0 ? band.color : T.textStrong;
  return (
    <span style={{ color }}>
      {v.text}
      {v.value !== null && unit ? ` ${unit}` : ''}
      {v.note ? ` (${v.note})` : ''}
    </span>
  );
}

export default function ResponderInfo({ id, r, st, cp }) {
  const hr = ppgValue(r, 'hr');
  const spo2 = ppgValue(r, 'spo2');
  const co = coValue(r);
  const hi = heatIndexValue(r, 1);
  const aq = aqValue(r);
  const g = gpsState(r, st.lost);
  const packetMs = recordMs(r);
  const toCp = cp && validLatLon(r.lat, r.lon) ? { d: haversineM(r.lat, r.lon, cp[0], cp[1]), b: bearingDeg(r.lat, r.lon, cp[0], cp[1]) } : null;
  return (
    <div className="map-info">
      <div className="map-info-head">
        <span className="map-info-id">{id}</span>
        <StatusBadge st={st} since={packetMs} align="start" />
      </div>
      <dl className="map-info-grid">
        <dt>HR</dt>
        <dd>
          <Val v={hr} unit="bpm" band={hrBand(hr.value)} />
        </dd>
        <dt>SpO₂</dt>
        <dd>
          <Val v={spo2} unit="%" band={spo2Band(spo2.value)} />
        </dd>
        <dt>CO</dt>
        <dd>
          <Val v={co} unit="ppm" band={coBand(co.value, r.co_sat)} />
        </dd>
        <dt>Heat idx</dt>
        <dd>
          <Val v={hi} unit="°C" band={heatBand(hi.value)} />
        </dd>
        <dt>AQI</dt>
        <dd>
          <Val v={aq} band={aqBand(aq.value)} />
        </dd>
        <dt>GPS</dt>
        <dd>
          {g.kind === 'fresh' ? g.text : null}
          {g.kind === 'fresh' && g.fixMs !== null ? <Age since={g.fixMs} prefix=" · fix " suffix=" old" /> : null}
          {g.kind === 'stale' && g.fixMs !== null ? <Age since={g.fixMs} prefix="last fix " suffix=" ago" /> : null}
          {g.kind === 'stale' && g.fixMs === null ? 'stale fix' : null}
          {g.kind === 'none' ? g.text : null}
          <SatsNote sats={g.sats} />
        </dd>
        {toCp ? (
          <>
            <dt>To CP</dt>
            <dd>
              {fmtDistance(toCp.d)}, bearing {fmtBearing(toCp.b)}
            </dd>
          </>
        ) : null}
      </dl>
      {r.fall === true ? <div style={{ color: T.red, fontWeight: 700 }}>FALL DETECTED</div> : null}
      {r.arm_ok === false ? <div style={{ color: T.amber, fontWeight: 600 }}>ARM OFFLINE</div> : null}
      {imuDown(r) ? <div style={{ color: T.amber, fontWeight: 600 }}>IMU OFFLINE</div> : null}
    </div>
  );
}
