// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/web-api.test.mjs
//
// Sprint 17 scope 1, phase B (docs/arch-web-app.md §1, §3.1, §11): WebApiFunction — the real
// handler, with fetch stubbed so nothing reaches the network. Only the spec's eleven operations
// reach PROC; every PROC call carries the internal key and the token's sub and nothing the
// browser sent; errors are WebError bodies.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';

import { handler }                  from '../../src/ui/web/api/handler.mjs';
import { WEB_ROUTES, matchRoute }   from '../../src/ui/web/api/routes.mjs';
import { UPSTREAM_TIMEOUT_MS }      from '../../src/ui/web/api/proc-client.mjs';

const SUB      = 'aaaa-bbbb-sub';
const PROC_URL = 'https://proc.example';
const realFetch = globalThis.fetch;
let calls;
let answers;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch() {
  calls   = [];
  answers = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = answers.shift() ?? (() => json(200, { success: true }));
    return next(String(url), init);
  };
}

const event = (method, proxy, extra = {}) => ({
  httpMethod:     method,
  pathParameters: { proxy },
  headers:        { Authorization: 'Bearer the-access-token', 'x-api-key': 'browser-key', 'x-principal-user': 'someone-else', ...(extra.headers ?? {}) },
  queryStringParameters: extra.query ?? null,
  body:           extra.body ?? null,
  isBase64Encoded: false,
  requestContext: { authorizer: { claims: { sub: SUB } } },
});

const parse = res => JSON.parse(res.body);

