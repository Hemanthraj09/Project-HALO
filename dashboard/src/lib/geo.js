// Distances, bearings and coordinate checks for the map and the command post.

import { isNum } from './num';
import { gpsUart } from './sensors';
import { recordMs } from './time';

const EARTH_R_M = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// A usable position: finite, in range, and not the 0,0 "no fix" placeholder.
export function validLatLon(lat, lon) {
  return isNum(lat) && isNum(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

export function isLatLonPair(v) {
  return Array.isArray(v) && v.length === 2 && validLatLon(v[0], v[1]);
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Initial great-circle bearing from point 1 to point 2, degrees clockwise from true north.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassPoint(bearing) {
  return POINTS[Math.round(bearing / 22.5) % 16];
}

export function fmtBearing(bearing) {
  const b = Math.round(bearing) % 360;
  return `${String(b).padStart(3, '0')}° ${compassPoint(bearing)}`;
}

export function fmtDistance(m) {
  if (!isNum(m)) return '--';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function fmtLatLon(lat, lon, digits = 5) {
  if (!validLatLon(lat, lon)) return '--';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

// When the last accepted GPS fix was taken: packet time minus the chest's fix age.
export function fixTimeMs(r, packetMs) {
  if (!r || !isNum(packetMs) || !validLatLon(r.lat, r.lon)) return null;
  if (isNum(r.gps_age_s) && r.gps_age_s >= 0) return packetMs - r.gps_age_s * 1000;
  return r.gps_ok === true ? packetMs : null;
}

// "5 sats in view" while the chest reports satellites but no fresh fix (link up): the GPS module is
// connected and receiving, only the signal is too weak for a fix. Null otherwise, including a
// lost link, whose satellite count is from the last packet.
function satsInView(r, lost) {
  if (lost || !r || r.gps_ok === true || gpsUart(r) === false || !isNum(r.gps_sats) || r.gps_sats < 1) return null;
  const n = Math.round(r.gps_sats);
  return `${n} sat${n === 1 ? '' : 's'} in view`;
}

// GPS state for cards, tooltips and the device tab.
//   kind 'fresh': gps_ok and the link is up; 'stale': a last-known position only; 'none': no position.
// fixMs is when that fix was taken (null if unknown), so the UI can say "last fix 2 min ago".
// sats is satsInView() for 'stale' and 'none'.
export function gpsState(r, lost) {
  const packetMs = recordMs(r);
  const sats = satsInView(r, lost);
  if (!r || !validLatLon(r.lat, r.lon)) {
    return { kind: 'none', text: gpsUart(r) === false ? 'No data from the GPS module' : 'No GPS fix yet', fixMs: null, acc: null, sats };
  }
  const acc = isNum(r.gps_acc_m) && r.gps_acc_m > 0 ? `±${Math.round(r.gps_acc_m)} m` : null;
  const fixMs = fixTimeMs(r, packetMs);
  if (r.gps_ok === true && !lost) return { kind: 'fresh', text: acc ? `GPS fresh ${acc}` : 'GPS fresh', fixMs, acc, sats: null };
  return { kind: 'stale', text: 'Last fix', fixMs, acc, sats };
}
