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
//
// Security gates:
//   - Table must exist in PGC_TableMap
//   - Column names in filters/updates validated against PGC_Schema columns for that table
//   - Filter operators validated against whitelist
//   - filters must be non-empty on UPDATE and DELETE — mass unfiltered writes are not permitted
//   - No raw SQL accepted in any field

import { ok, err }      from '../shared/lambda-utils.mjs';
import { getClient }    from './init-brain.mjs';

// ---------------------------------------------------------------------------
// Allowed filter operators — security gate.
// ---------------------------------------------------------------------------
const ALLOWED_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'is_null', 'not_null',
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
    filters  = [],
    orderBy,
    limit    = 100,
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

    // --- Validate filter column names against PGC_Schema ---
    const validColumns = new Set(schemaColumns.map(c => c.name));
    const filterError  = validateFilters(filters, validColumns);
    if (filterError) {
      return err(400, filterError, req.correlationId);
    }

    // --- Validate orderBy column ---
    if (orderBy && !validColumns.has(orderBy.column)) {
      return err(400, `orderBy column "${orderBy.column}" not found in schema`, req.correlationId);
    }

    // --- Validate limit ---
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);

    // --- Build parameterised query ---
    const { whereClause, values } = buildWhereClause(filters);

    const orderClause = orderBy
      ? `ORDER BY "${orderBy.column}" ${orderBy.direction === 'desc' ? 'DESC' : 'ASC'}`
      : '';

    // Choose the correct DB client based on where the table lives
    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const sql = `
      SELECT * FROM "${tableName}"
      ${whereClause}
      ${orderClause}
      LIMIT ${safeLimit}
    `;

    const result = await dbClient.query(sql, values);

    if (target === 'pgd') await dbClient.end();

    return ok({
      success:       true,
      tableName,
      count:         result.rows.length,
      rows:          result.rows,
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
// POST /serv/table/insertRow
// ---------------------------------------------------------------------------

async function insertRow(req) {
  const { tableName, row } = req.body;

  if (!tableName)            return err(400, 'tableName is required', req.correlationId);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return err(400, 'row must be a non-null object', req.correlationId);
  }
  if (Object.keys(row).length === 0) {
    return err(400, 'row must have at least one field', req.correlationId);
  }

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

    // --- Validate row column names against PGC_Schema ---
    const validColumns = new Set(schemaColumns.map(c => c.name));
    for (const col of Object.keys(row)) {
      if (!validColumns.has(col)) {
        return err(400, `Column "${col}" not found in schema for "${tableName}"`, req.correlationId);
      }
    }

    // --- Build parameterised INSERT ---
    const cols   = Object.keys(row);
    const vals         = Object.values(row).map(v =>
      (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
    );
    const colList      = cols.map(c => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dbClient.connect();

    const result = await dbClient.query(
      `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders}) RETURNING *`,
      vals
    );

    if (target === 'pgd') await dbClient.end();

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

    // --- Build parameterised SET and WHERE clauses ---
    // SET clause params are $1..$n; WHERE clause params start at $n+1
    const updateCols = Object.keys(updates);
    const updateVals = Object.values(updates).map(v =>
      (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
    );
    const setClause = updateCols
      .map((col, i) => `"${col}" = $${i + 1}`)
      .join(', ');

    const { whereClause, values: filterVals } = buildWhereClause(filters, updateCols.length + 1);

    const dbClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dbClient.connect();

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
// Filter helpers
// ---------------------------------------------------------------------------

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
    }
  }

  return {
    whereClause: `WHERE ${conditions.join(' AND ')}`,
    values,
  };
}
