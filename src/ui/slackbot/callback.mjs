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
    type:      message.type,
    traceId:   message.traceId,
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

      case 'CREATE_DOMAIN_RESULT':
        await postCreateDomainResult(message);
        break;

      case 'DESIGN_DOMAIN_GATE':
        await postDesignDomainGate(message);
        break;

      case 'DESIGN_DOMAIN_ERROR':
        await postDesignDomainError(message);
        break;

      case 'HELP_GATE':
        await postHelpGate(message);
        break;

      case 'HELP_RESULT':
        await postHelpResult(message);
        break;

      // Future result types added here:
      // case 'FLOW_RESULT': await postFlowResult(message); break;

      default:
        console.warn('callback: unknown message type', message.type);
    }

    return true;

  } catch (error) {
    console.error('callback: Slack post error', {
      type:    message.type,
      traceId: message.traceId,
      error:   error.message,
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
          text: `traceId: ${result.traceId} | hop1: ${result.hop1EnqueuedAt} | hop2: ${result.hop2ProcessedAt}`,
        },
      ],
    },
  ]);
  console.info('callback: Slack message posted', {
    channel: callback.channel,
    traceId: message.traceId,
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
          text: `traceId: ${result.traceId} | enqueued: ${result.enqueuedAt} | completed: ${result.completedAt}`,
        },
      ],
    },
  ]);
  console.info('callback: ping-e2e Slack message posted', {
    channel: callback.channel,
    traceId: message.traceId,
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
          text: `traceId: ${message.traceId}`,
        },
      ],
    },
  ]);
  console.info('callback: SERV notification posted', {
    channel: callback.channel,
    traceId: message.traceId,
  });
}

async function postCreateDomainResult(message) {
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
          text: `traceId: ${message.traceId} | completed: ${result.completedAt}`,
        },
      ],
    },
  ]);
  console.info('callback: create-domain result posted', {
    channel:    callback.channel,
    domainName: result.domainName,
    traceId:    message.traceId,
  });
}

// ---------------------------------------------------------------------------
// DESIGN_DOMAIN_GATE — renders the UI-neutral gate payload from design-domain.mjs
// into Slack Block Kit. All Slack-specific constructs live here, not in PROC.
//
// Handles two gateType values:
//   review_tables — initial and re-rendered table review (includes Remove buttons)
//   final_confirm — final creation confirmation (Proceed / Cancel)
// ---------------------------------------------------------------------------

async function postDesignDomainGate(message) {
  const { callback, result } = message;

  if (result.gateType === 'final_confirm') {
    await postDesignDomainFinalConfirm(callback, result, message.traceId);
    return;
  }

  // Default: review_tables gate
  await postDesignDomainReviewTables(callback, result, message.traceId);
}

