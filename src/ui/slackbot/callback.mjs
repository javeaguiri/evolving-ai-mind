// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/callback.mjs
// SQS-triggered Lambda — consumes SYSSQSCallbackResults messages.
// Routes on callback.provider and posts replies back to the originating UI.
// No HTTP trigger — fires only when a message lands on SYSSQSCallbackResults.
//
// Message type taxonomy:
//   HUMAN_GATE          — suspends workflow, renders interactive dialog via dialogToBlocks()
//   HUMAN_NOTIFICATION  — informational text message, rendered via textToBlocks()
//   WORKFLOW_ERROR      — workflow failure summary (error summarisation applied in EXP tier)
//   EXPLAIN_STEP_SELECT — /explain <run_id> matched multiple llm_call steps; posts a
//                         button per step so the user can pick which one to ask about
//   PING_SQS_RESULT     — dev/system ping with hop timing context
//   PING_E2E_RESULT     — dev/system ping with round-trip timing context
//
// Adding a new UI provider:
//   1. Add a case to routeCallback() below.
//   2. No new queue or Lambda needed for the common case.

import { randomUUID }  from 'node:crypto';
import { WebClient }   from '@slack/web-api';

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

      case 'EXPLAIN_STEP_SELECT':
        await postExplainStepSelect(message);
        break;

      default:
        console.warn('callback: unknown message type', message.type);
    }

    return true;

  } catch (error) {
    console.error('callback: Slack post error', {
      type:     message.type,
      traceId:  message.traceId,
      error:    error.message,
      // @slack/web-api errors carry the full API response body here (e.g. which
      // block/field triggered a validation error) — error.message alone is often
      // just the bare error code with no positional detail.
      slackData: error.data,
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
// markdownToBlocks — Novia reply renderer using Slack's markdown block type.
// Splits text into heading, code-block, and prose segments first.
//
// Heading lines (`#` through `######`) become dedicated `header` blocks with a
// real `level` (1-4, capped — Slack's header block only supports H1-H4; `####`
// and deeper all render as H4). This is a different mechanism from the `#`
// syntax inside a `markdown` block's own text, which Slack renders at a single
// fixed size regardless of level (verified against docs.slack.dev/reference/
// block-kit/blocks/markdown-block — see docs/slack-block-kit.md). Splitting
// headings out into their own `header` blocks is the only way to get real
// visual hierarchy (Sprint 7 Track D2).
//
// Code blocks become a dedicated single block each — splitting on \n\n inside
// a code block would break the ``` pair across separate Slack blocks (each
// renders independently), leaving fences unclosed. Prose segments are then
// split on paragraph boundaries as before.
// ---------------------------------------------------------------------------

const HEADER_TEXT_LIMIT = 150; // Slack header block text.text max length

function markdownToBlocks(text, contextText) {
  const blocks = [];

  // Split on heading lines first (capturing so they're isolated from prose).
  const headingSegments = text.split(/^(#{1,6}[ \t]+.+)$/m);

  for (const seg of headingSegments) {
    const headingMatch = seg.match(/^(#{1,6})[ \t]+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
      let headingText = headingMatch[2].trim();
      if (headingText.length > HEADER_TEXT_LIMIT) {
        headingText = `${headingText.slice(0, HEADER_TEXT_LIMIT - 3)}...`;
      }
      blocks.push({ type: 'header', text: { type: 'plain_text', text: headingText, emoji: true }, level });
    } else if (seg.trim()) {
      blocks.push(...markdownProseToBlocks(seg));
    }
  }

  if (contextText) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] });
  }
  return blocks;
}

// markdownProseToBlocks — code-block and paragraph chunking for non-heading
// markdown text. Extracted from markdownToBlocks so heading segments never
// enter this path (a heading line is never chunked as prose).
function markdownProseToBlocks(text) {
  const BLOCK_CHAR_LIMIT = 2800;
  const blocks = [];

  // Split on fenced code blocks (capturing so delimiters stay in array).
  const segments = text.split(/(```[\s\S]*?```)/);

  for (const seg of segments) {
    if (seg.startsWith('```')) {
      // Code block — single block, never split internally.
      const block = seg.length > BLOCK_CHAR_LIMIT
        ? `${seg.slice(0, BLOCK_CHAR_LIMIT - 7)}...\n\`\`\``
        : seg;
      blocks.push({ type: 'markdown', text: block });
    } else {
      // Prose — split on paragraph boundaries and accumulate into chunks.
      const paragraphs = seg.split(/\n\n+/);
      let chunk = '';
      for (const para of paragraphs) {
        if (!para.trim()) continue;
        const candidate = chunk ? `${chunk}\n\n${para}` : para;
        if (candidate.length > BLOCK_CHAR_LIMIT) {
          if (chunk) blocks.push({ type: 'markdown', text: chunk });
          chunk = para.length > BLOCK_CHAR_LIMIT ? `${para.slice(0, BLOCK_CHAR_LIMIT - 3)}...` : para;
        } else {
          chunk = candidate;
        }
      }
      if (chunk) blocks.push({ type: 'markdown', text: chunk });
    }
  }
  return blocks;
}

// groupBlocksForSlack — splits content blocks into per-message groups honoring
// both the 50-block-per-message limit (maxBlocksPerGroup) and Slack's documented
// 12,000-character cumulative limit across all `markdown` blocks in one payload
// (docs.slack.dev/reference/block-kit/blocks/markdown-block). markdownToBlocks
// caps each individual block at 2800 chars, so no single block can exceed the
// cumulative limit on its own — a group always makes progress.
const MARKDOWN_CUMULATIVE_LIMIT = 12000;

function groupBlocksForSlack(blocks, maxBlocksPerGroup) {
  const groups = [];
  let current = [];
  let currentMarkdownChars = 0;

  for (const block of blocks) {
    const blockMarkdownChars = block.type === 'markdown' ? block.text.length : 0;
    const exceedsBlockCount   = current.length >= maxBlocksPerGroup;
    const exceedsMarkdownChars = currentMarkdownChars + blockMarkdownChars > MARKDOWN_CUMULATIVE_LIMIT;

    if (current.length > 0 && (exceedsBlockCount || exceedsMarkdownChars)) {
      groups.push(current);
      current = [];
      currentMarkdownChars = 0;
    }

    current.push(block);
    currentMarkdownChars += blockMarkdownChars;
  }

  if (current.length > 0) groups.push(current);
  return groups;
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
  const { callback, traceId, workflowRunId, queryId, format, sessionId, reveals } = message;
  const text = message.message ?? 'No message provided.';
  const contextText = workflowRunId
    ? `runId: ${workflowRunId} | traceId: ${traceId}`
    : `traceId: ${traceId}`;

  // Build content blocks without suffix so chunking can manage them independently.
  // reveals (optional, notify steps only — Sprint 7 Track D2) render the same
  // way human_gate's reveal/reveals fields do, via the shared buildRevealBlock.
  const revealBlocks = Array.isArray(reveals) ? reveals.map(buildRevealBlock) : [];
  const contentBlocks = [
    ...(format === 'markdown' ? markdownToBlocks(text) : textToBlocks(text)),
    ...revealBlocks,
  ];

  // Suffix: context block + optional actions block — always on the last chunk only.
  const suffixBlocks = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] },
  ];
  if (format === 'markdown' && sessionId) {
    suffixBlocks.push({
      type:     'actions',
      elements: [{
        type:      'button',
        text:      { type: 'plain_text', text: 'Continue with Novia' },
        action_id: 'minds_eye_followup',
        value:     JSON.stringify({ action: 'minds_eye_followup', sessionId }),
      }],
    });
  } else if (queryId) {
    suffixBlocks.push({
      type:     'actions',
      elements: [{
        type:      'button',
        text:      { type: 'plain_text', text: 'Ask follow-up' },
        action_id: 'explain_followup',
        value:     JSON.stringify({ action: 'explain_followup', queryId }),
      }],
    });
  }

  const SLACK_BLOCK_LIMIT = 50;
  const chunkSize = SLACK_BLOCK_LIMIT - suffixBlocks.length;
  const groups     = groupBlocksForSlack(contentBlocks, chunkSize);

  for (let i = 0; i < groups.length; i++) {
    const isLast = i === groups.length - 1;
    await routeCallback(callback, text.slice(0, 150), isLast ? [...groups[i], ...suffixBlocks] : groups[i]);
  }

  console.info('callback: HUMAN_NOTIFICATION posted', {
    channel:    callback.channel,
    traceId,
    blockCount: contentBlocks.length + suffixBlocks.length,
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
// EXPLAIN_STEP_SELECT — /explain <run_id> resolved to one or more llm_call
// steps. Posts one button per step, threaded under the /explain ACK placeholder.
// Buttons carry only queryId — no question yet. Picking a step opens a modal
// to collect the question (interactive.mjs), keeping the two decisions separate.
// ---------------------------------------------------------------------------

async function postExplainStepSelect(message) {
  const { callback, runId, steps, traceId } = message;
  const displayText = `🔍 *Run ${runId} — ${steps.length} LLM step${steps.length === 1 ? '' : 's'}.* Pick one to explain:`;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: displayText } },
    ...steps.map(s => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Step ${s.stepId}* — \`${s.intentCategory}\`` },
      accessory: {
        type:      'button',
        text:      { type: 'plain_text', text: 'Explain this step' },
        action_id: 'explain_step_select',
        value:     JSON.stringify({ action: 'explain_step_select', queryId: s.queryId }),
      },
    })),
  ];
  await routeCallback(callback, displayText.slice(0, 150), blocks);
  console.info('callback: EXPLAIN_STEP_SELECT posted', { channel: callback?.channel, runId, count: steps.length, traceId });
}

