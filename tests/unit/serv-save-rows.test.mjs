// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-save-rows.test.mjs
//
// POST /serv/table/saveRows — a grid's save (spec 3.12.0), and withVersion on getRows. The real
// route runs against a stubbed pg.Client holding one small table: a clean save, a conflict that
// writes nothing, the change log written in the same transaction, and every refusal.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';
import pg                                      from 'pg';

import { handle, checkRowWrites, findVersionConflicts, fieldChanges } from '../../src/serv/table.mjs';

const V1 = '2026-11-21 10:02:11.120391+00';
const V2 = '2026-11-22 09:14:03.551210+00';   // the save's transaction time

const COLUMNS = [
  { name: 'id',         type: 'serial' },
  { name: 'title',      type: 'text' },
  { name: 'amount',     type: 'numeric(10,2)' },
  { name: 'tags',       type: 'jsonb' },
  { name: 'title_embedding', type: 'vector(2560)' },   // no embed_source: nothing to compute
  { name: 'created_at', type: 'timestamptz' },
  { name: 'updated_at', type: 'timestamptz' },
];

let table;     // id → row as to_jsonb gives it, version in updated_at
let gateRow;   // the PGC_TableMap / PGC_Schema row
let calls;     // every [sql, params] the route sent
let failOn;    // a regex: the statement that throws

const proto = pg.Client.prototype;
const real  = { connect: proto.connect, query: proto.query, end: proto.end };

beforeEach(() => {
  table = new Map([
    [381, { id: 381, title: 'Shop A', amount: 30.1, tags: [], title_embedding: '[0.1]', created_at: '2026-11-01T00:00:00.000001+00:00', updated_at: V1 }],
    [377, { id: 377, title: 'Shop B', amount: 5,    tags: [], title_embedding: '[0.2]', created_at: '2026-11-01T00:00:00.000002+00:00', updated_at: V1 }],
  ]);
  gateRow = { allow_insert: true, allow_update: true, allow_delete: true, target: 'pgd', columns: COLUMNS };
  calls   = [];
  failOn  = null;
  let nextId = 384;

  proto.connect = async function () {};
  proto.end     = async function () {};
  proto.query   = async function (sql, params = []) {
    calls.push([sql, params]);
    if (failOn?.test(sql)) throw new Error('boom');
    if (/PGC_TableMap/.test(sql)) return { rows: gateRow ? [gateRow] : [] };
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/FOR UPDATE/.test(sql)) {
      return { rows: params[0].filter(id => table.has(id)).map(id => ({ row: { ...table.get(id) }, version: table.get(id).updated_at })) };
    }
    const back = row => ({ ...row, _version: row.updated_at, _json: { ...row } });
    if (/^\s*UPDATE/.test(sql)) {
      const id   = params.at(-1);
      const cols = [...sql.matchAll(/"(\w+)" = \$/g)].map(m => m[1]);
      const row  = { ...table.get(id), updated_at: V2 };
      cols.forEach((c, i) => { row[c] = c === 'tags' ? JSON.parse(params[i]) : params[i]; });
      table.set(id, row);
      return { rows: [back(row)], rowCount: 1 };
    }
    if (/^\s*INSERT INTO "PGD_/.test(sql)) {
      const cols = [...sql.match(/\(([^)]*)\)\s*VALUES/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
      const row  = { id: nextId++, title: null, amount: null, tags: [], title_embedding: null, created_at: '2026-11-22T09:14:03.55121+00:00', updated_at: V2 };
      cols.forEach((c, i) => { row[c] = params[i]; });
      table.set(row.id, row);
      return { rows: [back(row)], rowCount: 1 };
    }
    if (/^\s*DELETE/.test(sql)) {
      for (const id of params[0]) table.delete(id);
      return { rows: [], rowCount: params[0].length };
    }
    return { rows: [], rowCount: 0 };
  };
});
afterEach(() => Object.assign(proto, real));

