// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/callback.mjs
// SQS-triggered Lambda — consumes SYSSQSCallbackResults messages.
// Routes on callback.provider and posts replies back to the originating UI.
// No HTTP trigger — fires only when a message lands on SYSSQSCallbackResults.
//
// Message type taxonomy:
//   HUMAN_GATE         — suspends workflow, renders interactive dialog via dialogToBlocks()
//   HUMAN_NOTIFICATION — informational text message, rendered via textToBlocks()
//   WORKFLOW_ERROR     — workflow failure summary (error summarisation applied in EXP tier)
//   PING_SQS_RESULT    — dev/system ping with hop timing context
//   PING_E2E_RESULT    — dev/system ping with round-trip timing context
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

      case 'HUMAN_GATE':
        await postHumanGate(message);
        break;

      case 'HUMAN_NOTIFICATION':
        await postHumanNotification(message);
        break;

      case 'WORKFLOW_ERROR':
        await postWorkflowError(message);
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

// ---------------------------------------------------------------------------
// textToBlocks — shared utility for HUMAN_NOTIFICATION and WORKFLOW_ERROR.
// Splits text on newlines into ≤2800-char section blocks to stay safely under
// Slack's 3000-character hard limit. Appends a context block when contextText
// is provided. All notification handlers call this — the limit is never missed.
// ---------------------------------------------------------------------------

function textToBlocks(text, contextText) {
  const BLOCK_CHAR_LIMIT = 2800;
  const blocks = [];

  if (text.length <= BLOCK_CHAR_LIMIT) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  } else {
    const lines = text.split('\n');
    let chunk = '';
    for (const line of lines) {
      const candidate = chunk ? chunk + '\n' + line : line;
      if (candidate.length > BLOCK_CHAR_LIMIT) {
        if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
        chunk = line.length > BLOCK_CHAR_LIMIT ? line.slice(0, BLOCK_CHAR_LIMIT - 3) + '...' : line;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  }

  if (contextText) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextText }],
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Dev / system ping handlers — unique timing context, always short.
// Not merged into HUMAN_NOTIFICATION because their context blocks carry
// hop-specific timing fields that differ from the standard runId | traceId shape.
// ---------------------------------------------------------------------------

async function postPingSqsResult(message) {
  const { callback, result } = message;
  const contextText = `traceId: ${result.traceId} | hop1: ${result.hop1EnqueuedAt} | hop2: ${result.hop2ProcessedAt}`;
  await routeCallback(callback, result.message, textToBlocks(result.message, contextText));
  console.info('callback: PING_SQS_RESULT posted', {
    channel: callback.channel,
    traceId: message.traceId,
  });
}

async function postPingE2eResult(message) {
  const { callback, result } = message;
  const contextText = `traceId: ${result.traceId} | enqueued: ${result.enqueuedAt} | completed: ${result.completedAt}`;
  await routeCallback(callback, result.message, textToBlocks(result.message, contextText));
  console.info('callback: PING_E2E_RESULT posted', {
    channel: callback.channel,
    traceId: message.traceId,
  });
}

// ---------------------------------------------------------------------------
// HUMAN_NOTIFICATION — universal informational text message.
// All workflow notifications, CRUD results, errors, and cancellations route here.
// message.message is always the display-ready text — PROC is responsible for
// producing human-readable content before enqueuing.
// ---------------------------------------------------------------------------

async function postHumanNotification(message) {
  const { callback, traceId, workflowRunId } = message;
  const text = message.message ?? 'No message provided.';
  const contextText = workflowRunId
    ? `runId: ${workflowRunId} | traceId: ${traceId}`
    : `traceId: ${traceId}`;
  const blocks = textToBlocks(text, contextText);
  await routeCallback(callback, text.slice(0, 150), blocks);
  console.info('callback: HUMAN_NOTIFICATION posted', {
    channel:    callback.channel,
    traceId,
    blockCount: blocks.length,
  });
}

// ---------------------------------------------------------------------------
// WORKFLOW_ERROR — workflow failure.
// Error summarisation is applied here (EXP responsibility per architecture Section 3.1)
// because PROC emits raw technical error strings that may exceed Slack's block limit.
// Full detail is always in CloudWatch and PGC_Prompt.error_log.
// ---------------------------------------------------------------------------

