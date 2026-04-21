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
//
// Slack section blocks have a 3000-character hard limit. Long workflow
// results (e.g. recipes with many ingredients and steps) exceed this.
// Split on newlines into chunks ≤ BLOCK_CHAR_LIMIT — one section block
// per chunk. The context block is always appended last and is always short.
async function postWorkflowNotify(message) {
  const { callback, message: text, traceId, workflowRunId } = message;
  const contextText = workflowRunId
    ? `runId: ${workflowRunId} | traceId: ${traceId}`
    : `traceId: ${traceId}`;

  const BLOCK_CHAR_LIMIT = 2800;
  const blocks = [];

  if (text.length <= BLOCK_CHAR_LIMIT) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  } else {
    // Split on newlines and accumulate into ≤2800-char chunks
    const lines  = text.split('\n');
    let   chunk  = '';
    for (const line of lines) {
      const candidate = chunk ? chunk + '\n' + line : line;
      if (candidate.length > BLOCK_CHAR_LIMIT) {
        if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
        // If a single line itself exceeds the limit, hard-truncate it
        chunk = line.length > BLOCK_CHAR_LIMIT ? line.slice(0, BLOCK_CHAR_LIMIT - 3) + '...' : line;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: contextText }],
  });

  await routeCallback(callback, text.slice(0, 150), blocks);
  console.info('callback: WORKFLOW_NOTIFY posted', {
    channel:    callback.channel,
    traceId,
    blockCount: blocks.length,
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

  // text_input gates are handled via Slack modal opened in interactive.mjs.
  // The modal is already open at this point — nothing to post.
  if (gateType === 'text_input') {
    console.info('callback: WORKFLOW_GATE text_input skipped (modal handles this)', { workflowRunId, traceId });
    return;
  }

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

      case 'description_list': {
        // Renders choice gate options as a formatted list above the action buttons.
        // One line per option: *A* — label: description
        // Mirrors HTML radio button helper text — keeps button labels short.
        const lines = (field.items ?? []).map(item =>
          `*${item.label}* — ${item.description || item.label}`
        );
        if (lines.length > 0) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: lines.join('\n') },
          });
        }
        break;
      }

      case 'list': {
        // Header showing item count (from label)
        if (field.label) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*${field.label}*` },
          });
        }
        // One section block per list item, with optional Remove button
        for (const [idx, item] of (field.items ?? []).entries()) {
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
              action_id: `workflow_action_${item.id || idx}_${idx}`,
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
        // text_input gates are handled via Slack modal (views.open in interactive.mjs).
        // The modal is opened synchronously when the user clicks the trigger button,
        // using trigger_id before it expires. No block posted here — the modal is
        // already open. plain_text_input is invalid in channel messages.
        break;

      case 'review_object': {
        // Render the context as formatted key-value pairs.
        // item.value may be a scalar, an array of strings (column names),
        // or an array of objects (commands). Render each appropriately.
        //
        // Slack section blocks have a 3000-character limit on text.text.
        // We emit one section block per field line, and truncate any single
        // value that exceeds BLOCK_CHAR_LIMIT to prevent invalid_blocks errors.
        // Long recipes, notes, or instruction arrays would otherwise overflow
        // a single block.
        const BLOCK_CHAR_LIMIT = 2800; // safe margin below Slack's 3000 hard limit

        for (const item of (field.items ?? [])) {
          let valueText;
          if (Array.isArray(item.value)) {
            if (item.value.length === 0) {
              valueText = '(none)';
            } else if (typeof item.value[0] === 'object') {
              // Array of objects (e.g. commands, ingredients, steps) — sub-list
              valueText = '\n' + item.value
                .map(v => `    • ${v.syntax ?? v.verb ?? v.command ?? JSON.stringify(v)}`)
                .join('\n');
            } else {
              // Array of strings (e.g. column names, aliases) — comma list
              valueText = item.value.join(', ');
            }
          } else {
            valueText = String(item.value ?? '');
          }

          let line = `*${item.key}:* ${valueText}`;

          // Truncate if a single field still exceeds the block limit
          if (line.length > BLOCK_CHAR_LIMIT) {
            line = line.slice(0, BLOCK_CHAR_LIMIT - 3) + '...';
          }

          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: line },
          });
        }
        break;
      }

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
        // btn.modal is an optional descriptor for buttons that require a text input modal.
        // When present it is encoded into the button value so interactive.mjs can open
        // the modal generically without any knowledge of workflow-specific action names.
        //
        // action_id must be unique within a message. We append the button index so that
        // blank or duplicate btn.action values (e.g. LLM-generated options missing action)
        // never produce colliding action_ids. Routing is driven by the value JSON payload,
        // not by action_id, so this change is safe.
        const elements = (field.buttons ?? []).map((btn, i) => ({
          type:      'button',
          style:     btn.style === 'primary' ? 'primary' : btn.style === 'danger' ? 'danger' : undefined,
          text:      { type: 'plain_text', text: btn.label },
          action_id: `workflow_action_${btn.action || i}_${i}`,
          value:     JSON.stringify({
            workflowRunId,
            action: btn.action,
            ...(btn.modal ? { modal: btn.modal } : {}),
          }),
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
  // errMessage may be a full AJV validation error JSON string — thousands of chars.
  // Slack section blocks have a 3000-char hard limit. Show a human-readable summary
  // only; full details are in CloudWatch and PGC_Prompt.error_log.
  const isValidationError = typeof errMessage === 'string' && errMessage.includes('llm_call validation failed');
  const isLlmError        = typeof errMessage === 'string' && /LLM (returned|call timed)/.test(errMessage);
  let summary;
  if (isValidationError) {
    const match = errMessage.match(/after 2 attempt\(s\): (\d+|\[)/);
    const errCount = errMessage.match(/"keyword"/g)?.length ?? '?';
    summary = `LLM output validation failed after 2 attempts (${errCount} schema errors). The prompt has been logged for improvement.`;
  } else if (isLlmError) {
    summary = `LLM call failed: ${errMessage.slice(0, 200)}`;
  } else {
    summary = typeof errMessage === 'string' ? errMessage.slice(0, 500) : 'An unexpected error occurred.';
  }
  const displayText = `⚠️ *Workflow failed*${step ? ` at step ${step}` : ''}

${summary}`;
  await routeCallback(callback, displayText, [
    { type: 'section', text: { type: 'mrkdwn', text: displayText } },
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
