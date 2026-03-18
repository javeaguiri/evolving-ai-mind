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
//   3. Enqueue WORKFLOW_STEP resume_gate message to SQS WorkflowQueue
//   4. Return 200 immediately — Slack requires response within 3s
//
// Button value encoding: JSON.stringify({ workflowRunId, action })
// e.g. '{"workflowRunId":42,"action":"confirm"}'
// This makes the handler stateless — no DB lookup needed to route the response.
//
// Security: signature verified by handler.mjs before this function is called.
// Experience tier only — no business logic, no DB calls, no LLM calls.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ok, err }                       from '../../shared/lambda-utils.mjs';
import { randomUUID }                    from 'crypto';

const sqs = new SQSClient({});

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

  const { workflowRunId, action: userResponse } = buttonValue;
  if (!workflowRunId || !userResponse) {
    console.warn('interactive: button value missing workflowRunId or action', { buttonValue });
    return err(400, 'Button value must contain workflowRunId and action', req.correlationId);
  }

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

  // Enqueue resume_gate to WorkflowQueue — Step Processor picks this up
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:          'WORKFLOW_STEP',
        action:        'resume_gate',
        workflowRunId,
        userResponse,
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
