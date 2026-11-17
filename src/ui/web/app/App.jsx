// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/App.jsx
//
// The shell (docs/arch-web-app.md §4.1): the top bar over the page the route names. It reads who
// the user is (GET /me), the household's pages (GET /pages) and its domains (GET /workflows) once,
// retrying with the §9 banner while the backend can't be reached. Page bodies are each page's
// title until the panels arrive (Sprint 17 item 4).

import { useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from './auth/session.mjs';
import { useRoute }            from './router.mjs';
import { Link }                from './Link.jsx';
import { TopBar, PhoneTabs }   from './shell/TopBar.jsx';
import { MenuList }            from './shell/Menu.jsx';
import { domainItems, pollDelay, HOME_PAGE_KEY } from './shell/nav.mjs';

/**
 * The three reads the shell needs, with retries. `me` may already be in hand — main.jsx reads it
 * first, for the language.
 */
function useShellData(api, initialMe, onSignInRequired) {
  const { i18n } = useTranslation();
  const [data, setData] = useState({ me: initialMe, pages: null, domains: null, problem: false });

  useEffect(() => {
    let timer = null;
    let alive = true;
    async function load(failures) {
      try {
        const [me, pages, workflows] = await Promise.all([
          initialMe ?? api.get('me'),
          api.get('pages'),
          api.get('workflows'),
        ]);
        if (!alive) return;
        if (!initialMe) {
          await i18n.changeLanguage(me.locale);
          document.documentElement.lang = me.locale;
        }
        setData({ me, pages: pages.pages, domains: workflows.domains, problem: false });
      } catch (e) {
        if (!alive) return;
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        setData(d => ({ ...d, problem: true }));
        timer = setTimeout(() => load(failures + 1), pollDelay(failures));
      }
    }
    load(0);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, initialMe, onSignInRequired, i18n]);

  return data;
}

/**
 * @param {object} props
 * @param {{ get: (path: string, query?: object) => Promise<any> }} props.api
 * @param {object|null} props.me              GET /me, when main.jsx could read it
 * @param {() => void} props.onSignInRequired
 * @param {() => void} props.onSignOut
 */
export function App({ api, me, onSignInRequired, onSignOut }) {
  const route = useRoute();
  const data  = useShellData(api, me, onSignInRequired);
  return <Shell route={route} {...data} api={api} onSignOut={onSignOut} />;
}

/**
 * The page's title: the household's name for it, the domain's label, or the app's own word.
 * Null while the reads it comes from are outstanding.
 */
function usePageTitle(route, pages, domains) {
  const { t } = useTranslation();
  switch (route.page) {
    case 'home':
    case 'householdPage': {
      const pageKey = route.page === 'home' ? HOME_PAGE_KEY : route.params.pageKey;
      return pages && (pages.find(p => p.pageKey === pageKey)?.title ?? t('pages.notFound'));
    }
    case 'domain':        return domains && (domains.find(d => d.domain === route.params.domain)?.label ?? t('pages.notFound'));
    case 'domains':       return t('pages.domains');
    case 'run':           return t('pages.run', { runId: route.params.runId });
    default:              return t('pages.notFound');
  }
}

/**
 * The shell drawn from its data — what App draws once the reads are in, and what the tests draw.
 *
 * @param {object} props
 * @param {{ page: string, params: object, run: number|null, from: string|null }} props.route
 * @param {object|null} props.me
 * @param {object[]|null} props.pages
 * @param {object[]|null} props.domains
 * @param {boolean} props.problem
 */
export function Shell({ route, pages, domains, problem }) {
  const { t } = useTranslation();
  const title = usePageTitle(route, pages, domains);

  useEffect(() => {
    document.title = title ? `${title} · ${t('app.name')}` : t('app.name');
  }, [title, t]);

  return (
    <div className="app">
      <TopBar route={route} title={title} pages={pages} domains={domains} />
      {problem && <div className="banner" role="alert">{t('errors.retrying')}</div>}
      <main className="main">
        {title === null
          ? <p className="muted">{t('shell.loading')}</p>
          : (
            <div className="pagehead">
              <h1>{title}</h1>
            </div>
          )}
        {route.page === 'domains' && domains && (
          <div className="panel">
            <MenuList items={domainItems(domains)} currentKey={null} onPick={() => {}} />
          </div>
        )}
        {route.page === 'notFound' && <p><Link to="/">{t('pages.goHome')}</Link></p>}
      </main>
      <PhoneTabs route={route} pages={pages} domains={domains} />
    </div>
  );
}

/** A sign-in that came back refused or unmatched (§9). */
export function SignInProblem({ onSignIn }) {
  const { t } = useTranslation();
  return (
    <main className="signin">
      <h1>{t('app.name')}</h1>
      <p role="alert">{t('signIn.problem')}</p>
      <button type="button" onClick={onSignIn}>{t('signIn.again')}</button>
    </main>
  );
}
