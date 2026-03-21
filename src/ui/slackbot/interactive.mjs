// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/interactive.mjs
// Handles POST /api/v1/ui/slack/interactive
//
// Receives Slack Block Kit interactive payloads — button clicks, modal submissions.
// Used exclusively for human_gate responses in the workflow execution stack.
//
// This handler is workflow-agnostic. It decodes whatever action + responseData
// the button carries and enqueues a resume_gate message. run-workflow.mjs handles
// all business logic. New workflow gate types require no changes here — only
// new button definitions in callback.mjs.
//
// Flow:
//   1. Slack POSTs URL-encoded payload to this endpoint
//   2. Parse payload JSON — extract workflowRunId, action, gateType, responseData
//   3. Update message in-place via chat.update:
//      - Terminal actions (confirm, cancel): replace with static text — gate closed
//      - Non-terminal actions (remove_table): replace with loading state —
//        run-workflow.mjs will re-post the updated gate via callback.mjs
//   4. Enqueue WORKFLOW_STEP resume_gate to SQS WorkflowQueue
//   5. Return 200 immediately — Slack requires response within 3s
//
// Button value encoding (set by callback.mjs when rendering gates):
//   JSON.stringify({ workflowRunId, action, gateType, ...responseData })
//   e.g. { workflowRunId: 42, action: 'confirm',      gateType: 'review_tables' }
//        { workflowRunId: 42, action: 'remove_table',  gateType: 'review_tables', tableName: 'PGD_Holdings' }
//        { workflowRunId: 42, action: 'confirm',       gateType: 'final_confirm' }
//
// Security: signature verified by handler.mjs before this function is called.
// Experience tier — WebClient used only for chat.update (cosmetic in-place update).

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { ok, err }                       from '../../shared/lambda-utils.mjs';
import { randomUUID }                    from 'crypto';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Terminal actions permanently close the gate — replace with static confirmation.
// All other actions are non-terminal — replace with a transient loading state
// while PROC mutates the data bag and re-posts the updated gate via callback.mjs.
const TERMINAL_ACTIONS = new Set(['confirm', 'cancel']);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — interactive expects POST', req.correlationId);
  }

  const rawPayload = req.body?.payload;
  if (!rawPayload) {
    console.warn('interactive: missing payload field');
    return err(400, 'Missing payload', req.correlationId);
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    console.warn('interactive: payload JSON parse failed', { error: error.message });
    return err(400, 'Invalid payload JSON', req.correlationId);
  }

  // Only handle block_actions for now — modal submissions are Phase 3
  if (payload.type !== 'block_actions') {
    console.info('interactive: ignoring payload type', { type: payload.type });
    return ok({}, req.correlationId);
  }

  const action = payload.actions?.[0];
  if (!action) {
    console.warn('interactive: no actions in payload');
    return err(400, 'No actions in payload', req.correlationId);
  }

  // Decode button value — { workflowRunId, action, gateType, ...responseData fields }
  let buttonValue;
  try {
    buttonValue = JSON.parse(action.value);
  } catch (error) {
    console.warn('interactive: button value parse failed', { value: action.value, error: error.message });
    return err(400, 'Invalid button value encoding', req.correlationId);
  }

  const { workflowRunId, action: userResponse, gateType, ...responseDataFields } = buttonValue;

  if (!workflowRunId || !userResponse) {
    console.warn('interactive: button value missing workflowRunId or action', { buttonValue });
    return err(400, 'Button value must contain workflowRunId and action', req.correlationId);
  }

  // Any extra fields beyond workflowRunId/action/gateType become responseData
  // e.g. tableName for remove_table actions
  const responseData = Object.keys(responseDataFields).length > 0 ? responseDataFields : undefined;

  const slackUserId = payload.user?.id;
  const channel     = payload.channel?.id;
  const messageTs   = payload.message?.ts;
  const traceId     = req.correlationId || randomUUID();

  console.info('interactive: resume_gate enqueuing', {
    workflowRunId, userResponse, gateType, responseData, slackUserId, channel, traceId,
  });

  // Update the Slack message in-place before enqueueing — prevents duplicate clicks.
  // Non-fatal: cosmetic failure must not block the workflow.
  const updateText = TERMINAL_ACTIONS.has(userResponse)
    ? buildTerminalText(userResponse)
    : buildLoadingText(userResponse, responseData);

  try {
    await slack.chat.update({
      channel,
      ts:     messageTs,
      text:   updateText,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: updateText } }],
    });
  } catch (error) {
    console.warn('interactive: chat.update failed (non-fatal)', { error: error.message, traceId });
  }

  // Enqueue resume_gate — run-workflow.mjs dispatches to the correct workflow handler
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:          'WORKFLOW_STEP',
        action:        'resume_gate',
        workflowRunId,
        userResponse,
        gateType,
        responseData,
        slackUserId,
        callback: {
          provider: 'slack',
          channel,
          threadId: messageTs,
        },
        traceId,
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}

// Terminal replacement text — gate is permanently closed after this
function buildTerminalText(userResponse) {
  switch (userResponse) {
    case 'confirm': return '✅ Got it — processing your confirmation...';
    case 'cancel':  return '❌ Cancelled.';
    default:        return '✅ Response recorded.';
  }
}

// Transient loading text — gate will be re-posted by PROC after state mutation
function buildLoadingText(userResponse, responseData) {
  switch (userResponse) {
    case 'remove_table':
      return `🗑️ Removing *${responseData?.tableName ?? 'table'}* — updating...`;
    default:
      return '⏳ Processing your response...';
  }
}
