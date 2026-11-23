// Light / dark switch at the right end of the LIVE / ANALYTICS bar, under the header clock. A
// toggle button: the label stays "Dark mode" and aria-pressed carries the state; the icon shows
// the theme it switches to.

import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/themeMode';

export default function ThemeToggle() {
  const { mode, toggle } = useTheme();
  const dark = mode === 'dark';
  const Icon = dark ? Sun : Moon;
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      aria-label="Dark mode"
      aria-pressed={dark}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggle}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
