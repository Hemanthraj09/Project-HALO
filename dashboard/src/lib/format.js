// Value formatters shared by the responder cards, the deep-dive tabs and the map tooltips/popups.
// They are the single place that decides how a sentinel or a missing sensor is shown:
//   arm_ok === false          -> "--"  ARM OFFLINE   (backend deleted the arm fields)
//   sensors.<sensor> === false -> "--"  NO SENSOR     (e.g. MAX30102 missing: sensors.ppg false)
//   HR / SpO2 -1              -> "CAL" CALIBRATING
//   HR / SpO2 0               -> "--"  NO SIGNAL     (no skin contact or signal lost)
//   CO / AQI, mq_warmup_s > 0 -> "--"  WARMING UP ~N min (state 'warming', shown in amber)
//   field absent              -> "--"  NO DATA
// Every formatter returns { text, note, value, state }; value is the usable number or null.

import { battTone } from './thresholds';
import { isNum } from './num';
import { mqWarmupS, warmupText } from './sensors';
import { fmtDuration } from './time';

export const DASH = '--';

export function fmtNum(v, digits = 0) {
  return isNum(v) ? v.toFixed(digits) : DASH;
}

const result = (text, note, value, state) => ({ text, note: note || null, value: isNum(value) ? value : null, state: state || 'ok' });
const NO_DATA = result(DASH, 'NO DATA', null, 'none');
const ARM_OFFLINE = result(DASH, 'ARM OFFLINE', null, 'arm-offline');
const NO_SENSOR = result(DASH, 'NO SENSOR', null, 'no-sensor');

// Before Session 4 the backend stored 0 for "no data" in these arm fields. A record without
// arm_ok is from that era, so its zeros mean "missing", not a real reading.
const LEGACY_ZERO_IS_MISSING = new Set(['temp', 'hum', 'heat_index', 'pressure', 'bme_alt', 'accel']);
export const isLegacyRecord = (r) => Boolean(r) && r.arm_ok === undefined;

// HR ('hr') or SpO2 ('spo2') from the arm strap's MAX30102.
export function ppgValue(r, key) {
  if (!r) return NO_DATA;
  if (r.arm_ok === false) return ARM_OFFLINE;
  if (r.sensors && r.sensors.ppg === false) return NO_SENSOR;
  const v = r[key];
  if (!isNum(v)) return NO_DATA;
  if (v === -1) return result('CAL', 'CALIBRATING', null, 'cal');
  if (v <= 0) return result(DASH, 'NO SIGNAL', null, 'no-signal');
  return result(String(Math.round(v)), null, v);
}

// Any other field measured on the arm strap: temp/hum/pressure/bme_alt/heat_index (sensor 'bme'),
// accel/activity_mg/still_s (sensor 'imu').
export function armValue(r, key, sensor, digits = 0) {
  if (!r) return NO_DATA;
  if (r.arm_ok === false) return ARM_OFFLINE;
  if (sensor && r.sensors && r.sensors[sensor] === false) return NO_SENSOR;
  const v = r[key];
  if (!isNum(v)) return NO_DATA;
  if (v === 0 && isLegacyRecord(r) && LEGACY_ZERO_IS_MISSING.has(key)) return NO_DATA;
  return result(v.toFixed(digits), null, v);
}

export function heatIndexValue(r, digits = 1) {
  return armValue(r, 'heat_index', 'bme', digits);
}

// The MQ heaters are still warming up, so CO and AQI (and CO saturation) are not valid yet.
function warming(r) {
  const s = mqWarmupS(r);
  return s === null ? null : result(DASH, warmupText(s), null, 'warming');
}

// CO from the chest MQ7. When the ADC is saturated the true value is at least the reported one.
export function coValue(r, digits = 0) {
  if (!r) return NO_DATA;
  const w = warming(r);
  if (w) return w;
  const v = r.co;
  if (!isNum(v) || v < 0) return NO_DATA;
  if (r.co_sat === true) return result(`≥${v.toFixed(digits)}`, 'SATURATED', v, 'saturated');
  return result(v.toFixed(digits), null, v);
}

