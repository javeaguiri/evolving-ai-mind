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

      case 'WORKFLOW_NOTIFY':
        await postWorkflowNotify(message);
        break;

      case 'CREATE_DOMAIN_RESULT':
        await postCreateDomainResult(message);
        break;

      case 'WORKFLOW_GATE':
        await postWorkflowGate(message);
        break;

      case 'WORKFLOW_ERROR':
        await postWorkflowError(message);
        break;

      case 'WORKFLOW_CANCELLED':
        await postWorkflowCancelled(message);
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

// Generic workflow notification — used by any workflow notify step
// that does not set a custom notify_type.
async function postWorkflowNotify(message) {
  const { callback, message: text, traceId, workflowRunId } = message;
  await routeCallback(callback, text, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `runId: ${workflowRunId} | traceId: ${traceId}`,
        },
      ],
    },
  ]);
  console.info('callback: WORKFLOW_NOTIFY posted', {
    channel: callback.channel,
    traceId,
  });
}

async function postCreateDomainResult(message) {
  // Step Processor sends: { type, workflowRunId, message, callback, traceId }
  // Legacy shape:         { type, callback, result: { message, ... }, traceId }
  const text     = message.message ?? message.result?.message ?? 'Domain created.';
  const callback = message.callback;
  await routeCallback(callback, text, [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
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
  console.info('callback: CREATE_DOMAIN_RESULT posted', {
    channel: callback.channel,
    traceId: message.traceId,
  });
}

// Replaced placeholder postDesignDomainResult — now receives pre-built blocks
// from design-domain.mjs. callback.mjs formats for the UI; block building is PROC's concern.
async function postDesignDomainGate(message) {
  const { callback, result } = message;
  const fallbackText = `🧠 Domain *${result.domain}* — ${result.tableCount} table(s) selected. Review and confirm.`;
  await routeCallback(callback, fallbackText, result.blocks);
  console.info('callback: DESIGN_DOMAIN_GATE posted', {
    channel:      callback.channel,
    domain:       result.domain,
    tableCount:   result.tableCount,
    workflowRunId: result.workflowRunId,
    traceId:      message.traceId,
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
// WORKFLOW_GATE — renders human_gate dialog as Slack Block Kit
// Translates the UI-neutral dialog (from Step Processor) to Block Kit blocks.
// gate_type is used as a layout hint only (e.g. whether to use chat.update).
// ---------------------------------------------------------------------------

async function postWorkflowGate(message) {
  const { callback, gate_type: gateType, dialog, workflowRunId, message_ts, traceId } = message;

  const blocks = dialogToBlocks(dialog, workflowRunId);
  const fallbackText = dialog?.fields?.find(f => f.type === 'typography')?.value
    ?? 'Workflow gate — please review and respond.';

  if (message_ts) {
    // remove_item re-render — update the existing message in-place
    await slack.chat.update({
      channel: callback.channel,
      ts:      message_ts,
      text:    fallbackText,
      blocks,
    });
  } else {
    // Initial gate post — new threaded message
    await routeCallback(callback, fallbackText, blocks);
  }

  console.info('callback: WORKFLOW_GATE posted', {
    channel:       callback.channel,
    gateType,
    workflowRunId,
    inPlace:       !!message_ts,
    traceId,
  });
}

/**
 * Translate a UI-neutral dialog object into Slack Block Kit blocks.
 * Each field type maps to one or more Block Kit blocks.
 *
 * @param {object} dialog           Resolved dialog from Step Processor
 * @param {number} workflowRunId    For encoding into button values
 * @returns {Array}                 Slack Block Kit blocks array
 */
function dialogToBlocks(dialog, workflowRunId) {
  const blocks = [];

  for (const field of (dialog?.fields ?? [])) {
    switch (field.type) {

      case 'typography':
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `🧠 ${field.value}` },
        });
        break;

      case 'list': {
        // Header showing item count (from label)
        if (field.label) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*${field.label}*` },
          });
        }
        // One section block per list item, with optional Remove button
        for (const item of (field.items ?? [])) {
          const sectionBlock = {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${item.primary}*${item.secondary ? `\n${item.secondary}` : ''}`,
            },
          };
          if (item.secondaryAction) {
            sectionBlock.accessory = {
              type:      'button',
              style:     item.secondaryAction.style === 'danger' ? 'danger' : 'default',
              text:      { type: 'plain_text', text: item.secondaryAction.label },
              action_id: `workflow_action_${item.id}`,
              value:     JSON.stringify({
                workflowRunId,
                action:       item.secondaryAction.action,
                responseData: { tableName: item.id },
              }),
              ...(item.secondaryAction.confirm ? {
                confirm: {
                  title:   { type: 'plain_text', text: 'Are you sure?' },
                  text:    { type: 'plain_text', text: item.secondaryAction.confirm },
                  confirm: { type: 'plain_text', text: 'Remove' },
                  deny:    { type: 'plain_text', text: 'Cancel' },
                },
              } : {}),
            };
          }
          blocks.push(sectionBlock);
        }
        break;
      }

      case 'textbox':
        blocks.push({
          type:    'input',
          label:   { type: 'plain_text', text: field.label ?? 'Input' },
          element: {
            type:        'plain_text_input',
            action_id:   field.name ?? 'text_input',
            placeholder: field.placeholder
              ? { type: 'plain_text', text: field.placeholder }
              : undefined,
          },
        });
        break;

      case 'radio': {
        const options = (field.options ?? []).map(o => ({
          text:  { type: 'plain_text', text: o.label },
          value: o.value,
        }));
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: field.label ?? 'Select one:' },
          accessory: {
            type:      'radio_buttons',
            action_id: field.name ?? 'radio',
            options,
          },
        });
        break;
      }

      case 'actions': {
        const elements = (field.buttons ?? []).map(btn => ({
          type:      'button',
          style:     btn.style === 'primary' ? 'primary' : btn.style === 'danger' ? 'danger' : undefined,
          text:      { type: 'plain_text', text: btn.label },
          action_id: `workflow_action_${btn.action}`,
          value:     JSON.stringify({ workflowRunId, action: btn.action }),
        }));
        if (elements.length > 0) {
          blocks.push({ type: 'actions', elements });
        }
        break;
      }

      default:
        console.warn('callback: unknown dialog field type', { type: field.type });
    }
  }

  return blocks;
}

async function postWorkflowError(message) {
  const { callback, step, message: errMessage, traceId, workflowRunId } = message;
  const text = `⚠️ Workflow step ${step} failed: ${errMessage}`;
  await routeCallback(callback, text, [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `runId: ${workflowRunId} | traceId: ${traceId}` }] },
  ]);
  console.info('callback: WORKFLOW_ERROR posted', { channel: callback.channel, traceId });
}

async function postWorkflowCancelled(message) {
  const { callback, traceId, workflowRunId } = message;
  const text = message.message ?? 'Workflow cancelled.';
  await routeCallback(callback, text, [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `runId: ${workflowRunId} | traceId: ${traceId}` }] },
  ]);
  console.info('callback: WORKFLOW_CANCELLED posted', { channel: callback.channel, traceId });
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
          value:     JSON.stringify({ workflowRunId, action: 'confirm', legacy: true }),
        },
        {
          type:      'button',
          text:      { type: 'plain_text', text: '❌ Not now' },
          action_id: 'help_cancel',
          value:     JSON.stringify({ workflowRunId, action: 'cancel', legacy: true }),
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
