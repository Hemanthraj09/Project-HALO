// Priority key under the alert log: one line tying the P0 / P1 / P2 chips to their names. The
// rules themselves are the backend's (SPEC §8.5); the dashboard does not restate them.

import React from 'react';
import { SEVERITY } from '../theme';

export default function PriorityLegend() {
  return (
    <div className="legend" aria-label="Priority key">
      {[0, 1, 2].map((p) => (
        <span key={p} className="legend-key" style={{ color: SEVERITY[p].color }}>
          <span className="legend-dot" style={{ background: SEVERITY[p].fill }} aria-hidden="true" />
          {SEVERITY[p].label} {SEVERITY[p].name}
        </span>
      ))}
    </div>
  );
}
