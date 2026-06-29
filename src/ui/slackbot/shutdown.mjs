// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/shutdown.mjs
// Handles POST /api/v1/ui/slack/shutdown
//
// Accepts: /shutdown            — cancel all active workflow runs
//          /shutdown <runId>    — cancel a specific run by PGC_WorkflowRun.id
//
// Flow: ack-and-notify.
//   SlackbotFunction → enqueue SHUTDOWN to WorkflowQueue → return ephemeral ack
//   ProcFunction (SQS) → shutdown logic → enqueueCallback HUMAN_NOTIFICATION
//
// Response is ephemeral — only visible to the operator who ran /shutdown.
// This is intentional: shutdown is an operator action, not a team notification.

import { err }                             from '../../shared/lambda-utils.mjs';
import { SQSClient, SendMessageCommand }   from '@aws-sdk/client-sqs';
import { randomUUID }                      from 'crypto';

const sqs = new SQSClient({});

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — shutdown expects POST', req.correlationId);
  }

  const text      = (req.body?.text || '').trim();
  const traceId   = req.correlationId || randomUUID();
  const channel   = req.body?.channel_id || 'unknown';
  const threadId  = req.body?.thread_ts  || undefined;

  console.info('shutdown: received', { traceId, text: text || '(cancel all)' });

  // --- Parse optional runId from Slack text field ---
  let workflowRunId = undefined;
  if (text !== '') {
    const parsed = parseInt(text, 10);
    if (isNaN(parsed) || String(parsed) !== text) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: `❌ Invalid run ID "${text}" — usage: \`/shutdown\` or \`/shutdown <runId>\``,
        }),
      };
    }
    workflowRunId = parsed;
  }

  // --- Enqueue SHUTDOWN to WorkflowQueue — PROC handles it and notifies via callback ---
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:     'SHUTDOWN',
        traceId,
        callback: {
          provider: 'slack',
          channel,
          ...(threadId && { threadId }),
        },
        ...(workflowRunId !== undefined && { workflowRunId }),
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('shutdown: SQS enqueue failed', { error: error.message, traceId });
    return {
      statusCode: 200,
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: `❌ Shutdown failed — could not enqueue request. Check logs (traceId: ${traceId})`,
      }),
    };
  }

  console.info('shutdown: enqueued', { traceId, workflowRunId: workflowRunId ?? '(all active)' });

  const ackText = workflowRunId !== undefined
    ? `🔄 Shutdown requested for run ${workflowRunId} — I'll post the result here.`
    : '🔄 Shutdown requested for all active runs — I\'ll post the result here.';

  return {
    statusCode: 200,
    body: JSON.stringify({
      response_type: 'ephemeral',
      text:          ackText,
    }),
  };
}
