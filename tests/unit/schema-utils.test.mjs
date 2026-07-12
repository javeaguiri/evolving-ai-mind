// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/schema-utils.test.mjs
//
// Unit tests for src/shared/schema-utils.mjs. Pure functions, called directly.
//
// pickLabelColumn has two callers with different preference orders:
//   - classify-intent.mjs  (display)  — default ['name', 'title']
//   - step-executor.mjs    (matching) — ['name', 'label', 'code', 'title']
// Both are covered here, since the same function now serves both.
//
// Run: node --test tests/unit/schema-utils.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { pickLabelColumn } from '../../src/shared/schema-utils.mjs';

const REF_PREFERRED = { preferred: ['name', 'label', 'code', 'title'] };

describe('pickLabelColumn — preference order', () => {
  it('honours the priority order, not schema order', () => {
    // 'code' appears first in the schema, but 'name' outranks it. The old
    // step-executor implementation used a Set + .find(), so it returned whichever
    // preferred column came first in the schema — non-deterministic across tables
    // with the same columns declared in a different order.
    const columns = [
      { name: 'code', type: 'text' },
      { name: 'name', type: 'text' },
    ];
    assert.equal(pickLabelColumn(columns, REF_PREFERRED), 'name');
  });

  it('falls through the priority list in order', () => {
    assert.equal(pickLabelColumn([{ name: 'code', type: 'text' }, { name: 'title', type: 'text' }], REF_PREFERRED), 'code');
    assert.equal(pickLabelColumn([{ name: 'title', type: 'text' }], REF_PREFERRED), 'title');
  });

  it('defaults to name, then title, for the display caller', () => {
    assert.equal(pickLabelColumn([{ name: 'title', type: 'text' }, { name: 'name', type: 'text' }]), 'name');
    assert.equal(pickLabelColumn([{ name: 'description', type: 'text' }, { name: 'title', type: 'text' }]), 'title');
  });

  it('ignores a preferred column the table does not have', () => {
    assert.equal(pickLabelColumn([{ name: 'label', type: 'text' }], { preferred: ['name'] }), 'label',
      'no preferred match — falls through to the first readable column');
  });
});

describe('pickLabelColumn — fallback when nothing is preferred', () => {
  it('never picks a system column', () => {
    const columns = [
      { name: 'id',         type: 'serial' },
      { name: 'created_at', type: 'timestamptz' },
      { name: 'updated_at', type: 'timestamptz' },
      { name: 'quantity',   type: 'numeric' },
    ];
    assert.equal(pickLabelColumn(columns, REF_PREFERRED), 'quantity');
  });

  it('never picks a jsonb, vector, json or bytea column', () => {
    // The bug this fixes: step-executor's old fallback was cols[0] with no type
    // filter, so a reference table whose leading column is jsonb/vector handed that
    // column to resolveRefTableId as a lookup key — a filter that can never match.
    const columns = [
      { name: 'id',      type: 'serial' },
      { name: 'payload', type: 'jsonb' },
      { name: 'vec',     type: 'vector' },
      { name: 'blob',    type: 'bytea' },
      { name: 'unit',    type: 'text' },
    ];
    assert.equal(pickLabelColumn(columns, REF_PREFERRED), 'unit');
  });

  it('never picks an embedding column, whatever its declared type', () => {
    const columns = [
      { name: 'id',              type: 'serial' },
      { name: 'front_embedding', type: 'text' },
      { name: 'front',           type: 'text' },
    ];
    assert.equal(pickLabelColumn(columns), 'front');
  });
});

describe('pickLabelColumn — null when nothing is readable', () => {
  it('returns null rather than inventing a column name', () => {
    // The old step-executor fallback returned the literal string 'name' here, which
    // would then be built into a SQL filter against a column that does not exist.
    assert.equal(pickLabelColumn([{ name: 'id', type: 'serial' }, { name: 'payload', type: 'jsonb' }], REF_PREFERRED), null);
  });

  it('returns null on an empty or missing column list', () => {
    assert.equal(pickLabelColumn([]), null);
    assert.equal(pickLabelColumn(), null);
  });
});
