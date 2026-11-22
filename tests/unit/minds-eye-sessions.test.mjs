// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-sessions.test.mjs
//
// /proc/minds-eye/sessions — the pure halves: who may see a session, whether it waits or works,
// what a gate answer enqueues or why it is refused, and how a conversation's two sources merge.
//
// Run: node --test tests/unit/minds-eye-sessions.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  ROUND_CEILING_MS, ANSWERED_TEXT, parseSessionsQuery, parseMessagesQuery, sessionState, toSession,
  mergeConversation, readMessageBody, gateAnswer, handle,
} from '../../src/proc/minds-eye-sessions.mjs';
import { canSeeSession } from '../../src/proc/principal.mjs';

const NOW       = Date.parse('2026-11-19T12:00:00.000Z');
const ago       = ms => new Date(NOW - ms).toISOString();
const household = { user: 'sub-1', roles: ['household'] };
const outsider  = { user: 'sub-2', roles: [] };

const gate = (gate_type, atSeq, extra = {}) =>
  ({ message_type: 'HUMAN_GATE', payload: { gate_type, atSeq, ...extra }, created_at: ago(1000) });
const reply = (extra = {}) =>
  ({ message_type: 'HUMAN_NOTIFICATION', payload: { message: 'Done.', invitesReply: true, ...extra }, created_at: ago(1000) });
const progress = { message_type: 'HUMAN_NOTIFICATION', payload: { message: '🔍 Turn 2 · read_workflow', turn: 2 }, created_at: ago(1000) };

describe('canSeeSession — minds_eye only, owned by its callback', () => {
  const web   = { session_type: 'minds_eye', callback: { provider: 'web', channel: 'sub-1' } };
  const slack = { session_type: 'minds_eye', callback: { provider: 'slack', channel: 'C1', threadId: '1.2' } };

  it('a web session is its starter\'s, whatever their role', () => {
    assert.equal(canSeeSession(household, web), true);
    assert.equal(canSeeSession({ user: 'sub-1', roles: [] }, web), true);
    assert.equal(canSeeSession({ user: 'sub-3', roles: ['household'] }, web), false);
  });

  it('a Slack session, or one with no callback, is the household\'s', () => {
    assert.equal(canSeeSession(household, slack), true);
    assert.equal(canSeeSession(outsider, slack), false);
    assert.equal(canSeeSession(household, { session_type: 'minds_eye', callback: null }), true);
  });

  it('no other session type, whoever asks', () => {
    for (const session_type of ['general_chat', 'llm_call_diagnostic']) {
      assert.equal(canSeeSession(household, { ...slack, session_type }), false, session_type);
    }
  });
});