const save = body => handle({ subRoute: 'saveRows', body, correlationId: 'c' });
const json = resp => JSON.parse(resp.body);
const sent = re => calls.filter(([sql]) => re.test(sql));
const LOG  = { actor: 'sub-1', via: 'web', domain: 'budgets' };

const GRID = {
  tableName: 'PGD_Expenses',
  update: [{ id: 381, version: V1, changes: { amount: 31.2 } }],
  insert: [{ title: 'Shop C', amount: 12.5 }],
  delete: [{ id: 377, version: V1 }],
};

describe('saveRows — a clean save', () => {
  it('writes the changed, new and removed rows in one transaction and returns them with new versions', async () => {
    const resp = await save(GRID);
    assert.equal(resp.statusCode, 200, resp.body);
    const b = json(resp);
    assert.deepEqual(b.updated.map(r => [r.id, r.amount, r._version]), [[381, 31.2, V2]]);
    assert.deepEqual(b.inserted.map(r => [r.id, r.title, r._version]), [[384, 'Shop C', V2]]);
    assert.deepEqual(b.deleted, [377]);
    assert.equal(b.updated[0].title_embedding, '[0.1]...');
    assert.ok(!('_json' in b.updated[0]) && !('_json' in b.inserted[0]));
    assert.equal(b.batchId, undefined);
    assert.deepEqual(sent(/^\s*(BEGIN|COMMIT|ROLLBACK)/).map(([s]) => s.trim()), ['BEGIN', 'COMMIT']);
    assert.equal(sent(/PGC_ChangeLog/).length, 0);
  });

  it('locks the rows it changes or removes before writing', async () => {
    await save(GRID);
    const order = calls.map(([s]) => s.trim().split(/\s+/)[0]);
    const lock  = calls.findIndex(([s]) => /FOR UPDATE/.test(s));
    assert.deepEqual(calls[lock][1], [[381, 377]]);
    assert.ok(lock < order.indexOf('UPDATE') && lock > order.indexOf('BEGIN'));
  });

  it('a save with inserts only takes no lock', async () => {
    const resp = await save({ tableName: 'PGD_Expenses', insert: [{ title: 'x' }] });
    assert.equal(resp.statusCode, 200, resp.body);
    assert.equal(sent(/FOR UPDATE/).length, 0);
  });

  it('writes a jsonb value as JSON text', async () => {
    await save({ tableName: 'PGD_Expenses', update: [{ id: 381, version: V1, changes: { tags: ['a'] } }] });
    assert.deepEqual(sent(/^\s*UPDATE/)[0][1], ['["a"]', 381]);
  });
});

describe('saveRows — the change log', () => {
  it('logs every row written in the same transaction, one batch, each field old and new', async () => {
    const resp = await save({ ...GRID, changeLog: LOG });
    assert.equal(resp.statusCode, 200, resp.body);
    const { batchId } = json(resp);
    assert.match(batchId, /^[0-9a-f-]{36}$/);

    const order = calls.map(([s]) => s.trim());
    const logAt = order.findIndex(s => /PGC_ChangeLog/.test(s));
    assert.ok(logAt > 0 && logAt < order.indexOf('COMMIT'));

    const [, values] = sent(/PGC_ChangeLog/)[0];
    const rows = [];
    for (let i = 0; i < values.length; i += 9) rows.push(values.slice(i, i + 9));
    assert.equal(rows.length, 3);
    for (const r of rows) assert.deepEqual(r.slice(0, 6), [batchId, 'sub-1', 'web', null, 'budgets', 'PGD_Expenses']);

    const byOp = Object.fromEntries(rows.map(r => [r[7], { id: r[6], changes: JSON.parse(r[8]) }]));
    assert.deepEqual(byOp.update, { id: '381', changes: { amount: { old: 30.1, new: 31.2 } } });
    assert.equal(byOp.insert.id, '384');
    assert.deepEqual(byOp.insert.changes.title, { new: 'Shop C' });
    assert.ok(!('updated_at' in byOp.insert.changes) && !('title_embedding' in byOp.insert.changes));
    assert.equal(byOp.delete.id, '377');
    assert.deepEqual(byOp.delete.changes.title, { old: 'Shop B' });
    assert.equal(byOp.delete.changes.created_at.old, '2026-11-01T00:00:00.000002+00:00');
    assert.ok(!('updated_at' in byOp.delete.changes) && !('title_embedding' in byOp.delete.changes));
  });

  it('carries runId when the caller names one', async () => {
    await save({ ...GRID, changeLog: { ...LOG, runId: 42, actor: null } });
    const [, values] = sent(/PGC_ChangeLog/)[0];
    assert.deepEqual(values.slice(1, 4), [null, 'web', 42]);
  });

  it('an update that changed nothing is not logged', async () => {
    const resp = await save({ tableName: 'PGD_Expenses', update: [{ id: 381, version: V1, changes: { amount: 30.1 } }], changeLog: LOG });
    assert.equal(resp.statusCode, 200, resp.body);
    assert.equal(json(resp).batchId, undefined);
    assert.equal(sent(/PGC_ChangeLog/).length, 0);
  });

  it('a failed log write rolls the save back', async () => {
    failOn = /PGC_ChangeLog/;
    const resp = await save({ ...GRID, changeLog: LOG });
    assert.equal(resp.statusCode, 500);
    assert.equal(sent(/^\s*COMMIT/).length, 0);
    assert.equal(sent(/^\s*ROLLBACK/).length, 1);
  });
});

