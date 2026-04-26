// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/create-domain.mjs
// Handles POST /api/v1/proc/create-domain (HTTP) and
//         CREATE_DOMAIN SQS WorkflowQueue messages (async).
//
// Step Processor entry point for the create_domain workflow.
// Creates a PGC_WorkflowRun row and enqueues WORKFLOW_STEP / execute_top.
// All LLM, validation, human gate, DDL, and registration steps are driven
// declaratively by run-workflow.mjs from the PGC_Workflow.steps definition.
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.

import { ok, err }             from '../shared/lambda-utils.mjs';
import { enqueueWorkflow }     from '../shared/sqs-callback.mjs';
import { getRows, insertRow }  from '../shared/serv-client.mjs';

export async function handle(req) {
  const { userInput } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;

  if (!userInput?.trim()) {
    if (req.source === 'sqs' && callback) {
      const { enqueueCallback } = await import('../shared/sqs-callback.mjs');
      await enqueueCallback(callback, {
        type:    'HUMAN_NOTIFICATION',
        traceId,
        message: 'Usage: /create-domain <description>',
      });
      return;
    }
    return err(400, 'userInput is required', req.correlationId);
  }

  console.info('proc/create-domain: received', { traceId, userInput: userInput.trim() });

  // Resolve create_domain workflow id
  const wfResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: 'create_domain' }],
    undefined, 1
  );
  if (!wfResp.success || wfResp.count === 0) {
    const msg = 'create_domain workflow not found in PGC_Workflow';
    console.error('proc/create-domain:', msg);
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
    input:        { userInput: userInput.trim() },
    callback:     callback ?? null,
    started_at:   new Date().toISOString(),
  });
  if (!runResp.success) {
    const msg = `Failed to insert PGC_WorkflowRun: ${runResp.error}`;
    console.error('proc/create-domain:', msg);
    if (req.source === 'http') return err(500, msg, req.correlationId);
    throw new Error(msg);
  }
  const workflowRunId = runResp.row.id;

  console.info('proc/create-domain: WorkflowRun created', { workflowRunId, traceId });

  // Enqueue execute_top — Step Processor drives all remaining steps
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
