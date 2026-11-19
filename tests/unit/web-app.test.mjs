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
import { formatValue, isNumericColumn }   from '../../src/ui/web/app/records/format.mjs';
import { rowsRequest, mergeColumns, listFields, initialView, viewKey } from '../../src/ui/web/app/records/query.mjs';
import { inputsOf, initialValues, isChanged, fieldProblems, formValues, answerFor, gridOf, gridSections, moveCell, listColumns, revealContent } from '../../src/ui/web/app/gates/gate.mjs';
import { liveScript, isNewBuild } from '../../src/ui/web/app/shell/version.mjs';
import { runName, panelWorkflows, foldPoint, addMessages, threadDelay, isActive, isWorking, THREAD_POLL_MS, THREAD_POLL_MAX_MS } from '../../src/ui/web/app/runs/runs.mjs';
import { pageItems, domainItems, sectionOf, currentItem, gateHeadline, relativeAge, pollDelay, POLL_MS, POLL_MAX_MS } from '../../src/ui/web/app/shell/nav.mjs';
import { sessionName, addConversation, groupTurns, repliesMissing, conversationDelay, readCollapsed, writeCollapsed, withSession, answerable, answerField, answersFrom, RADIO_LIMIT, stillExpecting, personCount, EXPECT_MS, COLLAPSED_KEY, WORKING_POLL_MS, WAITING_POLL_MS, POLL_MAX_MS as CONVO_MAX_MS, ROUND_CEILING_MS } from '../../src/ui/web/app/minds-eye/conversation.mjs';

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
    ['/', '', { page: 'home', params: {}, run: null, mindsEye: null }],
    ['/p/money', '', { page: 'householdPage', params: { pageKey: 'money' }, run: null, mindsEye: null }],
    ['/d', '', { page: 'domains', params: {}, run: null, mindsEye: null }],
    ['/d/budgets_expenses', '?run=1500', { page: 'domain', params: { domain: 'budgets_expenses' }, run: 1500, mindsEye: null }],
    ['/runs/42', '', { page: 'run', params: { runId: '42' }, run: null, mindsEye: null }],
    ['/settings/profile', '', { page: 'settings', params: { entry: 'profile' }, run: null, mindsEye: null }],
    ['/runs/0', '', { page: 'notFound', params: {}, run: null, mindsEye: null }],
    ['/d/x/y', '', { page: 'notFound', params: {}, run: null, mindsEye: null }],
    ['/p/%E0%A4%A', '', { page: 'notFound', params: {}, run: null, mindsEye: null }],
    ['/', '?run=abc', { page: 'home', params: {}, run: null, mindsEye: null }],
    ['/p/money', '?minds-eye=1367', { page: 'householdPage', params: { pageKey: 'money' }, run: null, mindsEye: 1367 }],
    ['/runs/42', '?run=7&minds-eye=12', { page: 'run', params: { runId: '42' }, run: 7, mindsEye: 12 }],
    ['/', '?minds-eye=0', { page: 'home', params: {}, run: null, mindsEye: null }],
    ['/nowhere', '?minds-eye=5', { page: 'notFound', params: {}, run: null, mindsEye: 5 }],
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

describe('records — formatting through Intl (§6.3, §13)', () => {
  const en = { locale: 'en', timeZone: 'Europe/Madrid' };
  const es = { locale: 'es', timeZone: 'Europe/Madrid' };
  const f  = (value, column, row = {}, where = en) => formatValue(value, column, row, where).replace(/\s/g, ' ');

  it('a date is its calendar day in every timezone; SERV sends it as UTC midnight', () => {
    assert.equal(f('2026-10-09T00:00:00.000Z', { type: 'date' }), 'Oct 9, 2026');
    assert.equal(f('2026-10-09T00:00:00.000Z', { type: 'date' }, {}, { locale: 'en', timeZone: 'America/Los_Angeles' }), 'Oct 9, 2026');
    assert.equal(f('2026-10-09', { type: 'date' }, {}, es), '9 oct 2026');
  });

  it('a timestamp is shown in the household\'s timezone; format date keeps only its day there', () => {
    assert.equal(f('2026-11-17T09:05:00Z', { type: 'timestamptz' }), 'Nov 17, 2026, 10:05 AM');
    assert.equal(f('2026-11-17T23:30:00Z', { type: 'timestamptz', format: 'date' }), 'Nov 18, 2026');
  });

  it('numbers — SERV sends numeric as a string — in the locale\'s separators', () => {
    assert.equal(f('9.1', { type: 'numeric' }), '9.1');
    assert.equal(f('1234.5', { type: 'numeric' }), '1,234.5');
    assert.equal(f('12345.5', { type: 'numeric' }, {}, es), '12.345,5');
    assert.equal(f(7, { type: 'integer' }), '7');
    assert.equal(f('0.25', { type: 'numeric', format: 'percent' }), '25%');
  });

  it('a currency only when the panel names one: the row\'s own column, or a fixed code', () => {
    const fromRow = { type: 'numeric', format: 'currency', currency_column: 'currency' };
    assert.equal(f('9.1', fromRow, { currency: 'EUR' }), '€9.10');
    assert.equal(f('9.1', fromRow, { currency: 'EUR' }, es), '9,10 €');
    assert.equal(f('9.1', { type: 'numeric', format: 'currency', currency: 'USD' }), '$9.10');
    assert.equal(f('9.1', fromRow, { currency: null }), '9.1', 'no code on the row — a plain number, never a guess');
    assert.equal(f('9.1', { type: 'numeric' }, { currency: 'EUR' }), '9.1', 'no format — no currency');
  });

  it('empty, true, a structure and text', () => {
    for (const empty of [null, undefined, '']) assert.equal(f(empty, { type: 'numeric' }), '');
    assert.equal(f(true, { type: 'boolean' }), '✓');
    assert.equal(f(false, { type: 'boolean' }), '');
    assert.equal(f({ a: 1 }, { type: 'jsonb' }), '{"a":1}');
    assert.equal(f('as entered', { type: 'varchar' }), 'as entered');
    assert.equal(f('not a number', { type: 'numeric' }), 'not a number');
  });

  it('numbers line up on the right', () => {
    for (const type of ['numeric', 'integer', 'serial', 'bigint', 'double precision', 'numeric(10,2)']) assert.ok(isNumericColumn({ type }), type);
    for (const type of ['varchar', 'date', 'text', 'interval']) assert.ok(!isNumericColumn({ type }), type);
  });
});

describe('records — the read, the columns, the views (§4.2)', () => {
  const READ = [
    { name: 'id', type: 'serial', label: 'Id' },
    { name: 'created_at', type: 'timestamptz', label: 'Created at' },
    { name: 'title', type: 'varchar', label: 'Title' },
    { name: 'amount', type: 'numeric', label: 'Amount' },
    { name: 'currency', type: 'varchar', label: 'Currency' },
    { name: 'date', type: 'date', label: 'Date' },
  ];

  it('rowsRequest: the panel\'s columns, plus any a currency or the list needs; its filter, order and limit', () => {
    assert.deepEqual(rowsRequest({ source: 'PGD_Things', columns: ['date', { name: 'amount', format: 'currency', currency_column: 'currency' }],
      title_column: 'title', filter: [{ column: 'deleted_at', op: 'is_null' }], order_by: 'date DESC', limit: 50 }), {
      source: 'PGD_Things',
      query:  { columns: 'date,amount,currency,title', filter: '[{"column":"deleted_at","op":"is_null"}]', order_by: 'date DESC', limit: 50 },
    });
    assert.deepEqual(rowsRequest({ entity: 'Thing' }), { source: 'Thing', query: { columns: undefined, filter: undefined, order_by: undefined, limit: undefined } });
  });

  it('mergeColumns: the panel\'s order, labels (a language map read in the language) and formats; the rest read but not in the grid', () => {
    const merged = mergeColumns({ columns: ['date', { name: 'amount', label: { en: 'Spent', es: 'Gastado' }, format: 'currency', currency_column: 'currency' }] }, READ, 'es');
    assert.deepEqual(merged.filter(c => c.shown).map(c => [c.name, c.label]), [['date', 'Date'], ['amount', 'Gastado']]);
    assert.equal(merged.find(c => c.name === 'amount').format, 'currency');
    assert.deepEqual(merged.filter(c => !c.shown).map(c => c.name), ['id', 'created_at', 'title', 'currency']);
    assert.ok(mergeColumns({}, READ, 'en').every(c => c.shown), 'no columns named — the grid shows every column read');
  });

  it('listFields: the panel\'s choice, else the label column and the next two readable columns', () => {
    const all = mergeColumns({}, READ, 'en');
    assert.deepEqual(listFields({}, all), { title: 'title', details: ['amount', 'currency'] });
    assert.deepEqual(listFields({ title_column: 'date', detail_columns: ['title'] }, all), { title: 'date', details: ['title'] });
    const named = mergeColumns({ columns: ['date', 'amount'] }, READ, 'en');
    assert.deepEqual(listFields({ columns: ['date', 'amount'] }, named), { title: 'title', details: ['date', 'amount'] });
  });

  it('initialView: the viewer\'s last choice, else the panel\'s view, else grid — of the views Phase 0 draws', () => {
    assert.equal(initialView({}, null), 'grid');
    assert.equal(initialView({ view: 'list' }, null), 'list');
    assert.equal(initialView({ view: 'list' }, 'grid'), 'grid');
    assert.equal(initialView({ view: 'document' }, 'gallery'), 'grid');
    assert.equal(viewKey('money', 'expenses'), 'evomind.view.money.expenses');
  });
});

