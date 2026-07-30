// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/troubleshoot-workflow.mjs
// Handles POST /api/v1/proc/troubleshoot-workflow (HTTP) and
//         TROUBLESHOOT_WORKFLOW SQS WorkflowQueue messages (async).
//
// Tier 1 reactive repair — Level 1 static analysis on a registered or
// supplied workflow step array. No WorkflowRun lifecycle — fire-and-forget.
//
// Input modes:
//   workflowName only        — load live steps from PGC_Workflow
//   workflowName + steps     — analyse supplied steps; name used for identification
//   steps only               — analyse raw step array with no DB lookup
//
// When autoFix=true (SQS path only) and issues are found, enqueues FIX_WORKFLOW.
// Always posts a TroubleshootWorkflowResponse summary to the callback channel.
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { ok, err }              from '../shared/lambda-utils.mjs';
import { enqueueWorkflow, enqueueCallback } from '../shared/sqs-callback.mjs';
import { getRows }              from '../shared/serv-client.mjs';
import { runSimulation }        from './simulation-engine.mjs';
import { loadStepTypeContracts } from './step-type-registry.mjs';

export async function handle(req) {
  const body         = req.body ?? {};
  const workflowName = body.workflowName ?? null;
  const suppliedSteps = body.steps ?? null;
  const autoFix      = body.autoFix === true;
  const stackTrace   = body.stackTrace ?? null;
  const callback     = req.callback ?? body.callback ?? null;
  const traceId      = req.traceId  ?? req.correlationId;

  if (!workflowName && !suppliedSteps) {
    const msg = 'troubleshoot-workflow: workflowName or steps is required';
    if (req.source === 'http') return err(400, msg, req.correlationId);
    if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
    return;
  }

  console.info('proc/troubleshoot-workflow: start', { traceId, workflowName, autoFix });

  // ── Load steps ────────────────────────────────────────────────────────────
  let steps         = suppliedSteps;
  let workflowVersion = null;

  if (!steps) {
    const wfResp = await getRows(
      'PGC_Workflow',
      [{ column: 'name', op: 'eq', value: workflowName }],
      undefined, 1
    );
    if (!wfResp.success || wfResp.count === 0) {
      const msg = `troubleshoot-workflow: workflow "${workflowName}" not found in PGC_Workflow`;
      console.error('proc/troubleshoot-workflow:', msg);
      if (req.source === 'http') return err(404, msg, req.correlationId);
      if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
      return;
    }
    steps           = wfResp.rows[0].steps ?? [];
    workflowVersion = wfResp.rows[0].version ?? null;
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    const msg = 'troubleshoot-workflow: step array is empty';
    if (req.source === 'http') return err(400, msg, req.correlationId);
    if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: msg });
    return;
  }

  // ── Run Level 0 + Level 1 static analysis ─────────────────────────────────
  // runSimulation with no simulationPaths stops after Level 1.
  const simResult = runSimulation({
    steps,
    mockOutputs:       null,
    simulationPaths:   null,
    stepTypeContracts: await loadStepTypeContracts(traceId),
    traceId,
  });
  // A Level 0 failure short-circuits before Level 1 runs, leaving static_analysis
  // null — reading only that field would report a shape failure as a clean pass.
  const issues = [
    ...(simResult.shape_analysis?.issues  ?? []),
    ...(simResult.static_analysis?.issues ?? []),
  ];
  const passed = issues.length === 0 && simResult.static_analysis !== null;

  // ── Build human-readable Slack summary ───────────────────────────────────
  const label = workflowName
    ? `*${workflowName}*${workflowVersion != null ? ` v${workflowVersion}` : ''}`
    : 'supplied step array';

  let summary;
  if (passed) {
    summary = `✅ ${label} — no structural issues found`;
  } else {
    const bulletLines = issues.slice(0, 10).map(
      i => `• Step ${i.step} [${i.failure_class}]: ${i.detail}${i.suggestion ? ` — ${i.suggestion}` : ''}`
    );
    if (issues.length > 10) bulletLines.push(`• …and ${issues.length - 10} more`);
    summary = `❌ ${label} — ${issues.length} issue${issues.length !== 1 ? 's' : ''} found\n\n${bulletLines.join('\n')}`;
  }

  const result = {
    workflowName,
    workflowVersion,
    passed,
    issueCount:     issues.length,
    staticAnalysis: simResult.static_analysis,
    summary,
    stackTrace:     stackTrace ?? undefined,
    traceId,
  };

  console.info('proc/troubleshoot-workflow: complete', {
    traceId, workflowName, passed, issueCount: issues.length,
  });

  // ── HTTP path — return directly ───────────────────────────────────────────
  if (req.source === 'http') {
    return ok(result, req.correlationId);
  }

  // ── SQS path — post summary to Slack ─────────────────────────────────────
  if (callback) {
    await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: summary });
  }

  // ── autoFix — chain to FIX_WORKFLOW if issues found ───────────────────────
  if (autoFix && !passed && workflowName) {
    console.info('proc/troubleshoot-workflow: autoFix=true — enqueueing FIX_WORKFLOW', {
      traceId, workflowName, issueCount: issues.length,
    });
    await enqueueWorkflow({
      type:               'FIX_WORKFLOW',
      troubleshootResult: result,
      stackTrace,
      traceId,
      callback,
    });
  }
}
