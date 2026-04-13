// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/create-workflow.mjs
// Handles POST /api/v1/ui/slack/create-workflow
//
// Accepts: /create-workflow <description>
// The full user input is passed through to proc/create-workflow.mjs which
// creates a PGC_WorkflowRun and enqueues WORKFLOW_STEP execute_top.
// Flow: SlackbotFunction → SQS WorkflowQueue → ProcFunction
//       → run-workflow.mjs (create_workflow steps)
//       → SQS CallbackResults → SlackCallbackListenerFunction → Slack thread
//
// domain is null on this direct path — no alias lookup runs here.
// analyze_and_design_workflow (step 7) extracts domain context from userInput.
//
// Response: Immediate ACK posted via chat.postMessage.
//           Threaded replies track workflow progress and human gate prompts.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — create-workflow expects POST', req.correlationId);
  }

  const userInput    = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  if (!userInput) {
    return err(400, 'Usage: /create-workflow <description>', req.correlationId);
  }

  console.info('create-workflow start', { traceId, userInput, slackUser, slackChannel });

  // Post ACK — becomes the thread root for all subsequent gate and result replies
  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `🧠 Building workflow for *${userInput}* — watch this thread for progress`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('create-workflow: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  // Enqueue to WorkflowQueue — ProcFunction dispatches to proc/create-workflow.mjs
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'CREATE_WORKFLOW',
        traceId,
        userInput,
        domain:    null,
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
    console.error('create-workflow: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