describe('sessionState — waiting or working', () => {
  it('waits at a gate whose atSeq is the latest entry, naming its kind', () => {
    assert.deepEqual(sessionState({ lastMessage: gate('minds_eye_gate', 14), latestSeq: 14 }, NOW),
      { state: 'waiting', gate: { kind: 'action', atSeq: 14 } });
    assert.deepEqual(sessionState({ lastMessage: gate('minds_eye_continue_gate', 9), latestSeq: 9 }, NOW),
      { state: 'waiting', gate: { kind: 'continue', atSeq: 9 } });
  });

  it('a gate the session has moved past is not waiting — working, within the ceiling', () => {
    assert.deepEqual(sessionState({ lastMessage: gate('minds_eye_gate', 14), latestSeq: 15, lastActiveAt: ago(5000) }, NOW),
      { state: 'working', gate: null });
  });

  it('a gate posted before atSeq existed is never current', () => {
    assert.equal(sessionState({ lastMessage: gate('minds_eye_continue_gate', null), latestSeq: null, lastActiveAt: ago(1000) }, NOW).gate, null);
  });

  it('waits after a reply that invites one, or an error', () => {
    assert.equal(sessionState({ lastMessage: reply(), latestSeq: 3, lastActiveAt: ago(1000) }, NOW).state, 'waiting');
    assert.equal(sessionState({ lastMessage: { message_type: 'WORKFLOW_ERROR', payload: {}, created_at: ago(1000) }, latestSeq: 3 }, NOW).state, 'waiting');
  });

  it('works after a progress line, and before her first message', () => {
    assert.equal(sessionState({ lastMessage: progress, latestSeq: 3, lastActiveAt: ago(1000) }, NOW).state, 'working');
    assert.equal(sessionState({ lastMessage: null, latestSeq: 1, lastActiveAt: ago(1000) }, NOW).state, 'working');
  });

  it('the person wrote after her last message: working, even after a reply that invited one or at a gate', () => {
    assert.deepEqual(sessionState({ lastMessage: reply(), latestSeq: 4, lastPersonAt: ago(500), lastActiveAt: ago(500) }, NOW),
      { state: 'working', gate: null });
    assert.deepEqual(sessionState({ lastMessage: gate('minds_eye_continue_gate', 9), latestSeq: 10, lastPersonAt: ago(500), lastActiveAt: ago(500) }, NOW),
      { state: 'working', gate: null });
  });

  it('the person\'s message before her last one changes nothing', () => {
    assert.equal(sessionState({ lastMessage: reply(), latestSeq: 4, lastPersonAt: ago(5000), lastActiveAt: ago(900) }, NOW).state, 'waiting');
  });

  it('a person\'s message no round answered, past the ceiling, waits again', () => {
    const quiet = ago(ROUND_CEILING_MS + 1);
    assert.equal(sessionState({ lastMessage: { ...reply(), created_at: ago(ROUND_CEILING_MS + 5000) }, latestSeq: 4, lastPersonAt: quiet, lastActiveAt: quiet }, NOW).state, 'waiting');
  });

  it('a round silent past the ceiling has died — the session waits', () => {
    const quiet = ago(ROUND_CEILING_MS + 1);
    assert.equal(sessionState({ lastMessage: { ...progress, created_at: quiet }, latestSeq: 3, lastActiveAt: quiet }, NOW).state, 'waiting');
    assert.equal(sessionState({ lastMessage: null, latestSeq: 1, lastActiveAt: quiet }, NOW).state, 'waiting');
  });

  it('the later of last activity and her last message is what the ceiling counts from', () => {
    const quiet = ago(ROUND_CEILING_MS + 1);
    assert.equal(sessionState({ lastMessage: { ...progress, created_at: quiet }, latestSeq: 3, lastActiveAt: ago(1000) }, NOW).state, 'working');
  });
});

describe('ROUND_CEILING_MS — no round outlives ProcFunction', () => {
  it('equals ProcFunction\'s Timeout in template.yaml', () => {
    const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
    const block    = template.slice(template.indexOf('FunctionName: evolving-mind-ai-proc'));
    const timeout  = Number(/Timeout:\s*(\d+)/.exec(block)[1]);
    assert.equal(ROUND_CEILING_MS, timeout * 1000);
  });
});

describe('toSession', () => {
  const row = { id: '42', session_type: 'minds_eye', callback: { provider: 'web', channel: 'sub-1' }, topic: 'garden',
    label: null, created_at: ago(9000), last_active_at: ago(1000) };

  it('names its fields as the spec does, provider from its callback', () => {
    assert.deepEqual(toSession(row, { firstMessage: 'Plan the beds', latestSeq: 3, lastMessage: reply() }, NOW), {
      sessionId: 42, label: null, firstMessage: 'Plan the beds', topic: 'garden', provider: 'web',
      createdAt: row.created_at, lastActiveAt: row.last_active_at, state: 'waiting', gate: null,
    });
  });

  it('a session with a Slack callback, or none, is slack', () => {
    assert.equal(toSession({ ...row, callback: { provider: 'slack' } }, {}, NOW).provider, 'slack');
    assert.equal(toSession({ ...row, callback: null }, undefined, NOW).provider, 'slack');
  });
});

