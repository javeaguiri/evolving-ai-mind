// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/delete-domain.mjs
// Handles POST /api/v1/proc/delete-domain (HTTP) and
//         DELETE_DOMAIN SQS WorkflowQueue messages (async).
//
// Permanently deletes a domain and all its registry entries:
//   1. PGD tables        — DROP TABLE CASCADE via serv/schema/deleteTable
//                          (also removes PGC_Schema + PGC_TableMap rows per table)
//   2. PGC_EntitySchema  — rows where root_table is one of the domain's tables
//   3. PGC_Workflow      — rows where domain = the deleted domain
//   4. PGC_IntentMap     — rows where intent_category matches domain CRUD patterns
//                          (deleted after PGC_Workflow — FK: workflow_id → PGC_Workflow.id)
//   5. PGC_DomainHelp    — single row for the domain
//
// Idempotent — if the domain is already absent, returns success with a warning.
// Requires PGC_TableMap.allow_delete = true for PGC_EntitySchema, PGC_DomainHelp,
// PGC_Workflow, and PGC_IntentMap. All set in seed_PGC_TableMap.json.
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.
// req.source determines response path only.

import { ok, err }                    from '../shared/lambda-utils.mjs';
import { enqueueCallback }            from '../shared/sqs-callback.mjs';
import { getRows, deleteRows, servPost } from '../shared/serv-client.mjs';

