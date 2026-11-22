// ANALYTICS tab, presentational half: renders everything from props, with no Firebase import, so
// a fixture page can render it (spec 10.8). AnalyticsView.js owns the subscriptions and passes
// the data in. Every number is scoped to the window named in the header, for this responder
// only (dash-5), and the charts use time on the x axis (dash-8).

import { memo, useMemo } from 'react';
import { BarChart3, Lightbulb } from 'lucide-react';
import { T, FONT, FS } from '../theme';
import {
  MINUTES_QUERY_LIMIT, MINUTE_MS, RANGE_12H_MS,
  buildInsights, buildKpis, buildMinuteSeries, fmtSpan, isSafeKey, mergeSummaries,
  minutesInWindow, resolveHrMax, sameLocalDay, selectView, sessionComparison, sessionLabel,
  sessionWindow, summarizeMinutes, summarizeSession, timeDomain, timeTicks,
} from './metrics';
import { Card, EmptyNote, KpiGrid, Notice, RetryButton, Segmented, SelectField } from './ui';
import { HrChart, HrRecoveryCard, Spo2Chart, StrainChart, ZoneChart } from './chartsPhysio';
import { ActivityChart, CoChart, HeatChart } from './chartsExposure';
import { DeviceHealthChart, SessionCompareChart } from './chartsTrend';

const RANGE_OPTIONS = [
  { value: 'session', label: 'This session' },
  { value: '12h', label: 'Last 12 h' },
];

const NONE = [];
const NOT_LOADED = { profile: false, sessions: false, minutes: false };

const rootStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  overflowY: 'auto',
  boxSizing: 'border-box',
  padding: 16,
  background: T.bg0,
  color: T.text,
  fontFamily: FONT.ui,
  fontSize: FS.md,
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 480px), 1fr))',
  gap: 12,
};

function Header({ id, ids, onPickId, mode, onMode, sessions, sessionKey, onSession, hasSessions, now, latestKey }) {
  const sessionOptions = useMemo(() => sessions.slice().reverse().map((s) => ({
    value: s.key,
    label: sessionLabel(s, { now, isLatest: s.key === latestKey }),
  })), [sessions, now, latestKey]);
  return (
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: FS.xl, fontWeight: 600, color: T.textStrong }}>
        <BarChart3 size={18} color={T.textMuted} aria-hidden="true" />
        Performance and fitness
        {id && <span style={{ fontSize: FS.lg, fontWeight: 500, color: T.textMuted }}>{id}</span>}
      </h2>
      <div role="toolbar" aria-label="Analytics filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
        {ids.length > 1 && (
          <SelectField label="Responder" value={id || ''} onChange={onPickId} options={ids.map((r) => ({ value: r, label: r }))} />
        )}
        <Segmented label="Range" value={mode} onChange={onMode}
          options={RANGE_OPTIONS.map((o) => (o.value === 'session' && !hasSessions ? { ...o, disabled: true } : o))} />
        {hasSessions && (
          <SelectField label="Session" value={sessionKey || ''} onChange={onSession} options={sessionOptions}
            disabled={mode !== 'session'} minWidth={300} />
        )}
      </div>
    </header>
  );
}