describe('runs — names, workflows, the thread\'s messages and pace (§2.4, §4.3)', () => {
  const where = { language: 'es', locale: 'es', timeZone: 'Europe/Madrid' };

  it('runName: the label; else the workflow\'s label in the language, and the day it started', () => {
    assert.equal(runName({ label: 'Noviembre' }, where), 'Noviembre');
    assert.equal(runName({ label: null, workflowLabel: { en: 'Edit budget', es: 'Editar presupuesto' }, startedAt: '2026-11-01T23:30:00Z' }, where), 'Editar presupuesto · 2 nov');
    assert.equal(runName({ label: null, workflowLabel: null, workflowName: 'edit_budget', startedAt: 'nonsense' }, where), 'edit_budget');
  });

  it('panelWorkflows: the domain\'s, or the one named — by its name when the menu does not list it', () => {
    const domains = [{ domain: 'a', workflows: [{ name: 'x', label: 'X' }, { name: 'y', label: 'Y' }] }, { domain: 'b', workflows: [{ name: 'z', label: 'Z' }] }];
    assert.deepEqual(panelWorkflows({ domain: 'a' }, domains).map(w => w.name), ['x', 'y']);
    assert.deepEqual(panelWorkflows({ domain: 'gone' }, domains), []);
    assert.deepEqual(panelWorkflows({ workflow: 'z' }, domains), [{ name: 'z', label: 'Z' }]);
    assert.deepEqual(panelWorkflows({ workflow: 'hidden' }, domains), [{ name: 'hidden', label: 'hidden' }]);
  });

  it('foldPoint: open from after the last question answered; a just-answered question stays open while nothing follows it', () => {
    const n = id => ({ id, messageType: 'HUMAN_NOTIFICATION', payload: {} });
    const g = (id, gid) => ({ id, messageType: 'HUMAN_GATE', payload: { dialog: { gate_id: gid } } });
    assert.equal(foldPoint([n(1), g(2, 'a'), n(3), g(4, 'b')], 'b'), 2, 'waiting: since the last answer, and the question');
    assert.equal(foldPoint([g(1, 'a'), g(2, 'b')], 'b'), 1);
    assert.equal(foldPoint([g(1, 'a'), n(2)], null), 1, 'finished: the report after the last answer');
    assert.equal(foldPoint([n(1), g(2, 'a')], null), 1, 'just answered: the answered question stays open');
    assert.equal(foldPoint([n(1), n(2)], null), 0, 'no questions: nothing folds');
    assert.equal(foldPoint([g(1, 'b')], 'b'), 0);
  });

  it('a newer build is live when index.html names another script than this tab runs', () => {
    const html = '<script type="module" src="/assets/app-ABC123.js"></script>';
    assert.equal(liveScript(html), '/assets/app-ABC123.js');
    assert.equal(isNewBuild(html, '/assets/app-OLD999.js'), true);
    assert.equal(isNewBuild(html, '/assets/app-ABC123.js'), false);
    assert.equal(isNewBuild('<html>maintenance</html>', '/assets/app-OLD999.js'), false, 'a page that names no build says nothing');
    assert.equal(isNewBuild(html, 'data:text/javascript;base64,xx'), false, 'a tab that cannot name its own build says nothing');
  });

  it('addMessages: each once, in the order sent', () => {
    assert.deepEqual(addMessages([{ id: 1 }, { id: 3 }], [{ id: 3 }, { id: 2 }, { id: 4 }]).map(m => m.id), [1, 2, 3, 4]);
  });

  it('a run is going until it finishes; it works only while pending or running', () => {
    for (const s of ['pending', 'running', 'awaiting_human_gate', 'awaiting_llm_break']) assert.ok(isActive(s), s);
    for (const s of ['completed', 'failed', 'cancelled']) assert.ok(!isActive(s), s);
    assert.deepEqual(['pending', 'running', 'awaiting_human_gate'].map(isWorking), [true, true, false]);
  });

  it('threadDelay: steady, doubling per failure, to a ceiling', () => {
    assert.deepEqual([0, 1, 2].map(threadDelay), [THREAD_POLL_MS, THREAD_POLL_MS * 2, THREAD_POLL_MS * 4]);
    assert.equal(threadDelay(40), THREAD_POLL_MAX_MS);
  });
});

