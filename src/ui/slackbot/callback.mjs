// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/callback.mjs
// SQS-triggered Lambda — consumes SYSSQSCallbackResults messages.
// Routes on callback.provider and posts replies back to the originating UI.
// No HTTP trigger — fires only when a message lands on SYSSQSCallbackResults.
//
// Adding a new UI provider:
//   1. Add a case to routeCallback() below.
//   2. No new queue or Lambda needed for the common case.

import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Provider router — add new UI providers here.
// callback: { provider, channel, threadId }
// ---------------------------------------------------------------------------
async function routeCallback(callback, text, blocks) {
  switch (callback?.provider) {
    case 'slack':
      await slack.chat.postMessage({
        channel:   callback.channel,
        thread_ts: callback.threadId || undefined,
        text,
        blocks,
      });
      break;

    // Future providers:
    // case 'teams': await postToTeams(callback, text, blocks); break;
    // case 'webhook': await postToWebhook(callback, text); break;

    default:
      console.warn('callback: unknown provider', callback?.provider);
  }
}

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

      case 'PING_E2E_RESULT':
        await postPingE2eResult(message);
        break;
		
	  case 'SERV_NOTIFICATION':
        await postServNotification(message);
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
  const { callback, result } = message;
  await routeCallback(callback, result.message, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: result.message },
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
  ]);
  console.info('callback: Slack message posted', {
    channel:    callback.channel,
    workflowId: message.workflowId,
  });
}

async function postPingE2eResult(message) {
  const { callback, result } = message;
  await routeCallback(callback, result.message, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: result.message },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `workflowId: ${result.workflowId} | enqueued: ${result.enqueuedAt} | completed: ${result.completedAt}`,
        },
      ],
    },
  ]);
  console.info('callback: ping-e2e Slack message posted', {
    channel:    callback.channel,
    workflowId: message.workflowId,
  });
}

async function postServNotification(message) {
  const { callback, result } = message;
  await routeCallback(callback, result.message, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: result.message },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `workflowId: ${message.workflowId}`,
        },
      ],
    },
  ]);
  console.info('callback: SERV notification posted', {
    channel:    callback.channel,
    workflowId: message.workflowId,
  });
}