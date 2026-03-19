// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/entity.mjs
// Handles /api/v1/serv/entity/* routes.
//
// SERV-Entity is the user-facing domain data layer. Callers use entity names
// (Recipe, Stock) — never table names. PGC_EntitySchema defines the root_table,
// joins, aggregations, upsert_key, and default filters for each entity.
//
// Routes:
//   POST /serv/entity/getEntity     — fetch one by id with joins/aggregations
//   POST /serv/entity/listEntities  — filter, orderBy, limit with joins/aggregations
//   POST /serv/entity/createEntity  — INSERT root row
//   POST /serv/entity/updateEntity  — PATCH or REPLACE root row
//   POST /serv/entity/upsertEntity  — INSERT ... ON CONFLICT DO UPDATE
//   POST /serv/entity/deleteEntity  — DELETE root row (CASCADE handles children)
//
// Security gates:
//   - entityName must be registered in PGC_EntitySchema
//   - Column names validated against PGC_Schema for the root_table
//   - allow_delete checked via PGC_TableMap for deleteEntity
//   - System columns (id, created_at, updated_at) excluded from all writes
//   - No raw SQL accepted in any field

import { ok, err }   from '../shared/lambda-utils.mjs';
import { getClient } from './init-brain.mjs';

// System columns never written by callers
const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('../shared/lambda-utils.mjs').parseEvent>} req
 */
