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
//   3. PGC_DomainHelp    — single row for the domain
//
// Idempotent — if the domain is already absent, returns success with a warning.
// Requires PGC_TableMap.allow_delete = true for PGC_EntitySchema and PGC_DomainHelp.
// Both are set in seed_PGC_TableMap.json — apply via init-brain bootstrap.
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

  // --- Step 4: Remove PGC_DomainHelp row ---
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
  const nothingFound = tables.length === 0 && !domainHelpRemoved && deletedEntityCount === 0;

  const result = {
    success:              true,
    domain,
    deletedTables,        // PGD tables dropped (PGC_Schema + PGC_TableMap rows also removed)
    deletedEntityCount,   // PGC_EntitySchema rows removed
    domainHelpRemoved,    // PGC_DomainHelp row removed
  };

  if (nothingFound) {
    result.warning = `No tables or registry entries found for domain "${domain}"`;
    console.info('delete-domain: domain already absent', { domain, traceId });
  } else {
    console.info('delete-domain: complete', { domain, deletedTables, deletedEntityCount, domainHelpRemoved, traceId });
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
