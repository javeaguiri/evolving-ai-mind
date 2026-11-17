// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/main.jsx
//
// The web app's entry (docs/arch-web-app.md §1): finish a sign-in at /auth/callback; with no
// session, go to sign-in and come back to this page; read who the user is, and load the catalog in
// their language (§13); then draw the app. A /me that can't be read leaves English and the app's
// own retries.

import { createRoot }        from 'react-dom/client';
import './styles.css';
import { WEB_CONFIG }        from './config.mjs';
import { initI18n }          from './i18n.mjs';
import { createSession, SignInRequired } from './auth/session.mjs';
import { createApiClient }   from './api/client.mjs';
import { replace }           from './router.mjs';
import { App, SignInProblem } from './App.jsx';

const session = createSession({
  config:   WEB_CONFIG,
  local:    window.localStorage,
  pending:  window.sessionStorage,
  fetch:    window.fetch.bind(window),
  redirect: url => window.location.assign(url),
});
const api  = createApiClient({ session, fetch: window.fetch.bind(window) });
const here = () => window.location.pathname + window.location.search;

async function setLocale(locale) {
  await initI18n(locale);
  document.documentElement.lang = locale;
}

async function start() {
  const root = createRoot(document.getElementById('root'));

  if (window.location.pathname === '/auth/callback') {
    try {
      replace(await session.completeSignIn(new URLSearchParams(window.location.search)));
    } catch {
      await setLocale('en');
      root.render(<SignInProblem onSignIn={() => session.signIn('/')} />);
      return;
    }
  }
  if (!session.hasSession()) {
    await session.signIn(here());
    return;
  }
  let me = null;
  try {
    me = await api.get('me');
  } catch (e) {
    if (e instanceof SignInRequired) { await session.signIn(here()); return; }
  }
  await setLocale(me?.locale ?? 'en');
  root.render(<App api={api} me={me} onSignInRequired={() => session.signIn(here())} onSignOut={() => session.signOut()} />);
}

await start();
