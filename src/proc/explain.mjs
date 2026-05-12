// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/explain.mjs
// Handles POST /api/v1/proc/explain (HTTP test path) and
//         EXPLAIN_QUERY SQS WorkflowQueue messages (async production path).
//
// Flow:
//   1. Look up PGC_Session by query_id (UUID)
//   2. Store slack_thread_ts on session if not yet set (first /explain invocation)
//   3. Load existing PGC_SessionEntry rows (seq 1=user prompt, seq 2=assistant output)
//   4. Append new user entry (seq 3+)
//   5. Reconstruct messages array (reasoning excluded)
//   6. Call LLM (heavy model) with full context
//   7. INSERT PGC_SessionEntry for assistant response
//   8. Enqueue HUMAN_NOTIFICATION with response (surfaces reasoning from seq 2 if present)
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { ok, err }                       from '../shared/lambda-utils.mjs';
import { getRows, insertRow, updateRows } from '../shared/serv-client.mjs';
import { callLlmWithMessages }           from '../shared/llm-client.mjs';
import { enqueueCallback }               from '../shared/sqs-callback.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXPLAIN_MODEL = 'anthropic/claude-sonnet-4-5';

export async function handle(req) {
  const { queryId, prompt } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;
  const threadTs = callback?.threadId ?? null;

  if (!UUID_RE.test(queryId?.trim() ?? '')) {
    if (req.source === 'http') return err(400, 'queryId is required and must be a UUID', req.correlationId);
    return;
  }
  if (!prompt?.trim()) {
    if (req.source === 'http') return err(400, 'prompt is required', req.correlationId);
    return;
  }

  console.info('proc/explain: received', { traceId, queryId });

  // Look up session by query_id (UUID)
  const sessionResp = await getRows('PGC_Session', [
    { column: 'query_id', op: 'eq', value: queryId.trim() },
  ]);
  if (!sessionResp.success || sessionResp.count === 0) {
    const msg = `No session found for query_id ${queryId}`;
    if (req.source === 'http') return err(404, msg, req.correlationId);
    if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
    return;
  }
  const session = sessionResp.rows[0];

  // Establish thread on first invocation; use stored thread on subsequent calls
  // so all explain responses for a session always land in the same thread.
  let effectiveThreadId = session.slack_thread_ts ?? threadTs ?? null;
  if (!session.slack_thread_ts && threadTs) {
    await updateRows('PGC_Session',
      [{ column: 'id', op: 'eq', value: session.id }],
      { slack_thread_ts: threadTs }
    );
    effectiveThreadId = threadTs;
  }
  const responseCallback = callback ? { ...callback, threadId: effectiveThreadId } : null;

  // Load existing entries ordered by sequence_number
  const entriesResp = await getRows('PGC_SessionEntry',
    [{ column: 'session_id', op: 'eq', value: session.id }],
    { column: 'sequence_number', direction: 'asc' }
  );
  const existingEntries = entriesResp.rows ?? [];

  // Extract reasoning from seq 2 (assistant) for surfacing in reply
  const assistantEntry = existingEntries.find(e => e.role === 'assistant' && e.sequence_number === 2);
  const reasoning = assistantEntry?.reasoning ?? null;

  // Next sequence number
  const nextSeq = existingEntries.length > 0
    ? Math.max(...existingEntries.map(e => e.sequence_number)) + 1
    : 1;

  // INSERT new user turn — skip if the last entry is already this same user prompt
  // (guards against SQS at-least-once redelivery after a partial failure).
  const lastEntry       = existingEntries[existingEntries.length - 1];
  const alreadyInserted = lastEntry?.role === 'user' && lastEntry?.content === prompt.trim();
  const userSeq         = alreadyInserted ? lastEntry.sequence_number : nextSeq;
  if (!alreadyInserted) {
    await insertRow('PGC_SessionEntry', {
      session_id:      session.id,
      sequence_number: userSeq,
      role:            'user',
      content:         prompt.trim(),
    });
  }

  // Reconstruct messages array (role + content only — reasoning excluded)
  const messages = [
    ...existingEntries.map(e => ({ role: e.role, content: e.content })),
    { role: 'user', content: prompt.trim() },
  ];

  // Call LLM with full context
  const responseText = await callLlmWithMessages(EXPLAIN_MODEL, messages, traceId);

  // INSERT assistant response
  await insertRow('PGC_SessionEntry', {
    session_id:      session.id,
    sequence_number: userSeq + 1,
    role:            'assistant',
    content:         responseText,
  });

  console.info('proc/explain: response ready', { sessionId: session.id, traceId });

  // Enqueue Slack response — thread to established session thread.
  // Include queryId so callback.mjs renders "Ask follow-up" on every reply.
  // interactive.mjs disables the clicked button before opening the follow-up modal,
  // preventing stale button accumulation in the thread.
  if (responseCallback) {
    let replyText = responseText;
    if (reasoning && nextSeq === 3) {
      replyText = `*LLM reasoning for this output:*\n>${reasoning.replace(/\n/g, '\n>')}\n\n${responseText}`;
    }
    await enqueueCallback(responseCallback, {
      type:    'HUMAN_NOTIFICATION',
      traceId,
      message: replyText,
      queryId: session.query_id,
    });
  }

  if (req.source === 'http') {
    return ok({ success: true, sessionId: session.id, response: responseText }, req.correlationId);
  }
}
