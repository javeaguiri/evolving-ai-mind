// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/chat.mjs
// Handles POST /api/v1/proc/chat (HTTP test path) and
//         CHAT_MESSAGE SQS WorkflowQueue messages (async production path).
//
// Flow:
//   1. Read general_chat_system_prompt from PGC_SystemContext
//   2. INSERT PGC_Session (general_chat, slack_thread_ts from callback.threadId)
//   3. INSERT PGC_SessionEntry seq=1 (system), seq=2 (user)
//   4. Call LLM (lightweight model)
//   5. INSERT PGC_SessionEntry seq=3 (assistant)
//   6. Enqueue HUMAN_NOTIFICATION with response
//
// Thread continuation: future Slack Events API integration will route thread
// replies here by looking up PGC_Session.slack_thread_ts.
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { ok, err }                       from '../shared/lambda-utils.mjs';
import { getRows, insertRow, updateRows } from '../shared/serv-client.mjs';
import { callLlmWithMessages }           from '../shared/llm-client.mjs';
import { enqueueCallback }               from '../shared/sqs-callback.mjs';

const CHAT_MODEL = 'perplexity/sonar';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant integrated into evolving-mind-ai, a personal cognitive automation system. Answer clearly and concisely.';

export async function handle(req) {
  const { prompt, slackUser } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;
  const threadTs = callback?.threadId ?? null;

  if (!prompt?.trim()) {
    if (req.source === 'http') return err(400, 'prompt is required', req.correlationId);
    return;
  }

  console.info('proc/chat: received', { traceId, slackUser });

  // Read system prompt from PGC_SystemContext
  const ctxResp = await getRows('PGC_SystemContext', [
    { column: 'key', op: 'eq', value: 'general_chat_system_prompt' },
  ]);
  const systemPrompt = ctxResp.rows?.[0]?.content ?? DEFAULT_SYSTEM_PROMPT;

  // INSERT PGC_Session
  const sessionResp = await insertRow('PGC_Session', {
    session_type:    'general_chat',
    slack_thread_ts: threadTs,
  });
  if (!sessionResp.success) throw new Error(`PGC_Session insert failed: ${sessionResp.error}`);
  const sessionId = sessionResp.row.id;

  console.info('proc/chat: session created', { sessionId, traceId });

  // INSERT seq=1 (system), seq=2 (user)
  await insertRow('PGC_SessionEntry', {
    session_id: sessionId, sequence_number: 1, role: 'system', content: systemPrompt,
  });
  await insertRow('PGC_SessionEntry', {
    session_id: sessionId, sequence_number: 2, role: 'user', content: prompt.trim(),
  });

  // Call LLM
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: prompt.trim() },
  ];
  const responseText = await callLlmWithMessages(CHAT_MODEL, messages, traceId);

  // INSERT seq=3 (assistant)
  await insertRow('PGC_SessionEntry', {
    session_id: sessionId, sequence_number: 3, role: 'assistant', content: responseText,
  });

  console.info('proc/chat: response ready', { sessionId, traceId });

  // Enqueue Slack response
  if (callback) {
    await enqueueCallback(callback, {
      type:    'HUMAN_NOTIFICATION',
      traceId,
      message: responseText,
      queryId: sessionResp.row.query_id,
    });
  }

  if (req.source === 'http') {
    return ok({ success: true, sessionId, queryId: sessionResp.row.query_id, response: responseText }, req.correlationId);
  }
}
