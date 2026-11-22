import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth } from 'firebase/auth';

// Firebase web config. These values identify the project and ship in every client bundle;
// they are not secrets. The dashboard has no sign-in (the user's choice), so the Realtime Database
// rules in ../database.rules.json allow public reads and deny every client write; the backend
// writes with the Admin SDK, which the rules do not restrict. The auth export is kept for
// re-enabling sign-in later (components/AuthGate.js, SignIn.js).
export const firebaseConfig = {
  apiKey: 'AIzaSyAs5CKRfDMbOLyqhPE5QedKWf8aoVVRnAk',
  authDomain: 'halo-223051.firebaseapp.com',
  databaseURL: 'https://halo-223051-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'halo-223051',
  storageBucket: 'halo-223051.firebasestorage.app',
  messagingSenderId: '740770019914',
  appId: '1:740770019914:web:2c5876b30a1f99760584b3',
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
