// Responder status, header counters and the active-alert list.
//
// A responder is offline (link lost) when its last packet is older than STALE_MS or the backend
// watchdog set live.link_lost. An offline responder keeps its last priority (dash-1): the badge
// says LINK LOST, "last: MAYDAY" stays visible, the outline keeps the last priority colour, and a
// last-known MAYDAY still counts in CRITICAL as well as in LINK LOST.

import { SEVERITY, STATUS } from '../theme';
import { ALERT_META, alertLabel } from './alerts';
import { isNum } from './num';
import { stillBand } from './thresholds';
import { STALE_MS, recordMs } from './time';

export function isLinkLost(r, now) {
  if (!r || typeof r !== 'object') return true;
  if (r.link_lost === true) return true;
  const ms = recordMs(r);
  return ms === null || now - ms > STALE_MS;
}

export function lastPriority(r) {
  const p = r ? r.priority : undefined;
  return p === 0 || p === 1 || p === 2 ? p : 2;
}

export function responderStatus(r, lost) {
  const priority = lastPriority(r);
  let key = 'nominal';
  if (lost) key = 'offline';
  else if (priority === 0) key = 'critical';
  else if (priority === 1) key = 'warning';
  return { key, priority, lost: Boolean(lost), ...STATUS[key], last: SEVERITY[priority] };
}

export function countResponders(responders, lostIds) {
  const c = { total: 0, critical: 0, warning: 0, nominal: 0, lost: 0 };
  for (const id of Object.keys(responders)) {
    const lost = lostIds.has(id);
    const p = lastPriority(responders[id]);
    c.total += 1;
    if (lost) c.lost += 1;
    if (p === 0) c.critical += 1;
    else if (!lost && p === 1) c.warning += 1;
    else if (!lost) c.nominal += 1;
  }
  return c;
}

// Most severe first, so a MAYDAY card is never below the fold. A lost link ranks at least as a
// WARNING (the backend's LINK alert is P1, or P0 after a MAYDAY or a fall). Ties keep ID order.
export function sortResponderIds(responders, lostIds) {
  const rank = (id) => {
    const p = lastPriority(responders[id]);
    return lostIds && lostIds.has(id) ? Math.min(p, 1) : p;
  };
  return Object.keys(responders).sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

const KIND_RANK = { health: 0, env: 0, link: 1, device: 2 };

function compareActive(x, y) {
  if (x.severity !== y.severity) return x.severity - y.severity;
  const kx = KIND_RANK[x.kind] === undefined ? 0 : KIND_RANK[x.kind];
  const ky = KIND_RANK[y.kind] === undefined ? 0 : KIND_RANK[y.kind];
  if (kx !== ky) return kx - ky;
  const sx = x.sinceMs === null ? 0 : x.sinceMs;
  const sy = y.sinceMs === null ? 0 : y.sinceMs;
  if (sx !== sy) return sy - sx;
  if (x.id === y.id) return 0;
  return x.id < y.id ? -1 : 1;
}

// Active alerts from live/<id>/active_alerts (type -> {severity, reason, kind, since_ms}).
// Sorted most severe first; equal severity puts health/env before link and device alerts,
// then the newest first.
// For a lost link (`lost`), the stored alerts are the last known ones (lastKnown: true). The
// backend's link watchdog normally adds LINK; when the backend is down, or restarted while this
// chest was silent, nothing does, so a LINK alert is added here with the backend's severity rule.
export function activeAlertsOf(id, r, lost = false) {
  const out = [];
  const aa = r && r.active_alerts;
  if (aa && typeof aa === 'object') {
    for (const type of Object.keys(aa)) {
      const a = aa[type];
      if (!a || typeof a !== 'object' || (a.severity !== 0 && a.severity !== 1)) continue;
      const meta = ALERT_META[type];
      out.push({
        id: `${id}/${type}`,
        responderId: id,
        type,
        label: alertLabel(type),
        severity: a.severity,
        reason: typeof a.reason === 'string' && a.reason ? a.reason : alertLabel(type),
        kind: typeof a.kind === 'string' && a.kind ? a.kind : meta ? meta.kind : 'health',
        sinceMs: isNum(a.since_ms) ? a.since_ms : null,
        lastKnown: Boolean(lost) && type !== 'LINK',
      });
    }
  }
  if (lost && !out.some((a) => a.type === 'LINK')) {
    out.push({
      id: `${id}/LINK`,
      responderId: id,
      type: 'LINK',
      label: alertLabel('LINK'),
      severity: lastPriority(r) === 0 || (r && r.fall === true) ? 0 : 1,
      reason: 'LINK LOST',
      kind: 'link',
      sinceMs: recordMs(r),
      lastKnown: false,
    });
  }
  out.sort(compareActive);
  return out;
}

// NO MOTION banner state: the backend's NO_MOTION alert when present, else the same rule applied
// to the live still_s (>= 30 s P1, >= 60 s P0, only with skin contact or an active fall).
export function noMotionState(r) {
  if (!r) return null;
  const still = isNum(r.still_s) ? r.still_s : null;
  const aa = r.active_alerts && r.active_alerts.NO_MOTION;
  if (aa && (aa.severity === 0 || aa.severity === 1)) return { severity: aa.severity, still, reason: typeof aa.reason === 'string' ? aa.reason : null };
  if (r.arm_ok === false || still === null) return null;
  const b = stillBand(still, r.skin, r.fall);
  if (b.level === 3) return { severity: 0, still, reason: null };
  if (b.level === 1) return { severity: 1, still, reason: null };
  return null;
}

export function collectActiveAlerts(responders, lostIds) {
  const out = [];
  for (const id of Object.keys(responders)) out.push(...activeAlertsOf(id, responders[id], Boolean(lostIds && lostIds.has(id))));
  out.sort(compareActive);
  return out;
}
