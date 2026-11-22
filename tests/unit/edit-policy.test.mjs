// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/edit-policy.test.mjs
//
// planEditPolicies — what dev_scripts/upsert-edit-policy.mjs writes to PGC_EditPolicy from the
// household's file: every entry checked against the live registry before anything is written,
// system-maintained columns never opened, and a rerun with nothing changed writing nothing.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { planEditPolicies, systemMaintained } from '../../src/proc/edit-policy.mjs';

const col = (name, type = 'text') => ({ name, type });
const SCHEMAS = [
  { table_name: 'PGD_Things', columns: [col('id', 'serial'), col('created_at', 'timestamptz'), col('updated_at', 'timestamptz'),
                                        col('name'), col('size', 'integer'), col('name_embedding', 'vector(4)')] },
  { table_name: 'PGD_Notes',  columns: [col('id', 'serial'), col('text')] },   // no updated_at
  { table_name: 'PGC_Page',   columns: [col('id', 'serial'), col('updated_at', 'timestamptz')] },
];
const THINGS = { table_name: 'PGD_Things', columns: { name: true, size: true }, add_rows: true, delete_rows: false };

describe('systemMaintained', () => {
  it('the key, the timestamps and every vector column', () => {
    assert.deepEqual([...systemMaintained(SCHEMAS[0].columns)].sort(), ['created_at', 'id', 'name_embedding', 'updated_at']);
  });
});

describe('planEditPolicies', () => {
  it('a table without a live row is inserted', () => {
    const plan = planEditPolicies([THINGS], [], SCHEMAS);
    assert.deepEqual(plan, { problems: [], inserts: [THINGS], updates: [], current: [] });
  });

  it('absent flags are false', () => {
    const { inserts } = planEditPolicies([{ table_name: 'PGD_Things', columns: {} }], [], SCHEMAS);
    assert.deepEqual(inserts, [{ table_name: 'PGD_Things', columns: {}, add_rows: false, delete_rows: false }]);
  });

  it('a live row equal by value is current — key order does not matter', () => {
    const live = [{ table_name: 'PGD_Things', columns: { size: true, name: true }, add_rows: true, delete_rows: false }];
    assert.deepEqual(planEditPolicies([THINGS], live, SCHEMAS), { problems: [], inserts: [], updates: [], current: ['PGD_Things'] });
  });

  it('a live row that differs is updated', () => {
    const live = [{ table_name: 'PGD_Things', columns: { name: true }, add_rows: true, delete_rows: false }];
    assert.deepEqual(planEditPolicies([THINGS], live, SCHEMAS).updates, [THINGS]);
  });

  it('a live row the file does not name is left alone', () => {
    const live = [{ table_name: 'PGD_Other', columns: {}, add_rows: false, delete_rows: false }];
    assert.deepEqual(planEditPolicies([THINGS], live, SCHEMAS), { problems: [], inserts: [THINGS], updates: [], current: [] });
  });

  for (const [what, entry, pattern] of [
    ['no table_name',                 { columns: {} },                                                  /names no table_name/],
    ['a PGC table',                   { table_name: 'PGC_Page', columns: {} },                          /only a PGD_ table/],
    ['an unregistered table',         { table_name: 'PGD_Missing', columns: {} },                       /not registered/],
    ['a table without updated_at',    { table_name: 'PGD_Notes', columns: { text: true } },             /no updated_at column/],
    ['columns not an object',         { table_name: 'PGD_Things', columns: ['name'] },                  /columns must be an object/],
    ['an unknown column',             { table_name: 'PGD_Things', columns: { colour: true } },          /"colour" not found/],
    ['the primary key',               { table_name: 'PGD_Things', columns: { id: true } },              /"id" is maintained by the system/],
    ['a timestamp',                   { table_name: 'PGD_Things', columns: { updated_at: true } },      /"updated_at" is maintained by the system/],
    ['a vector column',               { table_name: 'PGD_Things', columns: { name_embedding: true } },  /"name_embedding" is maintained by the system/],
    ['a column opened with false',    { table_name: 'PGD_Things', columns: { name: false } },           /"name" must be opened with true/],
    ['a flag that is not a boolean',  { table_name: 'PGD_Things', columns: {}, add_rows: 'yes' },       /add_rows must be true or false/],
  ]) {
    it(`refuses ${what}`, () => {
      const plan = planEditPolicies([entry], [], SCHEMAS);
      assert.equal(plan.problems.length, 1, plan.problems.join('; '));
      assert.match(plan.problems[0], pattern);
      assert.deepEqual([plan.inserts, plan.updates], [[], []]);
    });
  }

  it('refuses a table named twice', () => {
    assert.match(planEditPolicies([THINGS, THINGS], [], SCHEMAS).problems[0], /PGD_Things — named twice/);
  });
});