describe('mergeConversation — the person\'s entries and her inbox rows, by time', () => {
  const entry = (seq, at) => ({ sequence_number: seq, content: `me ${seq}`, created_at: at });
  const row   = (id, at)  => ({ id: String(id), message_type: 'HUMAN_NOTIFICATION', payload: { message: `her ${id}` }, created_at: at });

  it('interleaves by time, the person first on a tie, and advances both cursors', () => {
    const page = mergeConversation(
      [entry(1, '2026-11-19T10:00:00.000Z'), entry(5, '2026-11-19T10:02:00.000Z')],
      [row(70, '2026-11-19T10:00:30.000Z'), row(71, '2026-11-19T10:02:00.000Z')],
      { after: 0, afterSeq: 0, limit: 50 });
    assert.deepEqual(page.messages.map(m => m.kind === 'person' ? `p${m.seq}` : `i${m.id}`), ['p1', 'i70', 'p5', 'i71']);
    assert.deepEqual(page.cursor, { after: 71, afterSeq: 5 });
    assert.equal(page.more, false);
    assert.deepEqual(page.messages[1], { kind: 'inbox', id: 70, messageType: 'HUMAN_NOTIFICATION', payload: { message: 'her 70' }, createdAt: '2026-11-19T10:00:30.000Z' });
  });

  it('keeps the earliest `limit`, says more remain, and moves only past what it returned', () => {
    const page = mergeConversation(
      [entry(1, '2026-11-19T10:00:00.000Z'), entry(2, '2026-11-19T10:05:00.000Z')],
      [row(70, '2026-11-19T10:01:00.000Z'), row(71, '2026-11-19T10:02:00.000Z')],
      { after: 0, afterSeq: 0, limit: 2 });
    assert.deepEqual(page.messages.map(m => m.kind), ['person', 'inbox']);
    assert.deepEqual(page.cursor, { after: 70, afterSeq: 1 });
    assert.equal(page.more, true);
  });

  it('an empty page keeps the cursors it was given', () => {
    assert.deepEqual(mergeConversation([], [], { after: 80, afterSeq: 6, limit: 50 }),
      { messages: [], cursor: { after: 80, afterSeq: 6 }, more: false });
  });
});

describe('readMessageBody — text, or answers', () => {
  it('takes trimmed text, which wins over answers', () => {
    assert.deepEqual(readMessageBody({ text: '  hello ', answers: [{ id: 'q1', answer: 'x' }] }), { text: 'hello' });
  });

  it('takes answers with something in them, and a note', () => {
    assert.deepEqual(readMessageBody({ answers: [{ id: 'q1', answer: 'Yes' }, { id: 'q2', answer: ' ' }, { id: 'q3', comment: 'later' }, { answer: 'no id' }], note: ' Start small ' }),
      { answers: [{ id: 'q1', answer: 'Yes', comment: null }, { id: 'q3', answer: null, comment: 'later' }], note: 'Start small' });
    assert.deepEqual(readMessageBody({ answers: [], note: 'just this' }), { answers: [], note: 'just this' });
  });

  it('refuses a body with nothing to send', () => {
    for (const body of [{}, { text: '   ' }, { answers: [{ id: 'q1', answer: '' }] }, { answers: 'x' }]) {
      assert.ok(readMessageBody(body).error, JSON.stringify(body));
    }
  });
});

