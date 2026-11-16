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
import { matchPath }                 from '../../src/ui/web/app/router.mjs';

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

describe('components and catalog', () => {
  let ui;
  before(async () => {
    const out = await esbuild.build({
      stdin: {
        contents: `export { renderToString } from 'react-dom/server';
                   export { App, SignInProblem } from './App.jsx';
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

  it('the shell draws its name and Loading… before /me answers', () => {
    const api  = { get: () => new Promise(() => {}) };
    const html = ui.renderToString(ui.createElement(ui.App, { api, onSignInRequired() {}, onSignOut() {} }));
    assert.match(html, /<h1>Home Brain<\/h1>/);
    assert.match(html, /Loading…/);
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
