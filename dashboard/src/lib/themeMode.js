// Light / dark mode. The first visit follows the OS setting (prefers-color-scheme) and keeps
// following it; once the operator uses the header toggle, that choice is kept in localStorage.
// The theme is applied before the first render (module load), and a switch re-renders every
// component that subscribes with useTheme(): no reload and no remount, so selection, tabs, the
// map view and the Firebase listeners stay as they are. public/index.html applies the same rule
// before the bundle loads, so a dark page never flashes white. A choice made in another window of
// the dashboard is picked up through the storage event.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { applyTheme, PALETTES, themeMode } from '../theme';

const STORAGE_KEY = 'halo.theme.v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const isMode = (v) => v === 'light' || v === 'dark';

function storedChoice() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isMode(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function saveChoice(mode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch (e) {
    // Storage blocked: the choice still holds for this page load.
  }
}

function darkQuery() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
}

const osMode = () => {
  const q = darkQuery();
  return q && q.matches ? 'dark' : 'light';
};

// Native controls (scrollbars, select menus, checkboxes) follow color-scheme.
function apply(mode) {
  applyTheme(mode);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode;
  }
}

// The operator's choice for this page: kept here as well, so it still holds when storage is blocked.
let chosen = storedChoice();

apply(chosen || osMode());

const ThemeContext = createContext({ mode: themeMode(), tokens: PALETTES[themeMode()], toggle: () => {} });

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(themeMode);

  const switchTo = useCallback((next) => {
    if (next === themeMode()) return;
    apply(next); // the tokens change before the re-render that this state update starts
    setMode(next);
  }, []);

  const toggle = useCallback(() => {
    const next = themeMode() === 'dark' ? 'light' : 'dark';
    chosen = next;
    saveChoice(next);
    switchTo(next);
  }, [switchTo]);

  // Another window toggled (or cleared) the stored choice: follow it.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY && e.key !== null) return;
      chosen = isMode(e.newValue) ? e.newValue : null;
      switchTo(chosen || osMode());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [switchTo]);

  // Until the operator chooses, follow the OS setting when it changes.
  useEffect(() => {
    const q = darkQuery();
    if (!q) return undefined;
    const onChange = () => {
      if (chosen === null) switchTo(q.matches ? 'dark' : 'light');
    };
    if (typeof q.addEventListener === 'function') q.addEventListener('change', onChange);
    else q.addListener(onChange);
    return () => {
      if (typeof q.removeEventListener === 'function') q.removeEventListener('change', onChange);
      else q.removeListener(onChange);
    };
  }, [switchTo]);

  const value = useMemo(() => ({ mode, tokens: PALETTES[mode], toggle }), [mode, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// { mode, tokens, toggle }. Calling it subscribes the component to theme switches, which also
// re-renders a React.memo component whose props did not change. `tokens` is the active palette
// object (a new identity per theme), the dependency for memos that hold colours.
export function useTheme() {
  return useContext(ThemeContext);
}
