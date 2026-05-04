// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/chat.mjs
// Handles POST /api/v1/ui/slack/chat
//
// Accepts: /chat <prompt>
// Starts a general-purpose LLM conversation session.
// ACKs immediately; enqueues CHAT_MESSAGE to ProcFunction for async LLM call.
// ProcFunction stores session entries, calls LLM, replies in thread.
// Thread replies from the user continue the session (future: Events API).

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — chat expects POST', req.correlationId);
  }

  const prompt       = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  if (!prompt) {
    return err(400, 'Usage: /chat <your message>', req.correlationId);
  }

  console.info('slackbot/chat: received', { traceId, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `💬 "${prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt}"`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('slackbot/chat: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'CHAT_MESSAGE',
        traceId,
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
    console.error('slackbot/chat: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