async function postWorkflowError(message) {
  const { callback, step, message: errMessage, traceId, workflowRunId } = message;
  const isValidationError = typeof errMessage === 'string' && errMessage.includes('llm_call validation failed');
  const isLlmError        = typeof errMessage === 'string' && /LLM (returned|call timed)/.test(errMessage);
  const errCount          = errMessage.match(/"keyword"/g)?.length ?? '?';
  let summary;
  if (isValidationError) {
    summary = `LLM output validation failed after 2 attempts (${errCount} schema errors). The prompt has been logged for improvement.`;
  } else if (isLlmError) {
    summary = `LLM call failed: ${errMessage.slice(0, 200)}`;
  } else {
    summary = typeof errMessage === 'string' ? errMessage.slice(0, 500) : 'An unexpected error occurred.';
  }
  const displayText = `\u26a0\ufe0f *Workflow failed*${step ? ` at step ${step}` : ''}\n\n${summary}`;
  const contextText = `runId: ${workflowRunId} | traceId: ${traceId}`;
  const blocks = textToBlocks(displayText, contextText);
  await routeCallback(callback, displayText.slice(0, 150), blocks);
  console.info('callback: WORKFLOW_ERROR posted', { channel: callback.channel, traceId });
}

// ---------------------------------------------------------------------------
// HUMAN_GATE — renders a human_gate dialog as Slack Block Kit.
// Translates the UI-neutral dialog (from Step Processor or design-domain.mjs)
// to Block Kit blocks via dialogToBlocks(). gate_type is used as a layout hint
// only (e.g. whether to use chat.update for in-place re-renders).
// ---------------------------------------------------------------------------

async function postHumanGate(message) {
  const { callback, gate_type: gateType, dialog, workflowRunId, message_ts, traceId } = message;

  // text_input gates are handled via Slack modal opened in interactive.mjs.
  // The modal is already open at this point — nothing to post.
  if (gateType === 'text_input') {
    console.info('callback: HUMAN_GATE text_input skipped (modal handles this)', { workflowRunId, traceId });
    return;
  }

  const blocks = dialogToBlocks(dialog, workflowRunId);
  const fallbackText = dialog?.fields?.find(f => f.type === 'typography')?.value
    ?? 'Workflow gate \u2014 please review and respond.';

  if (message_ts) {
    // remove_item re-render — update the existing message in-place
    await slack.chat.update({
      channel: callback.channel,
      ts:      message_ts,
      text:    fallbackText,
      blocks,
    });
  } else {
    await routeCallback(callback, fallbackText, blocks);
  }

  console.info('callback: HUMAN_GATE posted', {
    channel:       callback.channel,
    gateType,
    workflowRunId,
    inPlace:       !!message_ts,
    traceId,
  });
}

// ---------------------------------------------------------------------------
// dialogToBlocks — translate a UI-neutral dialog object to Slack Block Kit.
// Each field type maps to one or more Block Kit blocks.
// Called by postHumanGate for all gate types.
//
// @param {object} dialog           Resolved dialog from Step Processor
// @param {number} workflowRunId    Encoded into button values
// @returns {Array}                 Slack Block Kit blocks array
// ---------------------------------------------------------------------------

function dialogToBlocks(dialog, workflowRunId) {
  const blocks = [];

  for (const field of (dialog?.fields ?? [])) {
    switch (field.type) {

      case 'typography':
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `\ud83e\udde0 ${field.value}` },
        });
        break;

      case 'description_list': {
        // Renders choice gate options as a formatted list above the action buttons.
        // One line per option: *A* — label: description
        const lines = (field.items ?? []).map(item =>
          `*${item.label}* \u2014 ${item.description || item.label}`
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
        if (field.label) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*${field.label}*` },
          });
        }
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
        // No block posted here — the modal is already open.
        break;

      case 'review_object': {
        // Render context as formatted key-value pairs.
        // One section block per field line — each bounded by BLOCK_CHAR_LIMIT
        // to prevent invalid_blocks errors on large data (recipes, steps, etc.).
        const BLOCK_CHAR_LIMIT = 2800;

        for (const item of (field.items ?? [])) {
          let valueText;
          if (Array.isArray(item.value)) {
            if (item.value.length === 0) {
              valueText = '(none)';
            } else if (typeof item.value[0] === 'object') {
              valueText = '\n' + item.value
                .map(v => `    \u2022 ${v.syntax ?? v.verb ?? v.command ?? JSON.stringify(v)}`)
                .join('\n');
            } else {
              valueText = item.value.join(', ');
            }
          } else {
            valueText = String(item.value ?? '');
          }

          let line = `*${item.key}:* ${valueText}`;
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
        // action_id must be unique within a message — append button index so that blank
        // or duplicate btn.action values never produce colliding action_ids.
        // Routing is driven by the value JSON payload, not by action_id.
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
