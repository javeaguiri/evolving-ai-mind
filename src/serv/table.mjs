// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/table.mjs
// Handles /api/v1/serv/table/* routes.
//
// SERV-Table is the DML executor — SELECT, INSERT, UPDATE, DELETE validated via PGC_TableMap.
// All operations are gated: table must be registered in PGC_TableMap and the
// relevant permission flag must be true before any SQL is executed.
//
// Routes:
//   POST /serv/table/getRows    — parameterised SELECT with filters, orderBy, limit, offset
//   POST /serv/table/insertRow  — single INSERT, gated by allow_insert
//   POST /serv/table/updateRows — parameterised UPDATE, gated by allow_update
//   POST /serv/table/deleteRows — parameterised DELETE, gated by allow_delete
//   POST /serv/table/upsertRows — per-row INSERT or UPDATE by matchColumns, gated by allow_insert + allow_update
//   POST /serv/table/saveRows   — a table's changed, new and removed rows in one transaction, each
//                                 checked against the version it was read at; optionally logged
//   POST /serv/table/runSql     — read-only SELECT/WITH statement, not PGC_TableMap-gated
//
// Security gates:
//   - Table must exist in PGC_TableMap
//   - Column names in filters/updates validated against PGC_Schema columns for that table
//   - Filter operators validated against whitelist
//   - filters must be non-empty on UPDATE and DELETE — mass unfiltered writes are not permitted
//   - No raw SQL accepted in any field, except runSql — a deliberate, narrow carve-out
//     (SELECT/WITH-only, keyword-denylisted, same guard as createView's selectSql) for
//     ad hoc read-only validation queries — never write-capable

import { randomUUID } from 'node:crypto';
import { ok, err, respond } from '../shared/lambda-utils.mjs';
import { getClient }  from './init-brain.mjs';
import { embedText }  from '../shared/embed-client.mjs';
import { validateReadOnlySql } from './schema.mjs';
import { normalizeOrderBy, buildOrderClause, resolveReadLimit, resolveReadOffset } from './query-utils.mjs';

// ---------------------------------------------------------------------------
// Allowed filter operators — security gate.
// ---------------------------------------------------------------------------
const ALLOWED_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'is_null', 'not_null', 'jsonb_contains', 'jsonb_contained_by',
]);

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('../shared/lambda-utils.mjs').parseEvent>} req
 */
