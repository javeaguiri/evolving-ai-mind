// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/query-utils.mjs
// Pure interpretation of the SERV read wire format. No I/O, no pg client.
//
// Shared by table.mjs (getRows) and entity.mjs (listEntities) — the two places a
// caller-supplied orderBy becomes an ORDER BY clause. Kept in one place so the two
// cannot drift: before this module existed they disagreed, and entity.mjs accepted
// only the object form while table.mjs also accepted a string.

/**
 * Normalise orderBy to an array of { column, direction }, whatever form it arrives in.
 *
 * A sort is a LIST of terms — a single term is the one-element case, not a different
 * kind of thing. Returning an array always means neither caller carries a branch for
 * "one key" versus "several".
 *
 * Accepted forms, all standard:
 *   "created_at"                          → [{ created_at, asc }]
 *   "priority DESC"                       → [{ priority, desc }]
 *   "priority DESC, id ASC"               → [{ priority, desc }, { id, asc }]
 *   { column, direction }                 → [{ column, direction }]
 *   [{ column, direction }, "id ASC"]     → both terms, mixed forms
 *
 * The comma-separated string is why this function exists. It used to split on
 * whitespace alone, so "priority DESC, id ASC" yielded direction "desc," — which
 * failed the === 'desc' test and fell back to ASCENDING while silently dropping the
 * second key. It did not error: it returned the lowest-priority rows in no order.
 *
 * @param {string|object|Array|null} orderBy
 * @returns {Array<{column: string, direction: 'asc'|'desc'}>} empty when nothing to sort by
 */
export function normalizeOrderBy(orderBy) {
  if (!orderBy) return [];

  const terms = Array.isArray(orderBy)
    ? orderBy
    : typeof orderBy === 'object'
      ? [orderBy]
      : String(orderBy).split(',');

  return terms.flatMap(normalizeTerm);
}

/**
 * One sort term → [{ column, direction }], or [] if it carries no column.
 * A term is itself either an object or a "col DIR" string.
 */
function normalizeTerm(term) {
  if (!term) return [];

  if (typeof term === 'object') {
    if (!term.column) return [];
    return [{ column: term.column, direction: toDirection(term.direction) }];
  }

  const parts = String(term).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  return [{ column: parts[0], direction: toDirection(parts[1]) }];
}

/** Anything that is not an explicit descending marker sorts ascending. */
function toDirection(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
}

/**
 * Render normalised sort terms as an ORDER BY clause.
 *
 * Column names are interpolated, so every caller must validate them against the
 * table's registered columns first — the same gate filters go through. `prefix`
 * qualifies each column with a table alias (entity.mjs joins, so it needs "r.").
 *
 * @param {Array<{column: string, direction: string}>} terms  from normalizeOrderBy
 * @param {string} prefix  optional alias prefix, e.g. 'r.'
 * @returns {string} 'ORDER BY ...' or '' when there is nothing to sort by
 */
export function buildOrderClause(terms, prefix = '') {
  if (!terms?.length) return '';
  const rendered = terms.map(t => `${prefix}"${t.column}" ${t.direction === 'desc' ? 'DESC' : 'ASC'}`);
  return `ORDER BY ${rendered.join(', ')}`;
}
