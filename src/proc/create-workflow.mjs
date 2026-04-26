// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/create-workflow.mjs
// Handles POST /api/v1/proc/create-workflow (HTTP) and
//         CREATE_WORKFLOW SQS WorkflowQueue messages (async).
//
// Step Processor entry point for the create_workflow workflow.
// Creates a PGC_WorkflowRun row and enqueues WORKFLOW_STEP / execute_top.
// All LLM, validation, human gate, and registration steps are driven
// declaratively by run-workflow.mjs from the PGC_Workflow.steps definition.
//
// input.domain — resolved by classify-intent.mjs alias lookup for the
// CREATE_WORKFLOW heavy-lift dispatch path. Null when triggered via the
// direct /create-workflow Slack command (domain extracted by the
// analyze_and_design_workflow LLM prompt at step 7 instead).
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.

import { ok, err }            from '../shared/lambda-utils.mjs';
import { enqueueWorkflow }    from '../shared/sqs-callback.mjs';
import { getRows, insertRow } from '../shared/serv-client.mjs';
import { matchDomainAlias }   from './classify-intent-tiers.mjs';

export async function handle(req) {
  const { userInput, domain: incomingDomain = null } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;

  if (!userInput?.trim()) {
    if (req.source === 'sqs' && callback) {
      const { enqueueCallback } = await import('../shared/sqs-callback.mjs');
      await enqueueCallback(callback, {
        type:    'HUMAN_NOTIFICATION',
        traceId,
        message: 'Usage: /m create workflow <description>',
      });
      return;
    }
    return err(400, 'userInput is required', req.correlationId);
  }

  // --- Domain resolution ---
  // Attempt to resolve a domain from userInput via alias matching so that
  // step 1 (serv_query PGC_Schema filtered by domain) returns real schema rows.
  // Falls back gracefully — if no domain is found the workflow still runs with
  // domain_schema: [] and the LLM applies domain-free mode.
  let domain = incomingDomain ?? null;
  if (!domain) {
    try {
      const dhResp = await getRows('PGC_DomainHelp');
      if (dhResp.success && dhResp.rows?.length) {
        const hit = matchDomainAlias(userInput.trim(), dhResp.rows);
        if (hit) {
          domain = hit.domain;
          console.info('proc/create-workflow: domain resolved via alias', { domain, traceId });
        }
      }
    } catch (e) {
      console.warn('proc/create-workflow: domain resolution failed — continuing with null', { error: e.message, traceId });
    }
  }

  console.info('proc/create-workflow: received', {
    traceId,
    userInput: userInput.trim(),
    domain,
  });

  // Resolve create_workflow workflow id
  const wfResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: 'create_workflow' }],
    undefined, 1
  );
  if (!wfResp.success || wfResp.count === 0) {
    const msg = 'create_workflow workflow not found in PGC_Workflow — run: node dev_scripts/upsert-workflow.mjs create_workflow';
    console.error('proc/create-workflow:', msg);
    if (req.source === 'http') return err(500, msg, req.correlationId);
    if (callback) {
      const { enqueueCallback } = await import('../shared/sqs-callback.mjs');
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
      return;
    }
    throw new Error(msg);
  }
  const workflowId = wfResp.rows[0].id;

  // Insert PGC_WorkflowRun row.
  // domain flows into input so step 1 serv_query PGC_Schema can filter by domain
  // and step 7 analyze_and_design_workflow receives it as {{input.domain}}.
  const runResp = await insertRow('PGC_WorkflowRun', {
    workflow_id:  workflowId,
    trace_id:     traceId,
    triggered_by: req.source === 'sqs' ? 'slack' : 'api',
    status:       'running',
    input:        { userInput: userInput.trim(), domain },
    callback:     callback ?? null,
    started_at:   new Date().toISOString(),
  });
  if (!runResp.success) {
    const msg = `Failed to insert PGC_WorkflowRun: ${runResp.error}`;
    console.error('proc/create-workflow:', msg);
    if (req.source === 'http') return err(500, msg, req.correlationId);
    throw new Error(msg);
  }
  const workflowRunId = runResp.row.id;

  console.info('proc/create-workflow: WorkflowRun created', { workflowRunId, traceId, domain });

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
