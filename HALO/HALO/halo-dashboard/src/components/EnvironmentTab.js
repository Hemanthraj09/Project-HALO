// ENVIRONMENT tab: CO + 15-min TWA, MQ135 air index, heat index with ambient temperature and
// humidity, and atmosphere. Colour bands and reference lines use the backend rules.

import React from 'react';
import { CloudFog, Flame, Mountain, ThermometerSun, Wind } from 'lucide-react';
import { T } from '../theme';
import { aqValue, armValue, coValue, fmtNum, heatIndexValue, twaValue } from '../lib/format';
import { isNum } from '../lib/num';
import { aqBand, coBand, heatBand, TH, twaBand } from '../lib/thresholds';
import TimeChart, { ChartCard } from './TimeChart';
import { Banner, BandGauge, Card, Row, Stat } from './ui';

// Constant props keep the memoised charts from re-rendering on every packet.
const FROM_ZERO = [0, 'auto'];
const PERCENT = [0, 100];
const CO_SERIES = [
  { key: 'co', name: 'CO', color: T.orangeFill, unit: 'ppm', digits: 1 },
  { key: 'twa', name: '15-min TWA', color: T.textMuted, unit: 'ppm', digits: 1, dashed: true },
];
const AQ_SERIES = [{ key: 'aq', name: 'AQI', color: T.purpleFill, unit: '', digits: 0 }];
const AQ_BANDS = [
  { y1: TH.AQ_MODERATE, y2: TH.AQ_POOR, fill: T.purpleFill, opacity: 0.05 },
  { y1: TH.AQ_POOR, y2: TH.AQ_P1, fill: T.purpleFill, opacity: 0.11 },
  { y1: TH.AQ_P1, y2: 500, fill: T.amberFill, opacity: 0.14 },
];
const AQ_LINES = [{ y: TH.AQ_P1, label: `P1 > ${TH.AQ_P1}`, color: T.amber }];
const AQ_DOMAIN = [0, 500]; // the full MQ135 index scale, so every band is visible
const HEAT_SERIES = [
  { key: 'heat', name: 'Heat index', color: T.orangeFill, unit: '°C', digits: 1 },
  { key: 'temp', name: 'Ambient', color: T.textMuted, unit: '°C', digits: 1, dashed: true },
  { key: 'hum', name: 'Humidity', color: T.tealFill, unit: '%', digits: 0, axis: 'right' },
];
const HEAT_LINES = [
  { y: TH.HEAT_P1, label: `P1 ${TH.HEAT_P1}`, color: T.amber },
  { y: TH.HEAT_P0, label: `P0 ${TH.HEAT_P0}`, color: T.red, overflow: 'discard' },
];
// Gauge zones; the boundaries are the same as coBand(), so bar and number always share a colour.
export const CO_ZONES = [
  { to: TH.CO_P1, fill: T.greenFill },
  { to: TH.CO_PEL, fill: T.amberFill },
  { to: TH.CO_P0, fill: T.orangeFill },
  { to: 250, fill: T.redFill },
];
const CO_TICKS = [TH.CO_P1, TH.CO_PEL, TH.CO_P0];

// Both limits are always drawn, so the chart shows how far the reading is from each.
const CO_LINES = [
  { y: TH.CO_P1, label: `P1 > ${TH.CO_P1}`, color: T.amber },
  { y: TH.CO_P0, label: `P0 > ${TH.CO_P0}`, color: T.red },
];

export default function EnvironmentTab({ r, series }) {
  // One decimal below 100 ppm; above that (and at ADC saturation) the decimal carries nothing.
  const co = coValue(r, isNum(r.co) && r.co >= 100 ? 0 : 1);
  const twa = twaValue(r, 1);
  const aq = aqValue(r);
  const hi = heatIndexValue(r, 1);
  const amb = armValue(r, 'temp', 'bme', 1);
  const hum = armValue(r, 'hum', 'bme', 0);
  const pres = armValue(r, 'pressure', 'bme', 1);
  const balt = armValue(r, 'bme_alt', 'bme', 0);
  const coB = coBand(co.value, r.co_sat);
  const aa = r.active_alerts || {};
  const fire = aa.FIRE_SUSPECTED;
  const hasAlt = typeof r.alt === 'number';
  return (
    <>
      {fire ? (
        <Banner tone="p1" icon={Flame}>
          {typeof fire.reason === 'string' ? fire.reason : 'POSSIBLE FIRE/SMOKE'}
        </Banner>
      ) : null}

      <Card title="Carbon monoxide" icon={Wind}>
        <div className="stat-grid">
          <Stat label="CO now" v={co} unit="ppm" band={coB} big />
          <Stat label="15-min TWA" v={twa} unit="ppm" band={twaBand(twa.value)} />
        </div>
        <BandGauge value={co.value} max={250} zones={CO_ZONES} ticks={CO_TICKS} label={`CO ${co.text} ppm`} fill={coB.level >= 0 ? coB.fill : undefined} />
        <ChartCard title="CO and 15-min TWA" span={series.span}>
          <TimeChart data={series.points} series={CO_SERIES} yDomain={FROM_ZERO} refLines={CO_LINES} height={140} />
        </ChartCard>
      </Card>

      <Card title="Air quality" icon={CloudFog} meta={series.span}>
        <Stat label="Air index" v={aq} band={aqBand(aq.value)} />
        <TimeChart data={series.points} series={AQ_SERIES} yDomain={AQ_DOMAIN} bands={AQ_BANDS} refLines={AQ_LINES} height={110} />
      </Card>

      <Card title="Heat" icon={ThermometerSun}>
        <div className="stat-grid">
          <Stat label="Heat index" v={hi} unit="°C" band={heatBand(hi.value)} big />
          <div className="rows">
            <Row label="Ambient" value={amb.value !== null ? `${amb.text} °C` : amb.text} note={amb.note} />
            <Row label="Humidity" value={hum.value !== null ? `${hum.text} %` : hum.text} note={hum.note} />
          </div>
        </div>
        <ChartCard title="Heat index, ambient and humidity" span={series.span}>
          <TimeChart data={series.points} series={HEAT_SERIES} refLines={HEAT_LINES} yDomainRight={PERCENT} />
        </ChartCard>
      </Card>

      <Card title="Atmosphere" icon={Mountain}>
        <div className="rows">
          <Row label="Pressure" value={pres.value !== null ? `${pres.text} hPa` : pres.text} note={pres.note} />
          <Row label="Barometric altitude" value={balt.value !== null ? `${balt.text} m` : balt.text} note={balt.note} />
          <Row label="GPS altitude" value={hasAlt ? `${fmtNum(r.alt, 0)} m` : '--'} note={hasAlt && r.gps_ok !== true ? 'last fix' : null} />
        </div>
      </Card>
    </>
  );
}