describe('gates — the answer Slack sends, checked before it is sent (§5)', () => {
  const field = (name, input_type, extra = {}) => ({ type: 'input', name, input_type, label: name.toUpperCase(), optional: false, ...extra });

  it('initialValues: each input\'s initial; a multi-select an array', () => {
    const inputs = [field('a', 'text', { initial: 'x' }), field('b', 'number', { initial: 12.5 }), field('c', 'multi_select', { initial: ['1', 2] }), field('d', 'checkbox'), field('e', 'select')];
    assert.deepEqual(initialValues(inputs), { a: 'x', b: '12.5', c: ['1', '2'], d: [], e: '' });
  });

  it('isChanged: a value moved from where it opened — order of a multi-select aside, whitespace aside', () => {
    const initial = { a: 'x', c: ['1', '2'] };
    assert.equal(isChanged({ name: 'a' }, { a: ' x ' }, initial), false);
    assert.equal(isChanged({ name: 'a' }, { a: 'y' }, initial), true);
    assert.equal(isChanged({ name: 'c' }, { c: ['2', '1'] }, initial), false);
    assert.equal(isChanged({ name: 'c' }, { c: ['1'] }, initial), true);
  });

  it('fieldProblems: a required field empty, a number the shared rule refuses; an optional field may be empty', () => {
    const inputs = [field('amount', 'number', { decimal: true, min: 0 }), field('count', 'number', { decimal: false }), field('note', 'text', { optional: true }), field('tags', 'multi_select')];
    assert.deepEqual(fieldProblems(inputs, { amount: '12,50', count: '3', note: '', tags: ['a'] }), []);
    assert.deepEqual(fieldProblems(inputs, { amount: '-1', count: '2.5', note: '', tags: [] }), [
      { name: 'amount', problem: 'must be at least 0' }, { name: 'count', problem: 'must be a whole number' }, { name: 'tags', problem: 'is required' },
    ]);
    assert.deepEqual(fieldProblems([field('x', 'number')], { x: 'twelve' }), [{ name: 'x', problem: 'must be a number' }]);
  });

  it('formValues: every field, as Slack sends it — empty null, none null, multi an array, a date-time epoch seconds', () => {
    const inputs = [field('a', 'text'), field('b', 'select'), field('c', 'multi_select'), field('d', 'date'), field('e', 'datetime'), field('f', 'number')];
    assert.deepEqual(formValues(inputs, { a: '  ', b: '', c: ['x', ''], d: '2026-11-17', e: '2026-11-17T10:00:00Z', f: ' 12,5 ' }),
      { a: null, b: null, c: ['x'], d: '2026-11-17', e: String(Date.parse('2026-11-17T10:00:00Z') / 1000), f: '12,5' });
  });

  it('answerFor: each gate type\'s answer (§5.2)', () => {
    const inputs = [field('a', 'text')];
    assert.deepEqual(answerFor('confirm', 'confirm'), { action: 'confirm' });
    assert.deepEqual(answerFor('choice', 'b'), { action: 'b' });
    assert.deepEqual(answerFor('text_input', 'submit', { inputValue: '  hello ' }), { action: 'submit', inputValue: 'hello' });
    assert.deepEqual(answerFor('text_input', 'cancel', { inputValue: '' }), { action: 'cancel' });
    assert.deepEqual(answerFor('form', 'save', { inputs, values: { a: 'x' } }), { action: 'save', formValues: { a: 'x' } });
    assert.deepEqual(answerFor('list_selection', 'open', { row: { id: 7, responseData: { table: 'PGD_Things' } } }), { action: 'open', inputValue: '7', listGroup: 'PGD_Things' });
    assert.deepEqual(answerFor('list_selection', 'open', { row: { id: 'x' } }), { action: 'open', inputValue: 'x', listGroup: '' });
    assert.deepEqual(answerFor('review_object', 'add_note', { inputValue: 'from a modal' }), { action: 'add_note', inputValue: 'from a modal' });
  });

  it('gridOf: a grid only when every input names row and column; rows and columns as they first appear', () => {
    const cell = (row, column, label, group) => field(`${row}_${column}`, 'number', { row, column, label, ...(group ? { group } : {}) });
    const grid = gridOf([cell('1', 'Amount', 'Food', 'Monthly'), cell('1', 'Note', 'Food', 'Monthly'), cell('2', 'Amount', 'Rent', 'Monthly'), cell('3', 'Amount', 'Gifts', 'Annual')]);
    assert.deepEqual(grid.columns, ['Amount', 'Note']);
    assert.deepEqual(grid.rows.map(r => [r.key, r.label, r.group, Object.keys(r.cells)]), [
      ['1', 'Food', 'Monthly', ['Amount', 'Note']], ['2', 'Rent', 'Monthly', ['Amount']], ['3', 'Gifts', 'Annual', ['Amount']],
    ]);
    assert.equal(gridOf([cell('1', 'Amount', 'Food'), field('x', 'text')]), null, 'one field without the hints — a stacked form');
    assert.equal(gridOf([]), null);
  });

  it('gridSections: each run of rows under one group, rows keeping their index in the whole grid', () => {
    const row = (key, group) => ({ key, label: key, group, cells: {} });
    const sections = gridSections({ rows: [row('a', null), row('b', 'Income'), row('c', 'Income'), row('d', 'Fixed'), row('e', 'Income')] });
    assert.deepEqual(sections.map(s => [s.group, s.rows.map(x => `${x.row.key}${x.r}`)]), [
      [null, ['a0']], ['Income', ['b1', 'c2']], ['Fixed', ['d3']], ['Income', ['e4']],
    ]);
  });

  it('moveCell: Enter and arrows move, stopping at the edges', () => {
    const size = { rows: 3, columns: 2 };
    assert.deepEqual(moveCell({ r: 0, c: 0 }, 'Enter', size), { r: 1, c: 0 });
    assert.deepEqual(moveCell({ r: 2, c: 1 }, 'ArrowDown', size), { r: 2, c: 1 });
    assert.deepEqual(moveCell({ r: 1, c: 0 }, 'ArrowLeft', size), { r: 1, c: 0 });
    assert.deepEqual(moveCell({ r: 1, c: 0 }, 'ArrowRight', size), { r: 1, c: 1 });
    assert.deepEqual(moveCell({ r: 1, c: 1 }, 'Tab', size), { r: 1, c: 1 });
  });

  it('listColumns: every key across the items, in first-appearance order, headed as Slack heads it', () => {
    assert.deepEqual(listColumns([{ fields: { unit_price: 1 } }, { fields: { deck_id: 'Basics', unit_price: 3 } }, {}]),
      [{ key: 'unit_price', label: 'Unit Price' }, { key: 'deck_id', label: 'Deck Name' }]);
  });

  it('revealContent: an array of records is a table, as Slack draws it (run 1042)', () => {
    const items = [{ unit: 'each', name_en: 'Monitor Stand', line_total: 19.99 }, { unit: 'each', name_en: 'Drops', line_total: 9.99 }];
    assert.deepEqual(revealContent(items), { kind: 'table', records: items });
  });

  it('revealContent: single syntax/verb/command records and plain values are a list of lines', () => {
    assert.deepEqual(revealContent([{ syntax: 'list <x>' }, { verb: 'add' }]), { kind: 'list', items: ['list <x>', 'add'] });
    assert.deepEqual(revealContent(['a', 2]), { kind: 'list', items: ['a', '2'] });
    assert.deepEqual(revealContent([]), { kind: 'list', items: [] });
  });

  it('revealContent: anything else is markdown', () => {
    assert.deepEqual(revealContent('| A |\n|---|\n| 1 |'), { kind: 'text', text: '| A |\n|---|\n| 1 |' });
    assert.deepEqual(revealContent(null), { kind: 'text', text: '' });
  });

  it('inputsOf: a form\'s inputs only', () => {
    assert.deepEqual(inputsOf({ fields: [{ type: 'typography' }, field('a', 'text'), { type: 'actions', buttons: [] }] }).map(f => f.name), ['a']);
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
                   export { RecordsBody, RecordDetail } from './panels/RecordsPanel.jsx';
                   export { Drawer } from './shell/Drawer.jsx';
                   export { Markdown } from './Markdown.jsx';
                   export { WorkflowList } from './panels/WorkflowPanel.jsx';
                   export { ThreadView } from './runs/RunThread.jsx';
                   export { SessionList, ConversationView, Composer } from './minds-eye/Region.jsx';
                   export { Gate, AnsweredRecord } from './gates/Gate.jsx';
                   export { ReportBody } from './panels/ReportPanel.jsx';
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
      { runId: 12, workflowName: 'tidy_up', workflowLabel: 'Tidy up', label: 'Spare room', provider: 'slack', waitingSince: '2026-11-17T09:00:00Z',
        dialog: { fields: [{ type: 'typography', value: '**Keep** the lamp?\nIt has not moved in a year.' }] } },
      { runId: 13, workflowName: 'unlisted_flow', workflowLabel: 'Unlisted flow', labelFallback: true, label: null, provider: 'web', waitingSince: '2026-11-16T10:00:00Z', dialog: { fields: [] } },
    ];
    const html = ui.renderToString(ui.createElement(ui.WaitingList, {
      gates, path: '/p/money', now: Date.parse('2026-11-17T12:00:00Z'), onPick() {},
    }));
    assert.match(html.replace(/<!-- -->/g, ''), /<a href="\/p\/money\?run=12"><span class="q">Keep the lamp\?<\/span><span class="sub">Tidy up · Spare room · <time dateTime="2026-11-17T09:00:00Z">3 hours ago<\/time> · #12<\/span><span class="pill slack">Slack<\/span><\/a>/);
    assert.match(html.replace(/<!-- -->/g, ''), /<a href="\/p\/money\?run=13"><span class="q">Unlisted flow<\/span><span class="sub">Unlisted flow · <time[^>]*>yesterday<\/time> · #13<\/span><\/a>/);
  });

  it('the waiting list, empty', () => {
    const html = ui.renderToString(ui.createElement(ui.WaitingList, { gates: [], path: '/', now: 0, onPick() {} }));
    assert.match(html, /Nothing is waiting for you\./);
  });

  it('a household page draws its panels in their widths; records and workflow panels load, a summary is its frame', () => {
    const domains = [{ domain: 'pantry', label: 'Pantry', workflows: [{ name: 'restock', label: 'Restock' }, { name: 'count_up', label: 'Count up' }] }];
    const pages = [{ pageKey: 'home', title: 'Home', position: 0, panels: [
      { id: 'r', kind: 'records', width: 'full', title: { en: 'Things', es: 'Cosas' }, config: { source: 'PGD_Things' } },
      { id: 'w', kind: 'workflow', width: '1/2', title: 'Flows', config: { domain: 'pantry' } },
      { id: 's', kind: 'summary', width: '1/3', title: 'Report', config: { widget: 'report', workflow: 'restock' } },
      { id: 'c', kind: 'summary', width: '1/3', title: 'Chart', config: { widget: 'chart', source: 'PGD_Things', category_column: 'a', value_columns: ['b'] } },
    ] }];
    const html = draw('/', { pages, domains });
    assert.match(html, /<div class="panels"><section class="panel w-full" aria-label="Things"><div class="phead"><h2>Things<\/h2><\/div><div class="skeleton" aria-busy="true"/);
    assert.match(html, /<section class="panel w-half" aria-label="Flows"><div class="phead"><h2>Flows<\/h2><\/div><div class="btnrow"><button type="button" class="btn">Restock<\/button><button type="button" class="btn">Count up<\/button><\/div><div class="skeleton"/);
    assert.match(html, /<section class="panel w-third" aria-label="Report"><div class="phead"><h2>Report<\/h2><button type="button" class="btn sm" aria-label="Refresh by running the workflow again">↻ Refresh<\/button><\/div><div class="skeleton"/);
    assert.match(html, /<section class="panel w-third" aria-label="Chart"><div class="phead"><h2>Chart<\/h2><\/div><\/section>/, 'a chart is Phase 1: its frame');
  });

  it('a domain page draws its workflow panel; a run page its thread', () => {
    const domains = [{ domain: 'pantry', label: 'Pantry', workflows: [{ name: 'restock', label: 'Restock' }] }];
    assert.match(draw('/d/pantry', { domains }), /<h1>Pantry<\/h1><\/div><div class="panels"><section class="panel w-full" aria-label="Workflows"><div class="phead"><h2>Workflows<\/h2><\/div><div class="btnrow"><button type="button" class="btn primary">Restock<\/button>/);
    assert.match(draw('/runs/42'), /<h1>Run 42<\/h1><\/div><div class="panel w-full"><p class="muted">Loading…<\/p><\/div>/);
    assert.match(draw('/p/money?run=42'), /aria-label="Run 42"><div class="dh">.*<a href="\/runs\/42">Open as a page<\/a>.*Loading…/);
  });

  const WHERE = { language: 'en', locale: 'en', timeZone: 'Europe/Madrid', now: Date.parse('2026-11-17T12:00:00Z') };

  it('the workflow list: Start per workflow, runs by name with their state and age', () => {
    const runs = [
      { runId: 9, label: 'November', status: 'awaiting_human_gate', startedAt: '2026-11-17T10:00:00Z' },
      { runId: 8, label: null, workflowLabel: { en: 'Edit budget' }, workflowName: 'edit_budget', status: 'failed', startedAt: '2026-11-01T10:00:00Z' },
      { runId: 7, label: 'October', status: 'completed', startedAt: '2026-11-03T10:00:00Z' },
    ];
    const html = ui.renderToString(ui.createElement(ui.WorkflowList, {
      workflows: [{ name: 'edit_budget', label: 'Edit budget' }], runs, where: WHERE, onStart() {}, onOpen() {}, problem: null, starting: false,
    })).replace(/<!-- -->/g, '');
    assert.match(html, /<button type="button" class="btn primary">Edit budget<\/button>/);
    assert.match(html, /<span class="lbl">November<\/span><span class="pill wait">Needs you<\/span><span class="when"><time dateTime="2026-11-17T10:00:00Z">2 hours ago<\/time> · #9<\/span>/);
    assert.match(html, /<span class="lbl">Edit budget · Nov 1<\/span><span class="pill bad">Failed<\/span>/);
    assert.match(html, /<span class="lbl">October<\/span><span class="when">/, 'a finished run says nothing of its state');
  });

  it('the workflow list, empty: one workflow named, or the domain\'s', () => {
    const list = workflows => ui.renderToString(ui.createElement(ui.WorkflowList, { workflows, runs: [], where: WHERE, onStart() {}, onOpen() {}, problem: null, starting: true }));
    assert.match(list([{ name: 'a', label: 'Restock' }]), /You don(’|&#x27;)t have any Restock runs yet — they will be shown here\./);
    assert.match(list([{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }]), /You don(’|&#x27;)t have any runs yet/);
    assert.match(list([{ name: 'a', label: 'A' }]), /<button type="button" class="btn primary" disabled="">A<\/button>/, 'Start waits while a start is sent');
  });

  const message = (id, messageType, payload) => ({ id, messageType, payload });
  const thread  = props => ui.renderToString(ui.createElement(ui.ThreadView, { run: null, messages: [], problem: null, ...props })).replace(/<!-- -->/g, '');

  it('the thread: notifications as markdown or plain text, a failure by its summary, reveals folded', () => {
    const html = thread({ run: { status: 'failed' }, messages: [
      message(2, 'HUMAN_NOTIFICATION', { format: 'markdown', message: '## Done\n\n**3** saved', reveals: [{ button_label: 'Details', content: '| a |\n|---|\n| 1 |' }] }),
      message(1, 'HUMAN_NOTIFICATION', { message: 'Line one\nLine *two*' }),
      message(3, 'WORKFLOW_ERROR', { summary: 'Step 4 failed: the table is missing.' }),
    ] });
    assert.match(html, /<div class="msg"><div class="md"><h4>Done<\/h4><p><strong>3<\/strong> saved<\/p><\/div><details class="reveal"><summary>Details<\/summary>/);
    assert.match(html, /<p class="plain">Line one\nLine \*two\*<\/p>/);
    assert.match(html, /<div class="msg error" role="alert">Step 4 failed: the table is missing\.<\/div>/);
    assert.doesNotMatch(html, /Working…/);
  });

  it('the thread: the question the run waits at is marked; Working… while it works', () => {
    const gate = id => message(id, 'HUMAN_GATE', { dialog: { gate_id: `g-${id}`, title: 'internal step note', fields: [{ type: 'typography', value: `Question ${id}` }, { type: 'button', value: 'x' }] } });
    const waiting = thread({ run: { status: 'awaiting_human_gate' }, messages: [gate(1), gate(2)] });
    assert.match(waiting, /<div class="thread"><button type="button" class="fold">Show 1 earlier message<\/button><div><div class="msg gate waiting"><div class="md"><p>Question 2<\/p><\/div><p class="hint">Waiting for your answer\.<\/p>/);
    assert.doesNotMatch(waiting, /Question 1/, 'the answered question folds away');
    assert.doesNotMatch(waiting, /internal step note/);
    assert.match(thread({ run: { status: 'running' }, messages: [gate(1)] }), /<div class="msg gate">.*<p class="working" role="status">Working…<\/p>/);
    assert.doesNotMatch(thread({ run: { status: 'completed' }, messages: [gate(1)] }), /waiting|Working/);
  });

  it('the thread: loading, a run that can\'t be shown, one that sent nothing, and the backend unreachable', () => {
    assert.match(thread({}), /Loading…/);
    assert.match(thread({ problem: 'gone' }), /This run can(’|&#x27;)t be shown\./);
    assert.match(thread({ run: { status: 'completed' } }), /No messages were kept for this run\./);
    assert.match(thread({ run: { status: 'running' }, problem: 'unreachable' }), /Working….*Can(’|&#x27;)t reach the home brain — retrying/);
  });

  it('a report: the latest output as markdown, when and from which run; or not run yet, or gone', () => {
    const where  = { locale: 'en', timeZone: 'Europe/Madrid' };
    const report = output => ui.renderToString(ui.createElement(ui.ReportBody, { output, where })).replace(/<!-- -->/g, '');
    const html = report({ status: 'ready', body: { runId: 1041, label: 'November 2026', completedAt: '2026-11-17T10:44:20Z',
      payload: { format: 'markdown', message: '## Budget\n\n| Category | Actual |\n|---|--:|\n| Rent | €900 |' } } });
    assert.match(html, /<div class="pbody report"><div class="md"><h4>Budget<\/h4><div class="mdtable">/);
    assert.match(html.replace(/\s/g, ' '), /<p class="pfoot">Updated Nov 17, 2026, 11:44 AM · November 2026 · #1041<\/p>/);
    assert.match(report({ status: 'ready', body: { runId: 7, label: null, completedAt: null, payload: { message: 'Plain *text*' } } }), /<p class="plain">Plain \*text\*<\/p><\/div><p class="pfoot">#7<\/p>/);
    assert.match(report({ status: 'none' }), /Not run yet/);
    assert.match(report({ status: 'missing', workflow: 'gone_flow' }), /“gone_flow” can(’|&#x27;)t be found\./);
  });

  it('a Home with no panels says how to go on', () => {
    assert.match(draw('/'), /Your home page is empty — open a domain from the menu\./);
    assert.doesNotMatch(draw('/p/money'), /home page is empty/);
  });

  const BODY = {
    columns: [
      { name: 'id', type: 'serial', label: 'Id' }, { name: 'title', type: 'varchar', label: 'Title' },
      { name: 'amount', type: 'numeric', label: 'Amount' }, { name: 'currency', type: 'varchar', label: 'Currency' },
    ],
    rows: [{ id: 1, title: 'Shop A', amount: '62.4', currency: 'EUR' }, { id: 2, title: 'Shop B', amount: '18.9', currency: 'EUR' }],
    more: true, totalMatching: 1228,
  };
  const CONFIG = { source: 'PGD_Things', columns: ['title', { name: 'amount', format: 'currency', currency_column: 'currency' }] };
  const body   = (view, extra = {}, selected = null) => ui.renderToString(ui.createElement(ui.RecordsBody, {
    config: CONFIG, body: { ...BODY, ...extra }, view, where: { locale: 'en', timeZone: 'Europe/Madrid' }, onOpen() {}, selected,
  }));

  it('grid: the panel\'s columns, numbers on the right, a currency from the row; a bounded read says so', () => {
    const html = body('grid');
    assert.match(html, /<thead><tr><th scope="col">Title<\/th><th scope="col" class="num">Amount<\/th><\/tr><\/thead>/);
    assert.match(html, /<tr tabindex="0"><td>Shop A<\/td><td class="num">€62.40<\/td><\/tr>/);
    assert.doesNotMatch(html, /Currency|EUR/);
    assert.match(html, /<p class="pfoot">Showing 2 of 1,228<\/p>/);
    assert.doesNotMatch(body('grid', { more: false }), /Showing/);
  });

  it('list: the label column, then the details, each row a button', () => {
    const html = body('list');
    assert.match(html, /<li><button type="button"><span class="rt">Shop A<\/span><span class="rd">€62.40<\/span><\/button><\/li>/);
  });

  it('a long read scrolls inside the panel; the row the drawer shows is marked in either view', () => {
    assert.match(body('grid'), /<div class="tablewrap pbody"><table class="grid">/);
    assert.match(body('list'), /<ul class="rlist pbody">/);
    assert.match(body('grid', {}, BODY.rows[1]), /<tr tabindex="0" aria-selected="true"><td>Shop B<\/td>/);
    assert.equal((body('grid', {}, BODY.rows[1]).match(/aria-selected/g) ?? []).length, 1);
    assert.match(body('list', {}, BODY.rows[0]), /<button type="button" aria-current="true"><span class="rt">Shop A/);
  });

  it('a drawer beside the page has no scrim and does not hold the page; the others do', () => {
    const drawer = props => ui.renderToString(ui.createElement(ui.Drawer, { title: 'Shop A', onClose() {}, ...props }));
    assert.match(drawer({ beside: true }), /^<div class="drawer beside" role="dialog" aria-modal="false" aria-label="Shop A">/);
    assert.match(drawer({}), /^<div class="scrim"><div class="drawer" role="dialog" aria-modal="true"/);
  });

  it('a source with no rows says Nothing here yet', () => {
    assert.match(body('grid', { rows: [], more: false }), /Nothing here yet/);
  });

  it('a record\'s detail: every column read, labelled and formatted', () => {
    const html = ui.renderToString(ui.createElement(ui.RecordDetail, {
      columns: BODY.columns.map(c => (c.name === 'amount' ? { ...c, format: 'currency', currency_column: 'currency' } : c)),
      row: BODY.rows[0], where: { locale: 'en', timeZone: 'Europe/Madrid' },
    }));
    assert.match(html, /<dt>Id<\/dt><dd>1<\/dd>.*<dt>Title<\/dt><dd>Shop A<\/dd>.*<dt>Amount<\/dt><dd>€62.40<\/dd>.*<dt>Currency<\/dt><dd>EUR<\/dd>/);
  });

  describe('Markdown — /proc\'s markdown as elements, never as HTML (§11)', () => {
    const md = text => ui.renderToString(ui.createElement(ui.Markdown, { text }));

    it('raw HTML is shown as text; nothing is inserted', () => {
      const html = md('Hi <b>there</b>\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
      assert.doesNotMatch(html, /<script|<img|<b>/);
      assert.match(html.replace(/<!-- -->/g, ''), /Hi &lt;b&gt;there&lt;\/b&gt;/);
      assert.match(html, /<p>&lt;script&gt;alert\(1\)&lt;\/script&gt;\n?<\/p>/);
    });

    it('an image is its description, never fetched', () => {
      const html = md('Look ![the receipt](https://example.test/r.png?leak=1)');
      assert.doesNotMatch(html, /<img|example\.test/);
      assert.match(html, /<span>the receipt<\/span>/);
    });

    it('links only to http, https and mailto, in a new tab with noopener noreferrer', () => {
      const html = md('[ok](https://a.example) [mail](mailto:x@a.example) [bad](javascript:alert(1)) [data](data:text/html,x)');
      assert.match(html, /<a href="https:\/\/a.example" target="_blank" rel="noopener noreferrer">ok<\/a>/);
      assert.match(html, /<a href="mailto:x@a.example" target="_blank" rel="noopener noreferrer">mail<\/a>/);
      assert.doesNotMatch(html, /javascript:|data:text/);
      assert.match(html, /<span>bad<\/span>.*<span>data<\/span>/);
    });

    it('a table with its alignment as classes; lists, tasks, headings, emphasis and code', () => {
      const html = md('## Month\n\n| Category | Spent |\n|---|--:|\n| Food | 12,40 € |\n\n- [x] **done** & dusted\n- `code`\n\n3. third\n4. fourth');
      assert.match(html, /<h4>Month<\/h4>/);
      assert.match(html, /<div class="mdtable"><table><thead><tr><th>Category<\/th><th class="al-right">Spent<\/th><\/tr><\/thead><tbody><tr><td>Food<\/td><td class="al-right">12,40 €<\/td><\/tr><\/tbody><\/table><\/div>/);
      assert.match(html, /<li><span aria-hidden="true">☑ <\/span><strong>done<\/strong> &amp; dusted<\/li>/);
      assert.match(html, /<li><code>code<\/code><\/li>/);
      assert.match(html, /<ol start="3"><li>third<\/li><li>fourth<\/li><\/ol>/);
      assert.doesNotMatch(html, /style=/);
    });
  });

  describe('the gate, drawn by its type', () => {
    const CONTEXT = { api: { post: () => new Promise(() => {}) }, onSignInRequired() {} };
    const gateOf  = (gate_type, fields) => ({ runId: 5, gateId: 'g-1', gate_type, dialog: { fields: [{ type: 'typography', value: '**Pick** one' }, ...fields] } });
    const actions = (...buttons) => ({ type: 'actions', buttons });
    const draw    = gate => ui.renderToString(ui.createElement(ui.Gate, { gate, context: CONTEXT, onAnswered() {}, onMoved() {} })).replace(/<!-- -->/g, '');

    it('confirm: the message and its buttons, styles kept', () => {
      const html = draw(gateOf('confirm', [actions({ action: 'confirm', label: 'Save', style: 'primary' }, { action: 'delete', label: 'Delete', style: 'danger' }, { action: 'cancel', label: 'Cancel', style: 'default' })]));
      assert.match(html, /<div class="msg gate waiting" aria-busy="false"><div class="md"><p><strong>Pick<\/strong> one<\/p><\/div>/);
      assert.match(html, /<button type="button" class="btn primary">Save<\/button><button type="button" class="btn danger">Delete<\/button><button type="button" class="btn ">Cancel<\/button>/);
    });

    it('choice: one radio per described option and Continue, waiting for a pick; other buttons stay buttons', () => {
      const html = draw(gateOf('choice', [
        { type: 'description_list', items: [{ value: 'a', label: 'A', description: 'The first' }, { value: 'b', label: 'B', description: '' }] },
        actions({ action: 'a', label: 'A' }, { action: 'b', label: 'B' }, { action: 'cancel', label: 'Cancel' }),
      ]));
      assert.match(html, /<input type="radio" name="choice-g-1" value="a"\/><span><b>A<\/b><span class="desc">The first<\/span><\/span>/);
      assert.match(html, /<button type="button" class="btn primary" disabled="">Continue<\/button><button type="button" class="btn ">Cancel<\/button><\/div>/);
      assert.doesNotMatch(html, />A<\/button>/);
    });

    it('text_input: its box, then the buttons', () => {
      const html = draw(gateOf('text_input', [{ type: 'textbox', name: 'user_input', label: 'Your note', multiline: true, placeholder: 'Type…' }, actions({ action: 'submit', label: 'Send' })]));
      assert.match(html, /<label class="fld"><span>Your note<\/span><textarea placeholder="Type…" rows="4"><\/textarea><\/label>/);
    });

    it('review_object: a key/value table, an array of records nested as a table', () => {
      const html = draw(gateOf('review_object', [{ type: 'review_object', items: [{ key: 'name', value: 'Lamp' }, { key: 'parts', value: [{ part: 'shade', qty: 1 }] }, { key: 'tags', value: ['a', 'b'] }] }, actions({ action: 'confirm', label: 'OK' })]));
      assert.match(html, /<tr><th scope="row">name<\/th><td>Lamp<\/td><\/tr>/);
      assert.match(html, /<table class="kv nested"><thead><tr><th>Part<\/th><th>Qty<\/th><\/tr><\/thead><tbody><tr><td>shade<\/td><td>1<\/td><\/tr>/);
      assert.match(html, /<ul class="plainlist"><li>a<\/li><li>b<\/li><\/ul>/);
    });

    it('reveal: an array of records is a table headed as Slack heads it, never JSON (run 1042)', () => {
      const html = draw(gateOf('confirm', [{ type: 'reveal', button_label: 'View items (1)', content: [{ name_en: 'Monitor Stand', unit_price: 19.99 }] }, actions({ action: 'confirm', label: 'OK' })]));
      assert.match(html, /<details class="reveal"><summary>View items \(1\)<\/summary><div class="tablewrap"><table class="kv nested"><thead><tr><th>Name En<\/th><th>Unit Price<\/th><\/tr><\/thead><tbody><tr><td>Monitor Stand<\/td><td>19.99<\/td><\/tr>/);
      assert.doesNotMatch(html, /\{&quot;/);
    });

    it('a table wider than its pane scrolls sideways inside it', () => {
      assert.match(readFileSync(join(APP_DIR, 'styles.css'), 'utf8'), /^\.tablewrap \{[^}]*overflow-x: auto;/m);
    });

    it('list_selection: a table, each row\'s own action button in place of typing its id', () => {
      const html = draw(gateOf('list_selection', [
        { type: 'list', name: 'rows', parentHeading: 'Things', items: [
          { id: 7, fields: { Name: 'Lamp', Qty: 2 }, secondaryAction: { action: 'open', label: 'Open Lamp' } },
          { id: 8, fields: { Name: 'Rug' }, secondaryAction: null },
        ] },
        actions({ action: 'done', label: 'Done' }),
      ]));
      assert.match(html, /<h4>Things<\/h4>.*<thead><tr><th scope="col">Name<\/th><th scope="col">Qty<\/th><th aria-label="Actions"><\/th><\/tr><\/thead>/);
      assert.match(html, /<tr><td>Lamp<\/td><td>2<\/td><td class="act"><button type="button" class="btn sm ">Open Lamp<\/button><\/td><\/tr><tr><td>Rug<\/td><td><\/td><td class="act"><\/td><\/tr>/);
    });

    it('form: labelled typed controls, optional marked, a select with none', () => {
      const html = draw(gateOf('form', [
        { type: 'input', name: 'amount', input_type: 'number', label: 'Amount', optional: false, initial: 12.5 },
        { type: 'input', name: 'kind', input_type: 'select', label: 'Kind', optional: true, options: [{ value: 'a', label: 'A' }] },
        { type: 'input', name: 'on', input_type: 'date', label: 'On', optional: false },
        actions({ action: 'save', label: 'Save', style: 'primary' }),
      ]));
      assert.match(html, /<label for="f-amount" class="flabel">Amount<\/label><input id="f-amount" type="text" inputMode="decimal" name="amount" value="12.5"\/>/);
      assert.match(html, /<label for="f-kind" class="flabel">Kind<i> \(optional\)<\/i><\/label><select id="f-kind" name="kind"><option value="" selected="">—<\/option><option value="a">A<\/option><\/select>/);
      assert.match(html, /<input id="f-on" type="date" name="on" value=""\/>/);
    });

    it('form with grid hints: each group a subheading over its own table — row headers, a blank where a row has no cell', () => {
      const cell = (row, column, label, group, initial) => ({ type: 'input', name: `${row}_${column}`, input_type: 'number', label, optional: false, row, column, group, initial });
      const html = draw(gateOf('form', [cell('1', 'Amount', 'Food', 'Monthly', 400), cell('1', 'Limit', 'Food', 'Monthly', 500), cell('2', 'Amount', 'Gifts', 'Annual', 300), actions({ action: 'save', label: 'Save' })]));
      assert.match(html, /<div class="grids"><section><h4 class="gridgroup">Monthly<\/h4><div class="tablewrap"><table class="grid edit"><thead><tr><th scope="col" aria-hidden="true"><\/th><th scope="col">Amount<\/th><th scope="col">Limit<\/th><\/tr><\/thead>/);
      assert.match(html, /<tbody><tr><th scope="row">Food<\/th><td><input id="f-1_Amount" aria-label="Food — Amount" data-cell="0:0" type="text" inputMode="decimal" class="cell num" name="1_Amount" value="400"\/><\/td>/);
      assert.match(html, /<section><h4 class="gridgroup">Annual<\/h4>.*<tr><th scope="row">Gifts<\/th><td>.*data-cell="1:0".*<\/td><td><\/td><\/tr>/);
      assert.equal((html.match(/<table class="grid edit">/g) ?? []).length, 2);
    });

    it('a button that opens a modal on Slack waits for its text in place', () => {
      const html = draw(gateOf('review_object', [actions({ action: 'revise', label: 'Revise', modal: { title: 'Revise', input_label: 'What to change' } })]));
      assert.match(html, /<button type="button" class="btn ">Revise<\/button>/);
    });

    it('followup_prompt: its message and Ask follow-up — the dialog\'s own buttons are not drawn, as Slack draws none', () => {
      const html = draw(gateOf('followup_prompt', [actions({ action: 'confirm', label: 'Confirm' })]));
      assert.match(html, /<button type="button" class="btn primary">Ask follow-up<\/button><\/div>/);
      assert.doesNotMatch(html, />Confirm</);
    });

    it('the thread names the run\'s workflow and its id', () => {
      const html = ui.renderToString(ui.createElement(ui.ThreadView, {
        run: { runId: 958, workflowName: 'ping_core', workflowLabel: null, status: 'completed' }, messages: [], problem: null,
      })).replace(/<!-- -->/g, '');
      assert.match(html, /<p class="runmeta">ping_core · Run 958<\/p>/);
      const labelled = ui.renderToString(ui.createElement(ui.ThreadView, {
        run: { runId: 1041, workflowName: 'x', workflowLabel: { en: 'Edit budget' }, status: 'completed' }, messages: [], problem: null,
      })).replace(/<!-- -->/g, '');
      assert.match(labelled, /Edit budget · Run 1041/);
    });

    it('an answer given here is one line', () => {
      const html = ui.renderToString(ui.createElement(ui.AnsweredRecord, { record: { label: 'Save', changes: 3 } })).replace(/<!-- -->/g, '');
      assert.equal(html, '<p class="answered">You chose Save · 3 changes</p>');
    });

    it('the thread puts the live question where its copy was sent, and a question answered here as its record', () => {
      const sent = (id, gid, text) => ({ id, messageType: 'HUMAN_GATE', payload: { dialog: { gate_id: gid, fields: [{ type: 'typography', value: text }] } } });
      const live = gateOf('confirm', [actions({ action: 'ok', label: 'OK' })]);
      const html = ui.renderToString(ui.createElement(ui.ThreadView, {
        run: { status: 'awaiting_human_gate' }, messages: [sent(1, 'g-0', 'First'), sent(2, 'g-1', 'Second (as sent)')], gate: live,
        answered: { 'g-0': { label: 'Yes', changes: 0 } }, problem: null, context: CONTEXT, onAnswered() {}, onMoved() {},
      })).replace(/<!-- -->/g, '');
      assert.match(html, /^<div class="thread"><button type="button" class="fold">Show 1 earlier message<\/button><div><div class="msg gate waiting"/);
      assert.doesNotMatch(html, /First|Second \(as sent\)/);
      const after = ui.renderToString(ui.createElement(ui.ThreadView, {
        run: { status: 'running' }, messages: [sent(1, 'g-0', 'First')], answered: { 'g-0': { label: 'Yes', changes: 0 } }, problem: null, context: CONTEXT,
      })).replace(/<!-- -->/g, '');
      assert.match(after, /<p>First<\/p><\/div><\/div><p class="answered">You chose Yes<\/p><\/div><p class="working" role="status">Working…<\/p>/, 'just answered, nothing since: the answer stays open');
      assert.match(html, /<div class="msg gate waiting" aria-busy="false"><div class="md"><p><strong>Pick<\/strong> one<\/p>.*>OK<\/button>/);
    });

    it('a waiting gate with no copy in the inbox — a scheduled run\'s — is still answered', () => {
      const html = ui.renderToString(ui.createElement(ui.ThreadView, {
        run: { status: 'awaiting_human_gate' }, messages: [], gate: gateOf('confirm', [actions({ action: 'ok', label: 'OK' })]), problem: null, context: CONTEXT, onAnswered() {}, onMoved() {},
      }));
      assert.match(html, /^<div class="thread"><div><div class="msg gate waiting"/);
      assert.doesNotMatch(html, /No messages were kept/);
    });
  });

  it('a refused sign-in says so and offers to sign in again', () => {
    const html = ui.renderToString(ui.createElement(ui.SignInProblem, { onSignIn() {} }));
    assert.match(html, /The sign-in didn(&#x27;|')t complete\./);
    assert.match(html, /<button type="button">Sign in again<\/button>/);
  });

  describe('her region', () => {
    const strip = html => html.replace(/<!-- -->/g, '');
    const NOW   = Date.parse('2026-11-19T12:00:00.000Z');
    const S     = { sessionId: 7, label: null, firstMessage: 'Plan the   garden beds', topic: null, provider: 'web',
      createdAt: '2026-11-19T11:00:00.000Z', lastActiveAt: '2026-11-19T11:58:00.000Z', state: 'waiting', gate: null };
    const person = (seq, text, at) => ({ kind: 'person', seq, text, createdAt: at });
    const her    = (id, payload, at, messageType = 'HUMAN_NOTIFICATION') => ({ kind: 'inbox', id, messageType, payload, createdAt: at });
    const convo  = props => strip(ui.renderToString(ui.createElement(ui.ConversationView, { session: S, messages: [], repliesKeptFrom: '2026-11-19T11:00:05.000Z', problem: null, ...props })));

    it('the list names each session by label, else first message, with its age or Working…', () => {
      const html = strip(ui.renderToString(ui.createElement(ui.SessionList, {
        sessions: [{ ...S, label: 'Garden' }, { ...S, sessionId: 8, state: 'working' }, { ...S, sessionId: 9, firstMessage: null }],
        currentId: 8, problem: false, now: NOW, locale: 'en', onOpen() {},
      })));
      assert.match(html, /<span class="lbl">Garden<\/span><span class="when">2 minutes ago<\/span>/);
      assert.match(html, /aria-current="true"[^>]*><span class="lbl">Plan the garden beds<\/span><span class="when">Working…<\/span>/);
      assert.match(html, /<span class="lbl">New conversation<\/span>/);
    });

    it('an empty list says how to start, and a list not yet read says Loading…', () => {
      assert.match(ui.renderToString(ui.createElement(ui.SessionList, { sessions: [], currentId: null, problem: false, now: NOW, locale: 'en', onOpen() {} })), /No conversations yet/);
      assert.match(ui.renderToString(ui.createElement(ui.SessionList, { sessions: null, currentId: null, problem: false, now: NOW, locale: 'en', onOpen() {} })), /Loading…/);
    });

    it('the person\'s messages and hers, a turn\'s calls on one line', () => {
      const html = convo({ messages: [
        person(1, 'Plan the beds', '2026-11-19T11:00:00.000Z'),
        her(10, { message: '_Turn 1 · `read_a`_ — first', format: 'markdown', turn: 1, call: '`read_a`', detail: 'first' }, '2026-11-19T11:00:02.000Z'),
        her(11, { message: '_Turn 1 · `read_b`_', format: 'markdown', turn: 1, call: '`read_b`' }, '2026-11-19T11:00:03.000Z'),
        her(12, { message: '_Turn 2 · `read_c`_ — then', format: 'markdown', turn: 2, call: '`read_c`', detail: 'then' }, '2026-11-19T11:00:04.000Z'),
        her(13, { message: 'Here is **the plan**.', format: 'markdown', invitesReply: true }, '2026-11-19T11:00:05.000Z'),
      ] });
      assert.match(html, /<div class="msg mine"><p class="plain">Plan the beds<\/p><\/div>/);
      assert.match(html, /<details class="turn"><summary>Turn 1 · 2 calls<\/summary><ul><li><div class="md"><p><code>read_a<\/code> — first<\/p><\/div><\/li><li><div class="md"><p><code>read_b<\/code><\/p>/);
      assert.match(html, /<div class="turn"><div class="md"><p><em>Turn 2 · <code>read_c<\/code><\/em> — then<\/p>/);
      assert.match(html, /<strong>the plan<\/strong>/);
      assert.doesNotMatch(html, /Turn 1 ·.*Turn 1 ·/s);
    });

    it('her questions are drawn under her reply, with their options', () => {
      const html = convo({ messages: [her(13, { message: 'Two things.', format: 'markdown', invitesReply: true,
        questions: [{ id: 'q1', text: 'Raised beds?', options: ['Yes', 'No'] }, { id: 'q2', text: 'How many?' }] }, '2026-11-19T11:00:05.000Z')] });
      assert.match(html, /<ol class="questions"><li><div class="md"><p>Raised beds\?<\/p><\/div><p class="muted">Yes · No<\/p><\/li><li><div class="md"><p>How many\?<\/p>/);
    });

    it('a continue gate says why she paused; the one waiting is marked', () => {
      const gate = her(14, { gate_type: 'minds_eye_continue_gate', atSeq: 6, reason: 'round_budget' }, '2026-11-19T11:05:00.000Z', 'HUMAN_GATE');
      const html = convo({ session: { ...S, gate: { kind: 'continue', atSeq: 6 } }, messages: [gate] });
      assert.match(html, /<div class="msg gate waiting"><p class="plain">I’ve used up this round’s time/);
      assert.match(html, /Waiting for your answer\./);
      assert.match(convo({ messages: [{ ...gate, payload: { gate_type: 'minds_eye_continue_gate', atSeq: 6 } }] }), /I’ve reached my turn limit/);
    });

    it('Working… while she works; the lost-replies notice only on a session older than the inbox', () => {
      assert.match(convo({ session: { ...S, state: 'working' } }), /<p class="working" role="status">Working…<\/p>/);
      assert.doesNotMatch(convo({}), /were not kept/);
      assert.match(convo({ repliesKeptFrom: '2026-11-19T11:30:00.000Z' }), /were not kept/);
    });

    it('a session that is not the person\'s, or gone, says it cannot be shown', () => {
      assert.match(convo({ session: null, problem: 'gone' }), /This conversation can’t be shown\./);
    });

    it('the composer says why nothing can be sent while she works', () => {
      const html = ui.renderToString(ui.createElement(ui.Composer, { blocked: 'Novia is still working — wait for her reply.', onSend: async () => {} }));
      assert.match(html, /Novia is still working/);
      assert.match(html, /<button type="submit" class="btn primary" disabled="">Send<\/button>/);
    });

    describe('answered in place (item 4)', () => {
      const on    = { onGate: async () => {}, onAnswers: async () => {} };
      const ask   = (id, questions, at = '2026-11-19T11:00:05.000Z') => her(id, { message: 'Two things.', format: 'markdown', invitesReply: true, questions }, at);
      const QS    = [{ id: 'q1', text: 'Raised beds?', options: ['Yes', 'No'] }, { id: 'q2', text: 'How many?' },
        { id: 'q3', text: 'Which?', options: Array.from({ length: RADIO_LIMIT + 1 }, (_, i) => `o${i}`) }];

      it('an action gate: its confirm label, the test label when offered, and Cancel', () => {
        const gate = her(20, { gate_type: 'minds_eye_gate', atSeq: 9, confirmLabel: 'Apply', testLabel: 'Apply and test',
          dialog: { fields: [{ type: 'typography', value: '**Change** step 4' }] } }, '2026-11-19T11:05:00.000Z', 'HUMAN_GATE');
        const html = convo({ session: { ...S, gate: { kind: 'action', atSeq: 9 } }, messages: [gate], ...on });
        assert.match(html, /<div class="msg gate waiting"><div class="md"><p><strong>Change<\/strong> step 4<\/p><\/div><div class="btnrow"><button type="button" class="btn primary">Apply<\/button><button type="button" class="btn">Apply and test<\/button><button type="button" class="btn">Cancel<\/button>/);
        const drop = convo({ session: { ...S, gate: { kind: 'action', atSeq: 9 } }, messages: [{ ...gate, payload: { ...gate.payload, confirmLabel: 'Drop', confirmStyle: 'danger', testLabel: undefined } }], ...on });
        assert.match(drop, /<button type="button" class="btn danger">Drop<\/button><button type="button" class="btn">Cancel<\/button><\/div>/);
      });

      it('a continue gate: Continue and End, a follow-up written below', () => {
        const gate = her(21, { gate_type: 'minds_eye_continue_gate', atSeq: 6, reason: 'turn_limit' }, '2026-11-19T11:05:00.000Z', 'HUMAN_GATE');
        const html = convo({ session: { ...S, gate: { kind: 'continue', atSeq: 6 } }, messages: [gate], ...on });
        assert.match(html, /<button type="button" class="btn primary">Continue<\/button><button type="button" class="btn">End<\/button><\/div><p class="hint">Or write a follow-up below\.<\/p>/);
      });

      it('a gate the session has moved past has no buttons', () => {
        const gate = her(21, { gate_type: 'minds_eye_continue_gate', atSeq: 6 }, '2026-11-19T11:05:00.000Z', 'HUMAN_GATE');
        assert.doesNotMatch(convo({ session: { ...S, state: 'working' }, messages: [gate], ...on }), /<button/);
      });

      it('her latest reply\'s questions: choices and a comment, text, a dropdown past ten; Anything else; Send answers', () => {
        const html = convo({ messages: [ask(30, QS)], ...on });
        assert.match(html, /<div class="msg waiting">/);
        assert.match(html, /<span role="radiogroup" aria-labelledby="f-a-q1-l" class="opts"><label><input type="radio" name="a-q1" value="Yes"/);
        assert.match(html, /<label for="f-c-q1" class="flabel">Comment/);
        assert.match(html, /<label for="f-a-q2" class="flabel">Your answer[^<]*<i> \(optional\)<\/i><\/label><textarea id="f-a-q2"/);
        assert.match(html, /<select id="f-a-q3"/);
        assert.doesNotMatch(html, /f-c-q2/);
        assert.match(html, /<label for="f-note" class="flabel">Anything else/);
        assert.match(html, /<button type="button" class="btn primary" disabled="">Send answers<\/button>/);
      });

      it('an older reply\'s questions are only what she asked', () => {
        const html = convo({ messages: [ask(30, QS), her(31, { message: 'Done.', format: 'markdown', invitesReply: true }, '2026-11-19T11:06:00.000Z')], ...on });
        assert.doesNotMatch(html, /<input|<textarea|Send answers/);
        assert.match(html, /<p class="muted">Yes · No<\/p>/);
      });
    });

    it('what the person just sent shows at once, marked Sent, with Working… — before the session is even read', () => {
      const html = convo({ session: null, pending: 'Plan the beds' });
      assert.match(html, /<div class="msg mine pending"><p class="plain">Plan the beds<\/p><p class="sent">Sent<\/p><\/div><p class="working" role="status">Working…<\/p>/);
      const waiting = convo({ messages: [her(13, { message: 'Two?', format: 'markdown', invitesReply: true, questions: [{ id: 'q1', text: 'x' }] }, '2026-11-19T11:00:05.000Z')],
        pending: 'Answers sent.', onGate: async () => {}, onAnswers: async () => {} });
      assert.doesNotMatch(waiting, /Send answers/);
    });

    it('the shell draws her region at the left, headed by her name, with a Novia tab for a phone', () => {
      const html = strip(draw('/p/money?minds-eye=7'));
      assert.match(html, /<div class="body"><aside class="region" aria-label="Novia"><div class="region-head"><h2>Novia<\/h2><button type="button" class="ib" aria-label="Collapse Novia"/);
      assert.match(html, /<nav class="tabbar"[^>]*>.*<button type="button">Novia<\/button><\/nav>/s);
    });
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

describe('her region — the decisions, pure', () => {
  it('sessionName: label, else first message, whitespace folded; null with neither', () => {
    assert.equal(sessionName({ label: ' Garden ', firstMessage: 'x' }), 'Garden');
    assert.equal(sessionName({ label: '', firstMessage: 'Plan\n the  beds' }), 'Plan the beds');
    assert.equal(sessionName({ label: null, firstMessage: null }), null);
  });

  it('addConversation: each message once, keyed by side', () => {
    const p1 = { kind: 'person', seq: 1 }, i1 = { kind: 'inbox', id: 1 }, i2 = { kind: 'inbox', id: 2 };
    assert.deepEqual(addConversation([p1, i1], [i1, i2, { kind: 'person', seq: 1 }]), [p1, i1, i2]);
  });

  it('groupTurns: consecutive lines of one turn together; a line without a turn stays itself', () => {
    const line = (id, turn) => ({ kind: 'inbox', id, messageType: 'HUMAN_NOTIFICATION', payload: { turn, call: `c${id}` } });
    const old  = { kind: 'inbox', id: 9, messageType: 'HUMAN_NOTIFICATION', payload: { message: '_Turn 3 · `x`_' } };
    const items = groupTurns([line(1, 1), line(2, 1), line(3, 2), old, line(4, 2)]);
    assert.deepEqual(items.map(i => (i.kind === 'turn' ? `t${i.turn}:${i.calls.length}` : i.id)), ['t1:2', 't2:1', 9, 't2:1']);
    assert.deepEqual(items[0].calls[1], { call: 'c2', detail: null, id: 2 });
  });

  it('repliesMissing: a first reply long after the session began, or none once it stopped', () => {
    const s = { createdAt: '2026-11-10T10:00:00.000Z', state: 'waiting' };
    assert.equal(repliesMissing(s, '2026-11-10T10:00:30.000Z'), false);
    assert.equal(repliesMissing(s, new Date(Date.parse(s.createdAt) + ROUND_CEILING_MS + 1).toISOString()), true);
    assert.equal(repliesMissing(s, null), true);
    assert.equal(repliesMissing({ ...s, state: 'working' }, null), false);
  });

  it('conversationDelay: by her state, doubling on failure, capped', () => {
    assert.equal(conversationDelay(0, 'working'), WORKING_POLL_MS);
    assert.equal(conversationDelay(0, 'waiting'), WAITING_POLL_MS);
    assert.equal(conversationDelay(1, 'working'), WORKING_POLL_MS * 2);
    assert.equal(conversationDelay(10, 'waiting'), CONVO_MAX_MS);
  });

  it('the collapsed region is remembered on the device, and a storage that throws forgets', () => {
    const store = new MemoryStorage();
    assert.equal(readCollapsed(store), false);
    writeCollapsed(store, true);
    assert.equal(store.getItem(COLLAPSED_KEY), 'true');
    assert.equal(readCollapsed(store), true);
    writeCollapsed(store, false);
    assert.equal(readCollapsed(store), false);
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
    assert.equal(readCollapsed(broken), false);
    assert.doesNotThrow(() => writeCollapsed(broken, true));
  });

  it('answerable: the gate she waits at, or her last reply with questions — nothing while she works', () => {
    const reply = q => ({ kind: 'inbox', id: 5, messageType: 'HUMAN_NOTIFICATION', payload: { invitesReply: true, ...(q ? { questions: [{ id: 'q1', text: 'x' }] } : {}) } });
    const gate  = { kind: 'inbox', id: 6, messageType: 'HUMAN_GATE', payload: { gate_type: 'minds_eye_gate', atSeq: 9 } };
    const me    = { kind: 'person', seq: 3 };
    assert.equal(answerable({ state: 'waiting', gate: { kind: 'action', atSeq: 9 } }, [reply(true), gate]), gate);
    assert.equal(answerable({ state: 'waiting', gate: { kind: 'action', atSeq: 8 } }, [gate]), null);
    assert.equal(answerable({ state: 'waiting', gate: null }, [reply(true)]).id, 5);
    assert.equal(answerable({ state: 'waiting', gate: null }, [reply(false)]), null);
    assert.equal(answerable({ state: 'waiting', gate: null }, [reply(true), me]).id, 5);
    assert.equal(answerable({ state: 'working', gate: null }, [reply(true)]), null);
    assert.equal(answerable(null, []), null);
  });

  it('answerField: radio up to ten choices, a dropdown past, text without', () => {
    assert.equal(answerField({ id: 'q1', options: ['a', 'b'] }, 'L').input_type, 'radio');
    assert.equal(answerField({ id: 'q1', options: Array.from({ length: RADIO_LIMIT + 1 }, (_, i) => `${i}`) }, 'L').input_type, 'select');
    assert.deepEqual(answerField({ id: 'q2' }, 'Your answer'), { name: 'a-q2', input_type: 'textarea', label: 'Your answer', optional: true });
  });

  it('answersFrom: the answers with something in them, the note, or null', () => {
    const qs = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
    assert.deepEqual(answersFrom(qs, { q1: { answer: ' Yes ' }, q2: { answer: '  ' }, q3: { comment: 'later' } }, '  '),
      { answers: [{ id: 'q1', answer: 'Yes', comment: null }, { id: 'q3', answer: null, comment: 'later' }], note: null });
    assert.deepEqual(answersFrom(qs, {}, ' just this '), { answers: [], note: 'just this' });
    assert.equal(answersFrom(qs, { q1: { answer: '' } }, ''), null);
  });

  it('stillExpecting: until the person\'s message is stored, she is working, or a minute passes', () => {
    const since = 1_000_000;
    const e = { since, persons: 2 };
    assert.equal(stillExpecting(e, { persons: 2, state: 'waiting', now: since + 5_000 }), true);
    assert.equal(stillExpecting(e, { persons: 3, state: 'waiting', now: since + 5_000 }), false);
    assert.equal(stillExpecting(e, { persons: 2, state: 'working', now: since + 5_000 }), false);
    assert.equal(stillExpecting(e, { persons: 2, state: 'waiting', now: since + EXPECT_MS }), false);
    assert.equal(stillExpecting(null, { persons: 0, state: 'waiting', now: since }), false);
    assert.equal(personCount([{ kind: 'person' }, { kind: 'inbox' }, { kind: 'person' }]), 2);
  });

  it('withSession: sets or clears ?minds-eye=, keeping the rest of the location', () => {
    assert.equal(withSession('/p/money', 7), '/p/money?minds-eye=7');
    assert.equal(withSession('/d/x?run=4', 7), '/d/x?run=4&minds-eye=7');
    assert.equal(withSession('/d/x?run=4&minds-eye=7', null), '/d/x?run=4');
    assert.equal(withSession('/?minds-eye=7', null), '/');
  });

  it('the app\'s round ceiling is ProcFunction\'s, as /proc\'s is', async () => {
    const proc = await import('../../src/proc/minds-eye-sessions.mjs');
    assert.equal(ROUND_CEILING_MS, proc.ROUND_CEILING_MS);
  });
});
