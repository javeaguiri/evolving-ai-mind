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
//   POST /serv/entity/saveEntity    — a document's save: the root and its child tables' rows in one
//                                     transaction, checked against versions (row-writes.mjs)
//
// Security gates:
//   - entityName must be registered in PGC_EntitySchema
//   - Column names validated against PGC_Schema for the root_table
//   - allow_delete checked via PGC_TableMap for deleteEntity
//   - System columns (id, created_at, updated_at) excluded from all writes
//   - No raw SQL accepted in any field

import { ok, err }   from '../shared/lambda-utils.mjs';
import { getClient } from './init-brain.mjs';
import { normalizeOrderBy, buildOrderClause } from './query-utils.mjs';
import {
  isRecord, isVersion, checkRowWriteLists, checkChangeLog, writeCount, writtenRows, checkWriteColumns,
  refusedKind, findVersionConflicts, lockRows, writeRows, writeChangeLog, versionConflict,
} from './row-writes.mjs';

// System columns never written by callers
const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);

// pgvector columns come back as raw strings (no pg type parser registered).
// Strip them from results — embeddings are large and not useful to callers.
// Recurses into jsonb_agg aggregation arrays (nested child rows), not just
// the root row's own columns.
function stripVectors(value) {
  if (Array.isArray(value)) {
    return value.map(stripVectors);
  }
  if (value && typeof value === 'object') {
    const out = { ...value };
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && v.startsWith('[') && /^[-\d.,eE ]+/.test(v.slice(1, 20))) {
        delete out[k];
      } else if (v && typeof v === 'object') {
        out[k] = stripVectors(v);
      }
    }
    return out;
  }
  return value;
}

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
    case 'saveEntity':   return saveEntity(req);
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
function buildSelectSQL(tableName, joins = [], aggregations = [], extraCols = []) {
  const joinClauses = (joins || []).map(j =>
    `${j.type || 'LEFT'} JOIN "${j.table}" ${j.alias || j.table} ON ${j.on}`
  );

  const aggCols = (aggregations || []).map(a => {
    if (!a.columns?.length) {
      return `jsonb_agg(DISTINCT to_jsonb(${a.alias}.*))
              FILTER (WHERE ${a.alias}.id IS NOT NULL) AS "${a.outputKey}"`;
    }
    const cols = a.columns.map(c => `'${c}', ${a.alias}.${c}`).join(', ');
    return `jsonb_agg(DISTINCT jsonb_build_object(${cols}))
              FILTER (WHERE ${a.alias}.id IS NOT NULL) AS "${a.outputKey}"`;
  });

  const selectCols = ['r.*', ...extraCols, ...aggCols].join(',\n       ');
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
 * An entity's child tables: those of its joins whose registered foreign key references the root
 * table, each with the column that holds the parent's id. A join without one is not a child
 * collection. `tables` are PGC_Schema rows with their PGC_TableMap flags.
 * Pure — exported for test.
 */
export function childTablesOf(entity, tables) {
  const joined = new Set((entity.joins ?? []).map(j => j.table));
  return tables.filter(t => joined.has(t.table_name)).flatMap(t => {
    const fk = (t.foreign_keys ?? []).find(f => f.references?.table === entity.root_table);
    return fk ? [{ tableName: t.table_name, parentKey: fk.column, columns: t.columns, gate: t }] : [];
  });
}

async function loadChildTables(pgcClient, entity) {
  const joined = [...new Set((entity.joins ?? []).map(j => j.table))];
  if (joined.length === 0) return [];
  const result = await pgcClient.query(
    `SELECT s.table_name, s.columns, s.foreign_keys, tm.allow_insert, tm.allow_update, tm.allow_delete
       FROM "PGC_Schema"   s
       JOIN "PGC_TableMap" tm ON tm.table_name = s.table_name
      WHERE s.table_name = ANY($1)`,
    [joined]
  );
  return childTablesOf(entity, result.rows);
}

/** The first of an entity's root and child tables without updated_at — it has no versions. */
function unversionedTable(entity, children) {
  const has = cols => cols.some(c => c.name === 'updated_at');
  if (!has(entity.schema_columns)) return entity.root_table;
  return children.find(c => !has(c.columns))?.tableName ?? null;
}

/** The root row, with its aggregations and — withVersion — its `_version`; undefined when absent. */
async function readEntity(pgdClient, entity, id, withVersion) {
  const { sql } = buildSelectSQL(entity.root_table, entity.joins, entity.aggregations,
    withVersion ? ['r."updated_at"::text AS "_version"'] : []);
  const result = await pgdClient.query(
    `${sql} ${sql.includes('GROUP BY') ? 'HAVING r.id = $1' : 'WHERE r.id = $1'}`,
    [id]
  );
  return result.rows[0];
}

/** Each child table's rows of one entity, whole, with `_version`, by table name, ordered by id. */
async function readChildren(pgdClient, children, id) {
  const out = {};
  for (const c of children) {
    const result = await pgdClient.query(
      `SELECT *, "updated_at"::text AS "_version" FROM "${c.tableName}" WHERE "${c.parentKey}" = $1 ORDER BY "id"`,
      [id]
    );
    out[c.tableName] = stripVectors(result.rows);
  }
  return out;
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
  const { entityName, id, withVersion = false } = req.body;

  if (!entityName) return err(400, 'entityName is required', req.correlationId);
  if (id === undefined || id === null) return err(400, 'id is required', req.correlationId);

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();
    const { entity, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;

    // With versions, the document: the root's version and each child table's rows.
    const children = withVersion ? await loadChildTables(pgcClient, entity) : [];
    if (withVersion) {
      const unversioned = unversionedTable(entity, children);
      if (unversioned) return err(400, `withVersion needs an updated_at column — "${unversioned}" has none`, req.correlationId);
    }

    const pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      const row = await readEntity(pgdClient, entity, id, withVersion);
      if (!row) {
        return err(404, `Entity "${entityName}" with id ${id} not found`, req.correlationId);
      }

      return ok({
        success:       true,
        entityName,
        entity:        stripVectors(row),
        ...(withVersion ? { children: await readChildren(pgdClient, children, id) } : {}),
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

    const orderTerms = normalizeOrderBy(orderBy);
    const badTerm    = orderTerms.find(t => !validColumns.has(t.column));
    if (badTerm) {
      return err(400, `orderBy column "${badTerm.column}" not found in schema`, req.correlationId);
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
        case 'like':     conditions.push(`${col} ILIKE $${idx++}`);  values.push(`%${f.value}%`);  break;
        case 'in':       conditions.push(`${col} = ANY($${idx++})`); values.push(f.value);  break;
        case 'is_null':  conditions.push(`${col} IS NULL`);                                  break;
        case 'not_null': conditions.push(`${col} IS NOT NULL`);                              break;
      }
    }

    const whereOrHaving = conditions.length
      ? `${hasGroupBy ? 'HAVING' : 'WHERE'} ${conditions.join(' AND ')}`
      : '';

    const orderClause = buildOrderClause(orderTerms, 'r.');

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
        entities:      result.rows.map(stripVectors),
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
        row:           stripVectors(result.rows[0]),
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
        row:           stripVectors(result.rows[0]),
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
        row:           stripVectors(returnedRow),
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

// ---------------------------------------------------------------------------
// POST /serv/entity/saveEntity
//
// A document's save: the root's row and each child table's changed, new and removed rows in one
// transaction. Every row changed or removed — the root included — is locked and its version
// compared first. Any save touches the root's updated_at, so the root's version is the
// document's. SERV sets each new child row's parent key.
// ---------------------------------------------------------------------------

/**
 * The request's shape, before anything is read: an error string, or null. Without id and
 * version the entity is new: its root inserted whole, its children inserted only.
 * Pure — exported for test.
 */
export function checkEntityWrites(body) {
  const { entityName, id, version, root, children, changeLog } = body ?? {};
  if (typeof entityName !== 'string' || !entityName) return 'entityName is required';
  const isNew = id === undefined && version === undefined;
  if (!isNew) {
    if (!Number.isInteger(id)) return 'id must be an integer, sent with version — or both absent for a new entity';
    if (!isVersion(version)) return 'version must be the version the entity was read at (updated_at as text), sent with id — or both absent for a new entity';
  }
  if (root !== undefined && (!isRecord(root) || !isRecord(root.changes))) return 'root.changes must be an object';
  if (children !== undefined && !isRecord(children)) return 'children must be an object keyed by table name';
  for (const [table, writes] of Object.entries(children ?? {})) {
    if (!isRecord(writes)) return `children.${table} must be an object`;
    const listError = checkRowWriteLists(writes, `children.${table}.`);
    if (listError) return listError;
    if (isNew && (writes.update?.length || writes.delete?.length)) {
      return `children.${table}: a new entity's children can only be inserted`;
    }
  }
  const rootColumns = Object.keys(root?.changes ?? {}).length;
  if (isNew && rootColumns === 0) return 'root.changes is required for a new entity — its whole row';
  const childRows = Object.values(children ?? {}).reduce((n, w) => n + writeCount(w), 0);
  if (rootColumns + childRows === 0) return 'nothing to write — root.changes and children are empty';
  return checkChangeLog(changeLog);
}

async function saveEntity(req) {
  const shapeError = checkEntityWrites(req.body);
  if (shapeError) return err(400, shapeError, req.correlationId);

  const { entityName, id, version, root = {}, children: childWrites = {}, changeLog } = req.body;
  const isNew       = id === undefined;
  const rootChanges = root.changes ?? {};

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  let   pgdClient = null;

  try {
    await pgcClient.connect();
    const { entity, error } = await loadEntity(pgcClient, entityName, req.correlationId);
    if (error) return error;
    const rootTable = entity.root_table;

    const children = await loadChildTables(pgcClient, entity);
    const byTable  = new Map(children.map(c => [c.tableName, c]));
    const unknown  = Object.keys(childWrites).find(t => !byTable.has(t));
    if (unknown) return err(400, `"${unknown}" is not a child table of entity "${entityName}"`, req.correlationId);
    const unversioned = unversionedTable(entity, children);
    if (unversioned) return err(400, `"${unversioned}" has no updated_at column — it accepts no versioned writes`, req.correlationId);

    // --- Gates: the root is inserted, or updated (a save of children only touches it) ---
    if (isNew ? !entity.allow_insert : !entity.allow_update) {
      return err(403, `${isNew ? 'INSERT' : 'UPDATE'} not permitted on "${rootTable}"`, req.correlationId);
    }
    for (const [table, writes] of Object.entries(childWrites)) {
      const refused = refusedKind(writes, byTable.get(table).gate);
      if (refused) return err(403, `${refused} not permitted on "${table}"`, req.correlationId);
    }

    // --- Columns: the root's, and each child's, which never names its parent ---
    const rootError = checkWriteColumns(rootTable, [['root.changes', rootChanges]], entity.schema_columns);
    if (rootError) return err(400, rootError, req.correlationId);
    for (const [table, writes] of Object.entries(childWrites)) {
      const { parentKey, columns } = byTable.get(table);
      const rows       = writtenRows(writes, `children.${table}.`);
      const childError = checkWriteColumns(table, rows, columns);
      if (childError) return err(400, childError, req.correlationId);
      const naming = rows.find(([, row]) => parentKey in row);
      if (naming) return err(400, `${naming[0]}: "${parentKey}" is set by SERV — a child row never names its parent`, req.correlationId);
    }

    pgdClient = getClient(process.env.PGD_DATABASE_URL);
    await pgdClient.connect();

    try {
      await pgdClient.query('BEGIN');

      // --- Lock the root and every child row to change or remove; compare versions ---
      let   rootId      = id;
      const rootCurrent = isNew ? new Map() : await lockRows(pgdClient, rootTable, [id]);
      if (!isNew && !rootCurrent.has(id)) {
        await pgdClient.query('ROLLBACK');
        return err(404, `Entity "${entityName}" with id ${id} not found`, req.correlationId);
      }
      const conflicts    = isNew ? [] : findVersionConflicts(rootTable, [{ id, version }], rootCurrent);
      const childCurrent = new Map();
      const foreign      = [];
      for (const [table, writes] of Object.entries(childWrites)) {
        const { parentKey } = byTable.get(table);
        const claimed = [...(writes.update ?? []), ...(writes.delete ?? [])];
        const current = await lockRows(pgdClient, table, claimed.map(r => r.id));
        childCurrent.set(table, current);
        const theirs  = claimed.filter(r => current.has(r.id) && current.get(r.id).row[parentKey] !== rootId);
        foreign.push(...theirs.map(r => `${table} ${r.id}`));
        conflicts.push(...findVersionConflicts(table, claimed.filter(r => !theirs.includes(r)), current));
      }
      if (foreign.length > 0) {
        await pgdClient.query('ROLLBACK');
        return err(404, `Not rows of ${entityName} ${id}: ${foreign.join(', ')}`, req.correlationId);
      }
      if (conflicts.length > 0) {
        await pgdClient.query('ROLLBACK');
        console.info(`entity saveEntity: version conflict on ${entityName} ${id}`, { conflicts });
        return versionConflict(conflicts, req.correlationId);
      }

      // --- The root: inserted, changed, or touched so its version moves with the document ---
      const log  = [];
      const base = { tableName: rootTable, schemaColumns: entity.schema_columns, correlationId: req.correlationId };
      if (isNew) {
        const written = await writeRows(pgdClient, { ...base, writes: { insert: [rootChanges] }, current: rootCurrent });
        rootId = written.inserted[0].id;
        log.push(...written.log);
      } else if (Object.keys(rootChanges).length > 0) {
        const written = await writeRows(pgdClient, { ...base, writes: { update: [{ id, version, changes: rootChanges }] }, current: rootCurrent });
        log.push(...written.log);
      } else {
        await pgdClient.query(`UPDATE "${rootTable}" SET "updated_at" = now() WHERE "id" = $1`, [id]);
      }

      // --- The children, each new row given its parent ---
      for (const [table, writes] of Object.entries(childWrites)) {
        const { parentKey, columns } = byTable.get(table);
        const written = await writeRows(pgdClient, {
          tableName: table, schemaColumns: columns, writes, current: childCurrent.get(table),
          setOnInsert: { [parentKey]: rootId }, correlationId: req.correlationId,
        });
        log.push(...written.log);
      }

      const batchId = await writeChangeLog(pgdClient, changeLog, log);

      // Read back inside the transaction: a failed read leaves nothing half-reported as saved.
      const saved    = await readEntity(pgdClient, entity, rootId, true);
      const document = await readChildren(pgdClient, children, rootId);

      await pgdClient.query('COMMIT');

      console.info(`entity: saved ${entityName} id=${rootId}${isNew ? ' (new)' : ''}`);
      return ok({
        success:       true,
        entityName,
        ...(batchId ? { batchId } : {}),
        entity:        stripVectors(saved),
        children:      document,
        correlationId: req.correlationId,
      }, req.correlationId);
    } catch (innerError) {
      await pgdClient.query('ROLLBACK');
      throw innerError;
    }

  } catch (error) {
    console.error('entity saveEntity error:', error.message);
    return err(500, `saveEntity failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient?.end();
    await pgcClient.end();
  }
}
