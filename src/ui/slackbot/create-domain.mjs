// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/create-domain.mjs
// Handles POST /api/v1/ui/slack/create-domain
//
// Accepts: /create-domain <description>
// The full user input is passed to the LLM which infers a clean domain name.
// Validates: SlackbotFunction → SQS WorkflowQueue → ProcFunction
//            → ServFunction (schema + table) → SQS CallbackResults
//            → SlackCallbackListenerFunction → Slack thread
//
// Response: Immediate ACK posted via chat.postMessage.
//           Threaded reply confirms domain creation with table list.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — create-domain expects POST', req.correlationId);
  }

  // Pass the full Slack text to the LLM — it infers a clean domain name
  const userInput    = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  if (!userInput) {
    return err(400, 'Usage: /create-domain <description>', req.correlationId);
  }

  console.info('create-domain start', { traceId, userInput, slackUser, slackChannel });

  // Post ACK — becomes the thread root for the result reply
  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `⏳ Designing domain for *${userInput}* — watch this thread for results`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('create-domain: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  // Enqueue to WorkflowQueue — ProcFunction handles async via SQS trigger
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:       'DESIGN_DOMAIN',
        traceId,
        userInput,
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
