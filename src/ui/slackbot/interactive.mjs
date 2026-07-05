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

  // view_closed — modal dismissed without submitting (notify_on_close: true required on view).
  // Enqueues resume_gate with userResponse: 'cancel' so the workflow routes to step 3a cancel path.
  if (payload.type === 'view_closed') {
    return handleViewClosed(payload, req.correlationId);
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

  // explain_followup — button on explain HUMAN_NOTIFICATION.
  // No workflowRunId; routes to EXPLAIN_QUERY, not resume_gate.
  if (buttonValue.action === 'explain_followup') {
    return handleExplainFollowupButton(buttonValue, payload, req.correlationId);
  }

  // explain_step_select — step chosen from an EXPLAIN_STEP_SELECT button list
  // (posted by /explain <run_id>). Opens the question modal; no workflowRunId.
  if (buttonValue.action === 'explain_step_select') {
    return handleExplainStepSelectButton(buttonValue, payload, req.correlationId);
  }

  // minds_eye_followup — "Continue with Novia" button on a Novia response.
  // Routes to MINDS_EYE with existingSessionId.
  if (buttonValue.action === 'minds_eye_followup') {
    return handleMindsEyeFollowupButton(buttonValue, payload, req.correlationId);
  }

  // minds_eye_action_gate — Approve/Cancel on a Novia action gate.
  // Routes to MINDS_EYE_RESUME with sessionId + approved flag.
  if (buttonValue.action === 'minds_eye_action_gate') {
    return handleMindsEyeActionGate(buttonValue, payload, req.correlationId);
  }

  // minds_eye_continue_gate — Continue/Cancel on a Novia turn-limit gate.
  // Routes to MINDS_EYE_RESUME with resumeType: 'continue' — no modal, no pending action.
  if (buttonValue.action === 'minds_eye_continue_gate') {
    return handleMindsEyeContinueGate(buttonValue, payload, req.correlationId);
  }

  // minds_eye_continue_followup — Follow-up button on a Novia turn-limit gate.
  // Opens a modal for the user to type a question; gate buttons remain until modal is submitted.
  if (buttonValue.action === 'minds_eye_continue_followup') {
    return handleMindsEyeContinueFollowupButton(buttonValue, payload, req.correlationId);
  }

  // peek_reveal — reveal button on a human_gate. Opens a read-only modal showing
  // the resolved content. Does NOT advance or resume the gate.
  if (buttonValue.action === 'peek_reveal') {
    return handlePeekReveal(buttonValue, payload, req.correlationId);
  }

  const { workflowRunId, action: userResponse, responseData, label: buttonLabel } = buttonValue;
  if (!workflowRunId || userResponse === undefined || userResponse === null) {
    console.warn('interactive: button value missing workflowRunId or action', { buttonValue });
    return err(400, 'Button value must contain workflowRunId and action', req.correlationId);
  }

  // Modal-trigger buttons carry a `modal` descriptor in the button value.
  // This is the generic path for any button that requires a text input modal —
  // interactive.mjs has no knowledge of workflow-specific action names.
  // The modal descriptor (title, input_label, placeholder, multiline) is set
  // by callback.mjs when building the button from the workflow step definition.
  if (buttonValue.modal) {
    const modal      = buttonValue.modal;
    const triggerId  = payload.trigger_id;
    const channel    = payload.channel?.id;
    const threadId   = payload.container?.message_ts ?? payload.message?.ts;
    const traceId    = req.correlationId || randomUUID();
    const gateText   = payload.message?.text ?? '';
    const gateContext = gateText ? `
> _${gateText}_` : '';

    if (triggerId) {
      try {
        await slack.views.open({
          trigger_id: triggerId,
          view: {
            type:             'modal',
            callback_id:      'text_input_gate',
            notify_on_close:  true,
            private_metadata: JSON.stringify({ workflowRunId, userResponse, traceId, modalTitle: modal.title, callback: { provider: 'slack', channel, threadId } }),
            title:   { type: 'plain_text', text: modal.title ?? 'Input' },
            submit:  { type: 'plain_text', text: 'Submit' },
            close:   { type: 'plain_text', text: 'Cancel' },
            blocks: [
              {
                type:     'input',
                block_id: 'text_input_block',
                label:    { type: 'plain_text', text: modal.input_label ?? 'Enter your input' },
                element: {
                  type:        'plain_text_input',
                  action_id:   'text_input_value',
                  multiline:   modal.multiline ?? false,
                  ...(modal.placeholder ? { placeholder: { type: 'plain_text', text: modal.placeholder } } : {}),
                },
              },
            ],
          },
        });
        console.info('interactive: modal opened', { workflowRunId, action: userResponse, traceId });
      } catch (error) {
        console.error('interactive: views.open failed', { error: error.message, traceId });
        return err(500, `views.open failed: ${error.message}`, req.correlationId);
      }
    } else {
      console.warn('interactive: modal button missing trigger_id — proceeding with resume_gate only', { workflowRunId, action: userResponse, traceId });
    }

    // Do NOT enqueue resume_gate here — the workflow stays suspended at the current gate.
    // handleViewSubmission enqueues resume_gate with responseData.inputValue when the
    // user submits the modal. This prevents the premature advance that caused
    // ping_modal to be written as 'modal_open' before the user had typed anything.
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

  const slackUserId   = payload.user?.id;
  const channel       = payload.channel?.id;
  // container.message_ts is always the ts of the message containing the clicked button.
  // payload.message?.ts can resolve to the parent thread ts in threaded message contexts.
  const threadId      = payload.container?.message_ts ?? payload.message?.ts;
  // response_url is a pre-authorized webhook for updating the source message.
  // Prefer this over chat.update — it works for all gate types including text_input
  // (chat.update silently fails on messages containing input blocks).
  const responseUrl   = payload.response_url ?? null;
  // Original gate message text — included in the ack so the user sees which step was confirmed.
  const gateText      = payload.message?.text ?? '';
  const traceId       = req.correlationId || randomUUID();

  console.info('interactive: resume_gate enqueuing', {
    workflowRunId,
    userResponse,
    slackUserId,
    channel,
    traceId,
  });

  const gateContext    = gateText ? `\n> _${gateText}_` : '';
  const confirmationText = userResponse === 'confirm'
    ? `✅ Confirmed.${gateContext}`
    : userResponse === 'remove_item'
    ? '🗑️ Removing — updating...'
    : userResponse === 'cancel'
    ? `❌ Cancelled.${gateContext}`
    : `✅ ${buttonLabel ?? userResponse}.${gateContext}`;

  // Enqueue resume_gate to WorkflowQueue — Step Processor picks this up.
  // Do this before returning so the workflow resumes even if the response body
  // is somehow not processed by Slack.
  if (userResponse !== 'remove_item') {
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
          // Forwarded so run-workflow can pass it to the re-render HUMAN_GATE
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
  }

  if (userResponse === 'remove_item') {
    // Keep gate open — Step Processor re-enqueues updated HUMAN_GATE. Return
    // empty body so Slack leaves the message as-is.
    return { statusCode: 200, body: '' };
  }

  // Replace the gate message with a confirmation to clear stale buttons.
  // chat.update is used directly — response_url is null for most channel message
  // interactions in practice, and chat.update works for all non-input-block gate
  // types (confirm, choice). text_input gates are handled above and never reach here.
  const confirmationBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: confirmationText } }];
  if (threadId && channel) {
    try {
      await slack.chat.update({
        channel,
        ts:     threadId,
        text:   confirmationText,
        blocks: confirmationBlocks,
      });
    } catch (updateErr) {
      console.warn('interactive: chat.update failed (non-fatal)', { error: updateErr.message, traceId });
      if (responseUrl) {
        try {
          await fetch(responseUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ replace_original: true, text: confirmationText, blocks: confirmationBlocks }),
          });
        } catch (fetchErr) {
          console.warn('interactive: response_url POST failed (non-fatal)', { error: fetchErr.message, traceId });
        }
      }
    }
  }

  return { statusCode: 200, body: '' };
}

