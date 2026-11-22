// Email/Password sign-in screen (Firebase Authentication).

import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { Eye, EyeOff, LogIn, ShieldCheck } from 'lucide-react';
import { auth } from '../firebase';
import { authErrorText } from '../lib/authErrors';
import { T } from '../theme';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // On success AuthGate swaps this screen for the dashboard.
    signInWithEmailAndPassword(auth, email.trim(), password).catch((err) => {
      setError(authErrorText(err));
      setBusy(false);
    });
  };

  return (
    <main className="gate">
      <form className="gate-card" onSubmit={submit} noValidate>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="brand-mark" style={{ color: T.blue, background: T.blueBg, borderColor: T.blueFill }}>
            <ShieldCheck size={18} aria-hidden="true" />
          </span>
          <div>
            <h1 className="gate-title">HALO Command</h1>
            <p className="gate-sub">Sign in to see live responder data.</p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="signin-password">Password</label>
          <div className="field-row">
            <input
              id="signin-password"
              className="input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
            <button
              type="button"
              className="btn"
              onClick={() => setShowPassword((s) => !s)}
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}

        <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>
          <LogIn size={16} aria-hidden="true" />
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="note" style={{ margin: 0 }}>
          Operator accounts are created in Firebase console → Authentication → Users. Reading data also needs the
          account's UID under operators/ in the Realtime Database; the dashboard shows the exact step if it is missing.
        </p>
      </form>
    </main>
  );
}