describe('saveRows — a row that moved since it was read', () => {
  it('a changed row and a removed row fail the whole save with 409, nothing written', async () => {
    table.set(381, { ...table.get(381), updated_at: V2 });
    table.delete(377);
    const resp = await save({ ...GRID, changeLog: LOG });
    assert.equal(resp.statusCode, 409);
    assert.deepEqual(json(resp), { success: false, error: 'version_conflict', correlationId: 'c', conflicts: [
      { table: 'PGD_Expenses', id: 381, reason: 'changed' },
      { table: 'PGD_Expenses', id: 377, reason: 'deleted' },
    ] });
    assert.equal(sent(/^\s*(UPDATE|INSERT|DELETE)/).length, 0);
    assert.deepEqual(sent(/^\s*(BEGIN|COMMIT|ROLLBACK)/).map(([s]) => s.trim()), ['BEGIN', 'ROLLBACK']);
  });

  it('compares versions to the microsecond, as text', () => {
    const current = new Map([[1, { version: '2026-11-22 08:02:22.892341+00' }]]);
    assert.deepEqual(findVersionConflicts('T', [{ id: 1, version: '2026-11-22 08:02:22.892341+00' }], current), []);
    assert.deepEqual(findVersionConflicts('T', [{ id: 1, version: '2026-11-22 08:02:22.892+00' }], current),
      [{ table: 'T', id: 1, reason: 'changed' }]);
  });
});

describe('saveRows — a write that fails', () => {
  it('rolls back and answers 500', async () => {
    failOn = /^\s*INSERT INTO "PGD_/;
    const resp = await save(GRID);
    assert.equal(resp.statusCode, 500);
    assert.match(json(resp).error, /saveRows failed: boom/);
    assert.deepEqual(sent(/^\s*(BEGIN|COMMIT|ROLLBACK)/).map(([s]) => s.trim()), ['BEGIN', 'ROLLBACK']);
  });
});

