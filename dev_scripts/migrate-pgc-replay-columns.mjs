// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-replay-columns.mjs
//
// Migration: Sprint 8 A1 — LLM replay harness schema (docs/arch-replay.md §7).
//
// The PGC system tables were bootstrapped before the replay harness existed, so
// these columns/constraints/index are absent on the live DB. The table templates
// and the seed_PGC_Schema registry have been updated for fresh bootstraps; this
// script brings an ALREADY-bootstrapped database up to the same shape.
//
// Adds:
//   PGC_WorkflowRun.replay_source_run_id (integer, nullable)
//   PGC_WorkflowRun.llm_break_policy     (text, nullable)  + chk_run_break_policy
//   PGC_WorkflowRun status enum          + 'awaiting_llm_break' (chk_run_status)
//   PGC_Session.request_fingerprint      (jsonb, nullable)
//   PGC_Session.fingerprint_hash         (text, nullable)   + idx_pgc_session_fingerprint_hash
//   PGC_Session.response_source          (text, nullable)   + chk_pgc_session_response_source
//   PGC_Session.replayed_from_session_id (integer, nullable)
// Then re-upserts the PGC_WorkflowRun + PGC_Session PGC_Schema registry rows from the
// updated seed so the registry never asserts what the DB does not.
//
// Idempotent: ADD COLUMN IF NOT EXISTS, DROP/ADD CONSTRAINT, CREATE INDEX IF NOT EXISTS,
// ON CONFLICT upsert. Safe to run more than once.
//
// Usage:
//   PGC_DATABASE_URL=<url> node dev_scripts/migrate-pgc-replay-columns.mjs

import pg from 'pg';
import seedSchema from '../src/serv/templates/pgc/seeds/seed_PGC_Schema.json' with { type: 'json' };

const { Client } = pg;

const PGC_DATABASE_URL = process.env.PGC_DATABASE_URL;
if (!PGC_DATABASE_URL) {
  console.error('ERROR: PGC_DATABASE_URL env var not set');
  process.exit(1);
}

const RUN_STATUS_CHECK =
  "status IN ('pending', 'running', 'awaiting_confirmation', 'awaiting_human_gate', 'awaiting_llm_break', 'completed', 'failed', 'cancelled')";
const RUN_BREAK_POLICY_CHECK =
  "llm_break_policy IS NULL OR llm_break_policy IN ('never', 'on_miss', 'always')";
const SESSION_RESPONSE_SOURCE_CHECK =
  "response_source IS NULL OR response_source IN ('live', 'replayed', 'recorded')";

const client = new Client({
  connectionString: PGC_DATABASE_URL,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

async function upsertRegistryRow(tableName) {
  const rows = Array.isArray(seedSchema) ? seedSchema : [seedSchema];
  const row = rows.find(r => r.table_name === tableName);
  if (!row) throw new Error(`seed_PGC_Schema.json has no row for ${tableName}`);
  await client.query(
    `INSERT INTO "PGC_Schema"
       (table_name, target, domain, description, columns, foreign_keys, constraints, triggers)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (table_name) DO UPDATE SET
       domain       = EXCLUDED.domain,
       description  = EXCLUDED.description,
       columns      = EXCLUDED.columns,
       foreign_keys = EXCLUDED.foreign_keys,
       constraints  = EXCLUDED.constraints,
       triggers     = EXCLUDED.triggers,
       updated_at   = now()`,
    [
      row.table_name, row.target, row.domain ?? null, row.description,
      JSON.stringify(row.columns),
      JSON.stringify(row.foreign_keys),
      JSON.stringify(row.constraints),
      JSON.stringify(row.triggers),
    ]
  );
}

try {
  await client.connect();
  console.log('Connected to PGC database.\n');

  await client.query('BEGIN');

  // --- PGC_WorkflowRun columns ---
  await client.query(`ALTER TABLE "PGC_WorkflowRun" ADD COLUMN IF NOT EXISTS replay_source_run_id integer`);
  await client.query(`ALTER TABLE "PGC_WorkflowRun" ADD COLUMN IF NOT EXISTS llm_break_policy text`);
  console.log('✅ PGC_WorkflowRun columns present.');

  // --- PGC_WorkflowRun constraints (drop + re-add = idempotent) ---
  await client.query(`ALTER TABLE "PGC_WorkflowRun" DROP CONSTRAINT IF EXISTS chk_run_status`);
  await client.query(`ALTER TABLE "PGC_WorkflowRun" ADD CONSTRAINT chk_run_status CHECK (${RUN_STATUS_CHECK})`);
  await client.query(`ALTER TABLE "PGC_WorkflowRun" DROP CONSTRAINT IF EXISTS chk_run_break_policy`);
  await client.query(`ALTER TABLE "PGC_WorkflowRun" ADD CONSTRAINT chk_run_break_policy CHECK (${RUN_BREAK_POLICY_CHECK})`);
  console.log('✅ PGC_WorkflowRun constraints updated (chk_run_status + awaiting_llm_break, chk_run_break_policy).');

  // --- PGC_Session columns ---
  await client.query(`ALTER TABLE "PGC_Session" ADD COLUMN IF NOT EXISTS request_fingerprint jsonb`);
  await client.query(`ALTER TABLE "PGC_Session" ADD COLUMN IF NOT EXISTS fingerprint_hash text`);
  await client.query(`ALTER TABLE "PGC_Session" ADD COLUMN IF NOT EXISTS response_source text`);
  await client.query(`ALTER TABLE "PGC_Session" ADD COLUMN IF NOT EXISTS replayed_from_session_id integer`);
  console.log('✅ PGC_Session columns present.');

  // --- PGC_Session constraint + corpus index ---
  await client.query(`ALTER TABLE "PGC_Session" DROP CONSTRAINT IF EXISTS chk_pgc_session_response_source`);
  await client.query(`ALTER TABLE "PGC_Session" ADD CONSTRAINT chk_pgc_session_response_source CHECK (${SESSION_RESPONSE_SOURCE_CHECK})`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pgc_session_fingerprint_hash ON "PGC_Session" (fingerprint_hash)`);
  console.log('✅ PGC_Session constraint + fingerprint_hash index present.');

  // --- Registry rows (keep PGC_Schema == DB) ---
  await upsertRegistryRow('PGC_WorkflowRun');
  await upsertRegistryRow('PGC_Session');
  console.log('✅ PGC_Schema registry rows re-upserted from seed.');

  await client.query('COMMIT');

  // --- Verify ---
  const cols = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_name IN ('PGC_WorkflowRun', 'PGC_Session')
      AND column_name IN ('replay_source_run_id', 'llm_break_policy', 'request_fingerprint',
                          'fingerprint_hash', 'response_source', 'replayed_from_session_id')
    ORDER BY table_name, column_name
  `);
  console.log('\nVerification — new columns present:');
  for (const r of cols.rows) console.log(`  ${r.table_name}.${r.column_name}`);
  console.log('✅ Migration complete.');

} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed (rolled back):', error.message);
  process.exit(1);
} finally {
  await client.end();
}
