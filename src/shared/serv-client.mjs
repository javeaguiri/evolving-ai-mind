// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/serv-client.mjs
// Shared SERV HTTP client for all Lambda tiers that need DB access.
//
// Cross-tier: calls go to ServFunction via API Gateway (proc-to-serv rule).
// All methods attach statusCode to the parsed response body so callers
// can inspect it without a separate resp.status check.

import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// The test sandbox (docs/arch-sandbox.md §3)
// ---------------------------------------------------------------------------
// A test run's SERV calls carry x-sandbox, and SERV points them at the sandbox. The context is
// set once — run-workflow.mjs opens a scope per message and names the run's sandbox when it
// loads the run — so step code, the LLM harness and the memory writer call SERV unchanged.

const sandboxContext = new AsyncLocalStorage();

/** Run fn in a fresh scope with no sandbox; setSandbox inside it names one for the rest of it. */
export function sandboxScope(fn) {
  return sandboxContext.run({ sandbox: null }, fn);
}

/** Name the sandbox for the rest of the current scope. Outside a scope it does nothing. */
export function setSandbox(sandbox) {
  const store = sandboxContext.getStore();
  if (store) store.sandbox = sandbox ?? null;
}

/** Run fn with every SERV call it makes pointed at `sandbox`. */
export function withSandbox(sandbox, fn) {
  return sandboxContext.run({ sandbox: sandbox ?? null }, fn);
}

/** The sandbox the current SERV calls go to, or null. */
export function currentSandbox() {
  return sandboxContext.getStore()?.sandbox ?? null;
}

function servHeaders() {
  const sandbox = currentSandbox();
  return {
    'Content-Type': 'application/json',
    'x-api-key':    process.env.INTERNAL_API_KEY ?? '',
    ...(sandbox ? { 'x-sandbox': sandbox } : {}),
  };
}

/**
 * POST to a SERV endpoint and return the parsed JSON body.
 * Attaches statusCode to the body so callers can check it inline.
 *
 * @param {string} path   SERV endpoint path e.g. '/api/v1/serv/table/getRows'
 * @param {object} body   Request body
 * @returns {Promise<object>}
 */
export async function servPost(path, body) {
  const url  = `${process.env.SERV_API_URL}${path}`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: servHeaders(),
    body:    JSON.stringify(body),
  });
  const parsed      = await resp.json();
  parsed.statusCode = resp.status;
  if (!resp.ok) throw new Error(parsed.error ?? `SERV HTTP ${resp.status}`);
  return parsed;
}

/**
 * GET a SERV endpoint and return the parsed JSON body.
 *
 * @param {string} path   SERV endpoint path
 * @returns {Promise<object>}
 */
export async function servGet(path) {
  const url  = `${process.env.SERV_API_URL}${path}`;
  const resp = await fetch(url, {
    method:  'GET',
    headers: servHeaders(),
  });
  const parsed      = await resp.json();
  parsed.statusCode = resp.status;
  return parsed;
}

/**
 * Run an async SERV call as best-effort: warn and return null on failure instead
 * of throwing. Use for cleanup operations (delete-domain, delete-workflow) where
 * a partial failure should be logged but not abort the rest of the sequence.
 *
 * @param {string}   label    console.warn label
 * @param {object}   ctx      extra fields appended to the warn log
 * @param {Function} fn       async function to call
 * @returns {Promise<any|null>}  fn's return value, or null on error
 */
export async function bestEffort(label, ctx, fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn(label, { ...ctx, error: e.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers for common SERV operations
// ---------------------------------------------------------------------------

/**
 * Fetch rows from a PGC/PGD table via SERV-Table getRows.
 * Pass vectorSearch to use pgvector cosine similarity ranking instead of
 * (or combined with) exact filters. SERV embeds queryText and ranks results.
 *
 * @param {object} [vectorSearch]  { column, queryText, threshold?, limit? }
 * @param {string|object|Array} [orderBy]  One sort term or several — "priority DESC",
 *   { column, direction }, or an array of either for a composite sort
 */
export async function getRows(tableName, filters = [], orderBy, limit, vectorSearch, columns) {
  return servPost('/api/v1/serv/table/getRows', {
    tableName,
    ...(filters.length  && { filters }),
    ...(orderBy         && { orderBy }),
    ...(limit           && { limit }),
    ...(vectorSearch    && { vectorSearch }),
    ...(columns?.length && { columns }),
  });
}

/**
 * Insert a row into a PGC/PGD table via SERV-Table insertRow.
 */
export async function insertRow(tableName, row) {
  return servPost('/api/v1/serv/table/insertRow', { tableName, row });
}

/**
 * Bulk-insert multiple rows into a PGC/PGD table in a single SQL statement.
 * All rows must have the same column set. Returns { rows: [...] } with all
 * inserted rows including generated IDs.
 */
export async function insertRows(tableName, rows) {
  return servPost('/api/v1/serv/table/insertRow', { tableName, rows });
}

/**
 * Update rows in a PGC/PGD table via SERV-Table updateRows.
 */
export async function updateRows(tableName, filters, updates) {
  return servPost('/api/v1/serv/table/updateRows', { tableName, filters, updates });
}

/**
 * Delete rows from a PGC/PGD table via SERV-Table deleteRows.
 * filters is required and must be non-empty — SERV rejects unfiltered deletes.
 */
export async function deleteRows(tableName, filters) {
  return servPost('/api/v1/serv/table/deleteRows', { tableName, filters });
}

/**
 * Insert or update each row in a PGC/PGD table depending on whether a row
 * matching matchColumns already exists, via SERV-Table upsertRows.
 * Workaround upsert — query-then-write, not a native ON CONFLICT (no table
 * currently declares a compound unique constraint on matchColumns).
 */
export async function upsertRows(tableName, matchColumns, rows) {
  return servPost('/api/v1/serv/table/upsertRows', { tableName, matchColumns, rows });
}

// ---------------------------------------------------------------------------
// SERV-Entity convenience wrappers
// ---------------------------------------------------------------------------

/**
 * List entities via SERV-Entity listEntities.
 * Returns assembled entities — root columns + jsonb_agg child arrays.
 * Response shape: { success, entityName, count, entities: [...] }
 *
 * @param {string}   entityName   PascalCase entity name e.g. 'Recipe'
 * @param {Array}    filters      Optional filter array — same shape as getRows filters
 * @param {string|object|Array} orderBy  Optional — one sort term or several; same
 *   forms as getRows
 * @param {number}   limit        Optional row cap (default 100, max 1000)
 */
export async function listEntities(entityName, filters = [], orderBy, limit) {
  return servPost('/api/v1/serv/entity/listEntities', {
    entityName,
    ...(filters.length && { filters }),
    ...(orderBy        && { orderBy }),
    ...(limit          && { limit }),
  });
}

/**
 * Fetch a single entity by id via SERV-Entity getEntity.
 * Returns the assembled entity with all configured joins and aggregations.
 * Response shape: { success, entityName, entity: {...} }
 *
 * @param {string}   entityName   PascalCase entity name e.g. 'Recipe'
 * @param {number}   id           Root table primary key
 */
export async function getEntityById(entityName, id) {
  return servPost('/api/v1/serv/entity/getEntity', { entityName, id });
}
