// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/minds-eye/conversation.mjs
//
// Her region's decisions (docs/arch-web-app.md §4.1, §4.5; decisions Q, T, U), pure: what a
// session is called, how a conversation's pages come together, how a turn's calls draw as one
// line, how often an open conversation asks for more, and whether the region is collapsed on
// this device.

/**
 * What a session is called: its label, else its first message. Null for a session still
 * without either — the region words that itself. The renderer shortens it.
 *
 * @param {{ label?: string|null, firstMessage?: string|null }} session
 * @returns {string|null}
 */
export function sessionName(session) {
  const name = session?.label?.trim() || session?.firstMessage?.trim() || null;
  return name ? name.replace(/\s+/g, ' ') : null;
}

/**
 * A minds_eye panel's topic and the title it falls back to (§2.5): a domain's name, titled by the
 * domain's label, or free text, titled by itself.
 *
 * @param {{ domain?: string, topic?: string }} config
 * @param {{ domain: string, label?: string }[]} domains
 * @returns {{ topic: string, title: string }}
 */
export function panelTopic(config, domains) {
  if (config.domain) return { topic: config.domain, title: domains.find(d => d.domain === config.domain)?.label ?? config.domain };
  return { topic: config.topic, title: config.topic };
}

/** The query that lists sessions: a panel's topic, or none for her region. */
export function sessionsQuery(topic) {
  return topic ? { topic } : undefined;
}

/** What *New* sends: the text, and a panel's topic when it has one. */
export function startBody(text, topic) {
  return topic ? { text, topic } : { text };
}

const keyOf = m => (m.kind === 'person' ? `p${m.seq}` : `i${m.id}`);

/**
 * The conversation with a new page added: each message once, in the order sent. A page is
 * already in order; a message arriving twice (a poll overlapping a send) is kept once.
 *
 * @param {object[]} held
 * @param {object[]} arrived
 */
export function addConversation(held, arrived) {
  const seen = new Set(held.map(keyOf));
  return [...held, ...arrived.filter(m => !seen.has(keyOf(m)))];
}

/** A progress line from her: a turn's tool call, its parts as facts (decision T). */
export const isProgress = m =>
  m.kind === 'inbox' && m.messageType === 'HUMAN_NOTIFICATION' && Number.isInteger(m.payload?.turn);

/**
 * The conversation as it draws: a turn's progress lines, one after another, become one item
 * holding its calls — so a turn with three calls is one line, never three lines with the same
 * number. Everything else stays as it came.
 *
 * @param {object[]} messages
 * @returns {Array<object | { kind: 'turn', turn: number, key: string, calls: { call: string, detail: string|null, id: number }[] }>}
 */
export function groupTurns(messages) {
  const items = [];
  for (const m of messages) {
    if (!isProgress(m)) { items.push(m); continue; }
    const call = { call: m.payload.call ?? m.payload.message, detail: m.payload.detail ?? null, id: m.id };
    const last = items[items.length - 1];
    if (last?.kind === 'turn' && last.turn === m.payload.turn) last.calls.push(call);
    else items.push({ kind: 'turn', turn: m.payload.turn, key: `t${m.id}`, calls: [call] });
  }
  return items;
}

/** The longest a round can run (ProcFunction's timeout): her first message comes within it. */
export const ROUND_CEILING_MS = 240_000;

/**
 * Whether her early replies were never kept: a session older than the inbox (2026-11-15) kept
 * only the person's side. Her first message always arrives within a round of the session
 * starting, so a first kept message much later than that, or none in a session that has
 * stopped working, means the ones before it were lost.
 *
 * @param {{ createdAt: string, state: string }} session
 * @param {string|null} repliesKeptFrom   When her first kept message was written
 */
export function repliesMissing(session, repliesKeptFrom) {
  if (!repliesKeptFrom) return session.state !== 'working';
  return Date.parse(repliesKeptFrom) - Date.parse(session.createdAt) > ROUND_CEILING_MS;
}

/** How often an open conversation asks while she works, and while she waits on the person. */
export const WORKING_POLL_MS = 3_000;
export const WAITING_POLL_MS = 15_000;
export const POLL_MAX_MS     = 60_000;

