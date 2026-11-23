// DEVICE tab: the arm link, sensors present, PPG quality, the LoRa link, chest
// uptime, GPS quality and the data source.

import React from 'react';
import { Cpu, Database, Radio, Satellite, Unplug } from 'lucide-react';
import { T } from '../theme';
import { fmtBool, fmtNum } from '../lib/format';
import { gpsState } from '../lib/geo';
import { isNum } from '../lib/num';
import { gpsUart, mqWarmupS } from '../lib/sensors';
import { fmtDuration } from '../lib/time';
import { Age } from './TimeText';
import { Card, Flag, Row } from './ui';

const SENSORS = [
  ['imu', 'IMU (MPU6050)'],
  ['bme', 'BME280'],
  ['ppg', 'MAX30102'],
  ['gps_uart', 'GPS NMEA'],
];

function SensorFlags({ r }) {
  const s = r.sensors && typeof r.sensors === 'object' ? r.sensors : null;
  if (!s) return <div className="note">Not reported</div>;
  return (
    <div className="flags">
      {SENSORS.map(([key, label]) => (
        <Flag key={key} on={typeof s[key] === 'boolean' ? s[key] : null}>
          {label}
          {s[key] === undefined ? ' ?' : ''}
        </Flag>
      ))}
    </div>
  );
}

function coSensorNote(r) {
  if (mqWarmupS(r) !== null) return 'warming up';
  return r.co_sat === true ? 'saturated' : null;
}

export default function DeviceTab({ r, lost }) {
  const g = gpsState(r, lost);
  const armOff = r.arm_ok === false;
  return (
    <>
      <Card title="Arm link" icon={Unplug}>
        <div className="rows">
          <Row label="Arm strap" value={armOff ? 'OFFLINE' : fmtBool(r.arm_ok, 'connected', 'offline')} color={armOff ? T.amber : undefined} />
          <Row label="ESP-NOW loss" value={isNum(r.arm_loss_pct) ? `${Math.round(r.arm_loss_pct)} %` : '--'} />
          <Row label="Skin contact" value={armOff ? '--' : fmtBool(r.skin, 'on skin', 'not on skin')} />
          <Row label="PPG quality" value={!armOff && isNum(r.ppg_q) ? `${Math.round(r.ppg_q)} / 100` : '--'} />
          <Row label="Motion hold" value={armOff ? '--' : fmtBool(r.ppg_motion, 'HR/SpO₂ held', 'no')} />
        </div>
      </Card>

      <Card title="Sensors present" icon={Cpu}>
        <SensorFlags r={r} />
      </Card>

      <Card title="LoRa link" icon={Radio}>
        <div className="rows">
          <Row label="RSSI" value={isNum(r.rssi) ? `${Math.round(r.rssi)} dBm` : '--'} />
          <Row label="SNR" value={isNum(r.snr) ? `${r.snr.toFixed(1)} dB` : '--'} />
          <Row label="Packet loss" value={isNum(r.link_loss_pct) ? `${fmtNum(r.link_loss_pct, 0)} %` : '--'} />
          <Row label="Radio re-inits" value={isNum(r.lora_reinits) ? String(r.lora_reinits) : '--'} />
          <Row label="Chest uptime" value={isNum(r.chest_uptime_min) ? fmtDuration(r.chest_uptime_min * 60) : '--'} />
          <Row label="Sequence" value={isNum(r.seq) ? String(r.seq) : '--'} />
          <Row label="Chest priority" value={isNum(r.device_pri) ? `P${r.device_pri}` : '--'} />
        </div>
      </Card>

      <Card title="GPS" icon={Satellite}>
        <div className="rows">
          <Row label="Fix" value={g.kind === 'none' ? g.text : g.kind} note={g.sats} color={g.kind === 'fresh' ? T.green : g.kind === 'stale' ? T.amber : undefined} />
          <Row label="Fix age" value={g.fixMs !== null ? <Age since={g.fixMs} suffix=" ago" /> : '--'} />
          <Row label="Satellites" value={isNum(r.gps_sats) ? String(r.gps_sats) : '--'} />
          <Row label="HDOP" value={isNum(r.gps_hdop) ? r.gps_hdop.toFixed(1) : '--'} />
          <Row label="Accuracy" value={isNum(r.gps_acc_m) ? `±${Math.round(r.gps_acc_m)} m` : '--'} />
          <Row label="NMEA from module" value={fmtBool(gpsUart(r), 'yes', 'no data')} />
        </div>
      </Card>

      <Card title="Data source" icon={Database}>
        <div className="rows">
          <Row label="Source" value={r.source === 'simulator' ? 'simulator' : r.source === 'hardware' ? 'hardware' : '--'} />
          <Row label="Packet format" value={r.fmt === 2 ? 'v2 binary (LoRa)' : r.fmt === 1 ? 'v1 text (legacy)' : '--'} />
          <Row label="CO sensor" value={isNum(r.co_raw_mv) ? `${Math.round(r.co_raw_mv)} mV` : '--'} note={coSensorNote(r)} />
          <Row label="MQ135 sensor" value={isNum(r.aq_raw_mv) ? `${Math.round(r.aq_raw_mv)} mV` : '--'} note={mqWarmupS(r) !== null ? 'warming up' : null} />
        </div>
      </Card>
    </>
  );
}
