// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/explain.mjs
// Handles POST /api/v1/proc/explain (HTTP test path) and
//         EXPLAIN_QUERY SQS WorkflowQueue messages (async production path).
//
// Flow:
//   1. Look up PGC_Session by query_id
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

const EXPLAIN_MODEL = 'anthropic/claude-sonnet-4-5';

export async function handle(req) {
  const { queryId, prompt } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;
  const threadTs = callback?.threadId ?? null;

  if (!queryId?.trim()) {
    if (req.source === 'http') return err(400, 'queryId is required', req.correlationId);
    return;
  }
  if (!prompt?.trim()) {
    if (req.source === 'http') return err(400, 'prompt is required', req.correlationId);
    return;
  }

  console.info('proc/explain: received', { traceId, queryId });

  // Look up session by query_id
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

  // Store slack_thread_ts on first /explain invocation
  if (!session.slack_thread_ts && threadTs) {
    await updateRows('PGC_Session',
      [{ column: 'id', op: 'eq', value: session.id }],
      { slack_thread_ts: threadTs }
    );
  }

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

  // INSERT new user turn
  await insertRow('PGC_SessionEntry', {
    session_id:      session.id,
    sequence_number: nextSeq,
    role:            'user',
    content:         prompt.trim(),
  });

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
    sequence_number: nextSeq + 1,
    role:            'assistant',
    content:         responseText,
  });

  console.info('proc/explain: response ready', { sessionId: session.id, traceId });

  // Enqueue Slack response — surface reasoning if present on first explain turn
  if (callback) {
    let replyText = responseText;
    if (reasoning && nextSeq === 3) {
      replyText = `*LLM reasoning for this output:*\n>${reasoning.replace(/\n/g, '\n>')}\n\n${responseText}`;
    }
    await enqueueCallback(callback, {
      type:    'HUMAN_NOTIFICATION',
      traceId,
      message: replyText,
    });
  }

  if (req.source === 'http') {
    return ok({ success: true, sessionId: session.id, response: responseText }, req.correlationId);
  }
}
