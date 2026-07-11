// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/classify-intent-crud.test.mjs
//
// Unit tests for the direct table-CRUD listing path in src/proc/classify-intent.mjs
// (`/m list <table>`). Imports the real functions — no local copies. classify-intent.mjs
// has no module-level side effects, so importing it is safe, same as
// classify-intent-tiers.test.mjs does for its sibling module.
//
// Run: node --test tests/unit/classify-intent-crud.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { formatTableCrudResult } from '../../src/proc/classify-intent.mjs';

// Mirrors CRUD_LIST_LIMIT in classify-intent.mjs. Not exported — it is an internal
// tuning value, not part of any contract — so the ceiling behaviour is asserted by
// driving the formatter with exactly this many rows.
const CRUD_LIST_LIMIT = 500;

const listing = (tableName, rows, labelColumn) =>
  formatTableCrudResult('serv_query', tableName, rows, {}, labelColumn);

// The label column itself is chosen by pickLabelColumn — see schema-utils.test.mjs.

describe('formatTableCrudResult — serv_query listing', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `row ${i + 1}` }));

  it('lists every row — the former 10-row slice is gone', () => {
    const out = listing('PGC_Workflow', rows(14), 'name');
    assert.ok(out.includes('Found 14 rows'));
    assert.ok(out.includes('14. row 14 (id: 14)'), 'the 14th row must be listed, not discarded');
    assert.ok(!out.includes('more.'), 'no truncation notice below the ceiling');
  });

  it('reports honestly when the row ceiling is reached', () => {
    const out = listing('PGC_SessionEntry', rows(CRUD_LIST_LIMIT), 'name');
    assert.ok(out.includes(`Showing the first ${CRUD_LIST_LIMIT} rows`),
      'must not report a truncated count as if it were the total');
    assert.ok(out.includes('there may be more'));
  });

  it('falls back to the id when there is no label column', () => {
    assert.ok(listing('PGC_Thing', [{ id: 7 }], null).includes('1. 7 (id: 7)'));
  });

  it('reports an empty table plainly', () => {
    assert.equal(listing('PGD_Empty', [], 'name'), 'No rows found in `PGD_Empty`.');
  });
});
