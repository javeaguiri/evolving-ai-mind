// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/minds-eye-sessions.mjs
//
// /api/v1/proc/minds-eye/sessions (docs/arch-web-app.md §4.5, decisions O, Q, S, U):
//   GET    /sessions[?topic=]          the minds_eye sessions the principal may see, by last activity
//   POST   /sessions                   start one — created here, then MINDS_EYE
//   PATCH  /sessions/{id}              set or clear its label
//   GET    /sessions/{id}/messages     its conversation: the person's entries and her inbox rows
//   POST   /sessions/{id}/messages     text or answers — MINDS_EYE, or a continue gate's follow-up
//   POST   /sessions/{id}/responses    answer the gate it is waiting at — MINDS_EYE_RESUME
//
// Only minds_eye sessions exist here: any other id is session_not_found. A session belongs to its
// callback (canSeeSession), and every message enqueued for it carries the session's own callback,
// so a Slack-started session continued on the web still replies in its thread.
//
// A session is waiting or working. Waiting: her last message is a reply that invites one, an
// error, or a gate still current (its atSeq is the session's latest entry), and the person has
// written nothing since. Working: a round is under way, or the person's message awaits one; a
// message is then refused (session_busy) so two rounds never run on one session — unless the
// last activity is older than the longest a round can run, so a round that died never leaves it
// stuck. Transport-agnostic — no AWS SDK, no Slack SDK.

import { randomUUID }                              from 'crypto';
import { respond, err }                            from '../shared/lambda-utils.mjs';
import { getRows, insertRow, updateRows, servPost } from '../shared/serv-client.mjs';
import { enqueueWorkflow, enqueueCallback }        from '../shared/sqs-callback.mjs';
import { readPrincipal, canSeeSession }            from './principal.mjs';

export const SESSIONS_DEFAULT_LIMIT = 20;
export const SESSIONS_MAX_LIMIT     = 100;
export const MESSAGES_DEFAULT_LIMIT = 50;
export const MESSAGES_MAX_LIMIT     = 200;

// ProcFunction's Timeout in template.yaml: no round outlives it (a test holds the two equal).
export const ROUND_CEILING_MS = 240_000;

const SESSION_COLUMNS = ['id', 'session_type', 'callback', 'topic', 'label', 'created_at', 'last_active_at'];
const INBOX_COLUMNS   = ['id', 'message_type', 'payload', 'created_at'];
const GATE_KINDS      = { minds_eye_gate: 'action', minds_eye_continue_gate: 'continue' };
const GATE_ACTIONS    = { action: ['approve', 'test', 'cancel'], continue: ['continue', 'end'] };

// What the person is shown once a gate is answered — the words Slack puts in the gate's place.
export const ANSWERED_TEXT = {
  approve:  '✅ Approved — executing…',
  test:     '✅ Approved — applying, then planning a test…',
  cancel:   '❌ Cancelled.',
  continue: '▶ Continuing…',
  end:      '⏹ Session ended.',
};

// ── Pure ─────────────────────────────────────────────────────────────────────

const whole = v => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);

/**
 * @returns {{ topic: string|null, limit: number, before: string|null } | { error: string }}
 */
export function parseSessionsQuery(query = {}) {
  const limit  = query.limit === undefined ? SESSIONS_DEFAULT_LIMIT : whole(query.limit);
  const before = query.before ?? null;
  if (Number.isNaN(limit) || limit < 1 || limit > SESSIONS_MAX_LIMIT) {
    return { error: `limit must be between 1 and ${SESSIONS_MAX_LIMIT}` };
  }
  if (before !== null && Number.isNaN(Date.parse(before))) return { error: 'before must be a date-time' };
  return { topic: query.topic?.trim() || null, limit, before };
}

/**
 * @returns {{ after: number, afterSeq: number, limit: number } | { error: string }}
 */
