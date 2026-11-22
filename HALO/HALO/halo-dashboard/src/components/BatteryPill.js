// Battery indicator: icon + % in the battery colour (red < 10 %, amber < 20 %, green otherwise,
// grey "--" when not measured). The tooltip carries volts, ETA and trend.

import React from 'react';
import { Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning } from 'lucide-react';
import { batteryInfo } from '../lib/format';

export function batteryIcon(b) {
  if (b.trend === 'charging') return BatteryCharging;
  if (!b.known) return Battery;
  if (b.pct < 10) return BatteryWarning;
  if (b.pct < 40) return BatteryLow;
  if (b.pct < 75) return BatteryMedium;
  return BatteryFull;
}

export default function BatteryPill({ r, which }) {
  const b = batteryInfo(r, which);
  const Icon = batteryIcon(b);
  return (
    <span className="batt-pill" title={b.title} style={{ color: b.color }}>
      <Icon size={16} aria-hidden="true" />
      <span className="batt-name">{b.name}</span>
      <span>{b.text}</span>
      <span className="sr-only">{b.title}</span>
    </span>
  );
}
