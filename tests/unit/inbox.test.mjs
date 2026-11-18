// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/inbox.test.mjs
//
// Sprint 16 scope 1 and 7 (docs/arch-web-app.md §2.1, §3.1, §11): every message to a person is
// written to PGC_UiMessage by enqueueCallback, the web's only delivery; GET /proc/inbox reads it
// for the principal, never trusting a run id it has not checked.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';
import { SQSClient }               from '@aws-sdk/client-sqs';

import { readPrincipal, canSeeRun }                                   from '../../src/proc/principal.mjs';
import { parseInboxQuery, toInboxPage, handle, INBOX_MAX_LIMIT }      from '../../src/proc/inbox.mjs';
import { enqueueCallback }                                            from '../../src/shared/sqs-callback.mjs';

const realFetch = globalThis.fetch;
const realSend  = SQSClient.prototype.send;

/** Stub SERV: record each call, answer from `answer(path, body)`. */
function stubServ(answer) {
  const calls = [];
  process.env.SERV_API_URL = 'https://serv.test';
  globalThis.fetch = async (url, init) => {
    const path = url.replace('https://serv.test', '');
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    return new Response(JSON.stringify(answer(path, body)), { status: 200 });
  };
  return calls;
}

describe('readPrincipal — the person a request acts for', () => {
  it('reads x-principal-user in any case, with the household role from configuration', () => {
    assert.deepEqual(readPrincipal({ 'X-Principal-User': ' sub-a ' }, 'sub-a, sub-b'), { user: 'sub-a', roles: ['household'] });
    assert.deepEqual(readPrincipal({ 'x-principal-user': 'sub-c' }, 'sub-a,sub-b'), { user: 'sub-c', roles: [] });
  });

  it('is null when the header is absent or empty — never taken from anywhere else', () => {
    assert.equal(readPrincipal({}, 'sub-a'), null);
    assert.equal(readPrincipal({ 'x-principal-user': '  ' }, 'sub-a'), null);
  });
});

describe('canSeeRun — who a run belongs to', () => {
  const member   = { user: 'sub-a', roles: ['household'] };
  const outsider = { user: 'sub-z', roles: [] };

  it('a web-started run belongs to the sub that started it, household or not', () => {
    const run = { callback: { provider: 'web', channel: 'sub-a' } };
    assert.equal(canSeeRun(member, run), true);
    assert.equal(canSeeRun({ user: 'sub-b', roles: ['household'] }, run), false);
  });

  it('a Slack-started or scheduled run belongs to the household', () => {
    for (const run of [{ callback: { provider: 'slack', channel: 'C1' } }, { callback: null }]) {
      assert.equal(canSeeRun(member, run), true);
      assert.equal(canSeeRun(outsider, run), false);
    }
  });
});

describe('parseInboxQuery', () => {
  it('defaults after to 0, run to none and limit to 50', () => {
    assert.deepEqual(parseInboxQuery({}), { after: 0, run: null, limit: 50 });
    assert.deepEqual(parseInboxQuery({ after: '41', run: '7', limit: '10' }), { after: 41, run: 7, limit: 10 });
  });

  it('refuses anything but a whole number in range', () => {
    for (const q of [{ after: '-1' }, { after: '1.5' }, { run: 'x' }, { run: '0' }, { limit: '0' }, { limit: String(INBOX_MAX_LIMIT + 1) }]) {
      assert.ok(parseInboxQuery(q).error, JSON.stringify(q));
    }
  });
});

describe('toInboxPage — a bounded page that says so', () => {
  const row = id => ({ id: String(id), provider: 'web', thread_id: '9', workflow_run_id: 9, message_type: 'HUMAN_NOTIFICATION', payload: { text: 't' }, created_at: '2026-11-15T10:00:00Z' });

  it('returns at most limit rows, the last id as cursor, and more when the extra row came back', () => {
    const page = toInboxPage([row(5), row(6), row(7)], 4, 2);
    assert.deepEqual(page.messages.map(m => m.id), [5, 6]);
    assert.equal(page.cursor, 6);
    assert.equal(page.more, true);
    assert.deepEqual(Object.keys(page.messages[0]), ['id', 'provider', 'threadId', 'workflowRunId', 'messageType', 'payload', 'createdAt']);
  });

  it('keeps the caller\'s cursor when nothing is new', () => {
    assert.deepEqual(toInboxPage([], 12, 50), { messages: [], cursor: 12, more: false });
  });
});

