// Realtime Database listeners. These hooks are only used inside the signed-in dashboard, so no
// listener is attached before sign-in. Every onValue has an error callback; a PERMISSION_DENIED
// error is reported per path so the UI can show the "Not authorised" panel.
// A snapshot that does not exist clears the matching state.

import { useEffect, useMemo, useState } from 'react';
import { limitToLast, onValue, orderByKey, query, ref } from 'firebase/database';
import { db } from '../firebase';
import { normaliseAlerts } from './alerts';
import { normaliseHazards } from './hazards';

export const ALERTS_LIMIT = 150;
export const HAZARDS_LIMIT = 300;
export const READINGS_LIMIT = 300;

const EMPTY_LIST = [];

export function describeDbError(err, path) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return {
    path,
    code,
    denied: code === 'PERMISSION_DENIED',
    message: err && err.message ? String(err.message) : 'Unknown database error',
  };
}

function liveObject(snap) {
  const val = snap.exists() ? snap.val() : null;
  const out = {};
  if (!val || typeof val !== 'object') return out;
  for (const [id, r] of Object.entries(val)) {
    if (r && typeof r === 'object') out[id] = r;
  }
  return out;
}

// Keep the previous object for responders whose data did not change, so memoised cards and map
// markers for those responders skip re-rendering when another responder updates.
function keepUnchanged(prev, next) {
  const out = {};
  for (const id of Object.keys(next)) {
    const p = prev[id];
    out[id] = p && JSON.stringify(p) === JSON.stringify(next[id]) ? p : next[id];
  }
  return out;
}

export function useLiveData(attempt) {
  const [connected, setConnected] = useState(false);
  const [responders, setResponders] = useState({});
  const [alerts, setAlerts] = useState({ list: EMPTY_LIST, legacyKeys: EMPTY_LIST });
  const [hazards, setHazards] = useState(EMPTY_LIST);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    const fail = (path) => (err) => setErrors((prev) => ({ ...prev, [path]: describeDbError(err, path) }));
    const ok = (path) => setErrors((prev) => (prev[path] ? { ...prev, [path]: null } : prev));
    setErrors((prev) => (Object.keys(prev).length ? {} : prev));

    const offs = [
      onValue(ref(db, '.info/connected'), (snap) => setConnected(snap.val() === true), fail('.info/connected')),
      onValue(
        ref(db, 'live'),
        (snap) => {
          ok('live');
          const next = liveObject(snap);
          setResponders((prev) => keepUnchanged(prev, next));
        },
        fail('live'),
      ),
      onValue(
        query(ref(db, 'alerts'), orderByKey(), limitToLast(ALERTS_LIMIT)),
        (snap) => {
          ok('alerts');
          setAlerts(normaliseAlerts(snap.exists() ? snap.val() : null, ALERTS_LIMIT));
        },
        fail('alerts'),
      ),
      onValue(
        query(ref(db, 'hazards'), orderByKey(), limitToLast(HAZARDS_LIMIT)),
        (snap) => {
          ok('hazards');
          setHazards(normaliseHazards(snap.exists() ? snap.val() : null));
        },
        fail('hazards'),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [attempt]);

  return { connected, responders, alerts: alerts.list, legacyAlertKeys: alerts.legacyKeys, hazards, errors };
}

// readings/<id>, newest READINGS_LIMIT by push key (chronological). Used for the deep-dive
// charts and the map trail of the selected responder.
export function useReadings(id, attempt) {
  const [state, setState] = useState({ id: null, list: EMPTY_LIST, error: null });

  useEffect(() => {
    if (!id) return undefined;
    const path = `readings/${id}`;
    return onValue(
      query(ref(db, path), orderByKey(), limitToLast(READINGS_LIMIT)),
      (snap) => {
        const list = [];
        snap.forEach((child) => {
          const v = child.val();
          if (v && typeof v === 'object') list.push(v);
        });
        setState({ id, list, error: null });
      },
      (err) => setState({ id, list: EMPTY_LIST, error: describeDbError(err, path) }),
    );
  }, [id, attempt]);

  return useMemo(
    () => (state.id === id ? { ...state, loading: false } : { id, list: EMPTY_LIST, error: null, loading: Boolean(id) }),
    [state, id],
  );
}
