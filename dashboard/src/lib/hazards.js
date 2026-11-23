// Hazard points written by the backend:
// hazards/<pushId> = {responder_id, type, severity, value, peak, lat, lon, acc_m, pos_stale,
//                     start_ms, last_ms, active}
// A hazard is a measurement taken by one responder at one place. Its circle radius is the GPS
// accuracy (at least 20 m); it is not the extent of the fire or gas cloud.

import { isNum } from './num';
import { validLatLon } from './geo';

export const HAZARD_MIN_RADIUS_M = 20;
// An active hazard whose last update is older than this is shown as not currently measured.
export const HAZARD_LIVE_MS = 120000;

export const HAZARD_META = {
  CO: { label: 'Carbon monoxide', short: 'CO' },
  AIR: { label: 'Smoke / poor air', short: 'Smoke' },
  HEAT: { label: 'Heat', short: 'Heat' },
  FIRE_SUSPECTED: { label: 'Possible fire/smoke', short: 'Fire?' },
  FALL: { label: 'Fall', short: 'Fall' },
  NO_MOTION: { label: 'No motion', short: 'No motion' },
};

export const HAZARD_WINDOWS = [
  { key: 'active', label: 'Active', ms: 0 },
  { key: '1h', label: '1 h', ms: 3600000 },
  { key: '6h', label: '6 h', ms: 21600000 },
  { key: '24h', label: '24 h', ms: 86400000 },
];

export const isHazardWindow = (k) => HAZARD_WINDOWS.some((w) => w.key === k);

export function hazardLabel(type) {
  return HAZARD_META[type] ? HAZARD_META[type].label : type || 'Hazard';
}

export function normaliseHazards(val) {
  const list = [];
  if (!val || typeof val !== 'object') return list;
  for (const [key, h] of Object.entries(val)) {
    if (!h || typeof h !== 'object' || !validLatLon(h.lat, h.lon)) continue;
    const value = isNum(h.value) ? h.value : null;
    const startMs = isNum(h.start_ms) ? h.start_ms : null;
    list.push({
      key,
      type: typeof h.type === 'string' ? h.type : 'UNKNOWN',
      responderId: typeof h.responder_id === 'string' ? h.responder_id : '',
      severity: h.severity === 0 ? 0 : 1,
      value,
      peak: isNum(h.peak) ? h.peak : value,
      lat: h.lat,
      lon: h.lon,
      accM: isNum(h.acc_m) && h.acc_m > 0 ? h.acc_m : null,
      posStale: h.pos_stale === true,
      startMs,
      lastMs: isNum(h.last_ms) ? h.last_ms : startMs,
      active: h.active === true,
      sat: h.sat === true, // CO sensor saturated: the true peak is at least this value
    });
  }
  return list;
}

// Active: active hazards only. 1 h / 6 h / 24 h: active ones plus any updated inside the window.
// Cleared hazards come first so active ones draw on top.
export function filterHazards(list, windowKey, now) {
  const w = HAZARD_WINDOWS.find((x) => x.key === windowKey) || HAZARD_WINDOWS[0];
  const since = now - w.ms;
  const shown = list.filter((h) => h.active || (w.ms > 0 && h.lastMs !== null && h.lastMs >= since));
  return shown.sort((a, b) => Number(a.active) - Number(b.active) || (a.lastMs || 0) - (b.lastMs || 0));
}

export function hazardRadius(h) {
  return Math.max(h.accM || 0, HAZARD_MIN_RADIUS_M);
}

export function isHazardLive(h, now) {
  return h.active && h.lastMs !== null && now - h.lastMs <= HAZARD_LIVE_MS;
}

export function fmtHazardValue(type, v, sat = false) {
  if (type === 'FALL') return 'confirmed';
  if (!isNum(v)) return '--';
  switch (type) {
    case 'CO':
      return `${sat ? '≥' : ''}${Math.round(v)} ppm`;
    case 'AIR':
      return `AQI ${Math.round(v)}`;
    case 'HEAT':
    case 'FIRE_SUSPECTED':
      return `${v.toFixed(1)} °C heat index`;
    case 'NO_MOTION':
      return `${Math.round(v)} s`;
    default:
      return String(Math.round(v));
  }
}
