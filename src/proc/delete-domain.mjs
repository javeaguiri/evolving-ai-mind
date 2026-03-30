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

import { ok, err }         from '../shared/lambda-utils.mjs';
import { enqueueCallback } from '../shared/sqs-callback.mjs';
import { getRows }         from '../shared/serv-client.mjs';

const SERV_URL = process.env.SERV_API_URL;

export async function handle(req) {
  const { domain } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId  = req.traceId ?? req.correlationId;

  if (!domain?.trim()) {
    if (req.source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:   'DELETE_DOMAIN_ERROR',
        traceId,
        result: { success: false, error: 'domain is required' },
      });
      return;
    }
    return err(400, 'domain is required', req.correlationId);
  }

  try {
    const result = await runDeleteDomain({ domain: domain.trim(), traceId });

    if (req.source === 'http') return ok(result, req.correlationId);

    if (callback) {
      await enqueueCallback(callback, { type: 'DELETE_DOMAIN_RESULT', traceId, result });
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
    const resp = await servPost('/api/v1/serv/schema/deleteTable', { tableName }, traceId);
    if (!resp.success) {
      console.warn('delete-domain: deleteTable failed (continuing)', { tableName, error: resp.error, traceId });
    } else {
      deletedTables.push(tableName);
      console.info('delete-domain: table deleted', { tableName, traceId });
    }
  }

  // --- Step 3: Remove PGC_EntitySchema rows for this domain ---
  // Matches on root_table — any entity whose root table was one of this domain's tables.
  // PGC_TableMap.allow_delete must be true for PGC_EntitySchema (set in seed).
  let deletedEntityCount = 0;
  if (tableNames.length > 0) {
    const entityResp = await servPost('/api/v1/serv/table/deleteRows', {
      tableName: 'PGC_EntitySchema',
      filters:   [{ column: 'root_table', op: 'in', value: tableNames }],
    }, traceId);

    if (!entityResp.success) {
      console.warn('delete-domain: PGC_EntitySchema delete failed', { domain, error: entityResp.error, traceId });
    } else {
      deletedEntityCount = entityResp.deletedCount ?? 0;
      console.info('delete-domain: PGC_EntitySchema rows removed', { domain, deletedEntityCount, traceId });
    }
  }

  // --- Step 4 preamble: resolve workflow ids for this domain ---
  // Needed to filter PGC_WorkflowRun and PGC_WorkflowRunStep by workflow before
  // deleting the workflow rows themselves.
  let workflowIds = [];
  const workflowIdResp = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Workflow',
    filters:   [{ column: 'domain', op: 'eq', value: domain }],
  }, traceId);

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
    const runIdResp = await servPost('/api/v1/serv/table/getRows', {
      tableName: 'PGC_WorkflowRun',
      filters:   [{ column: 'workflow_id', op: 'in', value: workflowIds }],
    }, traceId);

    const runIds = (runIdResp.success && runIdResp.count > 0)
      ? runIdResp.rows.map(r => r.id)
      : [];

    if (runIds.length > 0) {
      const runStepResp = await servPost('/api/v1/serv/table/deleteRows', {
        tableName: 'PGC_WorkflowRunStep',
        filters:   [{ column: 'run_id', op: 'in', value: runIds }],
      }, traceId);

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
    const runResp = await servPost('/api/v1/serv/table/deleteRows', {
      tableName: 'PGC_WorkflowRun',
      filters:   [{ column: 'workflow_id', op: 'in', value: workflowIds }],
    }, traceId);

    if (!runResp.success) {
      console.warn('delete-domain: PGC_WorkflowRun delete failed', { domain, error: runResp.error, traceId });
    } else {
      deletedRunCount = runResp.deletedCount ?? 0;
      console.info('delete-domain: PGC_WorkflowRun rows removed', { domain, deletedRunCount, traceId });
    }
  }

  // --- Step 4: Remove PGC_Workflow rows for this domain ---
  // These are the 4 CRUD workflows generated by create_domain.
  // Must be deleted before PGC_IntentMap (FK constraint: workflow_id → PGC_Workflow.id).
  // PGC_TableMap.allow_delete must be true for PGC_Workflow (set in seed).
  let deletedWorkflowCount = 0;
  const workflowResp = await servPost('/api/v1/serv/table/deleteRows', {
    tableName: 'PGC_Workflow',
    filters:   [{ column: 'domain', op: 'eq', value: domain }],
  }, traceId);

  if (!workflowResp.success) {
    console.warn('delete-domain: PGC_Workflow delete failed', { domain, error: workflowResp.error, traceId });
  } else {
    deletedWorkflowCount = workflowResp.deletedCount ?? 0;
    console.info('delete-domain: PGC_Workflow rows removed', { domain, deletedWorkflowCount, traceId });
  }

  // --- Step 5: Remove PGC_IntentMap rows for this domain ---
  // Matched by intent_category prefix — all CRUD intents for this domain follow
  // the pattern list_<domain>, add_<domain>, update_<domain>, delete_<domain>.
  // Using 'like' operator: intent_category LIKE '%_<domain>' catches all four patterns
  // regardless of verb prefix, without needing to enumerate them.
  // PGC_TableMap.allow_delete must be true for PGC_IntentMap (set in seed).
  let deletedIntentCount = 0;
  const intentResp = await servPost('/api/v1/serv/table/deleteRows', {
    tableName: 'PGC_IntentMap',
    filters:   [{ column: 'intent_category', op: 'like', value: `%_${domain}` }],
  }, traceId);

  if (!intentResp.success) {
    console.warn('delete-domain: PGC_IntentMap delete failed', { domain, error: intentResp.error, traceId });
  } else {
    deletedIntentCount = intentResp.deletedCount ?? 0;
    console.info('delete-domain: PGC_IntentMap rows removed', { domain, deletedIntentCount, traceId });
  }

  // --- Step 6: Remove PGC_DomainHelp row ---
  // PGC_TableMap.allow_delete must be true for PGC_DomainHelp (set in seed).
  const domainHelpResp = await servPost('/api/v1/serv/table/deleteRows', {
    tableName: 'PGC_DomainHelp',
    filters:   [{ column: 'domain', op: 'eq', value: domain }],
  }, traceId);

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

// ---------------------------------------------------------------------------
// SERV HTTP client (proc→serv rule, Section 3.5a)
// ---------------------------------------------------------------------------

async function servPost(path, body, traceId) {
  try {
    const resp = await fetch(`${SERV_URL}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-correlation-id': traceId },
      body:    JSON.stringify(body),
    });
    return await resp.json();
  } catch (error) {
    return { success: false, error: error.message };
  }
}
