// Small per-browser preferences (map layers, hazard window, command-post position) kept in
// localStorage. Stored values are validated on load; anything unexpected falls back to the default.

import { useEffect, useState } from 'react';

export function loadJson(key, fallback, isValid) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

export function saveJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Storage blocked or full: the value still works for this page load.
  }
}

export function useStoredState(key, fallback, isValid) {
  const [value, setValue] = useState(() => loadJson(key, fallback, isValid));
  useEffect(() => {
    saveJson(key, value);
  }, [key, value]);
  return [value, setValue];
}
