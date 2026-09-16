// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/query-utils.test.mjs
//
// Covers src/serv/query-utils.mjs — the shared orderBy interpretation used by
// table.mjs getRows and entity.mjs listEntities, and getRows's read-limit attribution.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOrderBy, buildOrderClause, resolveReadLimit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT,
} from '../../src/serv/query-utils.mjs';

// ---------------------------------------------------------------------------
// normalizeOrderBy — the forms callers actually send
// ---------------------------------------------------------------------------

test('normalizeOrderBy: absent orderBy yields no sort terms', () => {
  assert.deepEqual(normalizeOrderBy(undefined), []);
  assert.deepEqual(normalizeOrderBy(null), []);
  assert.deepEqual(normalizeOrderBy(''), []);
});

test('normalizeOrderBy: object form is a one-element list', () => {
  assert.deepEqual(
    normalizeOrderBy({ column: 'priority', direction: 'desc' }),
    [{ column: 'priority', direction: 'desc' }],
  );
});

test('normalizeOrderBy: bare column string defaults to ascending', () => {
  assert.deepEqual(normalizeOrderBy('created_at'), [{ column: 'created_at', direction: 'asc' }]);
});

test('normalizeOrderBy: single-column SQL string keeps its direction', () => {
  assert.deepEqual(normalizeOrderBy('priority DESC'), [{ column: 'priority', direction: 'desc' }]);
  assert.deepEqual(normalizeOrderBy('sequence_number ASC'), [{ column: 'sequence_number', direction: 'asc' }]);
});

test('normalizeOrderBy: direction matching is case-insensitive', () => {
  assert.equal(normalizeOrderBy('priority desc')[0].direction, 'desc');
  assert.equal(normalizeOrderBy('priority Desc')[0].direction, 'desc');
  assert.equal(normalizeOrderBy({ column: 'priority', direction: 'DESC' })[0].direction, 'desc');
});

test('normalizeOrderBy: array of objects becomes a composite sort', () => {
  assert.deepEqual(
    normalizeOrderBy([{ column: 'priority', direction: 'desc' }, { column: 'id', direction: 'asc' }]),
    [{ column: 'priority', direction: 'desc' }, { column: 'id', direction: 'asc' }],
  );
});

test('normalizeOrderBy: array may mix object and string terms', () => {
  assert.deepEqual(
    normalizeOrderBy([{ column: 'priority', direction: 'desc' }, 'id ASC']),
    [{ column: 'priority', direction: 'desc' }, { column: 'id', direction: 'asc' }],
  );
});

test('normalizeOrderBy: terms with no column are dropped, not emitted as undefined', () => {
  assert.deepEqual(normalizeOrderBy([{ direction: 'desc' }, { column: 'id' }]), [{ column: 'id', direction: 'asc' }]);
  assert.deepEqual(normalizeOrderBy('  '), []);
  assert.deepEqual(normalizeOrderBy(['priority DESC', '', null]), [{ column: 'priority', direction: 'desc' }]);
});

// ---------------------------------------------------------------------------
// The regression this module exists for.
//
// Verified live against prod 2026-08-06: getRows on PGC_Memory with
// orderBy "priority DESC, id ASC" returned five priority-2 rows (the LOWEST
// priority) with ids in no order. The old normalizeOrderBy split on whitespace
// alone, so parts[1] was "DESC," — which failed the === 'desc' test and fell back
// to ASCENDING, and the second key vanished entirely. It did not error.
// ---------------------------------------------------------------------------

test('normalizeOrderBy: comma-separated SQL string no longer inverts direction', () => {
  const terms = normalizeOrderBy('priority DESC, id ASC');

  assert.equal(terms.length, 2, 'both sort keys survive');
  assert.deepEqual(terms, [
    { column: 'priority', direction: 'desc' },
    { column: 'id',       direction: 'asc'  },
  ]);
});

test('normalizeOrderBy: comma-separated string tolerates irregular spacing', () => {
  assert.deepEqual(
    normalizeOrderBy('  priority   DESC ,id   ASC  '),
    [{ column: 'priority', direction: 'desc' }, { column: 'id', direction: 'asc' }],
  );
});

test('normalizeOrderBy: three-key composite sort', () => {
  assert.deepEqual(
    normalizeOrderBy('domain ASC, priority DESC, created_at DESC'),
    [
      { column: 'domain',     direction: 'asc'  },
      { column: 'priority',   direction: 'desc' },
      { column: 'created_at', direction: 'desc' },
    ],
  );
});

// ---------------------------------------------------------------------------
// buildOrderClause
// ---------------------------------------------------------------------------

test('buildOrderClause: no terms yields an empty clause', () => {
  assert.equal(buildOrderClause([]), '');
  assert.equal(buildOrderClause(null), '');
  assert.equal(buildOrderClause(undefined), '');
});

