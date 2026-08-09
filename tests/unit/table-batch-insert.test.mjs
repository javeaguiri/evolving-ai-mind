// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/table-batch-insert.test.mjs
//
// A batch insert takes its column list from the FIRST row and validates only that row's
// names against the schema. Every other row is then rendered against that list, so a row
// with a different key set does not fail — a column row 0 lacks is dropped, and one row 0
// has that this row does not goes in as null. The statement succeeds and the data is wrong.
//
// The step type contract now tells the LLM to prefer the batch form over an iterator of
// single-row inserts, so this is the failure mode that gets more traffic, not less.
//
// Run: node --test tests/unit/table-batch-insert.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findColumnSetMismatch } from '../../src/serv/table.mjs';

describe('findColumnSetMismatch — a batch must be homogeneous', () => {
  it('accepts rows that all carry the same columns', () => {
    assert.equal(findColumnSetMismatch([
      { name: 'a', quantity: 1 },
      { name: 'b', quantity: 2 },
      { name: 'c', quantity: 3 },
    ]), -1);
  });

  it('accepts a single-row batch', () => {
    assert.equal(findColumnSetMismatch([{ name: 'a' }]), -1);
  });

  it('ignores key ORDER — same columns, different insertion order, is one shape', () => {
    assert.equal(findColumnSetMismatch([
      { name: 'a', quantity: 1 },
      { quantity: 2, name: 'b' },
    ]), -1);
  });

  it('reports a row that omits a column — it would have been written as null', () => {
    assert.equal(findColumnSetMismatch([
      { name: 'a', quantity: 1 },
      { name: 'b' },
    ]), 1);
  });

  it('reports a row that adds a column — it would have been silently dropped', () => {
    assert.equal(findColumnSetMismatch([
      { name: 'a' },
      { name: 'b', quantity: 2 },
    ]), 1);
  });

  it('reports the FIRST mismatch, not the last', () => {
    assert.equal(findColumnSetMismatch([
      { name: 'a', quantity: 1 },
      { name: 'b' },
      { name: 'c' },
    ]), 1);
  });

  it('catches the partially-enriched batch — the shape a js_transform actually produces', () => {
    // An expression that adds a resolved foreign key only where a lookup succeeded.
    // Row 0 carries it, so the column list includes it and every unmatched row inserts null.
    assert.equal(findColumnSetMismatch([
      { name: 'a', category_id: 4 },
      { name: 'b', category_id: 7 },
      { name: 'c' },
    ]), 2);
  });
});
