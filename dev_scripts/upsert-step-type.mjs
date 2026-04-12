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

import { readFileSync } from 'fs';

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
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Upsert each target row
// ---------------------------------------------------------------------------

for (const row of targets) {
  console.log(`\nUpserting step type: ${row.step_type}`);
  console.log(`  status:      ${row.status}`);
  console.log(`  description: ${row.description.slice(0, 80)}...`);

  // Check if row exists by step_type
  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_StepType',
    filters:   [{ column: 'step_type', op: 'eq', value: row.step_type }],
    limit:     1,
  });

  if (!existing.success) {
    console.error('ERROR: getRows failed', existing);
    process.exit(1);
  }

  if (existing.count > 0) {
    const existingRow = existing.rows[0];
    console.log(`  Row found (id: ${existingRow.id}) — updating...`);

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
      console.error('ERROR: updateRows failed', result);
      process.exit(1);
    }

    console.log(`  ✅ Updated — ${result.updatedCount ?? 1} row(s) affected`);

  } else {
    console.log('  Row not found — inserting...');

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
      console.error('ERROR: insertRow failed', result);
      process.exit(1);
    }

    console.log(`  ✅ Inserted — id: ${result.row?.id}`);
  }

  // Verify
  const verify = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_StepType',
    filters:   [{ column: 'step_type', op: 'eq', value: row.step_type }],
    limit:     1,
  });

  const stored = verify.rows?.[0];
  console.log(`  Verification:`);
  console.log(`    step_type:   ${stored?.step_type}`);
  console.log(`    status:      ${stored?.status}`);
  console.log(`    updated_at:  ${stored?.updated_at}`);
}

console.log('\nDone.');
