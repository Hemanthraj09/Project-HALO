// Chart series from readings/<id>. The x value is the reading time (ts_ms), so gaps in the data
// show as gaps in the chart (dash-8). Sentinels (-1, 0 for HR/SpO2) and missing arm fields become
// null, which recharts draws as a break in the line, never as a dip to zero (fw-10).

import { isNum } from './num';
import { fmtSpan, recordMs } from './time';
import { isLegacyRecord } from './format';
import { mqWarmupS } from './sensors';

export const CHART_POINTS = 120;
// A pause longer than this between two readings breaks every line.
const GAP_MS = 30000;

export const SERIES_KEYS = ['hr', 'spo2', 'core', 'psi', 'co', 'twa', 'aq', 'heat', 'temp', 'hum', 'pres', 'act', 'still', 'accel'];

const positive = (v) => (isNum(v) && v > 0 ? v : null);
const nonNegative = (v) => (isNum(v) && v >= 0 ? v : null);
// Arm-strap environment value; in pre-Session-4 records 0 meant "no data".
const armEnv = (v, legacy) => (isNum(v) && !(legacy && v === 0) ? v : null);

// readings/ keeps the arm's sensor bitmask (IMU 1, BME 2, PPG 4). A sensor that is down sends
// zeros, so its fields are no data, not a reading of 0.
const ARM_IMU = 1;
const ARM_BME = 2;
const ARM_PPG = 4;
const sensorUp = (r, bit) => !isNum(r.arm_sensors) || (r.arm_sensors & bit) !== 0;

function point(r, t) {
  const legacy = isLegacyRecord(r);
  const warming = mqWarmupS(r) !== null; // MQ heaters not ready: co/aq are not measurements
  const imu = sensorUp(r, ARM_IMU);
  const bme = sensorUp(r, ARM_BME);
  const ppg = sensorUp(r, ARM_PPG);
  return {
    t,
    hr: ppg ? positive(r.hr) : null,
    spo2: ppg ? positive(r.spo2) : null,
    core: positive(r.core_temp_est),
    psi: nonNegative(r.psi),
    co: warming ? null : nonNegative(r.co),
    twa: nonNegative(r.twa_co),
    aq: warming ? null : nonNegative(r.aq),
    heat: bme ? armEnv(r.heat_index, legacy) : null,
    temp: bme ? armEnv(r.temp, legacy) : null,
    hum: bme ? positive(r.hum) : null, // 0 %RH is the old arm-silent placeholder, never a real reading
    pres: bme ? positive(r.pressure) : null,
    act: imu ? nonNegative(r.activity_mg) : null,
    still: imu ? nonNegative(r.still_s) : null,
    accel: imu ? positive(r.accel) : null,
  };
}

function gapPoint(t) {
  const p = { t, gap: true };
  for (const k of SERIES_KEYS) p[k] = null;
  return p;
}

// Returns { points, span, count }: up to maxPoints most recent readings in time order, with a
// null point inserted inside every gap longer than GAP_MS; span is a text such as "last 4 min 32 s".
export function buildSeries(readings, maxPoints = CHART_POINTS) {
  const src = readings.length > maxPoints ? readings.slice(readings.length - maxPoints) : readings;
  const pts = [];
  for (const r of src) {
    const t = recordMs(r);
    if (t !== null) pts.push(point(r, t));
  }
  pts.sort((a, b) => a.t - b.t);
  const points = [];
  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0 && pts[i].t - pts[i - 1].t > GAP_MS) points.push(gapPoint(pts[i - 1].t + 1));
    points.push(pts[i]);
  }
  let span = 'no readings yet';
  if (pts.length === 1) span = '1 reading';
  else if (pts.length > 1) span = `last ${fmtSpan(pts[pts.length - 1].t - pts[0].t)}`;
  return { points, span, count: pts.length, first: pts.length ? pts[0].t : null, last: pts.length ? pts[pts.length - 1].t : null };
}

// Number of points in which a series has a value.
export function seriesCount(points, key) {
  let n = 0;
  for (const p of points) if (isNum(p[key])) n += 1;
  return n;
}
