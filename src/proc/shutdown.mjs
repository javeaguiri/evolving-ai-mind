// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/shutdown.mjs
// Handles SHUTDOWN SQS messages (enqueued by slackbot/shutdown.mjs)
// and POST /api/v1/proc/shutdown (direct HTTP — curl/manual use only).
//
// Steps:
//   1. GET active runs from SERV — PGC_WorkflowRun filtered by
//      status IN ('running', 'awaiting_human_gate'), optionally by id
//   2. UPDATE each matched run to status=cancelled via SERV updateRows
//   3. Enqueue WORKFLOW_STEP/cancel to WorkflowQueue for each cancelled run
//      so the Step Processor discards any in-flight execution
//   4. Notify — SQS path: enqueueCallback HUMAN_NOTIFICATION to Slack
//              HTTP path: return ShutdownResult synchronously
//
// NOTE: Step Processor MUST check PGC_WorkflowRun.status before executing
// any step. That check is what gives the cancel signal its effect.

import { ok, err }          from '../shared/lambda-utils.mjs';
import { enqueueCallback }  from '../shared/sqs-callback.mjs';

export async function handle(req) {
  const { workflowRunId } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;
  const servUrl  = process.env.SERV_API_URL;

  console.info('shutdown: starting', {
    traceId,
    workflowRunId: workflowRunId ?? '(all active)',
    source: req.source,
  });

  // ---------------------------------------------------------------------------
  // Step 1 — fetch active runs from SERV
  // ---------------------------------------------------------------------------

  const filters = [{ column: 'status', op: 'in', value: ['running', 'awaiting_human_gate'] }];
  if (workflowRunId !== undefined) {
    filters.push({ column: 'id', op: 'eq', value: workflowRunId });
  }

  let activeRuns;
  try {
    const resp = await fetch(`${servUrl}/api/v1/serv/table/getRows`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
      body:    JSON.stringify({ tableName: 'PGC_WorkflowRun', filters }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('shutdown: getRows failed', { status: resp.status, data, traceId });
      return err(500, `shutdown: could not fetch active runs — ${data.error ?? resp.status}`, traceId);
    }
    activeRuns = data.rows ?? [];
  } catch (error) {
    console.error('shutdown: getRows fetch error', { error: error.message, traceId });
    return err(500, `shutdown: getRows fetch error — ${error.message}`, traceId);
  }

  console.info('shutdown: active runs found', { count: activeRuns.length, traceId });

  // ---------------------------------------------------------------------------
  // Step 1b — resolve workflow names from PGC_Workflow (workflow_name is not on the run row)
  // ---------------------------------------------------------------------------

  const workflowIds = [...new Set(activeRuns.map(r => r.workflow_id).filter(Boolean))];
  const workflowNameMap = {};
  if (workflowIds.length > 0) {
    try {
      const resp = await fetch(`${servUrl}/api/v1/serv/table/getRows`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
        body:    JSON.stringify({ tableName: 'PGC_Workflow', filters: [{ column: 'id', op: 'in', value: workflowIds }], columns: ['id', 'name'] }),
      });
      const data = await resp.json();
      for (const wf of data.rows ?? []) workflowNameMap[wf.id] = wf.name;
    } catch {
      // non-fatal — names fall back to workflow_id
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2 — cancel each run via SERV updateRows
  // ---------------------------------------------------------------------------

  const cancelledRuns = [];

  for (const run of activeRuns) {
    try {
      const resp = await fetch(`${servUrl}/api/v1/serv/table/updateRows`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
        body:    JSON.stringify({
          tableName: 'PGC_WorkflowRun',
          filters:   [{ column: 'id', op: 'eq', value: run.id }],
          updates:   { status: 'cancelled' },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        console.error('shutdown: updateRows failed for run', {
          runId: run.id, status: resp.status, data, traceId,
        });
        continue;
      }
      cancelledRuns.push({
        workflowRunId:  run.id,
        workflowName:   workflowNameMap[run.workflow_id] ?? `workflow_id:${run.workflow_id ?? '?'}`,
        stoppedAtStep:  run.current_step_index ?? null,
      });
    } catch (error) {
      console.error('shutdown: updateRows fetch error for run', {
        runId: run.id, error: error.message, traceId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3 — enqueue WORKFLOW_STEP/cancel for each successfully cancelled run
  // ---------------------------------------------------------------------------

  for (const run of cancelledRuns) {
    try {
      await enqueueCallback(
        { provider: 'internal', channel: null, threadId: null },
        { type: 'WORKFLOW_STEP', action: 'cancel', workflowRunId: run.workflowRunId, traceId }
      );
    } catch (error) {
      console.warn('shutdown: SQS cancel enqueue failed for run', {
        runId: run.workflowRunId, error: error.message, traceId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4 — notify
  // ---------------------------------------------------------------------------

  const result = {
    success:        true,
    cancelledCount: cancelledRuns.length,
    cancelled:      cancelledRuns,
  };

  console.info('shutdown: complete', {
    traceId,
    cancelledCount: cancelledRuns.length,
    attempted:      activeRuns.length,
  });

  // SQS path — post result to Slack via callback
  if (req.source === 'sqs' && callback) {
    const message = formatShutdownMessage(result, workflowRunId);
    try {
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', message, traceId });
    } catch (error) {
      console.warn('shutdown: callback enqueue failed', { error: error.message, traceId });
    }
    return;
  }

  // HTTP path — return result synchronously (curl/manual use)
  return ok(result, traceId);
}

// ---------------------------------------------------------------------------
// Format ShutdownResult as a human-readable Slack message
// ---------------------------------------------------------------------------

function formatShutdownMessage(result, workflowRunId) {
  const { cancelledCount, cancelled = [] } = result;

  if (workflowRunId !== undefined && cancelledCount === 0) {
    return `✅ Run ${workflowRunId} is not active (already completed, cancelled, or not found)`;
  }

  if (cancelledCount === 0) {
    return '✅ No active workflows to cancel';
  }

  if (workflowRunId !== undefined && cancelled.length === 1) {
    const r = cancelled[0];
    const step = r.stoppedAtStep != null ? `, was at step ${r.stoppedAtStep}` : '';
    return `🛑 Run ${r.workflowRunId} cancelled (${r.workflowName}${step})`;
  }

  const list = cancelled.map(r => `${r.workflowName} (run ${r.workflowRunId})`).join(', ');
  return `🛑 Shutdown complete — ${cancelledCount} run(s) cancelled: ${list}`;
}