export function parseMessagesQuery(query = {}) {
  const after    = query.after    === undefined ? 0 : whole(query.after);
  const afterSeq = query.afterSeq === undefined ? 0 : whole(query.afterSeq);
  const limit    = query.limit    === undefined ? MESSAGES_DEFAULT_LIMIT : whole(query.limit);
  if (Number.isNaN(after))    return { error: 'after must be a whole number' };
  if (Number.isNaN(afterSeq)) return { error: 'afterSeq must be a whole number' };
  if (Number.isNaN(limit) || limit < 1 || limit > MESSAGES_MAX_LIMIT) {
    return { error: `limit must be between 1 and ${MESSAGES_MAX_LIMIT}` };
  }
  return { after, afterSeq, limit };
}

/**
 * Whether a session waits for the person, and at which gate.
 *
 * @param {object} facts
 * @param {object|null} facts.lastMessage   Its latest inbox row ({ message_type, payload, created_at })
 * @param {number|null} facts.latestSeq     Its latest entry's sequence_number
 * @param {string|null} facts.lastPersonAt  When the person's latest entry was written
 * @param {string}      facts.lastActiveAt  PGC_Session.last_active_at
 * @param {number}      [now]
 * @returns {{ state: 'waiting'|'working', gate: { kind: string, atSeq: number } | null }}
 */
export function sessionState({ lastMessage = null, latestSeq = null, lastPersonAt = null, lastActiveAt = null }, now = Date.now()) {
  const lastAt  = Math.max(Date.parse(lastActiveAt) || 0, Date.parse(lastMessage?.created_at) || 0);
  const working = { state: now - lastAt > ROUND_CEILING_MS ? 'waiting' : 'working', gate: null };
  // The person wrote after her last message: the round that answers it has not spoken yet.
  if (Date.parse(lastPersonAt) > (Date.parse(lastMessage?.created_at) || 0)) return working;
  const kind = lastMessage?.message_type === 'HUMAN_GATE' ? GATE_KINDS[lastMessage.payload?.gate_type] ?? null : null;
  if (kind && lastMessage.payload.atSeq != null && lastMessage.payload.atSeq === latestSeq) {
    return { state: 'waiting', gate: { kind, atSeq: latestSeq } };
  }
  if (!kind && (lastMessage?.message_type === 'WORKFLOW_ERROR' || lastMessage?.payload?.invitesReply)) {
    return { state: 'waiting', gate: null };
  }
  return working;
}

/**
 * One session as her region and a minds_eye panel list it (openapi MindsEyeSession).
 */
export function toSession(row, facts = {}, now = Date.now()) {
  const { state, gate } = sessionState({ ...facts, lastActiveAt: row.last_active_at }, now);
  return {
    sessionId:    Number(row.id),
    label:        row.label ?? null,
    firstMessage: facts.firstMessage ?? null,
    topic:        row.topic ?? null,
    provider:     row.callback?.provider === 'web' ? 'web' : 'slack',
    createdAt:    row.created_at,
    lastActiveAt: row.last_active_at,
    state,
    gate,
  };
}

/**
 * One page of a conversation: the person's entries and her inbox rows, each read with limit + 1,
 * merged by time (the person's first on a tie). The first `limit` of the merge are the
 * conversation's first `limit` past the cursors, since each list's unread rows come after every
 * row read from it.
 */
export function mergeConversation(entries, inbox, { after, afterSeq, limit }) {
  const items = [
    ...entries.map(e => ({ kind: 'person', seq: Number(e.sequence_number), text: e.content, createdAt: e.created_at })),
    ...inbox.map(m => ({ kind: 'inbox', id: Number(m.id), messageType: m.message_type, payload: m.payload, createdAt: m.created_at })),
  ].sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || (a.kind === 'person' ? -1 : 1));
  const messages = items.slice(0, limit);
  return {
    messages,
    cursor: {
      after:    Math.max(after,    ...messages.filter(m => m.kind === 'inbox').map(m => m.id)),
      afterSeq: Math.max(afterSeq, ...messages.filter(m => m.kind === 'person').map(m => m.seq)),
    },
    more: items.length > limit,
  };
}

/**
 * What a message to the session asks for, or why it is refused.
 *
 * @returns {{ text: string } | { answers: object[], note: string|null } | { error: string }}
 */
