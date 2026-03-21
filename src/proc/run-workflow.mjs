// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/run-workflow.mjs
// Handles POST /api/v1/proc/run-workflow (HTTP) and
//         WORKFLOW_STEP SQS WorkflowQueue messages (async).
//
// The central Step Processor entry point. Workflow-agnostic — dispatches
// based on PGC_Workflow.name to registered handlers today; Phase 2 item 5
// replaces per-workflow handlers with generic declarative step execution
// from PGC_Workflow.steps.
//
// Actions:
//   resume_gate  — Human gate responded to. Loads run, dispatches to the
//                  correct workflow handler based on workflow name.
//                  Idempotency guard: 409/silent-consume if run not awaiting_human_gate.
//   execute_top  — Execute step at top of execution stack. Phase 2 item 5 stub.
//   cancel       — Immediately cancel the run regardless of current state.
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.
// req.source determines response path only.

import { ok, err }                      from '../shared/lambda-utils.mjs';
import { enqueueCallback }              from '../shared/sqs-callback.mjs';
import { getRows, updateRows }          from '../shared/serv-client.mjs';
import { handleResumeGate as designDomainResumeGate } from './design-domain.mjs';

// Map workflow name → resume_gate handler.
// Phase 2 item 5 replaces these entries with generic Step Processor execution
// from PGC_Workflow.steps declarative definitions.
const RESUME_GATE_HANDLERS = {
  create_domain: designDomainResumeGate,
  // help: helpResumeGate,         — to be added when /help gate is wired
  // create_workflow: ...,          — Phase 3
};

export async function handle(req) {
  const { action, workflowRunId, userResponse, responseData } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId ?? req.correlationId;

  if (!action)        return err(400, 'action is required', req.correlationId);
  if (!workflowRunId) return err(400, 'workflowRunId is required', req.correlationId);

  switch (action) {
    case 'resume_gate':
      return resumeGate({ workflowRunId, userResponse, responseData, callback, traceId, req });

    case 'execute_top':
      // Phase 2 item 5 — Step Processor full implementation
      console.info('run-workflow: execute_top stub', { workflowRunId, traceId });
      if (req.source === 'http') return err(501, 'execute_top not yet implemented — Phase 2 item 5', req.correlationId);
      return; // SQS — consume silently

    case 'cancel':
      return cancelRun({ workflowRunId, callback, traceId, req });

    default:
      return err(400, `Unknown action "${action}"`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// resume_gate
// ---------------------------------------------------------------------------

async function resumeGate({ workflowRunId, userResponse, responseData, callback, traceId, req }) {
  if (!userResponse) return err(400, 'userResponse is required for resume_gate', req.correlationId);

  const runResp = await getRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: workflowRunId }], null, 1);
  if (!runResp.success || runResp.count === 0) {
    return err(404, `WorkflowRun ${workflowRunId} not found`, req.correlationId);
  }

  const run = runResp.rows[0];

  // Idempotency guard — SQS delivers at-least-once; stale button clicks also possible
  if (run.status !== 'awaiting_human_gate') {
    console.warn('run-workflow: resume_gate on non-awaiting run', {
      workflowRunId, status: run.status, traceId,
    });
    if (req.source === 'http') {
      return err(409, `Run ${workflowRunId} is not awaiting_human_gate (status: ${run.status})`, req.correlationId);
    }
    return; // SQS — silent consume
  }

  // Load the workflow to identify which handler to dispatch to
  const wfResp = await getRows('PGC_Workflow', [{ column: 'id', op: 'eq', value: run.workflow_id }], null, 1);
  if (!wfResp.success || wfResp.count === 0) {
    throw new Error(`PGC_Workflow row not found for id ${run.workflow_id}`);
  }

  const workflowName = wfResp.rows[0].name;
  const handler      = RESUME_GATE_HANDLERS[workflowName];

  if (!handler) {
    console.warn('run-workflow: no resume_gate handler for workflow', { workflowName, workflowRunId, traceId });
    if (req.source === 'http') return err(501, `No resume_gate handler registered for workflow "${workflowName}"`, req.correlationId);
    return;
  }

  console.info('run-workflow: dispatching resume_gate', { workflowName, workflowRunId, userResponse, traceId });
  return handler({ run, userResponse, responseData, callback, traceId, req });
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

async function cancelRun({ workflowRunId, callback, traceId, req }) {
  const updateResp = await updateRows(
    'PGC_WorkflowRun',
    [
      { column: 'id',     op: 'eq',  value: workflowRunId },
      { column: 'status', op: 'neq', value: 'cancelled'   },
    ],
    { status: 'cancelled' }
  );

  if (!updateResp.success) throw new Error(`Failed to cancel WorkflowRun ${workflowRunId}: ${updateResp.error}`);

  const cancelled = updateResp.updatedCount > 0;
  console.info('run-workflow: cancel', { workflowRunId, cancelled, traceId });

  const result = { success: true, action: 'cancel', workflowRunId, cancelled };

  if (req.source === 'http') return ok(result, req.correlationId);

  if (callback) {
    await enqueueCallback(callback, { type: 'WORKFLOW_CANCELLED', traceId, result });
  }
}
