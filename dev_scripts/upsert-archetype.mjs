// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/upsert-archetype.mjs
//
// Upserts PGC_Archetype rows via SERV API.
// Matches on name — each name is unique in PGC_Archetype.
//
// If a row with the given name exists — updateRows
//   (description, aliases, preconditions, slots, topology,
//    design_rules, source_workflow, status, version).
// If not — insertRow (full row).
//
// The embedding column is NOT written here. SERV computes it from embed_source
// (aliases) on insert and on any update whose payload touches aliases.
//
// Reads from: ../src/serv/templates/pgc/seeds/seed_PGC_Archetype.json
//
// Usage (from project root):
//   node dev_scripts/upsert-archetype.mjs
//
// To target a specific archetype:
//   node dev_scripts/upsert-archetype.mjs scoped_row_editor

import { readFileSync }  from 'fs';
import { createHash }    from 'crypto';

const SERV_API_URL  = process.env.SERV_API_URL;
const ARCHETYPE_ARG = process.argv[2] ?? null;

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load archetype row(s) from seed file
// ---------------------------------------------------------------------------

const seedPath = new URL('../src/serv/templates/pgc/seeds/seed_PGC_Archetype.json', import.meta.url);
const seed     = JSON.parse(readFileSync(seedPath, 'utf8'));

const targets = ARCHETYPE_ARG
  ? seed.filter(r => r.name === ARCHETYPE_ARG)
  : seed;

if (targets.length === 0) {
  console.error(`ERROR: archetype "${ARCHETYPE_ARG}" not found in seed_PGC_Archetype.json`);
  console.error(`Available: ${seed.map(r => r.name).join(', ')}`);
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
    row.description     ?? '',
    JSON.stringify(sortKeys(row.aliases       ?? [])),
    JSON.stringify(sortKeys(row.preconditions ?? {})),
    JSON.stringify(sortKeys(row.slots         ?? [])),
    JSON.stringify(sortKeys(row.topology      ?? [])),
    row.design_rules    ?? '',
    row.source_workflow ?? '',
    row.status          ?? '',
    String(row.version  ?? 1),
  ].join('\x00');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Upsert each target row
// ---------------------------------------------------------------------------
const counts = { ok: 0, updated: 0, inserted: 0 };

for (const row of targets) {
  const seedFp = fingerprint(row);
  const label  = row.name;

  const existing = await servPost('/api/v1/serv/table/getRows', {
    tableName: 'PGC_Archetype',
    filters:   [{ column: 'name', op: 'eq', value: row.name }],
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

    // created_by is deliberately not updated — an archetype Novia authored and a
    // developer later moved into the seed file keeps its original provenance.
    const result = await servPost('/api/v1/serv/table/updateRows', {
      tableName: 'PGC_Archetype',
      filters:   [{ column: 'name', op: 'eq', value: row.name }],
      updates:   {
        description:     row.description     ?? null,
        aliases:         row.aliases         ?? [],
        preconditions:   row.preconditions   ?? {},
        slots:           row.slots           ?? [],
        topology:        row.topology        ?? [],
        design_rules:    row.design_rules    ?? null,
        source_workflow: row.source_workflow ?? null,
        status:          row.status          ?? 'draft',
        version:         row.version         ?? 1,
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
      tableName: 'PGC_Archetype',
      row: {
        name:            row.name,
        description:     row.description     ?? null,
        aliases:         row.aliases         ?? [],
        preconditions:   row.preconditions   ?? {},
        slots:           row.slots           ?? [],
        topology:        row.topology        ?? [],
        design_rules:    row.design_rules    ?? null,
        source_workflow: row.source_workflow ?? null,
        status:          row.status          ?? 'draft',
        version:         row.version         ?? 1,
        created_by:      row.created_by      ?? 'seed',
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
console.log(`\n${targets.length} archetypes: ${parts.join(', ')}`);
