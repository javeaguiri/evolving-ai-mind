// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/create-domain.mjs
// Handles POST /api/v1/ui/slack/create-domain
//
// Accepts: /create-domain <domain-name>
// Validates: SlackbotFunction → SQS WorkflowQueue → ProcStepOrchestrator
//            → ServFunction (schema + table) → SQS CallbackResults
//            → SlackCallbackListenerFunction → Slack thread
//
// Response: Immediate ACK posted via chat.postMessage.
//           Threaded reply confirms domain creation with table list.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/ping-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — create-domain expects POST', req.correlationId);
  }

  // Slack slash command sends the argument in body.text
  const domainName   = (req.body?.text || '').trim().toLowerCase();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const workflowId   = req.correlationId;

  if (!domainName) {
    return err(400, 'Usage: /create-domain <domain-name>', req.correlationId);
  }

  console.info('create-domain start', { workflowId, domainName, slackUser, slackChannel });

  // Post ACK — becomes the thread root for the result reply
  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `⏳ Creating domain *${domainName}* — watch this thread for results`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('create-domain: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  // Enqueue to WorkflowQueue for ProcStepOrchestrator
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:       'CREATE_DOMAIN',
        workflowId,
        domainName,
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
    console.error('create-domain: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
