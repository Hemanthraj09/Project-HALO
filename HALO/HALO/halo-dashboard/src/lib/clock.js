// One shared ticker, aligned to the wall-clock second, for every component that shows a running
// clock or an age. Only those small components subscribe with useNow, so the 1 s tick re-renders
// the clock, the ages and nothing else (dash-13).
//
// useLostIds lets a parent know which responders are past the 20 s link-loss line. It subscribes
// to the same ticker but its snapshot is a string of IDs, so its owner re-renders only when a
// responder actually crosses the line.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { isLinkLost } from './status';

let nowMs = Date.now();
let timer = null;
let ticking = false;
const listeners = new Set();

const msToNextSecond = () => 1000 - (Date.now() % 1000) + 5;

function tick() {
  nowMs = Date.now();
  ticking = true;
  listeners.forEach((fn) => fn());
  ticking = false;
  timer = listeners.size > 0 ? setTimeout(tick, msToNextSecond()) : null;
}

function subscribe(fn) {
  listeners.add(fn);
  if (timer === null && !ticking) {
    nowMs = Date.now();
    timer = setTimeout(tick, msToNextSecond());
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== null && !ticking) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

const getNow = () => nowMs;

export function useNow() {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

export function useLostIds(responders) {
  const getKey = useCallback(
    () => Object.keys(responders).filter((id) => isLinkLost(responders[id], nowMs)).sort().join('\n'),
    [responders],
  );
  const key = useSyncExternalStore(subscribe, getKey, getKey);
  return useMemo(() => new Set(key ? key.split('\n') : []), [key]);
}

// Coarse clock for slow-changing filters (hazard time windows). Re-renders its owner every periodMs.
export function useEvery(periodMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}
