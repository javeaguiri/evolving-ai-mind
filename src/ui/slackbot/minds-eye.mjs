// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/minds-eye.mjs
// Handles POST /api/v1/ui/slack/minds-eye
//
// Entry point for the minds-eye agent Slack command.
// ACKs immediately; enqueues MINDS_EYE to ProcFunction for async agentic reasoning.
// The agent display name (e.g. "Novia") is a user preference in PGC_SystemContext —
// never referenced in system code.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — minds-eye expects POST', req.correlationId);
  }

  const prompt       = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  if (!prompt) {
    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify({ response_type: 'ephemeral', text: 'Usage: /novia <your message>' }),
    };
  }

  console.info('slackbot/minds-eye: received', { traceId, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `🧠 "${prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt}"`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('slackbot/minds-eye: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'MINDS_EYE',
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
    console.error('slackbot/minds-eye: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
