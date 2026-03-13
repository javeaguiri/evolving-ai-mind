// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/schema.mjs
// Handles /api/v1/serv/schema/* routes.
//
// SERV-Schema is the DDL executor and PGC metadata registry.
// It creates/alters/drops tables and keeps PGC_Schema in sync.
//
// Routes:
//   POST   /serv/schema/createTable   — build DDL from JSON + register in PGC_Schema
//   POST   /serv/schema/listTables    — list all entries in PGC_Schema
//   POST   /serv/schema/getTable      — get one entry by table_name
//   POST   /serv/schema/updateTable   — update description/definition in PGC_Schema
//   POST   /serv/schema/deleteTable   — drop table + remove from PGC_Schema
//
// Security gate: all table names and column types are validated before any
// SQL is executed. Raw SQL in payloads is rejected.
//
// UI notification: SERV is UI-agnostic. Slack callbacks are owned by PROC.
// SERV never reads slackChannel / slackThreadTs — those fields are ignored
// even if present in a request body.

import { ok, err }                        from '../shared/ping-utils.mjs';
import { getClient, buildCreateTableSQL } from './init-brain.mjs';

// ---------------------------------------------------------------------------
// Allowed PostgreSQL column types — security gate.
// Reject anything not on this list before touching the DB.
// ---------------------------------------------------------------------------
const ALLOWED_TYPES = new Set([
  'serial', 'bigserial',
  'text', 'varchar',
  'integer', 'bigint', 'smallint',
  'boolean',
  'numeric', 'decimal', 'real', 'double precision',
  'jsonb', 'json',
  'timestamptz', 'timestamp', 'date', 'time',
  'uuid',
]);

// Allowed table name pattern — PGC_* system tables, PGD_* user domain tables
const TABLE_NAME_PATTERN = /^(PGC|PGD)_[A-Za-z][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('../shared/ping-utils.mjs').parseEvent>} req
 */
