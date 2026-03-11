// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/init-brain.mjs
// PostgreSQL client factory and PGC bootstrap.
//
// Responsibilities:
//   1. Provide getClient(url) — opens a pg.Client with standard SSL config.
//   2. On cold start, bootstrap() ensures all PGC system tables exist.
//      Reads src/serv/templates/pgc/*.json → buildCreateTableSQL() → CREATE TABLE IF NOT EXISTS.
//      Safe to call on every Lambda invocation — IF NOT EXISTS makes it idempotent.
//
// Called by: schema.mjs (and future table.mjs, query.mjs, entity.mjs)
// Never throws — returns { ok, error } so callers can decide how to handle failures.

import pg           from 'pg';
import { readFile } from 'fs/promises';
import { join }     from 'path';
import { fileURLToPath } from 'url';

const { Client } = pg;
const __dirname  = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// SSL config — rejectUnauthorized: false accepts RDS self-signed cert.
// Lambda connects over public internet — no VPC, no NAT Gateway.
// ---------------------------------------------------------------------------
const SSL_CONFIG = { rejectUnauthorized: false };

// ---------------------------------------------------------------------------
// Bootstrap state — runs once per Lambda container lifetime.
// Subsequent invocations on a warm container skip the DDL checks entirely.
// ---------------------------------------------------------------------------
let bootstrapComplete = false;

// ---------------------------------------------------------------------------
// PGC template load order matters — PGC_Schema must exist before
// PGC_TableMap (which has a FK to PGC_Schema).
// ---------------------------------------------------------------------------
const PGC_TEMPLATES = [
  'PGC_Schema.json',
  'PGC_TableMap.json',
  'PGC_EntitySchema.json',
  'PGC_DomainHelp.json',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a new pg.Client for the given connection string.
 * Caller is responsible for client.end() after use.
 *
 * @param {string} connectionString
 * @returns {pg.Client}
 */
export function getClient(connectionString) {
  return new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    ssl: SSL_CONFIG,
  });
}

/**
 * Ensure all PGC system tables exist.
 * Safe to call on every Lambda invocation — skips on warm containers.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function bootstrap() {
  if (bootstrapComplete) {
    return { ok: true };
  }

  const client = getClient(process.env.PGC_DATABASE_URL);

  try {
    await client.connect();
    console.info('init-brain: bootstrap starting');

    // Step 1 — install set_updated_at() trigger function
    await installTriggerFunction(client);

    // Step 2 — create PGC system tables from templates
    for (const filename of PGC_TEMPLATES) {
      await createTableFromTemplate(client, filename);
    }

    // Step 3 — seed PGC_Schema self-referential rows
    await seedPGCSchema(client);

    // Step 4 — seed PGC_TableMap gatekeeper rows
    await seedPGCTableMap(client);
	
    bootstrapComplete = true;
    console.info('init-brain: bootstrap complete');
    return { ok: true };

  } catch (error) {
    console.error('init-brain: bootstrap failed', error.message);
    return { ok: false, error: error.message };

  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Install the set_updated_at() trigger function in PGC.
 * CREATE OR REPLACE — safe to run on every bootstrap.
 */
