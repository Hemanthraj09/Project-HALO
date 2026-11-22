// lucide-react icons for alert types and alert-log events.

import {
  Activity,
  ArrowUpDown,
  BatteryWarning,
  Bell,
  BellRing,
  CheckCircle2,
  CloudFog,
  Flame,
  Gauge,
  HeartPulse,
  Hourglass,
  RadioTower,
  Repeat,
  Siren,
  Thermometer,
  ThermometerSun,
  Unplug,
  Wind,
} from 'lucide-react';
import { T } from '../theme';

export const TYPE_ICONS = {
  FALL: Siren,
  NO_MOTION: Hourglass,
  CO: Wind,
  CO_TWA: Wind,
  AIR: CloudFog,
  FIRE_SUSPECTED: Flame,
  SPO2: Activity,
  HR: HeartPulse,
  CORE_TEMP: Thermometer,
  HEAT: ThermometerSun,
  ARM_LINK: Unplug,
  CO_SENSOR: Gauge,
  BATT_CHEST: BatteryWarning,
  BATT_ARM: BatteryWarning,
  LINK: RadioTower,
};

export function typeIcon(type) {
  return TYPE_ICONS[type] || Bell;
}

// Event presentation. `color` gets the record's severity entry (may be null for legacy records).
export const EVENT_META = {
  raised: { label: 'raised', Icon: BellRing, color: (sev) => (sev ? sev.color : T.textMuted) },
  changed: { label: 'changed', Icon: ArrowUpDown, color: (sev) => (sev ? sev.color : T.textMuted) },
  ongoing: { label: 'ongoing', Icon: Repeat, color: () => T.textDim },
  cleared: { label: 'cleared', Icon: CheckCircle2, color: () => T.green },
  legacy: { label: 'logged', Icon: Bell, color: (sev) => (sev ? sev.color : T.textMuted) },
};
