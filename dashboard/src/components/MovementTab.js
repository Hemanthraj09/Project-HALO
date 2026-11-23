// MOVEMENT tab: fall state, the NO MOTION (man-down) timer, activity level with its cut-point
// band, acceleration, and the GPS position.
// Fall and man-down detection run on the arm's MPU6050, so they are unavailable when the arm
// strap is offline (arm_ok false) or its IMU is down (sensors.imu false).

import React from 'react';
import { Activity, Footprints, Hourglass, MapPin, Siren } from 'lucide-react';
import { FS, T } from '../theme';
import { armValue } from '../lib/format';
import { fmtLatLon, gpsState } from '../lib/geo';
import { isNum } from '../lib/num';
import { imuDown } from '../lib/sensors';
import { noMotionState } from '../lib/status';
import { activityBand, stillBand, TH } from '../lib/thresholds';
import { fmtAgo } from '../lib/time';
import TimeChart from './TimeChart';
import { Age } from './TimeText';
import { BandGauge, Card, Flag, Row, Stat } from './ui';

// Constant props keep the memoised charts from re-rendering on every packet.
const FROM_ZERO = [0, 'auto'];
const ACT_SERIES = [{ key: 'act', name: 'Activity', color: T.blueFill, unit: 'mg', digits: 0 }];
const ACT_BANDS = [
  { y1: TH.ACT_LIGHT, y2: TH.ACT_MODERATE, fill: T.blueFill, opacity: 0.05 },
  { y1: TH.ACT_MODERATE, y2: TH.ACT_VIGOROUS, fill: T.blueFill, opacity: 0.1 },
  { y1: TH.ACT_VIGOROUS, y2: 2000, fill: T.blueFill, opacity: 0.16 },
];
const ACCEL_SERIES = [{ key: 'accel', name: '|a|', color: T.purpleFill, unit: 'g', digits: 2 }];
const STILL_ZONES = [
  { to: TH.STILL_P1, fill: T.greenFill },
  { to: TH.STILL_P0, fill: T.amberFill },
  { to: 90, fill: T.redFill },
];

const FIX_TEXT = { fresh: 'fresh', stale: 'stale', none: 'no fix' };
const FIX_COLOR = { fresh: T.green, stale: T.amber, none: T.textDim };

// 'ARM OFFLINE' / 'IMU OFFLINE' when fall and man-down detection cannot run, else null.
function detectionDown(r) {
  if (r.arm_ok === false) return 'ARM OFFLINE';
  if (imuDown(r)) return 'IMU OFFLINE';
  return null;
}

function FallCard({ r }) {
  const down = detectionDown(r);
  if (down) {
    return (
      <Card title="Fall detection" icon={Siren}>
        <div className="stat-num" style={{ color: T.amber, fontSize: FS.xl }}>
          UNAVAILABLE
        </div>
        <span className="stat-note" style={{ color: T.amber }}>
          {down}
        </span>
        {r.fall === true ? <div style={{ color: T.red, fontWeight: 700 }}>FALL DETECTED (latched)</div> : null}
      </Card>
    );
  }
  return (
    <Card title="Fall detection" icon={Siren}>
      <div className="stat-num" style={{ color: r.fall === true ? T.red : T.green, fontSize: FS.xl }}>
        {r.fall === true ? 'FALL DETECTED' : 'NO FALL'}
      </div>
    </Card>
  );
}

function StillCard({ r }) {
  const still = armValue(r, 'still_s', 'imu', 0);
  const nm = noMotionState(r);
  const band = stillBand(still.value, r.skin, r.fall);
  const armed = r.skin === true || r.fall === true;
  return (
    <Card title="No motion (man-down)" icon={Hourglass}>
      <Stat
        label="Still for"
        v={{ ...still, text: still.value !== null ? fmtAgo(still.value * 1000) : still.text }}
        band={nm ? band : null}
        extra={nm ? <span className="stat-note" style={{ color: nm.severity === 0 ? T.red : T.amber }}>{nm.severity === 0 ? 'P0 MAYDAY' : 'P1 WARNING'}</span> : null}
      />
      <BandGauge value={still.value} max={90} zones={STILL_ZONES} ticks={[TH.STILL_P1, TH.STILL_P0]} label={`Still for ${still.text} s`} />
      <div className="flags">{detectionDown(r) ? <Flag warn>Timer unavailable</Flag> : <Flag on={armed}>Timer armed</Flag>}</div>
    </Card>
  );
}

export default function MovementTab({ r, series, lost }) {
  const act = armValue(r, 'activity_mg', 'imu', 0);
  const accel = armValue(r, 'accel', 'imu', 2);
  const actBand = activityBand(act.value);
  const g = gpsState(r, lost);
  return (
    <>
      <FallCard r={r} />
      <StillCard r={r} />
      <Card title="Activity" icon={Footprints} meta={series.span}>
        <Stat label="Now" v={act} unit="mg" band={act.value !== null ? actBand : null} />
        <TimeChart data={series.points} series={ACT_SERIES} yDomain={FROM_ZERO} bands={ACT_BANDS} height={100} />
      </Card>
      <Card title="Acceleration" icon={Activity} meta={series.span}>
        <Stat label="Now" v={accel} unit="g" />
        <TimeChart data={series.points} series={ACCEL_SERIES} yDomain={FROM_ZERO} height={90} />
      </Card>
      <Card title="GPS position" icon={MapPin}>
        <div className="rows">
          <Row label="Position" value={fmtLatLon(r.lat, r.lon, 6)} />
          <Row label="Fix" value={FIX_TEXT[g.kind]} color={FIX_COLOR[g.kind]} />
          <Row label="Fix age" value={g.fixMs !== null ? <Age since={g.fixMs} suffix=" ago" /> : '--'} />
          <Row label="Accuracy" value={isNum(r.gps_acc_m) ? `±${Math.round(r.gps_acc_m)} m` : '--'} />
          <Row label="GPS altitude" value={isNum(r.alt) ? `${Math.round(r.alt)} m` : '--'} />
        </div>
      </Card>
    </>
  );
}
