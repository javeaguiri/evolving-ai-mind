// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/serv-client.mjs
// Shared SERV HTTP client for all Lambda tiers that need DB access.
//
// Cross-tier: calls go to ServFunction via API Gateway (proc-to-serv rule).
// All methods attach statusCode to the parsed response body so callers
// can inspect it without a separate resp.status check.

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
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    process.env.INTERNAL_API_KEY ?? '',
    },
    body:    JSON.stringify(body),
  });
  const parsed      = await resp.json();
  parsed.statusCode = resp.status;
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
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    process.env.INTERNAL_API_KEY ?? '',
    },
  });
  const parsed      = await resp.json();
  parsed.statusCode = resp.status;
  return parsed;
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
 */
export async function getRows(tableName, filters = [], orderBy, limit, vectorSearch) {
  return servPost('/api/v1/serv/table/getRows', {
    tableName,
    ...(filters.length  && { filters }),
    ...(orderBy         && { orderBy }),
    ...(limit           && { limit }),
    ...(vectorSearch    && { vectorSearch }),
  });
}

/**
 * Insert a row into a PGC/PGD table via SERV-Table insertRow.
 */
export async function insertRow(tableName, row) {
  return servPost('/api/v1/serv/table/insertRow', { tableName, row });
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
 * @param {object}   orderBy      Optional { column, direction }
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
