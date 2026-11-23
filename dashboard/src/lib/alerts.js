// Alert types and alert-log records.
//
// alerts/<pushId> = {ts, ts_ms, responder_id, type, kind, priority, reason, event}.
// Records written before Session 4 have only {ts, responder_id, priority, reason}; they are shown
// as "logged" events. A legacy nested node such as alerts/HALO-01/<pushId> is flattened, and its
// key is reported so the operator can delete it (it sorts after every push ID, so
// limitToLast always downloads it in full).

import { recordMs } from './time';

export const ALERT_META = {
  FALL: { label: 'Fall', kind: 'health' },
  NO_MOTION: { label: 'No motion', kind: 'health' },
  CO: { label: 'Carbon monoxide', kind: 'env' },
  CO_TWA: { label: 'CO 15-min TWA', kind: 'env' },
  AIR: { label: 'Air quality', kind: 'env' },
  FIRE_SUSPECTED: { label: 'Possible fire/smoke', kind: 'env' },
  SPO2: { label: 'SpO₂', kind: 'health' },
  HR: { label: 'Heart rate', kind: 'health' },
  CORE_TEMP: { label: 'Core temp (est.)', kind: 'health' },
  HEAT: { label: 'Heat', kind: 'env' },
  ARM_LINK: { label: 'Arm strap link', kind: 'device' },
  ARM_IMU: { label: 'Arm motion sensor', kind: 'device' },
  CO_SENSOR: { label: 'CO sensor', kind: 'device' },
  BATT_CHEST: { label: 'Chest battery', kind: 'device' },
  BATT_ARM: { label: 'Arm battery', kind: 'device' },
  LINK: { label: 'Link lost', kind: 'link' },
};

export const ALERT_EVENTS = ['raised', 'changed', 'ongoing', 'cleared'];

export const ALERT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'p0', label: 'P0' },
  { key: 'p1', label: 'P1' },
  { key: 'device', label: 'Device', title: 'Sensor and link alerts' },
];

export function alertLabel(type) {
  if (type && ALERT_META[type]) return ALERT_META[type].label;
  return type || 'Alert';
}

export function alertKind(type, kind) {
  if (typeof kind === 'string' && kind) return kind;
  return type && ALERT_META[type] ? ALERT_META[type].kind : null;
}

function toAlert(key, a) {
  const type = typeof a.type === 'string' && a.type ? a.type : null;
  return {
    key,
    ms: recordMs(a),
    responderId: typeof a.responder_id === 'string' ? a.responder_id : '',
    type,
    label: alertLabel(type),
    kind: alertKind(type, a.kind),
    priority: a.priority === 0 || a.priority === 1 || a.priority === 2 ? a.priority : null,
    reason: a.reason,
    event: ALERT_EVENTS.includes(a.event) ? a.event : null,
  };
}

function newestFirst(a, b) {
  const am = a.ms === null ? -Infinity : a.ms;
  const bm = b.ms === null ? -Infinity : b.ms;
  if (bm !== am) return bm > am ? 1 : -1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}

// Flatten a snapshot value of alerts/ into a newest-first list of at most `limit` records.
export function normaliseAlerts(val, limit) {
  const list = [];
  const legacyKeys = [];
  if (val && typeof val === 'object') {
    for (const [key, item] of Object.entries(val)) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.reason === 'string') {
        list.push(toAlert(key, item));
        continue;
      }
      let nested = 0;
      for (const [subKey, sub] of Object.entries(item)) {
        if (sub && typeof sub === 'object' && typeof sub.reason === 'string') {
          list.push(toAlert(`${key}/${subKey}`, sub));
          nested += 1;
        }
      }
      if (nested > 0) legacyKeys.push(key);
    }
  }
  list.sort(newestFirst);
  return { list: list.length > limit ? list.slice(0, limit) : list, legacyKeys };
}

export function filterAlerts(list, filter) {
  switch (filter) {
    case 'p0':
      return list.filter((a) => a.priority === 0);
    case 'p1':
      return list.filter((a) => a.priority === 1);
    case 'device':
      return list.filter((a) => a.kind === 'device' || a.kind === 'link');
    default:
      return list;
  }
}
