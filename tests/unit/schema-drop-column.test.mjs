// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/schema-drop-column.test.mjs
//
// dropColumn must prune every place PGC_Schema references the column, not just
// `columns`. `DROP COLUMN ... CASCADE` already does this in the database; the
// registry has to match, or it asserts things the database does not.
//
// Run 717 reproduction: dropping PGD_Budgets.type left chk_budgets_type behind in
// PGC_Schema.constraints — a CHECK on a column that no longer existed. Every LLM
// reading domain_schema then believed PGD_Budgets had a required, enum-constrained
// `type` column, because a CHECK on a column implies the column. analyze_workflow_gaps
// reasoned correctly from that and reported a blocking gap for a phantom column.
//
// Run: node --test tests/unit/schema-drop-column.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pruneColumnRefs } from '../../src/serv/schema.mjs';

describe('pruneColumnRefs — the registry must not outlive the column', () => {
  // The real PGD_Budgets registry row, as it stood when run 717 failed.
  const budgets = {
    columns: [
      { name: 'id',             type: 'serial' },
      { name: 'year',           type: 'integer' },
      { name: 'month',          type: 'integer' },
      { name: 'category_id',    type: 'integer' },
      { name: 'planned_amount', type: 'numeric' },
      { name: 'type',           type: 'varchar(50)' },
    ],
    constraints: [
      { name: 'chk_budgets_year',  type: 'check', columns: ['year'],  expression: 'year >= 2000 AND year <= 2100' },
      { name: 'chk_budgets_month', type: 'check', columns: ['month'], expression: 'month >= 1 AND month <= 12' },
      { name: 'chk_budgets_type',  type: 'check', columns: ['type'],  expression: "type IN ('income', 'discretionary', 'non_discretionary', 'savings')" },
    ],
    foreign_keys: [
      { name: 'fk_budgets_spendingcategories', column: 'category_id', references: { table: 'PGD_SpendingCategories', column: 'id' } },
    ],
  };

  it('removes the CHECK constraint that outlived its column (run 717)', () => {
    const pruned = pruneColumnRefs(budgets, 'type');

    assert.equal(pruned.columns.some(c => c.name === 'type'), false);
    assert.equal(pruned.constraints.some(c => c.name === 'chk_budgets_type'), false,
      'a CHECK on the dropped column implies the column still exists — it must go');
    // Everything else survives untouched.
    assert.deepEqual(pruned.constraints.map(c => c.name), ['chk_budgets_year', 'chk_budgets_month']);
    assert.equal(pruned.foreign_keys.length, 1);
  });

  it('removes a foreign key declared on the dropped column', () => {
    const pruned = pruneColumnRefs(budgets, 'category_id');

    assert.equal(pruned.foreign_keys.length, 0, 'an FK on the dropped column cannot survive it');
    assert.equal(pruned.columns.some(c => c.name === 'category_id'), false);
    // Constraints on other columns are unaffected.
    assert.equal(pruned.constraints.length, 3);
  });

  it('removes a composite constraint that merely includes the dropped column', () => {
    const table = {
      columns:      [{ name: 'a' }, { name: 'b' }],
      constraints:  [{ name: 'uq_a_b', type: 'unique', columns: ['a', 'b'] }],
      foreign_keys: [],
    };
    const pruned = pruneColumnRefs(table, 'b');

    assert.equal(pruned.constraints.length, 0,
      'unique(a, b) cannot survive the loss of b — CASCADE has already dropped it in the DB');
  });

  it('leaves everything alone when the column is referenced nowhere else', () => {
    const pruned = pruneColumnRefs(budgets, 'planned_amount');

    assert.equal(pruned.constraints.length, 3);
    assert.equal(pruned.foreign_keys.length, 1);
    assert.equal(pruned.columns.some(c => c.name === 'planned_amount'), false);
  });

  it('tolerates a registry row with missing arrays', () => {
    const pruned = pruneColumnRefs({ columns: [{ name: 'x' }] }, 'x');

    assert.deepEqual(pruned, { columns: [], constraints: [], foreign_keys: [] });
  });
});
