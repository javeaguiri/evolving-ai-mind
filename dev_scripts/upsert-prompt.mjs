// upsert-prompt.mjs
//
// Upserts a prompt definition into PGC_Prompt via SERV.
// Matches on (intent_category, version) — PGC_Prompt allows multiple versions
// per intent_category, so both fields are required to identify a unique row.
//
// If a row with the given intent_category + version exists — updateRows
//   (prompt_text, model, input_variables, output_schema, output_sample).
// If not — insertRow (full row).
//
// Reads from: ../src/serv/templates/pgc/seeds/seed_PGC_Prompt.json
//
// Usage (from project root, cmd.exe):
//   set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-prompt.mjs
//
// To target a specific prompt by intent_category:
//   node dev_scripts/upsert-prompt.mjs generate_crud_workflows
//
// To target a specific version (defaults to version in seed file):
//   node dev_scripts/upsert-prompt.mjs design_table 2

import { readFileSync } from 'fs';

const SERV_API_URL     = process.env.SERV_API_URL;
const INTENT_CATEGORY  = process.argv[2] ?? null;
const VERSION_OVERRIDE = process.argv[3] ? parseInt(process.argv[3], 10) : null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load prompt definition(s) from seed file
// ---------------------------------------------------------------------------

const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_Prompt.json', import.meta.url);
const seed     = JSON.parse(readFileSync(seedPath, 'utf8'));

// Resolve which prompts to upsert — all if no name given, one if named
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
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Upsert each target prompt
// ---------------------------------------------------------------------------

for (const prompt of targets) {
  const version = VERSION_OVERRIDE ?? prompt.version ?? 1;

  console.log(`\nUpserting prompt: ${prompt.intent_category} v${version}`);
  console.log(`  model: ${prompt.model ?? '(none)'}`);
  console.log(`  prompt_text: ${prompt.prompt_text?.slice(0, 80)}...`);

  // Check if row exists by (intent_category, version)
  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Prompt',
    filters:   [
      { column: 'intent_category', op: 'eq', value: prompt.intent_category },
      { column: 'version',         op: 'eq', value: version },
    ],
    limit: 1,
  });

  if (!existing.success) {
    console.error('ERROR: getRows failed', existing);
    process.exit(1);
  }

  if (existing.count > 0) {
    const row = existing.rows[0];
    console.log(`  Row found (id: ${row.id}) — updating...`);

    const result = await servPost('/api/v1/serv/table/updateRows', {
      tableName: 'PGC_Prompt',
      filters:   [
        { column: 'intent_category', op: 'eq', value: prompt.intent_category },
        { column: 'version',         op: 'eq', value: version },
      ],
      updates: {
        prompt_text:      prompt.prompt_text,
        model:            prompt.model ?? null,
        input_variables:  prompt.input_variables  ?? null,
        output_schema:    prompt.output_schema    ?? null,
        output_sample:    prompt.output_sample    ?? null,
        was_successful:   prompt.was_successful   ?? null,
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
      tableName: 'PGC_Prompt',
      row: {
        intent_category:  prompt.intent_category,
        prompt_text:      prompt.prompt_text,
        model:            prompt.model            ?? null,
        version,
        input_variables:  prompt.input_variables  ?? null,
        output_schema:    prompt.output_schema    ?? null,
        output_sample:    prompt.output_sample    ?? null,
        was_successful:   prompt.was_successful   ?? null,
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
    tableName: 'PGC_Prompt',
    filters:   [
      { column: 'intent_category', op: 'eq', value: prompt.intent_category },
      { column: 'version',         op: 'eq', value: version },
    ],
    limit: 1,
  });

  const stored = verify.rows?.[0];
  console.log(`  Verification:`);
  console.log(`    intent_category: ${stored?.intent_category}`);
  console.log(`    version:         ${stored?.version}`);
  console.log(`    model:           ${stored?.model}`);
  console.log(`    updated_at:      ${stored?.updated_at}`);
}

console.log('\nDone.');
