// Responder detail with tabs VITALS / ENVIRONMENT / MOVEMENT / DEVICE / ALERTS. Chart series are
// built once per readings update (useMemo), not on every render.

import React, { useMemo, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { buildSeries, CHART_POINTS } from '../lib/series';
import { responderStatus } from '../lib/status';
import { recordMs } from '../lib/time';
import AlertsTab from './AlertsTab';
import DeviceTab from './DeviceTab';
import EnvironmentTab from './EnvironmentTab';
import MovementTab from './MovementTab';
import { AccessNotice } from './NotAuthorised';
import StatusBadge from './StatusBadge';
import { Age } from './TimeText';
import { Empty, Panel } from './ui';
import VitalsTab from './VitalsTab';

const TABS = [
  ['vitals', 'VITALS'],
  ['environment', 'ENVIRONMENT'],
  ['movement', 'MOVEMENT'],
  ['device', 'DEVICE'],
  ['alerts', 'ALERTS'],
];

function DeepDivePanel({ id, r, lost, readings, alerts, user, onPick }) {
  const [tab, setTab] = useState('vitals');
  const series = useMemo(() => buildSeries(readings.list, CHART_POINTS), [readings.list]);

  if (!id || !r) {
    return (
      <Panel title="Responder detail" icon={ScanSearch} className="area-deep">
        <Empty title="No responder selected" />
      </Panel>
    );
  }

  const st = responderStatus(r, lost);
  const packetMs = recordMs(r);
  let historyNote = null;
  if (readings.error) historyNote = <AccessNotice error={readings.error} user={user} />;
  else if (readings.loading) historyNote = <div className="note">Loading history…</div>;

  return (
    <section className="panel area-deep" aria-label={`Responder ${id}`}>
      <header className="dd-head">
        <div className="dd-title">
          <h2 className="dd-id">{id}</h2>
          <StatusBadge st={st} since={packetMs} />
        </div>
        <div className="dd-meta">
          {packetMs !== null ? <Age since={packetMs} prefix="Updated " suffix=" ago" /> : 'No timestamp'}
          {r.source ? ` · ${r.source}` : ''}
        </div>
      </header>
      <div className="dd-tabs" role="tablist" aria-label="Responder detail">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" className="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="dd-body" role="tabpanel">
        {historyNote}
        {tab === 'vitals' ? <VitalsTab r={r} series={series} /> : null}
        {tab === 'environment' ? <EnvironmentTab r={r} series={series} /> : null}
        {tab === 'movement' ? <MovementTab r={r} series={series} lost={lost} /> : null}
        {tab === 'device' ? <DeviceTab r={r} lost={lost} /> : null}
        {tab === 'alerts' ? <AlertsTab id={id} r={r} lost={lost} alerts={alerts} onPick={onPick} /> : null}
      </div>
    </section>
  );
}

export default React.memo(DeepDivePanel);
