// The only components that re-render on the 1 s tick: the header clock and running ages.

import React from 'react';
import { useNow } from '../lib/clock';
import { isNum } from '../lib/num';
import { fmtAgo, fmtClock, tzAbbrev, tzName } from '../lib/time';

// "<prefix>12 s<suffix>" counting up from `since` (epoch ms). Renders `fallback` when unknown.
export function Age({ since, prefix, suffix, fallback }) {
  const now = useNow();
  if (!isNum(since)) return fallback === undefined ? null : <>{fallback}</>;
  return (
    <span className="num">
      {prefix}
      {fmtAgo(now - since)}
      {suffix}
    </span>
  );
}

export function Clock() {
  const now = useNow();
  const zone = tzName();
  return (
    <span className="clock" title={zone || undefined}>
      <span className="clock-time num">{fmtClock(now)}</span>
      <span className="clock-tz">{tzAbbrev(now)}</span>
    </span>
  );
}