export async function handle(req) {
  switch (req.subRoute) {
    case 'createTable': return createTable(req);
    case 'listTables':  return listTables(req);
    case 'getTable':    return getTable(req);
    case 'updateTable': return updateTable(req);
    case 'deleteTable': return deleteTable(req);
    default:
      return err(404, `SERV-Schema route "${req.subRoute}" not found`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/createTable
// ---------------------------------------------------------------------------

async function createTable(req) {
  const {
    tableName, target,
    columns, foreignKeys = [], constraints = [],
    triggers = [], description = '',
  } = req.body;

  // --- Validate ---
  const validationError = validateCreatePayload({ tableName, target, columns });
  if (validationError) {
    return err(400, validationError, req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);
  const pgdClient = target === 'pgd' ? getClient(process.env.PGD_DATABASE_URL) : null;

  try {
    await pgcClient.connect();
    if (pgdClient) await pgdClient.connect();

    // --- Check for duplicate ---
    const exists = await pgcClient.query(
      `SELECT id FROM "PGC_Schema" WHERE table_name = $1`,
      [tableName]
    );
    if (exists.rows.length > 0) {
      return err(409, `Table "${tableName}" already exists in PGC_Schema`, req.correlationId);
    }

    // --- Build and execute DDL ---
    const template = { table_name: tableName, columns, foreign_keys: foreignKeys,
                       constraints, triggers };
    const ddl      = buildCreateTableSQL(template);
    const dbClient = target === 'pgd' ? pgdClient : pgcClient;

    await dbClient.query(ddl.createTable);
    for (const triggerSQL of ddl.triggers) {
      await dbClient.query(triggerSQL);
    }
    console.info(`schema: DDL executed for ${tableName} on ${target.toUpperCase()}`);

    // --- Register in PGC_Schema ---
    const insert = await pgcClient.query(
      `INSERT INTO "PGC_Schema"
         (table_name, target, description, columns, foreign_keys, constraints, triggers)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        tableName, target, description,
        JSON.stringify(columns),
        JSON.stringify(foreignKeys),
        JSON.stringify(constraints),
        JSON.stringify(triggers),
      ]
    );
    console.info(`schema: PGC_Schema row inserted for ${tableName}`);

    // --- Register in PGC_TableMap ---
    await pgcClient.query(
      `INSERT INTO "PGC_TableMap"
         (table_name, target, schema_id, allow_insert, allow_update, allow_delete)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tableName, target, insert.rows[0].id, true, true, false]
    );
    console.info(`schema: PGC_TableMap row inserted for ${tableName}`);

    return ok({
      success:       true,
      tableName,
      target,
      schemaId:   insert.rows[0].id,
      createdAt:  insert.rows[0].created_at,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('schema createTable error:', error.message);
    return err(500, `createTable failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
    if (pgdClient) await pgdClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/listTables
// ---------------------------------------------------------------------------

async function listTables(req) {
  const { target } = req.body;   // optional filter — 'pgc', 'pgd', or omit for all
  const client = getClient(process.env.PGC_DATABASE_URL);

  try {
    await client.connect();

    const query = target
      ? `SELECT id, table_name, target, description, created_at, updated_at
           FROM "PGC_Schema" WHERE target = $1 ORDER BY table_name`
      : `SELECT id, table_name, target, description, created_at, updated_at
           FROM "PGC_Schema" ORDER BY target, table_name`;

    const result = await client.query(query, target ? [target] : []);

    return ok({
      success: true,
      count:   result.rows.length,
      tables:  result.rows,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('schema listTables error:', error.message);
    return err(500, `listTables failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/getTable
// ---------------------------------------------------------------------------

async function getTable(req) {
  const { tableName } = req.body;
  if (!tableName) {
    return err(400, 'tableName is required', req.correlationId);
  }

  const client = getClient(process.env.PGC_DATABASE_URL);

  try {
    await client.connect();

    const result = await client.query(
      `SELECT * FROM "PGC_Schema" WHERE table_name = $1`,
      [tableName]
    );

    if (result.rows.length === 0) {
      return err(404, `Table "${tableName}" not found in PGC_Schema`, req.correlationId);
    }

    return ok({
      success: true,
      schema:  result.rows[0],
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('schema getTable error:', error.message);
    return err(500, `getTable failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/updateTable
// ---------------------------------------------------------------------------

async function updateTable(req) {
  const {
    tableName, description, columns,
    foreignKeys, constraints, triggers,
  } = req.body;

  if (!tableName) {
    return err(400, 'tableName is required', req.correlationId);
  }

  const client = getClient(process.env.PGC_DATABASE_URL);

  try {
    await client.connect();

    // Build SET clause dynamically — only update fields that were provided
    const updates = [];
    const values  = [];
    let   idx     = 1;

    if (description !== undefined) { updates.push(`description = $${idx++}`);  values.push(description); }
    if (columns      !== undefined) { updates.push(`columns = $${idx++}`);      values.push(JSON.stringify(columns)); }
    if (foreignKeys  !== undefined) { updates.push(`foreign_keys = $${idx++}`); values.push(JSON.stringify(foreignKeys)); }
    if (constraints  !== undefined) { updates.push(`constraints = $${idx++}`);  values.push(JSON.stringify(constraints)); }
    if (triggers     !== undefined) { updates.push(`triggers = $${idx++}`);     values.push(JSON.stringify(triggers)); }

    if (updates.length === 0) {
      return err(400, 'No updatable fields provided', req.correlationId);
    }

    updates.push(`updated_at = now()`);
    values.push(tableName);

    const result = await client.query(
      `UPDATE "PGC_Schema" SET ${updates.join(', ')}
       WHERE table_name = $${idx}
       RETURNING id, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return err(404, `Table "${tableName}" not found in PGC_Schema`, req.correlationId);
    }

    return ok({
      success:   true,
      tableName,
      updatedAt: result.rows[0].updated_at,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('schema updateTable error:', error.message);
    return err(500, `updateTable failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/deleteTable
// ---------------------------------------------------------------------------

async function deleteTable(req) {
  const { tableName } = req.body;

  if (!tableName) {
    return err(400, 'tableName is required', req.correlationId);
  }

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    return err(400, `Invalid table name "${tableName}"`, req.correlationId);
  }

  // Safety guard — never drop PGC system tables via this endpoint
  const PROTECTED = new Set(['PGC_Schema', 'PGC_TableMap', 'PGC_EntitySchema', 'PGC_DomainHelp']);
  if (PROTECTED.has(tableName)) {
    return err(403, `Table "${tableName}" is a protected system table`, req.correlationId);
  }

  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgcClient.connect();

    // Look up target so we know which DB to drop from
    const lookup = await pgcClient.query(
      `SELECT id, target FROM "PGC_Schema" WHERE table_name = $1`,
      [tableName]
    );
    if (lookup.rows.length === 0) {
      return err(404, `Table "${tableName}" not found in PGC_Schema`, req.correlationId);
    }

    const { id, target } = lookup.rows[0];
    const dropClient     = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dropClient.connect();

    // Drop the physical table
    await dropClient.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
    console.info(`schema: dropped table ${tableName} from ${target.toUpperCase()}`);

    // Remove from PGC_TableMap first (FK constraint)
    await pgcClient.query(`DELETE FROM "PGC_TableMap" WHERE schema_id = $1`, [id]);

    // Remove from PGC_Schema
    await pgcClient.query(`DELETE FROM "PGC_Schema" WHERE id = $1`, [id]);
    console.info(`schema: PGC_Schema + PGC_TableMap rows removed for ${tableName}`);

    return ok({
      success:   true,
      tableName,
      dropped:   true,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('schema deleteTable error:', error.message);
    return err(500, `deleteTable failed: ${error.message}`, req.correlationId);
  } finally {
    await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// Security validation
// ---------------------------------------------------------------------------

function validateCreatePayload({ tableName, target, columns }) {
  if (!tableName)              return 'tableName is required';
  if (!target)                 return 'target is required (pgc or pgd)';
  if (!columns?.length)        return 'columns array is required and must not be empty';

  if (!['pgc', 'pgd'].includes(target)) {
    return `target must be "pgc" or "pgd", got "${target}"`;
  }

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    return `Invalid table name "${tableName}" — must match PGC_* or PGD_* pattern`;
  }

  for (const col of columns) {
    if (!col.name || !col.type) {
      return `Each column must have name and type`;
    }
    if (!ALLOWED_TYPES.has(col.type.toLowerCase())) {
      return `Column type "${col.type}" is not allowed — rejected for security`;
    }
  }

  return null;  // valid
}
