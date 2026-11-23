// Pure helpers that turn readings and hazards into map shapes.

import { T } from '../theme';
import { haversineM, validLatLon } from '../lib/geo';
import { isNum } from '../lib/num';
import { mqWarmupS } from '../lib/sensors';
import { coBand, TH } from '../lib/thresholds';
import { recordMs } from '../lib/time';

// Tooltips and popups inherit the pane of the layer they sit in (react-leaflet withPane). Layers
// here live in custom panes, so every Tooltip/Popup names Leaflet's own panes explicitly; otherwise
// a popup could open underneath the responder markers.
export const TOOLTIP_PANE = 'tooltipPane';
export const POPUP_PANE = 'popupPane';

// Trail colour by CO band. Below 35 ppm the trail is blue so it does not read as "all clear green".
export function trailColor(co, sat) {
  const b = coBand(co, sat);
  if (b.level <= 0) return T.blueFill;
  return b.fill;
}

const TRAIL_GAP_MS = 120000; // a longer pause between two fixes starts a new line

// readings -> { lines: [{ positions, color }], dots: [{ key, lat, lon, co, sat, t, color }] }
// Only gps_ok points are used. Consecutive segments with the same colour share one polyline.
// CO read while the MQ sensors warm up is not a measurement, so those points count as no CO.
export function buildTrail(readings) {
  const pts = [];
  for (const r of readings) {
    if (!r || r.gps_ok !== true || !validLatLon(r.lat, r.lon)) continue;
    const valid = mqWarmupS(r) === null;
    pts.push({ lat: r.lat, lon: r.lon, t: recordMs(r), co: valid && isNum(r.co) ? r.co : null, sat: valid && r.co_sat === true });
  }
  const lines = [];
  let current = null;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.t !== null && b.t !== null && b.t - a.t > TRAIL_GAP_MS) {
      current = null;
      continue;
    }
    const worst = Math.max(a.co === null ? -1 : a.co, b.co === null ? -1 : b.co);
    const color = trailColor(worst < 0 ? null : worst, a.sat || b.sat);
    if (current && current.color === color) {
      current.positions.push([b.lat, b.lon]);
    } else {
      current = { color, positions: [[a.lat, a.lon], [b.lat, b.lon]] };
      lines.push(current);
    }
  }
  const dots = [];
  pts.forEach((p, i) => {
    if (p.co !== null && (p.co > TH.CO_P1 || p.sat)) {
      dots.push({ key: `${i}-${p.t}`, lat: p.lat, lon: p.lon, co: p.co, sat: p.sat, t: p.t, color: trailColor(p.co, p.sat) });
    }
  });
  return { lines, dots };
}

// Hazard colours: CO orange, red at P0; smoke purple; heat amber, orange at P0;
// possible fire red; fall red; no motion amber.
export function hazardColor(h) {
  switch (h.type) {
    case 'CO':
      return h.severity === 0 ? T.redFill : T.orangeFill;
    case 'AIR':
      return T.purpleFill;
    case 'HEAT':
      return h.severity === 0 ? T.orangeFill : T.amberFill;
    case 'FIRE_SUSPECTED':
    case 'FALL':
      return T.redFill;
    case 'NO_MOTION':
      return T.amberFill;
    default:
      return T.grayFill;
  }
}

// Leaflet path style for a hazard zone. Cleared hazards are lighter; a stale position is dashed.
export function hazardStyle(h, live) {
  const color = hazardColor(h);
  return {
    color,
    weight: h.active ? 2 : 1.5,
    opacity: h.active ? 0.95 : 0.5,
    fillColor: color,
    fillOpacity: h.active ? (live ? 0.24 : 0.18) : 0.07,
    dashArray: h.posStale ? '6 5' : null,
  };
}

// Pin hazards, most important first.
export const PIN_RANK = { FALL: 0, FIRE_SUSPECTED: 1, NO_MOTION: 2 };
const PIN_SAME_POINT_M = 5;

// The backend opens a hazard at the responder's position, so a fall and the no-motion that
// follows usually share one point. Active pins within PIN_SAME_POINT_M form a group: the most
// important one stands on the point (slot 0) and the others sit beside it as badges (slot 1, 2).
// Cleared pins come first so active ones draw over them. -> [{ h, slot }]
export function layoutPins(hazards) {
  const pins = hazards.filter((h) => PIN_RANK[h.type] !== undefined);
  const out = pins.filter((h) => !h.active).map((h) => ({ h, slot: 0 }));
  const active = pins.filter((h) => h.active).sort((a, b) => PIN_RANK[a.type] - PIN_RANK[b.type]);
  const groups = [];
  for (const h of active) {
    const group = groups.find((g) => haversineM(g[0].lat, g[0].lon, h.lat, h.lon) <= PIN_SAME_POINT_M);
    if (group) group.push(h);
    else groups.push([h]);
  }
  groups.forEach((g) => g.forEach((h, slot) => out.push({ h, slot })));
  return out;
}