async function postDesignDomainReviewTables(callback, result, traceId) {
  const { workflowRunId, domain, tableCount, tables, warning } = result;

  const blocks = [];

  // Live header — table count updates with each removal
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `🧠 Domain *${domain}* — ${tableCount} table${tableCount === 1 ? '' : 's'} selected` },
  });

  if (warning) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `⚠️ ${warning}` },
    });
  }

  blocks.push({ type: 'divider' });

  // One section per table: name + column summary + optional Remove button
  for (const table of tables) {
    const summaryLine = table.columnSummary
      ? `_${table.columnSummary}_`
      : '_no user columns_';

    const sectionBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${table.tableName}*\n${summaryLine}` },
    };

    // Parent tables (isParent: true) get no Remove button — child must be removed first
    if (!table.isParent) {
      sectionBlock.accessory = {
        type:      'button',
        style:     'danger',
        text:      { type: 'plain_text', text: '🗑️ Remove' },
        action_id: `remove_${table.tableName}`,
        value:     JSON.stringify({
          workflowRunId,
          action:    'remove_table',
          gateType:  'review_tables',
          tableName: table.tableName,
        }),
        confirm: {
          title:   { type: 'plain_text', text: 'Remove table?' },
          text:    { type: 'mrkdwn',     text: `Remove *${table.tableName}* from this domain?` },
          confirm: { type: 'plain_text', text: 'Remove' },
          deny:    { type: 'plain_text', text: 'Keep' },
        },
      };
    }

    blocks.push(sectionBlock);
  }

  blocks.push({ type: 'divider' });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type:      'button',
        style:     'primary',
        text:      { type: 'plain_text', text: '✅ Looks good' },
        action_id: 'review_confirm',
        value:     JSON.stringify({ workflowRunId, action: 'confirm', gateType: 'review_tables' }),
      },
      {
        type:      'button',
        text:      { type: 'plain_text', text: '❌ Cancel' },
        action_id: 'review_cancel',
        value:     JSON.stringify({ workflowRunId, action: 'cancel', gateType: 'review_tables' }),
      },
    ],
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `runId: ${workflowRunId} | traceId: ${traceId}` }],
  });

  const fallbackText = `🧠 Domain *${domain}* — ${tableCount} table(s). Review and confirm.`;
  await routeCallback(callback, fallbackText, blocks);
  console.info('callback: DESIGN_DOMAIN_GATE review_tables posted', {
    channel: callback.channel, domain, tableCount, workflowRunId, traceId,
  });
}

async function postDesignDomainFinalConfirm(callback, result, traceId) {
  const { workflowRunId, domain, tableCount } = result;

  const text   = `✅ Ready to create domain *${domain}* with ${tableCount} table${tableCount === 1 ? '' : 's'}. Proceed?`;
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
    {
      type: 'actions',
      elements: [
        {
          type:      'button',
          style:     'primary',
          text:      { type: 'plain_text', text: '✅ Create it' },
          action_id: 'final_create',
          value:     JSON.stringify({ workflowRunId, action: 'confirm', gateType: 'final_confirm' }),
        },
        {
          type:      'button',
          style:     'danger',
          text:      { type: 'plain_text', text: '❌ Cancel' },
          action_id: 'final_cancel',
          value:     JSON.stringify({ workflowRunId, action: 'cancel', gateType: 'final_confirm' }),
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `runId: ${workflowRunId} | traceId: ${traceId}` }],
    },
  ];

  await routeCallback(callback, text, blocks);
  console.info('callback: DESIGN_DOMAIN_GATE final_confirm posted', {
    channel: callback.channel, domain, tableCount, workflowRunId, traceId,
  });
}

async function postDesignDomainError(message) {
  const { callback, result } = message;
  await routeCallback(callback, result.error, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: result.error },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `runId: ${result.runId} | traceId: ${message.traceId}`,
        },
      ],
    },
  ]);
  console.info('callback: design-domain error posted', {
    channel: callback.channel,
    runId:   result.runId,
    traceId: message.traceId,
  });
}

// ---------------------------------------------------------------------------
// HELP handlers
// ---------------------------------------------------------------------------

/**
 * Post the Block Kit help gate — confirm/cancel buttons.
 * Button values encode { workflowRunId, action } so interactive.mjs
 * can route the response without a DB lookup.
 */
async function postHelpGate(message) {
  const { callback, result } = message;
  const { workflowRunId, traceId } = result;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '👋 *Welcome to evolving-mind!*\n\nI can help you build and manage data domains using natural language. Want to see what I can do?',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type:      'button',
          style:     'primary',
          text:      { type: 'plain_text', text: '✅ Yes, show me' },
          action_id: 'help_confirm',
          value:     JSON.stringify({ workflowRunId, action: 'confirm' }),
        },
        {
          type:      'button',
          text:      { type: 'plain_text', text: '❌ Not now' },
          action_id: 'help_cancel',
          value:     JSON.stringify({ workflowRunId, action: 'cancel' }),
        },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `traceId: ${traceId}` },
      ],
    },
  ];

  await routeCallback(callback, '👋 Welcome to evolving-mind! Want to see what I can do?', blocks);
  console.info('callback: HELP_GATE posted', { channel: callback.channel, traceId });
}

/**
 * Post the help result — plain threaded reply after user responds.
 */
async function postHelpResult(message) {
  const { callback, result } = message;
  await routeCallback(callback, result.message, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: result.message },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `traceId: ${result.traceId} | completed: ${result.completedAt}` },
      ],
    },
  ]);
  console.info('callback: HELP_RESULT posted', {
    channel:      callback.channel,
    userResponse: result.userResponse,
    traceId:      result.traceId,
  });
}
