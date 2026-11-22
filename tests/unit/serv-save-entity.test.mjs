// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-save-entity.test.mjs
//
// POST /serv/entity/saveEntity — a document's save (spec 3.12.0), and getEntity withVersion with
// its children. The real routes run against a stubbed pg.Client holding one invented entity: a
// root, two child tables whose foreign key references it, and one joined table whose foreign key
// points elsewhere — joined, but not a child.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';
import pg                                      from 'pg';

import { handle, checkEntityWrites, childTablesOf } from '../../src/serv/entity.mjs';

const V1 = '2026-11-21 09:31:10.551203+00';
const V2 = '2026-11-22 09:20:41.004113+00';   // the save's transaction time

const col = (name, type = 'text') => ({ name, type });
const SYS = [col('id', 'serial'), col('created_at', 'timestamptz'), col('updated_at', 'timestamptz')];

const ROOT_COLUMNS = [...SYS, col('title'), col('servings', 'integer'), col('title_embedding', 'vector(4)')];
const SCHEMAS = {
  PGD_Parts: { columns: [...SYS, col('parent_id', 'integer'), col('thing_id', 'integer'), col('quantity', 'numeric')],
               foreign_keys: [{ column: 'parent_id', references: { table: 'PGD_Roots', column: 'id' } },
                              { column: 'thing_id',  references: { table: 'PGD_Things', column: 'id' } }] },
  PGD_Steps: { columns: [...SYS, col('parent_id', 'integer'), col('step_number', 'integer'), col('text')],
               foreign_keys: [{ column: 'parent_id', references: { table: 'PGD_Roots', column: 'id' } }] },
  PGD_Kinds: { columns: [...SYS, col('name')],
               foreign_keys: [] },   // joined by the root's kind_id: not a child
};
const JOINS = [
  { table: 'PGD_Parts', alias: 'parts', on: 'parts.parent_id = r.id' },
  { table: 'PGD_Steps', alias: 'steps', on: 'steps.parent_id = r.id' },
  { table: 'PGD_Kinds', alias: 'kinds', on: 'kinds.id = r.kind_id' },
];

let db;        // table → Map(id → row)
let entityRow; // the PGC_EntitySchema row, or null
let flags;     // table → PGC_TableMap flags
let calls;
let failOn;

const proto = pg.Client.prototype;
const real  = { connect: proto.connect, query: proto.query, end: proto.end };

const allow = () => ({ allow_insert: true, allow_update: true, allow_delete: true });

