// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/explain.mjs
// Handles POST /api/v1/ui/slack/explain
//
// Accepts: /explain <run_id>
// run_id (PGC_WorkflowRun.id) is always resolved to a step-selection button list
// (one per llm_call step in that run, even when there's only one) — a query_id
// is never typed by the user. Picking a step opens a modal to collect the
// question, then enqueues EXPLAIN_QUERY with the resolved query_id internally.
// ACKs immediately; enqueues EXPLAIN_QUERY (runId only) to ProcFunction for async
// step resolution.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

// Slack slash command validation errors must return 200 so the message renders in-channel.
// Non-200 responses produce a generic Slack error that hides the usage hint.
function slackErr(message) {
  return {
    statusCode: 200,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify({ response_type: 'ephemeral', text: message }),
  };
}

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// run_id is a plain PGC_WorkflowRun.id integer
const RUN_ID_RE = /^\d+$/;

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — explain expects POST', req.correlationId);
  }

  const text         = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  if (!RUN_ID_RE.test(text)) {
    return slackErr('Usage: /explain <run_id>');
  }

  console.info('slackbot/explain: received', { traceId, runId: text, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `🔍 Looking up LLM steps for run ${text}...`,
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
        runId:     Number(text),
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
