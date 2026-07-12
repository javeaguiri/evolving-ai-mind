// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/explain.mjs
// Handles POST /api/v1/proc/explain (HTTP test path) and
//         EXPLAIN_QUERY SQS WorkflowQueue messages (async production path).
//
// The /explain slash command only ever sends { runId } — a user never types or
// sees a query_id. The queryId + prompt path below is internal plumbing, reached
// only from interactive.mjs (step-select modal submission, or the "Ask follow-up"
// button on an existing explain reply), never directly from the slash command.
//
// Flow:
//   0. If runId given (slash command path — never carries a prompt), resolve it
//      against PGC_Session.run_id — 0 sessions -> notify not found; otherwise
//      always post an EXPLAIN_STEP_SELECT button list (one button per llm_call
//      step, even when there's only one) and stop. The question is only ever
//      collected via modal after a specific step is chosen — see interactive.mjs.
//   1. Look up PGC_Session by query_id (UUID)
//   2. Store slack_thread_ts on session if not yet set (first /explain invocation)
//   3. Load existing PGC_SessionEntry rows — llm-harness.mjs seeds 3 (system:
//      the original llm_call's full prompt_text, user: its resolved input,
//      assistant: its raw output) before any explain Q&A is appended
//   4. Append new user entry
//   5. Reconstruct messages array (reasoning excluded) — found by role, not a
//      hardcoded sequence number, since the seed-entry count above is not
//      part of this module's contract
//   6. Call LLM (heavy model) with full context
//   7. INSERT PGC_SessionEntry for assistant response
//   8. Enqueue HUMAN_NOTIFICATION with response (surfaces reasoning from the
//      original assistant entry, on the first reply only)
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { ok, err }                       from '../shared/lambda-utils.mjs';
import { getRows, insertRow, updateRows } from '../shared/serv-client.mjs';
import { callLlmWithMessages }           from '../shared/llm-client.mjs';
import { enqueueCallback }               from '../shared/sqs-callback.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXPLAIN_MODEL = 'anthropic/claude-sonnet-4-5';

const EXPLAIN_SYSTEM_PROMPT = `You are an analytical assistant helping the user understand and interpret outputs from the evolving-mind-ai workflow system. You receive a workflow execution context as conversation history and answer the user's follow-up questions about it.

── FORMATTING ────────────────────────────────────────────────────────────────────
Your response is rendered in Slack using markdown. Use standard markdown:

**bold**  _italic_  \`inline code\`  **_bold italic_**
> blockquote for quoting source data
\`\`\`
code blocks for structured data or multi-line examples
\`\`\`

Respond in clear prose. Do not return raw JSON objects unless the user explicitly asks for them. When referencing data from the workflow context, summarise it in readable sentences. Use bullet points and headers to organise longer answers.`;

export async function handle(req) {
  const { queryId: queryIdInput, runId, prompt } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;
  const threadTs = callback?.threadId ?? null;

  let queryId = queryIdInput;

  // run_id form: never carries a prompt — always resolve to a step-selection button
  // list (even for a single session) so the question is only ever collected after a
  // specific llm_call step has been chosen.
  if (!queryId && runId) {
    const runSessionsResp = await getRows('PGC_Session',
      [{ column: 'run_id', op: 'eq', value: runId }],
      { column: 'id', direction: 'asc' }
    );
    const runSessions = runSessionsResp.rows ?? [];

    if (runSessions.length === 0) {
      const msg = `No diagnostic sessions found for run ${runId}.`;
      if (req.source === 'http') return err(404, msg, req.correlationId);
      if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
      return;
    }

    console.info('proc/explain: presenting step picker for run', {
      runId, traceId, count: runSessions.length,
    });
    if (callback) {
      await enqueueCallback(callback, {
        type:  'EXPLAIN_STEP_SELECT',
        traceId,
        runId,
        steps: runSessions.map(s => ({
          queryId:        s.query_id,
          stepId:         s.step_id,
          intentCategory: s.intent_category,
        })),
      });
    }
    if (req.source === 'http') {
      return ok({ success: true, stepSelectionRequired: true, steps: runSessions.length }, req.correlationId);
    }
    return;
  }

  // query_id form (direct, or resumed after the step-picker modal is submitted)
  // always requires a prompt.
  if (!prompt?.trim()) {
    if (req.source === 'http') return err(400, 'prompt is required', req.correlationId);
    return;
  }

  if (!UUID_RE.test(queryId?.trim() ?? '')) {
    if (req.source === 'http') return err(400, 'queryId is required and must be a UUID (or provide a valid runId)', req.correlationId);
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

  // Extract reasoning from the first assistant entry (the original llm_call's
  // own output) for surfacing in reply — found by role, not a hardcoded
  // sequence number, since llm-harness.mjs's seed-entry count for a session
  // is not part of this module's contract and has already changed once.
  const assistantEntry = existingEntries.find(e => e.role === 'assistant');
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

  // Reconstruct messages array (role + content only — reasoning excluded).
  // System prompt is injected first to set formatting expectations; it is not
  // stored in PGC_SessionEntry so it does not accumulate across turns.
  // When alreadyInserted, the user turn is already in existingEntries — don't append again.
  const messages = [
    { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
    ...existingEntries.map(e => ({ role: e.role, content: e.content })),
    ...(alreadyInserted ? [] : [{ role: 'user', content: prompt.trim() }]),
  ];

  // Call LLM with full context
  let responseText;
  try {
    responseText = await callLlmWithMessages(EXPLAIN_MODEL, messages, traceId);
  } catch (llmErr) {
    console.error('proc/explain: LLM call failed', { traceId, error: llmErr.message });
    if (responseCallback) {
      await enqueueCallback(responseCallback, {
        type:    'HUMAN_NOTIFICATION',
        format:  'markdown',
        traceId,
        message: `*/explain* could not complete — LLM error: ${llmErr.message}`,
      });
    }
    if (req.source === 'http') return err(502, llmErr.message, req.correlationId);
    return;
  }

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
    // Surface reasoning only on the very first follow-up — i.e. this new turn
    // immediately follows the original assistant entry, with no prior explain
    // Q&A in between. Checked by position relative to assistantEntry itself,
    // not a hardcoded sequence number, for the same reason as the lookup above.
    if (reasoning && assistantEntry && nextSeq === assistantEntry.sequence_number + 1) {
      replyText = `*LLM reasoning for this output:*\n>${reasoning.replace(/\n/g, '\n>')}\n\n${responseText}`;
    }
    await enqueueCallback(responseCallback, {
      type:    'HUMAN_NOTIFICATION',
      format:  'markdown',
      traceId,
      message: replyText,
      queryId: session.query_id,
    });
  }

  if (req.source === 'http') {
    return ok({ success: true, sessionId: session.id, response: responseText }, req.correlationId);
  }
}
