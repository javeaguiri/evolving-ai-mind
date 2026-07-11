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

  const readable = columns.find(c =>
    !SYSTEM_COLUMNS.has(c.name)
    && !/embedding/i.test(c.name)
    && !UNREADABLE_TYPES.has(String(c.type ?? '').toLowerCase())
  );
  return readable?.name ?? null;
}
