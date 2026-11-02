// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/upsert-schema-registry.mjs
//
// Updates the PGC_Schema registry rows of the PGC system tables from seed_PGC_Schema.json
// (columns, constraints, foreign_keys, triggers, description), via SERV.
//
// The registry must never assert what the database does not. Before a row is written, its
// columns (name and nullability), check constraints and foreign keys are compared with the
// live catalog in both directions; a row that disagrees is refused and named, and nothing is
// written for it. Fix the template and seed — or the database, with addColumn /
// modifyConstraint — and run again.
//
// Update only: the PGC system tables' rows are created by bootstrap. A table that does not
// exist in the database (e.g. a template committed but not bootstrapped) is skipped.
// PGD rows are domain data and are never touched.
//
// Usage (from project root):
//   node dev_scripts/upsert-schema-registry.mjs
//   node dev_scripts/upsert-schema-registry.mjs PGC_Session
//   node dev_scripts/upsert-schema-registry.mjs --check      (report only, write nothing)

import { readFileSync } from 'fs';
import { createHash }   from 'crypto';

const SERV_API_URL = process.env.SERV_API_URL;
const CHECK_ONLY   = process.argv.includes('--check');
const TABLE_ARG    = process.argv.slice(2).find(a => !a.startsWith('--')) ?? null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_Schema.json', import.meta.url);
const seed     = JSON.parse(readFileSync(seedPath, 'utf8'))
  .filter(r => /^PGC_[A-Za-z]+$/.test(r.table_name));

const targets = TABLE_ARG ? seed.filter(r => r.table_name === TABLE_ARG) : seed;
if (targets.length === 0) {
  console.error(`ERROR: "${TABLE_ARG}" is not a PGC table in seed_PGC_Schema.json`);
  console.error(`Available: ${seed.map(r => r.table_name).join(', ')}`);
  process.exit(1);
}

async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY ?? '' },
    body:    JSON.stringify(body),
  });
  return resp.json();
}

async function catalog(sql) {
  const resp = await servPost('/api/v1/serv/table/runSql', { target: 'pgc', selectSql: sql });
  if (!resp.success) {
    console.error('ERROR: catalog read failed', resp);
    process.exit(1);
  }
  return resp.rows;
}

// ---------------------------------------------------------------------------
// The live catalog, once, for every PGC table
// ---------------------------------------------------------------------------

const liveColumns = await catalog(
  `SELECT table_name, column_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name LIKE 'PGC\\_%'`);
const liveConstraints = await catalog(
  `SELECT conrelid::regclass::text AS table_name, conname, contype FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND contype IN ('c', 'f')`);

const columnsOf = (table) => new Map(
  liveColumns.filter(c => c.table_name === table).map(c => [c.column_name, c.is_nullable === 'YES']));
const constraintsOf = (table, type) => new Set(
  liveConstraints.filter(c => c.table_name.replace(/"/g, '') === table && c.contype === type).map(c => c.conname));

/** Every way the seed row and the live table disagree, in both directions. */
function disagreements(row) {
  const out  = [];
  const live = columnsOf(row.table_name);
  const seedCols = new Map((row.columns ?? []).map(c => [c.name, !c.primaryKey && c.nullable !== false]));
  for (const [name, nullable] of seedCols) {
    if (!live.has(name))              out.push(`column ${name}: in seed, not in database`);
    else if (live.get(name) !== nullable) out.push(`column ${name}: seed nullable=${nullable}, database nullable=${live.get(name)}`);
  }
  for (const name of live.keys()) {
    if (!seedCols.has(name)) out.push(`column ${name}: in database, not in seed`);
  }
  const compare = (kind, seedNames, liveNames) => {
    for (const n of seedNames) if (!liveNames.has(n)) out.push(`${kind} ${n}: in seed, not in database`);
    for (const n of liveNames) if (!seedNames.has(n)) out.push(`${kind} ${n}: in database, not in seed`);
  };
  compare('check', new Set((row.constraints ?? []).filter(c => c.type === 'check').map(c => c.name)), constraintsOf(row.table_name, 'c'));
  compare('fk',    new Set((row.foreign_keys ?? []).map(f => f.name)),                                  constraintsOf(row.table_name, 'f'));
  return out;
}

// JSONB round-trips sort object keys — normalise both sides before hashing.
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
    JSON.stringify(sortKeys(row.columns      ?? [])),
    JSON.stringify(sortKeys(row.constraints  ?? [])),
    JSON.stringify(sortKeys(row.foreign_keys ?? [])),
    JSON.stringify(sortKeys(row.triggers     ?? [])),
  ].join('\x00');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Check, then update, each target row
// ---------------------------------------------------------------------------

const counts = { ok: 0, updated: 0, skipped: 0, refused: 0 };

for (const row of targets) {
  const label = row.table_name;

  if (columnsOf(label).size === 0) {
    console.log(`  ${label}  skipped — not in the database`);
    counts.skipped++;
    continue;
  }

  const problems = disagreements(row);
  if (problems.length > 0) {
    console.log(`  ${label}  REFUSED — the seed and the database disagree:`);
    for (const p of problems) console.log(`      ${p}`);
    counts.refused++;
    continue;
  }

  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Schema',
    filters:   [{ column: 'table_name', op: 'eq', value: label }],
    limit:     1,
  });
  if (!existing.success || existing.count === 0) {
    console.error(`ERROR [${label}]: no registry row to update`, existing);
    process.exit(1);
  }

  if (fingerprint(existing.rows[0]) === fingerprint(row)) {
    console.log(`  ${label}  ok`);
    counts.ok++;
    continue;
  }

  if (CHECK_ONLY) {
    console.log(`  ${label}  would update`);
    counts.updated++;
    continue;
  }

  const result = await servPost('/api/v1/serv/table/updateRows', {
    tableName: 'PGC_Schema',
    filters:   [{ column: 'table_name', op: 'eq', value: label }],
    updates:   {
      description:  row.description  ?? null,
      columns:      row.columns      ?? [],
      constraints:  row.constraints  ?? [],
      foreign_keys: row.foreign_keys ?? [],
      triggers:     row.triggers     ?? [],
    },
  });
  if (!result.success) {
    console.error(`ERROR [${label}]: updateRows failed`, result);
    process.exit(1);
  }
  console.log(`  ${label}  updated`);
  counts.updated++;
}

const parts = [`${counts.ok} ok`];
if (counts.updated) parts.push(`${counts.updated} ${CHECK_ONLY ? 'would update' : 'updated'}`);
if (counts.skipped) parts.push(`${counts.skipped} skipped`);
if (counts.refused) parts.push(`${counts.refused} refused`);
console.log(`\n${targets.length} PGC registry rows: ${parts.join(', ')}`);
if (counts.refused) process.exit(1);
