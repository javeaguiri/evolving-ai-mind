// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-step-key.mjs
//
// Migration: add step_key text column to PGC_WorkflowRunStep.
//
// Problem: PGC_WorkflowRunStep.step_number is integer. Workflow step keys
// like "3a", "3b", "3c", "3d" all parse to 3 via parseInt(), causing the
// idempotency check to find false positives across branching steps.
//
// Fix: add step_key text column. checkIdempotency and recordStepAudit in
// run-workflow.mjs will use step_key for workflow frames going forward.
// step_number is kept for iterator frames (integer index, no collision risk).
//
// Backfill: existing rows get step_key = step_number::text (e.g. '1', '2').
// These rows are historical and will not cause false positives since their
// frame_ids are unique to completed runs.
//
// Usage (from project root, cmd.exe):
//   set PGC_DATABASE_URL=<url> && node dev_scripts/migrate-step-key.mjs

import pg from 'pg';

const { Client } = pg;

const PGC_DATABASE_URL = process.env.PGC_DATABASE_URL;
if (!PGC_DATABASE_URL) {
  console.error('ERROR: PGC_DATABASE_URL env var not set');
  process.exit(1);
}

const client = new Client({
  connectionString: PGC_DATABASE_URL,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log('Connected to PGC database.\n');

  // 1. Check if column already exists
  const check = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'PGC_WorkflowRunStep'
      AND column_name = 'step_key'
  `);

  if (check.rows.length > 0) {
    console.log('step_key column already exists — nothing to do.');
    process.exit(0);
  }

  // 2. Add step_key column (nullable — existing rows will be backfilled)
  console.log('Adding step_key text column...');
  await client.query(`
    ALTER TABLE "PGC_WorkflowRunStep"
    ADD COLUMN step_key text
  `);
  console.log('✅ Column added.');

  // 3. Backfill existing rows: step_key = step_number::text
  console.log('Backfilling existing rows...');
  const backfill = await client.query(`
    UPDATE "PGC_WorkflowRunStep"
    SET step_key = step_number::text
    WHERE step_key IS NULL
  `);
  console.log(`✅ Backfilled ${backfill.rowCount} row(s).`);

  // 4. Verify
  const verify = await client.query(`
    SELECT COUNT(*) AS total,
           COUNT(step_key) AS with_key,
           COUNT(*) FILTER (WHERE step_key IS NULL) AS missing_key
    FROM "PGC_WorkflowRunStep"
  `);
  const v = verify.rows[0];
  console.log(`\nVerification: total=${v.total}  with_key=${v.with_key}  missing_key=${v.missing_key}`);

  if (parseInt(v.missing_key) > 0) {
    console.warn('WARNING: some rows still have null step_key — check backfill.');
  } else {
    console.log('✅ Migration complete — all rows have step_key.');
  }

} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
} finally {
  await client.end();
}
