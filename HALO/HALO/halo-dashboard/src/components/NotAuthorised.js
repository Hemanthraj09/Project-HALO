// Shown when the database answers PERMISSION_DENIED. Full-page when live/ is denied; a compact
// inline notice when only one other path is denied. The UID box and the operator steps are for
// the sign-in mode (components/AuthGate.js, unused while the dashboard has no sign-in).

import React, { useState } from 'react';
import { Copy, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import { T } from '../theme';

function useCopy(text) {
  const [status, setStatus] = useState(null);
  const copy = () => {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(
        () => setStatus('Copied'),
        () => setStatus('Copy failed: select the UID and copy it by hand'),
      );
    } else {
      setStatus('Clipboard not available: select the UID and copy it by hand');
    }
  };
  return [status, copy];
}

export function UidBox({ uid }) {
  const [status, copy] = useCopy(uid);
  return (
    <div className="uid-box">
      <span className="label">Your UID</span>
      <code>{uid}</code>
      <button type="button" className="btn btn-small" onClick={copy}>
        <Copy size={14} aria-hidden="true" />
        Copy
      </button>
      {status ? (
        <span className="note" role="status">
          {status}
        </span>
      ) : null}
    </div>
  );
}

function Steps({ uid }) {
  return (
    <ol className="steps">
      <li>
        Firebase console → Realtime Database → Data: add the key <code>{`operators/${uid}`}</code> with the value{' '}
        <code>true</code>.
      </li>
      <li>
        Or start the backend with <code>{`HALO_OPERATOR_UIDS=${uid}`}</code> (comma-separated for several operators);
        it writes <code>{'operators/<uid>: true'}</code> for each one at startup.
      </li>
      <li>Then press Retry.</li>
    </ol>
  );
}

export default function NotAuthorised({ user, paths, onRetry, onSignOut }) {
  const uid = user && user.uid ? user.uid : '';
  return (
    <main className="gate">
      <div className="gate-card is-wide" role="alert">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="brand-mark" style={{ color: T.red, background: T.redBg, borderColor: T.redFill }}>
            <ShieldAlert size={18} aria-hidden="true" />
          </span>
          <div>
            <h1 className="gate-title">Database read refused</h1>
            <p className="gate-sub">
              {paths.join(', ')}
              {user ? ' · this account is not on the operator list yet.' : ''}
            </p>
          </div>
        </div>
        {user ? <UidBox uid={uid} /> : null}
        {user ? <Steps uid={uid} /> : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />
            Retry
          </button>
          {onSignOut ? (
            <button type="button" className="btn" onClick={onSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

// Inline notice for a single denied path while live/ itself is readable (usually a rules gap).
export function AccessNotice({ error, user }) {
  if (!error) return null;
  if (!error.denied) {
    return (
      <div className="inline-error" role="alert">
        Could not read {error.path}: {error.message}
      </div>
    );
  }
  return (
    <div className="access-inline" role="alert">
      <strong>Not authorised to read {error.path}</strong>
      {user ? (
        <span>
          The database rules deny this path for UID <code>{user.uid}</code>. Add <code>{`operators/${user.uid}`}</code> = true,
          or check the rule for this path.
        </span>
      ) : null}
    </div>
  );
}
