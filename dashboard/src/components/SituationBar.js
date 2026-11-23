// Header: counters, the active-alert ticker (from live/*/active_alerts, not time heuristics, plus
// LINK for a lost link the backend has not flagged), the local clock with the browser's time-zone
// abbreviation, Firebase connection and sign-out.

import React, { useMemo } from 'react';
import { LogOut, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useTheme } from '../lib/themeMode';
import { SEVERITY, T } from '../theme';
import { collectActiveAlerts, countResponders } from '../lib/status';
import { typeIcon } from './icons';
import { Age, Clock } from './TimeText';

function Counter({ label, value, color, blink }) {
  return (
    <div className={`counter${blink ? ' is-blinking' : ''}`}>
      <div className="counter-value" style={color ? { color } : undefined}>
        {value}
      </div>
      <div className="counter-label">{label}</div>
    </div>
  );
}

function Ticker({ active, onPick }) {
  if (active.length === 0) {
    return <div className="ticker ticker-empty">No active alerts</div>;
  }
  const top = active[0];
  const sev = SEVERITY[top.severity];
  const Icon = typeIcon(top.type);
  return (
    <button type="button" className="ticker" onClick={() => onPick(top.responderId)} title="Show this responder">
      <span className="ticker-chip" style={{ color: sev.color, background: sev.bg, borderColor: sev.fill }}>
        {sev.name}
      </span>
      <Icon size={16} aria-hidden="true" style={{ color: sev.color, flexShrink: 0 }} />
      <span className="ticker-text" style={{ color: sev.color }}>
        {top.reason}
      </span>
      <span className="ticker-meta">
        {top.responderId}
        {top.sinceMs !== null ? (
          <>
            {' · '}
            <Age since={top.sinceMs} />
          </>
        ) : null}
        {top.lastKnown ? ' · last known' : ''}
      </span>
      {active.length > 1 ? <span className="ticker-more">+{active.length - 1} more</span> : null}
    </button>
  );
}

function SituationBar({ responders, lostIds, connected, user, onSignOut, signOutError, onPick }) {
  useTheme();
  const counts = useMemo(() => countResponders(responders, lostIds), [responders, lostIds]);
  const active = useMemo(() => collectActiveAlerts(responders, lostIds), [responders, lostIds]);
  // backend started with HALO_BENCH=1: no-motion (man-down) alerts are off for a strap on a table
  const bench = useMemo(() => Object.values(responders || {}).some((r) => r && r.bench_mode === true), [responders]);
  const p0 = active.filter((a) => a.severity === 0).length;
  const critical = counts.critical > 0;
  const Mark = critical ? ShieldAlert : ShieldCheck;

  return (
    <header className={`sitbar${critical ? ' is-critical' : ''}`}>
      <div className="brand">
        <span
          className="brand-mark"
          style={critical ? { color: T.red, background: T.redBg, borderColor: T.redFill } : { color: T.blue, background: T.blueBg, borderColor: T.blueFill }}
        >
          <Mark size={18} aria-hidden="true" />
        </span>
        <div>
          <div className="brand-name">HALO</div>
          <div className="brand-sub">COMMAND</div>
        </div>
      </div>

      <div className="counters" role="group" aria-label="Responder status counts">
        <Counter label="RESPONDERS" value={counts.total} />
        <Counter label="CRITICAL" value={counts.critical} color={critical ? T.red : undefined} blink={critical} />
        <Counter label="WARNING" value={counts.warning} color={counts.warning ? T.amber : undefined} />
        <Counter label="NOMINAL" value={counts.nominal} color={counts.nominal ? T.green : undefined} />
        <Counter label="LINK LOST" value={counts.lost} color={counts.lost ? T.orange : undefined} blink={counts.lost > 0} />
      </div>

      <Ticker active={active} onPick={onPick} />

      <div className="sit-active">
        {active.length} active alert{active.length === 1 ? '' : 's'}
        {active.length ? ` · P0 ${p0} · P1 ${active.length - p0}` : ''}
      </div>

      <div className="sit-right">
        {bench ? (
          <span className="badge" style={{ color: T.amber, background: T.amberBg, borderColor: T.amberFill }} title="Backend started with HALO_BENCH=1">
            BENCH MODE · no-motion alerts off
          </span>
        ) : null}
        <Clock />
        <span className="conn" style={{ color: connected ? T.green : T.amber }} title="Firebase connection">
          <span className="conn-dot" style={{ background: connected ? T.greenFill : T.amberFill }} aria-hidden="true" />
          {connected ? 'LIVE' : 'RECONNECTING'}
        </span>
        {user ? (
          <div className="user-box">
            <span className="user-email" title={user.email || user.uid}>
              {user.email || user.uid}
            </span>
            <button type="button" className="btn btn-small" onClick={onSignOut}>
              <LogOut size={14} aria-hidden="true" />
              Sign out
            </button>
            {signOutError ? (
              <span className="note" role="alert" style={{ color: T.red }}>
                {signOutError}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export default React.memo(SituationBar);
