// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/interactive.mjs
// Handles POST /api/v1/ui/slack/interactive
//
// Receives Slack Block Kit interactive payloads — button clicks, modal submissions.
// Used exclusively for human_gate responses in the workflow execution stack.
//
// Flow:
//   1. Slack POSTs URL-encoded payload to this endpoint
//   2. Parse payload JSON — extract workflowRunId + action from button value
//   3. Replace the Block Kit buttons with a static confirmation (chat.update)
//      — prevents the user clicking the same button multiple times
//   4. Enqueue WORKFLOW_STEP resume_gate message to SQS WorkflowQueue
//   5. Return 200 immediately — Slack requires response within 3s
//
// Button value encoding: JSON.stringify({ workflowRunId, action, responseData? })
// e.g. '{"workflowRunId":42,"action":"confirm"}'
//      '{"workflowRunId":42,"action":"remove_item","responseData":{"tableName":"PGD_Holdings"}}'
// responseData is forwarded to the Step Processor for actions that carry item-specific data.
//
// Security: signature verified by handler.mjs before this function is called.
// Experience tier — WebClient used only to disable buttons via chat.update.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { ok, err }                       from '../../shared/lambda-utils.mjs';
import { randomUUID }                    from 'crypto';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — interactive expects POST', req.correlationId);
  }

  // Slack sends a single form field 'payload' containing URL-encoded JSON
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

  // Decode button value — { workflowRunId, action }
  let buttonValue;
  try {
    buttonValue = JSON.parse(action.value);
  } catch (error) {
    console.warn('interactive: button value parse failed', {
      value: action.value,
      error: error.message,
    });
    return err(400, 'Invalid button value encoding', req.correlationId);
  }

  const { workflowRunId, action: userResponse, responseData } = buttonValue;
  if (!workflowRunId || !userResponse) {
    console.warn('interactive: button value missing workflowRunId or action', { buttonValue });
    return err(400, 'Button value must contain workflowRunId and action', req.correlationId);
  }

  // Extract any plain_text_input value typed by the user.
  // Slack puts these in payload.state.values keyed by block_id → action_id → value.
  // We flatten all values and take the first non-empty one — text_input gates
  // have exactly one input element per dialog.
  let inputValue = null;
  const stateValues = payload.state?.values ?? {};
  for (const blockValues of Object.values(stateValues)) {
    for (const actionValue of Object.values(blockValues)) {
      const text = actionValue?.value?.trim();
      if (text) {
        inputValue = text;
        break;
      }
    }
    if (inputValue) break;
  }

  // Merge inputValue into responseData so run-workflow can write it to local_state
  const mergedResponseData = inputValue
    ? { ...(responseData ?? {}), inputValue }
    : responseData;

  const slackUserId = payload.user?.id;
  const channel     = payload.channel?.id;
  const threadId    = payload.message?.ts;
  const traceId     = req.correlationId || randomUUID();

  console.info('interactive: resume_gate enqueuing', {
    workflowRunId,
    userResponse,
    slackUserId,
    channel,
    traceId,
  });

  // Replace buttons with a static confirmation — prevents duplicate clicks.
  // chat.update replaces the original message in-place. If this fails we still
  // enqueue the resume_gate — a cosmetic failure should not block the workflow.
  const confirmationText = userResponse === 'confirm'
    ? '✅ Got it — processing your response...'
    : userResponse === 'remove_item'
    ? '🗑️ Removing — updating...'
    : '❌ Cancelled.';

  // For remove_item we keep the gate open — don't replace the full message,
  // just acknowledge. The Step Processor will re-enqueue an updated WORKFLOW_GATE.
  // For confirm/cancel we replace the message to prevent further clicks.
  if (userResponse !== 'remove_item') {
    try {
      await slack.chat.update({
        channel,
        ts:     threadId,
        text:   confirmationText,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: confirmationText },
          },
        ],
      });
    } catch (error) {
      console.warn('interactive: chat.update failed (non-fatal)', {
        error: error.message,
        traceId,
      });
    }
  }

  // Enqueue resume_gate to WorkflowQueue — Step Processor picks this up
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:          'WORKFLOW_STEP',
        action:        'resume_gate',
        workflowRunId,
        userResponse,
        ...(mergedResponseData && { responseData: mergedResponseData }),
        // message_ts is the ts of the gate message being interacted with.
        // Forwarded so run-workflow can pass it to the re-render WORKFLOW_GATE
        // payload, enabling callback.mjs to chat.update in-place on remove_item.
        message_ts:    threadId,
        slackUserId,
        callback: {
          provider: 'slack',
          channel,
          threadId,
        },
        traceId,
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  // Return empty 200 — Slack does not display this response body
  // The workflow result will arrive via SlackCallbackListenerFunction as a thread reply
  return { statusCode: 200, body: '' };
}