// ---------------------------------------------------------------------------
// view_submission — modal form submitted by user
// Handles text_input gates opened via views.open (e.g. add_table in create_domain).
// private_metadata carries { workflowRunId, traceId, callback } set at modal open time.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// handleExplainFollowupButton — "Ask follow-up" clicked on an explain
// HUMAN_NOTIFICATION. Opens a modal whose submission routes to
// EXPLAIN_QUERY (not resume_gate). No workflowRunId involved.
// The source message is left untouched until actual submission
// (handleExplainViewSubmission) — clicking Cancel must not mutate it.
// ---------------------------------------------------------------------------

async function handleExplainFollowupButton(buttonValue, payload, correlationId) {
  const { queryId } = buttonValue;
  const triggerId   = payload.trigger_id;
  const channel     = payload.channel?.id;
  const threadTs    = payload.container?.message_ts ?? payload.message?.ts;
  const traceId     = correlationId || randomUUID();

  if (!queryId) {
    console.warn('interactive: explain_followup missing queryId', { traceId });
    return err(400, 'explain_followup button value missing queryId', correlationId);
  }

  if (triggerId) {
    try {
      await slack.views.open({
        trigger_id: triggerId,
        view: {
          type:             'modal',
          callback_id:      'explain_followup_modal',
          notify_on_close:  false,
          private_metadata: JSON.stringify({ queryId, channel, threadTs, traceId, source: 'followup', originalText: payload.message?.text ?? '' }),
          title:  { type: 'plain_text', text: 'Ask a follow-up' },
          submit: { type: 'plain_text', text: 'Ask' },
          close:  { type: 'plain_text', text: 'Cancel' },
          blocks: [{
            type:     'input',
            block_id: 'followup_input_block',
            label:    { type: 'plain_text', text: 'Your question' },
            element: {
              type:        'plain_text_input',
              action_id:   'followup_input_value',
              multiline:   true,
              placeholder: { type: 'plain_text', text: 'What would you like to know about this output?' },
            },
          }],
        },
      });
      console.info('interactive: explain_followup modal opened', { queryId, traceId });
    } catch (error) {
      console.error('interactive: explain_followup views.open failed', { error: error.message, traceId });
      return err(500, `views.open failed: ${error.message}`, correlationId);
    }
  } else {
    console.warn('interactive: explain_followup missing trigger_id', { queryId, traceId });
  }

  return { statusCode: 200, body: '' };
}

