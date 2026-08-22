// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/schema-add-constraint.test.mjs
//
// addForeignKey / addUniqueConstraint — the pure halves.
//
// createTable was the only place a foreign key or a UNIQUE constraint could ever
// be created, so a relationship introduced after a domain was built had no route:
// modifyConstraint emits CHECK only, and updateTable writes PGC_Schema without
// touching DDL — which would leave the registry asserting a constraint the
// database does not enforce.
//
// Every identifier in these payloads is interpolated into a SQL string, so
// validateForeignKey is a security gate and not merely input hygiene. The DDL is
// parameterless by necessity — PostgreSQL does not accept bind parameters for
// identifiers — which is exactly why the pattern checks are tested here.
//
// Run: node --test tests/unit/schema-add-constraint.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateForeignKey, upsertForeignKey } from '../../src/serv/schema.mjs';

const valid = {
  name:       'fk_inventory_category',
  column:     'category_id',
  references: { table: 'PGD_InventoryCategory', column: 'id' },
  onDelete:   'SET NULL',
};

describe('validateForeignKey — accepts a well-formed spec', () => {
  it('returns null for a valid foreign key', () => {
    assert.equal(validateForeignKey(valid), null);
  });

  it('defaults onDelete to NO ACTION when omitted', () => {
    const { onDelete, ...withoutOnDelete } = valid;
    assert.equal(validateForeignKey(withoutOnDelete), null);
  });

  it('accepts every allowed onDelete action, case-insensitively', () => {
    for (const action of ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'cascade', 'set null']) {
      assert.equal(validateForeignKey({ ...valid, onDelete: action }), null, action);
    }
  });
});

describe('validateForeignKey — rejects anything unsafe to interpolate', () => {
  it('rejects a missing spec', () => {
    assert.match(validateForeignKey(undefined), /required/);
    assert.match(validateForeignKey(null), /required/);
  });

  it('rejects a constraint name with SQL punctuation', () => {
    assert.match(validateForeignKey({ ...valid, name: 'fk"; DROP TABLE "PGD_Inventory' }), /constraint name/);
  });

  it('rejects an uppercase or leading-digit constraint name', () => {
    assert.match(validateForeignKey({ ...valid, name: 'FK_Inventory' }), /constraint name/);
    assert.match(validateForeignKey({ ...valid, name: '1fk' }), /constraint name/);
  });

  it('rejects a referencing column with a quote in it', () => {
    assert.match(validateForeignKey({ ...valid, column: 'category_id" , "x' }), /column name/);
  });

  it('rejects a referenced table outside the PGC_/PGD_ namespace', () => {
    assert.match(validateForeignKey({ ...valid, references: { table: 'pg_catalog', column: 'id' } }), /referenced table/);
    assert.match(validateForeignKey({ ...valid, references: { table: 'PGD_X"; --', column: 'id' } }), /referenced table/);
  });

  it('rejects a missing references block', () => {
    assert.match(validateForeignKey({ ...valid, references: undefined }), /referenced table/);
  });

  it('rejects a referenced column that is not a plain identifier', () => {
    assert.match(validateForeignKey({ ...valid, references: { table: 'PGD_InventoryCategory', column: 'id)' } }), /referenced column/);
  });

  it('rejects an onDelete action outside the allowed set', () => {
    // SET DEFAULT is real SQL and still refused — the allowed set is deliberate,
    // not a spelling check, because a column with no default silently errors later.
    assert.match(validateForeignKey({ ...valid, onDelete: 'SET DEFAULT' }), /not allowed/);
  });
});

describe('upsertForeignKey — a re-issued request converges', () => {
  it('appends when the named key is new', () => {
    const result = upsertForeignKey([], valid);
    assert.deepEqual(result, [valid]);
  });

  it('treats null existing as empty', () => {
    assert.deepEqual(upsertForeignKey(null, valid), [valid]);
    assert.deepEqual(upsertForeignKey(undefined, valid), [valid]);
  });

  it('replaces in place when the name already exists, rather than duplicating', () => {
    const stale  = { ...valid, onDelete: 'CASCADE' };
    const result = upsertForeignKey([stale], valid);
    assert.equal(result.length, 1);
    assert.equal(result[0].onDelete, 'SET NULL');
  });

  it('leaves other foreign keys on the table untouched', () => {
    const other  = { name: 'fk_inventory_other', column: 'other_id',
                     references: { table: 'PGD_Other', column: 'id' }, onDelete: 'CASCADE' };
    const result = upsertForeignKey([other], valid);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], other);
    assert.deepEqual(result[1], valid);
  });

  it('preserves order when replacing, so the registry does not churn', () => {
    const first  = { name: 'fk_a', column: 'a_id', references: { table: 'PGD_A', column: 'id' }, onDelete: 'CASCADE' };
    const last   = { name: 'fk_z', column: 'z_id', references: { table: 'PGD_Z', column: 'id' }, onDelete: 'CASCADE' };
    const result = upsertForeignKey([first, valid, last], { ...valid, onDelete: 'RESTRICT' });
    assert.deepEqual(result.map(fk => fk.name), ['fk_a', 'fk_inventory_category', 'fk_z']);
    assert.equal(result[1].onDelete, 'RESTRICT');
  });
});
