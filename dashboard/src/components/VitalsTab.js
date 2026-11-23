// VITALS tab: HR, SpO2, estimated core temperature and PSI, with time-axis charts.

import React from 'react';
import { T, themed } from '../theme';
import { coreValue, ppgValue, psiValue } from '../lib/format';
import { coreBand, hrBand, psiBand, spo2Band, TH } from '../lib/thresholds';
import TimeChart, { ChartCard } from './TimeChart';
import { Flag, Stat } from './ui';

// Constant props keep the memoised charts from re-rendering on every packet (built per theme).
// Limits 20 bpm / 4 % / 1 °C apart sit about 12 px apart: the upper one's label goes above its
// line, so the two labels never overlap; P1 < 40 too, to stay clear of the time axis.
const HR_DOMAIN = [30, 200];
const SPO2_DOMAIN = [80, 100];
const CORE_DOMAIN = [36, 40.5];
const PSI_DOMAIN = [0, 10];
const charts = themed(() => ({
  hrSeries: [{ key: 'hr', name: 'HR', color: T.redFill, unit: 'bpm', digits: 0 }],
  hrLines: [
    { y: TH.HR_P0, label: `P0 > ${TH.HR_P0}`, color: T.red, above: true },
    { y: TH.HR_P1_HIGH, label: `P1 > ${TH.HR_P1_HIGH}`, color: T.amber },
    { y: TH.HR_P1_LOW, label: `P1 < ${TH.HR_P1_LOW}`, color: T.amber, above: true },
  ],
  spo2Series: [{ key: 'spo2', name: 'SpO₂', color: T.blueFill, unit: '%', digits: 0 }],
  spo2Lines: [
    { y: TH.SPO2_P1, label: `P1 < ${TH.SPO2_P1}`, color: T.amber, above: true },
    { y: TH.SPO2_P0, label: `P0 < ${TH.SPO2_P0}`, color: T.red },
  ],
  coreSeries: [{ key: 'core', name: 'Core (est.)', color: T.orangeFill, unit: '°C', digits: 2 }],
  coreLines: [
    { y: TH.CORE_P1, label: `P1 > ${TH.CORE_P1}`, color: T.amber },
    { y: TH.CORE_P0, label: `P0 > ${TH.CORE_P0}`, color: T.red, above: true },
  ],
  psiSeries: [{ key: 'psi', name: 'PSI', color: T.purpleFill, unit: '/10', digits: 1 }],
  psiBands: [
    { y1: 5, y2: 7, fill: T.amberFill, opacity: 0.08 },
    { y1: 7, y2: 9, fill: T.orangeFill, opacity: 0.1 },
    { y1: 9, y2: 10, fill: T.redFill, opacity: 0.1 },
  ],
}));

function skinText(skin) {
  if (skin === true) return 'On skin';
  if (skin === false) return 'Not on skin';
  return 'Skin --';
}

function PpgFlags({ r }) {
  if (r.arm_ok === false) return null;
  return (
    <div className="flags">
      <Flag on={typeof r.skin === 'boolean' ? r.skin : null}>{skinText(r.skin)}</Flag>
      {r.ppg_motion === true ? <Flag warn>Motion hold</Flag> : null}
      <Flag on={typeof r.ppg_q === 'number' ? r.ppg_q >= 40 : null}>PPG quality {typeof r.ppg_q === 'number' ? Math.round(r.ppg_q) : '--'}</Flag>
    </div>
  );
}

export default function VitalsTab({ r, series }) {
  const hr = ppgValue(r, 'hr');
  const spo2 = ppgValue(r, 'spo2');
  const core = coreValue(r);
  const psi = psiValue(r);
  const c = charts();
  return (
    <>
      <div className="stat-grid">
        <Stat label="Heart rate" v={hr} unit="bpm" band={hrBand(hr.value)} />
        <Stat label="SpO₂" v={spo2} unit="%" band={spo2Band(spo2.value)} />
        <Stat label="Core temp (est.)" v={core} unit="°C" band={coreBand(core.value)} />
        <Stat label="PSI" v={psi} unit="/ 10" band={psiBand(psi.value)} />
      </div>
      <PpgFlags r={r} />
      <ChartCard title="Heart rate" span={series.span}>
        <TimeChart data={series.points} series={c.hrSeries} yDomain={HR_DOMAIN} refLines={c.hrLines} />
      </ChartCard>
      <ChartCard title="SpO₂" span={series.span}>
        <TimeChart data={series.points} series={c.spo2Series} yDomain={SPO2_DOMAIN} refLines={c.spo2Lines} height={100} />
      </ChartCard>
      <ChartCard title="Core temperature (est.)" span={series.span}>
        <TimeChart data={series.points} series={c.coreSeries} yDomain={CORE_DOMAIN} refLines={c.coreLines} height={100} />
      </ChartCard>
      <ChartCard title="Physiological strain (PSI)" span={series.span}>
        <TimeChart data={series.points} series={c.psiSeries} yDomain={PSI_DOMAIN} bands={c.psiBands} height={100} />
      </ChartCard>
    </>
  );
}
