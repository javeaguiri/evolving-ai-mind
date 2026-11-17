// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/web-app.test.mjs
//
// Sprint 17 scope 3 (docs/arch-web-app.md §1, §4.8, §9, §13): the web app's sign-in, API client,
// router and catalog, without a browser — everything the browser provides is passed in or
// stubbed. Components are bundled with react-dom/server into one module (one React) and drawn to
// a string.

import { describe, it, before, beforeEach } from 'node:test';
import assert                               from 'node:assert/strict';
import { createHash }                       from 'node:crypto';
import { readFileSync, readdirSync }        from 'node:fs';
import { join }                             from 'node:path';
import * as esbuild                         from 'esbuild';

import { base64url, createVerifier, createState, challengeFor } from '../../src/ui/web/app/auth/pkce.mjs';
import { createSession, safeReturnPath, SignInRequired, AuthUnavailable, REFRESH_KEY, PENDING_KEY } from '../../src/ui/web/app/auth/session.mjs';
import { createApiClient, ApiError } from '../../src/ui/web/app/api/client.mjs';
import { matchPath, matchLocation }  from '../../src/ui/web/app/router.mjs';
import { pageItems, domainItems, sectionOf, currentItem, workflowLabels, gateHeadline, relativeAge, pollDelay, POLL_MS, POLL_MAX_MS } from '../../src/ui/web/app/shell/nav.mjs';

const APP_DIR = new URL('../../src/ui/web/app/', import.meta.url).pathname;
const CONFIG  = { userPoolId: 'us-east-2_pool', clientId: 'client123', authDomain: 'https://auth.example', siteUrl: 'https://site.example', region: 'us-east-2' };

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k)    { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('pkce — RFC 7636 S256', () => {
  it('a verifier is 43 URL-safe characters, new each time', () => {
    const a = createVerifier();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, createVerifier());
    assert.match(createState(), /^[A-Za-z0-9_-]{22}$/);
  });

  it('the challenge is BASE64URL(SHA-256(verifier)), unpadded', async () => {
    const verifier = createVerifier();
    assert.equal(await challengeFor(verifier), createHash('sha256').update(verifier).digest('base64url'));
    assert.equal(base64url(new Uint8Array([251, 255, 191])), '-_-_');
  });
});

describe('safeReturnPath — never another origin', () => {
  for (const [path, expected] of [['/d/inventory?run=4', '/d/inventory?run=4'], ['//evil.example', '/'], ['/\\evil.example', '/'],
    ['https://evil.example', '/'], ['', '/'], [null, '/'], ['/auth/callback?code=x', '/']]) {
    it(`${JSON.stringify(path)} → ${expected}`, () => assert.equal(safeReturnPath(path), expected));
  }
});