beforeEach(() => {
  process.env.PROC_API_URL     = PROC_URL;
  process.env.INTERNAL_API_KEY = 'internal-key';
  process.env.AWS_REGION       = 'us-east-2';
  stubFetch();
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('routes — an allow-list of the spec, never a proxy', () => {
  it('holds exactly the twenty-three UI-Web operations', () => {
    assert.deepEqual(WEB_ROUTES.map(r => r.operationId).sort(), [
      'webAnswerGate', 'webAnswerMindsEyeGate', 'webCreateSourceRecord', 'webGetGate', 'webGetMe', 'webGetOutput', 'webGetRun',
      'webListGates', 'webListMindsEyeSessions', 'webListPages', 'webListRuns', 'webListWorkflows', 'webReadInbox',
      'webReadMindsEyeMessages', 'webReadSourceRecord', 'webReadSourceRows', 'webReadSourceSchema', 'webRenameMindsEyeSession',
      'webSaveSourceRecord', 'webSaveSourceRows', 'webSendMindsEyeMessage', 'webStartMindsEyeSession', 'webStartRun',
    ]);
  });

  for (const [method, proxy] of [
    ['POST', 'run-workflow'], ['GET', 'run-workflow'], ['GET', 'replay/12'], ['DELETE', 'runs'],
    ['GET', 'gates/abc'], ['GET', 'gates/0'], ['GET', 'gates/12/'], ['GET', 'gates//responses'],
    ['POST', 'gates/12'], ['GET', 'sources/x;drop/rows'], ['GET', 'sources/PGD_x/rows/extra'],
    ['GET', 'outputs/..'], ['GET', ''], ['GET', 'me/'],
    ['GET', 'minds-eye'], ['GET', 'minds-eye/sessions/abc/messages'], ['GET', 'minds-eye/sessions/0'],
    ['DELETE', 'minds-eye/sessions/12'], ['PATCH', 'minds-eye/sessions'], ['GET', 'minds-eye/sessions/12/entries'],
    ['POST', 'minds-eye/sessions/12'], ['GET', 'minds-eye/sessions/12/responses'],
    ['GET', 'sources/Thing/records'], ['PUT', 'sources/PGD_x/rows'], ['GET', 'sources/Thing/records/0'],
    ['DELETE', 'sources/Thing/records/5'], ['POST', 'sources/PGD_x/schema'], ['GET', 'sources/Thing/records/5/x'],
  ]) {
    it(`refuses ${method} /${proxy} with 404 route_not_found and calls nothing`, async () => {
      const res = await handler(event(method, proxy));
      assert.equal(res.statusCode, 404);
      assert.equal(parse(res).error.code, 'route_not_found');
      assert.equal(typeof parse(res).error.message, 'string');
      assert.equal(calls.length, 0);
    });
  }

  it('matches a path parameter to its pattern', () => {
    assert.equal(matchRoute('GET', 'gates/1357').procPath, 'gates/1357');
    assert.equal(matchRoute('GET', 'sources/PGD_budget_line/rows').route.operationId, 'webReadSourceRows');
  });
});

describe('each operation calls its PROC route as the principal', () => {
  const cases = [
    ['GET',  'workflows',            'workflows'],
    ['GET',  'pages',                'pages'],
    ['GET',  'sources/PGD_t/rows',   'sources/PGD_t/rows'],
    ['GET',  'outputs/some_report',  'outputs/some_report'],
    ['GET',  'runs',                 'runs'],
    ['GET',  'inbox',                'inbox'],
    ['GET',  'gates',                'gates'],
    ['GET',  'gates/42',             'gates/42'],
    ['GET',  'minds-eye/sessions',   'minds-eye/sessions'],
    ['GET',  'minds-eye/sessions/7/messages', 'minds-eye/sessions/7/messages'],
  ];
  for (const [method, proxy, procPath] of cases) {
    it(`${method} /${proxy} → ${method} /proc/${procPath}`, async () => {
      if (proxy === 'inbox') answers.push(() => json(200, { success: true, messages: [], cursor: 0, more: false }));
      if (proxy.endsWith('/messages')) answers.push(() => json(200, { success: true, messages: [], cursor: { after: 0, afterSeq: 0 }, more: false }));
      const res = await handler(event(method, proxy));
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${PROC_URL}/api/v1/proc/${procPath}`);
      assert.equal(calls[0].init.method, method);
    });
  }

  it('sends fresh headers — the internal key and the token\'s sub, nothing the browser sent', async () => {
    await handler(event('GET', 'pages'));
    const headers = calls[0].init.headers;
    assert.equal(headers['x-api-key'], 'internal-key');
    assert.equal(headers['x-principal-user'], SUB);
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.authorization, undefined);
  });

  it('bounds every upstream call under API Gateway\'s limit', async () => {
    await handler(event('GET', 'pages'));
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.ok(UPSTREAM_TIMEOUT_MS < 29_000);
  });

  it('passes on only the query parameters the route names', async () => {
    await handler(event('GET', 'runs', { query: { workflow: 'w', limit: '5', principal: 'x', sub: 'y' } }));
    const url = new URL(calls[0].url);
    assert.deepEqual(Object.fromEntries(url.searchParams), { workflow: 'w', limit: '5' });
  });

  it('a records read passes its filter through intact', async () => {
    const filter = JSON.stringify([{ column: 'a', op: 'eq', value: 'b&c=d' }]);
    await handler(event('GET', 'sources/PGD_t/rows', { query: { filter, order_by: 'a DESC', offset: '100' } }));
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('filter'), filter);
    assert.equal(url.searchParams.get('order_by'), 'a DESC');
    assert.equal(url.searchParams.get('offset'), '100', 'the next page reaches PROC (item 9)');
  });

  it('returns PROC\'s body and status unchanged — a started run is 202', async () => {
    answers.push(() => json(202, { success: true, runId: 1500 }));
    const res = await handler(event('POST', 'runs', { body: JSON.stringify({ workflow: 'edit_budget' }) }));
    assert.equal(res.statusCode, 202);
    assert.deepEqual(parse(res), { success: true, runId: 1500 });
    assert.deepEqual(JSON.parse(calls[0].init.body), { workflow: 'edit_budget' });
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  });

  it('an answer\'s body passes through to its run\'s responses', async () => {
    answers.push(() => json(202, { success: true, runId: 42 }));
    const answer = { gateId: 'g-1', action: 'submit', formValues: { amount: '12,50' } };
    const res = await handler(event('POST', 'gates/42/responses', { body: JSON.stringify(answer) }));
    assert.equal(res.statusCode, 202);
    assert.equal(calls[0].url, `${PROC_URL}/api/v1/proc/gates/42/responses`);
    assert.deepEqual(JSON.parse(calls[0].init.body), answer);
  });
});

describe('minds-eye sessions — bodies and queries pass through', () => {
  for (const [method, proxy, body] of [
    ['POST',  'minds-eye/sessions',             { text: 'hello', topic: 'garden' }],
    ['PATCH', 'minds-eye/sessions/7',           { label: 'Garden plans' }],
    ['POST',  'minds-eye/sessions/7/messages',  { answers: [{ id: 'q1', answer: 'Yes' }], note: null }],
    ['POST',  'minds-eye/sessions/7/responses', { atSeq: 12, action: 'continue' }],
  ]) {
    it(`${method} /${proxy} passes its body to /proc/${proxy}`, async () => {
      answers.push(() => json(202, { success: true, sessionId: 7 }));
      const res = await handler(event(method, proxy, { body: JSON.stringify(body) }));
      assert.equal(res.statusCode, 202);
      assert.equal(calls[0].url, `${PROC_URL}/api/v1/proc/${proxy}`);
      assert.equal(calls[0].init.method, method);
      assert.deepEqual(JSON.parse(calls[0].init.body), body);
    });
  }

  it('a session list passes on topic, limit and before only', async () => {
    await handler(event('GET', 'minds-eye/sessions', { query: { topic: 'garden', limit: '5', before: '2026-11-19T10:00:00.000Z', session_type: 'general_chat' } }));
    const url = new URL(calls[0].url);
    assert.deepEqual(Object.fromEntries(url.searchParams), { topic: 'garden', limit: '5', before: '2026-11-19T10:00:00.000Z' });
  });

  it('a conversation\'s WORKFLOW_ERROR is summarised as the inbox\'s is, the person\'s entries untouched', async () => {
    const person = { kind: 'person', seq: 1, text: 'hi', createdAt: '2026-11-19T10:00:00.000Z' };
    const error  = { kind: 'inbox', id: 9, messageType: 'WORKFLOW_ERROR', payload: { message: 'SERV getRows failed: 500 boom' }, createdAt: '2026-11-19T10:00:01.000Z' };
    answers.push(() => json(200, { success: true, session: {}, messages: [person, error], cursor: { after: 9, afterSeq: 1 }, more: false, repliesKeptFrom: null }));
    const body = parse(await handler(event('GET', 'minds-eye/sessions/7/messages')));
    assert.deepEqual(body.messages[0], person);
    assert.equal(body.messages[1].payload.message, undefined);
    assert.equal(typeof body.messages[1].payload.summary, 'string');
  });
});

describe('invalid_body — a POST whose body is not a JSON object', () => {
  for (const body of ['not json', '', null, '[1,2]', '"text"']) {
    it(`refuses ${JSON.stringify(body)} with 400 and calls nothing`, async () => {
      const res = await handler(event('POST', 'runs', { body }));
      assert.equal(res.statusCode, 400);
      assert.equal(parse(res).error.code, 'invalid_body');
      assert.equal(calls.length, 0);
    });
  }
});

describe('errors — PROC\'s code kept, a codeless failure is 502', () => {
  it('a 409 gate_moved keeps its code with English to fall back on', async () => {
    answers.push(() => json(409, { success: false, error: 'gate_moved', waitingGateId: 'g-2' }));
    const res = await handler(event('POST', 'gates/42/responses', { body: '{"gateId":"g-1","action":"ok"}' }));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(parse(res), { error: { code: 'gate_moved', message: 'This was answered elsewhere.' } });
  });

  it('a 422 invalid_fields carries its fields', async () => {
    const fields = [{ name: 'amount', problem: 'not_a_number' }];
    answers.push(() => json(422, { success: false, error: 'invalid_fields', fields }));
    const res = await handler(event('POST', 'gates/42/responses', { body: '{"gateId":"g-1","action":"ok"}' }));
    assert.equal(res.statusCode, 422);
    assert.deepEqual(parse(res).error.fields, fields);
  });

  it('PROC\'s own message wins over the fallback', async () => {
    answers.push(() => json(400, { success: false, error: 'invalid_query', message: 'limit must be between 1 and 100' }));
    const res = await handler(event('GET', 'runs', { query: { limit: '900' } }));
    assert.deepEqual(parse(res), { error: { code: 'invalid_query', message: 'limit must be between 1 and 100' } });
  });

  it('a 400 missing_fields keeps its code and PROC\'s message', async () => {
    answers.push(() => json(400, { success: false, error: 'missing_fields', message: 'workflow is required' }));
    const res = await handler(event('POST', 'runs', { body: '{}' }));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(parse(res), { error: { code: 'missing_fields', message: 'workflow is required' } });
  });

  it('a 5xx PROC names keeps its code', async () => {
    answers.push(() => json(500, { success: false, error: 'pages_truncated', totalMatching: 900 }));
    const res = await handler(event('GET', 'pages'));
    assert.equal(res.statusCode, 500);
    assert.equal(parse(res).error.code, 'pages_truncated');
  });

  it('a Lambda error behind PROC is 502 upstream_unavailable', async () => {
    answers.push(() => json(502, { message: 'Internal server error' }));
    const res = await handler(event('GET', 'pages'));
    assert.equal(res.statusCode, 502);
    assert.equal(parse(res).error.code, 'upstream_unavailable');
  });

  it('a network failure or timeout is 502 upstream_unavailable', async () => {
    answers.push(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const res = await handler(event('GET', 'gates'));
    assert.equal(res.statusCode, 502);
    assert.equal(parse(res).error.code, 'upstream_unavailable');
  });

  it('a 2xx that is not JSON is 502 upstream_unavailable', async () => {
    answers.push(() => new Response('<html>oops</html>', { status: 200 }));
    const res = await handler(event('GET', 'gates'));
    assert.equal(res.statusCode, 502);
  });
});

describe('GET /me — PROC joined with Cognito', () => {
  const cognitoUser = () => json(200, { Username: SUB, UserAttributes: [
    { Name: 'sub', Value: SUB }, { Name: 'email', Value: 'person@example.com' }, { Name: 'name', Value: 'A Person' },
  ] });
  const procMe = () => json(200, { success: true, user: SUB, roles: ['household'], locale: 'en', timezone: 'Europe/Madrid' });

  it('returns name, email, roles, locale and timezone — and nothing else', async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).startsWith(PROC_URL) ? procMe() : cognitoUser();
    };
    const res = await handler(event('GET', 'me'));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parse(res), { name: 'A Person', email: 'person@example.com', roles: ['household'], locale: 'en', timezone: 'Europe/Madrid' });

    const cognito = calls.find(c => c.url.includes('cognito-idp'));
    assert.equal(cognito.url, 'https://cognito-idp.us-east-2.amazonaws.com/');
    assert.equal(cognito.init.headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.GetUser');
    assert.deepEqual(JSON.parse(cognito.init.body), { AccessToken: 'the-access-token' });
    const proc = calls.find(c => c.url.startsWith(PROC_URL));
    assert.equal(proc.url, `${PROC_URL}/api/v1/proc/me`);
    assert.equal(proc.init.headers['x-principal-user'], SUB);
  });

  it('a name never set is null', async () => {
    globalThis.fetch = async url => String(url).startsWith(PROC_URL) ? procMe()
      : json(200, { UserAttributes: [{ Name: 'email', Value: 'person@example.com' }] });
    assert.equal(parse(await handler(event('GET', 'me'))).name, null);
  });

  it('a Cognito refusal is 502 upstream_unavailable', async () => {
    globalThis.fetch = async url => String(url).startsWith(PROC_URL) ? procMe()
      : json(400, { __type: 'NotAuthorizedException', message: 'Access Token has been revoked' });
    const res = await handler(event('GET', 'me'));
    assert.equal(res.statusCode, 502);
    assert.equal(parse(res).error.code, 'upstream_unavailable');
  });
});

describe('GET /inbox — a WORKFLOW_ERROR reaches the browser summarised', () => {
  it('replaces the raw message with the summary Slack posts, and leaves other messages alone', async () => {
    const raw = 'llm_call validation failed: [{"keyword":"required"},{"keyword":"type"}]';
    const note = { id: 7, provider: 'web', messageType: 'HUMAN_NOTIFICATION', payload: { type: 'HUMAN_NOTIFICATION', text: 'Done' }, createdAt: 't' };
    const fail = { id: 8, provider: 'web', messageType: 'WORKFLOW_ERROR', workflowRunId: 9,
      payload: { type: 'WORKFLOW_ERROR', workflowRunId: 9, step: 'plan', message: raw, traceId: 'tr' }, createdAt: 't' };
    answers.push(() => json(200, { success: true, messages: [note, fail], cursor: 8, more: false }));

    const res  = await handler(event('GET', 'inbox', { query: { after: '6' } }));
    const body = parse(res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(body.messages[0], note);
    assert.deepEqual(body.messages[1].payload, {
      type: 'WORKFLOW_ERROR', workflowRunId: 9, step: 'plan', traceId: 'tr',
      summary: 'LLM output validation failed after 2 attempts (2 schema errors). The prompt has been logged for improvement.',
    });
    assert.equal(body.cursor, 8);
    assert.equal(new URL(calls[0].url).searchParams.get('after'), '6');
  });
});
