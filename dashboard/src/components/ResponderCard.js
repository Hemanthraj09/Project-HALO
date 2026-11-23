// Responder card (left column). Memoised: it re-renders when this responder's data, its link
// state or the selection changes. Running ages inside it tick on their own.

import React from 'react';
import { Axis3d, MapPin, MapPinOff, Signal, Siren, Hourglass, Unplug } from 'lucide-react';
import { useTheme } from '../lib/themeMode';
import { T } from '../theme';
import { aqValue, armValue, coValue, coreValue, ppgValue, psiValue, twaValue } from '../lib/format';
import { gpsState } from '../lib/geo';
import { isNum } from '../lib/num';
import { imuDown } from '../lib/sensors';
import { noMotionState, responderStatus } from '../lib/status';
import { aqBand, coBand, coreBand, heatBand, hrBand, psiBand, spo2Band, twaBand } from '../lib/thresholds';
import { recordMs } from '../lib/time';
import StatusBadge from './StatusBadge';
import { Age } from './TimeText';
import { Banner, SatsNote, Tile } from './ui';

function LinkLine({ r }) {
  const parts = [];
  if (isNum(r.rssi)) parts.push(`RSSI ${Math.round(r.rssi)} dBm`);
  if (isNum(r.link_loss_pct)) parts.push(`loss ${Math.round(r.link_loss_pct)} %`);
  return (
    <div className="rc-line" title={isNum(r.snr) ? `SNR ${r.snr.toFixed(1)} dB` : undefined}>
      <Signal size={14} aria-hidden="true" />
      <span>{parts.length ? `LoRa ${parts.join(' · ')}` : 'LoRa --'}</span>
    </div>
  );
}

function GpsLine({ r, lost }) {
  const g = gpsState(r, lost);
  if (g.kind === 'none') {
    return (
      <div className="rc-line">
        <MapPinOff size={14} aria-hidden="true" />
        <span>
          {g.text}
          <SatsNote sats={g.sats} />
        </span>
      </div>
    );
  }
  if (g.kind === 'fresh') {
    return (
      <div className="rc-line">
        <MapPin size={14} aria-hidden="true" style={{ color: T.green }} />
        <span>
          {g.text}
          {isNum(r.gps_sats) ? ` · ${r.gps_sats} sats` : ''}
        </span>
      </div>
    );
  }
  return (
    <div className="rc-line" style={{ color: T.amber }}>
      <MapPin size={14} aria-hidden="true" />
      <span>
        {g.fixMs !== null ? <Age since={g.fixMs} prefix="Last fix " suffix=" ago" /> : 'Stale fix'}
        <SatsNote sats={g.sats} />
      </span>
    </div>
  );
}

function ResponderCard({ id, r, lost, selected, onSelect }) {
  useTheme();
  const st = responderStatus(r, lost);
  const packetMs = recordMs(r);
  const hr = ppgValue(r, 'hr');
  const spo2 = ppgValue(r, 'spo2');
  const co = coValue(r);
  const amb = armValue(r, 'temp', 'bme', 1);
  const hum = armValue(r, 'hum', 'bme', 0);
  const aq = aqValue(r);
  const psi = psiValue(r);
  const twa = twaValue(r);
  const core = coreValue(r);
  const heat = heatBand(r.heat_index);
  const still = noMotionState(r);
  const outline = lost ? st.last.fill : st.fill;
  const select = () => onSelect(id);
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  };

  let cls = 'resp-card';
  if (selected) cls += ' is-selected';
  if (lost) cls += ' is-lost';
  else if (st.priority === 0) cls += ' is-p0';

  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${id}, ${lost ? `link lost, last ${st.last.name}` : st.label}`}
      onClick={select}
      onKeyDown={onKey}
      style={lost ? { borderColor: outline } : { borderLeftColor: outline }}
    >
      <div className="rc-head">
        <span className="rc-dot" style={{ background: lost ? T.grayFill : st.fill }} aria-hidden="true" />
        <span className="rc-id">{id}</span>
        {r.source === 'simulator' ? (
          <span className="rc-src" title="Simulator">
            SIM
          </span>
        ) : null}
        <StatusBadge st={st} since={packetMs} />
      </div>

      {r.fall === true ? (
        <Banner tone="p0" icon={Siren} live={!lost}>
          FALL DETECTED{lost ? ' (last known)' : ''}
        </Banner>
      ) : null}
      {still ? (
        <Banner tone={still.severity === 0 ? 'p0' : 'p1'} icon={Hourglass} live={!lost && still.severity === 0}>
          {still.still !== null ? `NO MOTION ${Math.round(still.still)} s` : still.reason || 'NO MOTION'}
        </Banner>
      ) : null}

      <div className="rc-grid">
        <Tile label="HR" v={hr} unit="bpm" color={hrBand(hr.value).color} />
        <Tile label="SpO₂" v={spo2} unit="%" color={spo2Band(spo2.value).color} />
        <Tile label="CO" v={co} unit="ppm" color={coBand(co.value, r.co_sat).color} />
        <Tile
          label="AMB"
          v={amb}
          unit="°C"
          color={heat.level >= 0 ? heat.color : undefined}
          title={isNum(r.heat_index) ? `Heat index ${r.heat_index.toFixed(1)} °C (${heat.label})` : 'Heat index --'}
        />
        <Tile label="HUM" v={hum} unit="%" />
        <Tile label="AQ" v={aq} unit="idx" color={aqBand(aq.value).color} />
      </div>

      <div className="rc-sub">
        <Tile label="PSI" v={psi} color={psiBand(psi.value).color} title="Physiological strain index" />
        <Tile label="TWA" v={twa} unit="ppm" color={twaBand(twa.value).color} title="CO 15-min TWA" />
        <Tile label="CORE" v={core} unit="°C" color={coreBand(core.value).color} title="Core temperature (est.)" />
      </div>

      <div className="rc-dev">
        {r.arm_ok === false ? (
          <span className="armoff">
            <Unplug size={12} aria-hidden="true" />
            ARM OFFLINE
          </span>
        ) : null}
        {imuDown(r) ? (
          <span className="armoff">
            <Axis3d size={12} aria-hidden="true" />
            IMU OFFLINE
          </span>
        ) : null}
      </div>
      <LinkLine r={r} />
      <GpsLine r={r} lost={lost} />
    </div>
  );
}

export default React.memo(ResponderCard);
