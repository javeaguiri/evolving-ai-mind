// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/upsert-step-type.mjs
//
// Upserts PGC_StepType rows via SERV API.
// Matches on step_type — each step_type is unique in PGC_StepType.
//
// If a row with the given step_type exists — updateRows
//   (description, input_contract, output_contract,
//    on_success_options, on_failure_options, requires_capability, status).
// If not — insertRow (full row).
//
// Reads from: ../src/serv/templates/pgc/seeds/seed_PGC_StepType.json
//
// Usage (from project root, cmd.exe):
//   set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-step-type.mjs
//
// To target a specific step type:
//   node dev_scripts/upsert-step-type.mjs js_transform

import { readFileSync }  from 'fs';
import { createHash }    from 'crypto';

const SERV_API_URL  = process.env.SERV_API_URL;
const STEP_TYPE_ARG = process.argv[2] ?? null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load step type row(s) from seed file
// ---------------------------------------------------------------------------

const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_StepType.json', import.meta.url);
const seed     = JSON.parse(readFileSync(seedPath, 'utf8'));

const targets = STEP_TYPE_ARG
  ? seed.filter(r => r.step_type === STEP_TYPE_ARG)
  : seed;

if (targets.length === 0) {
  console.error(`ERROR: step_type "${STEP_TYPE_ARG}" not found in seed_PGC_StepType.json`);
  console.error(`Available: ${seed.map(r => r.step_type).join(', ')}`);
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
// Fingerprint — stable content hash for change detection
// ---------------------------------------------------------------------------
// JSONB round-trips sort object keys alphabetically — sortKeys normalises both
// seed and DB values to the same canonical form before hashing.

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
}

function fingerprint(row) {
  const canonical = [
    row.description ?? '',
    JSON.stringify(sortKeys(row.input_contract  ?? [])),
    JSON.stringify(sortKeys(row.output_contract ?? null)),
    JSON.stringify(row.on_success_options ?? []),
    JSON.stringify(row.on_failure_options ?? []),
    row.status ?? '',
  ].join('\x00');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Upsert each target row
// ---------------------------------------------------------------------------
const counts = { ok: 0, updated: 0, inserted: 0 };

for (const row of targets) {
  const seedFp = fingerprint(row);
  const label  = row.step_type;

  // Check if row exists by step_type
  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_StepType',
    filters:   [{ column: 'step_type', op: 'eq', value: row.step_type }],
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
      console.log(`  ${label}  ok`);
      counts.ok++;
      continue;
    }

    const result = await servPost('/api/v1/serv/table/updateRows', {
      tableName: 'PGC_StepType',
      filters:   [{ column: 'step_type', op: 'eq', value: row.step_type }],
      updates:   {
        description:          row.description,
        input_contract:       row.input_contract       ?? [],
        output_contract:      row.output_contract      ?? null,
        on_success_options:   row.on_success_options   ?? [],
        on_failure_options:   row.on_failure_options   ?? [],
        requires_capability:  row.requires_capability  ?? null,
        status:               row.status,
      },
    });

    if (!result.success) {
      console.error(`ERROR [${label}]: updateRows failed`, result);
      process.exit(1);
    }

    console.log(`  ${label}  updated`);
    counts.updated++;

  } else {
    const result = await servPost('/api/v1/serv/table/insertRow', {
      tableName: 'PGC_StepType',
      row: {
        step_type:            row.step_type,
        description:          row.description,
        input_contract:       row.input_contract       ?? [],
        output_contract:      row.output_contract      ?? null,
        on_success_options:   row.on_success_options   ?? [],
        on_failure_options:   row.on_failure_options   ?? [],
        requires_capability:  row.requires_capability  ?? null,
        status:               row.status,
      },
    });

    if (!result.success) {
      console.error(`ERROR [${label}]: insertRow failed`, result);
      process.exit(1);
    }

    console.log(`  ${label}  inserted (id: ${result.row?.id})`);
    counts.inserted++;
  }
}

const parts = [`${counts.ok} ok`];
if (counts.updated)  parts.push(`${counts.updated} updated`);
if (counts.inserted) parts.push(`${counts.inserted} inserted`);
console.log(`\n${targets.length} step types: ${parts.join(', ')}`);
