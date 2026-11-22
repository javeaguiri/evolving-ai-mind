// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/schema-utils.mjs
//
// Helpers for reasoning about a table's shape from its PGC_Schema `columns` array.
// Pure — no I/O. Callers fetch the schema row; these functions only interpret it.

// Columns the system owns. Never a meaningful label or match key.
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

// Types that cannot read as a human-facing value: rendering one dumps a blob into
// a Slack message, and matching a user-typed string against one never resolves.
const UNREADABLE_TYPES = new Set(['jsonb', 'json', 'vector', 'bytea']);

/**
 * Pick the column that best stands in for a row as its human-readable value.
 *
 * Schema-driven, not data-driven: choosing from whichever key happened to come
 * first in row[0] means the same table can label itself differently depending on
 * which rows came back.
 *
 * `preferred` is a strict priority order, not a set — the first name in the list
 * that the table actually has wins, regardless of its position in the schema.
 * Failing that, the first column that can genuinely read as a value: not a system
 * column, not an embedding, not a structured/vector blob.
 *
 * Returns null when a table offers nothing readable. Callers must decide what that
 * means for them — there is no universally safe fallback column name, and inventing
 * one ('name', say) just moves the failure downstream into a query against a column
 * that may not exist.
 *
 * @param {Array<{name: string, type: string}>} columns    PGC_Schema.columns
 * @param {object}   [options]
 * @param {string[]} [options.preferred]  Priority-ordered column names to prefer
 * @returns {string|null}
 */
export function pickLabelColumn(columns = [], { preferred = ['name', 'title'] } = {}) {
  const byName = new Set(columns.map(c => c.name));
  for (const candidate of preferred) {
    if (byName.has(candidate)) return candidate;
  }

  return columns.find(isReadableColumn)?.name ?? null;
}

/**
 * Can this column read as a value a person recognises — not a system column, not an embedding,
 * not a structured or binary blob? The rule pickLabelColumn falls back on, and the web app's list
 * view picks its detail columns by.
 *
 * @param {{name: string, type: string}} column
 * @returns {boolean}
 */
export function isReadableColumn(column) {
  return !SYSTEM_COLUMNS.has(column.name)
    && !/embedding/i.test(column.name)
    && !UNREADABLE_TYPES.has(String(column.type ?? '').toLowerCase());
}

/**
 * An entity's child tables: those of its joins whose registered foreign key references the root
 * table, each with the column that holds the parent's id. A join without one is not a child
 * collection. `tables` are PGC_Schema rows (SERV passes them with their PGC_TableMap flags, kept
 * as `gate`). Shared by SERV's saveEntity and PROC's record routes.
 *
 * @param {{ root_table: string, joins?: { table: string }[] }} entity  a PGC_EntitySchema row
 * @param {object[]} tables  PGC_Schema rows { table_name, columns, foreign_keys }
 * @returns {{ tableName: string, parentKey: string, columns: object[], gate: object }[]}
 */
export function childTablesOf(entity, tables) {
  const joined = new Set((entity.joins ?? []).map(j => j.table));
  return tables.filter(t => joined.has(t.table_name)).flatMap(t => {
    const fk = (t.foreign_keys ?? []).find(f => f.references?.table === entity.root_table);
    return fk ? [{ tableName: t.table_name, parentKey: fk.column, columns: t.columns, gate: t }] : [];
  });
}