describe('gateAnswer — what an answer enqueues, or why it is refused', () => {
  const at = (kind, atSeq) => ({ state: 'waiting', gate: { kind, atSeq } });
  const actionGate   = gate('minds_eye_gate', 14, { testLabel: 'Apply and test' });
  const continueGate = gate('minds_eye_continue_gate', 9, { resetActionCount: true, afterTruncation: true });

  it('approve, test and cancel on an action gate', () => {
    assert.deepEqual(gateAnswer({ state: at('action', 14), gateMessage: actionGate, sessionId: 7, body: { atSeq: 14, action: 'approve' } }).message,
      { type: 'MINDS_EYE_RESUME', sessionId: 7, approved: true, atSeq: 14 });
    assert.deepEqual(gateAnswer({ state: at('action', 14), gateMessage: actionGate, sessionId: 7, body: { atSeq: 14, action: 'test' } }).message,
      { type: 'MINDS_EYE_RESUME', sessionId: 7, approved: true, test: true, atSeq: 14 });
    assert.deepEqual(gateAnswer({ state: at('action', 14), gateMessage: actionGate, sessionId: 7, body: { atSeq: 14, action: 'cancel' } }).message,
      { type: 'MINDS_EYE_RESUME', sessionId: 7, approved: false, atSeq: 14 });
  });

  it('continue and end on a continue gate carry what the gate\'s own message carried', () => {
    assert.deepEqual(gateAnswer({ state: at('continue', 9), gateMessage: continueGate, sessionId: 7, body: { atSeq: 9, action: 'continue' } }).message,
      { type: 'MINDS_EYE_RESUME', resumeType: 'continue', sessionId: 7, approved: true, resetActionCount: true, atSeq: 9, afterTruncation: true });
    assert.equal(gateAnswer({ state: at('continue', 9), gateMessage: gate('minds_eye_continue_gate', 9), sessionId: 7, body: { atSeq: 9, action: 'end' } }).message.approved, false);
  });

  it('never takes resetActionCount or afterTruncation from the body', () => {
    const message = gateAnswer({ state: at('continue', 9), gateMessage: gate('minds_eye_continue_gate', 9), sessionId: 7,
      body: { atSeq: 9, action: 'continue', resetActionCount: true, afterTruncation: true } }).message;
    assert.equal(message.resetActionCount, false);
    assert.equal(message.afterTruncation, undefined);
  });

  it('refuses an action the waiting gate does not offer, test without a test label among them', () => {
    for (const [state, gateMessage, action] of [
      [at('action', 14), actionGate, 'continue'], [at('continue', 9), continueGate, 'approve'],
      [at('action', 14), gate('minds_eye_gate', 14), 'test'], [at('action', 14), actionGate, 'explode'],
    ]) {
      assert.deepEqual(gateAnswer({ state, gateMessage, sessionId: 7, body: { atSeq: state.gate.atSeq, action } }),
        { status: 400, error: 'invalid_action' }, action);
    }
  });

  it('gate_moved for another atSeq, or a gate the session has moved past; gate_not_waiting with none', () => {
    assert.deepEqual(gateAnswer({ state: at('action', 14), gateMessage: actionGate, sessionId: 7, body: { atSeq: 12, action: 'approve' } }),
      { status: 409, error: 'gate_moved' });
    assert.deepEqual(gateAnswer({ state: { state: 'working', gate: null }, gateMessage: actionGate, sessionId: 7, body: { atSeq: 14, action: 'approve' } }),
      { status: 409, error: 'gate_moved' });
    assert.deepEqual(gateAnswer({ state: { state: 'waiting', gate: null }, gateMessage: reply(), sessionId: 7, body: { atSeq: 3, action: 'approve' } }),
      { status: 409, error: 'gate_not_waiting' });
  });

  it('missing_fields without a whole atSeq and an action', () => {
    for (const body of [{}, { atSeq: '14', action: 'approve' }, { atSeq: 14 }]) {
      assert.deepEqual(gateAnswer({ state: at('action', 14), gateMessage: actionGate, sessionId: 7, body }), { status: 400, error: 'missing_fields' });
    }
  });

  it('has the words Slack shows for every action', () => {
    assert.deepEqual(Object.keys(ANSWERED_TEXT).sort(), ['approve', 'cancel', 'continue', 'end', 'test']);
  });
});

describe('the queries', () => {
  it('sessions: limit in range, before a date-time, a blank topic none', () => {
    assert.deepEqual(parseSessionsQuery({}), { topic: null, limit: 20, before: null });
    assert.deepEqual(parseSessionsQuery({ topic: ' garden ', limit: '5', before: '2026-11-19T10:00:00.000Z' }),
      { topic: 'garden', limit: 5, before: '2026-11-19T10:00:00.000Z' });
    assert.equal(parseSessionsQuery({ topic: '  ' }).topic, null);
    assert.ok(parseSessionsQuery({ limit: '0' }).error);
    assert.ok(parseSessionsQuery({ limit: '101' }).error);
    assert.ok(parseSessionsQuery({ before: 'yesterday-ish' }).error);
  });

  it('messages: whole cursors, limit in range', () => {
    assert.deepEqual(parseMessagesQuery({}), { after: 0, afterSeq: 0, limit: 50 });
    assert.deepEqual(parseMessagesQuery({ after: '9', afterSeq: '4', limit: '200' }), { after: 9, afterSeq: 4, limit: 200 });
    for (const query of [{ after: '-1' }, { afterSeq: 'x' }, { limit: '201' }]) assert.ok(parseMessagesQuery(query).error, JSON.stringify(query));
  });
});

