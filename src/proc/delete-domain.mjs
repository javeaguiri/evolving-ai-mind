// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/delete-domain.mjs
// Handles POST /api/v1/proc/delete-domain (HTTP) and
//         DELETE_DOMAIN SQS WorkflowQueue messages (async).
//
// Permanently deletes a domain — drops all PGD tables and removes all
// PGC registry entries (PGC_Schema, PGC_TableMap, PGC_DomainHelp).
//
// Intended primarily for development and testing cleanup.
// Idempotent — if the domain is already absent, returns success with a warning.
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.
// req.source determines response path only.

import { ok, err }         from '../shared/lambda-utils.mjs';
import { enqueueCallback } from '../shared/sqs-callback.mjs';
import { getRows }         from '../shared/serv-client.mjs';

// SERV base URL — deleteTable and DomainHelp removal go through SERV HTTP endpoints
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
      { column: 'domain', op: 'eq',  value: domain },
      { column: 'target', op: 'eq',  value: 'pgd'  },
    ],
    null,
    100  // reasonable upper bound — no domain should have 100+ tables
  );

  if (!schemaResp.success) {
    throw new Error(`Failed to query PGC_Schema for domain "${domain}": ${schemaResp.error}`);
  }

  const tables       = schemaResp.rows ?? [];
  const deletedTables = [];

  console.info('delete-domain: found tables', { domain, count: tables.length, traceId });

  // --- Step 2: Drop each PGD table via SERV deleteTable ---
  // deleteTable handles: DROP TABLE CASCADE, DELETE FROM PGC_TableMap, DELETE FROM PGC_Schema
  for (const tableRow of tables) {
    const tableName = tableRow.table_name;
    const resp      = await servDeleteTable(tableName, traceId);

    if (!resp.success) {
      // Log but continue — partial cleanup is better than full abort.
      // The table may have already been dropped manually.
      console.warn('delete-domain: deleteTable failed (continuing)', { tableName, error: resp.error, traceId });
    } else {
      deletedTables.push(tableName);
      console.info('delete-domain: table deleted', { tableName, traceId });
    }
  }

  // --- Step 3: Remove PGC_DomainHelp row ---
  const domainHelpRemoved = await servDeleteDomainHelp(domain, traceId);

  const result = {
    success:            true,
    domain,
    deletedTables,
    domainHelpRemoved,
  };

  if (tables.length === 0 && !domainHelpRemoved) {
    result.warning = `No tables or registry entries found for domain "${domain}"`;
    console.info('delete-domain: domain already absent', { domain, traceId });
  } else {
    console.info('delete-domain: complete', { domain, deletedTables, domainHelpRemoved, traceId });
  }

  return result;
}

// ---------------------------------------------------------------------------
// SERV calls — HTTP fetch to ServFunction (proc→serv rule, Section 3.5a)
// ---------------------------------------------------------------------------

async function servDeleteTable(tableName, traceId) {
  try {
    const resp = await fetch(`${SERV_URL}/api/v1/serv/schema/deleteTable`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-correlation-id': traceId },
      body:    JSON.stringify({ tableName }),
    });
    return await resp.json();
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function servDeleteDomainHelp(domain, traceId) {
  // PGC_DomainHelp has allow_delete: false in the default seed — use direct SERV call.
  // We need a raw deleteRows call here since the standard gating would block this.
  // The domain name is the natural key (UNIQUE constraint on domain column).
  try {
    const resp = await fetch(`${SERV_URL}/api/v1/serv/table/deleteRows`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-correlation-id': traceId },
      body:    JSON.stringify({
        tableName: 'PGC_DomainHelp',
        filters:   [{ column: 'domain', op: 'eq', value: domain }],
      }),
    });
    const result = await resp.json();
    if (!result.success) {
      console.warn('delete-domain: DomainHelp delete failed', { domain, error: result.error, traceId });
      return false;
    }
    const removed = result.deletedCount > 0;
    console.info('delete-domain: DomainHelp row', { domain, removed, traceId });
    return removed;
  } catch (error) {
    console.warn('delete-domain: DomainHelp delete error (non-fatal)', { domain, error: error.message, traceId });
    return false;
  }
}
