// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/mind.mjs
// Handles POST /api/v1/ui/slack/mind
//
// Accepts: /mind <natural language>
// Primary entry point for all natural language interaction with the brain.
// Three-tier classification (exact match → alias+CRUD → LLM) runs in PROC.
//
// Response: Immediate ACK posted via chat.postMessage.
//           Classification result and workflow handoff posted to thread async.
//
// Session lookup (Phase 3):
//   If thread_ts present → getRows PGC_Session by callback.threadId to retrieve sessionId.
//   If not found or absent → generate fresh UUID; PROC creates PGC_Session on receipt.
//   Until Phase 3 lands, sessionId is always a fresh UUID and PROC ignores it.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { randomUUID }                    from 'crypto';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — mind expects POST', req.correlationId);
  }

  const userInput    = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const threadTs     = req.body?.thread_ts  || null;
  const traceId      = req.correlationId;

  if (!userInput) {
    return err(400, 'Usage: /mind <what you want to do>', req.correlationId);
  }

  console.info('mind start', {
    traceId,
    slackUser,
    slackChannel,
    threadTs,
    inputLen:     userInput.length,
    inputPreview: userInput.slice(0, 80) + (userInput.length > 80 ? '…' : ''),
  });

  // Phase 3 — session lookup:
  // If threadTs is present, query PGC_Session by callback->>'threadId' = threadTs.
  // Found → use existing sessionId. Not found → generate new UUID.
  // Until Phase 3 lands, always generate a fresh UUID.
  const sessionId = randomUUID();

  // Post ACK — becomes the thread root for all async replies from this intent.
  // Echo the user's input (truncated to 100 chars) so the thread is self-describing.
  // Strip Slack file/attachment tokens (<@U...>, <http...>, <!...>) — these are
  // references to uploads or special mentions that have no useful text representation.
  const sanitised = userInput
    .replace(/<[^>]+>/g, '')   // remove Slack angle-bracket tokens (files, links, mentions)
    .replace(/\s+/g, ' ')      // collapse whitespace left by removed tokens
    .trim();
  const ackText = sanitised.length > 100
    ? `🧠 "${sanitised.slice(0, 100)}…"`
    : `🧠 "${sanitised}"`;

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    ackText,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('mind: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  // Enqueue CLASSIFY_INTENT to WorkflowQueue — ProcFunction handles async
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'CLASSIFY_INTENT',
        traceId,
        userInput,
        sessionId,
        slackUser,
        callback: {
          provider: 'slack',
          channel:  slackChannel,
          threadId: ackTs,
        },
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('mind: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