describe('handle — paths, before anything is read', () => {
  const req = (method, proxy, headers = { 'x-principal-user': 'sub-1' }) => ({ method, proxy, headers, query: {}, body: {}, correlationId: 'c-1' });

  for (const [method, proxy] of [
    ['GET', 'minds-eye'], ['GET', 'minds-eye/other'], ['GET', 'minds-eye/sessions/abc'], ['GET', 'minds-eye/sessions/0/messages'],
    ['GET', 'minds-eye/sessions/7/entries'], ['DELETE', 'minds-eye/sessions/7'], ['GET', 'minds-eye/sessions/7/messages/extra'],
    ['PATCH', 'minds-eye/sessions'], ['GET', 'minds-eye/sessions/7/responses'],
  ]) {
    it(`404 for ${method} /${proxy}`, async () => {
      assert.equal((await handle(req(method, proxy))).statusCode, 404);
    });
  }

  it('401 principal_required without a principal', async () => {
    const res = await handle(req('GET', 'minds-eye/sessions', {}));
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'principal_required');
  });

  it('400 invalid_query before any read', async () => {
    const res = await handle({ ...req('GET', 'minds-eye/sessions'), query: { limit: '0' } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_query');
  });
});

// AC5: the routes against stored sessions, SERV and SQS stubbed — a session that is not
// minds_eye is never found, one that is not the principal's is forbidden, and the list reads
// minds_eye sessions only, leaving out what the principal may not see.
describe('handle — the session a route names, read from SERV', () => {
  const realFetch = globalThis.fetch;
  const realSend  = SQSClient.prototype.send;
  let calls, sent;

  /** Stub SERV: PGC_Session reads answer `sessions`; anything else answers empty. */
  function stubServ(sessions) {
    process.env.SERV_API_URL = 'https://serv.test';
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path: url.replace('https://serv.test', ''), body });
      const rows = body.tableName === 'PGC_Session' ? sessions : [];
      return new Response(JSON.stringify({ success: true, rows }), { status: 200 });
    };
  }

  beforeEach(() => {
    calls = []; sent = [];
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-1';
    SQSClient.prototype.send = async command => { sent.push(command); return {}; };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    SQSClient.prototype.send = realSend;
    delete process.env.HOUSEHOLD_PRINCIPALS;
  });

  const req = (method, proxy, body = {}, query = {}) =>
    ({ method, proxy, headers: { 'x-principal-user': 'sub-1' }, query, body, correlationId: 'c-1' });
  const idRoutes = [
    ['GET',   'minds-eye/sessions/7/messages',  {}],
    ['PATCH', 'minds-eye/sessions/7',           { label: 'A name' }],
    ['POST',  'minds-eye/sessions/7/messages',  { text: 'Hello' }],
    ['POST',  'minds-eye/sessions/7/responses', { atSeq: 3, action: 'approve' }],
  ];
  const slackCallback = { provider: 'slack', channel: 'C1', threadId: '1.2' };

  for (const session_type of ['general_chat', 'llm_call_diagnostic']) {
    for (const [method, proxy, body] of idRoutes) {
      it(`404 session_not_found for a ${session_type} id: ${method} /${proxy}`, async () => {
        stubServ([{ id: '7', session_type, callback: slackCallback, last_active_at: ago(1000) }]);
        const res = await handle(req(method, proxy, body));
        assert.equal(res.statusCode, 404);
        assert.equal(JSON.parse(res.body).error, 'session_not_found');
        assert.deepEqual(calls.map(c => c.body.tableName), ['PGC_Session'], 'nothing read past the session');
        assert.equal(sent.length, 0, 'nothing enqueued');
      });
    }
  }

  for (const [method, proxy, body] of idRoutes) {
    it(`403 session_forbidden for another person's web session: ${method} /${proxy}`, async () => {
      stubServ([{ id: '7', session_type: 'minds_eye', callback: { provider: 'web', channel: 'sub-2' }, last_active_at: ago(1000) }]);
      const res = await handle(req(method, proxy, body));
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).error, 'session_forbidden');
      assert.deepEqual(calls.map(c => c.body.tableName), ['PGC_Session'], 'nothing read past the session');
      assert.equal(sent.length, 0, 'nothing enqueued');
    });
  }

  it('the list asks for minds_eye sessions only, and leaves out one the principal may not see — its cursor past it', async () => {
    const mine   = { id: '11', session_type: 'minds_eye', callback: slackCallback, last_active_at: ago(1000) };
    const theirs = { id: '12', session_type: 'minds_eye', callback: { provider: 'web', channel: 'sub-2' }, last_active_at: ago(2000) };
    const extra  = { id: '13', session_type: 'minds_eye', callback: slackCallback, last_active_at: ago(3000) };
    stubServ([mine, theirs, extra]);

    const res  = await handle(req('GET', 'minds-eye/sessions', {}, { limit: '2' }));
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].body.filters, [{ column: 'session_type', op: 'eq', value: 'minds_eye' }]);
    assert.deepEqual(body.sessions.map(s => s.sessionId), [11]);
    assert.equal(body.cursor, theirs.last_active_at);
    assert.equal(body.more, true);
    assert.doesNotMatch(calls[1].body.selectSql, /\b12\b/, 'facts read for visible sessions only');
  });
});
