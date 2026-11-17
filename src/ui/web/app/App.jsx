// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/App.jsx
//
// The shell (docs/arch-web-app.md §4.1): the top bar — 🏠, Pages, Domains, 🔔, ⚙ — over the page
// the route names, Settings and the run drawer over that. It reads who
// the user is (GET /me), the household's pages (GET /pages) and its domains (GET /workflows) once,
// retrying with the §9 banner while the backend can't be reached. A household page draws its
// panels (§4.2); a domain page its workflow panel (§4.4); a run page and the run drawer the run's
// thread (§4.3).

import { useEffect, useMemo, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from './auth/session.mjs';
import { useRoute, matchLocation, navigate, replace, back } from './router.mjs';
import { Link }                from './Link.jsx';
import { TopBar, PhoneTabs }   from './shell/TopBar.jsx';
import { MenuList }            from './shell/Menu.jsx';
import { Drawer }              from './shell/Drawer.jsx';
import { NeedsYou }            from './shell/NeedsYou.jsx';
import { GearIcon }            from './shell/icons.jsx';
import { Settings, SETTINGS_ENTRIES } from './pages/Settings.jsx';
import { PageBody }            from './panels/PageBody.jsx';
import { WorkflowPanel }       from './panels/WorkflowPanel.jsx';
import { RunThread }           from './runs/RunThread.jsx';
import { runName }             from './runs/runs.mjs';
import { domainItems, workflowLabels, pollDelay, HOME_PAGE_KEY } from './shell/nav.mjs';

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
  return <Shell route={route} {...data} api={api} onSignInRequired={onSignInRequired} onSignOut={onSignOut} />;
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
 * Settings is a dialog over the page it was opened from (or Home, from a deep link); the run
 * drawer (`?run=`) opens over any page.
 *
 * @param {object} props
 * @param {{ page: string, params: object, run: number|null, location: string, from: string|null }} props.route
 * @param {object|null} props.me
 * @param {object[]|null} props.pages
 * @param {object[]|null} props.domains
 * @param {boolean} props.problem
 * @param {{ get: (path: string) => Promise<any> }} props.api
 * @param {() => void} props.onSignInRequired
 * @param {() => void} props.onSignOut
 */
export function Shell({ route, me, pages, domains, problem, api, onSignInRequired, onSignOut }) {
  const { t, i18n } = useTranslation();
  const settings = route.page === 'settings' && SETTINGS_ENTRIES.includes(route.params.entry);
  const under    = settings ? route.from ?? '/' : route.location;
  const page     = settings ? { ...matchLocation(under), location: under } : route;
  const path     = page.location.split('?')[0];
  const title    = usePageTitle(page, pages, domains);
  const labels   = useMemo(() => workflowLabels(domains ?? []), [domains]);
  const pageKey  = page.page === 'home' ? HOME_PAGE_KEY : page.page === 'householdPage' ? page.params.pageKey : null;
  const shown    = pageKey && pages?.find(p => p.pageKey === pageKey);
  const context  = useMemo(() => ({ api, domains, locale: me?.locale ?? i18n.language, timeZone: me?.timezone, onSignInRequired }),
    [api, domains, me, i18n.language, onSignInRequired]);
  const [run, setRun] = useState(null);     // the run the run page or the run drawer shows
  const where    = { language: i18n.language, locale: context.locale, timeZone: context.timeZone };
  const runId    = page.page === 'run' ? Number(page.params.runId) : null;

  useEffect(() => {
    document.title = title ? `${title} · ${t('app.name')}` : t('app.name');
  }, [title, t]);

  return (
    <div className="app">
      <TopBar route={page} title={title} pages={pages} domains={domains}>
        <NeedsYou api={api} labels={labels} path={path} onSignInRequired={onSignInRequired} />
        <Link to="/settings/profile" state={{ from: under }} className="ib" aria-label={t('settings.title')} title={t('settings.title')}>
          <GearIcon />
        </Link>
      </TopBar>
      {problem && <div className="banner" role="alert">{t('errors.retrying')}</div>}
      <main className="main">
        {title === null && <p className="muted">{t('shell.loading')}</p>}
        {title !== null && (
          <div className="pagehead">
            <h1>{runId && run?.runId === runId ? runName(run, where) : title}</h1>
          </div>
        )}
        {runId && (
          <div className="panel w-full">
            <RunThread key={runId} runId={runId} context={context} onRun={setRun} />
          </div>
        )}
        {page.page === 'domain' && domains?.some(d => d.domain === page.params.domain) && (
          <div className="panels">
            <WorkflowPanel key={page.params.domain} panel={{ id: 'workflows', width: 'full', config: { domain: page.params.domain } }}
              title={t('workflow.domainPanel')} context={context} />
          </div>
        )}
        {shown && shown.panels.length > 0 && <PageBody pageKey={shown.pageKey} panels={shown.panels} context={context} />}
        {shown && shown.panels.length === 0 && page.page === 'home' && <p className="muted">{t('pages.homeEmpty')}</p>}
        {page.page === 'domains' && domains && (
          <div className="panel">
            <MenuList items={domainItems(domains)} currentKey={null} onPick={() => {}} />
          </div>
        )}
        {page.page === 'notFound' && <p><Link to="/">{t('pages.goHome')}</Link></p>}
      </main>
      <PhoneTabs route={page} pages={pages} domains={domains} />
      {page.run && (
        <Drawer title={run?.runId === page.run ? runName(run, where) : t('pages.run', { runId: page.run })} onClose={() => navigate(path)}>
          <p className="ptools"><Link to={`/runs/${page.run}`}>{t('run.openPage')}</Link></p>
          <RunThread key={page.run} runId={page.run} context={context} onRun={setRun} />
        </Drawer>
      )}
      {settings && (
        <Settings entry={route.params.entry} me={me} from={route.from} onSignOut={onSignOut}
          onClose={() => (route.from ? back() : replace('/'))} />
      )}
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
