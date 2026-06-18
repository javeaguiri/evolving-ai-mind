// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/delete-workflow.mjs
// Handles POST /api/v1/proc/delete-workflow (HTTP) and
//         DELETE_WORKFLOW SQS WorkflowQueue messages (async).
//
// Permanently deletes a single named workflow and all its associated artifacts:
//   1. Fetch PGC_Workflow.id by name — 404 if not found
//   2. Fetch all PGC_WorkflowRun.id for that workflow_id
//   3. Delete PGC_WorkflowRunStep rows where run_id IN (run ids)
//   4. Delete PGC_WorkflowRun rows where workflow_id = id
//   5. Delete PGC_IntentMap rows where workflow_id = id (FK — exact match)
//   6. Delete PGC_Workflow row
//
// Not idempotent — returns 404 (HTTP) or error callback (SQS) if name unknown.
// Transport-agnostic — no AWS SDK, no Slack SDK imports.

import { ok, err }         from '../shared/lambda-utils.mjs';
import { enqueueCallback } from '../shared/sqs-callback.mjs';
import { getRows, deleteRows, bestEffort } from '../shared/serv-client.mjs';

export async function handle(req) {
  const { name } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId ?? req.correlationId;

  if (!name?.trim()) {
    if (req.source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:    'HUMAN_NOTIFICATION',
        traceId,
        message: 'Usage: /delete-workflow <name>',
      });
      return;
    }
    return err(400, 'name is required', req.correlationId);
  }

  // Normalise to snake_case — workflow names are always snake_case identifiers.
  // "flashcard quiz" → "flashcard_quiz". Resolves common user input variations.
  const normalised = name.trim().toLowerCase().replace(/\s+/g, '_');

  try {
    const result = await runDeleteWorkflow({ name: normalised, traceId });

    if (result.notFound) {
      if (req.source === 'sqs' && callback) {
        await enqueueCallback(callback, {
          type:    'HUMAN_NOTIFICATION',
          traceId,
          message: `Workflow \`${name.trim()}\` not found — nothing was deleted.`,
        });
        return;
      }
      return err(404, result.error, req.correlationId);
    }

    if (req.source === 'http') return ok(result, req.correlationId);

    if (callback) {
      const message = `Workflow \`${result.name}\` deleted.\n• Run history removed: ${result.deletedRunCount} run(s), ${result.deletedRunStepCount} step(s)\n• Intent patterns removed: ${result.deletedIntentCount}`;
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message });
    }

  } catch (error) {
    console.error('delete-workflow: unhandled error', { error: error.message, name, traceId });
    if (req.source === 'http') return err(500, `delete-workflow failed: ${error.message}`, req.correlationId);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Core delete logic
// ---------------------------------------------------------------------------

async function runDeleteWorkflow({ name, traceId }) {

  // --- Step 1: Fetch workflow id by name ---
  const workflowResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: name }],
    null,
    1
  );

  if (!workflowResp.success) {
    throw new Error(`Failed to query PGC_Workflow for name "${name}": ${workflowResp.error}`);
  }

  if (!workflowResp.rows?.length) {
    // Fallback: partial match — catches minor spelling variations
    const likeResp = await getRows(
      'PGC_Workflow',
      [{ column: 'name', op: 'like', value: `%${name}%` }],
      null, 1
    );
    if (!likeResp.success || !likeResp.rows?.length) {
      return { notFound: true, error: `Workflow "${name}" not found` };
    }
    console.info('delete-workflow: resolved via partial match', {
      searched: name, resolved: likeResp.rows[0].name, traceId,
    });
    return runDeleteWorkflow({ name: likeResp.rows[0].name, traceId });
  }

  const workflowId = workflowResp.rows[0].id;
  console.info('delete-workflow: found workflow', { name, workflowId, traceId });

  // --- Step 2: Fetch run ids for this workflow ---
  const runResp = await getRows(
    'PGC_WorkflowRun',
    [{ column: 'workflow_id', op: 'eq', value: workflowId }],
    null,
    10000
  );

  const runIds = (runResp.success && runResp.rows?.length)
    ? runResp.rows.map(r => r.id)
    : [];

  console.info('delete-workflow: found runs', { name, runCount: runIds.length, traceId });

  // --- Step 3: Delete PGC_WorkflowRunStep rows ---
  let deletedRunStepCount = 0;
  if (runIds.length > 0) {
    const runStepResp = await bestEffort('delete-workflow: PGC_WorkflowRunStep delete failed', { name, traceId },
      () => deleteRows('PGC_WorkflowRunStep', [{ column: 'run_id', op: 'in', value: runIds }]));
    deletedRunStepCount = runStepResp?.deletedCount ?? 0;
    if (runStepResp) console.info('delete-workflow: PGC_WorkflowRunStep rows removed', { name, deletedRunStepCount, traceId });
  }

  // --- Step 4: Delete PGC_WorkflowRun rows ---
  let deletedRunCount = 0;
  const runDeleteResp = await deleteRows(
    'PGC_WorkflowRun',
    [{ column: 'workflow_id', op: 'eq', value: workflowId }]
  );
  if (!runDeleteResp.success) {
    console.warn('delete-workflow: PGC_WorkflowRun delete failed', { name, error: runDeleteResp.error, traceId });
  } else {
    deletedRunCount = runDeleteResp.deletedCount ?? 0;
    console.info('delete-workflow: PGC_WorkflowRun rows removed', { name, deletedRunCount, traceId });
  }

  // --- Step 5: Delete PGC_IntentMap rows (FK match — exact workflow_id) ---
  let deletedIntentCount = 0;
  const intentResp = await deleteRows(
    'PGC_IntentMap',
    [{ column: 'workflow_id', op: 'eq', value: workflowId }]
  );
  if (!intentResp.success) {
    console.warn('delete-workflow: PGC_IntentMap delete failed', { name, error: intentResp.error, traceId });
  } else {
    deletedIntentCount = intentResp.deletedCount ?? 0;
    console.info('delete-workflow: PGC_IntentMap rows removed', { name, deletedIntentCount, traceId });
  }

  // --- Step 6: Delete PGC_Workflow row ---
  const wfDeleteResp = await deleteRows(
    'PGC_Workflow',
    [{ column: 'id', op: 'eq', value: workflowId }]
  );
  if (!wfDeleteResp.success) {
    throw new Error(`Failed to delete PGC_Workflow row for "${name}": ${wfDeleteResp.error}`);
  }

  console.info('delete-workflow: complete', {
    name, workflowId, deletedRunStepCount, deletedRunCount, deletedIntentCount, traceId,
  });

  return {
    success:             true,
    name,
    workflowId,
    deletedRunStepCount,
    deletedRunCount,
    deletedIntentCount,
    workflowDeleted:     true,
  };
}
