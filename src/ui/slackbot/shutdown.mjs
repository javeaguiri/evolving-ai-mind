// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/shutdown.mjs
// Handles POST /api/v1/ui/slack/shutdown
//
// Accepts: /shutdown            — cancel all active workflow runs
//          /shutdown <runId>    — cancel a specific run by PGC_WorkflowRun.id
//
// Flow: synchronous — no SQS hop.
//   SlackbotFunction → POST /proc/shutdown (HTTP fetch) → inline Slack response
//
// Response is ephemeral — only visible to the operator who ran /shutdown.
// This is intentional: shutdown is an operator action, not a team notification.

import { err } from '../../shared/lambda-utils.mjs';

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — shutdown expects POST', req.correlationId);
  }

  const text      = (req.body?.text || '').trim();
  const traceId   = req.correlationId;
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

  // --- Call PROC /shutdown synchronously ---
  const procUrl  = `${process.env.PROC_API_URL}/api/v1/proc/shutdown`;
  const payload  = {
    traceId,
    callback: {
      provider: 'slack',
      channel,
      ...(threadId && { threadId }),
    },
    ...(workflowRunId !== undefined && { workflowRunId }),
  };

  let result;
  try {
    const resp = await fetch(procUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    result = await resp.json();

    if (!resp.ok) {
      console.error('shutdown: PROC call failed', { status: resp.status, result, traceId });
      return {
        statusCode: 200,
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: `❌ Shutdown failed — PROC returned ${resp.status}. Check logs (traceId: ${traceId})`,
        }),
      };
    }
  } catch (error) {
    console.error('shutdown: PROC fetch error', { error: error.message, traceId });
    return {
      statusCode: 200,
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: `❌ Shutdown failed — could not reach PROC. Check logs (traceId: ${traceId})`,
      }),
    };
  }

  // --- Format inline Slack response ---
  const text_out = formatShutdownMessage(result, workflowRunId);
  console.info('shutdown: complete', { traceId, cancelledCount: result.cancelledCount });

  return {
    statusCode: 200,
    body: JSON.stringify({
      response_type: 'ephemeral',
      text:          text_out,
    }),
  };
}

// ---------------------------------------------------------------------------
// Format ShutdownResult as a human-readable Slack message
// ---------------------------------------------------------------------------

function formatShutdownMessage(result, workflowRunId) {
  const { cancelledCount, cancelled = [] } = result;

  // Specific run requested but not found / already inactive
  if (workflowRunId !== undefined && cancelledCount === 0) {
    return `✅ Run ${workflowRunId} is not active (already completed, cancelled, or not found)`;
  }

  // No active runs at all
  if (cancelledCount === 0) {
    return '✅ No active workflows to cancel';
  }

  // One or more runs cancelled
  if (workflowRunId !== undefined && cancelled.length === 1) {
    const r = cancelled[0];
    const step = r.stoppedAtStep != null ? `, was at step ${r.stoppedAtStep}` : '';
    return `🛑 Run ${r.workflowRunId} cancelled (${r.workflowName}${step})`;
  }

  // Cancel-all — list each run
  const list = cancelled
    .map(r => `${r.workflowName} (run ${r.workflowRunId})`)
    .join(', ');
  return `🛑 Shutdown complete — ${cancelledCount} run(s) cancelled: ${list}`;
}
