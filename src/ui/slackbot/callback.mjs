// src/ui/slackbot/callback.mjs
// SQS-triggered Lambda — consumes SYSSQSSlackResults messages.
// Posts threaded replies back to Slack for async workflow completions.
// No HTTP trigger — fires only when a message lands on SYSSQSSlackResults.

import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handler(event) {
  const failures = [];

  for (const record of event.Records) {
    const success = await processRecord(record);
    if (!success) {
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

async function processRecord(record) {
  const messageId = record.messageId;

  let message;
  try {
    message = JSON.parse(record.body);
  } catch (error) {
    console.error('callback: invalid JSON', { messageId, error: error.message });
    return true; // discard unparseable messages
  }

  console.info('callback received', {
    type:       message.type,
    workflowId: message.workflowId,
    messageId,
  });

  try {
    switch (message.type) {

      case 'PING_SQS_RESULT':
        await postPingSqsResult(message);
        break;

      // Future result types added here:
      // case 'FLOW_RESULT': await postFlowResult(message); break;

      default:
        console.warn('callback: unknown message type', message.type);
    }

    return true;

  } catch (error) {
    console.error('callback: Slack post error', {
      type:       message.type,
      workflowId: message.workflowId,
      error:      error.message,
    });
    return false; // return to queue for retry
  }
}

async function postPingSqsResult(message) {
  const { slackChannel, slackThreadTs, result } = message;

  await slack.chat.postMessage({
    channel:   slackChannel,
    thread_ts: slackThreadTs || undefined,
    text:      result.message,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: result.message,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `workflowId: ${result.workflowId} | hop1: ${result.hop1EnqueuedAt} | hop2: ${result.hop2ProcessedAt}`,
          },
        ],
      },
    ],
  });

  console.info('callback: Slack message posted', {
    channel:   slackChannel,
    workflowId: message.workflowId,
  });
}