beforeEach(() => {
  db = {
    PGD_Roots: new Map([[3, { id: 3, title: 'A', servings: 4, title_embedding: '[1,2,3,4]', created_at: 'c', updated_at: V1 }],
                        [8, { id: 8, title: 'B', servings: 1, title_embedding: null, created_at: 'c', updated_at: V1 }]]),
    PGD_Parts: new Map([[14, { id: 14, parent_id: 3, thing_id: 9, quantity: 100, created_at: 'c', updated_at: V1 }],
                        [15, { id: 15, parent_id: 3, thing_id: 2, quantity: 1,   created_at: 'c', updated_at: V1 }],
                        [16, { id: 16, parent_id: 8, thing_id: 2, quantity: 5,   created_at: 'c', updated_at: V1 }]]),
    PGD_Steps: new Map([[31, { id: 31, parent_id: 3, step_number: 1, text: 'Mix.', created_at: 'c', updated_at: V1 }]]),
  };
  flags     = { PGD_Roots: allow(), PGD_Parts: allow(), PGD_Steps: allow(), PGD_Kinds: allow() };
  entityRow = { entity_name: 'Root', root_table: 'PGD_Roots', joins: JOINS, aggregations: [], target: 'pgd' };
  calls     = [];
  failOn    = null;
  let nextId = 100;

  proto.connect = async function () {};
  proto.end     = async function () {};
  proto.query   = async function (sql, params = []) {
    calls.push([sql, params]);
    if (failOn?.test(sql)) throw new Error('boom');
    if (/PGC_EntitySchema/.test(sql)) {
      return { rows: entityRow ? [{ ...entityRow, schema_columns: ROOT_COLUMNS, ...flags.PGD_Roots }] : [] };
    }
    if (/FROM "PGC_Schema"\s+s\s+JOIN "PGC_TableMap"/.test(sql)) {
      return { rows: params[0].map(t => ({ table_name: t, ...SCHEMAS[t], ...flags[t] })) };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    const table = sql.match(/"(PGD_\w+)"/)?.[1];
    const rows  = db[table];
    const back  = row => ({ ...row, _version: row.updated_at, _json: { ...row } });
    if (/FOR UPDATE/.test(sql)) {
      return { rows: params[0].filter(id => rows.has(id)).map(id => ({ row: { ...rows.get(id) }, version: rows.get(id).updated_at })) };
    }
    if (/SET "updated_at" = now\(\)/.test(sql)) {
      rows.set(params[0], { ...rows.get(params[0]), updated_at: V2 });
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*UPDATE/.test(sql)) {
      const id   = params.at(-1);
      const row  = { ...rows.get(id), updated_at: V2 };
      [...sql.matchAll(/"(\w+)" = \$/g)].forEach(([, c], i) => { row[c] = params[i]; });
      rows.set(id, row);
      return { rows: [back(row)], rowCount: 1 };
    }
    if (/^\s*INSERT INTO "PGD_/.test(sql)) {
      const row = { id: nextId++, created_at: 'c', updated_at: V2 };
      [...sql.match(/\(([^)]*)\)\s*VALUES/)[1].matchAll(/"(\w+)"/g)].forEach(([, c], i) => { row[c] = params[i]; });
      rows.set(row.id, row);
      return { rows: [back(row)], rowCount: 1 };
    }
    if (/^\s*DELETE/.test(sql)) {
      for (const id of params[0]) rows.delete(id);
      return { rows: [], rowCount: params[0].length };
    }
    if (/^\s*SELECT r\.\*/.test(sql)) {
      const row = rows.get(params[0]);
      return { rows: row ? [{ ...row, ...(/_version/.test(sql) ? { _version: row.updated_at } : {}) }] : [] };
    }
    if (/^\s*SELECT \*, "updated_at"::text/.test(sql)) {
      const key = sql.match(/WHERE "(\w+)" = \$1/)[1];
      return { rows: [...rows.values()].filter(r => r[key] === params[0]).sort((a, b) => a.id - b.id).map(r => ({ ...r, _version: r.updated_at })) };
    }
    return { rows: [] };
  };
});
afterEach(() => Object.assign(proto, real));

const call = (subRoute, body) => handle({ subRoute, body, correlationId: 'c' });
const save = body => call('saveEntity', body);
const json = resp => JSON.parse(resp.body);
const sent = re => calls.filter(([sql]) => re.test(sql));
const txn  = () => sent(/^\s*(BEGIN|COMMIT|ROLLBACK)/).map(([s]) => s.trim());
const logRows = () => {
  const [, values] = sent(/PGC_ChangeLog/)[0] ?? [, []];
  const rows = [];
  for (let i = 0; i < values.length; i += 9) rows.push({ batch: values[i], table: values[i + 5], id: values[i + 6], op: values[i + 7], changes: JSON.parse(values[i + 8]) });
  return rows;
};
const LOG = { actor: 'sub-1', via: 'web', domain: 'roots' };

const DOCUMENT = {
  entityName: 'Root', id: 3, version: V1,
  root: { changes: { servings: 2 } },
  children: {
    PGD_Parts: {
      update: [{ id: 14, version: V1, changes: { quantity: 200 } }],
      insert: [{ thing_id: 9, quantity: 1 }],
      delete: [{ id: 15, version: V1 }],
    },
    PGD_Steps: { insert: [{ step_number: 2, text: 'Serve.' }] },
  },
};

