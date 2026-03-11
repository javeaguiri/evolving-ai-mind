// src/ui/slackbot/ping-e2e.mjs
// Handles POST /api/v1/ui/slack/ping-e2e
//
// Validates: SlackbotFunction → SQS → ProcStepOrchestrator → ServFunction
//            → SQS SlackResults → SlackCallbackListener → Slack thread
// Response:  Immediate ACK posted via chat.postMessage (returns ts for threading).
//            Threaded reply with RDS version string arrives ~5-10s later.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient } from '@slack/web-api';
import { err } from '../../shared/ping-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — ping-e2e expects POST', req.correlationId);
  }

  const workflowId   = req.correlationId;
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';

  console.info('ping-e2e start', { workflowId, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    '⏳ ping-e2e started — watch this thread for results',
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('ping-e2e: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:          'PING_E2E',
        workflowId,
        slackChannel,
        slackUser,
        slackThreadTs: ackTs,
        hop:           1,
        enqueuedAt:    new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('ping-e2e enqueue error:', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}