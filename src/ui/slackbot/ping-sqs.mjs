// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/ping-sqs.mjs
// Handles POST /api/v1/ui/slack/ping-sqs
//
// Validates: SlackbotFunction → SQS → ProcStepOrchestrator → SQS → SlackCallbackListener → Slack
// Response:  Immediate ACK posted via chat.postMessage (returns ts for threading).
//            Threaded reply arrives ~5-10s later.
// If this fails after ping-api passes → SQS IAM, queue config, or orchestrator issue.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient } from '@slack/web-api';
import { err } from '../../shared/ping-utils.mjs';

const sqs = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — ping-sqs expects POST', req.correlationId);
  }

  const workflowId  = req.correlationId;
  const slackUser   = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';

  console.info('ping-sqs start', { workflowId, slackUser, slackChannel });

  // Post ACK via chat.postMessage so Slack returns a ts we can thread against.
  // Slash commands give us no thread_ts — this message becomes the thread root.
  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    '⏳ ping-sqs started — watch this thread for results',
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('ping-sqs: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:          'PING_SQS',
        workflowId,
        slackChannel,
        slackUser,
        slackThreadTs: ackTs,   // callback threads reply to this message
        hop:           1,
        enqueuedAt:    new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('ping-sqs enqueue error:', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  // Return empty 200 — Slack requires a response within 3s but we've already
  // posted the visible ACK above, so no body is needed here.
  return { statusCode: 200, body: '' };
}