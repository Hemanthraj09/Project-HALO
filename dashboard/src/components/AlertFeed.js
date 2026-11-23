// Alert feed: the alert log newest first, with filter chips (All / P0 / P1 / Device). The header
// counts the alerts that are active right now, from live/*/active_alerts (plus LINK for a lost
// link the backend has not flagged, see lib/status).

import React, { useMemo, useState } from 'react';
import { BellRing } from 'lucide-react';
import { ALERT_FILTERS, filterAlerts } from '../lib/alerts';
import { collectActiveAlerts } from '../lib/status';
import AlertRow from './AlertRow';
import { AccessNotice } from './NotAuthorised';
import PriorityLegend from './PriorityLegend';
import { Empty, Panel } from './ui';

function AlertFeed({ alerts, legacyKeys, responders, lostIds, error, user, onPick }) {
  const [filter, setFilter] = useState('all');
  const shown = useMemo(() => filterAlerts(alerts, filter), [alerts, filter]);
  const active = useMemo(() => collectActiveAlerts(responders, lostIds), [responders, lostIds]);
  const p0 = active.filter((a) => a.severity === 0).length;
  const meta = active.length ? `${active.length} active · P0 ${p0} · P1 ${active.length - p0}` : 'none active';

  return (
    <Panel title="Alert log" icon={BellRing} meta={meta} className="area-feed" bodyClassName="feed-body">
      <div className="feed-filters">
        <div className="chips" role="group" aria-label="Filter the alert log">
          {ALERT_FILTERS.map((f) => (
            <button key={f.key} type="button" className="chip" aria-pressed={filter === f.key} title={f.title} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <div style={{ padding: 12 }}>
          <AccessNotice error={error} user={user} />
        </div>
      ) : null}
      {shown.length === 0 && !error ? (
        <Empty>{alerts.length === 0 ? 'No alerts logged.' : 'No alerts match this filter.'}</Empty>
      ) : (
        <ul className="feed-list">
          {shown.map((a) => (
            <AlertRow key={a.key} a={a} onPick={onPick} />
          ))}
        </ul>
      )}
      {legacyKeys.length ? <div className="feed-note">Old-format alerts: alerts/{legacyKeys.join(', alerts/')}</div> : null}
      <PriorityLegend />
    </Panel>
  );
}

export default React.memo(AlertFeed);
