// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/edit-policy.mjs
//
// The edit policy (docs/arch-home-brain.md §4.8): what the web may change directly, one
// PGC_EditPolicy row per PGD_ table — the columns open to direct edits, add_rows, delete_rows.
// A table without a row, or a column not named, is read-only. Columns the system maintains are
// never opened by any row. Workflows never meet the policy: PROC checks it on the direct path.

import { stableStringify } from './fingerprint.mjs';

/**
 * The columns no policy row may open: the primary key, the timestamps, and vector columns,
 * which SERV computes.
 * Pure — exported for test.
 *
 * @param {object[]} schemaColumns  PGC_Schema.columns
 * @returns {Set<string>}
 */
export function systemMaintained(schemaColumns) {
  return new Set([
    'id', 'created_at', 'updated_at',
    ...schemaColumns.filter(c => c.type?.startsWith('vector')).map(c => c.name),
  ]);
}

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * What writing these policy rows would do. Every entry is checked first: a registered PGD_ table
 * with versions (updated_at), each named column one of its own and not one the system
 * maintains, opened with `true`. A row is compared by value, so a rerun with nothing changed
 * writes nothing. Live rows the entries do not name are left as they are.
 * Pure — exported for test.
 *
 * @param {object[]} entries   [{ table_name, columns, add_rows?, delete_rows? }] — absent flags are false
 * @param {object[]} liveRows  PGC_EditPolicy rows
 * @param {object[]} schemas   PGC_Schema rows { table_name, columns }
 * @returns {{ problems: string[], inserts: object[], updates: object[], current: string[] }}
 */
export function planEditPolicies(entries, liveRows, schemas) {
  const live    = new Map(liveRows.map(r => [r.table_name, r]));
  const schema  = new Map(schemas.map(s => [s.table_name, s.columns]));
  const seen    = new Set();
  const plan    = { problems: [], inserts: [], updates: [], current: [] };

  for (const entry of entries) {
    const table = entry?.table_name;
    if (typeof table !== 'string' || !table) { plan.problems.push('an entry names no table_name'); continue; }
    const fail = msg => plan.problems.push(`${table} — ${msg}`);
    if (seen.has(table)) { fail('named twice'); continue; }
    seen.add(table);
    if (!/^PGD_/.test(table)) { fail('only a PGD_ table has an edit policy'); continue; }
    const columns = schema.get(table);
    if (!columns) { fail('not registered in PGC_Schema'); continue; }
    const names = new Set(columns.map(c => c.name));
    if (!names.has('updated_at')) { fail('has no updated_at column — a table without versions accepts no direct edits'); continue; }
    if (!isRecord(entry.columns)) { fail('columns must be an object of { "<column>": true }'); continue; }
    for (const key of ['add_rows', 'delete_rows']) {
      if (entry[key] !== undefined && typeof entry[key] !== 'boolean') fail(`${key} must be true or false`);
    }
    const system = systemMaintained(columns);
    for (const [col, open] of Object.entries(entry.columns)) {
      if (!names.has(col))   fail(`column "${col}" not found in its schema`);
      else if (system.has(col)) fail(`column "${col}" is maintained by the system and is never editable directly`);
      else if (open !== true) fail(`column "${col}" must be opened with true`);
    }
    if (plan.problems.some(p => p.startsWith(`${table} — `))) continue;

    const row = { table_name: table, columns: entry.columns, add_rows: entry.add_rows ?? false, delete_rows: entry.delete_rows ?? false };
    const now = live.get(table);
    const same = now && stableStringify({ columns: now.columns, add_rows: now.add_rows, delete_rows: now.delete_rows })
                     === stableStringify({ columns: row.columns, add_rows: row.add_rows, delete_rows: row.delete_rows });
    if (same)     plan.current.push(table);
    else if (now) plan.updates.push(row);
    else          plan.inserts.push(row);
  }
  return plan;
}
