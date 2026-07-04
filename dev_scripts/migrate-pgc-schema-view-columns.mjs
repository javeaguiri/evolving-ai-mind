// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-schema-view-columns.mjs
//
// Migration: add type and select_sql columns to PGC_Schema.
//
// Problem: PGC_Schema has no way to distinguish a table row from a view row.
// Track E (Sprint 7) registers views as first-class PGC_Schema/PGC_TableMap
// rows — same mechanism as tables — so serv_getRows/serv_query work on them
// with no code changes. deleteTable needs to know whether to run DROP VIEW
// or DROP TABLE, and a future redesign (Novia) needs the view's current
// select_sql to start from.
//
// Fix: add type text column (default 'table', check constraint 'table'|'view')
// and select_sql text column (nullable — populated for type='view' rows only).
//
// Backfill: existing rows get type = 'table' via the column default; no
// existing row needs select_sql.
//
// Usage:
//   PGC_DATABASE_URL=<url> node dev_scripts/migrate-pgc-schema-view-columns.mjs

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

  // 1. Check if columns already exist
  const check = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'PGC_Schema'
      AND column_name IN ('type', 'select_sql')
  `);
  const existing = new Set(check.rows.map(r => r.column_name));

  if (existing.has('type') && existing.has('select_sql')) {
    console.log('type and select_sql columns already exist — nothing to do.');
    process.exit(0);
  }

  // 2. Add type column (NOT NULL, default 'table')
  if (!existing.has('type')) {
    console.log('Adding type text column...');
    await client.query(`
      ALTER TABLE "PGC_Schema"
      ADD COLUMN type text NOT NULL DEFAULT 'table'
    `);
    console.log('✅ type column added (existing rows backfilled to \'table\' via default).');
  } else {
    console.log('type column already exists — skipping.');
  }

  // 3. Add check constraint on type
  const constraintCheck = await client.query(`
    SELECT conname FROM pg_constraint WHERE conname = 'chk_type'
  `);
  if (constraintCheck.rows.length === 0) {
    console.log('Adding chk_type check constraint...');
    await client.query(`
      ALTER TABLE "PGC_Schema"
      ADD CONSTRAINT chk_type CHECK (type IN ('table', 'view'))
    `);
    console.log('✅ chk_type constraint added.');
  } else {
    console.log('chk_type constraint already exists — skipping.');
  }

  // 4. Add select_sql column (nullable)
  if (!existing.has('select_sql')) {
    console.log('Adding select_sql text column...');
    await client.query(`
      ALTER TABLE "PGC_Schema"
      ADD COLUMN select_sql text
    `);
    console.log('✅ select_sql column added.');
  } else {
    console.log('select_sql column already exists — skipping.');
  }

  // 5. Verify
  const verify = await client.query(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE type = 'table') AS table_rows,
           COUNT(*) FILTER (WHERE type = 'view')  AS view_rows
    FROM "PGC_Schema"
  `);
  const v = verify.rows[0];
  console.log(`\nVerification: total=${v.total}  table_rows=${v.table_rows}  view_rows=${v.view_rows}`);
  console.log('✅ Migration complete.');

} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
} finally {
  await client.end();
}
