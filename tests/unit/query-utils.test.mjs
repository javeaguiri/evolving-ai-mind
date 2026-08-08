// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/query-utils.test.mjs
//
// Covers src/serv/query-utils.mjs — the shared orderBy interpretation used by
// table.mjs getRows and entity.mjs listEntities.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOrderBy, buildOrderClause } from '../../src/serv/query-utils.mjs';

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