// ---------------------------------------------------------------------------
// handleExplainStepSelectButton — step chosen from an EXPLAIN_STEP_SELECT
// button list (posted by /explain <run_id>). The button carries only queryId —
// no question has been asked yet, so this opens the same question-collection
// modal as handleExplainFollowupButton, using this click's own trigger_id.
// Submission (handleExplainViewSubmission) enqueues EXPLAIN_QUERY as normal.
// The step-picker is left untouched until actual submission — clicking
// Cancel must not destroy the other steps' buttons.
// ---------------------------------------------------------------------------

async function handleExplainStepSelectButton(buttonValue, payload, correlationId) {
  const { queryId } = buttonValue;
  const triggerId = payload.trigger_id;
  const channel   = payload.channel?.id;
  const threadTs  = payload.container?.message_ts ?? payload.message?.ts;
  const traceId   = correlationId || randomUUID();

  if (!queryId) {
    console.warn('interactive: explain_step_select missing queryId', { traceId });
    return err(400, 'explain_step_select button value missing queryId', correlationId);
  }

  if (triggerId) {
    try {
      await slack.views.open({
        trigger_id: triggerId,
        view: {
          type:             'modal',
          callback_id:      'explain_followup_modal',
          notify_on_close:  false,
          private_metadata: JSON.stringify({ queryId, channel, threadTs, traceId, source: 'stepSelect' }),
          title:  { type: 'plain_text', text: 'Ask about this step' },
          submit: { type: 'plain_text', text: 'Ask' },
          close:  { type: 'plain_text', text: 'Cancel' },
          blocks: [{
            type:     'input',
            block_id: 'followup_input_block',
            label:    { type: 'plain_text', text: 'Your question' },
            element: {
              type:        'plain_text_input',
              action_id:   'followup_input_value',
              multiline:   true,
              placeholder: { type: 'plain_text', text: 'What would you like to know about this step?' },
            },
          }],
        },
      });
      console.info('interactive: explain_step_select modal opened', { queryId, traceId });
    } catch (error) {
      console.error('interactive: explain_step_select views.open failed', { error: error.message, traceId });
      return err(500, `views.open failed: ${error.message}`, correlationId);
    }
  } else {
    console.warn('interactive: explain_step_select missing trigger_id', { queryId, traceId });
  }

  return { statusCode: 200, body: '' };
}

