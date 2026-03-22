// upsert-workflow.mjs
//
// Upserts a workflow definition into PGC_Workflow via SERV.
// If a row with the given name exists — updateRows (steps + description + version++).
// If not — insertRow (full row).
//
// Reads from: ../src/serv/templates/pgc/seeds/seed_PGC_Workflow.json
//
// Usage (from project root, cmd.exe):
//   set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-workflow.mjs
//
// To target a specific workflow by name:
//   node dev_scripts/upsert-workflow.mjs create_workflow

import { readFileSync } from 'fs';

const SERV_API_URL  = process.env.SERV_API_URL;
const WORKFLOW_NAME = process.argv[2] ?? 'create_domain';

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load workflow definition from seed file
// ---------------------------------------------------------------------------

const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_Workflow.json', import.meta.url);
const seed     = JSON.parse(readFileSync(seedPath, 'utf8'));
const workflow = seed.find(w => w.name === WORKFLOW_NAME);

if (!workflow) {
  console.error(`ERROR: workflow "${WORKFLOW_NAME}" not found in seed_PGC_Workflow.json`);
  console.error(`Available: ${seed.map(w => w.name).join(', ')}`);
  process.exit(1);
}

console.log(`\nUpserting workflow: ${workflow.name}`);
console.log(`Steps: ${workflow.steps.map(s => `${s.step}:${s.type}`).join('  →  ')}\n`);

// ---------------------------------------------------------------------------
// Check if row exists
// ---------------------------------------------------------------------------

async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return resp.json();
}

const existing = await servPost('/api/v1/serv/table/getRows', {
  tableName: 'PGC_Workflow',
  filters:   [{ column: 'name', op: 'eq', value: workflow.name }],
  limit:     1,
});

if (!existing.success) {
  console.error('ERROR: getRows failed', existing);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Update or insert
// ---------------------------------------------------------------------------

if (existing.count > 0) {
  const currentVersion = existing.rows[0].version ?? 1;
  const newVersion     = currentVersion + 1;

  console.log(`Row found (id: ${existing.rows[0].id}, version: ${currentVersion}) — updating to version ${newVersion}...`);

  const result = await servPost('/api/v1/serv/table/updateRows', {
    tableName: 'PGC_Workflow',
    filters:   [{ column: 'name', op: 'eq', value: workflow.name }],
    updates:   {
      steps:       workflow.steps,
      description: workflow.description,
      version:     newVersion,
      model_used:  workflow.model_used ?? null,
    },
  });

  if (!result.success) {
    console.error('ERROR: updateRows failed', result);
    process.exit(1);
  }

  console.log(`✅ Updated — ${result.updatedCount ?? 1} row(s) affected`);

} else {
  console.log('Row not found — inserting...');

  const result = await servPost('/api/v1/serv/table/insertRow', {
    tableName: 'PGC_Workflow',
    row: {
      name:            workflow.name,
      domain:          workflow.domain ?? null,
      description:     workflow.description,
      intent_keywords: workflow.intent_keywords ?? [],
      steps:           workflow.steps,
      state_strategy:  workflow.state_strategy ?? null,
      model_used:      workflow.model_used ?? null,
      version:         workflow.version ?? 1,
    },
  });

  if (!result.success) {
    console.error('ERROR: insertRow failed', result);
    process.exit(1);
  }

  console.log(`✅ Inserted — id: ${result.row?.id}`);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

const verify = await servPost('/api/v1/serv/table/getRows', {
  tableName: 'PGC_Workflow',
  filters:   [{ column: 'name', op: 'eq', value: workflow.name }],
  limit:     1,
});

const stored = verify.rows?.[0];
console.log(`\nVerification:`);
console.log(`  name:     ${stored?.name}`);
console.log(`  version:  ${stored?.version}`);
console.log(`  steps:    ${stored?.steps?.map(s => `${s.step}:${s.type}`).join('  →  ')}`);
console.log(`  updated:  ${stored?.updated_at}`);