describe('createSession — sign-in, refresh with rotation, sign-out', () => {
  let local, pending, redirects, calls, answers, clock, session;
  beforeEach(() => {
    local = new MemoryStorage(); pending = new MemoryStorage(); redirects = []; calls = []; answers = []; clock = 1_000_000;
    session = createSession({
      config: CONFIG, local, pending, now: () => clock, redirect: url => redirects.push(url),
      fetch: async (url, init) => { calls.push({ url, init }); return (answers.shift() ?? (() => json(500, {})))(); },
    });
  });

  const startSignIn = async (returnTo = '/d/inventory') => {
    await session.signIn(returnTo);
    return new URL(redirects.at(-1));
  };
  const tokens = (n = 1) => json(200, { access_token: `access-${n}`, refresh_token: `refresh-${n}`, id_token: 'id', expires_in: 3600, token_type: 'Bearer' });
  const rotated = (n) => json(200, { AuthenticationResult: { AccessToken: `access-${n}`, RefreshToken: `refresh-${n}`, ExpiresIn: 3600, IdToken: 'id' } });

  it('signIn goes to managed login with the PKCE challenge, state, scope and callback', async () => {
    const url = await startSignIn();
    const kept = JSON.parse(pending.getItem(PENDING_KEY));
    assert.equal(url.origin + url.pathname, 'https://auth.example/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), 'client123');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://site.example/auth/callback');
    assert.equal(url.searchParams.get('scope'), 'openid email profile aws.cognito.signin.user.admin');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), await challengeFor(kept.verifier));
    assert.equal(url.searchParams.get('state'), kept.state);
    assert.equal(kept.returnTo, '/d/inventory');
  });

  it('completeSignIn exchanges the code with the verifier, keeps the refresh token and returns the path', async () => {
    const url = await startSignIn();
    const verifier = JSON.parse(pending.getItem(PENDING_KEY)).verifier;
    answers.push(() => tokens(1));
    const back = await session.completeSignIn(new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state') }));
    assert.equal(back, '/d/inventory');
    assert.equal(calls[0].url, 'https://auth.example/oauth2/token');
    assert.deepEqual(Object.fromEntries(calls[0].init.body), {
      grant_type: 'authorization_code', client_id: 'client123', code: 'the-code',
      redirect_uri: 'https://site.example/auth/callback', code_verifier: verifier,
    });
    assert.equal(local.getItem(REFRESH_KEY), 'refresh-1');
    assert.equal(pending.getItem(PENDING_KEY), null);
    assert.equal(await session.accessToken(), 'access-1');
    assert.equal(calls.length, 1, 'a fresh access token is used without a refresh');
  });

  it('a callback whose state does not match, or that carries an error, is refused and exchanges nothing', async () => {
    await startSignIn();
    await assert.rejects(session.completeSignIn(new URLSearchParams({ code: 'c', state: 'forged' })), SignInRequired);
    await startSignIn();
    const state = JSON.parse(pending.getItem(PENDING_KEY)).state;
    await assert.rejects(session.completeSignIn(new URLSearchParams({ error: 'access_denied', state })), SignInRequired);
    await assert.rejects(session.completeSignIn(new URLSearchParams({ code: 'c', state })), SignInRequired, 'a pending sign-in is used once');
    assert.equal(calls.length, 0);
  });

  it('near expiry the token is refreshed through GetTokensFromRefreshToken, and the rotated refresh token kept', async () => {
    local.setItem(REFRESH_KEY, 'refresh-1');
    answers.push(() => rotated(2));
    assert.equal(await session.accessToken(), 'access-2');
    assert.equal(calls[0].url, 'https://cognito-idp.us-east-2.amazonaws.com/');
    assert.equal(calls[0].init.headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken');
    assert.deepEqual(JSON.parse(calls[0].init.body), { RefreshToken: 'refresh-1', ClientId: 'client123' });
    assert.equal(local.getItem(REFRESH_KEY), 'refresh-2');

    clock += 3600_000 - 30_000;   // inside the minute before expiry
    answers.push(() => rotated(3));
    assert.equal(await session.accessToken(), 'access-3');
    assert.deepEqual(JSON.parse(calls[1].init.body).RefreshToken, 'refresh-2');
  });

  it('callers asking at once share one refresh — a rotated token is spent once', async () => {
    local.setItem(REFRESH_KEY, 'refresh-1');
    answers.push(() => rotated(2));
    const all = await Promise.all([session.accessToken(), session.accessToken(), session.forceRefresh().then(() => session.accessToken())]);
    assert.deepEqual(all, ['access-2', 'access-2', 'access-2']);
    assert.equal(calls.length, 1);
  });

  it('a refused refresh token ends the session; an unreachable Cognito keeps it', async () => {
    local.setItem(REFRESH_KEY, 'refresh-1');
    answers.push(() => { throw new TypeError('network'); });
    await assert.rejects(session.accessToken(), AuthUnavailable);
    assert.equal(local.getItem(REFRESH_KEY), 'refresh-1');

    answers.push(() => json(400, { __type: 'NotAuthorizedException', message: 'Refresh Token has been revoked' }));
    await assert.rejects(session.accessToken(), SignInRequired);
    assert.equal(local.getItem(REFRESH_KEY), null);
    assert.equal(session.hasSession(), false);
  });

  it('signOut revokes the refresh token, forgets it, and leaves through Cognito\'s logout', async () => {
    local.setItem(REFRESH_KEY, 'refresh-1');
    answers.push(() => new Response('', { status: 200 }));
    await session.signOut();
    assert.equal(calls[0].url, 'https://auth.example/oauth2/revoke');
    assert.deepEqual(Object.fromEntries(calls[0].init.body), { token: 'refresh-1', client_id: 'client123' });
    assert.equal(local.getItem(REFRESH_KEY), null);
    const out = new URL(redirects.at(-1));
    assert.equal(out.origin + out.pathname, 'https://auth.example/logout');
    assert.equal(out.searchParams.get('logout_uri'), 'https://site.example/');
  });

  it('signOut still leaves when the revoke cannot be reached', async () => {
    local.setItem(REFRESH_KEY, 'refresh-1');
    answers.push(() => { throw new TypeError('network'); });
    await session.signOut();
    assert.equal(local.getItem(REFRESH_KEY), null);
    assert.match(redirects.at(-1), /\/logout\?/);
  });
});