describe('childTablesOf', () => {
  it('a joined table is a child only when its foreign key references the root', () => {
    const tables = Object.entries(SCHEMAS).map(([table_name, s]) => ({ table_name, ...s }));
    assert.deepEqual(childTablesOf(entityRow, tables).map(c => [c.tableName, c.parentKey]),
      [['PGD_Parts', 'parent_id'], ['PGD_Steps', 'parent_id']]);
  });
});

describe('getEntity withVersion', () => {
  it('the root carries _version, and children are each child table\'s rows by table name', async () => {
    const resp = await call('getEntity', { entityName: 'Root', id: 3, withVersion: true });
    assert.equal(resp.statusCode, 200, resp.body);
    const b = json(resp);
    assert.equal(b.entity._version, V1);
    assert.ok(!('title_embedding' in b.entity));
    assert.deepEqual(Object.keys(b.children), ['PGD_Parts', 'PGD_Steps']);
    assert.deepEqual(b.children.PGD_Parts.map(r => [r.id, r._version]), [[14, V1], [15, V1]]);
  });
  it('without it, the read is as before', async () => {
    const b = json(await call('getEntity', { entityName: 'Root', id: 3 }));
    assert.equal(b.children, undefined);
    assert.ok(!calls.some(([s]) => /_version/.test(s)));
  });
  it('is refused when a child table has no updated_at', async () => {
    const saved = SCHEMAS.PGD_Steps.columns;
    SCHEMAS.PGD_Steps.columns = saved.filter(c => c.name !== 'updated_at');
    try {
      const resp = await call('getEntity', { entityName: 'Root', id: 3, withVersion: true });
      assert.equal(resp.statusCode, 400);
      assert.match(json(resp).error, /"PGD_Steps" has none/);
    } finally { SCHEMAS.PGD_Steps.columns = saved; }
  });
});

describe('saveEntity — a document saved', () => {
  it('writes the root and each child table in one transaction and returns the document read back', async () => {
    const resp = await save({ ...DOCUMENT, changeLog: LOG });
    assert.equal(resp.statusCode, 200, resp.body);
    const b = json(resp);
    assert.deepEqual(txn(), ['BEGIN', 'COMMIT']);
    assert.equal(b.entity.servings, 2);
    assert.equal(b.entity._version, V2);
    assert.deepEqual(b.children.PGD_Parts.map(r => [r.id, r.quantity]), [[14, 200], [100, 1]]);
    assert.deepEqual(b.children.PGD_Steps.map(r => r.text), ['Mix.', 'Serve.']);
    assert.equal(db.PGD_Parts.get(100).parent_id, 3, 'SERV sets the new child row\'s parent');
    assert.ok(!db.PGD_Parts.has(15));
  });

  it('locks the root and every child row it changes or removes, before writing', async () => {
    await save(DOCUMENT);
    const locks = sent(/FOR UPDATE/).map(([s, p]) => [s.match(/"(PGD_\w+)"/)[1], p[0]]);
    assert.deepEqual(locks, [['PGD_Roots', [3]], ['PGD_Parts', [14, 15]], ['PGD_Steps', []]].filter(([, ids]) => ids.length));
    const firstWrite = calls.findIndex(([s]) => /^\s*(UPDATE|INSERT|DELETE)/.test(s));
    assert.ok(calls.findLastIndex(([s]) => /FOR UPDATE/.test(s)) < firstWrite);
  });

  it('logs every written row under one batch, root and children alike', async () => {
    const { batchId } = json(await save({ ...DOCUMENT, changeLog: LOG }));
    const rows = logRows();
    assert.ok(rows.every(r => r.batch === batchId));
    assert.deepEqual(rows.map(r => [r.table, r.id, r.op]), [
      ['PGD_Roots', '3', 'update'], ['PGD_Parts', '14', 'update'], ['PGD_Parts', '100', 'insert'],
      ['PGD_Parts', '15', 'delete'], ['PGD_Steps', '101', 'insert'],
    ]);
    assert.deepEqual(rows[0].changes, { servings: { old: 4, new: 2 } });
    assert.deepEqual(rows[2].changes.parent_id, { new: 3 });
  });

  it('a save of children only touches the root, so its version moves; the touch is not logged', async () => {
    const resp = await save({ ...DOCUMENT, root: undefined, changeLog: LOG });
    assert.equal(resp.statusCode, 200, resp.body);
    assert.equal(sent(/SET "updated_at" = now\(\)/).length, 1);
    assert.equal(json(resp).entity._version, V2);
    assert.ok(!logRows().some(r => r.table === 'PGD_Roots'));
  });

  it('a new entity: the root inserted whole, then its children with its new id', async () => {
    const resp = await save({ entityName: 'Root', root: { changes: { title: 'C', servings: 2 } },
      children: { PGD_Steps: { insert: [{ step_number: 1, text: 'Boil.' }] } }, changeLog: LOG });
    assert.equal(resp.statusCode, 200, resp.body);
    const b = json(resp);
    assert.equal(b.entity.id, 100);
    assert.deepEqual(b.children.PGD_Steps.map(r => [r.parent_id, r.text]), [[100, 'Boil.']]);
    assert.equal(sent(/FOR UPDATE/).length, 0);
    assert.deepEqual(logRows().map(r => [r.table, r.op]), [['PGD_Roots', 'insert'], ['PGD_Steps', 'insert']]);
  });
});