export async function handle(req) {
  switch (req.subRoute) {
    case 'getEntity':    return getEntity(req);
    case 'listEntities': return listEntities(req);
    case 'createEntity': return createEntity(req);
    case 'updateEntity': return updateEntity(req);
    case 'upsertEntity': return upsertEntity(req);
    case 'deleteEntity': return deleteEntity(req);
    default:
      return err(404, `SERV-Entity route "${req.subRoute}" not found`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Load entity definition from PGC_EntitySchema + column list from PGC_Schema.
 * Returns { entity, validColumns } or calls err() if not found.
 */
async function loadEntity(pgcClient, entityName, correlationId) {
  const result = await pgcClient.query(
    `SELECT e.*, s.columns AS schema_columns, s.target,
            tm.allow_delete, tm.allow_insert, tm.allow_update
       FROM "PGC_EntitySchema" e
       JOIN "PGC_Schema"  s  ON s.table_name = e.root_table
       JOIN "PGC_TableMap" tm ON tm.table_name = e.root_table
      WHERE e.entity_name = $1`,
    [entityName]
  );
  if (result.rows.length === 0) {
    return { error: err(404, `Entity "${entityName}" not registered in PGC_EntitySchema`, correlationId) };
  }
  const entity       = result.rows[0];
  const validColumns = new Set(entity.schema_columns.map(c => c.name));
  return { entity, validColumns };
}

/**
 * Build a SELECT with LEFT JOINs and jsonb_agg aggregations from entity definition.
 * Returns { sql, baseAlias: 'r' }.
 */
function buildSelectSQL(tableName, joins = [], aggregations = []) {
  const joinClauses = (joins || []).map(j =>
    `${j.type || 'LEFT'} JOIN "${j.table}" ${j.alias || j.table} ON ${j.on}`
  );

  const aggCols = (aggregations || []).map(a => {
    const cols = a.columns?.length
      ? a.columns.map(c => `'${c}', ${a.alias}.${c}`).join(', ')
      : `${a.alias}.*`;
    return `jsonb_agg(DISTINCT jsonb_build_object(${cols}))
              FILTER (WHERE ${a.alias}.id IS NOT NULL) AS "${a.outputKey}"`;
  });

  const selectCols = ['r.*', ...aggCols].join(',\n       ');
  const groupBy    = aggCols.length ? 'GROUP BY r.id' : '';

  return {
    sql: `SELECT ${selectCols}
      FROM "${tableName}" r
      ${joinClauses.join('\n      ')}
      ${groupBy}`,
    baseAlias: 'r',
  };
}

/**
 * Validate that all keys in `data` are in validColumns and not system columns.
 * Returns error string or null.
 */
function validateColumns(data, validColumns, entityName) {
  for (const col of Object.keys(data)) {
    if (SYSTEM_COLS.has(col)) continue; // silently ignore, not an error
    if (!validColumns.has(col)) {
      return `Column "${col}" not found in schema for entity "${entityName}"`;
    }
  }
  return null;
}

/**
 * Strip system columns from a data object before writing to DB.
 */
function stripSystemCols(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([k]) => !SYSTEM_COLS.has(k))
  );
}

/**
 * Serialize jsonb values for pg parameterised queries.
 */
function serializeValues(values) {
  return values.map(v =>
    (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
  );
}

// ---------------------------------------------------------------------------
// POST /serv/entity/getEntity
// ---------------------------------------------------------------------------

async function getEntity(req) {
  const { entityName, id } = req.body;

  if (!entityName) return err(400, 'entityName is required', req.correlationId);
  if (id === undefined || id === null) return err(400, 'id is required', req.correlationId);

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();
    const { entity, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;

    const pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      const { sql } = buildSelectSQL(entity.root_table, entity.joins, entity.aggregations);
      const result  = await pgdClient.query(
        `${sql} ${sql.includes('GROUP BY') ? 'HAVING r.id = $1' : 'WHERE r.id = $1'}`,
        [id]
      );

      if (result.rows.length === 0) {
        return err(404, `Entity "${entityName}" with id ${id} not found`, req.correlationId);
      }

      return ok({
        success:       true,
        entityName,
        entity:        result.rows[0],
        correlationId: req.correlationId,
      }, req.correlationId);

    } finally {
      await pgdClient.end();
    }

  } catch (error) {
    console.error('entity getEntity error:', error.message);
    return err(500, `getEntity failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/entity/listEntities
// ---------------------------------------------------------------------------

async function listEntities(req) {
  const { entityName, filters = [], orderBy, limit = 100 } = req.body;

  if (!entityName) return err(400, 'entityName is required', req.correlationId);

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();
    const { entity, validColumns, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;

    // Validate caller filters
    const allFilters = [...(entity.filters || []), ...filters];
    for (const f of filters) {
      if (!validColumns.has(f.column)) {
        return err(400, `Filter column "${f.column}" not found in schema for entity "${entityName}"`, req.correlationId);
      }
    }

    if (orderBy && !validColumns.has(orderBy.column)) {
      return err(400, `orderBy column "${orderBy.column}" not found in schema`, req.correlationId);
    }

    const safeLimit   = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);
    const { sql }     = buildSelectSQL(entity.root_table, entity.joins, entity.aggregations);
    const hasGroupBy  = sql.includes('GROUP BY');

    // Build WHERE clause — prefix columns with "r." for root table alias
    const conditions  = [];
    const values      = [];
    let   idx         = 1;

    for (const f of allFilters) {
      const col = `r."${f.column}"`;
      switch (f.op) {
        case 'eq':       conditions.push(`${col} = $${idx++}`);      values.push(f.value);  break;
        case 'neq':      conditions.push(`${col} != $${idx++}`);     values.push(f.value);  break;
        case 'gt':       conditions.push(`${col} > $${idx++}`);      values.push(f.value);  break;
        case 'gte':      conditions.push(`${col} >= $${idx++}`);     values.push(f.value);  break;
        case 'lt':       conditions.push(`${col} < $${idx++}`);      values.push(f.value);  break;
        case 'lte':      conditions.push(`${col} <= $${idx++}`);     values.push(f.value);  break;
        case 'like':     conditions.push(`${col} LIKE $${idx++}`);   values.push(f.value);  break;
        case 'in':       conditions.push(`${col} = ANY($${idx++})`); values.push(f.value);  break;
        case 'is_null':  conditions.push(`${col} IS NULL`);                                  break;
        case 'not_null': conditions.push(`${col} IS NOT NULL`);                              break;
      }
    }

    const whereOrHaving = conditions.length
      ? `${hasGroupBy ? 'HAVING' : 'WHERE'} ${conditions.join(' AND ')}`
      : '';

    const orderClause = orderBy
      ? `ORDER BY r."${orderBy.column}" ${orderBy.direction === 'desc' ? 'DESC' : 'ASC'}`
      : '';

    const pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      const result = await pgdClient.query(
        `${sql} ${whereOrHaving} ${orderClause} LIMIT ${safeLimit}`,
        values
      );

      return ok({
        success:       true,
        entityName,
        count:         result.rows.length,
        entities:      result.rows,
        correlationId: req.correlationId,
      }, req.correlationId);

    } finally {
      await pgdClient.end();
    }

  } catch (error) {
    console.error('entity listEntities error:', error.message);
    return err(500, `listEntities failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/entity/createEntity
// ---------------------------------------------------------------------------

async function createEntity(req) {
  const { entityName, row } = req.body;

  if (!entityName) return err(400, 'entityName is required', req.correlationId);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return err(400, 'row must be a non-null object', req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();
    const { entity, validColumns, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;

    if (!entity.allow_insert) {
      return err(403, `INSERT not permitted on entity "${entityName}"`, req.correlationId);
    }

    const cleanRow   = stripSystemCols(row);
    const colError   = validateColumns(cleanRow, validColumns, entityName);
    if (colError) return err(400, colError, req.correlationId);

    if (Object.keys(cleanRow).length === 0) {
      return err(400, 'row must have at least one non-system field', req.correlationId);
    }

    const cols         = Object.keys(cleanRow);
    const vals         = serializeValues(Object.values(cleanRow));
    const colList      = cols.map(c => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    const pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      const result = await pgdClient.query(
        `INSERT INTO "${entity.root_table}" (${colList}) VALUES (${placeholders}) RETURNING *`,
        vals
      );

      console.info(`entity: created ${entityName} id=${result.rows[0].id}`);

      return ok({
        success:       true,
        entityName,
        id:            result.rows[0].id,
        row:           result.rows[0],
        correlationId: req.correlationId,
      }, req.correlationId);

    } finally {
      await pgdClient.end();
    }

  } catch (error) {
    if (error.code === '23505') {
      return err(409, `Duplicate key — ${entityName} already exists`, req.correlationId);
    }
    console.error('entity createEntity error:', error.message);
    return err(500, `createEntity failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/entity/updateEntity
// ---------------------------------------------------------------------------

async function updateEntity(req) {
  const { entityName, id, updates, mode = 'patch' } = req.body;

  if (!entityName) return err(400, 'entityName is required', req.correlationId);
  if (id === undefined || id === null) return err(400, 'id is required', req.correlationId);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return err(400, 'updates must be a non-null object', req.correlationId);
  }
  if (!['patch', 'replace'].includes(mode)) {
    return err(400, `mode must be "patch" or "replace", got "${mode}"`, req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();
    const { entity, validColumns, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;

    if (!entity.allow_update) {
      return err(403, `UPDATE not permitted on entity "${entityName}"`, req.correlationId);
    }

    const cleanUpdates = stripSystemCols(updates);
    const colError     = validateColumns(cleanUpdates, validColumns, entityName);
    if (colError) return err(400, colError, req.correlationId);

    let writeData;

    if (mode === 'replace') {
      // Build full row from schema — all non-system columns, set to null if not provided
      const allWritable = [...validColumns].filter(c => !SYSTEM_COLS.has(c));
      writeData = Object.fromEntries(
        allWritable.map(c => [c, cleanUpdates[c] ?? null])
      );
    } else {
      // patch — only what was provided
      if (Object.keys(cleanUpdates).length === 0) {
        return err(400, 'updates must have at least one non-system field', req.correlationId);
      }
      writeData = cleanUpdates;
    }

    const cols    = Object.keys(writeData);
    const vals    = serializeValues(Object.values(writeData));
    const setList = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');

    const pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      const result = await pgdClient.query(
        `UPDATE "${entity.root_table}" SET ${setList}, "updated_at" = now()
          WHERE id = $${cols.length + 1}
          RETURNING *`,
        [...vals, id]
      );

      if (result.rows.length === 0) {
        return err(404, `Entity "${entityName}" with id ${id} not found`, req.correlationId);
      }

      console.info(`entity: updated ${entityName} id=${id} mode=${mode}`);

      return ok({
        success:       true,
        entityName,
        id,
        mode,
        row:           result.rows[0],
        correlationId: req.correlationId,
      }, req.correlationId);

    } finally {
      await pgdClient.end();
    }

  } catch (error) {
    console.error('entity updateEntity error:', error.message);
    return err(500, `updateEntity failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/entity/upsertEntity
// ---------------------------------------------------------------------------

async function upsertEntity(req) {
  const { entityName, row } = req.body;

  if (!entityName) return err(400, 'entityName is required', req.correlationId);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return err(400, 'row must be a non-null object', req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();
    const { entity, validColumns, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;

    // Validate upsert_key defined and non-empty
    const upsertKey = entity.upsert_key;
    if (!Array.isArray(upsertKey) || upsertKey.length === 0) {
      return err(400, `upsert_key not defined for entity "${entityName}" — upsertEntity is not supported`, req.correlationId);
    }

    const cleanRow = stripSystemCols(row);
    const colError = validateColumns(cleanRow, validColumns, entityName);
    if (colError) return err(400, colError, req.correlationId);

    // Validate all upsert_key columns are present in the row
    for (const keyCol of upsertKey) {
      if (cleanRow[keyCol] === undefined) {
        return err(400, `upsert_key column "${keyCol}" must be present in row`, req.correlationId);
      }
    }

    const cols         = Object.keys(cleanRow);
    const vals         = serializeValues(Object.values(cleanRow));
    const colList      = cols.map(c => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const conflictCols = upsertKey.map(c => `"${c}"`).join(', ');

    // On conflict: update all non-key, non-system columns + refresh updated_at
    const updateCols   = cols.filter(c => !upsertKey.includes(c));
    const updateClause = updateCols.length
      ? updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ') + ', "updated_at" = now()'
      : '"updated_at" = now()';

    const pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      const result = await pgdClient.query(
        `INSERT INTO "${entity.root_table}" (${colList})
         VALUES (${placeholders})
         ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateClause}
         RETURNING *, (xmax = 0) AS was_inserted`,
        vals
      );

      // xmax = 0 means no previous version existed → it was a true INSERT
      const wasInserted = result.rows[0].was_inserted;
      const returnedRow = { ...result.rows[0] };
      delete returnedRow.was_inserted;

      console.info(`entity: upserted ${entityName} id=${returnedRow.id} wasInserted=${wasInserted}`);

      return ok({
        success:       true,
        entityName,
        wasInserted,
        row:           returnedRow,
        correlationId: req.correlationId,
      }, req.correlationId);

    } finally {
      await pgdClient.end();
    }

  } catch (error) {
    console.error('entity upsertEntity error:', error.message);
    return err(500, `upsertEntity failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/entity/deleteEntity
// ---------------------------------------------------------------------------

async function deleteEntity(req) {
  const { entityName, id } = req.body;

  if (!entityName) return err(400, 'entityName is required', req.correlationId);
  if (id === undefined || id === null) return err(400, 'id is required', req.correlationId);

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();
    const { entity, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;

    if (!entity.allow_delete) {
      return err(403, `DELETE not permitted on entity "${entityName}"`, req.correlationId);
    }

    const pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      // CASCADE on FK constraints handles all child rows automatically
      const result = await pgdClient.query(
        `DELETE FROM "${entity.root_table}" WHERE id = $1`,
        [id]
      );

      console.info(`entity: deleted ${entityName} id=${id} count=${result.rowCount}`);

      return ok({
        success:       true,
        entityName,
        id,
        deletedCount:  result.rowCount,
        correlationId: req.correlationId,
      }, req.correlationId);

    } finally {
      await pgdClient.end();
    }

  } catch (error) {
    console.error('entity deleteEntity error:', error.message);
    return err(500, `deleteEntity failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}
