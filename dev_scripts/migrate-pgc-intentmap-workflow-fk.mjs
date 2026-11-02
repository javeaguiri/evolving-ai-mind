// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-intentmap-workflow-fk.mjs
//
// Sprint 15 scope 11: add fk_intentmap_workflow to the live database.
//
// PGC_IntentMap.json, seed_PGC_Schema.json and the live PGC_Schema row all declare
// workflow_id → PGC_Workflow(id) ON DELETE SET NULL, but the constraint was never created on the
// live table. Refuses if any row points at a workflow that does not exist; does nothing if the
// constraint is already there.
//
// Usage:
//   node dev_scripts/migrate-pgc-intentmap-workflow-fk.mjs

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

  const exists = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'fk_intentmap_workflow'`);
  if (exists.rows.length > 0) {
    console.log('fk_intentmap_workflow already exists — nothing to do.');
    process.exit(0);
  }

  const orphans = await client.query(`
    SELECT i.id, i.workflow_id FROM "PGC_IntentMap" i
     WHERE i.workflow_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "PGC_Workflow" w WHERE w.id = i.workflow_id)`);
  if (orphans.rows.length > 0) {
    console.error(`REFUSED: ${orphans.rows.length} PGC_IntentMap rows point at missing workflows:`, orphans.rows);
    process.exit(1);
  }

  console.log('Adding fk_intentmap_workflow...');
  await client.query(`
    ALTER TABLE "PGC_IntentMap"
      ADD CONSTRAINT fk_intentmap_workflow
      FOREIGN KEY (workflow_id) REFERENCES "PGC_Workflow"(id) ON DELETE SET NULL`);

  const verify = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conname = 'fk_intentmap_workflow'`);
  console.log('✅ Added:', verify.rows[0]);
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
