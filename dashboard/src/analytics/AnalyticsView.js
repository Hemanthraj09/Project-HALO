// ANALYTICS tab: performance and fitness analysis of one responder (spec section 10.6).
//
// Contract with App.js: default export AnalyticsView({ responderId, responders }), where
// responders is the live/ map. This file is the data half: it subscribes (useAnalyticsData),
// holds the picker state, and hands everything to AnalyticsPanel, which renders from props only
// (spec 10.8). KPI tiles for a session come from the backend's session record (computed from
// every reading); charts use the 1-minute summaries.

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MINUTE_MS, selectView } from './metrics';
import { useAnalyticsData, useSessionMinutes } from './useAnalyticsData';
import AnalyticsPanel from './AnalyticsPanel';

// Wall clock for the "last 12 h" window and the "ongoing" label; ticks once a minute.
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function AnalyticsView({ responderId, responders }) {
  const now = useMinuteClock();

  // Responder: the live selection, unless the user picked another one here for that selection.
  const idsKey = Object.keys(responders || {}).sort().join('\n');
  const ids = useMemo(() => (idsKey ? idsKey.split('\n') : []), [idsKey]);
  const [pick, setPick] = useState({ forProp: responderId, id: null });
  const id = (pick.forProp === responderId && pick.id) || responderId || ids[0] || null;
  const allIds = useMemo(() => (id && !ids.includes(id) ? [id, ...ids] : ids), [id, ids]);
  const onPickId = useCallback((value) => setPick({ forProp: responderId, id: value }), [responderId]);

  const [retry, setRetry] = useState(0);
  const data = useAnalyticsData(id, retry);
  const onRetry = useCallback(() => setRetry((n) => n + 1), []);

  const [modeChoice, setModeChoice] = useState('session');
  const [sessionPick, setSessionPick] = useState({ id: null, key: null });
  const sessionKey = sessionPick.id === id ? sessionPick.key : null;
  const onSession = useCallback((key) => setSessionPick({ id, key }), [id]);

  // An older session outside the newest 720 minutes gets its own bounded query (Retry re-runs it too).
  const sel = useMemo(() => selectView(data.sessions, data.minutes, modeChoice, sessionKey),
    [data.sessions, data.minutes, modeChoice, sessionKey]);
  const range = useSessionMinutes(id, sel.session, sel.needRange, retry);

  return (
    <AnalyticsPanel id={id} ids={allIds} onPickId={onPickId}
      profile={data.profile} sessions={data.sessions} minutes={data.minutes} loaded={data.loaded}
      error={data.error || range.error} rangeMinutes={range.minutes} rangeLoaded={range.loaded}
      modeChoice={modeChoice} onMode={setModeChoice} sessionKey={sessionKey} onSession={onSession}
      now={now} onRetry={onRetry} />
  );
}

// Re-render only when the responder or the set of responder ids changes, not on every live packet.
function sameProps(prev, next) {
  if (prev.responderId !== next.responderId) return false;
  const a = Object.keys(prev.responders || {});
  const b = Object.keys(next.responders || {});
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
}

export default memo(AnalyticsView, sameProps);