// Props: id, ids, onPickId; profile, sessions, minutes (normalised, see metrics.js), loaded
// { profile, sessions, minutes }, error (classifyDbError shape + key); rangeMinutes / rangeLoaded
// for an older session outside the newest 720 minutes; modeChoice ('session' | '12h'), onMode,
// sessionKey (null = latest), onSession; now (ms); onRetry.
export function AnalyticsPanel({
  id = null, ids = NONE, onPickId, profile = null, sessions = NONE, minutes = NONE, loaded = NOT_LOADED, error = null,
  rangeMinutes = NONE, rangeLoaded = true, modeChoice = 'session', onMode, sessionKey = null, onSession, now, onRetry,
}) {
  const { latest, session, isLatest, mode, needRange } = useMemo(
    () => selectView(sessions, minutes, modeChoice, sessionKey), [sessions, minutes, modeChoice, sessionKey]);

  // The clock only moves the 12 h window; session views do not re-derive once a minute.
  const windowNow = mode === '12h' ? now : 0;
  const windowMinutes = useMemo(() => {
    if (mode === 'session') {
      const w = sessionWindow(session, isLatest);
      return minutesInWindow(needRange ? rangeMinutes : minutes, w.start, w.end);
    }
    return minutesInWindow(minutes, windowNow - RANGE_12H_MS, null);
  }, [mode, session, isLatest, needRange, rangeMinutes, minutes, windowNow]);
  const truncated = mode === 'session' && session && windowMinutes.length >= MINUTES_QUERY_LIMIT
    && windowMinutes[0].t > Math.floor(session.start_ms / MINUTE_MS) * MINUTE_MS;

  const hrMax = useMemo(() => resolveHrMax(profile, session, mode), [profile, session, mode]);
  const hrMaxV = hrMax ? hrMax.value : null;
  const summary = useMemo(() => {
    const fromMinutes = summarizeMinutes(windowMinutes, hrMaxV);
    return mode === 'session' ? mergeSummaries(summarizeSession(session), fromMinutes) : fromMinutes;
  }, [windowMinutes, hrMaxV, mode, session]);
  const kpis = useMemo(() => buildKpis(summary, { mode, hrMax }), [summary, mode, hrMax]);
  const insights = useMemo(() => buildInsights(summary, { mode, hrMax }), [summary, mode, hrMax]);
  const rows = useMemo(() => buildMinuteSeries(windowMinutes, hrMaxV), [windowMinutes, hrMaxV]);
  const domain = useMemo(() => timeDomain(rows), [rows]);
  const ticks = useMemo(() => (domain ? timeTicks(domain[0], domain[1]) : []), [domain]);
  const compare = useMemo(() => sessionComparison(sessions, mode === 'session' && session ? session.key : null), [sessions, mode, session]);

  const withDate = Boolean(domain) && !sameLocalDay(domain[0], domain[1]);
  const span = windowMinutes.length
    ? `${fmtSpan(windowMinutes[0].t, windowMinutes[windowMinutes.length - 1].t)} · ${windowMinutes.length} min of data${mode === '12h' ? ' in the last 12 h' : ''}`
    : '';

  const header = (
    <Header id={id} ids={ids} onPickId={onPickId} mode={mode} onMode={onMode} sessions={sessions}
      sessionKey={session ? session.key : null} onSession={onSession} hasSessions={sessions.length > 0}
      now={now} latestKey={latest ? latest.key : null} />
  );

  let body;
  if (!id) {
    body = <Notice kind="info" title="No responder yet" />;
  } else if (!isSafeKey(id)) {
    body = <Notice kind="error" title="Cannot load analytics">This responder id cannot be used as a database path.</Notice>;
  } else if (error) {
    const path = error.key === 'profile' ? `profiles/${id}` : `analytics/${id}`;
    body = error.denied
      ? (
        <Notice kind="error" title={`Not authorised to read ${path}`} action={<RetryButton onClick={onRetry} />}>
          The database rules deny this path. Publish database.rules.json, which allows public reads.
        </Notice>
      )
      : <Notice kind="error" title="Could not load analytics" action={<RetryButton onClick={onRetry} />}>{error.message}</Notice>;
  } else if (!loaded.sessions || !loaded.minutes) {
    body = <Notice kind="info" title="Loading analytics" />;
  } else if (!sessions.length && !minutes.length) {
    body = <Notice kind="info" title={`No analytics for ${id} yet`} />;
  } else {
    body = (
      <AnalyticsBody kpis={kpis} insights={insights} summary={summary} rows={rows} domain={domain} ticks={ticks}
        withDate={withDate} span={span} hrMax={hrMax} windowMinutes={windowMinutes} compare={compare} mode={mode}
        loadingRange={needRange && !rangeLoaded} truncated={truncated} />
    );
  }

  return (
    <div style={rootStyle}>
      {header}
      {body}
    </div>
  );
}

const AnalyticsBody = memo(function AnalyticsBody({
  kpis, insights, summary, rows, domain, ticks, withDate, span, hrMax, windowMinutes, compare, mode, loadingRange, truncated,
}) {
  const chartProps = { rows, domain, ticks, withDate, span };
  let chartsNote = null;
  if (!windowMinutes.length) chartsNote = mode === 'session' ? 'No minute data for this session.' : 'No minute data in the last 12 h.';
  else if (truncated) chartsNote = `Charts: newest ${MINUTES_QUERY_LIMIT} min only.`;
  return (
    <>
      <KpiGrid tiles={kpis} />
      {insights.length > 0 && (
        <Card title="Insights" icon={Lightbulb} style={{ marginTop: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, lineHeight: 1.5, color: T.text, fontVariantNumeric: 'tabular-nums' }}>
            {insights.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </Card>
      )}
      {/* An older session's minutes are still loading: one placeholder, not ten empty charts. */}
      {loadingRange ? (
        <div role="status" style={{ marginTop: 12 }}><EmptyNote>Loading minute data…</EmptyNote></div>
      ) : (
        <>
          {chartsNote && (
            <div role="status" style={{ marginTop: 12, fontSize: FS.sm, color: T.textMuted }}>{chartsNote}</div>
          )}
          <div style={{ ...gridStyle, marginTop: 12 }}>
            <HrChart {...chartProps} hrMax={hrMax} />
            <ZoneChart zonesS={summary.zonesS} hrMax={hrMax} />
            <StrainChart {...chartProps} />
            <HeatChart {...chartProps} bandsS={summary.heat.bandsS} />
            <CoChart {...chartProps} />
            <ActivityChart minutes={windowMinutes} span={span} bandsS={summary.activity.bandsS} />
            <Spo2Chart {...chartProps} />
            <HrRecoveryCard hrr={summary.hrr} span={span} />
            <DeviceHealthChart {...chartProps} />
            <SessionCompareChart data={compare} />
          </div>
        </>
      )}
    </>
  );
});

export default memo(AnalyticsPanel);
