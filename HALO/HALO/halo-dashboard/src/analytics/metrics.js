// HALO analytics: pure data functions for the ANALYTICS tab.
//
// No React, no DOM and no Firebase in this file, so it runs under plain node for unit tests.
// Inputs are the backend records described in the Session 4 spec, section 8.7:
//   analytics/<id>/minutes/<epochMinute>  one summary per minute (t = minute start, ms)
//   analytics/<id>/sessions/<startMs>     one summary per session (gaps < 10 min)
//   profiles/<id>                         { age, hr_max, hr_max_method, hr_rest }
// Thresholds and bands mirror backend.py (sections 8.5 and 8.7). Change both together.

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

export const MINUTE_MS = 60 * 1000;
export const MINUTES_QUERY_LIMIT = 720;          // newest 720 minute summaries = 12 h of continuous data
export const SESSIONS_QUERY_LIMIT = 20;
export const COMPARE_MAX_SESSIONS = 10;
export const RANGE_12H_MS = 12 * 60 * MINUTE_MS;
export const SESSION_GAP_MS = 10 * MINUTE_MS;    // backend: a session spans data with gaps < 10 min
export const GAP_BREAK_MS = 1.5 * MINUTE_MS;     // minute points further apart than this are drawn with a break

// Alert thresholds (backend section 8.5)
export const CO_REL_PPM = 35;          // NIOSH REL (8-h TWA); CO P1
export const CO_CEILING_PPM = 200;     // NIOSH ceiling; CO P0
export const SPO2_LOW = 94;            // SpO2 P1 below this
export const SPO2_CRITICAL = 90;       // SpO2 P0 below this
export const CORE_WARN_C = 38.5;       // CORE_TEMP P1 above this
export const CORE_CRIT_C = 39.5;       // CORE_TEMP P0 above this
export const HEAT_DANGER_C = 39.4;     // NWS danger; HEAT P1 from this
export const HEAT_EXTREME_C = 51.7;    // NWS extreme danger; HEAT P0 from this
export const AIR_POOR = 200;
export const AIR_HAZARDOUS = 300;      // AIR P1 above this
export const NO_MOTION_S = 30;         // NO_MOTION P1 from this many seconds still (when worn)
export const BATT_LOW_PCT = 20;        // BATT_* P1 below this
export const BATT_CRIT_PCT = 10;       // "CRITICAL" in the battery alert text below this

// Analytics rules (section 8.7 and 10.6)
export const REST_HR_PERCENTILE = 5;   // resting HR = 5th percentile of sedentary-minute hr_avg
export const REST_HR_MIN_MINUTES = 5;  // ... and needs at least this many such minutes
export const HRR_MIN_ZONE = 4;         // HR recovery is measured after bouts in zone 4 or 5
export const HRR_ACT_FRACTION = 0.75;  // "lower activity": next minute <= 75 % of the bout-end activity, or a lower band
export const BATT_MIN_SPAN_MIN = 10;   // battery use needs at least 10 min of discharge-segment time
export const BATT_JUMP_RESET_PCT = 10; // backend: a rise this big between points = pack swapped or charged, new segment
// The backend's live battery trend (BATT_DISCHARGE_SLOPE -0.02, BATT_CHARGE_SLOPE +0.2 %/min) as a drain
// in %/h: at or above 1.2 is a real drain, -12 or lower is charging, anything between is about flat.
export const BATT_DRAIN_MIN_PCT_H = 1.2;
export const BATT_CHARGE_PCT_H = -12;

// Edwards HR zones, % of HRmax. A value belongs to the last zone whose lo it reaches.
export const HR_ZONES = [
  { z: 0, key: 'z0', label: 'Z0', name: 'below zone 1', lo: -Infinity, hi: 50 },
  { z: 1, key: 'z1', label: 'Z1', name: 'very light', lo: 50, hi: 60 },
  { z: 2, key: 'z2', label: 'Z2', name: 'light', lo: 60, hi: 70 },
  { z: 3, key: 'z3', label: 'Z3', name: 'moderate', lo: 70, hi: 80 },
  { z: 4, key: 'z4', label: 'Z4', name: 'hard', lo: 80, hi: 90 },
  { z: 5, key: 'z5', label: 'Z5', name: 'maximum', lo: 90, hi: Infinity },
];

// Activity cut-points, mean ENMO in milli-g (approximate wrist values from Hildebrand et al.).
export const ACTIVITY_BANDS = [
  { key: 'sedentary', label: 'Sedentary', lo: -Infinity, hi: 45 },
  { key: 'light', label: 'Light', lo: 45, hi: 100 },
  { key: 'moderate', label: 'Moderate', lo: 100, hi: 430 },
  { key: 'vigorous', label: 'Vigorous', lo: 430, hi: Infinity },
];

// Physiological Strain Index bands (Moran et al. 1998). PSI is continuous, so 0-2 means < 3, and so on.
export const PSI_BANDS = [
  { key: 'none', label: 'none/little', lo: -Infinity, hi: 3 },
  { key: 'low', label: 'low', lo: 3, hi: 5 },
  { key: 'moderate', label: 'moderate', lo: 5, hi: 7 },
  { key: 'high', label: 'high', lo: 7, hi: 9 },
  { key: 'very_high', label: 'very high', lo: 9, hi: Infinity },
];

// NWS heat index bands, deg C. Below 26.7 has no band name and is not counted as heat time.
export const HEAT_BANDS = [
  { key: 'caution', label: 'Caution', lo: 26.7, hi: 32.2 },
  { key: 'extreme_caution', label: 'Extreme caution', lo: 32.2, hi: 39.4 },
  { key: 'danger', label: 'Danger', lo: 39.4, hi: 51.7 },
  { key: 'extreme_danger', label: 'Extreme danger', lo: 51.7, hi: Infinity },
];

