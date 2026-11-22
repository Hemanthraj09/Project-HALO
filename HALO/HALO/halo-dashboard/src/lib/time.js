// Time helpers. Ages and offline detection use ts_ms (epoch ms) when present; older records only
// carry an ISO string, which Date.parse reads as browser-local time when it has no offset (dash-3).

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// No packet for this long = link lost (the backend's LINK_LOST_SEC is also 20 s).
export const STALE_MS = 20000;

// Epoch ms of a live/readings/alerts record: ts_ms, else Date.parse(ts), else null.
export function recordMs(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (isFiniteNum(rec.ts_ms)) return rec.ts_ms;
  if (typeof rec.ts === 'string') {
    const p = Date.parse(rec.ts);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

const hmsFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const hmFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Local wall-clock time, HH:MM:SS.
export function fmtClock(ms) {
  return isFiniteNum(ms) ? hmsFmt.format(ms) : '--:--:--';
}

// Local wall-clock time, HH:MM.
export function fmtHM(ms) {
  return isFiniteNum(ms) ? hmFmt.format(ms) : '--:--';
}

// Elapsed milliseconds as "4 s", "1 min 5 s", "12 min", "1 h 5 min", "2 d 3 h".
export function fmtAgo(ms) {
  if (!isFiniteNum(ms)) return '--';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

// Seconds as "45 s", "25 min", "1 h 50 min" (battery ETA, uptime).
export function fmtDuration(seconds) {
  if (!isFiniteNum(seconds)) return '--';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

// Span between the first and last point of a chart, in ms, e.g. "9 min 58 s".
export function fmtSpan(ms) {
  if (!isFiniteNum(ms) || ms <= 0) return '0 s';
  return fmtAgo(ms);
}

const dayFmt = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short' });

// Event time: HH:MM:SS for today, "22 Nov 14:05:09" for older events (alert log, hazard popups).
export function fmtStamp(ms, now = Date.now()) {
  if (!isFiniteNum(ms)) return '--:--:--';
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return sameDay ? hmsFmt.format(ms) : `${dayFmt.format(ms)} ${hmsFmt.format(ms)}`;
}

// Browser time-zone abbreviation, e.g. "IST", "GMT+5:30" or "CET" (depends on the browser locale).
export function tzAbbrev(ms = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(ms);
    const p = parts.find((x) => x.type === 'timeZoneName');
    return p ? p.value : '';
  } catch (e) {
    return '';
  }
}

// IANA time-zone name, e.g. "Asia/Kolkata".
export function tzName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (e) {
    return '';
  }
}
