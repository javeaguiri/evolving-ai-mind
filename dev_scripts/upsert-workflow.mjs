// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

// dev_scripts/upsert-workflow.mjs
//
// Upserts a workflow definition into PGC_Workflow via SERV.
//
// Idempotency behaviour:
//   - Fetches the current row for the workflow name from the DB.
//   - Computes a content fingerprint over: steps, description, model_used.
//   - If fingerprints match --> no-op. Prints "already current" and exits.
//   - If fingerprints differ --> updateRows with version incremented by 1.
//   - If no row exists --> insertRow at seed version.
//
// Reads from: ../src/serv/templates/pgc/seeds/seed_PGC_Workflow.json
//
// Usage (from project root, cmd.exe):
//   set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-workflow.mjs
//   node dev_scripts/upsert-workflow.mjs create_workflow

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { runSimulation } from '../src/proc/simulation-engine.mjs';

const SERV_API_URL = process.env.SERV_API_URL;
const WORKFLOW_NAME = process.argv[2] ?? null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load seed file
// ---------------------------------------------------------------------------
const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_Workflow.json', import.meta.url);
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

const targets = WORKFLOW_NAME
  ? seed.filter(w => w.name === WORKFLOW_NAME)
  : seed;

if (targets.length === 0) {
  console.error(`ERROR: workflow "${WORKFLOW_NAME}" not found in seed_PGC_Workflow.json`);
  console.error(`Available: ${seed.map(w => w.name).join(', ')}`);
  process.exit(1);
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
// Content fingerprint -- steps serialised canonically, plus description and
// model_used. intent_keywords, state_strategy, domain excluded (metadata).
// ---------------------------------------------------------------------------

// JSONB round-trips sort object keys alphabetically — JSON.stringify preserves
// insertion order. Normalise both seed and DB entries to sorted key order so
// fingerprints are stable across insert/retrieve cycles.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
}

function fingerprint(entry) {
  const canonical = [
    JSON.stringify(sortKeys(entry.steps ?? [])),
    entry.description ?? '',
    entry.model_used ?? '',
  ].join('\x00');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Upsert each target workflow
// ---------------------------------------------------------------------------
const counts = { ok: 0, updated: 0, inserted: 0, l1Failed: 0 };

for (const workflow of targets) {
  const seedFp = fingerprint(workflow);
  const label  = workflow.name;

  // L1 static analysis \u2014 suppress simulation-engine info logs in upsert context.
  const origInfo = console.info;
  console.info = () => {};
  const l1Result = runSimulation({ steps: workflow.steps, mockOutputs: null, simulationPaths: null, runInput: {} });
  console.info = origInfo;
  if (!l1Result.static_analysis.passed) {
    console.error(`  ${label}  L1 FAILED \u2014 ${l1Result.static_analysis.issues.length} issue(s):`);
    for (const issue of l1Result.static_analysis.issues) {
      console.error(`    [${issue.check}] step ${issue.step}: ${issue.detail}`);
    }
    counts.l1Failed++;
    continue;
  }

  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Workflow',
    filters: [{ column: 'name', op: 'eq', value: workflow.name }],
    limit: 1,
  });

  if (!existing.success) {
    console.error(`ERROR [${label}]: getRows failed`, existing);
    process.exit(1);
  }

  // No row -- insert at seed version
  if (existing.count === 0) {
    const result = await servPost('/api/v1/serv/table/insertRow', {
      tableName: 'PGC_Workflow',
      row: {
        name: workflow.name,
        domain: workflow.domain ?? null,
        description: workflow.description,
        intent_keywords: workflow.intent_keywords ?? [],
        steps: workflow.steps,
        state_strategy: workflow.state_strategy ?? null,
        model_used: workflow.model_used ?? null,
        version: workflow.version ?? 1,
      },
    });
    if (!result.success) { console.error(`ERROR [${label}]: insertRow failed`, result); process.exit(1); }
    console.log(`  ${label}  v${workflow.version ?? 1}  inserted (id: ${result.row?.id})`);
    counts.inserted++;
    continue;
  }

  const dbRow     = existing.rows[0];
  const dbVersion = dbRow.version ?? 1;
  const dbFp      = fingerprint(dbRow);

  // Fingerprints match -- no-op
  if (seedFp === dbFp) {
    console.log(`  ${label}  v${dbVersion}  ok`);
    counts.ok++;
    continue;
  }

  // Content differs -- increment DB version
  const newVersion = dbVersion + 1;
  const result = await servPost('/api/v1/serv/table/updateRows', {
    tableName: 'PGC_Workflow',
    filters: [{ column: 'name', op: 'eq', value: workflow.name }],
    updates: {
      steps:       workflow.steps,
      description: workflow.description,
      model_used:  workflow.model_used ?? null,
      version:     newVersion,
    },
  });

  if (!result.success) { console.error(`ERROR [${label}]: updateRows failed`, result); process.exit(1); }
  console.log(`  ${label}  v${dbVersion} \u2192 v${newVersion}  updated`);
  counts.updated++;
}

const parts = [`${counts.ok} ok`];
if (counts.updated)  parts.push(`${counts.updated} updated`);
if (counts.inserted) parts.push(`${counts.inserted} inserted`);
if (counts.l1Failed) parts.push(`${counts.l1Failed} L1 FAILED`);
console.log(`\n${targets.length} workflows: ${parts.join(', ')}`);