export function readMessageBody(body = {}) {
  if (typeof body.text === 'string' && body.text.trim()) return { text: body.text.trim() };
  const answers = Array.isArray(body.answers)
    ? body.answers.filter(a => typeof a?.id === 'string' && a.id)
      .map(a => ({ id: a.id, answer: a.answer ?? null, comment: a.comment ?? null }))
      .filter(a => (a.answer ?? '').trim() || (a.comment ?? '').trim())
    : [];
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  if (!answers.length && !note) return { error: 'text, or an answer or note, is required' };
  return { answers, note };
}

/**
 * The resume message a gate answer enqueues, or the refusal. `gateMessage` is the gate's inbox
 * row: what it carried (resetActionCount, afterTruncation, testLabel) is read from it, never
 * from the body.
 *
 * @returns {{ message: object } | { status: number, error: string }}
 */
export function gateAnswer({ state, gateMessage, sessionId, body = {} }) {
  const { atSeq, action } = body;
  if (!Number.isInteger(atSeq) || typeof action !== 'string') return { status: 400, error: 'missing_fields' };
  if (!state.gate) {
    const stale = gateMessage?.message_type === 'HUMAN_GATE' && GATE_KINDS[gateMessage.payload?.gate_type];
    return { status: 409, error: stale ? 'gate_moved' : 'gate_not_waiting' };
  }
  if (state.gate.atSeq !== atSeq) return { status: 409, error: 'gate_moved' };

  const { kind } = state.gate;
  const payload  = gateMessage.payload ?? {};
  if (!GATE_ACTIONS[kind].includes(action) || (action === 'test' && !payload.testLabel)) {
    return { status: 400, error: 'invalid_action' };
  }
  if (kind === 'action') {
    return { message: { type: 'MINDS_EYE_RESUME', sessionId, approved: action !== 'cancel', ...(action === 'test' ? { test: true } : {}), atSeq } };
  }
  return { message: {
    type:             'MINDS_EYE_RESUME',
    resumeType:       'continue',
    sessionId,
    approved:         action === 'continue',
    resetActionCount: !!payload.resetActionCount,
    atSeq,
    ...(payload.afterTruncation ? { afterTruncation: true } : {}),
  } };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Each session's latest entry, first message, the person's latest entry and latest inbox row,
 * in one read. The ids are
 * integers from PGC_Session, the only values in the statement.
 *
 * @param {number[]} ids
 * @returns {Promise<Map<number, { latestSeq: number|null, firstMessage: string|null, lastPersonAt: string|null, lastMessage: object|null }>>}
 */
async function readFacts(ids) {
  const facts = new Map();
  if (!ids.length) return facts;
  const resp = await servPost('/api/v1/serv/table/runSql', { target: 'pgc', selectSql: `
    SELECT s.id,
           (SELECT max(e.sequence_number) FROM "PGC_SessionEntry" e WHERE e.session_id = s.id) AS latest_seq,
           (SELECT e.content FROM "PGC_SessionEntry" e WHERE e.session_id = s.id AND e.role = 'user'
             ORDER BY e.sequence_number LIMIT 1) AS first_message,
           (SELECT max(e.created_at) FROM "PGC_SessionEntry" e WHERE e.session_id = s.id AND e.role = 'user') AS last_person_at,
           m.message_type, m.payload, m.created_at AS message_at
      FROM "PGC_Session" s
      LEFT JOIN LATERAL (
        SELECT u.message_type, u.payload, u.created_at FROM "PGC_UiMessage" u
         WHERE u.session_id = s.id ORDER BY u.id DESC LIMIT 1
      ) m ON true
     WHERE s.id IN (${ids.map(Number).join(', ')})` });
  for (const r of resp.rows ?? []) {
    facts.set(Number(r.id), {
      latestSeq:    r.latest_seq == null ? null : Number(r.latest_seq),
      firstMessage: r.first_message ?? null,
      lastPersonAt: r.last_person_at ?? null,
      lastMessage:  r.message_type ? { message_type: r.message_type, payload: r.payload, created_at: r.message_at } : null,
    });
  }
  return facts;
}

/**
 * The session the principal names, or the refusal: session_not_found for an id that is not a
 * minds_eye session, session_forbidden for one that is not theirs.
 */
async function loadSession(principal, sessionId) {
  const resp = await getRows('PGC_Session', [{ column: 'id', op: 'eq', value: sessionId }],
    undefined, 1, undefined, SESSION_COLUMNS);
  const row = resp.rows?.[0];
  if (!row || row.session_type !== 'minds_eye') return { status: 404, body: { error: 'session_not_found' } };
  if (!canSeeSession(principal, row))            return { status: 403, body: { error: 'session_forbidden' } };
  return { row };
}

export async function listSessions(principal, { topic, limit, before }) {
  const filters = [{ column: 'session_type', op: 'eq', value: 'minds_eye' }];
  if (topic)  filters.push({ column: 'topic', op: 'eq', value: topic });
  if (before) filters.push({ column: 'last_active_at', op: 'lt', value: before });
  const resp     = await getRows('PGC_Session', filters, { column: 'last_active_at', direction: 'desc' },
    limit + 1, undefined, SESSION_COLUMNS);
  const rows     = resp.rows ?? [];
  const examined = rows.slice(0, limit);
  const visible  = examined.filter(r => canSeeSession(principal, r));
  const facts    = await readFacts(visible.map(r => Number(r.id)));
  return {
    sessions: visible.map(r => toSession(r, facts.get(Number(r.id)))),
    cursor:   examined.length ? examined[examined.length - 1].last_active_at : null,
    more:     rows.length > limit,
  };
}

export async function readMessages(principal, sessionId, query) {
  const found = await loadSession(principal, sessionId);
  if (!found.row) return found;
  const bySession = [{ column: 'session_id', op: 'eq', value: sessionId }];
  const [facts, entries, inbox, first] = await Promise.all([
    readFacts([sessionId]),
    getRows('PGC_SessionEntry', [...bySession, { column: 'role', op: 'eq', value: 'user' }, { column: 'sequence_number', op: 'gt', value: query.afterSeq }],
      { column: 'sequence_number', direction: 'asc' }, query.limit + 1, undefined, ['sequence_number', 'content', 'created_at']),
    getRows('PGC_UiMessage', [...bySession, { column: 'id', op: 'gt', value: query.after }],
      { column: 'id', direction: 'asc' }, query.limit + 1, undefined, INBOX_COLUMNS),
    getRows('PGC_UiMessage', bySession, { column: 'id', direction: 'asc' }, 1, undefined, ['created_at']),
  ]);
  return { status: 200, body: {
    session: toSession(found.row, facts.get(sessionId)),
    ...mergeConversation(entries.rows ?? [], inbox.rows ?? [], query),
    repliesKeptFrom: first.rows?.[0]?.created_at ?? null,
  } };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function startSession(principal, body = {}, traceId = randomUUID()) {
  if (!principal.roles.includes('household')) return { status: 403, body: { error: 'household_required' } };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { status: 400, body: { error: 'missing_fields', message: 'text is required' } };
  const topic    = typeof body.topic === 'string' && body.topic.trim() ? body.topic.trim() : null;
  const callback = { provider: 'web', channel: principal.user };

  const resp = await insertRow('PGC_Session', {
    session_type: 'minds_eye', callback, topic, minds_eye_turn_count: 0, minds_eye_action_count: 0,
  });
  if (!resp.success) throw new Error(`PGC_Session insert failed: ${resp.error}`);
  const sessionId = Number(resp.row.id);

  await enqueueWorkflow({ type: 'MINDS_EYE', sessionId, prompt: text, user: principal.user, callback, traceId });
  console.info('proc/minds-eye-sessions: session started from the web', { sessionId, topic, traceId });
  return { status: 202, body: { sessionId } };
}

export async function renameSession(principal, sessionId, body = {}) {
  if (!('label' in body) || (body.label !== null && typeof body.label !== 'string')) {
    return { status: 400, body: { error: 'missing_fields', message: 'label is required — null clears it' } };
  }
  const found = await loadSession(principal, sessionId);
  if (!found.row) return found;
  const label = body.label?.trim() || null;
  await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: sessionId }], { label });
  const facts = await readFacts([sessionId]);
  return { status: 200, body: toSession({ ...found.row, label }, facts.get(sessionId)) };
}