export function twaValue(r, digits = 0) {
  if (!r || !isNum(r.twa_co) || r.twa_co < 0) return NO_DATA;
  return result(r.twa_co.toFixed(digits), r.twa_partial === true ? 'PARTIAL' : null, r.twa_co);
}

// MQ135 relative index 0..500 (not a calibrated AQI).
export function aqValue(r) {
  if (!r) return NO_DATA;
  const w = warming(r);
  if (w) return w;
  if (!isNum(r.aq) || r.aq < 0) return NO_DATA;
  return result(String(Math.round(r.aq)), null, r.aq);
}

// The backend publishes the core estimate (and so PSI) only after about a minute of valid HR, and
// again after a long HR gap. With a valid HR on screen the value is pending, not missing HR.
const PENDING = result(DASH, 'PENDING', null, 'none');
const NEEDS_HR = result(DASH, 'NEEDS HR', null, 'none');
const hrPending = (r) => (ppgValue(r, 'hr').value !== null ? PENDING : NEEDS_HR);

export function coreValue(r, digits = 1) {
  if (!r) return NO_DATA;
  const v = r.core_temp_est;
  if (isNum(v) && v > 0) return result(v.toFixed(digits), null, v);
  if (r.arm_ok === false) return ARM_OFFLINE;
  return hrPending(r);
}

export function psiValue(r, digits = 1) {
  if (!r) return NO_DATA;
  const v = r.psi;
  if (isNum(v) && v >= 0) return result(v.toFixed(digits), null, v);
  if (r.arm_ok === false) return ARM_OFFLINE;
  return hrPending(r);
}

export function fmtEta(min) {
  if (!isNum(min) || min <= 0) return null;
  if (min >= 1440) return '24 h or more';
  return `~${fmtDuration(min * 60)}`;
}

// Chest or arm battery. 'chest' falls back to the legacy simulator field "batt".
export function batteryInfo(r, which) {
  const name = which === 'chest' ? 'Chest' : 'Arm';
  let pct = r ? r[`batt_${which}`] : undefined;
  if (which === 'chest' && !isNum(pct) && r && isNum(r.batt)) pct = r.batt;
  const volts = r ? r[`vbat_${which}`] : undefined;
  const eta = r ? r[`batt_${which}_eta_min`] : undefined;
  const trend = r && typeof r[`batt_${which}_trend`] === 'string' ? r[`batt_${which}_trend`] : null;
  const armOffline = which === 'arm' && Boolean(r) && r.arm_ok === false;
  const known = !armOffline && isNum(pct) && pct >= 0 && pct <= 100;
  const t = battTone(known ? pct : null);
  const etaText = known && trend !== 'charging' ? fmtEta(eta) : null;
  let state = 'not measured';
  if (armOffline) state = 'arm strap offline';
  else if (known) state = `${Math.round(pct)}%`;
  const parts = [`${name} battery: ${state}`];
  if (!armOffline && isNum(volts) && volts > 0) parts.push(`${volts.toFixed(2)} V`);
  if (etaText) parts.push(`${etaText} left`);
  if (known && trend) parts.push(trend);
  return {
    which,
    name,
    known,
    pct: known ? pct : null,
    text: known ? `${Math.round(pct)}%` : DASH,
    volts: !armOffline && isNum(volts) && volts > 0 ? volts : null,
    etaText,
    trend: known ? trend : null,
    armOffline,
    color: t.color,
    fill: t.fill,
    bg: t.bg,
    level: t.level,
    title: parts.join(' · '),
  };
}

export function fmtBool(v, yes = 'yes', no = 'no') {
  if (v === true) return yes;
  if (v === false) return no;
  return DASH;
}
