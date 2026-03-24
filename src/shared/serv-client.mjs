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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
 */
export async function getRows(tableName, filters = [], orderBy, limit) {
  return servPost('/api/v1/serv/table/getRows', {
    tableName,
    ...(filters.length  && { filters }),
    ...(orderBy         && { orderBy }),
    ...(limit           && { limit }),
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
