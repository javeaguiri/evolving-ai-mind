// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/shutdown.mjs
// Handles POST /api/v1/proc/shutdown
//
// Transport-agnostic — called via HTTP fetch from SlackbotFunction.
// No SQS delivery path today (shutdown is always synchronous), but req.source
// is checked for response path consistency with the rest of PROC.
//
// Steps:
//   1. GET active runs from SERV — PGC_WorkflowRun filtered by status=active
//      (and optionally by id=workflowRunId)
//   2. UPDATE each matched run to status=cancelled via SERV updateRows
//   3. Enqueue WORKFLOW_STEP/cancel to WorkflowQueue for each cancelled run
//      so the Step Processor discards any in-flight execution
//   4. Return ShutdownResult
//
// NOTE: Step Processor MUST check PGC_WorkflowRun.status before executing
// any step. That check is what gives the cancel signal its effect.

import { ok, err }          from '../shared/lambda-utils.mjs';
import { enqueueCallback }  from '../shared/sqs-callback.mjs';

export async function handle(req) {
  const { workflowRunId, callback, traceId } = req.body ?? {};
  const servUrl = process.env.SERV_API_URL;

  console.info('shutdown: starting', {
    traceId,
    workflowRunId: workflowRunId ?? '(all active)',
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

  // No active runs — return early, not an error
  if (activeRuns.length === 0) {
    const result = { success: true, cancelledCount: 0, cancelled: [] };
    return ok(result, traceId);
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
        // Log and continue — cancel as many runs as possible, report partial success
        console.error('shutdown: updateRows failed for run', {
          runId: run.id, status: resp.status, data, traceId,
        });
        continue;
      }
      cancelledRuns.push({
        workflowRunId:  run.id,
        workflowName:   run.workflow_name ?? 'unknown',
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
  // The Step Processor checks status before executing — this message signals
  // it to discard any in-flight execution frame for this run.
  // ---------------------------------------------------------------------------

  for (const run of cancelledRuns) {
    try {
      await enqueueCallback(
        { provider: 'internal', channel: null, threadId: null },
        {
          type:          'WORKFLOW_STEP',
          action:        'cancel',
          workflowRunId: run.workflowRunId,
          traceId,
        }
      );
    } catch (error) {
      // Non-fatal — run is already marked cancelled in DB. SQS failure just means
      // the Step Processor won't get the cancel signal, but status check covers it.
      console.warn('shutdown: SQS cancel enqueue failed for run', {
        runId: run.workflowRunId, error: error.message, traceId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4 — return result
  // ---------------------------------------------------------------------------

  console.info('shutdown: complete', {
    traceId,
    cancelledCount: cancelledRuns.length,
    attempted:      activeRuns.length,
  });

  const result = {
    success:        true,
    cancelledCount: cancelledRuns.length,
    cancelled:      cancelledRuns,
  };

  return ok(result, traceId);
}
