// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/ping-core.mjs
// PING_CORE SQS handler — launches the ping_core workflow for Slack UI integration testing.
//
// Entry point pattern: fetch workflow → insert WorkflowRun → enqueue WORKFLOW_STEP execute_top.
// Step Processor drives all subsequent execution from here.
//
// Triggered by: /ping core → ping.mjs (EXP) → SQS PING_CORE → proc/handler.mjs → this module.

import { getRows, insertRow }              from '../shared/serv-client.mjs';
import { enqueueWorkflow, enqueueCallback } from '../shared/sqs-callback.mjs';
import { ok, err }                          from '../shared/lambda-utils.mjs';

export async function handle(req) {
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;

  // Fetch ping_core workflow definition
  const wfResult = await getRows('PGC_Workflow', [
    { column: 'name', op: 'eq', value: 'ping_core' },
  ]);

  if (!wfResult?.rows?.length) {
    console.error('ping-core: ping_core workflow not seeded in PGC_Workflow', { traceId });
    if (callback) {
      await enqueueCallback(callback, {
        type:  'HUMAN_NOTIFICATION',
        traceId,
        text:  'ping core failed — workflow ping_core not found.\nRun: node dev_scripts/upsert-workflow.mjs ping_core',
      });
    }
    return err(404, 'ping_core workflow not seeded', traceId);
  }

  const workflow = wfResult.rows[0];

  // Create WorkflowRun — stack starts empty; execute_top initialises it from workflow.steps
  const runResult = await insertRow('PGC_WorkflowRun', {
    workflow_id:        workflow.id,
    trace_id:           traceId,
    triggered_by:       'slack',
    status:             'pending',
    input:              { userInput: '/ping core' },
    stack:              [],
    state:              {},
    callback,
    total_execution_ms: 0,
    step_count:         0,
  });

  if (!runResult?.success) {
    console.error('ping-core: WorkflowRun insert failed', { traceId, error: runResult?.error });
    return err(500, 'WorkflowRun creation failed', traceId);
  }
  const workflowRunId = runResult.row.id;

  // Enqueue first step — Step Processor drives the rest
  await enqueueWorkflow({
    type:           'WORKFLOW_STEP',
    action:         'execute_top',
    workflowRunId,
    traceId,
    callback,
  });

  console.info('ping-core: workflow started', { workflowRunId, traceId });
  return ok({ success: true, workflowRunId }, traceId);
}