// ---------------------------------------------------------------------------
// HUMAN_GATE — renders a human_gate dialog as Slack Block Kit.
// Translates the UI-neutral dialog (from Step Processor or design-domain.mjs)
// to Block Kit blocks via dialogToBlocks(). gate_type is used as a layout hint
// only (e.g. whether to use chat.update for in-place re-renders).
// ---------------------------------------------------------------------------

async function postHumanGate(message) {
  const { callback, gate_type: gateType, dialog, workflowRunId, step: stepKey, message_ts, traceId } = message;
  const gateContextText = workflowRunId
    ? `runId: ${workflowRunId} | traceId: ${traceId}`
    : `traceId: ${traceId}`;
  const gateContextBlock = { type: 'context', elements: [{ type: 'mrkdwn', text: gateContextText }] };

  // text_input gates render an inline input block directly in the message.
  // Slack input blocks work in messages — state.values is populated in the
  // block_actions payload when the user clicks Submit. No modal required.
  // block_id is unique per run so Slack does not carry forward the previous gate's typed value.
  if (gateType === 'text_input') {
    const textboxField = dialog?.fields?.find(f => f.type === 'textbox') ?? {};
    const fallbackText = dialog?.fields?.find(f => f.type === 'typography')?.value
      ?? 'Please enter your response.';
    const isMultiline  = message.multiline ?? textboxField.multiline ?? false;
    const inputBlock   = {
      type:     'input',
      block_id: `text_input_block_${workflowRunId}_${stepKey ?? 'x'}`,
      element:  {
        type:      'plain_text_input',
        action_id: 'text_input_value',
        multiline: isMultiline,
        ...(textboxField.placeholder
          ? { placeholder: { type: 'plain_text', text: textboxField.placeholder } }
          : {}),
      },
      label: { type: 'plain_text', text: textboxField.label ?? 'Your input' },
    };
    // Use buttons from dialog.fields actions — respects Skip/Cancel defined in step.options.
    // Falls back to hardcoded Submit + Cancel if no actions field present.
    const actionsField = dialog?.fields?.find(f => f.type === 'actions');
    const actionElements = actionsField
      ? (actionsField.buttons ?? []).map((btn, i) => ({
          type:      'button',
          ...(btn.style === 'primary' || btn.style === 'danger' ? { style: btn.style } : {}),
          text:      { type: 'plain_text', text: btn.label },
          action_id: `workflow_action_${btn.action || i}_${i}`,
          value:     JSON.stringify({ workflowRunId, action: btn.action }),
        }))
      : [
          {
            type:      'button',
            style:     'primary',
            text:      { type: 'plain_text', text: 'Submit' },
            action_id: 'workflow_text_submit',
            // gateType included so interactive.mjs can use delete+reply instead of
            // chat.update — Slack silently ignores chat.update on messages with input blocks.
            value:     JSON.stringify({ workflowRunId, action: 'confirm', gateType: 'text_input' }),
          },
          {
            type:      'button',
            text:      { type: 'plain_text', text: 'Cancel' },
            action_id: 'workflow_text_cancel',
            value:     JSON.stringify({ workflowRunId, action: 'cancel', gateType: 'text_input' }),
          },
        ];
    // reveal fields (e.g. per-table column reference) — text_input builds its own
    // blocks independently of dialogToBlocks, so they must be rendered here too.
    const revealBlocks = (dialog?.fields ?? [])
      .filter(f => f.type === 'reveal')
      .map(buildRevealBlock);
    const blocks = [
      ...markdownToBlocks(fallbackText),
      ...revealBlocks,
      inputBlock,
      gateContextBlock,
      { type: 'actions', elements: actionElements },
    ];
    await routeCallback(callback, fallbackText.slice(0, 150), blocks);
    console.info('callback: HUMAN_GATE text_input posted', { workflowRunId, multiline: isMultiline, traceId });
    return;
  }

  // followup_prompt \u2014 notification-style message with an "Ask follow-up" modal button.
  // Uses the existing buttonValue.modal \u2192 views.open \u2192 resume_gate path in interactive.mjs.
  if (gateType === 'followup_prompt') {
    const promptText = dialog?.fields?.find(f => f.type === 'typography')?.value ?? 'LLM output recorded.';
    const blocks = [
      ...textToBlocks(promptText),
      gateContextBlock,
      {
        type:     'actions',
        elements: [{
          type:      'button',
          style:     'primary',
          text:      { type: 'plain_text', text: 'Ask follow-up' },
          action_id: 'workflow_followup_modal_0',
          value:     JSON.stringify({
            workflowRunId,
            action: 'confirm',
            modal:  { title: 'Your question', input_label: 'Type your follow-up question', multiline: true },
          }),
        }],
      },
    ];
    await routeCallback(callback, promptText.slice(0, 150), blocks);
    console.info('callback: HUMAN_GATE followup_prompt posted', { workflowRunId, traceId });
    return;
  }

  // minds_eye_continue_gate \u2014 Novia turn-limit gate. Three options: Continue resumes the loop,
  // Follow-up opens a modal for the user to ask a question, Cancel ends the session.
  if (gateType === 'minds_eye_continue_gate') {
    const { sessionId, resetActionCount = false } = message;
    const gateText = resetActionCount
      ? "I've reached my action limit. Continue to keep going (resets the limit), ask a Follow-up question, or Cancel to end the session."
      : "I've reached my turn limit. Continue to keep reasoning, ask a Follow-up question, or Cancel to end the session.";
    const sessionContextBlock = { type: 'context', elements: [{ type: 'mrkdwn', text: `sessionId: ${sessionId} | traceId: ${traceId}` }] };
    const gateBlocks = [
      ...markdownToBlocks(gateText),
      sessionContextBlock,
      {
        type: 'actions',
        elements: [
          {
            type:      'button',
            style:     'primary',
            text:      { type: 'plain_text', text: 'Continue' },
            action_id: 'minds_eye_continue_approve',
            value:     JSON.stringify({ action: 'minds_eye_continue_gate', sessionId, approved: true, resetActionCount }),
          },
          {
            type:      'button',
            text:      { type: 'plain_text', text: 'Follow-up' },
            action_id: 'minds_eye_continue_followup',
            value:     JSON.stringify({ action: 'minds_eye_continue_followup', sessionId }),
          },
          {
            type:      'button',
            text:      { type: 'plain_text', text: 'Cancel' },
            action_id: 'minds_eye_continue_cancel',
            value:     JSON.stringify({ action: 'minds_eye_continue_gate', sessionId, approved: false }),
          },
        ],
      },
    ];
    await routeCallback(callback, gateText, gateBlocks);
    console.info('callback: minds_eye_continue_gate posted', { sessionId, resetActionCount, traceId });
    return;
  }

  // minds_eye_gate \u2014 Novia action gate. Renders with sessionId buttons instead of workflowRunId.
  if (gateType === 'minds_eye_gate') {
    const { sessionId, confirmLabel = 'Approve', confirmStyle } = message;
    const gateText = dialog?.fields?.find(f => f.type === 'typography')?.value ?? 'Confirm action';
    const approveButton = {
      type:      'button',
      text:      { type: 'plain_text', text: confirmLabel },
      action_id: 'minds_eye_delete_approve',
      value:     JSON.stringify({ action: 'minds_eye_action_gate', sessionId, approved: true }),
    };
    if (confirmStyle) approveButton.style = confirmStyle;
    const sessionContextBlock = { type: 'context', elements: [{ type: 'mrkdwn', text: `sessionId: ${sessionId} | traceId: ${traceId}` }] };
    const gateBlocks = [
      ...markdownToBlocks(gateText),
      sessionContextBlock,
      {
        type: 'actions',
        elements: [
          approveButton,
          {
            type:      'button',
            text:      { type: 'plain_text', text: 'Cancel' },
            action_id: 'minds_eye_delete_cancel',
            value:     JSON.stringify({ action: 'minds_eye_action_gate', sessionId, approved: false }),
          },
        ],
      },
    ];
    await routeCallback(callback, gateText.slice(0, 150), gateBlocks);
    console.info('callback: minds_eye_gate posted', { sessionId, traceId });
    return;
  }

  const blocks = dialogToBlocks(dialog, workflowRunId);
  // Always the last block — a true footer. Previously spliced before a
  // trailing actions block, which put it above the buttons; list_selection
  // now renders two actions blocks in sequence (Select, then Back/Done), so
  // that rule landed the context line between them instead of at the bottom.
  blocks.push(gateContextBlock);
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

// buildRevealBlock — collapsible `container` Block Kit element for a
// reveal/reveals field (Sprint 7 Track D4/G3 follow-up — replaces the earlier
// `task_card` implementation, which could never interpret markdown; a
// container's child blocks are ordinary `section`/`mrkdwn`, so reveal content
// finally supports real markdown). content is a string → the block's own
// text; array of strings → one '• ' bullet per line in the same text.
// Shared by dialogToBlocks (all non-text_input gate types) and postHumanGate's
// text_input branch, which builds its blocks independently of dialogToBlocks.
const REVEAL_SECTION_CHAR_LIMIT = 2800;
const REVEAL_MAX_CHILD_BLOCKS   = 10;
const TABLE_MAX_ROWS            = 100;   // Slack `table` block hard limit, including the header row
const TABLE_MAX_COLUMNS         = 20;    // Slack `table` block hard limit
const TABLE_MAX_CHARS           = 10000; // Slack `table` block hard limit — aggregate cell text

// buildTableBlock — native Slack `table` block (rows of { type: 'rich_text' }
// cells, not markdown syntax) shared by buildRevealTable (array-of-records
// content) and the markdown-pipe-table segments found by
// splitMarkdownTableSegments (string content). container.child_blocks
// explicitly excludes the `markdown` block type (verified against Slack's own
// docs — see docs/slack-block-kit.md), so a markdown pipe-table can never
// render inside a reveal; `table` is the only real grid-rendering option
// available there. `raw_text` cells were tried first and render as a
// flattened pipe-joined fallback instead of a grid (confirmed live
// 2026-07-09) — `rich_text` cells are required.
function buildTableBlock(headerLabels, dataRows) {
  const cols = headerLabels.slice(0, TABLE_MAX_COLUMNS);
  const cell = (v, bold) => {
    const text = String(v ?? '').replace(/\r?\n/g, ' ');
    return {
      type:     'rich_text',
      elements: [{
        type:     'rich_text_section',
        elements: [{ type: 'text', text, ...(bold ? { style: { bold: true } } : {}) }],
      }],
    };
  };
  const cellText = c => c.elements[0].elements[0].text;

  const rows = [cols.map(h => cell(h, true))];
  let charCount = cols.reduce((sum, h) => sum + String(h ?? '').length, 0);
  let truncated = 0;
  for (const rowValues of dataRows) {
    const rowCells = rowValues.slice(0, TABLE_MAX_COLUMNS).map(v => cell(v, false));
    const rowChars = rowCells.reduce((sum, c) => sum + cellText(c).length, 0);
    if (rows.length >= TABLE_MAX_ROWS || charCount + rowChars > TABLE_MAX_CHARS) {
      truncated++;
      continue;
    }
    rows.push(rowCells);
    charCount += rowChars;
  }

  return { table: { type: 'table', rows }, truncated };
}

// buildRevealTable — builds a buildTableBlock() from an array of plain record
// objects. Columns are the union of every item's own keys, first-seen order,
// labeled via the same formatColumnHeader() used elsewhere — same
// data-driven, no-domain-knowledge approach as buildListTable/
// buildObjectArrayTable.
function buildRevealTable(items) {
  const columns = [];
  const seen = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  const headerLabels = columns.map(col => formatColumnHeader(col, items.map(it => it[col])));
  const dataRows = items.map(item => columns.map(col => item[col]));
  return buildTableBlock(headerLabels, dataRows);
}

// splitMarkdownTableSegments — parses a reveal string into alternating text
// and table segments, so a pipe-table embedded in otherwise-prose markdown
// (e.g. a js_transform building "intro text\n\n| Deck | Cards |\n|---|---|\n| ... |")
// renders the table natively (via buildTableBlock) while surrounding text
// keeps rendering as plain markdown — instead of the whole string collapsing
// into one mrkdwn block where the pipe syntax shows up literally. Standard
// GFM table detection: a `| ... |` row immediately followed by a
// `|---|---|`-style separator row starts a table; consecutive row lines after
// that are its body.
function splitMarkdownTableSegments(text) {
  const lines = text.split('\n');
  const isRow       = l => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = l => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l);
  const splitRow    = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const segments = [];
  let textLines = [];
  const flushText = () => {
    if (textLines.length) segments.push({ type: 'text', text: textLines.join('\n') });
    textLines = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i]) && isSeparator(lines[i + 1] ?? '')) {
      flushText();
      const header = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      segments.push({ type: 'table', header, rows });
    } else {
      textLines.push(lines[i]);
      i++;
    }
  }
  flushText();
  return segments;
}

