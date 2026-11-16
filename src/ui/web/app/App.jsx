// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/App.jsx
//
// The shell (docs/arch-web-app.md §4.1). Until the top bar lands it shows who is signed in, from
// GET /me, and signs out.

import { useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from './auth/session.mjs';

/**
 * @param {object} props
 * @param {{ get: (path: string) => Promise<any> }} props.api
 * @param {() => void} props.onSignInRequired
 * @param {() => void} props.onSignOut
 */
export function App({ api, onSignInRequired, onSignOut }) {
  const { t } = useTranslation();
  const [me, setMe]           = useState(null);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    api.get('me').then(setMe, e => (e instanceof SignInRequired ? onSignInRequired() : setProblem(e)));
  }, [api, onSignInRequired]);

  return (
    <main className="shell">
      <h1>{t('app.name')}</h1>
      {problem && <p role="alert">{t('errors.unreachable')}</p>}
      {!problem && !me && <p>{t('shell.loading')}</p>}
      {me && (
        <p>
          {t('shell.signedInAs', { name: me.name ?? me.email })}{' '}
          <button type="button" onClick={onSignOut}>{t('shell.signOut')}</button>
        </p>
      )}
    </main>
  );
}

/** A sign-in that came back refused or unmatched (§9). */
export function SignInProblem({ onSignIn }) {
  const { t } = useTranslation();
  return (
    <main className="shell">
      <h1>{t('app.name')}</h1>
      <p role="alert">{t('signIn.problem')}</p>
      <button type="button" onClick={onSignIn}>{t('signIn.again')}</button>
    </main>
  );
}
