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
//   POST /serv/table/getRows    — parameterised SELECT with filters, orderBy, limit
//   POST /serv/table/insertRow  — single INSERT, gated by allow_insert
//   POST /serv/table/updateRows — parameterised UPDATE, gated by allow_update
//   POST /serv/table/deleteRows — parameterised DELETE, gated by allow_delete
//   POST /serv/table/upsertRows — per-row INSERT or UPDATE by matchColumns, gated by allow_insert + allow_update
//
// Security gates:
//   - Table must exist in PGC_TableMap
//   - Column names in filters/updates validated against PGC_Schema columns for that table
//   - Filter operators validated against whitelist
//   - filters must be non-empty on UPDATE and DELETE — mass unfiltered writes are not permitted
//   - No raw SQL accepted in any field

import { ok, err }    from '../shared/lambda-utils.mjs';
import { getClient }  from './init-brain.mjs';
import { embedText }  from '../shared/embed-client.mjs';

// ---------------------------------------------------------------------------
// Allowed filter operators — security gate.
// ---------------------------------------------------------------------------
const ALLOWED_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'is_null', 'not_null', 'jsonb_contains',
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
    default:
      return err(404, `SERV-Table route "${req.subRoute}" not found`, req.correlationId);
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
    limit        = 100,
    vectorSearch = null,
    columns      = null,
  } = req.body;

  if (!tableName) {
    return err(400, 'tableName is required', req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

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
    // Accept both object { column, direction } and string "col ASC" / "col DESC".
    const normalizedOrderBy = normalizeOrderBy(orderBy);
    if (normalizedOrderBy && !validColumns.has(normalizedOrderBy.column)) {
      return err(400, `orderBy column "${normalizedOrderBy.column}" not found in schema`, req.correlationId);
    }

    // --- Validate vectorSearch if present ---
    if (vectorSearch) {
      if (!vectorSearch.column || !vectorSearch.queryText) {
        return err(400, 'vectorSearch requires column and queryText', req.correlationId);
      }
      const vsCol = schemaColumns.find(c => c.name === vectorSearch.column);
      if (!vsCol) {
        return err(400, `vectorSearch column "${vectorSearch.column}" not found in schema`, req.correlationId);
      }
      if (!vsCol.type?.startsWith('vector')) {
        return err(400, `vectorSearch column "${vectorSearch.column}" must be type vector`, req.correlationId);
      }
    }

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);

    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dbClient.connect();

    let result;

    if (vectorSearch) {
      // --- pgvector cosine similarity search ---
      // Embed the query text in SERV — caller supplies plain text only.
      const queryVec      = await embedText(vectorSearch.queryText, req.correlationId);
      const threshold     = vectorSearch.threshold ?? 0.75;
      const vsLimit       = Math.min(vectorSearch.limit ?? safeLimit, safeLimit);
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
        SELECT *, 1 - (${vsCol} <=> $${vecIdx}::vector) AS similarity
        FROM "${tableName}"
        ${combinedWhere}
        ORDER BY ${vsCol} <=> $${vecIdx}::vector
        LIMIT ${vsLimit}
      `;

      result = await dbClient.query(sql, [
        ...filterVals,
        JSON.stringify(queryVec),
        threshold,
      ]);

    } else {
      // --- Standard parameterised SELECT ---
      const { whereClause, values } = buildWhereClause(filters);

      const orderClause = normalizedOrderBy
        ? `ORDER BY "${normalizedOrderBy.column}" ${normalizedOrderBy.direction === 'desc' ? 'DESC' : 'ASC'}`
        : '';

      let selectList = '*';
      if (columns?.length) {
        const invalid = columns.find(c => !validColumns.has(c));
        if (invalid) return err(400, `Column "${invalid}" not found in schema for "${tableName}"`, req.correlationId);
        selectList = columns.map(c => `"${c}"`).join(', ');
      }

      const sql = `
        SELECT ${selectList} FROM "${tableName}"
        ${whereClause}
        ${orderClause}
        LIMIT ${safeLimit}
      `;

      result = await dbClient.query(sql, values);
    }

    if (target === 'pgd') await dbClient.end();

    // Truncate vector columns to 5 chars + '...' — enough to confirm populated
    // vs null without returning the full vector payload.
    const vectorCols = new Set(schemaColumns.filter(c => c.type?.startsWith('vector')).map(c => c.name));
    const rows = vectorCols.size === 0
      ? result.rows
      : result.rows.map(row => {
          const clean = { ...row };
          for (const col of vectorCols) {
            const v = clean[col];
            clean[col] = v == null ? null : String(v).slice(0, 5) + '...';
          }
          return clean;
        });

    return ok({
      success:       true,
      tableName,
      count:         rows.length,
      rows,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('table getRows error:', error.message);
    return err(500, `getRows failed: ${error.message}`, req.correlationId);
  } finally {
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

// ---------------------------------------------------------------------------
// POST /serv/table/insertRow
// ---------------------------------------------------------------------------

async function insertRow(req) {
  const { tableName, row, rows } = req.body;

  // Accept either a single row object or an array of rows for bulk insert.
  // Bulk path: all rows must have the same column set (derived from the first row).
  const isBatch = Array.isArray(rows) && rows.length > 0;

  if (!tableName) return err(400, 'tableName is required', req.correlationId);

  if (isBatch) {
    if (rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
      return err(400, 'rows must be an array of non-null objects', req.correlationId);
    }
    if (Object.keys(rows[0]).length === 0) {
      return err(400, 'rows must have at least one field', req.correlationId);
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

    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const result = await dbClient.query(
      `INSERT INTO "${tableName}" (${colList}) VALUES ${valueSets.join(', ')} RETURNING *`,
      allVals
    );

    if (target === 'pgd') await dbClient.end();

    if (isBatch) {
      console.info(`table: inserted ${result.rowCount} row(s) into ${tableName}`);
      return ok({
        success:       true,
        tableName,
        rows:          result.rows,
        correlationId: req.correlationId,
      }, req.correlationId);
    }

    console.info(`table: inserted row into ${tableName}`);
    return ok({
      success:       true,
      tableName,
      row:           result.rows[0],
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
    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

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

    if (target === 'pgd') await dbClient.end();

    console.info(`table: updated ${result.rowCount} row(s) in ${tableName}`);

    return ok({
      success:       true,
      tableName,
      updatedCount:  result.rowCount,
      rows:          result.rows,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('table updateRows error:', error.message);
    return err(500, `updateRows failed: ${error.message}`, req.correlationId);
  } finally {
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

    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const result = await dbClient.query(
      `DELETE FROM "${tableName}" ${whereClause}`,
      values
    );

    if (target === 'pgd') await dbClient.end();

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

    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const inserted = [];
    const updated  = [];

    try {
      await dbClient.query('BEGIN');

      for (const rawRow of rows) {
        // --- Find an existing row matching matchColumns ---
        const matchFilters = matchColumns.map(col => ({ column: col, op: 'eq', value: rawRow[col] }));
        const { whereClause, values: matchVals } = buildWhereClause(matchFilters);
        const existing = await dbClient.query(
          `SELECT id FROM "${tableName}" ${whereClause} LIMIT 1`,
          matchVals
        );

        // --- Compute embeddings (same pattern as insertRow/updateRows) ---
        const effectiveRow = { ...rawRow };
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

    if (target === 'pgd') await dbClient.end();

    console.info(`table: upserted ${tableName} — inserted ${inserted.length}, updated ${updated.length}`);

    return ok({
      success:       true,
      tableName,
      inserted,
      updated,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('table upsertRows error:', error.message);
    return err(500, `upsertRows failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Normalise orderBy to { column, direction } regardless of input form.
 * Accepts object { column, direction } or string "col_name ASC" / "col_name".
 */
function normalizeOrderBy(orderBy) {
  if (!orderBy) return null;
  if (typeof orderBy === 'object') return orderBy;
  const parts = String(orderBy).trim().split(/\s+/);
  return {
    column:    parts[0],
    direction: (parts[1] ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
  };
}

/**
 * Validate filter array — operators and column names.
 * Returns an error string or null if valid.
 */
function validateFilters(filters, validColumns) {
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
function buildWhereClause(filters, startIdx = 1) {
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
    }
  }

  return {
    whereClause: `WHERE ${conditions.join(' AND ')}`,
    values,
  };
}