test('buildOrderClause: single term is quoted and uppercased', () => {
  assert.equal(
    buildOrderClause([{ column: 'priority', direction: 'desc' }]),
    'ORDER BY "priority" DESC',
  );
});

test('buildOrderClause: composite terms are comma-joined in order', () => {
  assert.equal(
    buildOrderClause([{ column: 'priority', direction: 'desc' }, { column: 'id', direction: 'asc' }]),
    'ORDER BY "priority" DESC, "id" ASC',
  );
});

test('buildOrderClause: prefix qualifies every column, not just the first', () => {
  assert.equal(
    buildOrderClause([{ column: 'name', direction: 'asc' }, { column: 'id', direction: 'desc' }], 'r.'),
    'ORDER BY r."name" ASC, r."id" DESC',
  );
});

test('buildOrderClause: anything not "desc" renders ASC', () => {
  assert.equal(buildOrderClause([{ column: 'id', direction: 'sideways' }]), 'ORDER BY "id" ASC');
});

// ---------------------------------------------------------------------------
// Round trip — the shape assembleContext and serv_query steps rely on
// ---------------------------------------------------------------------------

test('round trip: the memory tiebreaker renders as intended', () => {
  const clause = buildOrderClause(normalizeOrderBy([
    { column: 'priority', direction: 'desc' },
    { column: 'id',       direction: 'asc'  },
  ]));
  assert.equal(clause, 'ORDER BY "priority" DESC, "id" ASC');
});

test('round trip: SQL string and array forms produce the same clause', () => {
  const fromString = buildOrderClause(normalizeOrderBy('priority DESC, id ASC'));
  const fromArray  = buildOrderClause(normalizeOrderBy([
    { column: 'priority', direction: 'desc' },
    { column: 'id',       direction: 'asc'  },
  ]));
  assert.equal(fromString, fromArray);
});

// ---------------------------------------------------------------------------
// resolveReadLimit — the bound a read applies, and who chose it
//
// A full read is only a silent cut when the caller never chose the bound. Run 815 failed
// because a similarity search's own vectorSearch.limit was reported as SERV's default, so
// every top-5 search that found 5 rows was refused as truncated.
// ---------------------------------------------------------------------------

test('resolveReadLimit: no stated limit takes the default', () => {
  assert.deepEqual(resolveReadLimit({}), { limit: DEFAULT_READ_LIMIT, chosenBy: 'default' });
  assert.deepEqual(resolveReadLimit({ vectorSearch: { column: 'c', queryText: 'q' } }),
    { limit: DEFAULT_READ_LIMIT, chosenBy: 'default' });
});

test('resolveReadLimit: an explicit limit is the caller\'s choice', () => {
  assert.deepEqual(resolveReadLimit({ limit: 10 }), { limit: 10, chosenBy: 'caller' });
  assert.deepEqual(resolveReadLimit({ limit: '10' }), { limit: 10, chosenBy: 'caller' });
});

test('resolveReadLimit: a vectorSearch.limit is the caller\'s choice (run 815)', () => {
  assert.deepEqual(resolveReadLimit({ vectorSearch: { limit: 5 } }), { limit: 5, chosenBy: 'caller' });
});

test('resolveReadLimit: a stated vectorSearch.limit above the default is honoured, not capped by it', () => {
  assert.deepEqual(resolveReadLimit({ vectorSearch: { limit: 500 } }), { limit: 500, chosenBy: 'caller' });
});

test('resolveReadLimit: where both are stated, the tighter one applies', () => {
  assert.deepEqual(resolveReadLimit({ limit: 8, vectorSearch: { limit: 5 } }), { limit: 5, chosenBy: 'caller' });
  assert.deepEqual(resolveReadLimit({ limit: 3, vectorSearch: { limit: 5 } }), { limit: 3, chosenBy: 'caller' });
});

test('resolveReadLimit: a request above the ceiling is bounded by SERV, not by the caller', () => {
  assert.deepEqual(resolveReadLimit({ limit: 5000 }), { limit: MAX_READ_LIMIT, chosenBy: 'ceiling' });
  assert.deepEqual(resolveReadLimit({ limit: MAX_READ_LIMIT }), { limit: MAX_READ_LIMIT, chosenBy: 'caller' });
});

test('resolveReadLimit: an unusable limit is no statement at all', () => {
  assert.deepEqual(resolveReadLimit({ limit: 'all' }), { limit: DEFAULT_READ_LIMIT, chosenBy: 'default' });
  assert.deepEqual(resolveReadLimit({ limit: 0 }),     { limit: DEFAULT_READ_LIMIT, chosenBy: 'default' });
  assert.deepEqual(resolveReadLimit({ limit: null }),  { limit: DEFAULT_READ_LIMIT, chosenBy: 'default' });
});
