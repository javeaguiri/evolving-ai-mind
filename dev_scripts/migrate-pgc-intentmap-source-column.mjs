// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-intentmap-source-column.mjs
//
// Sprint 7 Track F1 migration:
//   1. Add PGC_IntentMap.source (nullable text, CHECK 'user'|'auto'|'name') + sync PGC_Schema.
//   2. Split every existing workflow-linked row (workflow_id IS NOT NULL) whose pattern is a
//      joined regex ("phrase one|phrase two|...") into one row per phrase. System-seeded rows
//      (workflow_id IS NULL — create_domain, help, generic per-domain CRUD, etc.) are left
//      untouched: they are still managed as joined patterns by seed_PGC_IntentMap.json +
//      upsert-intent-map.mjs, which matches on intent_category and would fight a split.
//   Provenance for migrated (pre-existing) phrases can't be recovered exactly, so: the phrase
//   equal to the workflow's own intent_category gets source 'name'; every other phrase gets
//   'auto' (a defensible default — going forward, create_workflow's own step 35b tags phrases
//   precisely at creation time).
//
// Usage:
//   PGC_DATABASE_URL=<url> node dev_scripts/migrate-pgc-intentmap-source-column.mjs

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

  // --- Step 1: add source column ---
  const colCheck = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'PGC_IntentMap' AND column_name = 'source'
  `);
  if (colCheck.rows.length === 0) {
    console.log('Adding PGC_IntentMap.source column...');
    await client.query(`ALTER TABLE "PGC_IntentMap" ADD COLUMN source text`);
    console.log('✅ Column added.');
  } else {
    console.log('PGC_IntentMap.source already exists — skipping column add.');
  }

  // --- Step 2: add CHECK constraint ---
  const conCheck = await client.query(`
    SELECT conname FROM pg_constraint WHERE conname = 'chk_pgc_intentmap_source'
  `);
  if (conCheck.rows.length === 0) {
    console.log('Adding chk_pgc_intentmap_source check constraint...');
    await client.query(`
      ALTER TABLE "PGC_IntentMap"
      ADD CONSTRAINT chk_pgc_intentmap_source
      CHECK (source IS NULL OR source IN ('user', 'auto', 'name'))
    `);
    console.log('✅ Constraint added.');
  } else {
    console.log('chk_pgc_intentmap_source already exists — skipping.');
  }

  // --- Step 3: sync PGC_Schema registry row for PGC_IntentMap ---
  const schemaRow = await client.query(`
    SELECT id, columns, constraints FROM "PGC_Schema" WHERE table_name = 'PGC_IntentMap'
  `);
  if (schemaRow.rows.length > 0) {
    const { id, columns, constraints } = schemaRow.rows[0];
    const cols = Array.isArray(columns) ? columns : [];
    const cons = Array.isArray(constraints) ? constraints : [];
    let changed = false;

    let newCols = cols;
    if (!cols.some(c => c.name === 'source')) {
      newCols = cols.concat([{ name: 'source', type: 'text', nullable: true }]);
      changed = true;
    }
    let newCons = cons;
    if (!cons.some(c => c.name === 'chk_pgc_intentmap_source')) {
      newCons = cons.concat([{ type: 'check', name: 'chk_pgc_intentmap_source', expression: "source IS NULL OR source IN ('user', 'auto', 'name')" }]);
      changed = true;
    }
    if (changed) {
      await client.query(`UPDATE "PGC_Schema" SET columns = $1, constraints = $2 WHERE id = $3`,
        [JSON.stringify(newCols), JSON.stringify(newCons), id]);
      console.log('✅ PGC_Schema registry row synced.');
    } else {
      console.log('PGC_Schema registry row already in sync — skipping.');
    }
  } else {
    console.warn('⚠️  No PGC_Schema row found for PGC_IntentMap — registry not synced.');
  }

  // --- Step 4: split workflow-linked joined-pattern rows ---
  console.log('\nSplitting workflow-linked joined-pattern rows...');
  const rowsResp = await client.query(`
    SELECT id, pattern, intent_category, workflow_id, action_type
    FROM "PGC_IntentMap"
    WHERE workflow_id IS NOT NULL
  `);

  let splitRowCount = 0;
  let newPhraseCount = 0;

  for (const row of rowsResp.rows) {
    const phrases = row.pattern.split('|').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);
    if (phrases.length <= 1) {
      console.log(`  id ${row.id} (${row.intent_category}): single phrase already — skipping`);
      continue;
    }

    const seen = new Set();
    const uniquePhrases = phrases.filter(p => (seen.has(p) ? false : (seen.add(p), true)));

    await client.query('BEGIN');
    try {
      for (const phrase of uniquePhrases) {
        const source = phrase === row.intent_category.toLowerCase() ? 'name' : 'auto';
        await client.query(`
          INSERT INTO "PGC_IntentMap" (pattern, intent_category, workflow_id, action_type, source)
          VALUES ($1, $2, $3, $4, $5)
        `, [phrase, row.intent_category, row.workflow_id, row.action_type, source]);
      }
      await client.query(`DELETE FROM "PGC_IntentMap" WHERE id = $1`, [row.id]);
      await client.query('COMMIT');
    } catch (splitErr) {
      await client.query('ROLLBACK');
      throw splitErr;
    }

    console.log(`  id ${row.id} (${row.intent_category}): split into ${uniquePhrases.length} rows`);
    splitRowCount += 1;
    newPhraseCount += uniquePhrases.length;
  }

  console.log(`\n✅ Migration complete. ${splitRowCount} joined-pattern row(s) split into ${newPhraseCount} phrase row(s).`);

} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
} finally {
  await client.end();
}
