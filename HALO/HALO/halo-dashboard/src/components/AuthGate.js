// Firebase Authentication gate (SPEC §10.1). Nothing below this component touches the database
// until Firebase reports a signed-in user, so no listener exists before sign-in.
// The database rules are the real access control; this gate only decides what to render.

import React, { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '../firebase';
import SignIn from './SignIn';

function Splash({ text }) {
  return (
    <div className="gate" role="status">
      <div className="empty">
        <div className="spinner" aria-hidden="true" />
        <div>{text}</div>
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  // undefined until Firebase has restored (or not) a session; then a User or null
  const [user, setUser] = useState(undefined);
  const [leaving, setLeaving] = useState(false);
  const [signOutError, setSignOutError] = useState(null);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u || null);
        setLeaving(false);
      }),
    [],
  );

  // The dashboard unmounts first, so its database listeners detach before the session ends.
  const doSignOut = useCallback(() => {
    setSignOutError(null);
    setLeaving(true);
    signOut(auth).catch((err) => {
      setLeaving(false);
      setSignOutError(err && err.message ? String(err.message) : 'Sign-out failed');
    });
  }, []);

  if (user === undefined) return <Splash text="Checking sign-in…" />;
  if (leaving) return <Splash text="Signing out…" />;
  if (!user) return <SignIn />;
  return children({ user, signOut: doSignOut, signOutError });
}
