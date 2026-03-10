// src/ui/slackbot/ping-sqs.mjs
// Handles POST /api/v1/ui/slack/ping-sqs
//
// Validates: SlackbotFunction → SQS → ProcStepOrchestrator → SQS → SlackCallbackListener → Slack
// Response:  Immediate ACK to Slack, threaded reply arrives ~5-10s later.
// If this fails after ping-api passes → SQS IAM, queue config, or orchestrator issue.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ok, err } from '../../shared/ping-utils.mjs';

const sqs = new SQSClient({});

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — ping-sqs expects POST', req.correlationId);
  }

  const workflowId  = req.correlationId;
  const slackUser   = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const threadTs    = req.body?.thread_ts  || null;

  console.info('ping-sqs enqueue', { workflowId, slackUser, slackChannel });

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:          'PING_SQS',
        workflowId,
        slackChannel,
        slackUser,
        slackThreadTs: threadTs,
        hop:           1,
        enqueuedAt:    new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('ping-sqs enqueue error:', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  // Immediate ACK — Slack requires response within 3 seconds
  return ok({
    success:       true,
    message:       '⏳ ping-sqs started — watch this thread for results',
    workflowId,
    correlationId: req.correlationId,
    timestamp:     new Date().toISOString(),
  }, req.correlationId);
}