describe('createApiClient — the bearer, one retry on 401, WebError codes', () => {
  let calls, answers, refreshes, tokens, api;
  beforeEach(() => {
    calls = []; answers = []; refreshes = 0; tokens = ['t1', 't2'];
    const session = { accessToken: async () => tokens[Math.min(refreshes, 1)], forceRefresh: async () => { refreshes += 1; } };
    api = createApiClient({ session, fetch: async (url, init) => { calls.push({ url, init }); return (answers.shift() ?? (() => json(200, {})))(); } });
  });

  it('calls the same-origin web API with the access token', async () => {
    answers.push(() => json(200, { roles: ['household'] }));
    assert.deepEqual(await api.get('me'), { roles: ['household'] });
    assert.equal(calls[0].url, '/api/v1/ui/web/me');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer t1');
  });

  it('sends a query without empty values, and a JSON body', async () => {
    await api.get('runs', { workflow: 'w', status: undefined, limit: 5 });
    assert.equal(calls[0].url, '/api/v1/ui/web/runs?workflow=w&limit=5');
    await api.post('runs', { workflow: 'w' });
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].init.body, '{"workflow":"w"}');
  });

  it('a 401 refreshes once and retries with the new token', async () => {
    answers.push(() => json(401, { message: 'Unauthorized' }), () => json(200, { ok: 1 }));
    assert.deepEqual(await api.get('pages'), { ok: 1 });
    assert.equal(refreshes, 1);
    assert.deepEqual(calls.map(c => c.init.headers.Authorization), ['Bearer t1', 'Bearer t2']);
  });

  it('a second 401 means sign in again', async () => {
    answers.push(() => json(401, {}), () => json(401, {}));
    await assert.rejects(api.get('pages'), SignInRequired);
  });

  it('a WebError keeps its code, message and fields', async () => {
    answers.push(() => json(422, { error: { code: 'invalid_fields', message: 'Some answers need correcting.', fields: [{ name: 'amount' }] } }));
    const e = await api.post('gates/4/responses', { gateId: 'g', action: 'ok' }).catch(x => x);
    assert.ok(e instanceof ApiError);
    assert.deepEqual([e.status, e.code, e.fields], [422, 'invalid_fields', [{ name: 'amount' }]]);
  });

  it('a 502, a body without a code, or no answer at all is upstream_unavailable', async () => {
    answers.push(() => json(502, { error: { code: 'upstream_unavailable', message: 'x' } }), () => json(504, { message: 'Endpoint request timed out' }), () => { throw new TypeError('offline'); });
    for (let i = 0; i < 3; i++) assert.equal((await api.get('gates').catch(x => x)).code, 'upstream_unavailable');
  });
});

describe('matchPath — the §4.8 routes', () => {
  for (const [path, search, expected] of [
    ['/', '', { page: 'home', params: {}, run: null }],
    ['/p/money', '', { page: 'householdPage', params: { pageKey: 'money' }, run: null }],
    ['/d', '', { page: 'domains', params: {}, run: null }],
    ['/d/budgets_expenses', '?run=1500', { page: 'domain', params: { domain: 'budgets_expenses' }, run: 1500 }],
    ['/runs/42', '', { page: 'run', params: { runId: '42' }, run: null }],
    ['/settings/profile', '', { page: 'settings', params: { entry: 'profile' }, run: null }],
    ['/runs/0', '', { page: 'notFound', params: {}, run: null }],
    ['/d/x/y', '', { page: 'notFound', params: {}, run: null }],
    ['/p/%E0%A4%A', '', { page: 'notFound', params: {}, run: null }],
    ['/', '?run=abc', { page: 'home', params: {}, run: null }],
  ]) {
    it(`${path}${search}`, () => assert.deepEqual(matchPath(path, search), expected));
  }
});

