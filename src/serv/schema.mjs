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
//   POST   /serv/schema/createTable      — build DDL from JSON + register in PGC_Schema
//   POST   /serv/schema/addColumn        — ALTER TABLE ... ADD COLUMN + PGC_Schema sync
//   POST   /serv/schema/modifyColumn     — ALTER TABLE ... ALTER COLUMN TYPE + PGC_Schema sync
//   POST   /serv/schema/dropColumn       — ALTER TABLE ... DROP COLUMN CASCADE + PGC_Schema sync
//   POST   /serv/schema/modifyConstraint — DROP + ADD CONSTRAINT + PGC_Schema sync
//   POST   /serv/schema/listTables          — list all entries in PGC_Schema
//   POST   /serv/schema/listPhysicalTables  — list physical tables from DB catalog (registered/orphaned)
//   POST   /serv/schema/getTable            — get one entry by table_name
//   POST   /serv/schema/updateTable         — update description/definition in PGC_Schema
//   POST   /serv/schema/deleteTable         — drop table + remove from PGC_Schema (force:true skips PGC_Schema check)
//
// Security gate: all table names and column types are validated before any
// SQL is executed. Raw SQL in payloads is rejected.
//
// UI notification: SERV is UI-agnostic. Slack callbacks are owned by PROC.
// SERV never reads slackChannel / slackThreadTs — those fields are ignored
// even if present in a request body.

import { ok, err }                        from '../shared/lambda-utils.mjs';
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
  'vector',
]);

// Allowed table name pattern — PGC_* system tables, PGD_* user domain tables
const TABLE_NAME_PATTERN = /^(PGC|PGD)_[A-Za-z][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('../shared/lambda-utils.mjs').parseEvent>} req
 */
