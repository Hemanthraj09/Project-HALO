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
// t: the active palette (useTheme().tokens); coBand reads the same live tokens.
export function trailColor(co, sat, t = T) {
  const b = coBand(co, sat);
  if (b.level <= 0) return t.blueFill;
  return b.fill;
}

const TRAIL_GAP_MS = 120000; // a longer pause between two fixes starts a new line

// GPS fixes wander by a few metres even when the receiver does not move, so a line through every
// fix draws a standing responder as a zig-zag. A fix within the step distance of the current trail
// point is averaged into it (weighted by 1 / accuracy²). A fix outside it is held; the trail moves on
// only when the next fix lands near the held one, or even farther away (fast movement). A single
// stray fix therefore moves nothing. The step is the fix's accuracy (gps_acc_m) kept within 8-25 m.
const TRAIL_STEP_MIN_M = 8;
const TRAIL_STEP_MAX_M = 25;
const TRAIL_ACC_DEFAULT_M = 15; // readings without gps_acc_m

const trailStepM = (acc) => Math.min(TRAIL_STEP_MAX_M, Math.max(TRAIL_STEP_MIN_M, acc));

// A trail point: the weighted mean position of its n fixes, plus the highest CO among them and when
// it was read (co null = no valid CO).
function newTrailPoint(f) {
  const q = { lat: f.lat, lon: f.lon, n: 0, w: 0, wLat: 0, wLon: 0, co: null, coT: null, sat: false };
  mergeTrailFix(q, f);
  return q;
}

function mergeTrailCo(q, f) {
  if (f.co !== null && (q.co === null || f.co > q.co)) {
    q.co = f.co;
    q.coT = f.coT;
  }
  q.sat = q.sat || f.sat;
}

function mergeTrailFix(q, f) {
  const w = 1 / (f.acc * f.acc);
  q.n += 1;
  q.w += w;
  q.wLat += f.lat * w;
  q.wLon += f.lon * w;
  q.lat = q.wLat / q.w;
  q.lon = q.wLon / q.w;
  mergeTrailCo(q, f);
}

const distM = (a, b) => haversineM(a.lat, a.lon, b.lat, b.lon);

// readings -> { lines: [{ positions, color }], dots: [{ key, lat, lon, co, sat, t, color }] }
// Only gps_ok points are used. Consecutive segments with the same colour share one polyline.
// CO read while the MQ sensors warm up is not a measurement, so those points count as no CO.
// A dot marks a trail point whose highest CO is above 35 ppm (t = when that CO was read).
// tokens: the palette the colours are for, so a memo of the result can depend on the theme.
export function buildTrail(readings, tokens = T) {
  const runs = []; // trail points joined by lines; a gap in the data starts a new run
  let run = null;
  let cur = null; // the trail point new fixes are merged into
  let held = null; // trail point of the fixes outside cur, kept until it is clear they were not strays
  let lastT = null;
  for (const r of readings) {
    if (!r || r.gps_ok !== true || !validLatLon(r.lat, r.lon)) continue;
    const valid = mqWarmupS(r) === null;
    const t = recordMs(r);
    const f = {
      lat: r.lat,
      lon: r.lon,
      acc: isNum(r.gps_acc_m) && r.gps_acc_m > 0 ? r.gps_acc_m : TRAIL_ACC_DEFAULT_M,
      co: valid && isNum(r.co) ? r.co : null,
      coT: t,
      sat: valid && r.co_sat === true,
    };
    const gap = lastT !== null && t !== null && t - lastT > TRAIL_GAP_MS;
    if (t !== null) lastT = t;
    const step = trailStepM(f.acc);
    if (!cur || gap) {
      if (cur && held) mergeTrailCo(cur, held);
      cur = newTrailPoint(f);
      run = [cur];
      runs.push(run);
      held = null;
    } else if (distM(cur, f) <= step) {
      mergeTrailFix(cur, f);
      if (held) mergeTrailCo(cur, held); // the held position was a stray, its CO was still measured
      held = null;
    } else if (held && distM(held, f) <= step) {
      // two fixes in a row away from cur and close together: the responder moved there. A first
      // point of the run that never got a second fix was a stray first fix (common right after
      // the GPS gets its fix), so it is replaced instead of drawn.
      mergeTrailFix(held, f);
      if (run.length === 1 && cur.n === 1) {
        mergeTrailCo(held, cur);
        run[0] = held;
      } else {
        run.push(held);
      }
      cur = held;
      held = null;
    } else if (held && distM(cur, f) >= distM(cur, held) + step / 2) {
      // moving away faster than one step per fix: the held fix becomes a point, this one is held
      run.push(held);
      cur = held;
      held = newTrailPoint(f);
    } else {
      if (held) mergeTrailCo(cur, held);
      held = newTrailPoint(f);
    }
  }
  const lines = [];
  const dots = [];
  runs.forEach((pts, ri) => {
    let current = null;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const worst = Math.max(a.co === null ? -1 : a.co, b.co === null ? -1 : b.co);
      const color = trailColor(worst < 0 ? null : worst, a.sat || b.sat, tokens);
      if (current && current.color === color) {
        current.positions.push([b.lat, b.lon]);
      } else {
        current = { color, positions: [[a.lat, a.lon], [b.lat, b.lon]] };
        lines.push(current);
      }
    }
    pts.forEach((p, i) => {
      if (p.co !== null && (p.co > TH.CO_P1 || p.sat)) {
        dots.push({ key: `${ri}-${i}`, lat: p.lat, lon: p.lon, co: p.co, sat: p.sat, t: p.coT, color: trailColor(p.co, p.sat, tokens) });
      }
    });
  });
  return { lines, dots };
}

// Hazard colours: CO orange, red at P0; smoke purple; heat amber, orange at P0;
// possible fire red; fall red; no motion amber.
function hazardHue(h) {
  switch (h.type) {
    case 'CO':
      return h.severity === 0 ? 'red' : 'orange';
    case 'AIR':
      return 'purple';
    case 'HEAT':
      return h.severity === 0 ? 'orange' : 'amber';
    case 'FIRE_SUSPECTED':
    case 'FALL':
      return 'red';
    case 'NO_MOTION':
      return 'amber';
    default:
      return 'gray';
  }
}

export const hazardColor = (h) => T[`${hazardHue(h)}Fill`];

// The same hue as a text colour, for the zone tooltips: not every *Fill reaches 4.5:1 as text.
export const hazardTextColor = (h) => T[hazardHue(h)];

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