describe('GET /proc/inbox — every id checked against the principal', () => {
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.HOUSEHOLD_PRINCIPALS; });
  const req = (headers, query) => ({ method: 'GET', proxy: 'inbox', route: 'inbox', headers, query, correlationId: 'c' });
  const status = r => [r.statusCode, JSON.parse(r.body).error];

  it('401 without a principal, and no SERV call', async () => {
    const calls = stubServ(() => ({ rows: [] }));
    assert.deepEqual(status(await handle(req({}, {}))), [401, 'principal_required']);
    assert.equal(calls.length, 0);
  });

  it('400 on a malformed query', async () => {
    stubServ(() => ({ rows: [] }));
    assert.deepEqual(status(await handle(req({ 'x-principal-user': 'sub-a' }, { limit: 'all' }))), [400, 'invalid_query']);
  });

  it('without run, reads only the principal\'s own web messages after the cursor', async () => {
    const calls = stubServ(() => ({ rows: [] }));
    const r = await handle(req({ 'x-principal-user': 'sub-a' }, { after: '3', limit: '5' }));
    assert.equal(r.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.tableName, 'PGC_UiMessage');
    assert.deepEqual(calls[0].body.filters, [
      { column: 'id', op: 'gt', value: 3 },
      { column: 'provider', op: 'eq', value: 'web' },
      { column: 'channel', op: 'eq', value: 'sub-a' },
    ]);
    assert.equal(calls[0].body.limit, 6);
    assert.equal(calls[0].body.orderBy, 'id ASC');
  });

  it('a run the principal may not see is 403, and its messages are never read', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ(path => ({ rows: [{ id: 9, callback: { provider: 'web', channel: 'sub-a' } }] }));
    assert.deepEqual(status(await handle(req({ 'x-principal-user': 'sub-b' }, { run: '9' }))), [403, 'run_forbidden']);
    assert.deepEqual(calls.map(c => c.body.tableName), ['PGC_WorkflowRun']);
  });

  it('a Slack-started run is read for a household principal, from every provider', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ(path => path.endsWith('getRows') && calls.length === 1
      ? { rows: [{ id: 9, callback: { provider: 'slack', channel: 'C1' } }] } : { rows: [] });
    const r = await handle(req({ 'x-principal-user': 'sub-a' }, { run: '9' }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(calls[1].body.filters, [{ column: 'id', op: 'gt', value: 0 }, { column: 'workflow_run_id', op: 'eq', value: 9 }]);
  });

  it('an unknown run is 404', async () => {
    stubServ(() => ({ rows: [] }));
    assert.deepEqual(status(await handle(req({ 'x-principal-user': 'sub-a' }, { run: '404' }))), [404, 'run_not_found']);
  });
});

describe('enqueueCallback — the inbox is the single delivery point', () => {
  afterEach(() => { globalThis.fetch = realFetch; SQSClient.prototype.send = realSend; });
  const gate = { type: 'HUMAN_GATE', workflowRunId: 9, dialog: { gate_id: 'g' }, traceId: 't' };

  function capture() {
    const sent = [];
    SQSClient.prototype.send = async function (command) { sent.push(command.input); };
    process.env.SQS_SLACK_RESULTS_URL = 'results-queue';
    return { sent, inserts: stubServ(() => ({ rows: [{ id: 1 }] })) };
  }

  it('a web message is written to the inbox and enqueued nowhere', async () => {
    const { sent, inserts } = capture();
    await enqueueCallback({ provider: 'web', channel: 'sub-a', threadId: '9' }, { ...gate, callback: { provider: 'web' } });
    assert.equal(sent.length, 0);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].path, '/api/v1/serv/table/insertRow');
    assert.deepEqual(inserts[0].body, { tableName: 'PGC_UiMessage', row: {
      provider: 'web', channel: 'sub-a', thread_id: '9', workflow_run_id: 9, session_id: null, message_type: 'HUMAN_GATE',
      payload: { type: 'HUMAN_GATE', workflowRunId: 9, dialog: { gate_id: 'g' }, traceId: 't' },
    } });
  });

  it('a Slack message is written to the inbox, then enqueued for Slack', async () => {
    const { sent, inserts } = capture();
    await enqueueCallback({ provider: 'slack', channel: 'C1', threadId: '1.2' }, { type: 'HUMAN_NOTIFICATION', workflowRunId: 9, text: 'Done', traceId: 't' });
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].body.row.provider, 'slack');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].QueueUrl, 'results-queue');
  });

  it('a minds-eye message is written with its session, so the session conversation can be read', async () => {
    const { inserts } = capture();
    await enqueueCallback({ provider: 'web', channel: 'sub-a' }, { type: 'HUMAN_NOTIFICATION', format: 'markdown', message: 'Hi', sessionId: 42, traceId: 't' });
    assert.equal(inserts[0].body.row.session_id, 42);
    assert.equal(inserts[0].body.row.workflow_run_id, null);
  });

  it('a Slack-only message (explain buttons, pings) goes to Slack and not the inbox', async () => {
    const { sent, inserts } = capture();
    await enqueueCallback({ provider: 'slack', channel: 'C1', threadId: '1.2' }, { type: 'EXPLAIN_STEP_SELECT', traceId: 't' });
    assert.equal(inserts.length, 0);
    assert.equal(sent.length, 1);
  });

  it('a failed inbox write stops delivery, so Slack never shows what the inbox lacks', async () => {
    const sent = [];
    SQSClient.prototype.send = async function (command) { sent.push(command.input); };
    process.env.SERV_API_URL = 'https://serv.test';
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'down' }), { status: 500 });
    await assert.rejects(enqueueCallback({ provider: 'slack', channel: 'C1' }, { type: 'WORKFLOW_ERROR', workflowRunId: 9, traceId: 't' }), /down/);
    assert.equal(sent.length, 0);
  });
});