// chunkTextBlocks — splits reveal prose into REVEAL_SECTION_CHAR_LIMIT-sized
// `section`/`mrkdwn` blocks, capped at REVEAL_MAX_CHILD_BLOCKS with a trailing
// truncation note merged into the last kept chunk.
function chunkTextBlocks(text) {
  const lines = text ? text.split('\n') : [];
  const chunks = [];
  let chunk = '';
  for (const line of lines) {
    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > REVEAL_SECTION_CHAR_LIMIT && chunk) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);

  const truncatedCount = Math.max(0, chunks.length - REVEAL_MAX_CHILD_BLOCKS);
  const kept = chunks.slice(0, REVEAL_MAX_CHILD_BLOCKS);
  if (truncatedCount > 0 && kept.length > 0) {
    kept[kept.length - 1] = `${kept[kept.length - 1]}\n_...and ${truncatedCount} more chunk(s)_`;
  }
  return kept.map(c => ({ type: 'section', text: { type: 'mrkdwn', text: c } }));
}

function buildRevealBlock(field) {
  // An array of plain records with no recognized single-field shape renders as
  // a real table (see buildRevealTable) — everything else (a string, an array
  // of strings, or an array uniformly shaped with syntax/verb/command) keeps
  // the original bulleted-mrkdwn rendering.
  const isRecordArray = Array.isArray(field.content) && field.content.length > 0
    && field.content.every(v => v !== null && typeof v === 'object')
    && !field.content.every(v => v.syntax || v.verb || v.command);

  const childBlocks = [];

  if (isRecordArray) {
    const { table, truncated } = buildRevealTable(field.content);
    childBlocks.push(table);
    if (truncated > 0) {
      childBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_...and ${truncated} more row(s)_` } });
    }
  } else if (Array.isArray(field.content)) {
    const text = field.content.map(item => `• ${(item !== null && typeof item === 'object') ? (item.syntax ?? item.verb ?? item.command) : String(item)}`).join('\n');
    childBlocks.push(...chunkTextBlocks(text));
  } else {
    // String content may mix prose with an embedded pipe-table — split so the
    // table renders natively and surrounding text is unaffected.
    const segments = splitMarkdownTableSegments(String(field.content ?? ''));
    for (const seg of segments) {
      if (seg.type === 'table') {
        const { table, truncated } = buildTableBlock(seg.header, seg.rows);
        childBlocks.push(table);
        if (truncated > 0) {
          childBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_...and ${truncated} more row(s)_` } });
        }
      } else if (seg.text.trim()) {
        childBlocks.push(...chunkTextBlocks(seg.text));
      }
    }
  }

  return {
    type:               'container',
    block_id:           `reveal_${randomUUID()}`,
    title:              { type: 'plain_text', text: field.button_label ?? 'Details' },
    is_collapsible:     true,
    default_collapsed:  true,
    child_blocks:       childBlocks,
  };
}

