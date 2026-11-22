// HALO command dashboard.
//
// App = global styles + the dashboard. There is no sign-in (the user's decision, 2026-11-22):
// the database rules in ../database.rules.json allow public reads and deny all client writes.
// The LIVE tab is the responder list, the operational map, the responder detail and the alert
// log; the ANALYTICS tab is AnalyticsView (src/analytics, written by the analytics agent).

import React, { useCallback, useMemo, useState } from 'react';
import AnalyticsView from './analytics/AnalyticsView';
import AlertFeed from './components/AlertFeed';
import DeepDivePanel from './components/DeepDivePanel';
import GlobalStyles from './components/GlobalStyles';
import NotAuthorised from './components/NotAuthorised';
import ResponderList from './components/ResponderList';
import SituationBar from './components/SituationBar';
import { useLostIds } from './lib/clock';
import { useLiveData, useReadings } from './lib/db';
import { sortResponderIds } from './lib/status';
import MapPanel from './map/MapPanel';

function Dashboard({ user, signOut, signOutError }) {
  const [attempt, setAttempt] = useState(0);
  const [chosenId, setChosenId] = useState(null);
  // Counts selections, so re-selecting the responder already selected still turns map follow on.
  const [selectSeq, setSelectSeq] = useState(0);
  const [mainTab, setMainTab] = useState('live');
  const live = useLiveData(attempt);
  const { responders, errors } = live;
  const lostIds = useLostIds(responders);

  // The operator's choice sticks while that responder is in live/; otherwise the most severe one.
  const firstId = useMemo(() => sortResponderIds(responders, lostIds)[0] || null, [responders, lostIds]);
  const selectedId = chosenId && responders[chosenId] ? chosenId : firstId;
  const readings = useReadings(selectedId, attempt);

  const select = useCallback((id) => {
    setChosenId(id);
    setSelectSeq((n) => n + 1);
  }, []);
  const pick = useCallback((id) => {
    setChosenId(id);
    setSelectSeq((n) => n + 1);
    setMainTab('live');
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (errors.live && errors.live.denied) {
    const paths = Object.values(errors)
      .filter((e) => e && e.denied)
      .map((e) => `${e.path}/`);
    return <NotAuthorised user={user} paths={paths} onRetry={retry} onSignOut={signOut} />;
  }

  return (
    <div className="app">
      <SituationBar
        responders={responders}
        lostIds={lostIds}
        connected={live.connected}
        user={user}
        onSignOut={signOut}
        signOutError={signOutError}
        onPick={pick}
      />
      <div className="mainnav" role="tablist" aria-label="Main views">
        <button type="button" role="tab" className="tab" aria-selected={mainTab === 'live'} onClick={() => setMainTab('live')}>
          LIVE
        </button>
        <button type="button" role="tab" className="tab" aria-selected={mainTab === 'analytics'} onClick={() => setMainTab('analytics')}>
          ANALYTICS
        </button>
      </div>

      {mainTab === 'analytics' ? (
        <main className="analytics-host">
          <AnalyticsView responderId={selectedId} responders={responders} />
        </main>
      ) : (
        <main className="live-grid">
          <ResponderList
            responders={responders}
            lostIds={lostIds}
            selectedId={selectedId}
            onSelect={select}
            error={errors.live}
            user={user}
          />
          <MapPanel
            responders={responders}
            lostIds={lostIds}
            selectedId={selectedId}
            selectSeq={selectSeq}
            readings={readings.list}
            hazards={live.hazards}
            hazardsError={errors.hazards}
            user={user}
            onSelect={select}
          />
          <DeepDivePanel
            id={selectedId}
            r={selectedId ? responders[selectedId] : null}
            lost={selectedId ? lostIds.has(selectedId) : false}
            readings={readings}
            alerts={live.alerts}
            user={user}
            onPick={pick}
          />
          <AlertFeed
            alerts={live.alerts}
            legacyKeys={live.legacyAlertKeys}
            responders={responders}
            lostIds={lostIds}
            error={errors.alerts}
            user={user}
            onPick={pick}
          />
        </main>
      )}
    </div>
  );
}

export default function App() {
  return (
    <>
      <GlobalStyles />
      <Dashboard user={null} />
    </>
  );
}