export async function handle(req) {
  switch (req.subRoute) {
    case 'getRows':   return getRows(req);
    case 'insertRow': return insertRow(req);
    case 'updateRows': return updateRows(req);
    case 'deleteRows': return deleteRows(req);
    case 'upsertRows': return upsertRows(req);
    case 'saveRows':   return saveRows(req);
    case 'runSql':     return runSql(req);
    default:
      return err(404, `SERV-Table route "${req.subRoute}" not found`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// POST /serv/table/runSql
// ---------------------------------------------------------------------------

async function runSql(req) {
  const { selectSql, target = 'pgd' } = req.body;

  const sqlError = validateReadOnlySql(selectSql);
  if (sqlError) return err(400, sqlError, req.correlationId);
  if (!['pgc', 'pgd'].includes(target)) {
    return err(400, `target must be "pgc" or "pgd", got "${target}"`, req.correlationId);
  }

  const dbUrl = target === 'pgd' ? process.env.PGD_DATABASE_URL : process.env.PGC_DATABASE_URL;
  const client = getClient(dbUrl);

  try {
    await client.connect();
    const result = await client.query(selectSql);
    return ok({
      success: true,
      count:   result.rows.length,
      rows:    result.rows,
      correlationId: req.correlationId,
    }, req.correlationId);
  } catch (error) {
    console.error('table runSql error:', error.message);
    return err(500, `runSql failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/table/getRows
// ---------------------------------------------------------------------------

async function getRows(req) {
  const {
    tableName,
    filters      = [],
    orderBy,
    vectorSearch = null,
    columns      = null,
    withVersion  = false,
  } = req.body;

  // The bound this read applies, and whether the caller chose it or inherited it. A
  // caller that asked for 10 rows and got 10 is reading exactly what it requested; a
  // caller that asked for nothing and got the default is reading a cut of unknown size.
  // Only the second is a silent bound, and only PROC can tell the two apart — so the
  // distinction travels with the response rather than being re-derived downstream.
  const { limit: effectiveLimit, chosenBy: limitApplied } = resolveReadLimit(req.body);
  // A later page of the same read: the rows before it are skipped.
  const offset = resolveReadOffset(req.body.offset);

  if (!tableName) {
    return err(400, 'tableName is required', req.correlationId);
  }
  if (offset === null) {
    return err(400, 'offset must be a whole number of rows, 0 or more', req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  // Closed in finally, never after the query: a failed query or an early return would
  // otherwise leave the connection open for the life of the Lambda container.
  let   pgdClient = null;

  try {
    await pgcClient.connect();

    // --- Gate: table must be registered in PGC_TableMap ---
    const gate = await pgcClient.query(
      `SELECT tm.id, s.target, s.columns
         FROM "PGC_TableMap" tm
         JOIN "PGC_Schema"   s  ON s.id = tm.schema_id
        WHERE tm.table_name = $1`,
      [tableName]
    );
    if (gate.rows.length === 0) {
      return err(404, `Table "${tableName}" not registered in PGC_TableMap`, req.correlationId);
    }

    const { target, columns: schemaColumns } = gate.rows[0];
    const validColumns = new Set(schemaColumns.map(c => c.name));

    // --- Validate regular filter column names ---
    const filterError = validateFilters(filters, validColumns);
    if (filterError) return err(400, filterError, req.correlationId);

    // --- Normalize and validate orderBy ---
    // Object, string, or array — one term or several. Every column is validated,
    // because each one is interpolated into the ORDER BY clause.
    const orderTerms = normalizeOrderBy(orderBy);
    const badTerm    = orderTerms.find(t => !validColumns.has(t.column));
    if (badTerm) {
      return err(400, `orderBy column "${badTerm.column}" not found in schema`, req.correlationId);
    }

    // --- Validate vectorSearch if present ---
    if (vectorSearch) {
      if (!vectorSearch.column || !vectorSearch.queryText) {
        return err(400, 'vectorSearch requires column and queryText', req.correlationId);
      }
      // queryText is embedded as plain text. A non-string reaches embedText as
      // `text.trim is not a function`, which names neither the field nor the caller.
      if (typeof vectorSearch.queryText !== 'string') {
        return err(400, `vectorSearch.queryText must be a string, got ${typeof vectorSearch.queryText}`, req.correlationId);
      }
      const vsCol = schemaColumns.find(c => c.name === vectorSearch.column);
      if (!vsCol) {
        return err(400, `vectorSearch column "${vectorSearch.column}" not found in schema`, req.correlationId);
      }
      if (!vsCol.type?.startsWith('vector')) {
        return err(400, `vectorSearch column "${vectorSearch.column}" must be type vector`, req.correlationId);
      }
    }

    // --- Column projection ---
    // Built once, above the branch: both the vector and the standard path
    // project through it, and both validate against the same schema.
    let selectList = '*';
    if (columns?.length) {
      const invalid = columns.find(c => !validColumns.has(c));
      if (invalid) return err(400, `Column "${invalid}" not found in schema for "${tableName}"`, req.correlationId);
      selectList = columns.map(c => `"${c}"`).join(', ');
    }

    // --- Each row's version, for a later saveRows or saveEntity ---
    // As text, to the microsecond: a version passed through a JS Date keeps milliseconds only.
    if (withVersion) {
      if (!validColumns.has('updated_at')) {
        return err(400, `withVersion needs an updated_at column — "${tableName}" has none`, req.correlationId);
      }
      selectList += `, "updated_at"::text AS "_version"`;
    }

    if (target === 'pgd') pgdClient = getClient(process.env.PGD_DATABASE_URL);
    const dbClient = pgdClient ?? pgcClient;

    if (target === 'pgd') await dbClient.connect();

    let result;
    // Every row the read could have returned is described by one WHERE clause and its
    // values. Each branch records its own, so the boundary count below asks the same
    // question the read did — including the similarity threshold on the vector path.
    let matchWhere;
    let matchValues;

    if (vectorSearch) {
      // --- pgvector cosine similarity search ---
      // Embed the query text in SERV — caller supplies plain text only.
      const queryVec      = await embedText(vectorSearch.queryText, req.correlationId);
      const threshold     = vectorSearch.threshold ?? 0.75;
      const vsCol         = `"${vectorSearch.column}"`;

      // Regular filters fill $1..$n; vector is $n+1; threshold is $n+2.
      const { whereClause: regularWhere, values: filterVals } = buildWhereClause(filters);
      const vecIdx = filterVals.length + 1;
      const thrIdx = filterVals.length + 2;

      const vectorCondition = `(1 - (${vsCol} <=> $${vecIdx}::vector)) >= $${thrIdx}`;
      const combinedWhere   = filterVals.length > 0
        ? `${regularWhere} AND ${vectorCondition}`
        : `WHERE ${vectorCondition}`;

      const sql = `
        SELECT ${selectList}, 1 - (${vsCol} <=> $${vecIdx}::vector) AS similarity
        FROM "${tableName}"
        ${combinedWhere}
        ORDER BY ${vsCol} <=> $${vecIdx}::vector
        LIMIT ${effectiveLimit} OFFSET ${offset}
      `;

      matchWhere  = combinedWhere;
      matchValues = [...filterVals, JSON.stringify(queryVec), threshold];
      result = await dbClient.query(sql, matchValues);

    } else {
      // --- Standard parameterised SELECT ---
      const { whereClause, values } = buildWhereClause(filters);

      const orderClause = buildOrderClause(orderTerms);

      const sql = `
        SELECT ${selectList} FROM "${tableName}"
        ${whereClause}
        ${orderClause}
        LIMIT ${effectiveLimit} OFFSET ${offset}
      `;

      matchWhere  = whereClause;
      matchValues = values;
      result = await dbClient.query(sql, values);
    }

    // A read that filled its limit exactly may have left rows behind — or may have
    // matched exactly that many. Only a count can say which, so a full read is counted
    // and `truncated` means rows really were withheld; asserting it on the boundary alone
    // failed every read whose table held exactly the limit. Saying so — and saying how
    // many — is what separates a bounded view from a silently truncated one: nothing
    // downstream can otherwise tell a complete answer from a cut one. The COUNT runs only
    // on that boundary, never on an ordinary read, and it must run while the connection
    // is still open. A later page is cut when rows remain past it: past the offset and its own.
    let totalMatching;
    if (result.rows.length === effectiveLimit) {
      const countResult = await dbClient.query(
        `SELECT COUNT(*)::int AS total FROM "${tableName}" ${matchWhere}`, matchValues
      );
      totalMatching = countResult.rows[0].total;
    }
    const truncated = totalMatching > offset + result.rows.length;


    const rows = truncateVectorColumns(result.rows, schemaColumns);

    return ok({
      success:       true,
      tableName,
      count:         rows.length,
      limit:         effectiveLimit,
      limit_applied: limitApplied,
      ...(offset ? { offset } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(totalMatching !== undefined ? { total_matching: totalMatching } : {}),
      rows,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('table getRows error:', error.message);
    return err(500, `getRows failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient?.end();
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// normalizeEmbedText — clean a single field value for embedding
// ---------------------------------------------------------------------------

/**
 * Convert a row field value to a normalised text fragment for embedding.
 * Underscores are replaced with spaces so snake_case identifiers (domain names,
 * alias keys) are tokenised correctly by the embedding model.
 *
 * @param {*} v  Raw field value from row
 * @returns {string}
 */
function normalizeEmbedText(v) {
  if (v === null || v === undefined) return '';
  let text;
  if (Array.isArray(v)) {
    text = v.map(item => String(item ?? '')).join(' ');
  } else if (typeof v === 'object') {
    // jsonb objects not caught by Array.isArray — unlikely in embed_source
    // but handled defensively by extracting string values only.
    text = Object.values(v).filter(x => typeof x === 'string').join(' ');
  } else {
    text = String(v);
  }
  return text.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// resolveEmbedding — build focused embed text from array source fields only
// ---------------------------------------------------------------------------

/**
 * Build a single normalised text string from array-type embed_source fields
 * (e.g. aliases) and embed it as one unit via embedText().
 *
 * Only array fields are used. Scalar fields (domain name, description) are
 * excluded because:
 *   - domain is already represented in the aliases
 *   - description is generic system text ("Manage your data") that pulls the
 *     centroid away from the user-vocabulary terms in the aliases
 *
 * If no array fields are found, falls back to all fields concatenated.
 * This keeps the document tightly focused on what users would type.
 *
 * @param {{ name: string, embed_source: string[] }} vectorCol
 * @param {object} row  Complete row data (merged current + updates for updateRows)
 * @param {string} traceId
 * @returns {Promise<number[]>}
 */
async function resolveEmbedding(vectorCol, row, traceId) {
  // Prefer array fields (aliases) — they are the user-vocabulary source of truth.
  const arrayTexts = [];
  const scalarTexts = [];

  for (const key of vectorCol.embed_source) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      arrayTexts.push(normalizeEmbedText(v));
    } else {
      scalarTexts.push(normalizeEmbedText(v));
    }
  }

  const parts = arrayTexts.length > 0 ? arrayTexts : scalarTexts;
  const text  = parts.join(' ').replace(/\s+/g, ' ').trim();

  if (!text) return null;
  return embedText(text, traceId);
}

/**
 * Return vector columns that have embed_source defined in their schema definition.
 * These are automatically populated by SERV on insert/update.
 *
 * @param {object[]} schemaColumns  Columns array from PGC_Schema
 * @returns {object[]}
 */
function getEmbedColumns(schemaColumns) {
  return schemaColumns.filter(
    c => c.type?.startsWith('vector') && Array.isArray(c.embed_source) && c.embed_source.length > 0
  );
}

/**
 * Index of the first row whose column set differs from row 0's, or -1 when they all match.
 *
 * A batch insert builds one VALUES tuple per row from the FIRST row's column list, and
 * validates only that row's names against the schema. So a row carrying a different key set
 * is not something Postgres can reject: a column row 0 lacks is silently dropped, and one
 * row 0 has that this row does not is written as null. The insert succeeds and the data is
 * wrong — which is why this is a rejection rather than a repair.
 *
 * Pure — exported for test.
 *
 * @param {object[]} rows  non-empty array of row objects
 * @returns {number} index of the first mismatched row, or -1
 */
export function findColumnSetMismatch(rows) {
  const first = Object.keys(rows[0]).sort().join(',');
  for (let i = 1; i < rows.length; i++) {
    if (Object.keys(rows[i]).sort().join(',') !== first) return i;
  }
  return -1;
}

/**
 * Truncate vector columns to 5 chars + '...' — enough to confirm populated vs null without
 * returning the full vector payload. Applied to every row SERV-Table returns, reads and writes
 * alike: a write echoing its row back with a 2,560-number embedding cost Novia ~9,000
 * characters per `update_data` call (session 1293).
 *
 * @param {Array} rows           Rows as pg returned them
 * @param {Array} schemaColumns  PGC_Schema.columns for the table
 * @returns {Array}
 */
export function truncateVectorColumns(rows, schemaColumns) {
  const vectorCols = new Set((schemaColumns ?? []).filter(c => c.type?.startsWith('vector')).map(c => c.name));
  if (vectorCols.size === 0) return rows;
  return rows.map(row => {
    const clean = { ...row };
    for (const col of vectorCols) {
      // Only truncate what the projection actually returned. Assigning
      // unconditionally puts a column the caller excluded back into the row
      // as null, which undoes part of the projection it just asked for.
      if (!(col in clean)) continue;
      const v = clean[col];
      clean[col] = v == null ? null : String(v).slice(0, 5) + '...';
    }
    return clean;
  });
}

// ---------------------------------------------------------------------------
// POST /serv/table/insertRow
// ---------------------------------------------------------------------------

async function insertRow(req) {
  const { tableName, row, rows } = req.body;

  // Accept either a single row object or an array of rows for bulk insert.
  // Bulk path: all rows must have the same column set (derived from the first row).
  const isBatch = Array.isArray(rows);

  if (!tableName) return err(400, 'tableName is required', req.correlationId);

  if (isBatch) {
    // An empty batch is a valid no-op (e.g. "insert whichever of these rows
    // are missing" resolving to zero rows) — not an error, and not a single-row
    // insert. Must be checked before rows[0]-dependent validation below.
    if (rows.length === 0) {
      return ok({ success: true, tableName, rows: [], correlationId: req.correlationId }, req.correlationId);
    }
    if (rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
      return err(400, 'rows must be an array of non-null objects', req.correlationId);
    }
    if (Object.keys(rows[0]).length === 0) {
      return err(400, 'rows must have at least one field', req.correlationId);
    }
    const mismatch = findColumnSetMismatch(rows);
    if (mismatch !== -1) {
      return err(
        400,
        `rows[${mismatch}] has a different column set than rows[0] — every row in a batch insert must carry the same columns`,
        req.correlationId
      );
    }
  } else {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return err(400, 'row must be a non-null object', req.correlationId);
    }
    if (Object.keys(row).length === 0) {
      return err(400, 'row must have at least one field', req.correlationId);
    }
  }

  const rowsToInsert = isBatch ? rows : [row];

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  let   pgdClient = null;

  try {
    await pgcClient.connect();

    // --- Gate: table must be registered and allow_insert = true ---
    const gate = await pgcClient.query(
      `SELECT tm.allow_insert, s.target, s.columns
         FROM "PGC_TableMap" tm
         JOIN "PGC_Schema"   s  ON s.id = tm.schema_id
        WHERE tm.table_name = $1`,
      [tableName]
    );
    if (gate.rows.length === 0) {
      return err(404, `Table "${tableName}" not registered in PGC_TableMap`, req.correlationId);
    }

    const { allow_insert, target, columns: schemaColumns } = gate.rows[0];
    if (!allow_insert) {
      return err(403, `INSERT not permitted on "${tableName}"`, req.correlationId);
    }

    // --- Validate column names against PGC_Schema (use first row as template) ---
    const validColumns = new Set(schemaColumns.map(c => c.name));
    for (const col of Object.keys(rowsToInsert[0])) {
      if (!validColumns.has(col)) {
        return err(400, `Column "${col}" not found in schema for "${tableName}"`, req.correlationId);
      }
    }

    // --- Compute embeddings and build effective rows ---
    const colTypeMap = Object.fromEntries(schemaColumns.map(c => [c.name, c.type]));
    const embedCols  = getEmbedColumns(schemaColumns);
    const effectiveRows = [];

    for (const rawRow of rowsToInsert) {
      const effectiveRow = { ...rawRow };
      for (const vc of embedCols) {
        try {
          const vec = await resolveEmbedding(vc, effectiveRow, req.correlationId);
          if (vec !== null) effectiveRow[vc.name] = vec;
        } catch (embErr) {
          console.error(`table insertRow: embedding failed for ${vc.name}`, { tableName, error: embErr.message });
          return err(500, `Embedding failed for column "${vc.name}": ${embErr.message}`, req.correlationId);
        }
      }
      effectiveRows.push(effectiveRow);
    }

    // --- Build parameterised INSERT (single or multi-row) ---
    const cols    = Object.keys(effectiveRows[0]);
    const colList = cols.map(c => `"${c}"`).join(', ');

    let paramIdx  = 1;
    const valueSets = [];
    const allVals   = [];
    for (const effectiveRow of effectiveRows) {
      const placeholders = cols.map(() => `$${paramIdx++}`);
      valueSets.push(`(${placeholders.join(', ')})`);
      for (const col of cols) {
        const v = effectiveRow[col];
        if (v !== null && typeof v === 'object') allVals.push(JSON.stringify(v));
        else if (typeof v === 'string' && colTypeMap[col] === 'jsonb') allVals.push(JSON.stringify(v));
        else allVals.push(v);
      }
    }

    if (target === 'pgd') pgdClient = getClient(process.env.PGD_DATABASE_URL);
    const dbClient = pgdClient ?? pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const result = await dbClient.query(
      `INSERT INTO "${tableName}" (${colList}) VALUES ${valueSets.join(', ')} RETURNING *`,
      allVals
    );


    if (isBatch) {
      console.info(`table: inserted ${result.rowCount} row(s) into ${tableName}`);
      return ok({
        success:       true,
        tableName,
        rows:          truncateVectorColumns(result.rows, schemaColumns),
        correlationId: req.correlationId,
      }, req.correlationId);
    }

    console.info(`table: inserted row into ${tableName}`);
    return ok({
      success:       true,
      tableName,
      row:           truncateVectorColumns(result.rows, schemaColumns)[0],
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    // PostgreSQL unique violation — return 409 so callers can treat as idempotent
    if (error.code === '23505') {
      console.info('table insertRow: unique constraint violation', { tableName, constraint: error.constraint });
      return err(409, `Duplicate key — row already exists in "${tableName}"`, req.correlationId);
    }
    console.error('table insertRow error:', error.message);
    return err(500, `insertRow failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient?.end();
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/table/updateRows
// ---------------------------------------------------------------------------

async function updateRows(req) {
  const { tableName, filters, updates } = req.body;

  if (!tableName) return err(400, 'tableName is required', req.correlationId);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return err(400, 'updates must be a non-null object', req.correlationId);
  }
  if (Object.keys(updates).length === 0) {
    return err(400, 'updates must have at least one field', req.correlationId);
  }
  if (!Array.isArray(filters) || filters.length === 0) {
    return err(400, 'filters must be a non-empty array — unfiltered UPDATE is not permitted', req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  let   pgdClient = null;

  try {
    await pgcClient.connect();

    // --- Gate: table must be registered and allow_update = true ---
    const gate = await pgcClient.query(
      `SELECT tm.allow_update, s.target, s.columns
         FROM "PGC_TableMap" tm
         JOIN "PGC_Schema"   s  ON s.id = tm.schema_id
        WHERE tm.table_name = $1`,
      [tableName]
    );
    if (gate.rows.length === 0) {
      return err(404, `Table "${tableName}" not registered in PGC_TableMap`, req.correlationId);
    }

    const { allow_update, target, columns: schemaColumns } = gate.rows[0];
    if (!allow_update) {
      return err(403, `UPDATE not permitted on "${tableName}"`, req.correlationId);
    }

    const validColumns = new Set(schemaColumns.map(c => c.name));

    // --- Validate update column names ---
    for (const col of Object.keys(updates)) {
      if (!validColumns.has(col)) {
        return err(400, `Update column "${col}" not found in schema for "${tableName}"`, req.correlationId);
      }
    }

    // --- Validate filter column names and operators ---
    const filterError = validateFilters(filters, validColumns);
    if (filterError) return err(400, filterError, req.correlationId);

    // --- Setup DB client ---
    if (target === 'pgd') pgdClient = getClient(process.env.PGD_DATABASE_URL);
    const dbClient = pgdClient ?? pgcClient;

    if (target === 'pgd') await dbClient.connect();

    // --- Re-compute embeddings when any embed_source field is changing ---
    // Read-before-write: merge current row with updates so the embedding
    // reflects the full post-update state, not just the changed fields.
    // Known limitation: when filters match multiple rows the first row's
    // values are used for missing embed_source fields (same partial data
    // is being written to all matched rows anyway).
    let effectiveUpdates = { ...updates };
    const embedCols = getEmbedColumns(schemaColumns);
    const needsEmbed = embedCols.filter(vc =>
      vc.embed_source.some(sk => sk in updates)
    );

    if (needsEmbed.length > 0) {
      const { whereClause: readWhere, values: readVals } = buildWhereClause(filters);
      const existing = await dbClient.query(
        `SELECT * FROM "${tableName}" ${readWhere} LIMIT 1`,
        readVals
      );

      if (existing.rows.length > 0) {
        const currentRow = existing.rows[0];
        for (const vc of needsEmbed) {
          const merged = { ...currentRow, ...effectiveUpdates };
          try {
            const vec = await resolveEmbedding(vc, merged, req.correlationId);
            if (vec !== null) effectiveUpdates[vc.name] = vec;
          } catch (embErr) {
            console.error(`table updateRows: embedding failed for ${vc.name}`, { tableName, error: embErr.message });
            return err(500, `Embedding failed for column "${vc.name}": ${embErr.message}`, req.correlationId);
          }
        }
      } else {
        console.warn('table updateRows: embed re-compute skipped — filters matched no rows', { tableName });
      }
    }

    // --- Build parameterised SET and WHERE clauses ---
    // SET clause params are $1..$n; WHERE clause params start at $n+1.
    const updateCols = Object.keys(effectiveUpdates);
    const colTypeMap = Object.fromEntries(schemaColumns.map(c => [c.name, c.type]));
    const updateVals = Object.values(effectiveUpdates).map((v, i) => {
      if (v !== null && typeof v === 'object') return JSON.stringify(v);
      if (typeof v === 'string' && colTypeMap[updateCols[i]] === 'jsonb') return JSON.stringify(v);
      return v;
    });
    const setClause = updateCols
      .map((col, i) => `"${col}" = $${i + 1}`)
      .join(', ');

    const { whereClause, values: filterVals } = buildWhereClause(filters, updateCols.length + 1);

    const result = await dbClient.query(
      `UPDATE "${tableName}" SET ${setClause} ${whereClause} RETURNING *`,
      [...updateVals, ...filterVals]
    );


    console.info(`table: updated ${result.rowCount} row(s) in ${tableName}`);

    return ok({
      success:       true,
      tableName,
      updatedCount:  result.rowCount,
      rows:          truncateVectorColumns(result.rows, schemaColumns),
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('table updateRows error:', error.message);
    return err(500, `updateRows failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient?.end();
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/table/deleteRows
// ---------------------------------------------------------------------------

async function deleteRows(req) {
  const { tableName, filters } = req.body;

  if (!tableName) return err(400, 'tableName is required', req.correlationId);
  if (!Array.isArray(filters) || filters.length === 0) {
    return err(400, 'filters must be a non-empty array — unfiltered DELETE is not permitted', req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  let   pgdClient = null;

  try {
    await pgcClient.connect();

    // --- Gate: table must be registered and allow_delete = true ---
    const gate = await pgcClient.query(
      `SELECT tm.allow_delete, s.target, s.columns
         FROM "PGC_TableMap" tm
         JOIN "PGC_Schema"   s  ON s.id = tm.schema_id
        WHERE tm.table_name = $1`,
      [tableName]
    );
    if (gate.rows.length === 0) {
      return err(404, `Table "${tableName}" not registered in PGC_TableMap`, req.correlationId);
    }

    const { allow_delete, target, columns: schemaColumns } = gate.rows[0];
    if (!allow_delete) {
      return err(403, `DELETE not permitted on "${tableName}"`, req.correlationId);
    }

    // --- Validate filter column names and operators ---
    const validColumns = new Set(schemaColumns.map(c => c.name));
    const filterError  = validateFilters(filters, validColumns);
    if (filterError) return err(400, filterError, req.correlationId);

    // --- Build parameterised WHERE clause ---
    const { whereClause, values } = buildWhereClause(filters);

    if (target === 'pgd') pgdClient = getClient(process.env.PGD_DATABASE_URL);
    const dbClient = pgdClient ?? pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const result = await dbClient.query(
      `DELETE FROM "${tableName}" ${whereClause}`,
      values
    );


    console.info(`table: deleted ${result.rowCount} row(s) from ${tableName}`);

    return ok({
      success:       true,
      tableName,
      deletedCount:  result.rowCount,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('table deleteRows error:', error.message);
    return err(500, `deleteRows failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient?.end();
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/table/upsertRows
//
// Workaround upsert — no table currently declares a compound unique
// constraint on matchColumns, so this queries for a match on matchColumns
// and then inserts or updates, rather than a native INSERT ... ON CONFLICT.
// A future migration may add compound unique constraints and switch this
// to native ON CONFLICT for tables that have one.
// ---------------------------------------------------------------------------

/**
 * The row to insert when every matchColumns value is empty (null, undefined or ''), else null.
 *
 * A row with no key value is a new record — the standard form of "insert or update" in one
 * save step, where a new record has no id yet. It cannot match an existing row, and its empty
 * key cannot be written either: '' is not a valid integer or serial. So the lookup is skipped
 * and the empty match columns are left out, letting the database assign them.
 *
 * The exception: a text match column whose stored value really is '' can never be matched.
 *
 * Pure — exported for test.
 *
 * @param {object}   row           one upsert row
 * @param {string[]} matchColumns  non-empty array of column names
 * @returns {object|null} the row without its empty match columns, or null when it carries a key
 */
export function unkeyedInsertRow(row, matchColumns) {
  const isEmpty = v => v === null || v === undefined || v === '';
  if (!matchColumns.every(col => isEmpty(row[col]))) return null;
  const insertRow = { ...row };
  for (const col of matchColumns) delete insertRow[col];
  return insertRow;
}

async function upsertRows(req) {
  const { tableName, matchColumns, rows } = req.body;

  if (!tableName) return err(400, 'tableName is required', req.correlationId);
  if (!Array.isArray(matchColumns) || matchColumns.length === 0) {
    return err(400, 'matchColumns must be a non-empty array', req.correlationId);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return err(400, 'rows must be a non-empty array', req.correlationId);
  }
  if (rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
    return err(400, 'rows must be an array of non-null objects', req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  let   pgdClient = null;

  try {
    await pgcClient.connect();

    // --- Gate: table must be registered and allow both insert + update ---
    const gate = await pgcClient.query(
      `SELECT tm.allow_insert, tm.allow_update, s.target, s.columns
         FROM "PGC_TableMap" tm
         JOIN "PGC_Schema"   s  ON s.id = tm.schema_id
        WHERE tm.table_name = $1`,
      [tableName]
    );
    if (gate.rows.length === 0) {
      return err(404, `Table "${tableName}" not registered in PGC_TableMap`, req.correlationId);
    }

    const { allow_insert, allow_update, target, columns: schemaColumns } = gate.rows[0];
    if (!allow_insert || !allow_update) {
      return err(403, `UPSERT requires both INSERT and UPDATE permission on "${tableName}"`, req.correlationId);
    }

    // --- Validate matchColumns and row column names against PGC_Schema ---
    const validColumns = new Set(schemaColumns.map(c => c.name));
    for (const col of matchColumns) {
      if (!validColumns.has(col)) {
        return err(400, `matchColumns column "${col}" not found in schema for "${tableName}"`, req.correlationId);
      }
    }
    for (const col of Object.keys(rows[0])) {
      if (!validColumns.has(col)) {
        return err(400, `Column "${col}" not found in schema for "${tableName}"`, req.correlationId);
      }
    }

    const colTypeMap = Object.fromEntries(schemaColumns.map(c => [c.name, c.type]));
    const embedCols  = getEmbedColumns(schemaColumns);

    if (target === 'pgd') pgdClient = getClient(process.env.PGD_DATABASE_URL);
    const dbClient = pgdClient ?? pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const inserted = [];
    const updated  = [];

    try {
      await dbClient.query('BEGIN');

      for (const rawRow of rows) {
        // --- Find an existing row matching matchColumns — an unkeyed row is new by definition ---
        const unkeyed = unkeyedInsertRow(rawRow, matchColumns);
        let existing = { rows: [] };
        if (!unkeyed) {
          const matchFilters = matchColumns.map(col => ({ column: col, op: 'eq', value: rawRow[col] }));
          const { whereClause, values: matchVals } = buildWhereClause(matchFilters);
          existing = await dbClient.query(
            `SELECT id FROM "${tableName}" ${whereClause} LIMIT 1`,
            matchVals
          );
        }

        // --- Compute embeddings (same pattern as insertRow/updateRows) ---
        const effectiveRow = { ...(unkeyed ?? rawRow) };
        for (const vc of embedCols) {
          const vec = await resolveEmbedding(vc, effectiveRow, req.correlationId);
          if (vec !== null) effectiveRow[vc.name] = vec;
        }

        const cols = Object.keys(effectiveRow);
        const vals = cols.map(col => {
          const v = effectiveRow[col];
          if (v !== null && typeof v === 'object') return JSON.stringify(v);
          if (typeof v === 'string' && colTypeMap[col] === 'jsonb') return JSON.stringify(v);
          return v;
        });

        if (existing.rows.length > 0) {
          const id = existing.rows[0].id;
          const setClause = cols.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
          const result = await dbClient.query(
            `UPDATE "${tableName}" SET ${setClause} WHERE "id" = $${cols.length + 1} RETURNING *`,
            [...vals, id]
          );
          updated.push(result.rows[0]);
        } else {
          const colList = cols.map(c => `"${c}"`).join(', ');
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const result = await dbClient.query(
            `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders}) RETURNING *`,
            vals
          );
          inserted.push(result.rows[0]);
        }
      }

      await dbClient.query('COMMIT');
    } catch (innerError) {
      await dbClient.query('ROLLBACK');
      throw innerError;
    }


    console.info(`table: upserted ${tableName} — inserted ${inserted.length}, updated ${updated.length}`);

    return ok({
      success:       true,
      tableName,
      inserted:      truncateVectorColumns(inserted, schemaColumns),
      updated:       truncateVectorColumns(updated, schemaColumns),
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('table upsertRows error:', error.message);
    return err(500, `upsertRows failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient?.end();
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/table/saveRows
//
// A grid's save. Rows to change or remove are locked and their versions compared before
// anything is written; one that moved fails the whole save with 409. With changeLog, every
// row written is logged to PGC_ChangeLog in the same transaction, through the same
// connection — PGC and PGD are one database (arch-data.md §4.3.7).
// ---------------------------------------------------------------------------

// A version is updated_at as PostgreSQL text, to the microsecond (`updated_at::text`).
const VERSION_TEXT   = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The request's shape, before anything is read: an error string, or null.
 * Pure — exported for test.
 */
export function checkRowWrites(body) {
  const { tableName, update = [], insert = [], delete: remove = [], changeLog } = body ?? {};
  if (typeof tableName !== 'string' || !/^PGD_[A-Za-z][A-Za-z0-9_]*$/.test(tableName)) {
    return 'tableName must name a PGD_ table';
  }
  for (const [key, list] of [['update', update], ['insert', insert], ['delete', remove]]) {
    if (!Array.isArray(list)) return `${key} must be an array`;
  }
  if (update.length + insert.length + remove.length === 0) {
    return 'nothing to write — update, insert and delete are all empty';
  }
  const versioned = (r, at) => {
    if (!isRecord(r) || !Number.isInteger(r.id)) return `${at}.id must be an integer`;
    if (typeof r.version !== 'string' || !VERSION_TEXT.test(r.version)) {
      return `${at}.version must be the version the row was read at (updated_at as text)`;
    }
    return null;
  };
  for (const [i, r] of update.entries()) {
    const e = versioned(r, `update[${i}]`);
    if (e) return e;
    if (!isRecord(r.changes) || Object.keys(r.changes).length === 0) {
      return `update[${i}].changes must be an object with at least one column`;
    }
  }
  for (const [i, r] of insert.entries()) {
    if (!isRecord(r) || Object.keys(r).length === 0) return `insert[${i}] must be an object with at least one column`;
  }
  for (const [i, r] of remove.entries()) {
    const e = versioned(r, `delete[${i}]`);
    if (e) return e;
  }
  const ids = [...update, ...remove].map(r => r.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) return `row ${twice} appears more than once`;
  if (changeLog !== undefined) {
    if (!isRecord(changeLog)) return 'changeLog must be an object';
    if (changeLog.via !== 'web') return 'changeLog.via must be "web"';
    if (typeof changeLog.domain !== 'string' || !changeLog.domain) return 'changeLog.domain is required';
    if (changeLog.actor != null && typeof changeLog.actor !== 'string') return 'changeLog.actor must be a string or null';
    if (changeLog.runId != null && !Number.isInteger(changeLog.runId)) return 'changeLog.runId must be an integer or null';
  }
  return null;
}

/**
 * The columns a save writes, against the table's schema: an error string, or null. A table
 * without updated_at has no versions; system and vector columns are never written directly.
 * Pure — exported for test.
 */
export function checkWriteColumns(body, schemaColumns) {
  const types = new Map(schemaColumns.map(c => [c.name, c.type]));
  if (!types.has('updated_at')) return `"${body.tableName}" has no updated_at column — it accepts no versioned writes`;
  const writes = [
    ...(body.update ?? []).map((r, i) => [`update[${i}].changes`, r.changes]),
    ...(body.insert ?? []).map((r, i) => [`insert[${i}]`, r]),
  ];
  for (const [at, row] of writes) {
    for (const col of Object.keys(row)) {
      if (!types.has(col)) return `${at}: column "${col}" not found in schema for "${body.tableName}"`;
      if (SYSTEM_COLUMNS.has(col) || types.get(col)?.startsWith('vector')) {
        return `${at}: column "${col}" is maintained by the system`;
      }
    }
  }
  return null;
}

/**
 * The rows that moved since they were read — gone, or at another version.
 * Pure — exported for test.
 *
 * @param {string} tableName
 * @param {{ id: number, version: string }[]} claimed  the rows to change or remove, as read
 * @param {Map<number, { version: string }>} current  the same rows now, locked
 */
export function findVersionConflicts(tableName, claimed, current) {
  return claimed.flatMap(({ id, version }) => {
    const now = current.get(id);
    if (!now)                    return [{ table: tableName, id, reason: 'deleted' }];
    if (now.version !== version) return [{ table: tableName, id, reason: 'changed' }];
    return [];
  });
}

/**
 * A change log row's `changes`: each field's old and new value — an insert new only, a delete
 * old only, an update the columns it set whose value differs. Rows are as `to_jsonb` gives
 * them, so a timestamp keeps its microseconds. `skip` holds updated_at and vector columns.
 * Pure — exported for test.
 */
export function fieldChanges(operation, oldRow, newRow, skip, columns) {
  const changes = {};
  if (operation === 'insert') {
    for (const [col, v] of Object.entries(newRow)) if (!skip.has(col)) changes[col] = { new: v };
  } else if (operation === 'delete') {
    for (const [col, v] of Object.entries(oldRow)) if (!skip.has(col)) changes[col] = { old: v };
  } else {
    for (const col of columns) {
      if (skip.has(col)) continue;
      const before = oldRow[col] ?? null;
      const after  = newRow[col] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes[col] = { old: before, new: after };
    }
  }
  return changes;
}

/** A value as pg takes it for a column: objects, and strings bound for jsonb, as JSON text. */
function toParam(v, colType) {
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && colType === 'jsonb') return JSON.stringify(v);
  return v;
}

async function saveRows(req) {
  const shapeError = checkRowWrites(req.body);
  if (shapeError) return err(400, shapeError, req.correlationId);

  const { tableName, update = [], insert = [], delete: remove = [], changeLog } = req.body;

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  let   pgdClient = null;

  try {
    await pgcClient.connect();

    // --- Gate: registered, and each kind of write the request carries allowed ---
    const gate = await pgcClient.query(
      `SELECT tm.allow_insert, tm.allow_update, tm.allow_delete, s.target, s.columns
         FROM "PGC_TableMap" tm
         JOIN "PGC_Schema"   s  ON s.id = tm.schema_id
        WHERE tm.table_name = $1`,
      [tableName]
    );
    if (gate.rows.length === 0) {
      return err(404, `Table "${tableName}" not registered in PGC_TableMap`, req.correlationId);
    }
    const { allow_insert, allow_update, allow_delete, target, columns: schemaColumns } = gate.rows[0];
    for (const [kind, rows, allowed] of [['UPDATE', update, allow_update], ['INSERT', insert, allow_insert], ['DELETE', remove, allow_delete]]) {
      if (rows.length > 0 && !allowed) return err(403, `${kind} not permitted on "${tableName}"`, req.correlationId);
    }

    const columnError = checkWriteColumns(req.body, schemaColumns);
    if (columnError) return err(400, columnError, req.correlationId);

    const colTypeMap = Object.fromEntries(schemaColumns.map(c => [c.name, c.type]));
    const embedCols  = getEmbedColumns(schemaColumns);
    const skip       = new Set(['updated_at', ...schemaColumns.filter(c => c.type?.startsWith('vector')).map(c => c.name)]);

    if (target === 'pgd') pgdClient = getClient(process.env.PGD_DATABASE_URL);
    const dbClient = pgdClient ?? pgcClient;
    if (target === 'pgd') await dbClient.connect();

    // Each written row comes back whole, with its new version and as to_jsonb for the log.
    const returning = `RETURNING t.*, t."updated_at"::text AS "_version", to_jsonb(t) AS "_json"`;
    const withEmbeddings = async (row, changed) => {
      const effective = { ...changed };
      for (const vc of embedCols) {
        if (!vc.embed_source.some(k => k in changed)) continue;
        const vec = await resolveEmbedding(vc, { ...row, ...changed }, req.correlationId);
        if (vec !== null) effective[vc.name] = vec;
      }
      return effective;
    };

    const updated  = [];
    const inserted = [];
    const logRows  = [];

    try {
      await dbClient.query('BEGIN');

      // --- Lock the rows to change or remove, and compare their versions ---
      const current = new Map();
      const claimed = [...update, ...remove];
      if (claimed.length > 0) {
        const locked = await dbClient.query(
          `SELECT to_jsonb(t) AS "row", t."updated_at"::text AS "version"
             FROM "${tableName}" AS t WHERE t."id" = ANY($1) FOR UPDATE`,
          [claimed.map(r => r.id)]
        );
        for (const { row, version } of locked.rows) current.set(row.id, { row, version });
      }
      const conflicts = findVersionConflicts(tableName, claimed, current);
      if (conflicts.length > 0) {
        await dbClient.query('ROLLBACK');
        console.info(`table saveRows: version conflict on ${tableName}`, { conflicts });
        return respond(409, { success: false, error: 'version_conflict', conflicts, correlationId: req.correlationId }, req.correlationId);
      }

      for (const { id, changes } of update) {
        const old       = current.get(id).row;
        const effective = await withEmbeddings(old, changes);
        const cols      = Object.keys(effective);
        const result    = await dbClient.query(
          `UPDATE "${tableName}" AS t SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
            WHERE t."id" = $${cols.length + 1} ${returning}`,
          [...cols.map(c => toParam(effective[c], colTypeMap[c])), id]
        );
        const { _json, ...row } = result.rows[0];
        updated.push(row);
        logRows.push({ id, operation: 'update', changes: fieldChanges('update', old, _json, skip, Object.keys(changes)) });
      }

      for (const raw of insert) {
        const effective = await withEmbeddings({}, raw);
        const cols      = Object.keys(effective);
        const result    = await dbClient.query(
          `INSERT INTO "${tableName}" AS t (${cols.map(c => `"${c}"`).join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${returning}`,
          cols.map(c => toParam(effective[c], colTypeMap[c]))
        );
        const { _json, ...row } = result.rows[0];
        inserted.push(row);
        logRows.push({ id: row.id, operation: 'insert', changes: fieldChanges('insert', null, _json, skip) });
      }

      if (remove.length > 0) {
        await dbClient.query(`DELETE FROM "${tableName}" WHERE "id" = ANY($1)`, [remove.map(r => r.id)]);
        for (const { id } of remove) {
          logRows.push({ id, operation: 'delete', changes: fieldChanges('delete', current.get(id).row, null, skip) });
        }
      }

      // --- The log, in the same transaction: an update that changed nothing is not a change ---
      let batchId;
      const logged = logRows.filter(r => Object.keys(r.changes).length > 0);
      if (changeLog && logged.length > 0) {
        batchId = randomUUID();
        const values = [];
        const tuples = logged.map(r => {
          values.push(batchId, changeLog.actor ?? null, changeLog.via, changeLog.runId ?? null, changeLog.domain,
                      tableName, String(r.id), r.operation, JSON.stringify(r.changes));
          const at = values.length - 9;
          return `(${Array.from({ length: 9 }, (_, i) => `$${at + i + 1}`).join(', ')})`;
        });
        await dbClient.query(
          `INSERT INTO "PGC_ChangeLog"
             (batch_id, actor, via, run_id, domain, table_name, record_id, operation, changes)
           VALUES ${tuples.join(', ')}`,
          values
        );
      }

      await dbClient.query('COMMIT');

      console.info(`table: saved ${tableName} — updated ${updated.length}, inserted ${inserted.length}, deleted ${remove.length}`);
      return ok({
        success:       true,
        tableName,
        ...(batchId ? { batchId } : {}),
        updated:       truncateVectorColumns(updated, schemaColumns),
        inserted:      truncateVectorColumns(inserted, schemaColumns),
        deleted:       remove.map(r => r.id),
        correlationId: req.correlationId,
      }, req.correlationId);
    } catch (innerError) {
      await dbClient.query('ROLLBACK');
      throw innerError;
    }

  } catch (error) {
    console.error('table saveRows error:', error.message);
    return err(500, `saveRows failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient?.end();
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Validate filter array — operators and column names.
 * Returns an error string or null if valid.
 */
export function validateFilters(filters, validColumns) {
  if (!Array.isArray(filters)) return 'filters must be an array';

  for (const f of filters) {
    if (!f.column) return 'each filter must have a column';
    if (!f.op)     return 'each filter must have an op';

    if (!validColumns.has(f.column)) {
      return `filter column "${f.column}" not found in schema`;
    }
    if (!ALLOWED_OPS.has(f.op)) {
      return `filter op "${f.op}" is not allowed`;
    }
    if (f.op === 'in' && !Array.isArray(f.value)) {
      return `filter op "in" requires value to be an array`;
    }
  }
  return null;
}

/**
 * Build a parameterised WHERE clause from a filter array.
 * startIdx — offset for $n placeholders when preceding params exist (e.g. UPDATE SET values).
 * Returns { whereClause, values }.
 */
export function buildWhereClause(filters, startIdx = 1) {
  if (!filters.length) return { whereClause: '', values: [] };

  const conditions = [];
  const values     = [];
  let   idx        = startIdx;

  for (const f of filters) {
    const col = `"${f.column}"`;

    switch (f.op) {
      case 'eq':
        if (f.value === null) {
          conditions.push(`${col} IS NULL`);
        } else {
          conditions.push(`${col} = $${idx++}`);
          values.push(f.value);
        }
        break;
      case 'neq':
        conditions.push(`${col} != $${idx++}`);
        values.push(f.value);
        break;
      case 'gt':
        conditions.push(`${col} > $${idx++}`);
        values.push(f.value);
        break;
      case 'gte':
        conditions.push(`${col} >= $${idx++}`);
        values.push(f.value);
        break;
      case 'lt':
        conditions.push(`${col} < $${idx++}`);
        values.push(f.value);
        break;
      case 'lte':
        conditions.push(`${col} <= $${idx++}`);
        values.push(f.value);
        break;
      case 'like':
        conditions.push(`${col} LIKE $${idx++}`);
        values.push(f.value);
        break;
      case 'in':
        conditions.push(`${col} = ANY($${idx++})`);
        values.push(f.value);
        break;
      case 'is_null':
        conditions.push(`${col} IS NULL`);
        break;
      case 'not_null':
        conditions.push(`${col} IS NOT NULL`);
        break;
      case 'jsonb_contains':
        conditions.push(`${col} @> $${idx++}::jsonb`);
        values.push(typeof f.value === 'string' ? f.value : JSON.stringify(f.value));
        break;
      case 'jsonb_contained_by':
        conditions.push(`${col} <@ $${idx++}::jsonb`);
        values.push(typeof f.value === 'string' ? f.value : JSON.stringify(f.value));
        break;
    }
  }

  return {
    whereClause: `WHERE ${conditions.join(' AND ')}`,
    values,
  };
}
