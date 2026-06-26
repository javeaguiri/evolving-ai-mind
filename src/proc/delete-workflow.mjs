// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/delete-workflow.mjs
// Handles POST /api/v1/proc/delete-workflow (HTTP) and
//         DELETE_WORKFLOW SQS WorkflowQueue messages (async).
//
// Permanently deletes a single named workflow and all its associated artifacts:
//   1. Resolve name: exact snake_case → LIKE → Pass 1 IntentMap → Pass 2 domain/keyword scan
//   2. Fetch PGC_Workflow.id by resolved name — 404 if not found
//   3. Fetch all PGC_WorkflowRun.id for that workflow_id
//   4. Delete PGC_WorkflowRunStep rows where run_id IN (run ids)
//   5. Delete PGC_WorkflowRun rows where workflow_id = id
//   6. Delete PGC_IntentMap rows where workflow_id = id (FK — exact match)
//   7. Delete PGC_Workflow row
//
// Not idempotent — returns 404 (HTTP) or error callback (SQS) if name unknown.
// Transport-agnostic — no AWS SDK, no Slack SDK imports.

import { ok, err }         from '../shared/lambda-utils.mjs';
import { enqueueCallback } from '../shared/sqs-callback.mjs';
import { getRows, deleteRows, bestEffort } from '../shared/serv-client.mjs';
import { matchIntentMap, matchDomainAlias, matchWorkflowByKeywords } from './classify-intent-tiers.mjs';

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

  try {
    const resolved = await resolveWorkflowName(name.trim(), traceId);

    if (!resolved) {
      if (req.source === 'sqs' && callback) {
        await enqueueCallback(callback, {
          type:    'HUMAN_NOTIFICATION',
          traceId,
          message: `Workflow matching \`${name.trim()}\` not found — nothing was deleted.`,
        });
        return;
      }
      return err(404, `Workflow "${name.trim()}" not found`, req.correlationId);
    }

    const result = await runDeleteWorkflow({ name: resolved, traceId });

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
      const promptNote = result.deletedPromptCount > 0 ? `\n• Domain prompts removed: ${result.deletedPromptCount}` : '';
      const message = `Workflow \`${result.name}\` deleted.\n• Run history removed: ${result.deletedRunCount} run(s), ${result.deletedRunStepCount} step(s)\n• Intent patterns removed: ${result.deletedIntentCount}${promptNote}`;
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message });
    }

  } catch (error) {
    console.error('delete-workflow: unhandled error', { error: error.message, name, traceId });
    if (req.source === 'http') return err(500, `delete-workflow failed: ${error.message}`, req.correlationId);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Workflow name resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied name or phrase to a canonical PGC_Workflow.name.
 * Resolution order:
 *   1. Exact snake_case match
 *   2. Partial LIKE match
 *   3. Pass 1 — PGC_IntentMap regex (same as classify-intent)
 *   4. Pass 2 — domain alias → workflow keyword scan (same as classify-intent)
 * Returns the canonical name string, or null if nothing matched.
 */
async function resolveWorkflowName(rawInput, traceId) {
  const normalised = rawInput.toLowerCase().replace(/\s+/g, '_');

  const exactResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: normalised }], null, 1);
  if (exactResp.rows?.length) {
    console.info('delete-workflow: resolved via exact match', { normalised, traceId });
    return exactResp.rows[0].name;
  }

  const likeResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'like', value: `%${normalised}%` }], null, 1);
  if (likeResp.rows?.length) {
    console.info('delete-workflow: resolved via partial match', { normalised, resolved: likeResp.rows[0].name, traceId });
    return likeResp.rows[0].name;
  }

  const [intentMapResp, domainHelpResp, workflowResp] = await Promise.all([
    getRows('PGC_IntentMap'),
    getRows('PGC_DomainHelp'),
    getRows('PGC_Workflow'),
  ]);
  const intentRows   = intentMapResp.rows  ?? [];
  const domainRows   = domainHelpResp.rows ?? [];
  const workflowRows = workflowResp.rows   ?? [];

  // Pass 1: PGC_IntentMap regex — catches creation phrases stored by create_workflow step 35b
  const intentMatch = matchIntentMap(rawInput, intentRows);
  if (intentMatch?.action_type === 'workflow') {
    console.info('delete-workflow: resolved via Pass 1 intent map', { intent_category: intentMatch.intent_category, traceId });
    return intentMatch.intent_category;
  }

  // Pass 2: domain alias → keyword scan
  const domainMatch = matchDomainAlias(rawInput, domainRows);
  if (domainMatch) {
    const aliases = [domainMatch._matched_alias, ...(domainMatch.aliases ?? [])].filter(Boolean);
    const kwMatch = matchWorkflowByKeywords(rawInput, domainMatch.domain, workflowRows, aliases);
    if (kwMatch?.workflow_name) {
      console.info('delete-workflow: resolved via Pass 2 keyword match', { workflow_name: kwMatch.workflow_name, domain: domainMatch.domain, traceId });
      return kwMatch.workflow_name;
    }
  }

  return null;
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
    return { notFound: true, error: `Workflow "${name}" not found` };
  }

  const workflowId     = workflowResp.rows[0].id;
  const workflowDomain = workflowResp.rows[0].domain ?? null;
  console.info('delete-workflow: found workflow', { name, workflowId, workflowDomain, traceId });

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

  // --- Step 5a: Delete PGC_Prompt rows for this workflow's domain ---
  // Only runs when the workflow has a domain — system workflows (domain: null) share
  // prompts across all workflows and must not have their prompts wiped here.
  let deletedPromptCount = 0;
  if (workflowDomain) {
    const promptResp = await bestEffort('delete-workflow: PGC_Prompt delete failed', { name, workflowDomain, traceId },
      () => deleteRows('PGC_Prompt', [{ column: 'domain', op: 'eq', value: workflowDomain }]));
    deletedPromptCount = promptResp?.deletedCount ?? 0;
    if (promptResp) console.info('delete-workflow: PGC_Prompt rows removed', { name, workflowDomain, deletedPromptCount, traceId });
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
    name, workflowId, workflowDomain, deletedRunStepCount, deletedRunCount,
    deletedIntentCount, deletedPromptCount, traceId,
  });

  return {
    success:             true,
    name,
    workflowId,
    deletedRunStepCount,
    deletedRunCount,
    deletedIntentCount,
    deletedPromptCount,
    workflowDeleted:     true,
  };
}
