// ALERTS tab: this responder's active alerts (from live; last known ones while the link is lost)
// and its alert log (raised / changed / ongoing / cleared, newest first).

import React, { useMemo } from 'react';
import { BellRing } from 'lucide-react';
import { SEVERITY } from '../theme';
import { activeAlertsOf } from '../lib/status';
import AlertRow from './AlertRow';
import { typeIcon } from './icons';
import { Age } from './TimeText';
import { Card, Empty, SeverityChip } from './ui';

export default function AlertsTab({ id, r, lost, alerts, onPick }) {
  const active = useMemo(() => activeAlertsOf(id, r, lost), [id, r, lost]);
  const log = useMemo(() => alerts.filter((a) => a.responderId === id), [alerts, id]);
  return (
    <>
      <Card title="Active now" icon={BellRing} meta={`${active.length}`}>
        {active.length === 0 ? (
          <div className="note">No active alerts.</div>
        ) : (
          <div className="rows">
            {active.map((a) => {
              const Icon = typeIcon(a.type);
              const sev = SEVERITY[a.severity];
              return (
                <div key={a.id} className="row">
                  <span className="row-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon size={14} aria-hidden="true" style={{ color: sev.color }} />
                    <SeverityChip sev={sev} />
                    <span style={{ color: sev.color, fontWeight: 600 }}>{a.reason}</span>
                  </span>
                  <span className="row-value">
                    {a.sinceMs !== null ? <Age since={a.sinceMs} /> : '--'}
                    {a.lastKnown ? <span className="row-sub">last known</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Card title="Alert log" meta={`${log.length}`}>
        {log.length === 0 ? (
          <Empty>No alerts logged for {id}.</Empty>
        ) : (
          <ul className="feed-list" style={{ overflow: 'visible' }}>
            {log.map((a) => (
              <AlertRow key={a.key} a={a} onPick={onPick} showResponder={false} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
