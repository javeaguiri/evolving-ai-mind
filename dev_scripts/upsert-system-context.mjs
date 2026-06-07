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
//   (content, section, inject_always, inject_for, version).
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
// Fingerprint — content hash so no-op is detected even without a version bump
// ---------------------------------------------------------------------------
import { createHash } from 'crypto';

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
}

function fingerprint(row) {
  const canonical = [
    JSON.stringify(sortKeys(row.content ?? null)),
    row.section ?? '',
    String(row.inject_always ?? false),
    JSON.stringify(row.inject_for ?? []),
  ].join('\x00');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Upsert each target row
// ---------------------------------------------------------------------------
const counts = { ok: 0, updated: 0, inserted: 0 };

for (const row of targets) {
  const seedFp = fingerprint(row);
  const label  = row.key;

  // Check if row exists by key
  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_SystemContext',
    filters:   [{ column: 'key', op: 'eq', value: row.key }],
    limit:     1,
  });

  if (!existing.success) {
    console.error(`ERROR [${label}]: getRows failed`, existing);
    process.exit(1);
  }

  if (existing.count > 0) {
    const existingRow = existing.rows[0];
    const dbFp = fingerprint(existingRow);

    if (seedFp === dbFp) {
      console.log(`  ${label}  v${existingRow.version}  ok`);
      counts.ok++;
      continue;
    }

    const result = await servPost('/api/v1/serv/table/updateRows', {
      tableName: 'PGC_SystemContext',
      filters:   [{ column: 'key', op: 'eq', value: row.key }],
      updates:   {
        content:       row.content,
        section:       row.section       ?? null,
        inject_always: row.inject_always ?? false,
        inject_for:    row.inject_for    ?? [],
        version:       row.version       ?? 1,
      },
    });

    if (!result.success) {
      console.error(`ERROR [${label}]: updateRows failed`, result);
      process.exit(1);
    }

    const vTag = existingRow.version === row.version
      ? `v${row.version}`
      : `v${existingRow.version} → v${row.version}`;
    console.log(`  ${label}  ${vTag}  updated`);
    counts.updated++;

  } else {
    const result = await servPost('/api/v1/serv/table/insertRow', {
      tableName: 'PGC_SystemContext',
      row: {
        key:           row.key,
        content:       row.content,
        section:       row.section       ?? null,
        inject_always: row.inject_always ?? false,
        inject_for:    row.inject_for    ?? [],
        version:       row.version       ?? 1,
      },
    });

    if (!result.success) {
      console.error(`ERROR [${label}]: insertRow failed`, result);
      process.exit(1);
    }

    console.log(`  ${label}  v${row.version}  inserted (id: ${result.row?.id})`);
    counts.inserted++;
  }
}

const parts = [`${counts.ok} ok`];
if (counts.updated)  parts.push(`${counts.updated} updated`);
if (counts.inserted) parts.push(`${counts.inserted} inserted`);
console.log(`\n${targets.length} context rows: ${parts.join(', ')}`);