// handleMindsEyeFollowupButton — "Continue with Novia" clicked on a Novia response.
// Opens a modal whose submission routes to MINDS_EYE with existingSessionId.
// ---------------------------------------------------------------------------

async function handleMindsEyeFollowupButton(buttonValue, payload, correlationId) {
  const { sessionId } = buttonValue;
  const triggerId     = payload.trigger_id;
  const channel       = payload.channel?.id;
  const threadTs      = payload.container?.message_ts ?? payload.message?.ts;
  const traceId       = correlationId || randomUUID();

  if (!sessionId) {
    console.warn('interactive: minds_eye_followup missing sessionId', { traceId });
    return err(400, 'minds_eye_followup button value missing sessionId', correlationId);
  }

  if (triggerId) {
    try {
      await slack.views.open({
        trigger_id: triggerId,
        view: {
          type:             'modal',
          callback_id:      'minds_eye_followup_modal',
          notify_on_close:  false,
          private_metadata: JSON.stringify({ sessionId, channel, threadTs, traceId }),
          title:  { type: 'plain_text', text: 'Ask Novia' },
          submit: { type: 'plain_text', text: 'Send' },
          close:  { type: 'plain_text', text: 'Cancel' },
          blocks: [{
            type:     'input',
            block_id: 'novia_input_block',
            label:    { type: 'plain_text', text: 'Your message' },
            element: {
              type:        'plain_text_input',
              action_id:   'novia_input_value',
              multiline:   true,
              placeholder: { type: 'plain_text', text: 'Continue the conversation with Novia…' },
            },
          }],
        },
      });
      console.info('interactive: minds_eye_followup modal opened', { sessionId, traceId });
    } catch (error) {
      console.error('interactive: minds_eye_followup views.open failed', { error: error.message, traceId });
      return err(500, `views.open failed: ${error.message}`, correlationId);
    }
  } else {
    console.warn('interactive: minds_eye_followup missing trigger_id', { sessionId, traceId });
  }

  return { statusCode: 200, body: '' };
}

// handleMindsEyeActionGate — Approve/Cancel clicked on a Novia deletion gate.
// Replaces the gate message with a static confirmation, then enqueues MINDS_EYE_RESUME.
// ---------------------------------------------------------------------------