export async function handle(req) {
  switch (req.subRoute) {
    case 'createTable': return createTable(req);
    case 'addColumn':    return addColumn(req);
    case 'modifyColumn': return modifyColumn(req);
    case 'dropColumn':   return dropColumn(req);
    case 'listTables':          return listTables(req);
    case 'listPhysicalTables':  return listPhysicalTables(req);
    case 'getTable':    return getTable(req);
    case 'updateTable':      return updateTable(req);
    case 'modifyConstraint': return modifyConstraint(req);
    case 'dropConstraint':   return dropConstraint(req);
    case 'deleteTable':      return deleteTable(req);
    default:
      return err(404, `SERV-Schema route "${req.subRoute}" not found`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/createTable
// ---------------------------------------------------------------------------

async function createTable(req) {
  const {
    tableName, target, domain = null,
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

    // Auto-infer embed_source for vector columns named X_embedding where column X exists.
    const allColNames = new Set(columns.map(c => c.name));
    const registeredColumns = columns.map(c => {
      if (c.type?.startsWith('vector') && typeof c.name === 'string' &&
          c.name.endsWith('_embedding') && !Array.isArray(c.embed_source)) {
        const src = c.name.slice(0, -'_embedding'.length);
        if (allColNames.has(src)) return { ...c, embed_source: [src] };
      }
      return c;
    });

    // --- Register in PGC_Schema ---
    const insert = await pgcClient.query(
      `INSERT INTO "PGC_Schema"
         (table_name, target, domain, description, columns, foreign_keys, constraints, triggers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        tableName, target, domain, description,
        JSON.stringify(registeredColumns),
        JSON.stringify(foreignKeys),
        JSON.stringify(constraints),
        JSON.stringify(triggers),
      ]
    );
    console.info(`schema: PGC_Schema row inserted for ${tableName}`);

    // --- Register in PGC_TableMap ---
    await pgcClient.query(
      `INSERT INTO "PGC_TableMap"
         (table_name, target, domain, schema_id, allow_insert, allow_update, allow_delete)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tableName, target, domain, insert.rows[0].id, true, true, target === 'pgd']
    );
    console.info(`schema: PGC_TableMap row inserted for ${tableName}`);

    return ok({
      success:       true,
      tableName,
      target,
      domain,
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
// POST /serv/schema/addColumn
// ---------------------------------------------------------------------------

async function addColumn(req) {
  const { tableName, column, schemaOnly = false } = req.body;

  if (!tableName) return err(400, 'tableName is required', req.correlationId);
  if (!column)    return err(400, 'column is required', req.correlationId);

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    return err(400, `Invalid table name "${tableName}"`, req.correlationId);
  }

  const { name: colName, type: colType, nullable = true } = column;

  if (!colName || !/^[a-z][a-z0-9_]*$/.test(colName)) {
    return err(400, `Invalid column name "${colName}" — must be lowercase alphanumeric + underscore`, req.correlationId);
  }
  if (!colType || !ALLOWED_TYPES.has(colType.toLowerCase().split('(')[0].trim())) {
    return err(400, `Column type "${colType}" is not allowed`, req.correlationId);
  }

  const client = getClient(process.env.PGC_DATABASE_URL);

  try {
    await client.connect();

    // Look up PGC_Schema row to get target and existing columns
    const lookup = await client.query(
      `SELECT id, target, columns FROM "PGC_Schema" WHERE table_name = $1`,
      [tableName]
    );
    if (lookup.rows.length === 0) {
      return err(404, `Table "${tableName}" not found in PGC_Schema`, req.correlationId);
    }

    const { id: schemaId, target, columns: existingCols } = lookup.rows[0];
    const colsArray = Array.isArray(existingCols) ? existingCols : [];

    // Check if already registered in PGC_Schema metadata
    if (colsArray.some(c => c.name === colName)) {
      return ok({ success: true, tableName, column: colName, action: 'already_exists' }, req.correlationId);
    }

    // Execute DDL unless schemaOnly is true (column already exists physically)
    if (!schemaOnly) {
      const nullStr   = nullable ? '' : ' NOT NULL';
      const ddlClient = target === 'pgd' ? getClient(process.env.PGD_DATABASE_URL) : client;
      if (target === 'pgd') await ddlClient.connect();

      await ddlClient.query(
        `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${colName}" ${colType}${nullStr}`
      );
      console.info(`schema: added column ${colName} to ${tableName} on ${target.toUpperCase()}`);

      if (target === 'pgd') await ddlClient.end();
    } else {
      console.info(`schema: schemaOnly mode — skipping DDL for ${colName} on ${tableName}`);
    }

    // Register in PGC_Schema.columns
    // Preserve explicit embed_source; infer it for X_embedding vector columns when omitted.
    const newCol = { name: colName, type: colType, nullable };
    if (Array.isArray(column.embed_source) && column.embed_source.length > 0) {
      newCol.embed_source = column.embed_source;
    } else if (colType?.startsWith('vector') && colName.endsWith('_embedding')) {
      const src = colName.slice(0, -'_embedding'.length);
      if (colsArray.some(c => c.name === src)) newCol.embed_source = [src];
    }
    await client.query(
      `UPDATE "PGC_Schema"
          SET columns    = columns || $1::jsonb,
              updated_at = now()
        WHERE id = $2`,
      [JSON.stringify([newCol]), schemaId]
    );
    console.info(`schema: PGC_Schema.columns updated for ${tableName} — added ${colName}`);

    return ok({
      success:    true,
      tableName,
      column:     colName,
      action:     schemaOnly ? 'schema_registered' : 'added',
    }, req.correlationId);

  } catch (error) {
    console.error('schema addColumn error:', error.message);
    return err(500, `addColumn failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/modifyColumn
// ---------------------------------------------------------------------------

async function modifyColumn(req) {
  const { tableName, columnName, newType, nullable, using: usingExpr = null } = req.body;

  if (!tableName)  return err(400, 'tableName is required',  req.correlationId);
  if (!columnName) return err(400, 'columnName is required', req.correlationId);
  if (!newType && nullable === undefined) {
    return err(400, 'newType or nullable is required', req.correlationId);
  }

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    return err(400, `Invalid table name "${tableName}"`, req.correlationId);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(columnName)) {
    return err(400, `Invalid column name "${columnName}" — must be lowercase alphanumeric + underscore`, req.correlationId);
  }
  if (newType && !ALLOWED_TYPES.has(newType.toLowerCase().split('(')[0].trim())) {
    return err(400, `Column type "${newType}" is not allowed`, req.correlationId);
  }
  if (usingExpr && !/^[a-z][a-z0-9_]*::[a-z][a-z0-9\s]*$/.test(usingExpr)) {
    return err(400, 'USING expression must be in the form "columnName::type"', req.correlationId);
  }

  const client = getClient(process.env.PGC_DATABASE_URL);

  try {
    await client.connect();

    const lookup = await client.query(
      `SELECT id, target, columns FROM "PGC_Schema" WHERE table_name = $1`,
      [tableName]
    );
    if (lookup.rows.length === 0) {
      return err(404, `Table "${tableName}" not found in PGC_Schema`, req.correlationId);
    }

    const { id: schemaId, target, columns: existingCols } = lookup.rows[0];
    const colsArray = Array.isArray(existingCols) ? existingCols : [];

    if (!colsArray.some(c => c.name === columnName)) {
      return err(404, `Column "${columnName}" not found in PGC_Schema for "${tableName}"`, req.correlationId);
    }

    const ddlClient = target === 'pgd' ? getClient(process.env.PGD_DATABASE_URL) : client;
    if (target === 'pgd') await ddlClient.connect();

    if (newType) {
      const usingClause = usingExpr ? ` USING ${usingExpr}` : '';
      await ddlClient.query(
        `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" TYPE ${newType}${usingClause}`
      );
      console.info(`schema: modified column ${columnName} on ${tableName} — type now ${newType}`);
    }

    if (nullable !== undefined) {
      const nullOp = nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
      await ddlClient.query(
        `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" ${nullOp}`
      );
      console.info(`schema: modified column ${columnName} on ${tableName} — nullable now ${nullable}`);
    }

    if (target === 'pgd') await ddlClient.end();

    const updatedCols = colsArray.map(c => {
      if (c.name !== columnName) return c;
      const updated = { ...c };
      if (newType) updated.type = newType;
      if (nullable !== undefined) updated.nullable = nullable;
      return updated;
    });
    await client.query(
      `UPDATE "PGC_Schema" SET columns = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(updatedCols), schemaId]
    );

    return ok({ success: true, tableName, column: columnName, newType, nullable, action: 'modified' }, req.correlationId);

  } catch (error) {
    console.error('schema modifyColumn error:', error.message);
    return err(500, `modifyColumn failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/dropColumn
// ---------------------------------------------------------------------------

async function dropColumn(req) {
  const { tableName, columnName } = req.body;

  if (!tableName)  return err(400, 'tableName is required',  req.correlationId);
  if (!columnName) return err(400, 'columnName is required', req.correlationId);

  if (!TABLE_NAME_PATTERN.test(tableName)) {
    return err(400, `Invalid table name "${tableName}"`, req.correlationId);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(columnName)) {
    return err(400, `Invalid column name "${columnName}" — must be lowercase alphanumeric + underscore`, req.correlationId);
  }

  const client = getClient(process.env.PGC_DATABASE_URL);

  try {
    await client.connect();

    const lookup = await client.query(
      `SELECT id, target, columns FROM "PGC_Schema" WHERE table_name = $1`,
      [tableName]
    );
    if (lookup.rows.length === 0) {
      return err(404, `Table "${tableName}" not found in PGC_Schema`, req.correlationId);
    }

    const { id: schemaId, target, columns: existingCols } = lookup.rows[0];
    const colsArray = Array.isArray(existingCols) ? existingCols : [];

    if (!colsArray.some(c => c.name === columnName)) {
      return ok({ success: true, tableName, column: columnName, action: 'not_in_schema' }, req.correlationId);
    }

    const ddlClient = target === 'pgd' ? getClient(process.env.PGD_DATABASE_URL) : client;
    if (target === 'pgd') await ddlClient.connect();

    await ddlClient.query(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${columnName}" CASCADE`);
    console.info(`schema: dropped column ${columnName} from ${tableName}`);

    if (target === 'pgd') await ddlClient.end();

    const updatedCols = colsArray.filter(c => c.name !== columnName);
    await client.query(
      `UPDATE "PGC_Schema" SET columns = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(updatedCols), schemaId]
    );

    return ok({ success: true, tableName, column: columnName, action: 'dropped' }, req.correlationId);

  } catch (error) {
    console.error('schema dropColumn error:', error.message);
    return err(500, `dropColumn failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
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
      ? `SELECT id, table_name, target, domain, description, created_at, updated_at
           FROM "PGC_Schema" WHERE target = $1 ORDER BY table_name`
      : `SELECT id, table_name, target, domain, description, created_at, updated_at
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
// POST /serv/schema/listPhysicalTables
// ---------------------------------------------------------------------------

async function listPhysicalTables(req) {
  const { prefix = 'PGD_' } = req.body ?? {};

  const pgdClient = getClient(process.env.PGD_DATABASE_URL);
  const pgcClient = getClient(process.env.PGC_DATABASE_URL);

  try {
    await pgdClient.connect();
    await pgcClient.connect();

    const physicalResult = await pgdClient.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE $1
       ORDER BY table_name`,
      [`${prefix}%`]
    );

    const tableNames = physicalResult.rows.map(r => r.table_name);
    let registeredSet = new Set();
    if (tableNames.length > 0) {
      const regResult = await pgcClient.query(
        `SELECT table_name FROM "PGC_Schema" WHERE table_name = ANY($1::text[])`,
        [tableNames]
      );
      registeredSet = new Set(regResult.rows.map(r => r.table_name));
    }

    const tables = tableNames.map(name => ({
      table_name:  name,
      registered:  registeredSet.has(name),
    }));

    return ok({
      success: true,
      count:   tables.length,
      tables,
      correlationId: req.correlationId,
    }, req.correlationId);

  } catch (error) {
    console.error('schema listPhysicalTables error:', error.message);
    return err(500, `listPhysicalTables failed: ${error.message}`, req.correlationId);
  } finally {
    await pgdClient.end();
    await pgcClient.end();
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
// POST /serv/schema/modifyConstraint
// Drops an existing named constraint and replaces it with a new CHECK expression.
// Updates PGC_Schema metadata to match. Use when a CHECK constraint's expression
// needs to change (e.g. adding a new allowed value to an IN list).
// ---------------------------------------------------------------------------

async function modifyConstraint(req) {
  const { tableName, constraintName, expression, target = 'pgc' } = req.body;

  if (!tableName || !constraintName || !expression) {
    return err(400, 'tableName, constraintName, and expression are required', req.correlationId);
  }
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    return err(400, `Invalid table name "${tableName}"`, req.correlationId);
  }

  const dbUrl  = target === 'pgd' ? process.env.PGD_DATABASE_URL : process.env.PGC_DATABASE_URL;
  const pgcUrl = process.env.PGC_DATABASE_URL;

  const dbClient  = getClient(dbUrl);
  const pgcClient = dbUrl === pgcUrl ? dbClient : getClient(pgcUrl);

  try {
    await dbClient.connect();
    if (dbClient !== pgcClient) await pgcClient.connect();

    await dbClient.query(
      `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${constraintName}"`
    );
    await dbClient.query(
      `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" CHECK (${expression})`
    );

    // Update PGC_Schema constraints field
    const schemaRow = await pgcClient.query(
      `SELECT constraints FROM "PGC_Schema" WHERE table_name = $1`, [tableName]
    );
    if (schemaRow.rows.length > 0) {
      const existing = schemaRow.rows[0].constraints ?? [];
      const updated  = existing.map(c =>
        c.name === constraintName ? { ...c, expression } : c
      );
      await pgcClient.query(
        `UPDATE "PGC_Schema" SET constraints = $1, updated_at = now() WHERE table_name = $2`,
        [JSON.stringify(updated), tableName]
      );
    }

    console.info(`schema: constraint "${constraintName}" on "${tableName}" updated`);
    return ok({ success: true, tableName, constraintName, expression }, req.correlationId);

  } catch (error) {
    console.error('schema modifyConstraint error:', error.message);
    return err(500, `modifyConstraint failed: ${error.message}`, req.correlationId);
  } finally {
    await dbClient.end();
    if (dbClient !== pgcClient) await pgcClient.end();
  }
}

// ---------------------------------------------------------------------------
// POST /serv/schema/dropConstraint
// Drops a named constraint from the physical table and removes it from
// PGC_Schema.constraints. Supports any constraint type (unique, check, fk).
// ---------------------------------------------------------------------------

async function dropConstraint(req) {
  const { tableName, constraintName, target = 'pgc' } = req.body;

  if (!tableName || !constraintName) {
    return err(400, 'tableName and constraintName are required', req.correlationId);
  }
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    return err(400, `Invalid table name "${tableName}"`, req.correlationId);
  }

  const dbUrl  = target === 'pgd' ? process.env.PGD_DATABASE_URL : process.env.PGC_DATABASE_URL;
  const pgcUrl = process.env.PGC_DATABASE_URL;

  const dbClient  = getClient(dbUrl);
  const pgcClient = dbUrl === pgcUrl ? dbClient : getClient(pgcUrl);

  try {
    await dbClient.connect();
    if (dbClient !== pgcClient) await pgcClient.connect();

    await dbClient.query(
      `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${constraintName}"`
    );

    const schemaRow = await pgcClient.query(
      `SELECT constraints FROM "PGC_Schema" WHERE table_name = $1`, [tableName]
    );
    if (schemaRow.rows.length > 0) {
      const existing = schemaRow.rows[0].constraints ?? [];
      const updated  = existing.filter(c => c.name !== constraintName);
      await pgcClient.query(
        `UPDATE "PGC_Schema" SET constraints = $1, updated_at = now() WHERE table_name = $2`,
        [JSON.stringify(updated), tableName]
      );
    }

    console.info(`schema: constraint "${constraintName}" on "${tableName}" dropped`);
    return ok({ success: true, tableName, constraintName }, req.correlationId);

  } catch (error) {
    console.error('schema dropConstraint error:', error.message);
    return err(500, `dropConstraint failed: ${error.message}`, req.correlationId);
  } finally {
    await dbClient.end();
    if (dbClient !== pgcClient) await pgcClient.end();
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
  const { tableName, force = false } = req.body;

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

    // Look up PGC_Schema row to determine target DB and enable cleanup.
    // force=true allows dropping tables that are not yet registered (e.g. orphaned
    // from a failed create_domain run that never wrote the PGC_Schema row).
    const lookup = await pgcClient.query(
      `SELECT id, target FROM "PGC_Schema" WHERE table_name = $1`,
      [tableName]
    );

    if (lookup.rows.length === 0 && !force) {
      return err(404, `Table "${tableName}" not found in PGC_Schema`, req.correlationId);
    }

    const schemaRow  = lookup.rows[0] ?? null;
    const target     = schemaRow?.target ?? 'pgd';
    const schemaId   = schemaRow?.id     ?? null;
    const dropClient = target === 'pgd'
      ? getClient(process.env.PGD_DATABASE_URL)
      : pgcClient;

    if (target === 'pgd') await dropClient.connect();

    // Drop the physical table
    await dropClient.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
    console.info(`schema: dropped table ${tableName} from ${target.toUpperCase()}${force && !schemaRow ? ' (force — no PGC_Schema row)' : ''}`);

    // Best-effort cleanup of PGC_Schema + PGC_TableMap (may not exist when force=true)
    if (schemaId) {
      await pgcClient.query(`DELETE FROM "PGC_TableMap" WHERE schema_id = $1`, [schemaId]);
      await pgcClient.query(`DELETE FROM "PGC_Schema" WHERE id = $1`, [schemaId]);
      console.info(`schema: PGC_Schema + PGC_TableMap rows removed for ${tableName}`);
    }

    return ok({
      success:   true,
      tableName,
      dropped:   true,
      forced:    force && !schemaRow,
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
    if (!ALLOWED_TYPES.has(col.type.toLowerCase().split('(')[0].trim())) {
      return `Column type "${col.type}" is not allowed — rejected for security`;
    }
  }

  return null;  // valid
}
