// Status badge. A lost link keeps the last priority visible next to the LINK LOST badge.

import React from 'react';
import { Age } from './TimeText';
import { Badge } from './ui';

export default function StatusBadge({ st, since, align = 'end' }) {
  if (!st.lost) {
    return (
      <Badge color={st.color} bg={st.bg} border={st.fill}>
        {st.label}
      </Badge>
    );
  }
  return (
    <span className="rc-status" style={{ alignItems: align === 'end' ? 'flex-end' : 'flex-start' }}>
      <Badge color={st.color} bg={st.bg} border={st.last.fill}>
        LINK LOST
        {since !== null && since !== undefined ? (
          <>
            {' · '}
            <Age since={since} />
          </>
        ) : null}
      </Badge>
      <span className="rc-last" style={{ color: st.last.color }}>
        last: {st.last.name}
      </span>
    </span>
  );
}
