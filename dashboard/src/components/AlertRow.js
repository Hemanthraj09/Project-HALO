// One alert-log entry: event icon (raised / changed / ongoing / cleared), severity chip, type,
// reason, responder and time. Device-supplied text is rendered as JSX text.

import React from 'react';
import { SEVERITY, T } from '../theme';
import { fmtStamp } from '../lib/time';
import { EVENT_META } from './icons';
import { SeverityChip } from './ui';

function AlertRow({ a, onPick, showResponder = true }) {
  const sev = a.priority === null ? null : SEVERITY[a.priority];
  const ev = EVENT_META[a.event || 'legacy'];
  const Icon = ev.Icon;
  const cleared = a.event === 'cleared';
  let cls = 'alert-row';
  if (cleared) cls += ' is-cleared';
  if (a.event === 'ongoing') cls += ' is-ongoing';
  return (
    <li className={cls} style={{ borderLeftColor: sev && !cleared ? sev.fill : T.border }}>
      <span className="alert-ev" title={ev.label} style={{ color: ev.color(sev) }}>
        <Icon size={16} aria-hidden="true" />
        <span className="sr-only">{ev.label}</span>
      </span>
      <div className="alert-main">
        <div className="alert-top">
          <SeverityChip sev={sev} />
          <span className="alert-type">{a.label}</span>
          <span className="alert-event">{ev.label}</span>
        </div>
        <div className="alert-reason" style={{ color: cleared || !sev ? T.textMuted : sev.color }}>
          {a.reason}
        </div>
        <div className="alert-meta">
          {showResponder && a.responderId ? (
            <button type="button" className="linkbtn" onClick={() => onPick(a.responderId)} title="Show this responder">
              {a.responderId}
            </button>
          ) : null}
          <time dateTime={a.ms !== null ? new Date(a.ms).toISOString() : undefined}>{fmtStamp(a.ms)}</time>
        </div>
      </div>
    </li>
  );
}

export default React.memo(AlertRow);
