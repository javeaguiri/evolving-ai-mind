// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

// dev_scripts/pull-prompt.mjs
//
// Pulls the highest-version DB row for one or more intent_categories and writes
// the result directly into seed_PGC_Prompt.json, replacing ALL existing entries
// for that category with the single authoritative DB row.
//
// Use when the DB is ahead of the seed (e.g. after a prompt was improved by the
// self-healing pipeline or manually patched in the DB without updating the seed).
// After running, use 'git diff' to review changes before committing.
//
// Encoding: JSON.stringify produces \uXXXX for all non-ASCII characters, which
// is the project standard for seed files (git-stable, round-trip safe).
//
// Seed file written: src/serv/templates/pgc/seeds/seed_PGC_Prompt.json
//
// Usage (from project root, cmd.exe):
//   set SERV_API_URL=https://... && node dev_scripts/pull-prompt.mjs <intent_category>
//   node dev_scripts/pull-prompt.mjs generate_workflow_steps
//   node dev_scripts/pull-prompt.mjs              (pulls and writes all categories known in seed)
//
// Workflow:
//   1. Run this script -- seed file is updated in place.
//   2. git diff src/serv/templates/pgc/seeds/seed_PGC_Prompt.json
//   3. Review the diff. If it looks correct, commit.
//   4. Re-run upsert-prompt.mjs to confirm "no changes -- already current".

import { readFileSync, writeFileSync } from 'fs';

const SERV_API_URL = process.env.SERV_API_URL;
const INTENT_CATEGORY = process.argv[2] ?? null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load seed file
// ---------------------------------------------------------------------------
const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_Prompt.json', import.meta.url);
const seedRaw = readFileSync(seedPath, 'utf8');
const seed = JSON.parse(seedRaw);

// Determine which categories to pull
const allCategories = [...new Set(seed.map(p => p.intent_category))];
const targetCategories = INTENT_CATEGORY ? [INTENT_CATEGORY] : allCategories;

// Validate requested category exists in seed (or is being added fresh)
if (INTENT_CATEGORY && !allCategories.includes(INTENT_CATEGORY)) {
  console.warn(`NOTE: "${INTENT_CATEGORY}" not found in seed -- will append as a new entry if found in DB.`);
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
// Pull from DB -- collect replacements
// ---------------------------------------------------------------------------
// Map: intent_category -> pulled entry (or null if not found in DB)
const replacements = new Map();

for (const cat of targetCategories) {
  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Prompt',
    filters: [{ column: 'intent_category', op: 'eq', value: cat }],
    orderBy: { column: 'version', direction: 'desc' },
    limit: 1,
  });

  if (!existing.success) {
    console.error(`ERROR: getRows failed for ${cat}`, existing);
    process.exit(1);
  }

  if (existing.count === 0) {
    console.warn(`WARNING: ${cat} not found in DB -- skipping`);
    replacements.set(cat, null);
    continue;
  }

  const row = existing.rows[0];

  // Shape the seed entry -- omit DB-internal fields (id, created_at, updated_at)
  const entry = {
    intent_category: row.intent_category,
    version: row.version,
    model: row.model ?? null,
    was_successful: row.was_successful ?? null,
    input_variables: row.input_variables ?? null,
    output_schema: row.output_schema ?? null,
    prompt_text: row.prompt_text ?? '',
    probe_input: row.probe_input ?? null,
    max_output_tokens: row.max_output_tokens ?? null,
  };

  replacements.set(cat, entry);
  console.log(`Pulled: ${cat} v${row.version}  updated_at: ${row.updated_at}`);
}

// ---------------------------------------------------------------------------
// Rebuild seed array:
//   - Walk existing seed entries in order.
//   - For each category, emit the pulled entry the FIRST time that category is
//     encountered; skip all subsequent entries for the same category (removes
//     old version entries).
//   - If a pulled category was not in the seed at all, append at the end.
// ---------------------------------------------------------------------------
const emitted = new Set();
const updated = [];

for (const entry of seed) {
  const cat = entry.intent_category;

  if (!replacements.has(cat)) {
    // Not a target category -- preserve unchanged
    updated.push(entry);
    continue;
  }

  if (emitted.has(cat)) {
    // Subsequent old-version entry for this category -- drop it
    continue;
  }

  emitted.add(cat);
  const replacement = replacements.get(cat);

  if (replacement === null) {
    // DB had no row -- preserve the existing seed entry unchanged
    console.warn(`  ${cat}: no DB row found, keeping existing seed entry`);
    updated.push(entry);
  } else {
    // Replace with DB content
    updated.push(replacement);
  }
}

// Append any pulled categories that were not in the seed at all
for (const [cat, entry] of replacements) {
  if (!emitted.has(cat) && entry !== null) {
    console.log(`  ${cat}: new entry, appending to seed`);
    updated.push(entry);
    emitted.add(cat);
  }
}

// ---------------------------------------------------------------------------
// Write seed file
// Encoding note: JSON.stringify produces \uXXXX for all non-ASCII characters.
// This is intentional -- see architecture.md section 3.4 encoding decision.
// ---------------------------------------------------------------------------
const oldCount  = seed.length;
const newCount  = updated.length;
const removed   = oldCount - newCount;

writeFileSync(seedPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');

console.log(`\nSeed file updated: ${seedPath.pathname}`);
console.log(`  Entries before : ${oldCount}`);
console.log(`  Entries after  : ${newCount}`);
if (removed > 0) {
  console.log(`  Removed        : ${removed} old-version entry/entries`);
}
console.log('\nRun: git diff src/serv/templates/pgc/seeds/seed_PGC_Prompt.json');
console.log('Then: node dev_scripts/upsert-prompt.mjs to confirm "already current"');