describe('nav — the shell\'s decisions', () => {
  it('pageItems: position order; Home at /, the rest at /p/{pageKey}', () => {
    assert.deepEqual(pageItems([
      { pageKey: 'money', title: 'Money', position: 2 },
      { pageKey: 'home', title: 'Home', position: 0 },
      { pageKey: 'a b', title: 'AB', position: 1 },
    ]), [
      { key: 'home', label: 'Home', to: '/' },
      { key: 'a b', label: 'AB', to: '/p/a%20b' },
      { key: 'money', label: 'Money', to: '/p/money' },
    ]);
  });

  it('domainItems: PROC\'s order and labels, each to /d/{domain}', () => {
    assert.deepEqual(domainItems([{ domain: 'b_x', label: 'B x', labelFallback: true }, { domain: 'a', label: 'A' }]),
      [{ key: 'b_x', label: 'B x', to: '/d/b_x' }, { key: 'a', label: 'A', to: '/d/a' }]);
  });

  it('sectionOf and currentItem', () => {
    const at = path => matchLocation(path);
    assert.equal(sectionOf(at('/')), 'pages');
    assert.equal(sectionOf(at('/p/money')), 'pages');
    assert.equal(sectionOf(at('/d')), 'domains');
    assert.equal(sectionOf(at('/d/x')), 'domains');
    assert.equal(sectionOf(at('/runs/4')), null);
    assert.equal(sectionOf(at('/settings/profile')), null);
    assert.equal(currentItem(at('/')), 'home');
    assert.equal(currentItem(at('/p/money')), 'money');
    assert.equal(currentItem(at('/d/x')), 'x');
    assert.equal(currentItem(at('/d')), null);
  });

  it('workflowLabels: every domain\'s workflows by name', () => {
    const labels = workflowLabels([{ workflows: [{ name: 'w1', label: 'One' }] }, { workflows: [{ name: 'w2', label: 'Two' }] }]);
    assert.equal(labels.get('w1'), 'One');
    assert.equal(labels.get('w2'), 'Two');
    assert.equal(labels.get('w3'), undefined);
  });

  it('gateHeadline: the message\'s first line, without markdown\'s marks', () => {
    const d = value => ({ fields: [{ type: 'typography', value }, { type: 'button', value: 'x' }] });
    assert.equal(gateHeadline(d('Merge *Bread, sliced* into **Bread**?\nTwo items look alike.')), 'Merge Bread, sliced into Bread?');
    assert.equal(gateHeadline(d('\n\n## Choose a `month`\n')), 'Choose a month');
    assert.equal(gateHeadline(d('- [Item](https://x.example) first')), 'Item first');
    assert.equal(gateHeadline(d('|---|---|\n| a | b |')), '| a | b |');
    assert.equal(gateHeadline(d('   \n  ')), null);
    assert.equal(gateHeadline({ fields: [] }), null);
    assert.equal(gateHeadline(undefined), null);
  });

  it('relativeAge: the largest whole unit, in the locale\'s words', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    assert.equal(relativeAge('2026-11-17T11:59:30Z', now, 'en'), 'now');
    assert.equal(relativeAge('2026-11-17T11:55:00Z', now, 'en'), '5 minutes ago');
    assert.equal(relativeAge('2026-11-17T09:00:00Z', now, 'en'), '3 hours ago');
    assert.equal(relativeAge('2026-11-16T10:00:00Z', now, 'en'), 'yesterday');
    assert.equal(relativeAge('2026-11-01T12:00:00Z', now, 'en'), '2 weeks ago');
    assert.equal(relativeAge('2026-11-16T10:00:00Z', now, 'es'), 'ayer');
  });

  it('pollDelay: steady while reads succeed, doubling per failure, to a ceiling', () => {
    assert.equal(pollDelay(0), POLL_MS);
    assert.equal(pollDelay(1), POLL_MS * 2);
    assert.equal(pollDelay(2), POLL_MS * 4);
    assert.equal(pollDelay(50), POLL_MAX_MS);
  });
});