async function handleMindsEyeActionGate(buttonValue, payload, correlationId) {
  const { sessionId, approved } = buttonValue;
  const channel  = payload.channel?.id;
  const threadTs = payload.container?.message_ts ?? payload.message?.ts;
  const traceId  = correlationId || randomUUID();

  if (!sessionId) {
    console.warn('interactive: minds_eye_action_gate missing sessionId', { traceId });
    return err(400, 'minds_eye_action_gate button value missing sessionId', correlationId);
  }

  const confirmText = approved ? '✅ Approved — executing…' : '❌ Cancelled.';
  if (channel && threadTs) {
    try {
      await slack.chat.update({
        channel,
        ts:     threadTs,
        text:   confirmText,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: confirmText } }],
      });
    } catch (error) {
      console.warn('interactive: minds_eye_action_gate chat.update failed (non-fatal)', { error: error.message, traceId });
    }
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'MINDS_EYE_RESUME',
        sessionId,
        approved:  !!approved,
        slackUser: payload.user?.id,
        callback:  { provider: 'slack', channel, threadId: threadTs },
        traceId,
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: minds_eye_action_gate SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, correlationId);
  }

  console.info('interactive: minds_eye_action_gate enqueued MINDS_EYE_RESUME', { sessionId, approved, traceId });
  return { statusCode: 200, body: '' };
}

// handleMindsEyeContinueGate — Continue/Cancel clicked on a Novia turn-limit gate.
// Enqueues MINDS_EYE_RESUME with resumeType: 'continue' — no modal, no pending action lookup.
// ---------------------------------------------------------------------------

async function handleMindsEyeContinueGate(buttonValue, payload, correlationId) {
  const { sessionId, approved } = buttonValue;
  const channel  = payload.channel?.id;
  const threadTs = payload.container?.message_ts ?? payload.message?.ts;
  const traceId  = correlationId || randomUUID();

  if (!sessionId) {
    console.warn('interactive: minds_eye_continue_gate missing sessionId', { traceId });
    return err(400, 'minds_eye_continue_gate button value missing sessionId', correlationId);
  }

  const confirmText = approved ? '▶ Continuing…' : '⏹ Session ended.';
  if (channel && threadTs) {
    try {
      await slack.chat.update({
        channel,
        ts:     threadTs,
        text:   confirmText,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: confirmText } }],
      });
    } catch (error) {
      console.warn('interactive: minds_eye_continue_gate chat.update failed (non-fatal)', { error: error.message, traceId });
    }
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:             'MINDS_EYE_RESUME',
        resumeType:       'continue',
        sessionId,
        approved:         !!approved,
        resetActionCount: !!buttonValue.resetActionCount,
        slackUser:        payload.user?.id,
        callback:         { provider: 'slack', channel, threadId: threadTs },
        traceId,
        enqueuedAt:       new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: minds_eye_continue_gate SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, correlationId);
  }

  console.info('interactive: minds_eye_continue_gate enqueued MINDS_EYE_RESUME', { sessionId, approved, traceId });
  return { statusCode: 200, body: '' };
}

// handleMindsEyeContinueFollowupButton — Follow-up clicked on a Novia turn-limit gate.
// Opens a modal without updating the gate message — if the user cancels, the 3 buttons remain.
// ---------------------------------------------------------------------------

async function handleMindsEyeContinueFollowupButton(buttonValue, payload, correlationId) {
  const { sessionId } = buttonValue;
  const triggerId     = payload.trigger_id;
  const channel       = payload.channel?.id;
  const threadTs      = payload.container?.message_ts ?? payload.message?.ts;
  const traceId       = correlationId || randomUUID();

  if (!sessionId) {
    console.warn('interactive: minds_eye_continue_followup missing sessionId', { traceId });
    return err(400, 'minds_eye_continue_followup button value missing sessionId', correlationId);
  }

  if (triggerId) {
    try {
      await slack.views.open({
        trigger_id: triggerId,
        view: {
          type:             'modal',
          callback_id:      'minds_eye_continue_followup_modal',
          notify_on_close:  false,
          private_metadata: JSON.stringify({ sessionId, channel, threadTs, traceId }),
          title:  { type: 'plain_text', text: 'Ask Novia' },
          submit: { type: 'plain_text', text: 'Send' },
          close:  { type: 'plain_text', text: 'Cancel' },
          blocks: [{
            type:     'input',
            block_id: 'novia_followup_input_block',
            label:    { type: 'plain_text', text: 'Your question' },
            element: {
              type:        'plain_text_input',
              action_id:   'novia_followup_input_value',
              multiline:   true,
              placeholder: { type: 'plain_text', text: 'Ask what Novia is doing, or give new direction…' },
            },
          }],
        },
      });
      console.info('interactive: minds_eye_continue_followup modal opened', { sessionId, traceId });
    } catch (error) {
      console.error('interactive: minds_eye_continue_followup views.open failed', { error: error.message, traceId });
      return err(500, `views.open failed: ${error.message}`, correlationId);
    }
  } else {
    console.warn('interactive: minds_eye_continue_followup missing trigger_id', { sessionId, traceId });
  }

  return { statusCode: 200, body: '' };
}

