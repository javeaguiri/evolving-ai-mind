// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/upsert-edit-policy.mjs
//
// Writes PGC_EditPolicy — what the web may change directly, per table (docs/arch-home-brain.md
// §4.8) — from the household's file, until Novia's domain tooling writes it. There is no system
// seed: a policy names a household's tables, and nothing is editable until declared.
//
//   node dev_scripts/upsert-edit-policy.mjs household/edit-policy.json
//   add --check to check the file against the live registry and write nothing
//
// Each entry is { table_name, columns: { "<column>": true }, add_rows, delete_rows }. Every entry
// is checked first and nothing is written if any fails. A row that matches the live one by value
// prints "no changes — already current" (src/proc/edit-policy.mjs planEditPolicies). A live row
// the file does not name is left as it is.

import { readFileSync }                   from 'fs';
import { resolve }                        from 'path';
import { getRows, insertRow, updateRows } from '../src/shared/serv-client.mjs';
import { planEditPolicies }               from '../src/proc/edit-policy.mjs';

if (!process.env.SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const fileArg   = process.argv.slice(2).find(a => a !== '--check');
if (!fileArg) {
  console.error('Usage: node dev_scripts/upsert-edit-policy.mjs <household/edit-policy.json> [--check]');
  process.exit(1);
}
const entries = JSON.parse(readFileSync(resolve(process.cwd(), fileArg), 'utf8'));

const read = async (table, columns) => {
  const resp = await getRows(table, [], undefined, 1000, undefined, columns);
  if (resp.truncated) throw new Error(`${table} read was cut short — refusing to compare against part of it`);
  return resp.rows ?? [];
};
const liveRows = await read('PGC_EditPolicy', ['table_name', 'columns', 'add_rows', 'delete_rows']);
const schemas  = await read('PGC_Schema', ['table_name', 'columns']);

const { problems, inserts, updates, current } = planEditPolicies(entries, liveRows, schemas);
if (problems.length) {
  console.error(`REFUSED — nothing written. ${problems.length} problem(s):`);
  for (const m of problems) console.error(`  ${m}`);
  process.exit(1);
}
for (const table of current) console.log(`${table}: no changes — already current`);
if (checkOnly) {
  console.log(`OK — ${entries.length} table(s) pass; ${inserts.length + updates.length} would be written. Nothing written (--check).`);
  process.exit(0);
}
const describe = r => `${Object.keys(r.columns).length} column(s) open, add_rows ${r.add_rows}, delete_rows ${r.delete_rows}`;
for (const row of inserts) {
  await insertRow('PGC_EditPolicy', row);
  console.log(`${row.table_name}: created — ${describe(row)}`);
}
for (const { table_name, ...policy } of updates) {
  await updateRows('PGC_EditPolicy', [{ column: 'table_name', op: 'eq', value: table_name }], policy);
  console.log(`${table_name}: updated — ${describe(policy)}`);
}
