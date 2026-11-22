// Left column: one card per responder in live/, most severe first (a lost link ranks at least
// with the warnings).

import React, { useMemo } from 'react';
import { Users } from 'lucide-react';
import { sortResponderIds } from '../lib/status';
import { AccessNotice } from './NotAuthorised';
import ResponderCard from './ResponderCard';
import { Empty, Panel } from './ui';

function ResponderList({ responders, lostIds, selectedId, onSelect, error, user }) {
  const ids = useMemo(() => sortResponderIds(responders, lostIds), [responders, lostIds]);
  return (
    <Panel title="Responders" icon={Users} meta={`${ids.length}`} className="area-resp">
      <AccessNotice error={error} user={user} />
      {ids.length === 0 ? (
        <Empty title="Waiting for data" spinner={!error} />
      ) : (
        ids.map((id) => (
          <ResponderCard key={id} id={id} r={responders[id]} lost={lostIds.has(id)} selected={id === selectedId} onSelect={onSelect} />
        ))
      )}
    </Panel>
  );
}

export default React.memo(ResponderList);
