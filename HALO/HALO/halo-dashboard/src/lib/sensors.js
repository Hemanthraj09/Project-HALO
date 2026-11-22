// Sensor-state helpers for live/ and readings/ records (SPEC §8.4 "sensors", §12.5 MQ warm-up).

import { isNum } from './num';

// Seconds left in the MQ7/MQ135 heater warm-up, or null when the sensors are ready. The backend
// writes live.mq_warmup_s only while it is > 0, and keeps it next to co/aq in readings/. While it
// runs, co, aq and co_sat are not measurements: no CO/AQI alert, TWA, hazard or analytics use them.
export function mqWarmupS(r) {
  return r && isNum(r.mq_warmup_s) && r.mq_warmup_s > 0 ? r.mq_warmup_s : null;
}

export function warmupText(seconds) {
  return `WARMING UP ~${Math.max(1, Math.ceil(seconds / 60))} min`;
}

// The arm strap is linked but its MPU6050 is not answering (sensors.imu false): the arm pauses
// fall detection and zeroes still_s/activity, so neither FALL nor NO_MOTION can be raised.
export function imuDown(r) {
  return Boolean(r) && r.arm_ok !== false && Boolean(r.sensors) && r.sensors.imu === false;
}

// NMEA arriving from the GPS module: true / false, or null when unknown. live/ carries it only in
// sensors.gps_uart; readings/ records keep a top-level gps_uart.
export function gpsUart(r) {
  if (!r) return null;
  if (r.sensors && typeof r.sensors.gps_uart === 'boolean') return r.sensors.gps_uart;
  return typeof r.gps_uart === 'boolean' ? r.gps_uart : null;
}
