// Thresholds and colour bands. The values are the backend alert rules (SPEC §8.5), so a reading
// turns amber exactly when the backend raises its P1 alert and red when it raises P0 (dash-9).
// Values inside the normal range use the neutral text colour; colour always means "alerting".
// The only extra band is CO above the OSHA PEL (50 ppm), shown orange between P1 and P0.

import { T } from '../theme';
import { isNum } from './num';
import { mqWarmupS } from './sensors';

export const TH = {
  CO_P1: 35, // ppm, NIOSH REL
  CO_PEL: 50, // ppm, OSHA PEL (display band only)
  CO_P0: 200, // ppm, NIOSH ceiling
  TWA_P1: 35, // ppm, 15-min TWA (needs >= 300 s of data in the backend)
  AQ_MODERATE: 100,
  AQ_POOR: 200, // also the AQI part of FIRE_SUSPECTED
  AQ_P1: 300,
  SPO2_P1: 94,
  SPO2_P0: 90,
  HR_P1_HIGH: 150,
  HR_P0: 170,
  HR_P1_LOW: 40,
  CORE_P1: 38.5,
  CORE_P0: 39.5,
  HEAT_CAUTION: 26.7, // NWS bands, °C heat index
  HEAT_XCAUTION: 32.2,
  HEAT_P1: 39.4,
  HEAT_P0: 51.7,
  STILL_P1: 30, // s, with skin contact or an active fall
  STILL_P0: 60,
  BATT_LOW: 20, // %
  BATT_CRIT: 10,
  ACT_LIGHT: 45, // mg ENMO cut-points (approximate wrist values, Hildebrand et al.)
  ACT_MODERATE: 100,
  ACT_VIGOROUS: 430,
};

// level: -1 unknown, 0 normal, 1 P1, 2 danger band (CO > OSHA PEL), 3 P0.
export function tone(level, label = '') {
  switch (level) {
    case 3:
      return { level, label, color: T.red, fill: T.redFill, bg: T.redBg };
    case 2:
      return { level, label, color: T.orange, fill: T.orangeFill, bg: T.orangeBg };
    case 1:
      return { level, label, color: T.amber, fill: T.amberFill, bg: T.amberBg };
    case 0:
      return { level, label, color: T.textStrong, fill: T.greenFill, bg: T.greenBg };
    default:
      return { level: -1, label, color: T.textDim, fill: T.grayFill, bg: T.grayBg };
  }
}

export function coBand(v, saturated) {
  if (!isNum(v) || v < 0) return tone(-1);
  const sat = saturated === true;
  if (v > TH.CO_P0 || (sat && v >= TH.CO_P0)) return tone(3, 'CRITICAL');
  if (v > TH.CO_PEL) return tone(2, 'DANGER');
  if (v > TH.CO_P1 || sat) return tone(1, 'ELEVATED');
  return tone(0, 'SAFE');
}

export function twaBand(v) {
  if (!isNum(v) || v < 0) return tone(-1);
  return v > TH.TWA_P1 ? tone(1, 'HIGH') : tone(0, 'SAFE');
}

export function aqBand(v) {
  if (!isNum(v) || v < 0) return tone(-1);
  if (v > TH.AQ_P1) return tone(1, 'HAZARDOUS');
  if (v > TH.AQ_POOR) return tone(0, 'POOR');
  if (v > TH.AQ_MODERATE) return tone(0, 'MODERATE');
  return tone(0, 'GOOD');
}

export function heatBand(v) {
  if (!isNum(v)) return tone(-1);
  if (v >= TH.HEAT_P0) return tone(3, 'EXTREME DANGER');
  if (v >= TH.HEAT_P1) return tone(1, 'DANGER');
  if (v >= TH.HEAT_XCAUTION) return tone(0, 'EXTREME CAUTION');
  if (v >= TH.HEAT_CAUTION) return tone(0, 'CAUTION');
  return tone(0, 'NORMAL');
}

export function spo2Band(v) {
  if (!isNum(v) || v <= 0) return tone(-1);
  if (v < TH.SPO2_P0) return tone(3, 'CRITICAL');
  if (v < TH.SPO2_P1) return tone(1, 'LOW');
  return tone(0, 'NORMAL');
}

export function hrBand(v) {
  if (!isNum(v) || v <= 0) return tone(-1);
  if (v > TH.HR_P0) return tone(3, 'CRITICAL HIGH');
  if (v > TH.HR_P1_HIGH) return tone(1, 'HIGH');
  if (v < TH.HR_P1_LOW) return tone(1, 'LOW (BRADYCARDIA)');
  return tone(0, 'NORMAL');
}

export function coreBand(v) {
  if (!isNum(v) || v <= 0) return tone(-1);
  if (v > TH.CORE_P0) return tone(3, 'CRITICAL (EST.)');
  if (v > TH.CORE_P1) return tone(1, 'HIGH (EST.)');
  return tone(0, 'NORMAL (EST.)');
}

// Moran et al. 1998 strain bands. PSI raises no alert of its own, so the colours here describe
// strain only; the label always names the band.
export function psiBand(v) {
  if (!isNum(v) || v < 0) return tone(-1);
  if (v >= 9) return tone(3, 'VERY HIGH');
  if (v >= 7) return tone(2, 'HIGH');
  if (v >= 5) return tone(1, 'MODERATE');
  if (v >= 3) return tone(0, 'LOW');
  return tone(0, 'NONE / LITTLE');
}

// Man-down timer. The backend only counts stillness while the strap is on skin or a fall is active.
export function stillBand(stillS, skin, fall) {
  if (!isNum(stillS) || stillS < 0) return tone(-1);
  const armed = skin === true || fall === true;
  if (armed && stillS >= TH.STILL_P0) return tone(3, 'NO MOTION');
  if (armed && stillS >= TH.STILL_P1) return tone(1, 'NO MOTION');
  return tone(0, stillS > 0 ? 'STILL' : 'MOVING');
}

export function activityBand(mg) {
  if (!isNum(mg) || mg < 0) return tone(-1);
  if (mg >= TH.ACT_VIGOROUS) return tone(0, 'VIGOROUS');
  if (mg >= TH.ACT_MODERATE) return tone(0, 'MODERATE');
  if (mg >= TH.ACT_LIGHT) return tone(0, 'LIGHT');
  return tone(0, 'SEDENTARY');
}

// Battery colours: red below 10 %, amber below 20 % (the backend BATT alert), green otherwise.
export function battTone(pct) {
  if (!isNum(pct)) return { level: -1, color: T.gray, fill: T.grayFill, bg: T.grayBg };
  if (pct < TH.BATT_CRIT) return { level: 3, color: T.red, fill: T.redFill, bg: T.redBg };
  if (pct < TH.BATT_LOW) return { level: 1, color: T.amber, fill: T.amberFill, bg: T.amberBg };
  return { level: 0, color: T.green, fill: T.greenFill, bg: T.greenBg };
}

// Worst current environmental reading at a responder (CO, heat index, AQI), for the map's
// sensing halo. CO and AQI are left out while the MQ sensors warm up. Returns null when none of
// the three is known.
export function envWorst(r) {
  if (!r) return null;
  const all = mqWarmupS(r) === null ? [coBand(r.co, r.co_sat), heatBand(r.heat_index), aqBand(r.aq)] : [heatBand(r.heat_index)];
  const bands = all.filter((b) => b.level >= 0);
  if (bands.length === 0) return null;
  return bands.reduce((worst, b) => (b.level > worst.level ? b : worst));
}
