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
import { pruneColumnRefs, upsertConstraint } from '../../src/serv/schema.mjs';

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

// ---------------------------------------------------------------------------
// upsertConstraint — the registry must record every CHECK the database enforces.
//
// The DDL is an upsert (DROP IF EXISTS, then ADD), so it creates constraints that
// did not exist. The registry sync was a pure .map(), which silently did nothing for
// a new one — so adding a CHECK left the database enforcing a rule PGC_Schema had
// never heard of. Inverse of the pruneColumnRefs bug, and it matters just as much:
// domain_schema is built FROM PGC_Schema, and design_workflow_process reads a
// column's allowed values out of its CHECK expression there. A constraint missing
// from the registry is invisible to the LLM, so generated workflows keep emitting
// values the database will reject.
// ---------------------------------------------------------------------------

describe('upsertConstraint — a CHECK the DB enforces must be in the registry', () => {
  const existing = [
    { name: 'uq_spendingcategories_name', type: 'unique', columns: ['name'] },
  ];

  it('appends a brand-new CHECK (the case that silently did nothing)', () => {
    const result = upsertConstraint(
      existing, 'chk_spendingcategories_type',
      "type IN ('income', 'discretionary', 'non_discretionary', 'savings')",
      ['type'],
    );

    assert.equal(result.length, 2);
    const added = result.find(c => c.name === 'chk_spendingcategories_type');
    assert.ok(added, 'a new constraint must be added, not dropped on the floor');
    assert.equal(added.type, 'check');
    assert.deepEqual(added.columns, ['type']);
    assert.match(added.expression, /non_discretionary/);
    // The pre-existing constraint survives untouched.
    assert.ok(result.some(c => c.name === 'uq_spendingcategories_name'));
  });

  it('updates the expression when the constraint already exists, without duplicating it', () => {
    const withCheck = [
      ...existing,
      { name: 'chk_x', type: 'check', columns: ['x'], expression: "x IN ('a')" },
    ];
    const result = upsertConstraint(withCheck, 'chk_x', "x IN ('a', 'b')", ['x']);

    assert.equal(result.length, withCheck.length, 'must not append a duplicate');
    assert.equal(result.find(c => c.name === 'chk_x').expression, "x IN ('a', 'b')");
    assert.deepEqual(result.find(c => c.name === 'chk_x').columns, ['x'], 'existing columns preserved');
  });

  it('handles a table with no constraints yet', () => {
    const result = upsertConstraint(undefined, 'chk_y', 'y > 0', ['y']);
    assert.deepEqual(result, [{ name: 'chk_y', type: 'check', columns: ['y'], expression: 'y > 0' }]);
  });

  it('tolerates columns being omitted', () => {
    const result = upsertConstraint([], 'chk_z', 'z > 0');
    assert.deepEqual(result[0].columns, []);
  });
});
