// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/diagnose-prompt-schema.mjs
// Handles POST /api/v1/proc/diagnose-prompt-schema (HTTP) and
//         DIAGNOSE_PROMPT_SCHEMA SQS WorkflowQueue messages (async).
//
// Tier 1b reactive repair — triggered when an llm_call step receives
// Agent API error 400, indicating PGC_Prompt.output_schema contains
// constructs incompatible with the structured output spec.
//
// This module is a thin launcher — it loads the PGC_Prompt row, packages
// the raw output_schema into run.input as repair_state, then creates a
// PGC_WorkflowRun for the diagnose_prompt_schema system workflow.
//
// All repair logic (R1–R6 compatibility rules) lives as js_transform steps
// in the diagnose_prompt_schema PGC_Workflow definition. Rules are
// independently evolvable without code deploys.
//
// run.input shape passed to the Step Processor:
//   intentCategory    — PGC_Prompt.intent_category
//   promptId          — PGC_Prompt.id
//   promptVersion     — current version (for display in notify message)
//   promptVersionNext — version + 1 (written to PGC_Prompt on repair)
//   failedRunId       — PGC_WorkflowRun.id that triggered this (nullable)
//   repair_state      — { schema: <raw output_schema>, violations: [] }
//                       Initial state for the R1–R6 js_transform rule steps
//
// HTTP path: returns the raw schema for inspection (no run created).
// SQS path:  creates PGC_WorkflowRun and enqueues execute_top.
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { ok, err }                          from '../shared/lambda-utils.mjs';
import { enqueueWorkflow, enqueueCallback } from '../shared/sqs-callback.mjs';
import { getRows, insertRow }               from '../shared/serv-client.mjs';

export async function handle(req) {
  const body           = req.body ?? {};
  const intentCategory = body.intentCategory ?? null;
  const workflowRunId  = body.workflowRunId  ?? null;
  const callback       = req.callback ?? body.callback ?? null;
  const traceId        = req.traceId  ?? req.correlationId;

  if (!intentCategory) {
    const msg = 'diagnose-prompt-schema: intentCategory is required';
    if (req.source === 'http') return err(400, msg, req.correlationId);
    if (callback) await enqueueCallback(callback, { type: 'WORKFLOW_NOTIFY', traceId, message: msg });
    return;
  }

  console.info('proc/diagnose-prompt-schema: start', { traceId, intentCategory, workflowRunId });

  // ── Load PGC_Prompt row ───────────────────────────────────────────────────
  const promptResp = await getRows(
    'PGC_Prompt',
    [{ column: 'intent_category', op: 'eq', value: intentCategory }],
    { column: 'version', direction: 'desc' },
    1
  );
  if (!promptResp.success || promptResp.count === 0) {
    const msg = `diagnose-prompt-schema: prompt "${intentCategory}" not found in PGC_Prompt`;
    console.error('proc/diagnose-prompt-schema:', msg);
    if (req.source === 'http') return err(404, msg, req.correlationId);
    if (callback) await enqueueCallback(callback, { type: 'WORKFLOW_NOTIFY', traceId, message: msg });
    return;
  }
  const promptRow = promptResp.rows[0];

  if (!promptRow.output_schema) {
    const msg = `diagnose-prompt-schema: prompt "${intentCategory}" has no output_schema — cannot diagnose`;
    if (req.source === 'http') return err(400, msg, req.correlationId);
    if (callback) await enqueueCallback(callback, { type: 'WORKFLOW_NOTIFY', traceId, message: msg });
    return;
  }

  // ── HTTP path — return raw schema for inspection (no run created) ─────────
  if (req.source === 'http') {
    return ok({
      intentCategory,
      promptId:      promptRow.id,
      promptVersion: promptRow.version,
      output_schema: promptRow.output_schema,
      action:        'inspection_only',
    }, req.correlationId);
  }

  // ── SQS path — resolve diagnose_prompt_schema system workflow ────────────
  const wfResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: 'diagnose_prompt_schema' }],
    undefined, 1
  );
  if (!wfResp.success || wfResp.count === 0) {
    const msg = 'diagnose_prompt_schema workflow not found — run: node dev_scripts/upsert-workflow.mjs diagnose_prompt_schema';
    console.error('proc/diagnose-prompt-schema:', msg);
    if (callback) await enqueueCallback(callback, { type: 'WORKFLOW_NOTIFY', traceId, message: msg });
    return;
  }
  const workflowId = wfResp.rows[0].id;

  // ── Insert PGC_WorkflowRun ────────────────────────────────────────────────
  // repair_state is the initial input to the R1–R6 js_transform rule chain.
  // Each rule step reads repair_state via input_key and writes back via output_key.
  const runResp = await insertRow('PGC_WorkflowRun', {
    workflow_id:  workflowId,
    trace_id:     traceId,
    triggered_by: 'system',
    status:       'running',
    input: {
      intentCategory,
      promptId:          promptRow.id,
      promptVersion:     promptRow.version,
      promptVersionNext: (promptRow.version ?? 0) + 1,
      failedRunId:       workflowRunId ?? null,
      repair_state: {
        schema:     promptRow.output_schema,
        violations: [],
      },
    },
    callback:   callback ?? null,
    started_at: new Date().toISOString(),
  });
  if (!runResp.success) {
    const msg = `diagnose-prompt-schema: failed to create WorkflowRun: ${runResp.error}`;
    console.error('proc/diagnose-prompt-schema:', msg);
    if (callback) await enqueueCallback(callback, { type: 'WORKFLOW_NOTIFY', traceId, message: msg });
    return;
  }
  const diagRunId = runResp.row.id;

  console.info('proc/diagnose-prompt-schema: WorkflowRun created', {
    diagRunId, traceId, intentCategory,
  });

  await enqueueWorkflow({
    type:          'WORKFLOW_STEP',
    action:        'execute_top',
    workflowRunId: diagRunId,
    traceId,
  });
}