// escapeCell — shared markdown-table cell escaping (pipe/newline), used by
// both buildListTable and buildObjectArrayTable.
const escapeCell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// formatColumnHeader — pure presentation, no domain knowledge: title-cases a
// snake_case field name (ease_factor -> Ease Factor, front -> Front). A key
// ending in _id whose values no longer look like raw ids (the workflow already
// resolved the FK to its label, keeping the original column name) drops the
// _id suffix and reads as "<Prefix> Name" (deck_id -> Deck Name) instead —
// judged from the data itself, so an _id column still holding raw numeric ids
// (never resolved) is left as a plain title-cased "Deck Id".
function formatColumnHeader(key, values) {
  if (key === 'ID') return 'ID';
  const isFkColumn    = /_id$/i.test(key);
  const looksResolved = isFkColumn && values.some(v => v !== undefined && v !== null && v !== '' && Number.isNaN(Number(v)));
  const base  = looksResolved ? key.slice(0, -3) : key;
  const words = base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return looksResolved ? `${words.join(' ')} Name` : words.join(' ');
}

// formatTableName — pure presentation, no domain knowledge: strips the PGD_
// prefix and splits PascalCase into words (PGD_RecipeSteps -> Recipe Steps).
// Used as a list-group heading when no parent-context column applies (see
// buildOneListTable below) — every table gets a stable, deterministic name
// regardless of what data happens to be in its rows.
function formatTableName(tableName) {
  const base = String(tableName ?? '').replace(/^PGD_/i, '');
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || String(tableName ?? '');
}

