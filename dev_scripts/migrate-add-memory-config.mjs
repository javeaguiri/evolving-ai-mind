// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-add-memory-config.mjs
//
// Migration: add memory_config JSONB NULL column to PGC_Prompt.
//
// Controls per-prompt memory injection via the LLM harness:
//   memory_budget_tokens  — max tokens for memory injection block (0 = disabled)
//   memory_types          — which PGC_Memory types to retrieve
//   include_persona       — include {"topic":"persona"} memories (chat calls only)
//   scope_override        — fixed scope instead of auto-derived call scope
//   tags_filter           — only retrieve memories matching these tags
//
// Existing rows: memory_config = NULL → harness defaults (budget 0, disabled).
//
// Usage (from project root):
//   node dev_scripts/migrate-add-memory-config.mjs

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

  const check = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'PGC_Prompt'
      AND column_name = 'memory_config'
  `);

  if (check.rows.length > 0) {
    console.log('memory_config column already exists — nothing to do.');
    process.exit(0);
  }

  console.log('Adding memory_config JSONB NULL column to PGC_Prompt...');
  await client.query(`
    ALTER TABLE "PGC_Prompt"
    ADD COLUMN memory_config JSONB NULL
  `);
  console.log('✅ Column added.');

  const verify = await client.query(`
    SELECT COUNT(*) AS total,
           COUNT(memory_config) AS with_config,
           COUNT(*) FILTER (WHERE memory_config IS NULL) AS null_config
    FROM "PGC_Prompt"
  `);
  const v = verify.rows[0];
  console.log(`\nVerification: total=${v.total}  with_config=${v.with_config}  null_config=${v.null_config}`);
  console.log('✅ Migration complete — all existing rows have memory_config = NULL (harness default: disabled).');

} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
} finally {
  await client.end();
}
