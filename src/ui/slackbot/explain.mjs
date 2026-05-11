// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/explain.mjs
// Handles POST /api/v1/ui/slack/explain
//
// Accepts: /explain <session_id> <prompt>
// Opens a follow-up conversation anchored to a prior /chat session.
// ACKs immediately; enqueues EXPLAIN_QUERY to ProcFunction for async LLM call.
// ProcFunction loads the existing session entries and continues the conversation.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// session_id must be a positive integer
const SESSION_ID_RE = /^\d+$/;

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — explain expects POST', req.correlationId);
  }

  const text         = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  // Parse: first token is query_id, remainder is the prompt
  const spaceIdx = text.indexOf(' ');
  const queryId  = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const prompt   = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  if (!SESSION_ID_RE.test(queryId)) {
    return err(400, 'Usage: /explain <session_id> <your question>  (session_id must be a number)', req.correlationId);
  }
  if (!prompt) {
    return err(400, 'Usage: /explain <query_id> <your question>', req.correlationId);
  }

  console.info('slackbot/explain: received', { traceId, queryId, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `❓ ${prompt}`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('slackbot/explain: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'EXPLAIN_QUERY',
        traceId,
        queryId,
        prompt,
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
    console.error('slackbot/explain: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