// buildTableBody — markdown header/sep/rows for one table's worth of rows,
// no heading line (buildListTable decides headings — see below). Columns are
// entirely data-driven: ID first, then the union of every item's own `fields`
// keys, in first-seen order — no synthesized Name/Detail columns. excludeColumn
// (a def's own link back to this level's parent, tagged onto every item's
// responseData.fkColumn by list_entity) is dropped from the body when present,
// since a parent heading already conveys it — showing it again as a column
// would just repeat the same value on every row.
function buildTableBody(items, excludeColumn) {
  const columns = ['ID'];
  const seen = new Set(columns);
  for (const item of items) {
    for (const key of Object.keys(item.fields ?? {})) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  const tableColumns = columns.filter(col => col !== excludeColumn);

  const headerLabels = tableColumns.map(col => formatColumnHeader(col, items.map(item => item.fields?.[col])));
  const header = `| ${headerLabels.join(' | ')} |`;
  const sep    = `|${tableColumns.map(() => '---').join('|')}|`;
  const rows   = items.map(item => {
    const cells = tableColumns.map(col => (col === 'ID' ? item.id : item.fields?.[col]));
    return `| ${cells.map(escapeCell).join(' | ')} |`;
  });
  return [header, sep, ...rows].join('\n');
}

// buildListTable — markdown table(s) for a list_selection field's rows.
// Replaces the former one-section-plus-accessory-button-plus-divider-per-row
// rendering, which cost 2 Block Kit blocks per row and started throwing
// msg_blocks_too_long above ~8 rows (Sprint 7 Track D). A table is one
// markdown block regardless of row count, and — per the user's own
// observation — Slack renders long markdown tables with native scroll, so
// nothing is lost for larger lists.
//
// A single drill-down level can span more than one source table (e.g. a
// recipe's own children are both its ingredients and its steps) — grouping
// by responseData.table (already set per row by list_entity) and rendering
// one table per group, rather than merging every row into one sparse table
// over the union of all columns, keeps differently-shaped record types
// visually separate instead of producing a mostly-blank combined grid.
//
// parentHeading (optional) is computed once by list_entity per drill-down
// level — the clicked row's own title/name, or its table name as fallback —
// never re-derived here from per-row data, so it can't be shown more than
// once even when several child tables share it, and the table-name fallback
// is always correct rather than guessed from a child's own FK column. When
// present, it renders once as the level's own '#' heading and every table
// group gets its own '##' heading instead; when absent (root level — no
// parent), each table group is simply its own '#' heading, matching how a
// single-table level has always rendered.
function buildListTable(items, parentHeading) {
  const groups = new Map();
  for (const item of items) {
    const table = item.responseData?.table;
    if (!groups.has(table)) groups.set(table, []);
    groups.get(table).push(item);
  }
  const entries = [...groups.entries()];

  if (!parentHeading) {
    return entries
      .map(([table, groupItems]) => [`# ${formatTableName(table)}`, buildTableBody(groupItems)].join('\n'))
      .join('\n\n');
  }

  const sections = entries.map(([table, groupItems]) => {
    const excludeColumn = groupItems[0]?.responseData?.fkColumn ?? undefined;
    return [`## ${formatTableName(table)}`, buildTableBody(groupItems, excludeColumn)].join('\n');
  });
  return [`# ${parentHeading}`, ...sections].join('\n\n');
}

// Slack's static_select limits, from its block element reference: at most 100
// options across all option groups, and option text capped at 75 characters.
// A list longer than the option cap falls back to the shared text box (see the
// 'list' case below) — the markdown table itself is uncapped either way, so a
// long list is never truncated, only selected from differently.
const SELECT_OPTION_LIMIT = 100;
const OPTION_TEXT_LIMIT   = 75;

function truncateOption(text) {
  const s = String(text ?? '');
  return s.length <= OPTION_TEXT_LIMIT ? s : `${s.slice(0, OPTION_TEXT_LIMIT - 1)}…`;
}

// buildSelectOptionText — a one-line identifier for a row in the dropdown,
// data-driven and domain-free exactly as buildTableBody's columns are: the row's
// id (the same ID column the table shows, so dropdown and table can be read
// against each other) followed by its first non-empty field value in first-seen
// key order, skipping the parent-link column. The table above already carries the
// full labeled detail — an option only has to be enough to pick a row by.
function buildSelectOptionText(item, excludeColumn) {
  const entry = Object.entries(item.fields ?? {}).find(([col, value]) =>
    col !== excludeColumn && value !== null && value !== undefined && String(value).trim() !== ''
  );
  const summary = entry ? String(entry[1]).trim() : '';
  return truncateOption(summary ? `${item.id} — ${summary}` : String(item.id));
}

// buildListSelect — a static_select over a list_selection field's selectable rows,
// replacing the shared "type the ID" text box. Each option's value carries the
// row's source table alongside its id, so a level spanning more than one child
// table (a recipe's ingredients and its steps) can no longer resolve a bare id
// that collides across both to the wrong table's row — the tables become their own
// labeled option_groups and the table travels with the selection, which removes
// the ambiguity by construction rather than asking the user to disambiguate it.
// Returns null when nothing is selectable, or when the list exceeds Slack's
// 100-option cap — the caller then falls back to the text input.
function buildListSelect(items, workflowRunId) {
  const selectable = items.filter(item => item.secondaryAction);
  if (selectable.length === 0 || selectable.length > SELECT_OPTION_LIMIT) return null;

  const groups = new Map();
  for (const item of selectable) {
    const table = item.responseData?.table;
    if (!groups.has(table)) groups.set(table, []);
    groups.get(table).push(item);
  }
  const entries = [...groups.entries()];

  const toOptions = groupItems => {
    const excludeColumn = groupItems[0]?.responseData?.fkColumn ?? undefined;
    return groupItems.map(item => ({
      text:  { type: 'plain_text', text: buildSelectOptionText(item, excludeColumn) },
      value: JSON.stringify({
        id: item.id,
        ...(item.responseData?.table ? { table: item.responseData.table } : {}),
      }),
    }));
  };

  const element = {
    type:        'static_select',
    action_id:   'list_select_value',
    placeholder: { type: 'plain_text', text: 'Choose a record' },
  };
  // Only group when the level genuinely spans more than one table — a single-table
  // list gets a flat option list, with no redundant one-group header above it.
  if (entries.length > 1) {
    element.option_groups = entries.map(([table, groupItems]) => ({
      label:   { type: 'plain_text', text: truncateOption(formatTableName(table)) },
      options: toOptions(groupItems),
    }));
  } else {
    element.options = toOptions(entries[0][1]);
  }

  return {
    type:     'input',
    block_id: `list_select_input_${workflowRunId}`,
    element,
    label:    { type: 'plain_text', text: 'Select a record' },
  };
}

// buildObjectArrayTable — markdown table for a review_object array-of-records
// value with no recognized single-field shape (e.g. add_entity's parsed child
// rows — flashcard {front, back} pairs, recipe {description, order} steps).
// Replaces an anonymous positional "value — value" join, which is unverifiable
// once a record has more than one field of the same type: a user reviewing a
// {front, back} pair has no way to tell which value landed in which field from
// an unlabeled dash-join alone. Columns are the union of every item's own keys,
// in first-seen order — same data-driven, no-domain-knowledge approach as
// buildListTable.
function buildObjectArrayTable(items) {
  const columns = [];
  const seen = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  const headerLabels = columns.map(col => formatColumnHeader(col, items.map(it => it[col])));
  const header = `| ${headerLabels.join(' | ')} |`;
  const sep    = `|${columns.map(() => '---').join('|')}|`;
  const rows   = items.map(item => `| ${columns.map(col => escapeCell(item[col])).join(' | ')} |`);
  return [header, sep, ...rows].join('\n');
}

function dialogToBlocks(dialog, workflowRunId) {
  const blocks = [];

  for (const field of (dialog?.fields ?? [])) {
    switch (field.type) {

      case 'typography':
        blocks.push({
          type: 'markdown',
          text: `\ud83e\udde0 ${field.value}`,
        });
        break;

      case 'description_list': {
        // Renders choice gate options as a formatted list above the action buttons.
        // One line per option: **A** — label: description
        const lines = (field.items ?? []).map(item =>
          `**${item.label}** \u2014 ${item.description || item.label}`
        );
        if (lines.length > 0) {
          blocks.push({
            type: 'markdown',
            text: lines.join('\n'),
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
        const items = field.items ?? [];
        if (items.length > 0) {
          blocks.push(...markdownToBlocks(buildListTable(items, field.parentHeading)));
        }
        // One shared selection control + button replaces the former per-row accessory
        // button. list_selection's item_action is uniform across every row, so a
        // single button (labeled from the first selectable row's own action) covers
        // the whole list; run-workflow.mjs's resumeGate resolves the selection back
        // to that row's responseData before advancing, exactly as a direct row click
        // used to. Rows with no secondaryAction (item_action condition false, or the
        // item explicitly opts out) stay visible in the table but aren't selectable —
        // same as before, when they simply rendered with no accessory button.
        //
        // The control is a static_select whose options carry each row's source table
        // (see buildListSelect), so colliding ids across two child tables at one level
        // resolve unambiguously. Past Slack's 100-option cap it falls back to the
        // original shared text box, where a bare typed id is matched first-hit — the
        // table stays uncapped and fully visible under either control.
        const selectable = items.find(item => item.secondaryAction);
        if (selectable) {
          const validStyle = selectable.secondaryAction.style === 'danger' || selectable.secondaryAction.style === 'primary';
          blocks.push(buildListSelect(items, workflowRunId) ?? {
            type:     'input',
            block_id: `list_select_input_${workflowRunId}`,
            element:  {
              type:        'plain_text_input',
              action_id:   'list_select_value',
              placeholder: { type: 'plain_text', text: `e.g. ${selectable.id}` },
            },
            label: { type: 'plain_text', text: 'Enter the ID to select' },
          });
          blocks.push({
            type:     'actions',
            elements: [{
              type: 'button',
              ...(validStyle ? { style: selectable.secondaryAction.style } : {}),
              text:      { type: 'plain_text', text: selectable.secondaryAction.label },
              action_id: `list_select_${selectable.secondaryAction.action}`,
              value:     JSON.stringify({ workflowRunId, action: selectable.secondaryAction.action }),
            }],
          });
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
              // Skip empty arrays entirely \u2014 they add no value to the review
              continue;
            } else if (typeof item.value[0] === 'object') {
              // Check if all objects are empty {} \u2014 collapse to a count summary
              const allEmpty = item.value.every(v => Object.keys(v).length === 0);
              if (allEmpty) {
                valueText = `${item.value.length} entries _(metadata auto-assigned by DB)_`;
              } else {
                // Check if all objects are identical \u2014 collapse repeats
                const first = JSON.stringify(item.value[0]);
                const allSame = item.value.every(v => JSON.stringify(v) === first);
                if (allSame && item.value.length > 3) {
                  valueText = `${item.value.length}\u00d7 ${first}`;
                } else if (item.value.every(v => v.syntax || v.verb || v.command)) {
                  valueText = '\n' + item.value
                    .map(v => `    \u2022 ${v.syntax ?? v.verb ?? v.command}`)
                    .join('\n');
                } else {
                  // No recognized single-field shape (e.g. add_entity's parsed
                  // child records) \u2014 render as a labeled table instead of an
                  // anonymous positional value list. See buildObjectArrayTable.
                  blocks.push({ type: 'markdown', text: `*${item.key}:*` });
                  blocks.push(...markdownToBlocks(buildObjectArrayTable(item.value)));
                  continue;
                }
              }
            } else {
              valueText = item.value.join(', ');
            }
          } else if (item.value !== null && typeof item.value === 'object') {
            // Plain object (not array) — render as compact JSON
            valueText = JSON.stringify(item.value, null, 2);
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

      case 'reveal': {
        // Inline collapsible container shown above the gate buttons — no click required.
        blocks.push(buildRevealBlock(field));
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
            label:  btn.label,
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