// handleMindsEyeContinueFollowupSubmission — minds_eye_continue_followup_modal submitted.
// Echoes question to thread, then enqueues MINDS_EYE_RESUME with resumeType: 'followup'.
// Novia answers, then re-posts the Continue/Follow-up/Cancel gate.
// ---------------------------------------------------------------------------

async function handleMindsEyeContinueFollowupSubmission(payload, traceId) {
  let meta;
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  } catch {
    console.warn('interactive: minds_eye_continue_followup_modal private_metadata parse failed', { traceId });
    return err(400, 'Invalid private_metadata', traceId);
  }

  const { sessionId, channel, threadTs, traceId: metaTraceId } = meta;
  if (!sessionId || !channel) {
    console.warn('interactive: minds_eye_continue_followup_modal missing sessionId or channel', { meta, traceId });
    return err(400, 'minds_eye_continue_followup_modal private_metadata must contain sessionId and channel', traceId);
  }

  const stateValues = payload.view?.state?.values ?? {};
  let inputValue = null;
  for (const blockValues of Object.values(stateValues)) {
    for (const actionValue of Object.values(blockValues)) {
      const text = actionValue?.value?.trim();
      if (text && !inputValue) inputValue = text;
    }
  }

  if (!inputValue) {
    console.warn('interactive: minds_eye_continue_followup_modal empty submission', { sessionId, traceId });
    return { statusCode: 200, body: '' };
  }

  try {
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text:      `❓ ${inputValue}`,
    });
  } catch (error) {
    console.warn('interactive: minds_eye_continue_followup echo failed (non-fatal)', { error: error.message });
  }

  const effectiveTrace = metaTraceId ?? traceId;
  console.info('interactive: minds_eye_continue_followup_modal — enqueuing MINDS_EYE_RESUME', {
    sessionId, traceId: effectiveTrace,
  });

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:         'MINDS_EYE_RESUME',
        resumeType:   'followup',
        sessionId,
        followupText: inputValue,
        slackUser:    payload.user?.id,
        callback:     { provider: 'slack', channel, threadId: threadTs },
        traceId:      effectiveTrace,
        enqueuedAt:   new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: minds_eye_continue_followup_modal SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, traceId);
  }

  return { statusCode: 200, body: '' };
}

