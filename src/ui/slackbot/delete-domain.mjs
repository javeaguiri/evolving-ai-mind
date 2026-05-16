// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/delete-domain.mjs
// Handles POST /api/v1/ui/slack/delete-domain
//
// Accepts: /delete-domain <domain>
// Flow: SlackbotFunction → SQS WorkflowQueue → ProcFunction (delete-domain.mjs)
//       → SQS CallbackResults → SlackCallbackListenerFunction → Slack thread

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — delete-domain expects POST', req.correlationId);
  }

  const domain       = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  if (!domain) {
    return err(400, 'Usage: /delete-domain <domain>', req.correlationId);
  }

  console.info('delete-domain start', { traceId, domain, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `⏳ Deleting domain *${domain}* — watch this thread for results`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('delete-domain: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'DELETE_DOMAIN',
        traceId,
        domain,
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
    console.error('delete-domain: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