describe('components and catalog', () => {
  let ui;
  before(async () => {
    const out = await esbuild.build({
      stdin: {
        contents: `export { renderToString } from 'react-dom/server';
                   export { Shell, SignInProblem } from './App.jsx';
                   export { WaitingList } from './shell/NeedsYou.jsx';
                   export { initI18n } from './i18n.mjs';
                   export { createElement } from 'react';`,
        resolveDir: APP_DIR, loader: 'jsx',
      },
      bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', write: false, logLevel: 'silent',
      // react-dom/server requires Node built-ins; a data: module has no URL to resolve them from
      banner: { js: `import { createRequire } from 'module'; const require = createRequire(${JSON.stringify(APP_DIR)});` },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    ui = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`);
    await ui.initI18n('en');
  });

  const PAGES   = [
    { pageKey: 'money', title: 'Money', position: 1, panels: [] },
    { pageKey: 'home',  title: 'Home',  position: 0, panels: [] },
  ];
  const DOMAINS = [{ domain: 'pantry', label: 'Pantry', workflows: [] }, { domain: 'garden', label: 'Garden', labelFallback: true, workflows: [] }];
  const ME      = { name: 'A Person', email: 'person@example.test', roles: ['household'], locale: 'en', timezone: 'Europe/Madrid' };
  const api     = { get: () => new Promise(() => {}) };
  const draw    = (location, data = {}, from = null) => ui.renderToString(ui.createElement(ui.Shell, {
    route: { ...matchLocation(location), location, from }, me: ME, pages: PAGES, domains: DOMAINS, problem: false,
    api, onSignInRequired() {}, onSignOut() {}, ...data,
  }));

  it('before the pages are read, the shell draws its top bar and Loading…', () => {
    const html = draw('/', { pages: null, domains: null });
    assert.match(html, /aria-label="Home"/);
    assert.match(html, />Pages<span class="car"/);
    assert.match(html, /Loading…/);
    assert.doesNotMatch(html, /<h1>/);
  });

  it('Home draws the household\'s title for it; 🏠 and the Pages menu are marked current', () => {
    const html = draw('/');
    assert.match(html, /<h1>Home<\/h1>/);
    assert.match(html, /class="homeb" aria-label="Home" title="Home" aria-current="page"/);
    assert.match(html, /class="mbtn cur"[^>]*>Pages</);
    assert.match(html, /class="mbtn"[^>]*>Domains</);
  });

  it('a household page and a domain page take their titles from the reads', () => {
    assert.match(draw('/p/money'), /<h1>Money<\/h1>/);
    const html = draw('/d/garden');
    assert.match(html, /<h1>Garden<\/h1>/);
    assert.match(html, /class="mbtn cur"[^>]*>Domains</);
  });

  it('an unknown page, domain or path says Page not found and offers Home', () => {
    for (const path of ['/p/nowhere', '/d/nowhere', '/nowhere/at/all']) {
      const html = draw(path);
      assert.match(html, /<h1>Page not found<\/h1>/, path);
    }
    assert.match(draw('/nowhere/at/all'), /<a href="\/">Go to Home<\/a>/);
  });

  it('See all… lists every domain, each linked to its page', () => {
    const html = draw('/d');
    assert.match(html, /<h1>Domains<\/h1>/);
    assert.match(html, /<a href="\/d\/pantry">Pantry<\/a>.*<a href="\/d\/garden">Garden<\/a>/);
  });

  it('a backend that can\'t be reached shows the retrying banner', () => {
    assert.match(draw('/', { problem: true }), /role="alert">Can(&#x27;|')t reach the home brain — retrying</);
    assert.doesNotMatch(draw('/'), /role="alert"/);
  });

  it('the phone tabs carry the two menus, the section the user is in marked', () => {
    const html = draw('/d/pantry');
    assert.match(html, /<nav class="tabbar"[^>]*><button type="button">Pages<\/button><button type="button" aria-current="true">Domains<\/button>/);
  });

  it('🔔 before its first read: no count, named for a screen reader; ⚙ goes to Profile over this page', () => {
    const html = draw('/p/money');
    assert.match(html, /<button type="button" class="ib" aria-label="Needs you, nothing waiting" title="Needs you">/);
    assert.doesNotMatch(html, /class="badge"/);
    assert.match(html, /<a href="\/settings\/profile" class="ib" aria-label="Settings" title="Settings">/);
  });

  it('Settings from a deep link opens over Home: Profile, name and email read-only, Sign out, no Save', () => {
    const html = draw('/settings/profile');
    assert.match(html, /<h1>Home<\/h1>/);
    assert.match(html, /class="mbtn cur"[^>]*>Pages</);
    assert.match(html, /role="dialog" aria-modal="true" aria-label="Settings"/);
    assert.match(html, /<a href="\/settings\/profile" aria-current="page">Profile<\/a>/);
    assert.match(html, /<dt>Name<\/dt><dd>A Person<\/dd><dt>Email<\/dt><dd>person@example.test<\/dd>/);
    assert.match(html, /<button type="button" class="btn">Sign out<\/button>/);
    assert.doesNotMatch(html, /Save|<input/);
  });

  it('Settings opened from a page draws over that page; a name Cognito lacks is left out', () => {
    const html = draw('/settings/profile', { me: { ...ME, name: undefined } }, '/d/garden');
    assert.match(html, /<h1>Garden<\/h1>/);
    assert.match(html, /class="mbtn cur"[^>]*>Domains</);
    assert.doesNotMatch(html, /<dt>Name/);
    assert.match(html, /<dt>Email<\/dt>/);
  });

  it('an unknown Settings entry is Page not found, with no dialog', () => {
    const html = draw('/settings/nowhere');
    assert.match(html, /<h1>Page not found<\/h1>/);
    assert.doesNotMatch(html, /role="dialog"/);
  });

  it('?run= opens the run drawer over the page', () => {
    const html = draw('/p/money?run=7');
    assert.match(html, /<h1>Money<\/h1>/);
    assert.match(html, /role="dialog" aria-modal="true" aria-label="Run 7"/);
  });

  it('the waiting list: question, workflow and run, age, Slack, each opening its run over this page', () => {
    const gates = [
      { runId: 12, workflowName: 'tidy_up', label: 'Spare room', provider: 'slack', waitingSince: '2026-11-17T09:00:00Z',
        dialog: { fields: [{ type: 'typography', value: '**Keep** the lamp?\nIt has not moved in a year.' }] } },
      { runId: 13, workflowName: 'unlisted_flow', label: null, provider: 'web', waitingSince: '2026-11-16T10:00:00Z', dialog: { fields: [] } },
    ];
    const html = ui.renderToString(ui.createElement(ui.WaitingList, {
      gates, labels: new Map([['tidy_up', 'Tidy up']]), path: '/p/money', now: Date.parse('2026-11-17T12:00:00Z'), onPick() {},
    }));
    assert.match(html, /<a href="\/p\/money\?run=12"><span class="q">Keep the lamp\?<\/span><span class="sub">Tidy up · Spare room(<!-- -->)? · <time dateTime="2026-11-17T09:00:00Z">3 hours ago<\/time><\/span><span class="pill slack">Slack<\/span><\/a>/);
    assert.match(html, /<a href="\/p\/money\?run=13"><span class="q">unlisted_flow<\/span><span class="sub">unlisted_flow(<!-- -->)? · <time[^>]*>yesterday<\/time><\/span><\/a>/);
  });

  it('the waiting list, empty', () => {
    const html = ui.renderToString(ui.createElement(ui.WaitingList, { gates: [], labels: new Map(), path: '/', now: 0, onPick() {} }));
    assert.match(html, /Nothing is waiting for you\./);
  });

  it('a refused sign-in says so and offers to sign in again', () => {
    const html = ui.renderToString(ui.createElement(ui.SignInProblem, { onSignIn() {} }));
    assert.match(html, /The sign-in didn(&#x27;|')t complete\./);
    assert.match(html, /<button type="button">Sign in again<\/button>/);
  });

  it('every catalog key is used by the app, and every key the app uses is in the catalog', () => {
    const catalog = JSON.parse(readFileSync(join(APP_DIR, 'locales/en.json'), 'utf8'));
    const flat    = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    const keys    = new Set(flat(catalog));
    const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(jsx|mjs)$/.test(e.name) ? [readFileSync(join(dir, e.name), 'utf8')] : []));
    const used    = new Set(sources(APP_DIR).flatMap(src => [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map(m => m[1])));
    assert.deepEqual([...used].filter(k => !keys.has(k)), [], 'used but not in the catalog');
    assert.deepEqual([...keys].filter(k => !used.has(k)), [], 'in the catalog but never used');
  });
});
