// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/table-upsert-unkeyed.test.mjs
//
// A single save step serving both Add and Edit upserts on id, and a new record has no id yet —
// the form state carries ''. upsertRows looked that up as WHERE id = '' and Postgres refused
// the cast (run 904). A row whose match columns are all empty is new: it skips the lookup and
// is inserted without them, so the database assigns them.
//
// Run: node --test tests/unit/table-upsert-unkeyed.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unkeyedInsertRow } from '../../src/serv/table.mjs';

describe('unkeyedInsertRow — a row with no key value is a new record', () => {
  it('drops an empty-string id and inserts the rest (run 904)', () => {
    assert.deepEqual(
      unkeyedInsertRow({ id: '', title: 'a', amount: 93.1 }, ['id']),
      { title: 'a', amount: 93.1 }
    );
  });

  it('treats null and an absent key as empty too', () => {
    assert.deepEqual(unkeyedInsertRow({ id: null, title: 'a' }, ['id']), { title: 'a' });
    assert.deepEqual(unkeyedInsertRow({ title: 'a' }, ['id']), { title: 'a' });
  });

  it('returns null for a row that carries a key — it is looked up as before', () => {
    assert.equal(unkeyedInsertRow({ id: '257', title: 'a' }, ['id']), null);
    assert.equal(unkeyedInsertRow({ id: 0, title: 'a' }, ['id']), null);
  });

  it('needs EVERY match column empty — one value present is a key to look up', () => {
    assert.equal(unkeyedInsertRow({ year: 2026, month: '', amount: 1 }, ['year', 'month']), null);
    assert.deepEqual(
      unkeyedInsertRow({ year: '', month: null, amount: 1 }, ['year', 'month']),
      { amount: 1 }
    );
  });

  it('does not mutate the caller\'s row', () => {
    const row = { id: '', title: 'a' };
    unkeyedInsertRow(row, ['id']);
    assert.deepEqual(row, { id: '', title: 'a' });
  });
});
