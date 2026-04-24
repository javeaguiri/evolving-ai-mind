// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

// dev_scripts/upsert-prompt.mjs
//
// Upserts a prompt definition into PGC_Prompt via SERV.
//
// Idempotency behaviour:
//   - Fetches the highest-version row for the intent_category from the DB.
//   - Computes a content fingerprint over: prompt_text, model, output_schema,
//     input_variables. Fields excluded from fingerprint: was_successful,
//     probe_input, max_output_tokens (operational metadata, not prompt content).
//   - If fingerprints match --> no-op. Prints "already current" and exits.
//   - If fingerprints differ --> updates the target version row in-place.
//   - If the DB highest version is ahead of the seed version --> warns that
//     the seed file version field is stale and should be updated.
//
// Reads from: ../src/serv/templates/pgc/seeds/seed_PGC_Prompt.json
//
// Usage (from project root, cmd.exe):
//   set SERV_API_URL=https://... && node dev_scripts/upsert-prompt.mjs
//   node dev_scripts/upsert-prompt.mjs research_workflow_domain
//   node dev_scripts/upsert-prompt.mjs design_table 2

import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const SERV_API_URL = process.env.SERV_API_URL;
const INTENT_CATEGORY = process.argv[2] ?? null;
const VERSION_OVERRIDE = process.argv[3] ? parseInt(process.argv[3], 10) : null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load seed file
// ---------------------------------------------------------------------------
const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_Prompt.json', import.meta.url);
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

const targets = INTENT_CATEGORY
  ? seed.filter(p => p.intent_category === INTENT_CATEGORY)
  : seed;

if (targets.length === 0) {
  console.error(`ERROR: intent_category "${INTENT_CATEGORY}" not found in seed_PGC_Prompt.json`);
  console.error(`Available: ${seed.map(p => `${p.intent_category} v${p.version}`).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SERV helper
// ---------------------------------------------------------------------------
async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Content fingerprint -- canonical JSON serialisation with sorted keys so
// field ordering differences in the seed file don't produce false diffs.
// ---------------------------------------------------------------------------
function sortedJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const sorted = Object.keys(value).sort().reduce((acc, k) => {
    acc[k] = value[k];
    return acc;
  }, {});
  return JSON.stringify(sorted);
}

function fingerprint(entry) {
  const canonical = [
    entry.prompt_text ?? '',
    entry.model ?? '',
    sortedJson(entry.output_schema ?? null),
    sortedJson(entry.input_variables ?? null),
  ].join('\x00');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Upsert each target prompt
// ---------------------------------------------------------------------------
for (const prompt of targets) {
  const seedVersion = VERSION_OVERRIDE ?? prompt.version ?? 1;
  const seedFp = fingerprint(prompt);

  console.log(`\nPrompt: ${prompt.intent_category}`);
  console.log(`  Seed version : v${seedVersion}  fingerprint: ${seedFp}`);

  // Fetch all rows for this intent_category, find highest version
  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Prompt',
    filters: [{ column: 'intent_category', op: 'eq', value: prompt.intent_category }],
    orderBy: { column: 'version', direction: 'desc' },
    limit: 1,
  });

  if (!existing.success) {
    console.error('ERROR: getRows failed', existing);
    process.exit(1);
  }

  // No row exists at all -- insert at seed version
  if (existing.count === 0) {
    console.log('  DB row      : none -- inserting...');
    const result = await servPost('/api/v1/serv/table/insertRow', {
      tableName: 'PGC_Prompt',
      row: {
        intent_category: prompt.intent_category,
        prompt_text: prompt.prompt_text,
        model: prompt.model ?? null,
        version: seedVersion,
        input_variables: prompt.input_variables ?? null,
        output_schema: prompt.output_schema ?? null,
        output_sample: prompt.output_sample ?? null,
        was_successful: prompt.was_successful ?? null,
        probe_input: prompt.probe_input ?? null,
        max_output_tokens: prompt.max_output_tokens ?? null,
      },
    });
    if (!result.success) { console.error('ERROR: insertRow failed', result); process.exit(1); }
    console.log(`  Result      : inserted at v${seedVersion} (id: ${result.row?.id})`);
    continue;
  }

  const dbRow = existing.rows[0];
  const dbVersion = dbRow.version;
  const dbFp = fingerprint(dbRow);

  console.log(`  DB highest  : v${dbVersion}  fingerprint: ${dbFp}`);

  // Warn if DB version is ahead of the seed file
  if (dbVersion > seedVersion) {
    console.warn(`  WARNING: DB is at v${dbVersion} but seed file declares v${seedVersion}.`);
    console.warn(`           Update the seed file version field to ${dbVersion} to resolve the mismatch.`);
  }

  // Fingerprints match -- no-op
  if (seedFp === dbFp) {
    console.log(`  Result      : no changes -- already current (v${dbVersion})`);
    continue;
  }

  // Content differs -- update the highest DB version row in-place
  console.log(`  Content diff detected -- updating v${dbVersion}...`);
  const targetVersion = dbVersion;

  const result = await servPost('/api/v1/serv/table/updateRows', {
    tableName: 'PGC_Prompt',
    filters: [
      { column: 'intent_category', op: 'eq', value: prompt.intent_category },
      { column: 'version', op: 'eq', value: targetVersion },
    ],
    updates: {
      prompt_text: prompt.prompt_text,
      model: prompt.model ?? null,
      input_variables: prompt.input_variables ?? null,
      output_schema: prompt.output_schema ?? null,
      output_sample: prompt.output_sample ?? null,
      was_successful: prompt.was_successful ?? null,
      probe_input: prompt.probe_input ?? null,
      max_output_tokens: prompt.max_output_tokens ?? null,
    },
  });

  if (!result.success) { console.error('ERROR: updateRows failed', result); process.exit(1); }

  if (dbVersion !== seedVersion) {
    console.warn(`  NOTE: Changes written to DB v${dbVersion} (not seed v${seedVersion}).`);
    console.warn(`        Update seed file version field to ${dbVersion}.`);
  }
  console.log(`  Result      : updated v${targetVersion} -- ${result.updatedCount ?? 1} row(s) affected`);

  // Verify
  const verify = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Prompt',
    filters: [
      { column: 'intent_category', op: 'eq', value: prompt.intent_category },
      { column: 'version', op: 'eq', value: targetVersion },
    ],
    limit: 1,
  });
  const stored = verify.rows?.[0];
  console.log(`  Verified    : v${stored?.version}  updated_at: ${stored?.updated_at}`);
}

console.log('\nDone.');
