// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/delete-workflow.mjs
// Handles POST /api/v1/ui/slack/delete-workflow
//
// Accepts: /delete-workflow <name>
// Flow: SlackbotFunction → SQS WorkflowQueue → ProcFunction (delete-workflow.mjs)
//       → SQS CallbackResults → SlackCallbackListenerFunction → Slack thread

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — delete-workflow expects POST', req.correlationId);
  }

  const name         = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  if (!name) {
    return err(400, 'Usage: /delete-workflow <name>', req.correlationId);
  }

  console.info('delete-workflow start', { traceId, name, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `⏳ Deleting workflow *${name}* — watch this thread for results`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('delete-workflow: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'DELETE_WORKFLOW',
        traceId,
        name,
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
    console.error('delete-workflow: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
