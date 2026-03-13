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
// Called by: serv/handler.mjs (cold start), schema.mjs (getClient, buildCreateTableSQL)
// Never throws — returns { ok, report, error } so callers decide how to handle failures.

import pg           from 'pg';

// Fixed — bundled at build time by esbuild
import PGC_Schema       from './templates/pgc/PGC_Schema.json'       with { type: 'json' };
import PGC_TableMap     from './templates/pgc/PGC_TableMap.json'     with { type: 'json' };
import PGC_EntitySchema from './templates/pgc/PGC_EntitySchema.json' with { type: 'json' };
import PGC_DomainHelp   from './templates/pgc/PGC_DomainHelp.json'   with { type: 'json' };
import seedSchema       from './templates/pgc/seeds/PGC_Schema.json'   with { type: 'json' };
import seedTableMap     from './templates/pgc/seeds/PGC_TableMap.json' with { type: 'json' };

const { Client } = pg;

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

/** @type {BootstrapReport | null} Cached on warm containers — returned immediately. */
let cachedReport = null;

// ---------------------------------------------------------------------------
// PGC template load order matters — PGC_Schema must exist before
// PGC_TableMap (which has a FK to PGC_Schema).
// ---------------------------------------------------------------------------
const PGC_TEMPLATES = [
  PGC_Schema,
  PGC_TableMap,
  PGC_EntitySchema,
  PGC_DomainHelp,
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
 * @typedef {Object} TableBootstrapResult
 * @property {string}  table_name
 * @property {'created' | 'already_existed'} status
 */

/**
 * @typedef {Object} BootstrapReport
 * @property {boolean}               freshEnvironment  — true if any table was newly created
 * @property {TableBootstrapResult[]} tables            — one entry per PGC system table
 * @property {string}                 bootstrappedAt    — ISO timestamp
 */

/**
 * Ensure all PGC system tables exist.
 * Safe to call on every Lambda invocation — skips on warm containers.
 *
 * @returns {Promise<{ ok: boolean, report?: BootstrapReport, error?: string, cached?: boolean }>}
 */
export async function bootstrap() {
  if (bootstrapComplete) {
    return { ok: true, report: cachedReport, cached: true };
  }

  const client = getClient(process.env.PGC_DATABASE_URL);

  /** @type {TableBootstrapResult[]} */
  const tableResults = [];

  try {
    await client.connect();
    console.info('init-brain: bootstrap starting');

    // Step 1 — install set_updated_at() trigger function
    await installTriggerFunction(client);

    // Step 2 — create PGC system tables from templates, tracking new vs existing
    for (const template of PGC_TEMPLATES) {
      const status = await createTableFromTemplate(client, template);
      tableResults.push({ table_name: template[0].table_name, status });
    }

    // Step 3 — seed PGC_Schema self-referential rows
    await seedPGCSchema(client);

    // Step 4 — seed PGC_TableMap gatekeeper rows
    await seedPGCTableMap(client);

    const freshEnvironment = tableResults.some(r => r.status === 'created');

    /** @type {BootstrapReport} */
    const report = {
      freshEnvironment,
      tables:         tableResults,
      bootstrappedAt: new Date().toISOString(),
    };

    cachedReport      = report;
    bootstrapComplete = true;

    if (freshEnvironment) {
      console.info('init-brain: fresh environment detected — PGC tables created', report);
    } else {
      console.info('init-brain: bootstrap complete — all tables already existed');
    }

    return { ok: true, report };

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
 * Check whether a table exists, then create it if not.
 * Returns 'created' or 'already_existed' — used to build BootstrapReport.
 *
 * @param {pg.Client} client
 * @param {object[]}  templateArray  — JSON template is an array; first element holds table_name
 * @returns {Promise<'created' | 'already_existed'>}
 */
async function createTableFromTemplate(client, templateArray) {
  // Each PGC template JSON file is an array — bootstrap uses index 0
  const template = Array.isArray(templateArray) ? templateArray[0] : templateArray;

  // Check existence before CREATE TABLE IF NOT EXISTS so we can report accurately
  const exists = await client.query(
    `SELECT to_regclass($1::text) AS oid`,
    [`"${template.table_name}"`]
  );
  const alreadyExisted = exists.rows[0].oid !== null;

  const ddl = buildCreateTableSQL(template);
  await client.query(ddl.createTable);

  for (const triggerSQL of ddl.triggers) {
    await client.query(triggerSQL);
  }

  const status = alreadyExisted ? 'already_existed' : 'created';
  console.info(`init-brain: ${template.table_name} — ${status}`);
  return status;
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
      ${trg.timing} ON "${table_name}"
      FOR EACH ROW EXECUTE FUNCTION ${trg.function};
  `.trim());

  return { createTable, triggers: triggerStatements };
}

/**
 * Resolve the PostgreSQL column type string.
 * Types are passed through verbatim from JSON
 * e.g. serial, text, integer, jsonb, timestamptz
 */
function resolveType(col) {
  return col.type;   // types are passed through verbatim from JSON
                     // e.g. serial, text, integer, jsonb, timestamptz
}

async function seedPGCSchema(client) {
  // seedSchema is the array from seed_PGC_Schema.json
  const rows = Array.isArray(seedSchema) ? seedSchema : [seedSchema];
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
  const rows = Array.isArray(seedTableMap) ? seedTableMap : [seedTableMap];
  for (const row of rows) {
    const lookup = await client.query(
      `SELECT id FROM "PGC_Schema" WHERE table_name = $1`,
      [row.table_name]
    );
    if (lookup.rows.length === 0) {
      console.warn(`init-brain: seed_PGC_TableMap — no PGC_Schema row for ${row.table_name}, skipping`);
      continue;
    }
    await client.query(
      `INSERT INTO "PGC_TableMap"
         (table_name, target, schema_id, allow_insert, allow_update, allow_delete, views)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (table_name) DO NOTHING`,
      [
        row.table_name, row.target, lookup.rows[0].id,
        row.allow_insert, row.allow_update, row.allow_delete,
        JSON.stringify(row.views),
      ]
    );
  }
  console.info('init-brain: PGC_TableMap seeded');
}