async function handleViewSubmission(payload, correlationId) {
  const traceId = correlationId || randomUUID();

  // explain_followup_modal — routes to EXPLAIN_QUERY, not resume_gate
  if (payload.view?.callback_id === 'explain_followup_modal') {
    return handleExplainViewSubmission(payload, traceId);
  }

  // minds_eye_followup_modal — routes to MINDS_EYE with existingSessionId
  if (payload.view?.callback_id === 'minds_eye_followup_modal') {
    return handleMindsEyeViewSubmission(payload, traceId);
  }

  // minds_eye_continue_followup_modal — routes to MINDS_EYE_RESUME with resumeType: 'followup'
  if (payload.view?.callback_id === 'minds_eye_continue_followup_modal') {
    return handleMindsEyeContinueFollowupSubmission(payload, traceId);
  }

  let meta;
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  } catch {
    console.warn('interactive: view_submission private_metadata parse failed', { traceId });
    return err(400, 'Invalid private_metadata', correlationId);
  }

  const { workflowRunId, userResponse: modalUserResponse, traceId: metaTraceId, modalTitle, callback } = meta;
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
    action: modalUserResponse,
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
        userResponse:  modalUserResponse ?? 'confirm',
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

  // Replace the gate message with a confirmation to clear stale buttons.
  const confirmText = `📝 ${modalTitle ?? 'Input'} — submitted.`;
  if (callback.channel && callback.threadId) {
    try {
      await slack.chat.update({
        channel: callback.channel,
        ts:      callback.threadId,
        text:    confirmText,
        blocks:  [{ type: 'section', text: { type: 'mrkdwn', text: confirmText } }],
      });
    } catch (updateErr) {
      console.warn('interactive: view_submission chat.update failed (non-fatal)', { error: updateErr.message, traceId });
    }
  }

  // Returning null body with 200 closes the modal — Slack interprets empty response as success.
  return { statusCode: 200, body: '' };
}

// ---------------------------------------------------------------------------
// handleExplainViewSubmission — explain_followup_modal submitted.
// Enqueues EXPLAIN_QUERY with the submitted text and the original thread context.
// ---------------------------------------------------------------------------

async function handleExplainViewSubmission(payload, traceId) {
  let meta;
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  } catch {
    console.warn('interactive: explain_followup_modal private_metadata parse failed', { traceId });
    return err(400, 'Invalid private_metadata', traceId);
  }

  const { queryId, channel, threadTs, source, originalText, traceId: metaTraceId } = meta;
  if (!queryId || !channel) {
    console.warn('interactive: explain_followup_modal missing queryId or channel', { meta, traceId });
    return err(400, 'explain_followup_modal private_metadata must contain queryId and channel', traceId);
  }

  const stateValues = payload.view?.state?.values ?? {};
  let inputValue = null;
  for (const blockValues of Object.values(stateValues)) {
    for (const actionValue of Object.values(blockValues)) {
      const text = actionValue?.value?.trim();
      if (text && !inputValue) inputValue = text;
    }
  }

  if (!inputValue) {
    console.warn('interactive: explain_followup_modal empty submission', { queryId, traceId });
    return { statusCode: 200, body: '' };
  }

  // Disable the source message (button or step-picker) now that a question has
  // actually been submitted — deferred from button-click time so Cancel leaves
  // it untouched. Prevents stale "Ask follow-up"/step-picker buttons accumulating.
  if (channel && threadTs) {
    const disableText = source === 'stepSelect'
      ? '🔍 Step selected — question submitted.'
      : `💬 Follow-up submitted.${originalText ? `\n> _${originalText}_` : ''}`;
    try {
      await slack.chat.update({
        channel,
        ts:     threadTs,
        text:   disableText,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: disableText } }],
      });
    } catch (error) {
      console.warn('interactive: explain_followup_modal chat.update failed (non-fatal)', { error: error.message, traceId });
    }
  }

  // Echo the user's question to the thread so the full conversation is visible.
  try {
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text:      `❓ ${inputValue}`,
    });
  } catch (error) {
    console.warn('interactive: explain_followup echo failed (non-fatal)', { error: error.message });
  }

  const effectiveTrace = metaTraceId ?? traceId;
  console.info('interactive: explain_followup_modal — enqueuing EXPLAIN_QUERY', {
    queryId, traceId: effectiveTrace,
  });

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'EXPLAIN_QUERY',
        traceId:   effectiveTrace,
        queryId,
        prompt:    inputValue,
        slackUser: payload.user?.id,
        callback:  { provider: 'slack', channel, threadId: threadTs },
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: explain_followup_modal SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, traceId);
  }

  return { statusCode: 200, body: '' };
}