describe('saveRows — refusals', () => {
  const refused = async (body, status, pattern) => {
    const resp = await save(body);
    assert.equal(resp.statusCode, status, resp.body);
    assert.match(json(resp).error, pattern);
    assert.equal(sent(/^\s*(BEGIN|UPDATE|INSERT|DELETE)/).length, 0);
  };

  it('a table that is not PGD_', () => refused({ ...GRID, tableName: 'PGC_Workflow' }, 400, /PGD_ table/));
  it('nothing to write', () => refused({ tableName: 'PGD_Expenses', update: [], insert: [] }, 400, /nothing to write/));
  it('a list that is not an array', () => refused({ tableName: 'PGD_Expenses', update: {} }, 400, /update must be an array/));
  it('a version passed through a Date', () =>
    refused({ tableName: 'PGD_Expenses', delete: [{ id: 377, version: '2026-11-21T10:02:11.120Z' }] }, 400, /delete\[0\]\.version/));
  it('an update without changes', () =>
    refused({ tableName: 'PGD_Expenses', update: [{ id: 381, version: V1, changes: {} }] }, 400, /update\[0\]\.changes/));
  it('an id that is not an integer', () =>
    refused({ tableName: 'PGD_Expenses', delete: [{ id: '377', version: V1 }] }, 400, /delete\[0\]\.id/));
  it('a row both changed and removed', () =>
    refused({ ...GRID, delete: [{ id: 381, version: V1 }] }, 400, /row 381 appears more than once/));
  it('a changeLog from an unknown writer', () => refused({ ...GRID, changeLog: { ...LOG, via: 'slack' } }, 400, /changeLog\.via/));
  it('a changeLog without its domain', () => refused({ ...GRID, changeLog: { via: 'web' } }, 400, /changeLog\.domain/));

  it('an unregistered table', () => { gateRow = null; return refused(GRID, 404, /not registered/); });
  for (const [kind, flag] of [['UPDATE', 'allow_update'], ['INSERT', 'allow_insert'], ['DELETE', 'allow_delete']]) {
    it(`${kind} not allowed by PGC_TableMap`, () => { gateRow[flag] = false; return refused(GRID, 403, new RegExp(`${kind} not permitted`)); });
  }
  it('an unknown column', () =>
    refused({ tableName: 'PGD_Expenses', insert: [{ colour: 'red' }] }, 400, /insert\[0\]: column "colour" not found/));
  for (const col of ['id', 'created_at', 'updated_at', 'title_embedding']) {
    it(`the system column ${col}`, () =>
      refused({ tableName: 'PGD_Expenses', update: [{ id: 381, version: V1, changes: { [col]: 1 } }] }, 400, new RegExp(`"${col}" is maintained by the system`)));
  }
  it('a table without updated_at', () => {
    gateRow.columns = COLUMNS.filter(c => c.name !== 'updated_at');
    return refused(GRID, 400, /no updated_at column/);
  });
});

describe('pure parts', () => {
  it('checkRowWrites accepts the spec example', () => {
    assert.equal(checkRowWrites({ ...GRID, changeLog: LOG }), null);
  });
  it('fieldChanges leaves out the columns it is told to skip', () => {
    assert.deepEqual(fieldChanges('insert', null, { id: 1, a: 2, updated_at: 'x' }, new Set(['updated_at'])), { id: { new: 1 }, a: { new: 2 } });
  });
  it('fieldChanges compares jsonb by value', () => {
    assert.deepEqual(fieldChanges('update', { t: ['a'] }, { t: ['a'] }, new Set(), ['t']), {});
  });
});

describe('getRows withVersion', () => {
  const read = body => handle({ subRoute: 'getRows', body: { tableName: 'PGD_Expenses', ...body }, correlationId: 'c' });

  it('selects each row\'s version as text', async () => {
    const resp = await read({ withVersion: true, columns: ['id', 'title'] });
    assert.equal(resp.statusCode, 200, resp.body);
    const [sql] = calls.find(([s]) => /^\s*SELECT .* FROM "PGD_Expenses"/s.test(s));
    assert.match(sql, /SELECT "id", "title", "updated_at"::text AS "_version" FROM/);
  });
  it('reads without a version by default', async () => {
    await read({});
    assert.ok(!calls.some(([s]) => /_version/.test(s)));
  });
  it('is refused on a table without updated_at', async () => {
    gateRow.columns = COLUMNS.filter(c => c.name !== 'updated_at');
    const resp = await read({ withVersion: true });
    assert.equal(resp.statusCode, 400);
    assert.match(json(resp).error, /withVersion needs an updated_at column/);
  });
});