export async function sendMessage(principal, sessionId, body = {}, traceId = randomUUID()) {
  const reply = readMessageBody(body);
  if (reply.error) return { status: 400, body: { error: 'missing_fields', message: reply.error } };
  const found = await loadSession(principal, sessionId);
  if (!found.row) return found;

  const facts = (await readFacts([sessionId])).get(sessionId) ?? {};
  const { state, gate } = sessionState({ ...facts, lastActiveAt: found.row.last_active_at });
  if (state === 'working')      return { status: 409, body: { error: 'session_busy' } };
  if (gate?.kind === 'action')  return { status: 409, body: { error: 'gate_waiting' } };

  const callback = found.row.callback;
  const base     = { sessionId, user: principal.user, callback, traceId };
  if (gate?.kind === 'continue' && reply.text) {
    await enqueueWorkflow({ type: 'MINDS_EYE_RESUME', resumeType: 'followup', followupText: reply.text,
      ...(facts.lastMessage.payload?.afterTruncation ? { afterTruncation: true } : {}), ...base });
  } else {
    await enqueueWorkflow({ type: 'MINDS_EYE', ...(reply.text ? { prompt: reply.text } : { answers: reply.answers, note: reply.note }), ...base });
  }
  console.info('proc/minds-eye-sessions: message sent', { sessionId, followup: gate?.kind === 'continue' && !!reply.text, traceId });
  return { status: 202, body: { sessionId } };
}