// handleMindsEyeViewSubmission — minds_eye_followup_modal submitted.
// Enqueues MINDS_EYE with existingSessionId to continue the agentic session.
// ---------------------------------------------------------------------------

async function handleMindsEyeViewSubmission(payload, traceId) {
  let meta;
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? '{}');
  } catch {
    console.warn('interactive: minds_eye_followup_modal private_metadata parse failed', { traceId });
    return err(400, 'Invalid private_metadata', traceId);
  }

  const { sessionId, channel, threadTs, traceId: metaTraceId } = meta;
  if (!sessionId || !channel) {
    console.warn('interactive: minds_eye_followup_modal missing sessionId or channel', { meta, traceId });
    return err(400, 'minds_eye_followup_modal private_metadata must contain sessionId and channel', traceId);
  }

  const stateValues = payload.view?.state?.values ?? {};
  let inputValue = null;
  for (const blockValues of Object.values(stateValues)) {
    for (const actionValue of Object.values(blockValues)) {
      const text = actionValue?.value?.trim();
      if (text && !inputValue) inputValue = text;
    }
  }

  if (!inputValue) {
    console.warn('interactive: minds_eye_followup_modal empty submission', { sessionId, traceId });
    return { statusCode: 200, body: '' };
  }

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text:      `🧠 "${inputValue}"`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.warn('interactive: minds_eye_followup echo failed (non-fatal)', { error: error.message });
  }

  const effectiveTrace = metaTraceId ?? traceId;
  console.info('interactive: minds_eye_followup_modal — enqueuing MINDS_EYE', {
    sessionId, traceId: effectiveTrace,
  });

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:              'MINDS_EYE',
        traceId:           effectiveTrace,
        prompt:            inputValue,
        sessionId,
        slackUser:         payload.user?.id,
        callback:          { provider: 'slack', channel, threadId: ackTs ?? threadTs },
        enqueuedAt:        new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('interactive: minds_eye_followup_modal SQS enqueue failed', { error: error.message, traceId });
    return err(500, `SQS enqueue failed: ${error.message}`, traceId);
  }

  return { statusCode: 200, body: '' };
}

// ---------------------------------------------------------------------------
// handlePeekReveal — reveal button clicked on a human_gate.
// Posts a task_card block in the thread showing the resolved content.
// Never enqueues resume_gate.
// ---------------------------------------------------------------------------

async function handlePeekReveal(buttonValue, payload, correlationId) {
  const { content, button_label } = buttonValue;
  const channel  = payload.channel?.id;
  const threadTs = payload.container?.message_ts ?? payload.message?.ts;
  const traceId  = correlationId || randomUUID();

  try {
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text:      content ?? '(no content)',
      blocks: [{
        type:    'task_card',
        task_id: randomUUID(),
        title:   button_label ?? 'Definition',
        status:  'complete',
        output: {
          type:     'rich_text',
          elements: [{
            type:     'rich_text_section',
            elements: [{ type: 'text', text: content ?? '(no content)' }],
          }],
        },
      }],
    });
    console.info('interactive: peek_reveal task_card posted', { traceId });
  } catch (error) {
    console.error('interactive: peek_reveal task_card failed', { error: error.message, traceId });
  }

  return { statusCode: 200, body: '' };
}

// ---------------------------------------------------------------------------
// view_closed — modal dismissed without submitting (Cancel or × button).
// Fires only when notify_on_close: true is set on the view.
// The workflow remains suspended at the same gate — no resume_gate enqueued.
// The gate message stays active in Slack; user can click another button.
// ---------------------------------------------------------------------------

async function handleViewClosed(payload, correlationId) {
  const traceId = correlationId || randomUUID();
  console.info('interactive: view_closed — modal dismissed, workflow gate remains active', { traceId });
  return { statusCode: 200, body: '' };
}
