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

  // view_submission — modal submitted by user (e.g. text_input gate add_table flow).
  if (payload.type === 'view_submission') {
    return handleViewSubmission(payload, req.correlationId);
  }

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

  // text_input gate — open a Slack modal using trigger_id (expires in 3s, must be synchronous).
  // The workflow is already suspended at the text_input step waiting for resume_gate.
  // The WORKFLOW_GATE callback will post nothing (textbox case emits no blocks).
  // Modal submission arrives as view_submission and is handled by handleViewSubmission below.
  if (userResponse === 'add_table') {
    const triggerId = payload.trigger_id;
    const channel   = payload.channel?.id;
    const threadId  = payload.container?.message_ts ?? payload.message?.ts;
    const traceId   = req.correlationId || randomUUID();
    if (triggerId) {
      try {
        await slack.views.open({
          trigger_id: triggerId,
          view: {
            type:             'modal',
            callback_id:      'text_input_gate',
            private_metadata: JSON.stringify({ workflowRunId, traceId, callback: { provider: 'slack', channel, threadId } }),
            title:    { type: 'plain_text', text: 'Add a table' },
            submit:   { type: 'plain_text', text: 'Submit' },
            close:    { type: 'plain_text', text: 'Cancel' },
            blocks: [
              {
                type:     'input',
                block_id: 'text_input_block',
                label:    { type: 'plain_text', text: 'Describe the table' },
                element: {
                  type:        'plain_text_input',
                  action_id:   'text_input_value',
                  multiline:   true,
                  placeholder: { type: 'plain_text', text: 'What it stores and how it relates to the other tables.' },
                },
              },
            ],
          },
        });
        console.info('interactive: text_input modal opened', { workflowRunId, traceId });
      } catch (error) {
        console.error('interactive: views.open failed', { error: error.message, traceId });
        return err(500, \`views.open failed: \${error.message}\`, req.correlationId);
      }
    } else {
      console.warn('interactive: add_table missing trigger_id', { workflowRunId, traceId });
    }
    return { statusCode: 200, body: '' };
  }

  // Extract any plain_text_input value typed by the user.
  // Slack puts these in payload.state.values keyed by block_id → action_id → value.
  // We flatten all values and take the first non-empty one — text_input gates
  // have exactly one input element per dialog.
  let inputValue    = null;
  let selectedValue = null;  // for radio_buttons / static_select elements
  const stateValues = payload.state?.values ?? {};
  for (const blockValues of Object.values(stateValues)) {
    for (const actionValue of Object.values(blockValues)) {
      // plain_text_input
      const text = actionValue?.value?.trim();
      if (text && !inputValue) {
        inputValue = text;
      }
      // radio_buttons and static_select — selected option value
      const sel = actionValue?.selected_option?.value;
      if (sel && !selectedValue) {
        selectedValue = sel;
      }
    }
  }

  // Merge inputValue and selectedValue into responseData so run-workflow
  // can write them to local_state as needed.
  const mergedResponseData = {
    ...(responseData ?? {}),
    ...(inputValue    ? { inputValue }    : {}),
    ...(selectedValue ? { selectedValue } : {}),
  };

  const slackUserId = payload.user?.id;
  const channel     = payload.channel?.id;
  // container.message_ts is always the ts of the message containing the clicked button.
  // payload.message?.ts can resolve to the parent thread ts in threaded message contexts.
  const threadId    = payload.container?.message_ts ?? payload.message?.ts;
  // Original gate message text — included in the ack so the user sees which step was confirmed.
  const gateText    = payload.message?.text ?? '';
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
  //
  // Include the gate's own message text in the ack so the user can see which
  // step was just completed — without it all acks look identical in the thread.
  const gateContext    = gateText ? `\n> _${gateText}_` : '';
  const confirmationText = userResponse === 'confirm'
    ? `✅ Confirmed.${gateContext}`
    : userResponse === 'remove_item'
    ? '🗑️ Removing — updating...'
    : userResponse === 'cancel'
    ? `❌ Cancelled.${gateContext}`
    : `✅ ${userResponse}.${gateContext}`;

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
        error:     error.message,
        errorCode: error.data?.error,   // Slack error code e.g. 'cant_update_message'
        channel,
        ts:        threadId,
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

// ---------------------------------------------------------------------------
// view_submission — modal form submitted by user
// Handles text_input gates opened via views.open (e.g. add_table in create_domain).
// private_metadata carries { workflowRunId, traceId, callback } set at modal open time.
// ---------------------------------------------------------------------------

async function handleViewSubmission(payload, correlationId) {
  const traceId = correlationId || randomUUID();

  let meta;
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  } catch {
    console.warn('interactive: view_submission private_metadata parse failed', { traceId });
    return err(400, 'Invalid private_metadata', correlationId);
  }

  const { workflowRunId, traceId: metaTraceId, callback } = meta;
  if (!workflowRunId || !callback) {
    console.warn('interactive: view_submission missing workflowRunId or callback', { meta, traceId });
    return err(400, 'view_submission private_metadata must contain workflowRunId and callback', correlationId);
  }

  // Extract submitted text from view state — keyed by block_id → action_id.
  const stateValues = payload.view?.state?.values ?? {};
  let inputValue = null;
  for (const blockValues of Object.values(stateValues)) {
    for (const actionValue of Object.values(blockValues)) {
      const text = actionValue?.value?.trim();
      if (text && !inputValue) inputValue = text;
    }
  }

  console.info('interactive: view_submission resume_gate enqueuing', {
    workflowRunId,
    hasInput: !!inputValue,
    traceId: metaTraceId ?? traceId,
  });

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:          'WORKFLOW_STEP',
        action:        'resume_gate',
        workflowRunId,
        userResponse:  'confirm',
        responseData:  { inputValue: inputValue ?? '' },
        callback,
        traceId:       metaTraceId ?? traceId,
        enqueuedAt:    new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: view_submission SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, correlationId);
  }

  // Returning null body with 200 closes the modal — Slack interprets empty response as success.
  return { statusCode: 200, body: '' };
}
