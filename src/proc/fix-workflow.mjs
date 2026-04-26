// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/fix-workflow.mjs
// Handles POST /api/v1/proc/fix-workflow (HTTP) and
//         FIX_WORKFLOW SQS WorkflowQueue messages (async).
//
// Step Processor entry point for the fix_workflow system workflow.
// Creates a PGC_WorkflowRun row and enqueues WORKFLOW_STEP / execute_top.
// All LLM, validation, human gate, DB writes, and run cancellation steps
// are driven declaratively by run-workflow.mjs from the fix_workflow
// PGC_Workflow definition.
//
// Input paths:
//   troubleshootResult — full TroubleshootWorkflowResponse (primary path)
//   workflowName + issues [+ brokenSteps + stackTrace] — direct path
//
// run.input shape passed to the Step Processor:
//   { workflowName, issues, brokenSteps, workflowVersion, stackTrace }
// All fields are available as {{input.*}} in workflow step templates.
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.

import { ok, err }            from '../shared/lambda-utils.mjs';
import { enqueueWorkflow }    from '../shared/sqs-callback.mjs';
import { getRows, insertRow } from '../shared/serv-client.mjs';

export async function handle(req) {
  const body     = req.body ?? {};
  const callback = req.callback ?? body.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;

  // ── Resolve inputs ────────────────────────────────────────────────────────
  let workflowName, issues, brokenSteps, workflowVersion, stackTrace;

  if (body.troubleshootResult) {
    const r  = body.troubleshootResult;
    if (r.passed) {
      const msg = `fix-workflow: "${r.workflowName}" has no issues — nothing to fix`;
      if (req.source === 'http') return err(400, msg, req.correlationId);
      if (callback) {
        const { enqueueCallback } = await import('../shared/sqs-callback.mjs');
        await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
      }
      return;
    }
    workflowName    = r.workflowName    ?? null;
    issues          = r.staticAnalysis?.issues ?? [];
    workflowVersion = r.workflowVersion ?? null;
    brokenSteps     = body.brokenSteps  ?? null;
    stackTrace      = body.stackTrace   ?? r.stackTrace ?? null;
  } else {
    workflowName    = body.workflowName    ?? null;
    issues          = body.issues          ?? [];
    workflowVersion = body.workflowVersion ?? null;
    brokenSteps     = body.brokenSteps     ?? null;
    stackTrace      = body.stackTrace      ?? null;
  }

  if (!workflowName) {
    const msg = 'fix-workflow: workflowName is required';
    if (req.source === 'http') return err(400, msg, req.correlationId);
    if (callback) {
      const { enqueueCallback } = await import('../shared/sqs-callback.mjs');
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
    }
    return;
  }
  if (!issues || issues.length === 0) {
    const msg = `fix-workflow: no issues supplied for "${workflowName}" — nothing to fix`;
    if (req.source === 'http') return err(400, msg, req.correlationId);
    if (callback) {
      const { enqueueCallback } = await import('../shared/sqs-callback.mjs');
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
    }
    return;
  }

  console.info('proc/fix-workflow: received', {
    traceId, workflowName, issueCount: issues.length,
  });

  // ── Resolve fix_workflow system workflow id ───────────────────────────────
  const wfResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: 'fix_workflow' }],
    undefined, 1
  );
  if (!wfResp.success || wfResp.count === 0) {
    const msg = 'fix_workflow workflow not found in PGC_Workflow — run: node dev_scripts/upsert-workflow.mjs fix_workflow';
    console.error('proc/fix-workflow:', msg);
    if (req.source === 'http') return err(500, msg, req.correlationId);
    if (callback) {
      const { enqueueCallback } = await import('../shared/sqs-callback.mjs');
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
      return;
    }
    throw new Error(msg);
  }
  const workflowId = wfResp.rows[0].id;

  // ── Insert PGC_WorkflowRun row ────────────────────────────────────────────
  const runResp = await insertRow('PGC_WorkflowRun', {
    workflow_id:  workflowId,
    trace_id:     traceId,
    triggered_by: req.source === 'sqs' ? 'slack' : 'api',
    status:       'running',
    input: {
      workflowName,
      issues,
      brokenSteps:     brokenSteps     ?? null,
      workflowVersion: workflowVersion ?? null,
      stackTrace:      stackTrace      ?? null,
    },
    callback:   callback ?? null,
    started_at: new Date().toISOString(),
  });
  if (!runResp.success) {
    const msg = `Failed to insert PGC_WorkflowRun: ${runResp.error}`;
    console.error('proc/fix-workflow:', msg);
    if (req.source === 'http') return err(500, msg, req.correlationId);
    throw new Error(msg);
  }
  const workflowRunId = runResp.row.id;

  console.info('proc/fix-workflow: WorkflowRun created', {
    workflowRunId, traceId, workflowName,
  });

  // ── Enqueue execute_top — Step Processor drives all remaining steps ────────
  await enqueueWorkflow({
    type:          'WORKFLOW_STEP',
    action:        'execute_top',
    workflowRunId,
    traceId,
  });

  if (req.source === 'http') {
    return ok({ workflowRunId, status: 'running' }, req.correlationId);
  }
}