async function installTriggerFunction(client) {
  const sql = `
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;
  await client.query(sql);
  console.info('init-brain: set_updated_at() installed');
}

/**
 * Load a PGC template JSON file, build DDL, execute it.
 *
 * @param {pg.Client} client
 * @param {string}    filename  — e.g. 'PGC_Schema.json'
 */
async function createTableFromTemplate(client, filename) {
  const templatePath = join(__dirname, 'templates', 'pgc', filename);
  const raw          = await readFile(templatePath, 'utf-8');
  const template     = JSON.parse(raw);
  const ddl          = buildCreateTableSQL(template);

  await client.query(ddl.createTable);
  console.info(`init-brain: table ready — ${template.table_name}`);

  for (const triggerSQL of ddl.triggers) {
    await client.query(triggerSQL);
  }
}

/**
 * Build CREATE TABLE IF NOT EXISTS DDL from a template JSON object.
 * Used for both PGC bootstrap (from files) and runtime domain creation
 * (from PROC/LLM payloads) — same JSON shape, same builder.
 *
 * @param {object} template
 * @returns {{ createTable: string, triggers: string[] }}
 */
export function buildCreateTableSQL(template) {
  const { table_name, columns = [], constraints = [], triggers = [], foreign_keys = [] } = template;

  const columnDefs = columns.map(col => {
    const parts = [`  ${col.name}`, resolveType(col)];

    if (col.primaryKey)          parts.push('PRIMARY KEY');
    if (col.nullable === false && !col.primaryKey) parts.push('NOT NULL');
    if (col.unique)              parts.push('UNIQUE');
    if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);

    return parts.join(' ');
  });

  const constraintDefs = constraints.map(con => {
    switch (con.type) {
      case 'unique':
        return `  CONSTRAINT ${con.name} UNIQUE (${con.columns.join(', ')})`;
      case 'check':
        return `  CONSTRAINT ${con.name} CHECK (${con.expression})`;
      default:
        console.warn(`init-brain: unknown constraint type "${con.type}" on ${table_name}`);
        return null;
    }
  }).filter(Boolean);

  const fkDefs = foreign_keys.map(fk =>
    `  CONSTRAINT ${fk.name} FOREIGN KEY (${fk.column}) ` +
    `REFERENCES "${fk.references.table}" (${fk.references.column}) ` +
    `ON DELETE ${fk.onDelete || 'RESTRICT'}`
  );

  const allDefs = [...columnDefs, ...constraintDefs, ...fkDefs].join(',\n');

  const createTable = [
    `CREATE TABLE IF NOT EXISTS "${table_name}" (`,
    allDefs,
    `);`,
  ].join('\n');

  // Triggers are separate statements — must run after CREATE TABLE
  const triggerStatements = (triggers || []).map(trg => `
    CREATE OR REPLACE TRIGGER "${trg.name}"
      ${trg.timing} UPDATE ON "${table_name}"
      FOR EACH ROW EXECUTE FUNCTION ${trg.function};
  `.trim());

  return { createTable, triggers: triggerStatements };
}

/**
 * Resolve the PostgreSQL column type string.
 * Handles serial specially — serial implies NOT NULL so we skip that flag.
 */
function resolveType(col) {
  return col.type;   // types are passed through verbatim from JSON
                     // e.g. serial, text, integer, jsonb, timestamptz
}

async function seedPGCSchema(client) {
  const raw   = await readFile(join(__dirname, 'templates', 'pgc', 'seeds', 'seed_PGC_Schema.json'), 'utf-8');
  const rows  = JSON.parse(raw);

  for (const row of rows) {
    await client.query(
      `INSERT INTO "PGC_Schema"
         (table_name, target, description, columns, foreign_keys, constraints, triggers)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (table_name) DO NOTHING`,
      [
        row.table_name, row.target, row.description,
        JSON.stringify(row.columns),
        JSON.stringify(row.foreign_keys),
        JSON.stringify(row.constraints),
        JSON.stringify(row.triggers),
      ]
    );
  }
  console.info('init-brain: PGC_Schema seeded');
}

async function seedPGCTableMap(client) {
  const raw  = await readFile(join(__dirname, 'templates', 'pgc', 'seeds', 'seed_PGC_TableMap.json'), 'utf-8');
  const rows = JSON.parse(raw);

  for (const row of rows) {
    // Resolve schema_id from PGC_Schema
    const lookup = await client.query(
      `SELECT id FROM "PGC_Schema" WHERE table_name = $1`,
      [row.table_name]
    );
    if (lookup.rows.length === 0) {
      console.warn(`init-brain: seed_PGC_TableMap — no PGC_Schema row for ${row.table_name}, skipping`);
      continue;
    }
    const schemaId = lookup.rows[0].id;

    await client.query(
      `INSERT INTO "PGC_TableMap"
         (table_name, target, schema_id, allow_insert, allow_update, allow_delete, views)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (table_name) DO NOTHING`,
      [
        row.table_name, row.target, schemaId,
        row.allow_insert, row.allow_update, row.allow_delete,
        JSON.stringify(row.views),
      ]
    );
  }
  console.info('init-brain: PGC_TableMap seeded');
}
