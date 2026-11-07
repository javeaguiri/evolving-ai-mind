// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-write-vectors.test.mjs
//
// No SERV write echoes a full vector back. Reads already truncated (table) or stripped (entity)
// vector columns, but every write returned its row with `RETURNING *` untouched, so each
// `update_data` / `insert_data` reply Novia read in session 1293 carried a 2,560-number
// `name_embedding` — about 9,000 characters per call, re-read on every later turn.
// The real routes run here against a stubbed pg.Client.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';
import pg                                      from 'pg';

import { handle as tableHandle, truncateVectorColumns } from '../../src/serv/table.mjs';
import { handle as entityHandle }                       from '../../src/serv/entity.mjs';

const VECTOR  = `[${Array.from({ length: 2560 }, (_, i) => (i % 7) / 10).join(',')}]`;
const COLUMNS = [
  { name: 'id', type: 'serial' },
  { name: 'name', type: 'text' },
  { name: 'name_embedding', type: 'vector(2560)' },   // no embed_source: nothing to compute
];
const ROW = { id: 7, name: 'a', name_embedding: VECTOR };

const proto = pg.Client.prototype;
const real  = { connect: proto.connect, query: proto.query, end: proto.end };

beforeEach(() => {
  proto.connect = async function () {};
  proto.end     = async function () {};
  proto.query   = async function (sql) {
    if (/PGC_EntitySchema/.test(sql)) {
      return { rows: [{ entity_name: 'thing', root_table: 'PGD_X', schema_columns: COLUMNS, target: 'pgd',
        allow_insert: true, allow_update: true, allow_delete: true, upsert_key: ['name'] }] };
    }
    if (/PGC_TableMap/.test(sql)) {
      return { rows: [{ id: 1, target: 'pgd', allow_insert: true, allow_update: true, allow_delete: true, columns: COLUMNS }] };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/^\s*SELECT id FROM/.test(sql)) return { rows: [] };
    if (/was_inserted/.test(sql)) return { rows: [{ ...ROW, was_inserted: true }], rowCount: 1 };
    return { rows: [{ ...ROW }], rowCount: 1 };
  };
});
afterEach(() => Object.assign(proto, real));

const body = (resp) => JSON.parse(resp.body);

describe('truncateVectorColumns', () => {
  it('cuts a vector column to five characters and a marker', () => {
    assert.deepEqual(truncateVectorColumns([ROW], COLUMNS), [{ id: 7, name: 'a', name_embedding: '[0,0....' }]);
  });
  it('keeps null as null and leaves a column the projection excluded absent', () => {
    assert.deepEqual(truncateVectorColumns([{ id: 1, name_embedding: null }, { id: 2 }], COLUMNS),
      [{ id: 1, name_embedding: null }, { id: 2 }]);
  });
  it('returns the rows untouched when the table has no vector column', () => {
    const rows = [{ id: 1 }];
    assert.equal(truncateVectorColumns(rows, [{ name: 'id', type: 'serial' }]), rows);
  });
});

describe('SERV-Table writes return no full vector', () => {
  for (const [subRoute, req, pick] of [
    ['insertRow',  { tableName: 'PGD_X', row: { name: 'a' } },                 b => [b.row]],
    ['insertRow',  { tableName: 'PGD_X', rows: [{ name: 'a' }, { name: 'b' }] }, b => b.rows],
    ['updateRows', { tableName: 'PGD_X', filters: [{ column: 'id', op: 'eq', value: 7 }], updates: { name: 'b' } }, b => b.rows],
    ['upsertRows', { tableName: 'PGD_X', matchColumns: ['name'], rows: [{ name: 'a' }] }, b => [...b.inserted, ...b.updated]],
  ]) {
    it(`${subRoute}${req.rows && subRoute === 'insertRow' ? ' (batch)' : ''}`, async () => {
      const resp = await tableHandle({ subRoute, body: req, correlationId: 'c' });
      assert.equal(resp.statusCode, 200, resp.body);
      const rows = pick(body(resp));
      assert.ok(rows.length > 0);
      for (const r of rows) assert.equal(r.name_embedding, '[0,0....');
    });
  }
});

describe('SERV-Entity writes return no vector', () => {
  for (const [subRoute, req] of [
    ['createEntity', { entityName: 'thing', row: { name: 'a' } }],
    ['updateEntity', { entityName: 'thing', id: 7, updates: { name: 'b' } }],
    ['upsertEntity', { entityName: 'thing', row: { name: 'a' } }],
  ]) {
    it(subRoute, async () => {
      const resp = await entityHandle({ subRoute, body: req, correlationId: 'c' });
      assert.equal(resp.statusCode, 200, resp.body);
      const { row } = body(resp);
      assert.equal(row.id, 7);
      assert.ok(!('name_embedding' in row), 'the vector column is stripped, as entity reads strip it');
    });
  }
});