/** The wait before the next read: by her state, doubling with each failure in a row. */
export function conversationDelay(failures, state) {
  const base = state === 'working' ? WORKING_POLL_MS : WAITING_POLL_MS;
  return Math.min(base * 2 ** failures, POLL_MAX_MS);
}

/** How often the session list is read again while the region is open. */
export const LIST_POLL_MS = 30_000;

/** Where this device remembers the region collapsed (§4.1). */
export const COLLAPSED_KEY = 'minds-eye.collapsed';

/** @param {Storage|null} storage */
export function readCollapsed(storage) {
  try { return storage?.getItem(COLLAPSED_KEY) === 'true'; } catch { return false; }
}

/** @param {Storage|null} storage */
export function writeCollapsed(storage, collapsed) {
  try { collapsed ? storage?.setItem(COLLAPSED_KEY, 'true') : storage?.removeItem(COLLAPSED_KEY); } catch { /* not kept */ }
}

/**
 * The location with her region open on a session, or closed on none — `?minds-eye=` beside
 * whatever else the location carries.
 *
 * @param {string} location   Path and query
 * @param {number|null} sessionId
 */
export function withSession(location, sessionId) {
  const at     = location.indexOf('?');
  const path   = at < 0 ? location : location.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : location.slice(at + 1));
  if (sessionId) params.set('minds-eye', String(sessionId));
  else params.delete('minds-eye');
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Her message the person can answer now: the gate she waits at, or her last reply when it
 * asks questions — never an older one. Null while she works, or when nothing is asked.
 *
 * @param {{ state: string, gate: object|null }|null} session
 * @param {object[]} messages
 * @returns {object|null}
 */
export function answerable(session, messages) {
  if (session?.state !== 'waiting') return null;
  const last = messages.findLast(m => m.kind === 'inbox');
  if (!last) return null;
  if (session.gate) return last.messageType === 'HUMAN_GATE' && last.payload?.atSeq === session.gate.atSeq ? last : null;
  return last.payload?.invitesReply && last.payload?.questions?.length ? last : null;
}

/** Past this many choices a question's options are a dropdown, as Slack's radio buttons stop at 10. */
export const RADIO_LIMIT = 10;

/**
 * A question's answer box, as a gate input (§5.3): its choices, or text.
 *
 * @param {{ id: string, options?: string[] }} question
 * @param {string} label
 */
export function answerField(question, label) {
  const options = (question.options ?? []).map(o => ({ value: o, label: o }));
  if (!options.length) return { name: `a-${question.id}`, input_type: 'textarea', label, optional: true };
  return { name: `a-${question.id}`, input_type: options.length <= RADIO_LIMIT ? 'radio' : 'select', label, optional: true, options };
}

/**
 * The answers to send — each question's answer and comment, those with something in them —
 * and the closing note. Null when nothing is filled in.
 *
 * @param {{ id: string }[]} questions
 * @param {Record<string, { answer?: string, comment?: string }>} values  By question id
 * @param {string} note
 * @returns {{ answers: object[], note: string|null } | null}
 */
export function answersFrom(questions, values, note) {
  const answers = questions
    .map(q => ({ id: q.id, answer: values[q.id]?.answer?.trim() || null, comment: values[q.id]?.comment?.trim() || null }))
    .filter(a => a.answer || a.comment);
  const kept = note?.trim() || null;
  return answers.length || kept ? { answers, note: kept } : null;
}

/** How long after a send the conversation reads at the working pace, waiting for her round to show. */
export const EXPECT_MS = 60_000;

/**
 * Whether the conversation is still waiting for its first sign of the round a send started: the
 * person's message stored, or the session working. Until then it reads at the working pace, so
 * what was sent shows within seconds; it gives up after EXPECT_MS.
 *
 * @param {{ since: number, persons: number }|null} expecting   When the send was, and the person's
 *                                                               messages held then
 * @param {{ persons: number, state: string|undefined, now: number }} seen
 */
export function stillExpecting(expecting, { persons, state, now }) {
  if (!expecting) return false;
  return persons <= expecting.persons && state !== 'working' && now - expecting.since < EXPECT_MS;
}

/** The person's messages a conversation holds. */
export const personCount = messages => messages.filter(m => m.kind === 'person').length;