// ─── SMALL HELPERS ───────────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
const inRange = (v, lo, hi) => (isNum(v) && v >= lo && v <= hi ? v : null);
const positive = (v, hi) => (isNum(v) && v > 0 && v <= hi ? v : null);
const count = (v) => (isNum(v) && v >= 0 ? Math.round(v) : null);
const nonZero = (v, lo, hi) => (isNum(v) && v !== 0 && v >= lo && v <= hi ? v : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function mean(values) {
  const xs = values.filter(isNum);
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function sum(values) {
  return values.reduce((s, x) => (isNum(x) ? s + x : s), 0);
}

// Largest (or smallest) value with the time it occurred. pick(m) returns the value for minute m.
function extreme(minutes, pick, wantMax) {
  let best = null;
  let bestT = null;
  for (const m of minutes) {
    const v = pick(m);
    if (!isNum(v)) continue;
    if (best === null || (wantMax ? v > best : v < best)) {
      best = v;
      bestT = m.t;
    }
  }
  return { value: best, t: bestT };
}

const pickFirst = (...vals) => {
  for (const v of vals) if (isNum(v)) return v;
  return null;
};

const consecutive = (a, b) => Math.round((b.t - a.t) / MINUTE_MS) === 1;

// Linear interpolation between closest ranks (the numpy default).
export function percentile(values, p) {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = (p / 100) * (xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

// Index of the band a value falls in (bands sorted by lo), or null when the value is missing
// or below the first band.
export function bandIndex(value, bands) {
  if (!isNum(value)) return null;
  for (let i = bands.length - 1; i >= 0; i -= 1) {
    if (value >= bands[i].lo) return i;
  }
  return null;
}

// ─── RECORD NORMALISATION ────────────────────────────────────────────────────
// Firebase data is untrusted input: every field is type- and range-checked here and dropped
// (set to null) when it fails. Sentinels never reach a chart: HR/SpO2 <= 0, humidity 0 % and a
// temperature of exactly 0 (the old arm-dropout value, dash-8), RSSI 0, battery 255.

const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);

const MINUTE_FIELDS = {
  n: count,
  hr_avg: (v) => positive(v, 300),
  hr_min: (v) => positive(v, 300),
  hr_max: (v) => positive(v, 300),
  hr_n: count,
  spo2_avg: (v) => positive(v, 100),
  spo2_min: (v) => positive(v, 100),
  co_avg: (v) => inRange(v, 0, 100000),
  co_max: (v) => inRange(v, 0, 100000),
  twa_co: (v) => inRange(v, 0, 100000),
  aq_avg: (v) => inRange(v, 0, 5000),
  aq_max: (v) => inRange(v, 0, 5000),
  temp_avg: (v) => nonZero(v, -60, 100),
  hum_avg: (v) => positive(v, 100),
  heat_avg: (v) => nonZero(v, -60, 150),
  heat_max: (v) => nonZero(v, -60, 150),
  core_est: (v) => inRange(v, 30, 45),
  psi_avg: (v) => inRange(v, 0, 10),
  psi_max: (v) => inRange(v, 0, 10),
  act_avg: (v) => inRange(v, 0, 65535),
  act_max: (v) => inRange(v, 0, 65535),
  still_max: (v) => inRange(v, 0, 1e7),
  zone: (v) => parseZone(v),
  pri_worst: (v) => (v === 0 || v === 1 || v === 2 ? v : null),
  falls: (v) => (typeof v === 'boolean' ? Number(v) : inRange(v, 0, 1e6)),
  no_motion: count,               // NO_MOTION alerts raised in the minute (newer backends only)
  batt_chest: (v) => inRange(v, 0, 100),
  batt_arm: (v) => inRange(v, 0, 100),
  vbat_chest: (v) => positive(v, 10),
  vbat_arm: (v) => positive(v, 10),
  rssi_avg: (v) => (isNum(v) && v < 0 && v >= -200 ? v : null),
  snr_avg: (v) => inRange(v, -50, 50),
  loss_pct: (v) => inRange(v, 0, 100),
  lat: (v) => inRange(v, -90, 90),
  lon: (v) => inRange(v, -180, 180),
  worn_frac: (v) => inRange(v, 0, 1),
};

export function parseZone(v) {
  if (isNum(v) && Number.isInteger(v) && v >= 0 && v <= 5) return v;
  if (typeof v === 'string') {
    const m = /^z?([0-5])$/i.exec(v.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

export function normalizeMinute(key, raw) {
  if (!raw || typeof raw !== 'object') return null;
  let t = num(raw.t);
  if (t === null && /^\d{1,10}$/.test(String(key))) t = Number(key) * MINUTE_MS;
  if (t === null || t < MIN_PLAUSIBLE_MS) return null;
  const m = { key: String(key), t };
  for (const [field, check] of Object.entries(MINUTE_FIELDS)) {
    m[field] = check(raw[field]);
  }
  if (m.lat === 0 && m.lon === 0) {
    m.lat = null;
    m.lon = null;
  }
  return m;
}

// Snapshot value of analytics/<id>/minutes -> minutes sorted by t (one per minute).
export function minutesFromSnapshot(val) {
  const byT = new Map();
  for (const [key, raw] of Object.entries(obj(val))) {
    const m = normalizeMinute(key, raw);
    if (m) byT.set(m.t, m);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

const secs = (v) => inRange(v, 0, 1e9);

export function normalizeSession(key, raw) {
  if (!raw || typeof raw !== 'object') return null;
  let start = num(raw.start_ms);
  if (start === null && /^\d{1,16}$/.test(String(key))) start = Number(key);
  if (start === null || start < MIN_PLAUSIBLE_MS) return null;
  let end = num(raw.end_ms);
  if (end === null || end < start) end = start;
  const hr = obj(raw.hr);
  const zs = obj(raw.zones_s);
  const psi = obj(raw.psi);
  const heat = obj(raw.heat);
  const co = obj(raw.co);
  const air = obj(raw.air);
  const spo2 = obj(raw.spo2);
  const act = obj(raw.activity);
  const ev = obj(raw.events);
  const batt = obj(raw.battery);
  const link = obj(raw.link);
  const prof = obj(raw.profile);
  const zonesPresent = HR_ZONES.some((z) => secs(zs[z.key]) !== null);
  return {
    key: String(key),
    start_ms: start,
    end_ms: end,
    duration_s: pickFirst(secs(raw.duration_s), (end - start) / 1000),
    minutes: count(raw.minutes),
    readings: count(raw.readings),
    source: typeof raw.source === 'string' ? raw.source : null,
    profile: {
      age: inRange(prof.age, 1, 120),
      hr_max: positive(prof.hr_max, 260),
      hr_rest: positive(prof.hr_rest, 200),
    },
    hr: {
      avg: positive(hr.avg, 300),
      max: positive(hr.max, 300),
      min: positive(hr.min, 300),
      rest_est: positive(hr.rest_est, 300),
    },
    zones_s: zonesPresent ? HR_ZONES.map((z) => secs(zs[z.key]) || 0) : null,
    trimp: inRange(raw.trimp, 0, 1e6),
    psi: {
      avg: inRange(psi.avg, 0, 10),
      max: inRange(psi.max, 0, 10),
      bands_s: PSI_BANDS.map((b) => secs(psi[`s_${b.key}`])),
    },
    core_max: inRange(raw.core_max, 30, 45),
    heat: {
      max: nonZero(heat.max, -60, 150),
      bands_s: HEAT_BANDS.map((b) => secs(heat[`s_${b.key}`])),
    },
    co: {
      max: inRange(co.max, 0, 100000),
      avg: inRange(co.avg, 0, 100000),
      dose_ppm_min: inRange(co.dose_ppm_min, 0, 1e9),
      s_over_35: secs(co.s_over_35),
      s_over_200: secs(co.s_over_200),
      twa_max: inRange(co.twa_max, 0, 100000),
    },
    air: {
      max: inRange(air.max, 0, 5000),
      s_poor: secs(air.s_poor),
      s_hazardous: secs(air.s_hazardous),
    },
    spo2: {
      min: positive(spo2.min, 100),
      avg: positive(spo2.avg, 100),
      s_below_94: secs(spo2.s_below_94),
      s_below_90: secs(spo2.s_below_90),
    },
    activity: {
      avg_mg: inRange(act.avg_mg, 0, 65535),
      bands_s: ACTIVITY_BANDS.map((b) => secs(act[`s_${b.key}`])),
    },
    events: {
      falls: count(ev.falls),
      no_motion: count(ev.no_motion),
      alerts_p0: count(ev.alerts_p0),
      alerts_p1: count(ev.alerts_p1),
    },
    battery: {
      chest_start: inRange(batt.chest_start, 0, 100),
      chest_end: inRange(batt.chest_end, 0, 100),
      arm_start: inRange(batt.arm_start, 0, 100),
      arm_end: inRange(batt.arm_end, 0, 100),
      chest_drain_pct_h: inRange(batt.chest_drain_pct_h, -1000, 1000),
      arm_drain_pct_h: inRange(batt.arm_drain_pct_h, -1000, 1000),
    },
    link: {
      rssi_avg: isNum(link.rssi_avg) && link.rssi_avg < 0 && link.rssi_avg >= -200 ? link.rssi_avg : null,
      snr_avg: inRange(link.snr_avg, -50, 50),
      loss_avg: inRange(link.loss_avg, 0, 100),
    },
    updated_ms: num(raw.updated_ms),
  };
}

// Snapshot value of analytics/<id>/sessions -> sessions sorted by start (oldest first).
export function sessionsFromSnapshot(val) {
  const out = [];
  for (const [key, raw] of Object.entries(obj(val))) {
    const s = normalizeSession(key, raw);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

// ─── PROFILE AND ZONES ───────────────────────────────────────────────────────

export const TANAKA_METHOD = 'Tanaka 208 - 0.7 × age';

export function tanakaHrMax(age) {
  const a = inRange(age, 1, 120);
  return a === null ? null : 208 - 0.7 * a;
}

// HRmax used for zone bands and % of HRmax. In 'session' mode the copy stored with the session
// comes first: the backend computed that session's zones_s, TRIMP and minute zones with it. Then
// profiles/<id>.hr_max, else Tanaka from the profile age, else the session copy. null when none is known.
export function resolveHrMax(profile, session, mode) {
  const p = obj(profile);
  const sp = session ? obj(session.profile) : {};
  const method = typeof p.hr_max_method === 'string' && p.hr_max_method ? p.hr_max_method : TANAKA_METHOD;
  const sessDirect = positive(sp.hr_max, 260);
  const fromSession = () => ({ value: sessDirect, age: inRange(sp.age, 1, 120), method: TANAKA_METHOD, from: 'session' });
  if (mode === 'session' && sessDirect !== null) return fromSession();
  const direct = positive(p.hr_max, 260);
  if (direct !== null) return { value: direct, age: inRange(p.age, 1, 120), method, from: 'profile' };
  const fromAge = tanakaHrMax(p.age);
  if (fromAge !== null) return { value: fromAge, age: p.age, method: TANAKA_METHOD, from: 'profile' };
  if (sessDirect !== null) return fromSession();
  const sessAge = tanakaHrMax(sp.age);
  if (sessAge !== null) return { value: sessAge, age: sp.age, method: TANAKA_METHOD, from: 'session' };
  return null;
}

export function zoneForHr(hr, hrMax) {
  if (!isNum(hr) || hr <= 0 || !isNum(hrMax) || hrMax <= 0) return null;
  return bandIndex((hr / hrMax) * 100, HR_ZONES);
}

// The backend's zone for the minute (from hr_avg), else computed from hr_avg.
export function minuteZone(m, hrMax) {
  if (m.zone !== null && m.zone !== undefined) return m.zone;
  return zoneForHr(m.hr_avg, hrMax);
}

// Share of the minute's readings that carried a valid HR (zone time only counts those).
function hrWeight(m) {
  if (isNum(m.hr_n) && isNum(m.n) && m.n > 0) return Math.min(1, Math.max(0, m.hr_n / m.n));
  return 1;
}

// Minutes per HR zone [z0..z5] from 1-minute summaries.
export function zoneMinutes(minutes, hrMax) {
  const out = HR_ZONES.map(() => 0);
  for (const m of minutes) {
    if (m.hr_avg === null) continue;
    const z = minuteZone(m, hrMax);
    if (z === null) continue;
    out[z] += hrWeight(m);
  }
  return out;
}

// Edwards TRIMP = sum over zones of (minutes in zone x zone number); zone 0 adds nothing.
export function edwardsTrimp(zoneMins) {
  if (!zoneMins) return null;
  return zoneMins.reduce((s, minutes, z) => s + (isNum(minutes) ? minutes * z : 0), 0);
}

export function trimpBand(trimp) {
  if (!isNum(trimp)) return null;
  if (trimp < 50) return 'light';
  if (trimp < 150) return 'moderate';
  if (trimp <= 300) return 'hard';
  return 'very hard';
}

export function psiBandLabel(psi) {
  const i = bandIndex(psi, PSI_BANDS);
  return i === null ? null : PSI_BANDS[i].label;
}

export function heatBandLabel(heat) {
  const i = bandIndex(heat, HEAT_BANDS);
  return i === null ? 'below caution' : HEAT_BANDS[i].label.toLowerCase();
}

export function activityBandIndex(mg) {
  return bandIndex(mg, ACTIVITY_BANDS);
}

// Minutes per band, assigning each minute to the band of pick(m).
export function minutesPerBand(minutes, pick, bands) {
  const out = bands.map(() => 0);
  for (const m of minutes) {
    const i = bandIndex(pick(m), bands);
    if (i !== null) out[i] += 1;
  }
  return out;
}

// ─── DERIVED METRICS ─────────────────────────────────────────────────────────

// Resting HR estimate: 5th percentile of hr_avg over sedentary minutes, needing >= 5 of them.
export function restingHrEstimate(minutes) {
  const vals = minutes
    .filter((m) => m.hr_avg !== null && m.act_avg !== null && m.act_avg < ACTIVITY_BANDS[1].lo)
    .map((m) => m.hr_avg);
  if (vals.length < REST_HR_MIN_MINUTES) return { value: null, n: vals.length };
  return { value: percentile(vals, REST_HR_PERCENTILE), n: vals.length };
}

function lowerActivity(actEnd, actNext) {
  if (!isNum(actEnd) || !isNum(actNext)) return false;
  if (actNext <= actEnd * HRR_ACT_FRACTION) return true;
  const a = activityBandIndex(actEnd);
  const b = activityBandIndex(actNext);
  return a !== null && b !== null && b < a;
}

// HR recovery after each bout of consecutive minutes in zone >= 4 that is followed (in the next
// minute) by lower activity: HRR1 = hr_avg(last bout minute) - hr_avg(next minute).
export function hrRecoveries(minutes, hrMax) {
  const out = [];
  const zoneAt = (i) => {
    const z = minuteZone(minutes[i], hrMax);
    return z === null ? -1 : z;
  };
  let i = 0;
  while (i < minutes.length) {
    if (zoneAt(i) < HRR_MIN_ZONE) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < minutes.length && consecutive(minutes[j], minutes[j + 1]) && zoneAt(j + 1) >= HRR_MIN_ZONE) j += 1;
    const end = minutes[j];
    const next = minutes[j + 1];
    if (next && consecutive(end, next) && end.hr_avg !== null && next.hr_avg !== null
        && lowerActivity(end.act_avg, next.act_avg)) {
      const bout = minutes.slice(i, j + 1);
      out.push({
        t: end.t,
        boutStart: minutes[i].t,
        boutEnd: end.t + MINUTE_MS,
        boutMin: j - i + 1,
        hrEnd: end.hr_avg,
        hrNext: next.hr_avg,
        hrr1: end.hr_avg - next.hr_avg,
        peakHr: extreme(bout, (m) => pickFirst(m.hr_max, m.hr_avg), true).value,
        actEnd: end.act_avg,
        actNext: next.act_avg,
      });
    }
    i = j + 1;
  }
  return out;
}

// Battery use per discharge segment, as the backend computes a session's drain: a rise of
// BATT_JUMP_RESET_PCT or more (pack swapped or charged) or a gap of SESSION_GAP_MS or more (a new
// session) starts a new segment. drainPctH = total drop / total segment time (> 0 = discharging),
// null below BATT_MIN_SPAN_MIN of segment time. start/end are the first and last values.
export function batteryUse(minutes, key) {
  const pts = minutes.filter((m) => isNum(m[key]));
  if (!pts.length) return null;
  let seg = pts[0];
  let drop = 0;
  let spanMs = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    if (cur[key] - prev[key] >= BATT_JUMP_RESET_PCT || cur.t - prev.t >= SESSION_GAP_MS) {
      drop += seg[key] - prev[key];
      spanMs += prev.t - seg.t;
      seg = cur;
    }
  }
  const last = pts[pts.length - 1];
  drop += seg[key] - last[key];
  spanMs += last.t - seg.t;
  const spanMin = spanMs / MINUTE_MS;
  const drain = spanMin >= BATT_MIN_SPAN_MIN ? drop / (spanMin / 60) : null;
  return { start: pts[0][key], end: last[key], spanMin, drainPctH: drain };
}

// Number of episodes: runs of consecutive minutes where pred(m) holds. A missing minute ends a run.
export function countEpisodes(minutes, pred) {
  let n = 0;
  let prev = null;
  let prevOn = false;
  for (const m of minutes) {
    const on = Boolean(pred(m));
    if (on && !(prevOn && prev && consecutive(prev, m))) n += 1;
    prev = m;
    prevOn = on;
  }
  return n;
}

const isFallMinute = (m) => isNum(m.falls) && m.falls > 0;
const isNoMotionMinute = (m) => isNum(m.still_max) && m.still_max >= NO_MOTION_S
  && ((isNum(m.worn_frac) && m.worn_frac > 0) || isFallMinute(m));

// ─── WINDOWS ─────────────────────────────────────────────────────────────────

// Minutes from the minute containing `start` up to `end` (null = no bound).
export function minutesInWindow(minutes, start, end) {
  const s = isNum(start) ? Math.floor(start / MINUTE_MS) * MINUTE_MS : -Infinity;
  const e = isNum(end) ? end : Infinity;
  return minutes.filter((m) => m.t >= s && m.t <= e);
}

// The latest session also takes minutes newer than its record's end_ms (the record is flushed
// once a minute, the minutes every 15 s), up to the 10-min session gap: anything later belongs to
// a new session whose record has not arrived yet.
export function sessionWindow(session, isLatest) {
  if (!session) return null;
  return { start: session.start_ms, end: isLatest ? session.end_ms + SESSION_GAP_MS : session.end_ms };
}

export function isSessionOngoing(session, now) {
  return Boolean(session) && isNum(now) && now - session.end_ms < SESSION_GAP_MS;
}

// True when the newest-720 minutes query cannot contain all of this session's minutes.
export function sessionNeedsRangeQuery(session, minutes, isLatest) {
  if (!session || isLatest) return false;
  if (minutes.length < MINUTES_QUERY_LIMIT) return false;   // the query returned everything there is
  return minutes[0].t > Math.floor(session.start_ms / MINUTE_MS) * MINUTE_MS;
}

// What the view shows: the picked session (pickedKey; null or unknown = the latest one), and the
// mode. "This session" falls back to the last 12 h when there is no session record at all.
export function selectView(sessions, minutes, modeChoice, pickedKey) {
  const list = Array.isArray(sessions) ? sessions : [];
  const latest = list.length ? list[list.length - 1] : null;
  const picked = pickedKey ? list.find((s) => s.key === pickedKey) : null;
  const session = picked || latest;
  const isLatest = Boolean(session && latest && session.key === latest.key);
  const mode = modeChoice === 'session' && session ? 'session' : '12h';
  const needRange = mode === 'session' && sessionNeedsRangeQuery(session, Array.isArray(minutes) ? minutes : [], isLatest);
  return { latest, session, isLatest, mode, needRange };
}

// ─── SUMMARIES ───────────────────────────────────────────────────────────────
// One shape for both sources. Seconds are seconds; nulls mean unknown.

function emptySummary() {
  return {
    start: null,
    end: null,
    durationS: null,
    dataMinutes: null,
    readings: null,
    hr: { avg: null, max: null, maxT: null, min: null, restEst: null, restN: null },
    zonesS: null,
    zonesFrom: null,
    trimp: null,
    psi: { avg: null, max: null, maxT: null, bandsS: null },
    core: { max: null, maxT: null },
    heat: { max: null, maxT: null, bandsS: null },
    co: { max: null, maxT: null, avg: null, dose: null, sOver35: null, sOver200: null, twaMax: null, twaMaxT: null },
    air: { max: null, sPoor: null, sHazardous: null },
    spo2: { min: null, minT: null, avg: null, sBelow94: null, sBelow90: null },
    activity: { avgMg: null, bandsS: null },
    events: { falls: null, noMotion: null, alertsP0: null, alertsP1: null, minutesP0: null, minutesP1: null },
    battery: { chest: null, arm: null },
    link: { rssiAvg: null, snrAvg: null, lossAvg: null },
    hrr: [],
  };
}

// Weighted by hr_n where the backend reports it.
function hrAverage(minutes) {
  let s = 0;
  let w = 0;
  for (const m of minutes) {
    if (m.hr_avg === null) continue;
    const weight = isNum(m.hr_n) && m.hr_n > 0 ? m.hr_n : 1;
    s += m.hr_avg * weight;
    w += weight;
  }
  return w > 0 ? s / w : null;
}

const toSeconds = (arr) => arr.map((minutes) => minutes * 60);

export function summarizeMinutes(minutes, hrMax) {
  const s = emptySummary();
  if (!minutes || !minutes.length) return s;
  s.start = minutes[0].t;
  s.end = minutes[minutes.length - 1].t;          // start of the last minute with data
  s.dataMinutes = minutes.length;
  s.durationS = minutes.length * 60;
  s.readings = minutes.some((m) => m.n !== null) ? sum(minutes.map((m) => m.n)) : null;

  const hrMaxPoint = extreme(minutes, (m) => pickFirst(m.hr_max, m.hr_avg), true);
  const rest = restingHrEstimate(minutes);
  s.hr = {
    avg: hrAverage(minutes),
    max: hrMaxPoint.value,
    maxT: hrMaxPoint.t,
    min: extreme(minutes, (m) => pickFirst(m.hr_min, m.hr_avg), false).value,
    restEst: rest.value,
    restN: rest.n,
  };
  if (minutes.some((m) => m.hr_avg !== null && minuteZone(m, hrMax) !== null)) {
    const zm = zoneMinutes(minutes, hrMax);
    s.zonesS = toSeconds(zm);
    s.zonesFrom = 'minutes';
    s.trimp = edwardsTrimp(zm);
  }

  const psiPeak = extreme(minutes, (m) => pickFirst(m.psi_max, m.psi_avg), true);
  s.psi = {
    avg: mean(minutes.map((m) => m.psi_avg)),
    max: psiPeak.value,
    maxT: psiPeak.t,
    bandsS: minutes.some((m) => m.psi_avg !== null) ? toSeconds(minutesPerBand(minutes, (m) => m.psi_avg, PSI_BANDS)) : null,
  };
  const corePeak = extreme(minutes, (m) => m.core_est, true);
  s.core = { max: corePeak.value, maxT: corePeak.t };

  const heatPeak = extreme(minutes, (m) => pickFirst(m.heat_max, m.heat_avg), true);
  s.heat = {
    max: heatPeak.value,
    maxT: heatPeak.t,
    bandsS: minutes.some((m) => m.heat_avg !== null) ? toSeconds(minutesPerBand(minutes, (m) => m.heat_avg, HEAT_BANDS)) : null,
  };

  const coMins = minutes.filter((m) => m.co_avg !== null);
  const coPeak = extreme(minutes, (m) => pickFirst(m.co_max, m.co_avg), true);
  const twaPeak = extreme(minutes, (m) => m.twa_co, true);
  s.co = {
    max: coPeak.value,
    maxT: coPeak.t,
    avg: mean(coMins.map((m) => m.co_avg)),
    dose: coMins.length ? sum(coMins.map((m) => m.co_avg)) : null,     // ppm x 1 min per summary
    sOver35: coMins.length ? coMins.filter((m) => m.co_avg > CO_REL_PPM).length * 60 : null,
    sOver200: coMins.length ? coMins.filter((m) => m.co_avg > CO_CEILING_PPM).length * 60 : null,
    twaMax: twaPeak.value,
    twaMaxT: twaPeak.t,
  };

  const aqMins = minutes.filter((m) => m.aq_avg !== null);
  s.air = {
    max: extreme(minutes, (m) => pickFirst(m.aq_max, m.aq_avg), true).value,
    sPoor: aqMins.length ? aqMins.filter((m) => m.aq_avg > AIR_POOR).length * 60 : null,
    sHazardous: aqMins.length ? aqMins.filter((m) => m.aq_avg > AIR_HAZARDOUS).length * 60 : null,
  };

  const spMins = minutes.filter((m) => m.spo2_avg !== null);
  const spLow = extreme(minutes, (m) => pickFirst(m.spo2_min, m.spo2_avg), false);
  s.spo2 = {
    min: spLow.value,
    minT: spLow.t,
    avg: mean(spMins.map((m) => m.spo2_avg)),
    sBelow94: spMins.length ? spMins.filter((m) => m.spo2_avg < SPO2_LOW).length * 60 : null,
    sBelow90: spMins.length ? spMins.filter((m) => m.spo2_avg < SPO2_CRITICAL).length * 60 : null,
  };

  s.activity = {
    avgMg: mean(minutes.map((m) => m.act_avg)),
    bandsS: minutes.some((m) => m.act_avg !== null) ? toSeconds(minutesPerBand(minutes, (m) => m.act_avg, ACTIVITY_BANDS)) : null,
  };

  const hasPri = minutes.some((m) => m.pri_worst !== null);
  s.events = {
    // minute.falls / minute.no_motion count the alerts raised in that minute, so the minutes add up.
    // Minutes written before the backend stored no_motion fall back to the still_max episode heuristic.
    falls: minutes.some((m) => isNum(m.falls)) ? sum(minutes.map((m) => m.falls)) : null,
    noMotion: sum(minutes.map((m) => m.no_motion)) + countEpisodes(minutes.filter((m) => !isNum(m.no_motion)), isNoMotionMinute),
    alertsP0: null,
    alertsP1: null,
    minutesP0: hasPri ? minutes.filter((m) => m.pri_worst === 0).length : null,
    minutesP1: hasPri ? minutes.filter((m) => m.pri_worst === 1).length : null,
  };

  s.battery = { chest: batteryUse(minutes, 'batt_chest'), arm: batteryUse(minutes, 'batt_arm') };
  s.link = {
    rssiAvg: mean(minutes.map((m) => m.rssi_avg)),
    snrAvg: mean(minutes.map((m) => m.snr_avg)),
    lossAvg: mean(minutes.map((m) => m.loss_pct)),
  };
  s.hrr = hrRecoveries(minutes, hrMax);
  return s;
}

const anyNum = (arr) => Array.isArray(arr) && arr.some(isNum);

export function summarizeSession(sess) {
  const s = emptySummary();
  if (!sess) return s;
  s.start = sess.start_ms;
  s.end = sess.end_ms;
  s.durationS = sess.duration_s;
  s.dataMinutes = sess.minutes;
  s.readings = sess.readings;
  s.hr = { avg: sess.hr.avg, max: sess.hr.max, maxT: null, min: sess.hr.min, restEst: sess.hr.rest_est, restN: null };
  if (sess.zones_s) {
    s.zonesS = sess.zones_s.slice();
    s.zonesFrom = 'session';
  }
  s.trimp = pickFirst(sess.trimp, sess.zones_s ? edwardsTrimp(sess.zones_s.map((x) => x / 60)) : null);
  s.psi = { avg: sess.psi.avg, max: sess.psi.max, maxT: null, bandsS: anyNum(sess.psi.bands_s) ? sess.psi.bands_s.map((x) => x || 0) : null };
  s.core = { max: sess.core_max, maxT: null };
  s.heat = { max: sess.heat.max, maxT: null, bandsS: anyNum(sess.heat.bands_s) ? sess.heat.bands_s.map((x) => x || 0) : null };
  s.co = {
    max: sess.co.max,
    maxT: null,
    avg: sess.co.avg,
    dose: sess.co.dose_ppm_min,
    sOver35: sess.co.s_over_35,
    sOver200: sess.co.s_over_200,
    twaMax: sess.co.twa_max,
    twaMaxT: null,
  };
  s.air = { max: sess.air.max, sPoor: sess.air.s_poor, sHazardous: sess.air.s_hazardous };
  s.spo2 = { min: sess.spo2.min, minT: null, avg: sess.spo2.avg, sBelow94: sess.spo2.s_below_94, sBelow90: sess.spo2.s_below_90 };
  s.activity = {
    avgMg: sess.activity.avg_mg,
    bandsS: anyNum(sess.activity.bands_s) ? sess.activity.bands_s.map((x) => x || 0) : null,
  };
  s.events = {
    falls: sess.events.falls,
    noMotion: sess.events.no_motion,
    alertsP0: sess.events.alerts_p0,
    alertsP1: sess.events.alerts_p1,
    minutesP0: null,
    minutesP1: null,
  };
  const b = sess.battery;
  const battery = (start, end, drain) => (start === null && end === null && drain === null ? null : { start, end, spanMin: null, drainPctH: drain });
  s.battery = {
    chest: battery(b.chest_start, b.chest_end, b.chest_drain_pct_h),
    arm: battery(b.arm_start, b.arm_end, b.arm_drain_pct_h),
  };
  s.link = { rssiAvg: sess.link.rssi_avg, snrAvg: sess.link.snr_avg, lossAvg: sess.link.loss_avg };
  return s;
}

// Peak times come from the minutes; keep one only when the minute value is the same peak.
function keepTime(value, fallbackValue, fallbackT) {
  if (!isNum(value)) return fallbackT;
  return isNum(fallbackValue) && Math.abs(fallbackValue - value) <= 0.05 + Math.abs(value) * 0.001 ? fallbackT : null;
}

// Field-by-field: the session record (full-resolution, computed by the backend) wins; the
// minute-derived value fills what the record lacks.
export function mergeSummaries(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const pick = (a, b) => (a === null || a === undefined ? b : a);
  const group = (name) => {
    const out = {};
    const p = primary[name] || {};
    const f = fallback[name] || {};
    for (const k of new Set([...Object.keys(p), ...Object.keys(f)])) out[k] = pick(p[k], f[k]);
    return out;
  };
  const m = { ...fallback };
  for (const k of ['start', 'end', 'durationS', 'dataMinutes', 'readings', 'trimp']) m[k] = pick(primary[k], fallback[k]);
  if (primary.zonesS) {
    m.zonesS = primary.zonesS;
    m.zonesFrom = primary.zonesFrom;
  }
  for (const g of ['hr', 'psi', 'core', 'heat', 'co', 'air', 'spo2', 'activity', 'events', 'link']) m[g] = group(g);
  m.battery = { chest: pick(primary.battery.chest, fallback.battery.chest), arm: pick(primary.battery.arm, fallback.battery.arm) };
  m.hr.maxT = keepTime(primary.hr.max, fallback.hr.max, fallback.hr.maxT);
  m.psi.maxT = keepTime(primary.psi.max, fallback.psi.max, fallback.psi.maxT);
  m.core.maxT = keepTime(primary.core.max, fallback.core.max, fallback.core.maxT);
  m.heat.maxT = keepTime(primary.heat.max, fallback.heat.max, fallback.heat.maxT);
  m.co.maxT = keepTime(primary.co.max, fallback.co.max, fallback.co.maxT);
  m.co.twaMaxT = keepTime(primary.co.twaMax, fallback.co.twaMax, fallback.co.twaMaxT);
  m.spo2.minT = keepTime(primary.spo2.min, fallback.spo2.min, fallback.spo2.minT);
  m.hr.restN = fallback.hr.restN;
  m.hrr = fallback.hrr;
  return m;
}

export function activeMinutes(sum0) {
  const b = sum0 && sum0.activity && sum0.activity.bandsS;
  if (!b) return null;
  return ((b[2] || 0) + (b[3] || 0)) / 60;
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

// Local wall-clock time, always HH:MM (24 h).
export function fmtHM(t) {
  if (!isNum(t)) return '--:--';
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDayMonth(t) {
  if (!isNum(t)) return '--';
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtDate(t) {
  if (!isNum(t)) return '--';
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// "14:02–16:45", or "21 Nov 22:10–22 Nov 04:05" across midnight.
export function fmtSpan(start, end) {
  if (!isNum(start) || !isNum(end)) return '--';
  if (sameLocalDay(start, end)) return `${fmtHM(start)}–${fmtHM(end)}`;
  return `${fmtDayMonth(start)} ${fmtHM(start)}–${fmtDayMonth(end)} ${fmtHM(end)}`;
}

// "45 s", "43 min", "2 h", "2 h 43 min".
export function fmtDuration(seconds) {
  if (!isNum(seconds) || seconds < 0) return '--';
  if (Math.round(seconds) === 0) return '0 min';
  if (Math.round(seconds) < 60) return `${Math.round(seconds)} s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtInt(v) {
  return isNum(v) ? Math.round(v).toLocaleString('en-US') : '--';
}

export function fmtFixed(v, dp = 1) {
  return isNum(v) ? v.toFixed(dp) : '--';
}

// ppm with one decimal below 10, whole numbers above.
export function fmtPpm(v) {
  if (!isNum(v)) return '--';
  return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
}

// Minutes for chart labels: one decimal below 10.
export function fmtMinutes(min) {
  if (!isNum(min)) return '--';
  if (min > 0 && min < 10) return min.toFixed(1);
  return Math.round(min).toLocaleString('en-US');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

export function sessionLabel(session, { now, isLatest } = {}) {
  if (!session) return '--';
  const end = session.end_ms;
  const endTxt = sameLocalDay(session.start_ms, end) ? fmtHM(end) : `${fmtDayMonth(end)} ${fmtHM(end)}`;
  let label = `${fmtDate(session.start_ms)} · ${fmtHM(session.start_ms)}–${endTxt} · ${fmtDuration(session.duration_s)}`;
  if (isLatest && isSessionOngoing(session, now)) label += ' · ongoing';
  return label;
}

// ─── CHART HELPERS ───────────────────────────────────────────────────────────

const gapRow = (t) => ({
  t,
  gap: true,
  hr: null, hrMin: null, hrMax: null, hrRange: null, zone: null,
  spo2: null, spo2Min: null,
  co: null, coMax: null, twa: null, dose: null, aq: null, aqMax: null,
  temp: null, hum: null, heat: null, heatMax: null,
  core: null, psi: null, psiMax: null,
  act: null, actMax: null, still: null,
  battChest: null, battArm: null, vbatChest: null, vbatArm: null,
  rssi: null, snr: null, loss: null,
});

// One row per minute for the time charts, with an empty row after each gap so lines break there
// (dash-8: the x axis is time, and missing data shows as a gap instead of a joined line).
export function buildMinuteSeries(minutes, hrMax) {
  const rows = [];
  let prev = null;
  let dose = 0;
  for (const m of minutes) {
    if (prev && m.t - prev.t > GAP_BREAK_MS) rows.push(gapRow(prev.t + MINUTE_MS));
    if (m.co_avg !== null) dose += m.co_avg;
    const hasRange = m.hr_min !== null && m.hr_max !== null && m.hr_min <= m.hr_max;
    rows.push({
      t: m.t,
      gap: false,
      hr: m.hr_avg,
      hrMin: m.hr_min,
      hrMax: m.hr_max,
      hrRange: hasRange ? [m.hr_min, m.hr_max] : null,
      zone: m.hr_avg === null ? null : minuteZone(m, hrMax),
      spo2: m.spo2_avg,
      spo2Min: m.spo2_min,
      co: m.co_avg,
      coMax: m.co_max,
      twa: m.twa_co,
      dose: m.co_avg === null ? null : dose,
      aq: m.aq_avg,
      aqMax: m.aq_max,
      temp: m.temp_avg,
      hum: m.hum_avg,
      heat: m.heat_avg,
      heatMax: m.heat_max,
      core: m.core_est,
      psi: m.psi_avg,
      psiMax: m.psi_max,
      act: m.act_avg,
      actMax: m.act_max,
      still: m.still_max,
      battChest: m.batt_chest,
      battArm: m.batt_arm,
      vbatChest: m.vbat_chest,
      vbatArm: m.vbat_arm,
      rssi: m.rssi_avg,
      snr: m.snr_avg,
      loss: m.loss_pct,
    });
    prev = m;
  }
  return rows;
}

export function seriesHas(rows, key) {
  return rows.some((r) => isNum(r[key]) || Array.isArray(r[key]));
}

// [lo, hi] over the given keys (arrays count both ends); null when there is no value.
export function seriesExtent(rows, keys) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    for (const k of keys) {
      const v = r[k];
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) {
        if (!isNum(x)) continue;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
  }
  return lo === Infinity ? null : [lo, hi];
}

// x-axis domain from the data; a lone minute gets one minute either side.
export function timeDomain(rows) {
  if (!rows.length) return null;
  const a = rows[0].t;
  const b = rows[rows.length - 1].t;
  return a === b ? [a - MINUTE_MS, b + MINUTE_MS] : [a, b];
}

const TICK_STEPS_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440];

// Ticks on round local wall-clock times (for example every 30 min), at most maxTicks of them.
export function timeTicks(start, end, maxTicks = 7) {
  if (!isNum(start) || !isNum(end) || end <= start) return [];
  const spanMin = (end - start) / MINUTE_MS;
  const step = TICK_STEPS_MIN.find((s) => spanMin / s <= maxTicks) || 1440;
  const d = new Date(start);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes() + (d.getSeconds() || d.getMilliseconds() ? 1 : 0);
  const first = Math.ceil(minuteOfDay / step) * step;
  d.setHours(0, first, 0, 0);
  const ticks = [];
  for (let t = d.getTime(); t <= end && ticks.length < 50; t += step * MINUTE_MS) ticks.push(t);
  return ticks;
}

// Round ticks for a linear axis: a step of 1, 2, 2.5 or 5 x 10^k giving at most about maxTicks
// intervals, with the domain widened to the outer ticks. null when lo/hi are not numbers.
export function niceTicks(lo, hi, maxTicks = 5) {
  if (!isNum(lo) || !isNum(hi)) return null;
  const top = hi > lo ? hi : lo + 1;
  const raw = (top - lo) / Math.max(1, maxTicks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-12);
  const first = Math.floor(lo / step + 1e-9) * step;
  const last = Math.ceil(top / step - 1e-9) * step;
  const n = Math.round((last - first) / step);
  const ticks = [];
  for (let i = 0; i <= n; i += 1) ticks.push(Number((first + i * step).toPrecision(12)));
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}

// HR chart y domain: the data plus enough of the zone scale to give context.
export function hrDomain(rows, hrMax) {
  const ext = seriesExtent(rows, ['hr', 'hrRange']);
  if (!ext) return [40, 200];
  let lo = ext[0] - 5;
  let hi = ext[1] + 5;
  if (isNum(hrMax)) {
    lo = Math.min(lo, hrMax * 0.5 - 5);
    hi = Math.max(hi, hrMax * 0.6);
  }
  return [Math.max(30, Math.floor(lo / 10) * 10), Math.ceil(hi / 10) * 10];
}

// Zone bands that are visible inside the y domain, in bpm.
export function zoneBands(hrMax, domain) {
  if (!isNum(hrMax) || !domain) return [];
  const [dlo, dhi] = domain;
  return HR_ZONES.map((z) => ({
    ...z,
    y1: Math.max(dlo, z.lo === -Infinity ? dlo : (z.lo / 100) * hrMax),
    y2: Math.min(dhi, z.hi === Infinity ? dhi : (z.hi / 100) * hrMax),
  })).filter((z) => z.y2 > z.y1);
}

// Rows for the time-in-zones bars: minutes per zone, the % range and (with HRmax) the bpm range.
export function zoneBarData(zonesS, hrMax) {
  const total = zonesS ? zonesS.reduce((s, x) => s + (isNum(x) ? x : 0), 0) : 0;
  const bpmAt = (pct) => Math.round((pct / 100) * hrMax);
  return HR_ZONES.map((z, i) => {
    let range = `${z.lo}–${z.hi}%`;
    let bpm = isNum(hrMax) ? `${bpmAt(z.lo)}–${bpmAt(z.hi)} bpm` : null;
    if (z.lo === -Infinity) {
      range = `<${z.hi}%`;
      bpm = isNum(hrMax) ? `< ${bpmAt(z.hi)} bpm` : null;
    } else if (z.hi === Infinity) {
      range = `≥${z.lo}%`;
      bpm = isNum(hrMax) ? `≥ ${bpmAt(z.lo)} bpm` : null;
    }
    const secsInZone = zonesS && isNum(zonesS[i]) ? zonesS[i] : 0;
    return {
      key: z.key,
      z: z.z,
      label: z.label,
      name: z.name,
      range,
      bpm,
      minutes: secsInZone / 60,
      share: total > 0 ? secsInZone / total : null,
    };
  });
}

// Minutes per band in 10-minute buckets aligned to local wall-clock time. Empty buckets are kept so
// gaps show. top = the highest band with minutes (gets the rounded end of the stacked bar).
export function activityBuckets(minutes, bucketMin = 10) {
  const withAct = minutes.filter((m) => m.act_avg !== null);
  if (!withAct.length) return [];
  const size = bucketMin * MINUTE_MS;
  const offsetOf = (t) => -new Date(t).getTimezoneOffset() * MINUTE_MS;
  const bucketOf = (t) => Math.floor((t + offsetOf(t)) / size) * size - offsetOf(t);
  const first = bucketOf(withAct[0].t);
  const last = bucketOf(withAct[withAct.length - 1].t);
  const buckets = new Map();
  for (let b = first; b <= last && buckets.size < 500; b += size) {
    buckets.set(b, { t: b, label: fmtHM(b), sedentary: 0, light: 0, moderate: 0, vigorous: 0, n: 0, top: null });
  }
  for (const m of withAct) {
    const b = buckets.get(bucketOf(m.t));
    if (!b) continue;
    b[ACTIVITY_BANDS[activityBandIndex(m.act_avg)].key] += 1;
    b.n += 1;
  }
  for (const b of buckets.values()) {
    for (const band of ACTIVITY_BANDS) if (b[band.key] > 0) b.top = band.key;
  }
  return [...buckets.values()];
}

// Last <= 10 sessions, oldest first, with the four comparison metrics.
export function sessionComparison(sessions, selectedKey) {
  return sessions.slice(-COMPARE_MAX_SESSIONS).map((s) => {
    const sm = summarizeSession(s);
    return {
      key: s.key,
      label: fmtHM(s.start_ms),
      date: fmtDayMonth(s.start_ms),
      title: sessionLabel(s),
      trimp: sm.trimp,
      psiMax: sm.psi.max,
      coDose: sm.co.dose,
      activeMin: activeMinutes(sm),
      selected: s.key === selectedKey,
    };
  });
}

// ─── KPI TILES ───────────────────────────────────────────────────────────────

const pctOf = (v, of) => (isNum(v) && isNum(of) && of > 0 ? Math.round((v / of) * 100) : null);

// Tiles for the KPI row. status: null, or { level: 'critical' | 'warning', text }. sub is data only
// ('' when there is nothing to add to the value).
export function buildKpis(sm, ctx = {}) {
  const hrMax = ctx.hrMax ? ctx.hrMax.value : null;
  const fromMinutes = ctx.mode !== 'session';
  const tiles = [];

  const span = isNum(sm.start) && isNum(sm.end) ? fmtSpan(sm.start, sm.end) : null;
  tiles.push({
    id: 'duration',
    label: 'Duration',
    value: fmtDuration(sm.durationS),
    unit: '',
    sub: fromMinutes
      ? `with data in the last 12 h${span ? ` · ${span}` : ''}`
      : `${span || '--'}${isNum(sm.dataMinutes) ? ` · ${plural(sm.dataMinutes, 'minute')} with data` : ''}`,
    status: null,
  });

  tiles.push({ id: 'trimp', label: 'Training load', value: fmtInt(sm.trimp), unit: '', sub: trimpBand(sm.trimp) || '', status: null });

  const pa = pctOf(sm.hr.avg, hrMax);
  const pm = pctOf(sm.hr.max, hrMax);
  tiles.push({
    id: 'hr',
    label: 'Avg / max HR',
    value: `${fmtInt(sm.hr.avg)} / ${fmtInt(sm.hr.max)}`,
    unit: 'bpm',
    sub: hrMax && pa !== null && pm !== null
      ? `${pa}% / ${pm}% of HRmax ${Math.round(hrMax)}`
      : (hrMax ? `HRmax ${Math.round(hrMax)} bpm` : 'no HRmax: profile missing'),
    status: null,
  });

  tiles.push({ id: 'rest', label: 'Est. resting HR', value: fmtInt(sm.hr.restEst), unit: 'bpm', sub: '', status: null });

  const psiBand = psiBandLabel(sm.psi.max);
  let psiStatus = null;
  if (isNum(sm.psi.max) && sm.psi.max >= 9) psiStatus = { level: 'critical', text: 'very high' };
  else if (isNum(sm.psi.max) && sm.psi.max >= 7) psiStatus = { level: 'warning', text: 'high' };
  tiles.push({
    id: 'psi',
    label: 'Peak PSI',
    value: fmtFixed(sm.psi.max, 1),
    unit: '/ 10',
    sub: psiBand ? `${psiBand} (est.)` : '',
    status: psiStatus,
  });

  const hb = sm.heat.bandsS;
  const dangerS = hb ? (hb[2] || 0) + (hb[3] || 0) : null;
  let heatStatus = null;
  if (hb && hb[3] > 0) heatStatus = { level: 'critical', text: 'extreme danger' };
  else if (dangerS > 0) heatStatus = { level: 'warning', text: 'danger' };
  tiles.push({
    id: 'heat',
    label: 'Time in heat danger',
    value: hb ? fmtDuration(dangerS) : '--',
    unit: '',
    sub: isNum(sm.heat.max) ? `peak heat index ${fmtFixed(sm.heat.max, 1)} °C` : '',
    status: heatStatus,
  });

  let coStatus = null;
  if (isNum(sm.co.max) && sm.co.max > CO_CEILING_PPM) coStatus = { level: 'critical', text: `above ${CO_CEILING_PPM} ppm` };
  else if (isNum(sm.co.twaMax) && sm.co.twaMax > CO_REL_PPM) coStatus = { level: 'warning', text: `TWA above ${CO_REL_PPM} ppm` };
  tiles.push({
    id: 'co',
    label: 'CO dose',
    value: fmtInt(sm.co.dose),
    unit: 'ppm·min',
    sub: `max 15-min TWA ${fmtPpm(sm.co.twaMax)} ppm${isNum(sm.co.max) ? ` · peak ${fmtPpm(sm.co.max)} ppm` : ''}`,
    status: coStatus,
  });

  let spStatus = null;
  if (isNum(sm.spo2.min) && sm.spo2.min < SPO2_CRITICAL) spStatus = { level: 'critical', text: `below ${SPO2_CRITICAL}%` };
  else if (isNum(sm.spo2.min) && sm.spo2.min < SPO2_LOW) spStatus = { level: 'warning', text: `below ${SPO2_LOW}%` };
  let spSub = 'no valid SpO2';
  if (isNum(sm.spo2.min)) {
    spSub = isNum(sm.spo2.sBelow94)
      ? `${fmtDuration(sm.spo2.sBelow90 || 0)} below ${SPO2_CRITICAL}% · ${fmtDuration(sm.spo2.sBelow94)} below ${SPO2_LOW}%`
      : `avg ${fmtInt(sm.spo2.avg)}%`;
  }
  tiles.push({ id: 'spo2', label: 'Min SpO2', value: fmtInt(sm.spo2.min), unit: '%', sub: spSub, status: spStatus });

  const act = activeMinutes(sm);
  const ab = sm.activity.bandsS;
  tiles.push({
    id: 'active',
    label: 'Active minutes',
    value: fmtInt(act),
    unit: 'min',
    sub: ab ? `moderate ${fmtInt(ab[2] / 60)} + vigorous ${fmtInt(ab[3] / 60)}` : 'no activity data',
    status: null,
  });

  const ev = sm.events;
  let evStatus = null;
  if (isNum(ev.falls) && ev.falls > 0) evStatus = { level: 'critical', text: plural(ev.falls, 'fall') };
  else if (isNum(ev.noMotion) && ev.noMotion > 0) evStatus = { level: 'warning', text: 'no motion' };
  let evSub = '';
  if (isNum(ev.alertsP0) || isNum(ev.alertsP1)) evSub = `alerts raised: ${fmtInt(ev.alertsP0 || 0)} P0 · ${fmtInt(ev.alertsP1 || 0)} P1`;
  else if (isNum(ev.minutesP0)) evSub = `${ev.minutesP0} min at P0 · ${ev.minutesP1} min at P1`;
  tiles.push({ id: 'events', label: 'Falls / no-motion', value: `${fmtInt(ev.falls)} / ${fmtInt(ev.noMotion)}`, unit: '', sub: evSub, status: evStatus });

  return tiles;
}

// ─── INSIGHTS ────────────────────────────────────────────────────────────────

const at = (t) => (isNum(t) ? ` at ${fmtHM(t)}` : '');

// Up to 6 short factual bullets from the summary, most important first. Estimates are marked;
// no medical claims (thresholds are named as alert levels, not diagnoses).
export function buildInsights(sm, ctx = {}) {
  if (!sm || !isNum(sm.dataMinutes) || sm.dataMinutes <= 0) return [];
  const items = [];
  const add = (rank, text) => items.push({ rank, text });
  const scope = ctx.mode === 'session' ? 'this session' : 'the last 12 h';

  const falls = sm.events.falls || 0;
  const still = sm.events.noMotion || 0;
  if (falls > 0 || still > 0) add(0, `${plural(falls, 'fall')} and ${plural(still, 'no-motion event')} in ${scope}`);

  if (isNum(sm.co.max) && sm.co.max > CO_CEILING_PPM) {
    add(1, `CO reached ${fmtPpm(sm.co.max)} ppm${at(sm.co.maxT)}, above the ${CO_CEILING_PPM} ppm alert level`);
  }
  if (isNum(sm.spo2.min) && sm.spo2.min < SPO2_CRITICAL) {
    const dur = isNum(sm.spo2.sBelow90) && sm.spo2.sBelow90 > 0 ? `; ${fmtDuration(sm.spo2.sBelow90)} below ${SPO2_CRITICAL}%` : '';
    add(1, `SpO2 fell to ${fmtInt(sm.spo2.min)}%${at(sm.spo2.minT)}, below the ${SPO2_CRITICAL}% alert level${dur}`);
  }
  if (isNum(sm.co.twaMax) && sm.co.twaMax > CO_REL_PPM) {
    add(2, `15-min CO TWA peaked at ${fmtPpm(sm.co.twaMax)} ppm${at(sm.co.twaMaxT)}, above the ${CO_REL_PPM} ppm alert level`);
  }
  const hb = sm.heat.bandsS;
  const dangerS = hb ? (hb[2] || 0) + (hb[3] || 0) : 0;
  if (dangerS > 0) {
    add(2, `${fmtDuration(dangerS)} at heat index ${HEAT_DANGER_C} °C or more${isNum(sm.heat.max) ? `; peak ${Math.round(sm.heat.max)} °C${at(sm.heat.maxT)}` : ''}`);
  }

  if (sm.zonesS && sm.zonesS.some((x) => x > 0)) {
    const z45 = (sm.zonesS[4] + sm.zonesS[5]) / 60;
    if (z45 >= 0.5) {
      add(3, `${fmtDuration(z45 * 60)} in zones 4–5`);
    } else {
      let top = 0;
      sm.zonesS.forEach((x, z) => { if (x > sm.zonesS[top]) top = z; });
      add(6, `No time in zones 4–5; most HR time in zone ${top}`);
    }
  } else if (!isNum(sm.hr.avg)) {
    add(7, `No valid heart rate in ${scope}`);
  }

  if (isNum(sm.psi.max)) {
    add(sm.psi.max >= 7 ? 2 : 4, `Peak strain PSI ${sm.psi.max.toFixed(1)} (${psiBandLabel(sm.psi.max)}, est.)${at(sm.psi.maxT)}`);
  }
  if (isNum(sm.core.max) && sm.core.max > CORE_WARN_C) {
    add(3, `Estimated core temperature peaked at ${sm.core.max.toFixed(1)} °C${at(sm.core.maxT)}`);
  }

  if (sm.hrr && sm.hrr.length) {
    const best = sm.hrr.reduce((a, b) => (b.hrr1 > a.hrr1 ? b : a));
    const more = sm.hrr.length > 1 ? ` (largest of ${sm.hrr.length} bouts)` : '';
    if (Math.round(best.hrr1) > 0) {
      add(4, `HR fell ${Math.round(best.hrr1)} bpm in the minute after the zone 4–5 bout that ended at ${fmtHM(best.boutEnd)}${more}`);
    } else {
      add(4, `HR did not drop in the minute after the zone 4–5 bout that ended at ${fmtHM(best.boutEnd)}${more}`);
    }
  }

  if (isNum(sm.co.max) && sm.co.max > CO_REL_PPM && sm.co.max <= CO_CEILING_PPM) {
    const dur = isNum(sm.co.sOver35) && sm.co.sOver35 > 0 ? `${fmtDuration(sm.co.sOver35)} with CO above ${CO_REL_PPM} ppm; ` : '';
    add(3, `${dur}CO peaked at ${fmtPpm(sm.co.max)} ppm${at(sm.co.maxT)}`);
  } else if (isNum(sm.co.max) && sm.co.max <= CO_REL_PPM) {
    add(8, `CO stayed at or below ${CO_REL_PPM} ppm (peak ${fmtPpm(sm.co.max)} ppm)`);
  } else if (!isNum(sm.co.max)) {
    add(9, `No CO data in ${scope}`);
  }

  if (isNum(sm.spo2.min) && sm.spo2.min >= SPO2_CRITICAL && sm.spo2.min < SPO2_LOW) {
    const dur = isNum(sm.spo2.sBelow94) && sm.spo2.sBelow94 > 0 ? `; ${fmtDuration(sm.spo2.sBelow94)} below ${SPO2_LOW}%` : '';
    add(3, `SpO2 dipped to ${fmtInt(sm.spo2.min)}%${at(sm.spo2.minT)}${dur}`);
  } else if (isNum(sm.spo2.min) && sm.spo2.min >= SPO2_LOW) {
    add(8, `SpO2 stayed at ${SPO2_LOW}% or above (lowest ${fmtInt(sm.spo2.min)}%)`);
  }

  const act = activeMinutes(sm);
  if (isNum(act) && act >= 0.5) add(6, `${fmtDuration(act * 60)} of moderate or vigorous activity`);
  else if (isNum(act)) add(7, 'No moderate or vigorous activity');


  items.sort((a, b) => a.rank - b.rank);
  return items.slice(0, 6).map((i) => i.text);
}

// ─── FIREBASE ERRORS ─────────────────────────────────────────────────────────

// The RTDB SDK cancels a listener with Error("permission_denied at /path: ...") and code
// 'PERMISSION_DENIED'.
export function classifyDbError(err) {
  const code = String((err && err.code) || '').toUpperCase();
  const message = String((err && err.message) || err || 'Unknown error');
  return { denied: code === 'PERMISSION_DENIED' || /permission[_ ]denied/i.test(message), code, message };
}

// Firebase keys cannot contain . # $ [ ] or /; anything else from live/ is safe to put in a path.
export function isSafeKey(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[.#$[\]/]/.test(id);
}
