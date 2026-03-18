// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/help.mjs
// Handles POST /api/v1/ui/slack/help
//
// Accepts: /help
// Flow: SlackbotFunction → SQS WorkflowQueue → ProcFunction
//       → SQS CallbackResults → SlackCallbackListenerFunction → Slack thread
//
// Today: posts a confirmation gate to prove the interactive loop end-to-end.
// Future: queries PGC_DomainHelp + PGC_Capability to return dynamic help buttons
//         reflecting what this instance has actually built.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — help expects POST', req.correlationId);
  }

  const slackChannel = req.body?.channel_id || 'unknown';
  const slackUser    = req.body?.user_id    || 'unknown';
  const traceId      = req.correlationId;

  console.info('help: received', { traceId, slackUser, slackChannel });

  // Post ACK — becomes the thread root for all follow-up replies
  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    '🧠 evolving-mind is here — loading help...',
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('help: Slack ACK failed', { error: error.message, traceId });
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  // Enqueue HELP message to WorkflowQueue — ProcFunction handles the next step
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'HELP',
        traceId,
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
    console.error('help: SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