export async function handle(req) {
  const rawDomain = (req.body?.domain ?? '').trim();
  // Normalise user-supplied domain: "Spanish flashcards" → "spanish_flashcards"
  const domain   = rawDomain.toLowerCase().replace(/\s+/g, '_');
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId ?? req.correlationId;

  if (!domain) {
    if (req.source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:    'HUMAN_NOTIFICATION',
        traceId,
        message: 'Usage: /delete-domain <domain>',
      });
      return;
    }
    return err(400, 'domain is required', req.correlationId);
  }

  try {
    const result = await runDeleteDomain({ domain, traceId });

    if (req.source === 'http') return ok(result, req.correlationId);

    if (callback) {
      const message = result.warning
        ? `Domain \`${domain}\` not found — nothing was deleted.`
        : `Domain \`${domain}\` deleted.\n• Tables dropped: ${result.deletedTables.length > 0 ? result.deletedTables.join(', ') : 'none'}\n• Workflows removed: ${result.deletedWorkflowCount}\n• Intent patterns removed: ${result.deletedIntentCount}`;
      await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message });
    }

  } catch (error) {
    console.error('delete-domain: unhandled error', { error: error.message, domain, traceId });
    if (req.source === 'http') return err(500, `delete-domain failed: ${error.message}`, req.correlationId);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Core delete logic
// ---------------------------------------------------------------------------

async function runDeleteDomain({ domain, traceId }) {

  // --- Step 1: Find all PGD tables registered for this domain ---
  const schemaResp = await getRows(
    'PGC_Schema',
    [
      { column: 'domain', op: 'eq', value: domain },
      { column: 'target', op: 'eq', value: 'pgd'  },
    ],
    null,
    100
  );

  if (!schemaResp.success) {
    throw new Error(`Failed to query PGC_Schema for domain "${domain}": ${schemaResp.error}`);
  }

  const tables        = schemaResp.rows ?? [];
  const tableNames    = tables.map(r => r.table_name);
  const deletedTables = [];

  console.info('delete-domain: found tables', { domain, count: tables.length, traceId });

  // --- Step 2: Drop each PGD table ---
  // serv/schema/deleteTable handles: DROP TABLE CASCADE + PGC_Schema row + PGC_TableMap row
  for (const tableName of tableNames) {
    const resp = await servPost('/api/v1/serv/schema/deleteTable', { tableName });
    if (!resp.success) {
      console.warn('delete-domain: deleteTable failed (continuing)', { tableName, error: resp.error, traceId });
    } else {
      deletedTables.push(tableName);
      console.info('delete-domain: table deleted', { tableName, traceId });
    }
  }

  // --- Step 3: Remove PGC_EntitySchema rows for this domain ---
  // Matches on domain column (Option C) — correct regardless of whether PGD tables
  // still exist. The old root_table IN filter was unreliable when tableNames was empty.
  // PGC_TableMap.allow_delete must be true for PGC_EntitySchema (set in seed).
  let deletedEntityCount = 0;
  const entityResp = await deleteRows('PGC_EntitySchema', [{ column: 'domain', op: 'eq', value: domain }]);

  if (!entityResp.success) {
    console.warn('delete-domain: PGC_EntitySchema delete failed', { domain, error: entityResp.error, traceId });
  } else {
    deletedEntityCount = entityResp.deletedCount ?? 0;
    console.info('delete-domain: PGC_EntitySchema rows removed', { domain, deletedEntityCount, traceId });
  }

  // --- Step 4 preamble: resolve workflow ids for this domain ---
  // Needed to filter PGC_WorkflowRun and PGC_WorkflowRunStep by workflow before
  // deleting the workflow rows themselves.
  let workflowIds = [];
  const workflowIdResp = await getRows('PGC_Workflow', [{ column: 'domain', op: 'eq', value: domain }]);

  if (workflowIdResp.success && workflowIdResp.count > 0) {
    workflowIds = workflowIdResp.rows.map(r => r.id);
    console.info('delete-domain: found workflow ids', { domain, workflowIds, traceId });
  }

  // --- Step 4a: Remove PGC_WorkflowRunStep rows for this domain's runs ---
  // Must precede WorkflowRun deletion. SERV deleteRows does not support subqueries,
  // so we first fetch the run ids for these workflows, then delete step rows by run_id.
  // PGC_TableMap.allow_delete must be true for PGC_WorkflowRunStep.
  let deletedRunStepCount = 0;
  if (workflowIds.length > 0) {
    const runIdResp = await getRows('PGC_WorkflowRun', [{ column: 'workflow_id', op: 'in', value: workflowIds }]);

    const runIds = (runIdResp.success && runIdResp.count > 0)
      ? runIdResp.rows.map(r => r.id)
      : [];

    if (runIds.length > 0) {
      const runStepResp = await deleteRows('PGC_WorkflowRunStep', [{ column: 'run_id', op: 'in', value: runIds }]);

      if (!runStepResp.success) {
        console.warn('delete-domain: PGC_WorkflowRunStep delete failed', { domain, error: runStepResp.error, traceId });
      } else {
        deletedRunStepCount = runStepResp.deletedCount ?? 0;
        console.info('delete-domain: PGC_WorkflowRunStep rows removed', { domain, deletedRunStepCount, traceId });
      }
    }
  }

  // --- Step 4b: Remove PGC_WorkflowRun rows for this domain's workflows ---
  // Must precede PGC_Workflow deletion — PGC_WorkflowRun.workflow_id FK references
  // PGC_Workflow.id with no ON DELETE CASCADE, so Postgres rejects the workflow delete
  // if run rows exist.
  // PGC_TableMap.allow_delete must be true for PGC_WorkflowRun.
  let deletedRunCount = 0;
  if (workflowIds.length > 0) {
    const runResp = await deleteRows('PGC_WorkflowRun', [{ column: 'workflow_id', op: 'in', value: workflowIds }]);

    if (!runResp.success) {
      console.warn('delete-domain: PGC_WorkflowRun delete failed', { domain, error: runResp.error, traceId });
    } else {
      deletedRunCount = runResp.deletedCount ?? 0;
      console.info('delete-domain: PGC_WorkflowRun rows removed', { domain, deletedRunCount, traceId });
    }
  }

  // --- Step 4: Remove PGC_Workflow rows for this domain ---
  // Catches any domain-specific workflows registered against this domain.
  // Generic *_entity workflows (domain: null) are never deleted here — they serve all domains.
  // Must be deleted before PGC_IntentMap (FK constraint: workflow_id → PGC_Workflow.id).
  // PGC_TableMap.allow_delete must be true for PGC_Workflow (set in seed).
  let deletedWorkflowCount = 0;
  const workflowResp = await deleteRows('PGC_Workflow', [{ column: 'domain', op: 'eq', value: domain }]);

  if (!workflowResp.success) {
    console.warn('delete-domain: PGC_Workflow delete failed', { domain, error: workflowResp.error, traceId });
  } else {
    deletedWorkflowCount = workflowResp.deletedCount ?? 0;
    console.info('delete-domain: PGC_Workflow rows removed', { domain, deletedWorkflowCount, traceId });
  }

  // --- Step 5: Remove PGC_IntentMap rows for this domain ---
  // Since Session 17, create_domain writes rows with generic intent_category values
  // (add_entity, list_entity, etc.) — not domain-specific. The domain name lives in
  // the pattern column (e.g. "add.spanish_flashcards|add spanish_flashcards|...").
  // Matching on pattern LIKE '%<domain>%' correctly targets all five rows.
  // PGC_TableMap.allow_delete must be true for PGC_IntentMap (set in seed).
  let deletedIntentCount = 0;
  const intentResp = await deleteRows('PGC_IntentMap', [{ column: 'pattern', op: 'like', value: `%${domain}%` }]);

  if (!intentResp.success) {
    console.warn('delete-domain: PGC_IntentMap delete failed', { domain, error: intentResp.error, traceId });
  } else {
    deletedIntentCount = intentResp.deletedCount ?? 0;
    console.info('delete-domain: PGC_IntentMap rows removed', { domain, deletedIntentCount, traceId });
  }

  // --- Step 6: Remove PGC_DomainHelp row ---
  // PGC_TableMap.allow_delete must be true for PGC_DomainHelp (set in seed).
  const domainHelpResp = await deleteRows('PGC_DomainHelp', [{ column: 'domain', op: 'eq', value: domain }]);

  let domainHelpRemoved = false;
  if (!domainHelpResp.success) {
    console.warn('delete-domain: PGC_DomainHelp delete failed', { domain, error: domainHelpResp.error, traceId });
  } else {
    domainHelpRemoved = (domainHelpResp.deletedCount ?? 0) > 0;
    console.info('delete-domain: PGC_DomainHelp row', { domain, removed: domainHelpRemoved, traceId });
  }

  // --- Build result ---
  const nothingFound = tables.length === 0
    && deletedEntityCount === 0
    && deletedRunStepCount === 0
    && deletedRunCount === 0
    && deletedWorkflowCount === 0
    && deletedIntentCount === 0
    && !domainHelpRemoved;

  const result = {
    success:               true,
    domain,
    deletedTables,         // PGD tables dropped (PGC_Schema + PGC_TableMap rows also removed)
    deletedEntityCount,    // PGC_EntitySchema rows removed
    deletedRunStepCount,   // PGC_WorkflowRunStep rows removed
    deletedRunCount,       // PGC_WorkflowRun rows removed
    deletedWorkflowCount,  // PGC_Workflow rows removed
    deletedIntentCount,    // PGC_IntentMap rows removed
    domainHelpRemoved,     // PGC_DomainHelp row removed
  };

  if (nothingFound) {
    result.warning = `No tables or registry entries found for domain "${domain}"`;
    console.info('delete-domain: domain already absent', { domain, traceId });
  } else {
    console.info('delete-domain: complete', {
      domain, deletedTables, deletedEntityCount,
      deletedRunStepCount, deletedRunCount,
      deletedWorkflowCount, deletedIntentCount, domainHelpRemoved,
      traceId,
    });
  }

  return result;
}