export async function answerSessionGate(principal, sessionId, body = {}, traceId = randomUUID()) {
  const found = await loadSession(principal, sessionId);
  if (!found.row) return found;

  const facts  = (await readFacts([sessionId])).get(sessionId) ?? {};
  const state  = sessionState({ ...facts, lastActiveAt: found.row.last_active_at });
  const answer = gateAnswer({ state, gateMessage: facts.lastMessage, sessionId, body });
  if (answer.error) return { status: answer.status, body: { error: answer.error } };

  // The answer is told first, so the session reads as working before the resume is consumed.
  const callback = found.row.callback;
  await enqueueCallback(callback, {
    type: 'HUMAN_NOTIFICATION', format: 'markdown', message: ANSWERED_TEXT[body.action], sessionId, traceId,
    ...(body.action === 'end' ? { invitesReply: true } : {}),
  });
  await enqueueWorkflow({ ...answer.message, user: principal.user, callback, traceId });
  console.info('proc/minds-eye-sessions: gate answered', { sessionId, action: body.action, traceId });
  return { status: 202, body: { sessionId } };
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function handle(req) {
  const segments  = (req.proxy || '').split('/').filter(Boolean);
  const sessionId = /^[1-9][0-9]{0,15}$/.test(segments[2] ?? '') ? Number(segments[2]) : null;
  const sub       = segments[3] ?? null;
  const method    = req.method;
  const notFound  = () => err(404, `minds-eye route not found: ${method} /${req.proxy}`, req.correlationId);

  if (segments[1] !== 'sessions' || segments.length > 4) return notFound();
  if (segments.length > 2 && sessionId === null)         return notFound();

  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);

  let result;
  if (segments.length === 2 && method === 'GET') {
    const query = parseSessionsQuery(req.query);
    if (query.error) return respond(400, { success: false, error: 'invalid_query', message: query.error }, req.correlationId);
    result = { status: 200, body: await listSessions(principal, query) };
  } else if (segments.length === 2 && method === 'POST') {
    result = await startSession(principal, req.body ?? {}, req.correlationId);
  } else if (segments.length === 3 && method === 'PATCH') {
    result = await renameSession(principal, sessionId, req.body ?? {});
  } else if (sub === 'messages' && method === 'GET') {
    const query = parseMessagesQuery(req.query);
    if (query.error) return respond(400, { success: false, error: 'invalid_query', message: query.error }, req.correlationId);
    result = await readMessages(principal, sessionId, query);
  } else if (sub === 'messages' && method === 'POST') {
    result = await sendMessage(principal, sessionId, req.body ?? {}, req.correlationId);
  } else if (sub === 'responses' && method === 'POST') {
    result = await answerSessionGate(principal, sessionId, req.body ?? {}, req.correlationId);
  } else {
    return notFound();
  }
  const { status, body } = result;
  return respond(status, { success: status < 300, ...body }, req.correlationId);
}
