// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/help.mjs
// Handles the HELP workflow entry point.
//
// Creates a PGC_WorkflowRun row for the 'help' workflow and enqueues
// WORKFLOW_STEP / execute_top to the WorkflowQueue. The Step Processor
// (run-workflow.mjs) then drives all steps declaratively — human_gate,
// notify, end — with no special-case code here.
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.
// All SQS writes go through sqs-callback.mjs.

import { ok, err }                          from '../shared/lambda-utils.mjs';
import { enqueueWorkflow }                  from '../shared/sqs-callback.mjs';
import { getRows, insertRow }               from '../shared/serv-client.mjs';

export async function handle(req) {
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;

  console.info('proc/help: received', { traceId });

  // Resolve help workflow_id
  const wfResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: 'help' }],
    undefined, 1
  );
  if (!wfResp.success || wfResp.count === 0) {
    const msg = 'help workflow not found in PGC_Workflow';
    console.error('proc/help:', msg);
    if (req.source === 'http') return err(500, msg, req.correlationId);
    throw new Error(msg);
  }
  const workflowId = wfResp.rows[0].id;

  // Insert PGC_WorkflowRun row
  const runResp = await insertRow('PGC_WorkflowRun', {
    workflow_id:  workflowId,
    trace_id:     traceId,
    triggered_by: req.source === 'sqs' ? 'slack' : 'api',
    status:       'running',
    input:        {},
    callback:     callback ?? null,
    started_at:   new Date().toISOString(),
  });
  if (!runResp.success) {
    const msg = `Failed to insert PGC_WorkflowRun: ${runResp.error}`;
    console.error('proc/help:', msg);
    if (req.source === 'http') return err(500, msg, req.correlationId);
    throw new Error(msg);
  }
  const workflowRunId = runResp.row.id;

  console.info('proc/help: WorkflowRun created', { workflowRunId, traceId });

  // Enqueue execute_top — Step Processor drives the rest
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
