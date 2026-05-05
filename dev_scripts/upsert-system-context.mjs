// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/upsert-system-context.mjs
//
// Upserts PGC_SystemContext rows via SERV API.
// Matches on key — each key is unique in PGC_SystemContext.
//
// If a row with the given key exists — updateRows
//   (content, section, format, inject_always, inject_for, version).
// If not — insertRow (full row).
//
// Reads from: ../src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json
//
// Usage (from project root, cmd.exe):
//   set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-system-context.mjs
//
// To target a specific row by key:
//   node dev_scripts/upsert-system-context.mjs create_domain_example

import { readFileSync } from 'fs';

const SERV_API_URL = process.env.SERV_API_URL;
const KEY_FILTER   = process.argv[2] ?? null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load context row(s) from seed file
// ---------------------------------------------------------------------------

const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', import.meta.url);
const seed     = JSON.parse(readFileSync(seedPath, 'utf8'));

const targets = KEY_FILTER
  ? seed.filter(r => r.key === KEY_FILTER)
  : seed;

if (targets.length === 0) {
  console.error(`ERROR: key "${KEY_FILTER}" not found in seed_PGC_SystemContext.json`);
  console.error(`Available: ${seed.map(r => `${r.key} v${r.version}`).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SERV helper
// ---------------------------------------------------------------------------

async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
    body:    JSON.stringify(body),
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Upsert each target row
// ---------------------------------------------------------------------------

for (const row of targets) {
  console.log(`\nUpserting system context: ${row.key} v${row.version}`);
  console.log(`  section:      ${row.section}`);
  console.log(`  format:       ${row.format}`);
  console.log(`  inject_for:   ${JSON.stringify(row.inject_for ?? [])}`);
  console.log(`  inject_always: ${row.inject_always ?? false}`);
  console.log(`  content:      ${row.content.slice(0, 80)}...`);

  // Check if row exists by key
  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_SystemContext',
    filters:   [{ column: 'key', op: 'eq', value: row.key }],
    limit:     1,
  });

  if (!existing.success) {
    console.error('ERROR: getRows failed', existing);
    process.exit(1);
  }

  if (existing.count > 0) {
    const existingRow = existing.rows[0];
    console.log(`  Row found (id: ${existingRow.id})  db version: v${existingRow.version}  seed version: v${row.version}`);

    if (existingRow.version === row.version) {
      console.log(`  No changes — already current (v${row.version})\n`);
      continue;
    }

    console.log(`  Version diff detected — updating v${existingRow.version} → v${row.version}...`);
    const result = await servPost('/api/v1/serv/table/updateRows', {
      tableName: 'PGC_SystemContext',
      filters:   [{ column: 'key', op: 'eq', value: row.key }],
      updates:   {
        content:       row.content,
        section:       row.section       ?? null,
        format:        row.format        ?? 'prose',
        inject_always: row.inject_always ?? false,
        inject_for:    row.inject_for    ?? [],
        version:       row.version       ?? 1,
      },
    });

    if (!result.success) {
      console.error('ERROR: updateRows failed', result);
      process.exit(1);
    }

    console.log(`  ✅ Updated — ${result.updatedCount ?? 1} row(s) affected`);

  } else {
    console.log('  Row not found — inserting...');

    const result = await servPost('/api/v1/serv/table/insertRow', {
      tableName: 'PGC_SystemContext',
      row: {
        key:           row.key,
        content:       row.content,
        section:       row.section       ?? null,
        format:        row.format        ?? 'prose',
        inject_always: row.inject_always ?? false,
        inject_for:    row.inject_for    ?? [],
        version:       row.version       ?? 1,
      },
    });

    if (!result.success) {
      console.error('ERROR: insertRow failed', result);
      process.exit(1);
    }

    console.log(`  ✅ Inserted — id: ${result.row?.id}`);
  }

  // Verify
  const verify = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_SystemContext',
    filters:   [{ column: 'key', op: 'eq', value: row.key }],
    limit:     1,
  });

  const stored = verify.rows?.[0];
  console.log(`  Verification:`);
  console.log(`    key:        ${stored?.key}`);
  console.log(`    version:    ${stored?.version}`);
  console.log(`    section:    ${stored?.section}`);
  console.log(`    updated_at: ${stored?.updated_at}`);
}

console.log('\nDone.');