describe('saveEntity — what moved since it was read', () => {
  it('a changed root and a removed child fail the whole save with 409, nothing written', async () => {
    db.PGD_Roots.set(3, { ...db.PGD_Roots.get(3), updated_at: V2 });
    db.PGD_Parts.delete(15);
    const resp = await save({ ...DOCUMENT, changeLog: LOG });
    assert.equal(resp.statusCode, 409);
    assert.deepEqual(json(resp).conflicts, [
      { table: 'PGD_Roots', id: 3, reason: 'changed' },
      { table: 'PGD_Parts', id: 15, reason: 'deleted' },
    ]);
    assert.equal(sent(/^\s*(UPDATE|INSERT|DELETE)/).length, 0);
    assert.deepEqual(txn(), ['BEGIN', 'ROLLBACK']);
  });

  it('a child row of another entity is refused with 404, nothing written', async () => {
    const resp = await save({ entityName: 'Root', id: 3, version: V1,
      children: { PGD_Parts: { update: [{ id: 16, version: V1, changes: { quantity: 9 } }] } } });
    assert.equal(resp.statusCode, 404);
    assert.match(json(resp).error, /Not rows of Root 3: PGD_Parts 16/);
    assert.equal(sent(/^\s*(UPDATE|INSERT|DELETE)/).length, 0);
    assert.deepEqual(txn(), ['BEGIN', 'ROLLBACK']);
  });

  it('a root that is gone is 404', async () => {
    const resp = await save({ ...DOCUMENT, id: 99 });
    assert.equal(resp.statusCode, 404);
    assert.match(json(resp).error, /with id 99 not found/);
    assert.deepEqual(txn(), ['BEGIN', 'ROLLBACK']);
  });
});

describe('saveEntity — a write that fails', () => {
  it('rolls everything back and answers 500', async () => {
    failOn = /^\s*INSERT INTO "PGD_Steps"/;
    const resp = await save(DOCUMENT);
    assert.equal(resp.statusCode, 500);
    assert.deepEqual(txn(), ['BEGIN', 'ROLLBACK']);
  });
  it('a failed read-back rolls the save back too', async () => {
    failOn = /^\s*SELECT r\.\*/;
    const resp = await save(DOCUMENT);
    assert.equal(resp.statusCode, 500);
    assert.deepEqual(txn(), ['BEGIN', 'ROLLBACK']);
  });
});

