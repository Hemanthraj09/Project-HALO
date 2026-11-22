// Firebase Authentication error codes -> plain operator-facing text (SPEC §10.1).
// Projects created with email-enumeration protection report a wrong email and a wrong password
// the same way (auth/invalid-credential); older projects use the two separate codes below.

export const SIGN_IN_DISABLED_TEXT =
  'Email/Password sign-in is not enabled for this Firebase project. Enable it in Firebase console → Authentication → Sign-in method.';

export function authErrorText(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong email or password.';
    case 'auth/invalid-email':
      return 'That is not a valid email address.';
    case 'auth/missing-password':
      return 'Enter your password.';
    case 'auth/missing-email':
      return 'Enter your email address.';
    case 'auth/user-disabled':
      return 'This account is disabled in Firebase Authentication.';
    case 'auth/operation-not-allowed':
    case 'auth/configuration-not-found':
      return SIGN_IN_DISABLED_TEXT;
    case 'auth/too-many-requests':
      return 'Too many sign-in attempts from this device. Wait a few minutes, then try again.';
    case 'auth/network-request-failed':
      return 'Network error: could not reach Firebase Authentication. Check the internet connection and try again.';
    default: {
      const detail = err && err.message ? String(err.message) : 'unknown error';
      return code ? `Sign-in failed (${code}): ${detail}` : `Sign-in failed: ${detail}`;
    }
  }
}
