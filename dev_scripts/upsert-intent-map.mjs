// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

// dev_scripts/upsert-intent-map.mjs
//
// Upserts system-level PGC_IntentMap rows from seed_PGC_IntentMap.json.
//
// Idempotency: matches on intent_category.
//   - Row exists with same pattern + action_type → no-op.
//   - Row exists with different pattern or action_type → update.
//   - Row absent → insert.
//
// User-domain rows (written by create_domain workflow) are never touched —
// they do not appear in seed_PGC_IntentMap.json.
//
// Usage (from project root):
//   node dev_scripts/upsert-intent-map.mjs
//   node dev_scripts/upsert-intent-map.mjs create_domain   # single intent_category

import { readFileSync } from 'fs';

const SERV_API_URL = process.env.SERV_API_URL;
const TARGET = process.argv[2] ?? null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_IntentMap.json', import.meta.url);
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

const targets = TARGET
  ? seed.filter(r => r.intent_category === TARGET)
  : seed;

if (targets.length === 0) {
  console.error(`ERROR: intent_category "${TARGET}" not found in seed_PGC_IntentMap.json`);
  console.error(`Available: ${seed.map(r => r.intent_category).join(', ')}`);
  process.exit(1);
}

async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
    body:    JSON.stringify(body),
  });
  return resp.json();
}

for (const row of targets) {
  console.log(`\nIntent: ${row.intent_category}  (${row.action_type})`);
  console.log(`  Pattern : ${row.pattern}`);

  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_IntentMap',
    filters:   [{ column: 'intent_category', op: 'eq', value: row.intent_category }],
    limit:     1,
  });

  if (!existing.success) {
    console.error('ERROR: getRows failed', existing);
    process.exit(1);
  }

  if (existing.count === 0) {
    console.log('  DB row  : none — inserting...');
    const result = await servPost('/api/v1/serv/table/insertRow', {
      tableName: 'PGC_IntentMap',
      row: {
        pattern:         row.pattern,
        intent_category: row.intent_category,
        action_type:     row.action_type,
      },
    });
    if (!result.success) { console.error('ERROR: insertRow failed', result); process.exit(1); }
    console.log(`  Result  : inserted (id: ${result.row?.id})`);
    continue;
  }

  const dbRow = existing.rows[0];
  if (dbRow.pattern === row.pattern && dbRow.action_type === row.action_type) {
    console.log(`  Result  : no changes — already current (id: ${dbRow.id})`);
    continue;
  }

  console.log(`  DB row  : id ${dbRow.id}, pattern differs or action_type differs — updating...`);
  const result = await servPost('/api/v1/serv/table/updateRows', {
    tableName: 'PGC_IntentMap',
    filters:   [{ column: 'intent_category', op: 'eq', value: row.intent_category }],
    updates:   { pattern: row.pattern, action_type: row.action_type },
  });
  if (!result.success) { console.error('ERROR: updateRows failed', result); process.exit(1); }
  console.log(`  Result  : updated (${result.updatedCount ?? 1} row)`);
}

console.log('\nDone.');