describe('saveEntity — refusals', () => {
  const refused = async (body, status, pattern) => {
    const resp = await save(body);
    assert.equal(resp.statusCode, status, resp.body);
    assert.match(json(resp).error, pattern);
    assert.equal(sent(/^\s*(BEGIN|UPDATE|INSERT|DELETE)/).length, 0);
  };

  it('id without version', () => refused({ ...DOCUMENT, version: undefined }, 400, /version must be/));
  it('version without id', () => refused({ ...DOCUMENT, id: undefined }, 400, /id must be an integer/));
  it('a version passed through a Date', () => refused({ ...DOCUMENT, version: '2026-11-21T09:31:10.551Z' }, 400, /version must be/));
  it('nothing to write', () => refused({ entityName: 'Root', id: 3, version: V1, root: { changes: {} } }, 400, /nothing to write/));
  it('a new entity without its row', () => refused({ entityName: 'Root', children: { PGD_Steps: { insert: [{ text: 'x' }] } } }, 400, /root\.changes is required/));
  it('a new entity\'s child updated', () =>
    refused({ entityName: 'Root', root: { changes: { title: 'x' } }, children: { PGD_Parts: { delete: [{ id: 14, version: V1 }] } } }, 400, /can only be inserted/));
  it('a child version malformed', () =>
    refused({ ...DOCUMENT, children: { PGD_Parts: { delete: [{ id: 15, version: 'yesterday' }] } } }, 400, /children\.PGD_Parts\.delete\[0\]\.version/));
  it('a changeLog from an unknown writer', () => refused({ ...DOCUMENT, changeLog: { ...LOG, via: 'slack' } }, 400, /changeLog\.via/));

  it('an unregistered entity', () => { entityRow = null; return refused(DOCUMENT, 404, /not registered/); });
  it('a joined table that is not a child', () =>
    refused({ ...DOCUMENT, children: { PGD_Kinds: { insert: [{ name: 'x' }] } } }, 400, /"PGD_Kinds" is not a child table/));
  it('a child row naming its parent', () =>
    refused({ ...DOCUMENT, children: { PGD_Steps: { insert: [{ parent_id: 8, text: 'x' }] } } }, 400, /"parent_id" is set by SERV/));
  it('a system column on the root', () =>
    refused({ ...DOCUMENT, root: { changes: { updated_at: 'x' } } }, 400, /root\.changes: column "updated_at" is maintained by the system/));
  it('a vector column on the root', () =>
    refused({ ...DOCUMENT, root: { changes: { title_embedding: '[1]' } } }, 400, /"title_embedding" is maintained by the system/));
  it('an unknown child column', () =>
    refused({ ...DOCUMENT, children: { PGD_Steps: { insert: [{ colour: 'x' }] } } }, 400, /children\.PGD_Steps\.insert\[0\]: column "colour" not found/));
  it('a new root where INSERT is not allowed', () => {
    flags.PGD_Roots.allow_insert = false;
    return refused({ entityName: 'Root', root: { changes: { title: 'x' } } }, 403, /INSERT not permitted on "PGD_Roots"/);
  });
  it('a children-only save where the root may not be updated — it would be touched', () => {
    flags.PGD_Roots.allow_update = false;
    return refused({ ...DOCUMENT, root: undefined }, 403, /UPDATE not permitted on "PGD_Roots"/);
  });
  it('a kind of child write PGC_TableMap does not allow', () => {
    flags.PGD_Parts.allow_delete = false;
    return refused(DOCUMENT, 403, /DELETE not permitted on "PGD_Parts"/);
  });
});

describe('checkEntityWrites', () => {
  it('accepts the spec example', () => {
    assert.equal(checkEntityWrites({ ...DOCUMENT, changeLog: LOG }), null);
  });
});
