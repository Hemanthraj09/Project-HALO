// Firebase subscriptions for the ANALYTICS tab (spec section 10 contract):
//   profiles/<id>
//   analytics/<id>/sessions  orderByKey, limitToLast(20)
//   analytics/<id>/minutes   orderByKey, limitToLast(720)
// plus, only when an older session lies outside those 720 minutes, a bounded range query for
// that session's minutes. Every listener has an error callback.

import { useEffect, useReducer, useState } from 'react';
import { endAt, limitToLast, onValue, orderByKey, query, ref, startAt } from 'firebase/database';
import { db } from '../firebase';
import {
  MINUTE_MS, MINUTES_QUERY_LIMIT, SESSIONS_QUERY_LIMIT,
  classifyDbError, isSafeKey, minutesFromSnapshot, sessionsFromSnapshot,
} from './metrics';

const initial = (id) => ({
  id,
  profile: null,
  sessions: [],
  minutes: [],
  loaded: { profile: false, sessions: false, minutes: false },
  error: null,
});

function reducer(state, action) {
  if (action.type === 'reset') return state.id === action.id ? state : initial(action.id);
  if (action.id !== state.id) return state;   // late callback for a responder no longer shown
  if (action.type === 'data') {
    return { ...state, [action.key]: action.value, loaded: { ...state.loaded, [action.key]: true } };
  }
  if (action.type === 'error') {
    return { ...state, error: state.error || { ...action.error, key: action.key }, loaded: { ...state.loaded, [action.key]: true } };
  }
  return state;
}

const asProfile = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// retry: bump it to drop the current listeners (and any error) and subscribe again.
export function useAnalyticsData(id, retry) {
  const [state, dispatch] = useReducer(reducer, id, initial);
  useEffect(() => {
    dispatch({ type: 'reset', id });
    if (!isSafeKey(id)) return undefined;
    const listen = (key, q, parse) => onValue(
      q,
      (snap) => dispatch({ type: 'data', id, key, value: parse(snap.exists() ? snap.val() : null) }),
      (err) => dispatch({ type: 'error', id, key, error: classifyDbError(err) }),
    );
    const unsubs = [
      listen('profile', ref(db, `profiles/${id}`), asProfile),
      listen('sessions', query(ref(db, `analytics/${id}/sessions`), orderByKey(), limitToLast(SESSIONS_QUERY_LIMIT)), sessionsFromSnapshot),
      listen('minutes', query(ref(db, `analytics/${id}/minutes`), orderByKey(), limitToLast(MINUTES_QUERY_LIMIT)), minutesFromSnapshot),
    ];
    return () => {
      unsubs.forEach((unsub) => unsub());
      dispatch({ type: 'reset', id: null });
    };
  }, [id, retry]);
  return state.id === id ? state : initial(id);
}

// Minutes of one closed session, by key range (minute keys are epoch minutes, compared as integers).
// retry: bump it to drop the listener (and any error) and subscribe again, as useAnalyticsData.
export function useSessionMinutes(id, session, enabled, retry = 0) {
  const startMin = session ? Math.floor(session.start_ms / MINUTE_MS) : null;
  const endMin = session ? Math.floor(session.end_ms / MINUTE_MS) : null;
  const key = enabled && isSafeKey(id) && startMin !== null ? `${id}|${startMin}|${endMin}|${retry}` : null;
  const [state, setState] = useState({ key: null, minutes: [], loaded: false, error: null });
  useEffect(() => {
    if (!key) return undefined;
    const q = query(ref(db, `analytics/${id}/minutes`), orderByKey(), startAt(String(startMin)), endAt(String(endMin)),
      limitToLast(MINUTES_QUERY_LIMIT));
    return onValue(
      q,
      (snap) => setState({ key, minutes: minutesFromSnapshot(snap.exists() ? snap.val() : null), loaded: true, error: null }),
      (err) => setState({ key, minutes: [], loaded: true, error: classifyDbError(err) }),
    );
  }, [key, id, startMin, endMin]);
  return state.key === key ? state : { key, minutes: [], loaded: !key, error: null };
}
