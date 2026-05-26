// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

// dev_scripts/upsert-prompt.mjs
//
// Upserts a prompt definition into PGC_Prompt via SERV.
//
// Idempotency and version safety rules:
//   1. When multiple seed entries exist for the same intent_category, only the
//      highest-version entry is processed. Old versions in the seed file are
//      historical noise and must never be deployed over a newer DB row.
//   2. Computes a content fingerprint over prompt_text, model, output_schema,
//      input_variables, probe_input before every write.
//   3. Fingerprints match --> no-op. "Already current."
//   4. Fingerprints differ AND seed version >= DB version --> update DB row.
//   5. Fingerprints differ AND DB version > seed version --> SKIP. The DB is
//      ahead of the seed. Print instructions to pull DB content into the seed.
//      Never overwrite a newer DB version with older seed content.
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

// Filter to requested intent_category (or all)
const candidates = INTENT_CATEGORY
  ? seed.filter(p => p.intent_category === INTENT_CATEGORY)
  : seed;

if (candidates.length === 0) {
  console.error(`ERROR: intent_category "${INTENT_CATEGORY}" not found in seed_PGC_Prompt.json`);
  console.error(`Available: ${[...new Set(seed.map(p => p.intent_category))].join(', ')}`);
  process.exit(1);
}

// Deduplicate: for each intent_category keep only the highest seed version.
// Old versions in the seed file must never be deployed.
const latestByCat = new Map();
for (const p of candidates) {
  const v = VERSION_OVERRIDE ?? p.version ?? 1;
  const existing = latestByCat.get(p.intent_category);
  if (!existing || v > (VERSION_OVERRIDE ?? existing.version ?? 1)) {
    latestByCat.set(p.intent_category, p);
  }
}
const targets = [...latestByCat.values()];

if (targets.length < candidates.length) {
  const skipped = candidates.length - targets.length;
  console.warn(`NOTE: ${skipped} older seed version(s) skipped -- only the highest version per intent_category is deployed.`);
  console.warn('      Remove old version entries from seed_PGC_Prompt.json to eliminate this warning.\n');
}

// ---------------------------------------------------------------------------
// SERV helper
// ---------------------------------------------------------------------------
async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Content fingerprint -- canonical JSON with sorted keys so field ordering
// differences between seed and DB do not produce false diffs.
// Covers: prompt_text, model, output_schema, input_variables.
// Excludes: was_successful, probe_input, max_output_tokens (operational metadata).
// ---------------------------------------------------------------------------
// JSONB round-trips sort object keys at every nesting level — sortedJson must
// be recursive so fingerprints are stable for nested structures like output_schema.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
}

function fingerprint(entry) {
  const canonical = [
    entry.prompt_text ?? '',
    entry.model ?? '',
    JSON.stringify(sortKeys(entry.output_schema ?? null)),
    JSON.stringify(sortKeys(entry.input_variables ?? null)),
    String(entry.max_output_tokens ?? ''),
  ].join('\x00');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Upsert each target prompt
// ---------------------------------------------------------------------------
let needsAttention = false;

for (const prompt of targets) {
  const seedVersion = VERSION_OVERRIDE ?? prompt.version ?? 1;
  const seedFp = fingerprint(prompt);

  console.log(`\nPrompt: ${prompt.intent_category}`);
  console.log(`  Seed version : v${seedVersion}  fingerprint: ${seedFp}`);

  // Fetch highest-version DB row for this intent_category
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

  // No DB row -- insert at seed version
  if (existing.count === 0) {
    console.log('  DB row       : none -- inserting...');
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
      },
    });
    if (!result.success) { console.error('ERROR: insertRow failed', result); process.exit(1); }
    console.log(`  Result       : inserted at v${seedVersion} (id: ${result.row?.id})`);
    continue;
  }

  const dbRow = existing.rows[0];
  const dbVersion = dbRow.version;
  const dbFp = fingerprint(dbRow);

  console.log(`  DB highest   : v${dbVersion}  fingerprint: ${dbFp}`);

  // Fingerprints match -- no-op regardless of version numbers
  if (seedFp === dbFp) {
    console.log(`  Result       : no changes -- already current (v${dbVersion})`);
    if (seedVersion !== dbVersion) {
      console.warn(`  NOTE: Seed declares v${seedVersion} but DB is v${dbVersion}. Update seed version field.`);
      needsAttention = true;
    }
    continue;
  }

  // Content differs AND DB is ahead of seed -- do NOT overwrite
  if (dbVersion > seedVersion) {
    console.warn(`  SKIP: DB v${dbVersion} has different content from seed v${seedVersion}.`);
    console.warn(`        The seed is stale. Pull the DB content before deploying:`);
    console.warn(`        node dev_scripts/pull-prompt.mjs ${prompt.intent_category}`);
    needsAttention = true;
    continue;
  }

  // Content differs AND seed version >= DB version -- safe to update
  const targetVersion = dbVersion;
  console.log(`  Content diff detected -- updating v${targetVersion}...`);

  const result = await servPost('/api/v1/serv/table/updateRows', {
    tableName: 'PGC_Prompt',
    filters: [
      { column: 'intent_category', op: 'eq', value: prompt.intent_category },
      { column: 'version', op: 'eq', value: targetVersion },
    ],
    updates: {
      prompt_text:       prompt.prompt_text,
      model:             prompt.model ?? null,
      input_variables:   prompt.input_variables ?? null,
      output_schema:     prompt.output_schema ?? null,
      max_output_tokens: prompt.max_output_tokens ?? null,
      probe_input:       prompt.probe_input ?? null,
    },
  });

  if (!result.success) { console.error('ERROR: updateRows failed', result); process.exit(1); }
  console.log(`  Result       : updated v${targetVersion} -- ${result.updatedCount ?? 1} row(s) affected`);

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
  console.log(`  Verified     : v${stored?.version}  updated_at: ${stored?.updated_at}`);
}

if (needsAttention) {
  console.warn('\n ACTION REQUIRED: one or more prompts were skipped or have version mismatches.');
  console.warn(' Run: node dev_scripts/pull-prompt.mjs <intent_category> to pull DB content.');
}

console.log('\nDone.');
