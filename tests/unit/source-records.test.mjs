// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/source-records.test.mjs
//
// The web's direct edits through PROC (spec 3.13.0; docs/arch-home-brain.md §4.7, §4.8): a
// source's schema with what the edit policy opens, a grid's save, and a document read, created
// and saved. Every save is checked against the policy before SERV is called and refused whole;
// SERV's answers — a conflict, a refusal — are passed on. The real routes run against a stubbed
// SERV holding invented tables.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';

import { handle, matchSourceRoute, sourceTable } from '../../src/proc/sources.mjs';
import { editableColumns, policyRefusals }       from '../../src/proc/edit-policy.mjs';
import { WebError }                              from '../../src/ui/web/api/proc-client.mjs';

const col = (name, type = 'text', extra = {}) => ({ name, type, ...extra });
const SYS = [col('id', 'serial', { primaryKey: true }), col('created_at', 'timestamptz'), col('updated_at', 'timestamptz')];
const V1  = '2026-11-21 09:31:10.551203+00';

const SCHEMAS = {
  PGD_Things:   { type: 'table', domain: 'stuff', foreign_keys: [{ column: 'kind_id', references: { table: 'PGD_Kinds', column: 'id' } }],
                  columns: [...SYS, col('name', 'varchar', { nullable: false }), col('size', 'integer'), col('kind_id', 'integer'), col('name_embedding', 'vector(4)')] },
  PGD_Totals:   { type: 'view', domain: 'stuff', foreign_keys: [], columns: [col('kind'), col('total', 'numeric')] },
  PGD_Boxes:    { type: 'table', domain: 'stuff', foreign_keys: [], columns: [...SYS, col('label'), col('note')] },
  PGD_BoxItems: { type: 'table', domain: 'stuff', foreign_keys: [{ column: 'box_id', references: { table: 'PGD_Boxes', column: 'id' } }],
                  columns: [...SYS, col('box_id', 'integer'), col('thing_id', 'integer'), col('count', 'integer')] },
  PGD_Kinds:    { type: 'table', domain: 'stuff', foreign_keys: [], columns: [...SYS, col('name')] },
};
const ENTITY = { entity_name: 'Box', root_table: 'PGD_Boxes',
  joins: [{ table: 'PGD_BoxItems', alias: 'items', on: 'items.box_id = r.id' }, { table: 'PGD_Kinds', alias: 'kinds', on: 'kinds.id = r.kind_id' }] };

let policies;   // table → PGC_EditPolicy row
let answers;    // SERV route → { status, body }
let calls;      // [{ path, body }]

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.SERV_API_URL         = 'https://serv.test';
  process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
  policies = {
    PGD_Things:   { table_name: 'PGD_Things', columns: { name: true, size: true }, add_rows: false, delete_rows: true },
    PGD_Boxes:    { table_name: 'PGD_Boxes', columns: { label: true }, add_rows: true, delete_rows: false },
    PGD_BoxItems: { table_name: 'PGD_BoxItems', columns: { thing_id: true, count: true, box_id: true }, add_rows: true, delete_rows: true },
  };
  answers = {};
  calls   = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v1/serv/', '');
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const reply = (status, payload) => new Response(JSON.stringify({ success: status === 200, ...payload }), { status });
    if (path === 'table/getRows') {
      const f = body.filters ?? [];
      const eq = name => f.find(x => x.column === name && x.op === 'eq')?.value;
      const inn = name => f.find(x => x.column === name && x.op === 'in')?.value;
      if (body.tableName === 'PGC_Schema') {
        const names = eq('table_name') !== undefined ? [eq('table_name')] : inn('table_name');
        return reply(200, { rows: names.filter(n => SCHEMAS[n]).map(n => ({ table_name: n, ...SCHEMAS[n] })) });
      }
      if (body.tableName === 'PGC_EntitySchema') return reply(200, { rows: eq('entity_name') === 'Box' ? [ENTITY] : [] });
      if (body.tableName === 'PGC_EditPolicy')   return reply(200, { rows: inn('table_name').filter(n => policies[n]).map(n => policies[n]) });
      return reply(200, { rows: [{ id: 1, name: 'a', _version: V1 }] });
    }
    const answer = answers[path] ?? { status: 200, body: {} };
    return reply(answer.status, answer.body);
  };
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.HOUSEHOLD_PRINCIPALS; });

const member = { 'x-principal-user': 'sub-a' };
const call   = (method, proxy, body, headers = member, query = {}) =>
  handle({ method, proxy, headers, query, body, correlationId: 'c' });
const json   = r => JSON.parse(r.body);
const servCalls = path => calls.filter(c => c.path === path);

describe('matchSourceRoute', () => {
  for (const [method, proxy, expected] of [
    ['GET',  'sources/PGD_Things/rows',      { op: 'readRows', source: 'PGD_Things' }],
    ['POST', 'sources/PGD_Things/rows',      { op: 'saveRows', source: 'PGD_Things' }],
    ['GET',  'sources/Box/schema',           { op: 'readSchema', source: 'Box' }],
    ['POST', 'sources/Box/records',          { op: 'createRecord', source: 'Box' }],
    ['GET',  'sources/Box/records/7',        { op: 'readRecord', source: 'Box', id: 7 }],
    ['POST', 'sources/Box/records/7',        { op: 'saveRecord', source: 'Box', id: 7 }],
    ['GET',  'sources/Box/records/0',        null],
    ['PATCH', 'sources/PGD_Things/rows',     null],
    ['POST', 'sources/Box/schema',           null],
    ['GET',  'sources/Box/records',          null],
    ['GET',  'sources/Box/records/7/extra',  null],
  ]) {
    it(`${method} /${proxy}`, () => assert.deepEqual(matchSourceRoute(method, proxy), expected));
  }
});

describe('the edit policy\'s answers', () => {
  it('editableColumns: what the row opens, less the system\'s columns and the parent key', () => {
    const open = editableColumns({ columns: { box_id: true, count: true, id: true, thing_id: false, gone: true } }, SCHEMAS.PGD_BoxItems.columns, 'box_id');
    assert.deepEqual([...open], ['count']);
  });
  it('editableColumns: nothing without a row, or without versions', () => {
    assert.equal(editableColumns(null, SCHEMAS.PGD_Things.columns).size, 0);
    assert.equal(editableColumns({ columns: { total: true } }, SCHEMAS.PGD_Totals.columns).size, 0);
  });
  it('policyRefusals names every part refused, once each', () => {
    const refused = policyRefusals('PGD_Things', {
      update: [{ id: 1, version: V1, changes: { size: 2, kind_id: 3 } }, { id: 2, version: V1, changes: { kind_id: 4 } }],
      insert: [{ name: 'x' }],
      delete: [{ id: 3, version: V1 }],
    }, policies.PGD_Things, SCHEMAS.PGD_Things.columns);
    assert.deepEqual(refused, [{ name: 'PGD_Things', problem: 'add_rows' }, { name: 'PGD_Things.kind_id', problem: 'column_not_editable' }]);
  });
  it('policyRefusals: nothing asked, nothing refused — even of a table without a row', () => {
    assert.deepEqual(policyRefusals('PGD_Kinds', {}, null, SCHEMAS.PGD_Kinds.columns), []);
  });
});

describe('GET /proc/sources/{source}/schema', () => {
  it('a table: columns with editable and references, vectors left out, the table\'s flags', async () => {
    const r = await call('GET', 'sources/PGD_Things/schema');
    assert.equal(r.statusCode, 200, r.body);
    const b = json(r);
    assert.deepEqual([b.kind, b.domain, b.table.versioned, b.table.addRows, b.table.deleteRows], ['table', 'stuff', true, false, true]);
    assert.deepEqual(b.table.columns.map(c => [c.name, c.editable]),
      [['id', false], ['created_at', false], ['updated_at', false], ['name', true], ['size', true], ['kind_id', false]]);
    assert.deepEqual(b.table.columns.find(c => c.name === 'kind_id').references, { table: 'PGD_Kinds', column: 'id' });
    assert.deepEqual(b.table.columns.find(c => c.name === 'name'), { name: 'name', type: 'varchar', label: 'Name', labelFallback: true, nullable: false, editable: true });
    assert.equal(b.table.columns.find(c => c.name === 'id').nullable, false);
  });

  it('a table without a policy row is read-only', async () => {
    delete policies.PGD_Things;
    const b = json(await call('GET', 'sources/PGD_Things/schema'));
    assert.ok(b.table.columns.every(c => !c.editable));
    assert.deepEqual([b.table.addRows, b.table.deleteRows], [false, false]);
  });

  it('a view has no versions and nothing editable', async () => {
    policies.PGD_Totals = { table_name: 'PGD_Totals', columns: { total: true }, add_rows: true, delete_rows: true };
    const b = json(await call('GET', 'sources/PGD_Totals/schema'));
    assert.deepEqual([b.kind, b.table.versioned, b.table.addRows, b.table.columns.some(c => c.editable)], ['view', false, false, false]);
  });

  it('an entity: its root, and its child tables with their parent key never editable', async () => {
    const b = json(await call('GET', 'sources/Box/schema'));
    assert.deepEqual([b.kind, b.table.table], ['entity', 'PGD_Boxes']);
    assert.deepEqual(b.children.map(c => [c.table, c.parentKey]), [['PGD_BoxItems', 'box_id']]);
    assert.deepEqual(b.children[0].columns.filter(c => c.editable).map(c => c.name), ['thing_id', 'count']);
  });

  it('sourceTable: a child\'s parent key is marked', () => {
    assert.equal(sourceTable('PGD_BoxItems', SCHEMAS.PGD_BoxItems.columns, [], null, 'box_id').parentKey, 'box_id');
  });
});

describe('GET /proc/sources/{source}/rows?with_version', () => {
  it('asks SERV for versions', async () => {
    const r = await call('GET', 'sources/PGD_Things/rows', undefined, member, { with_version: 'true' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(servCalls('table/getRows').at(-1).body.withVersion, true);
  });
  it('refuses a source without versions', async () => {
    const r = await call('GET', 'sources/PGD_Totals/rows', undefined, member, { with_version: 'true' });
    assert.deepEqual([r.statusCode, json(r).error], [400, 'invalid_query']);
  });
  it('refuses a with_version that is not true or false', async () => {
    const r = await call('GET', 'sources/PGD_Things/rows', undefined, member, { with_version: 'yes' });
    assert.equal(r.statusCode, 400);
  });
});

describe('POST /proc/sources/{table}/rows — a grid\'s save', () => {
  const GRID = { update: [{ id: 1, version: V1, changes: { size: 3 } }], delete: [{ id: 2, version: V1 }] };

  it('an allowed save reaches SERV with the change log: the principal, web, the registry\'s domain', async () => {
    answers['table/saveRows'] = { status: 200, body: { tableName: 'PGD_Things', updated: [{ id: 1 }], inserted: [], deleted: [2], batchId: 'b-1' } };
    const r = await call('POST', 'sources/PGD_Things/rows', { ...GRID, changeLog: { actor: 'someone-else', via: 'web', domain: 'x' }, tableName: 'PGD_Kinds' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(json(r), { success: true, updated: [{ id: 1 }], inserted: [], deleted: [2], batchId: 'b-1' });
    const [sent] = servCalls('table/saveRows');
    // The table and the change log are the server's: the request's own are ignored.
    assert.deepEqual(sent.body, { tableName: 'PGD_Things', update: GRID.update, delete: GRID.delete,
      changeLog: { actor: 'sub-a', via: 'web', domain: 'stuff' } });
  });

  it('refused whole, naming each refusal, and SERV is never called', async () => {
    const r = await call('POST', 'sources/PGD_Things/rows', { ...GRID, update: [{ id: 1, version: V1, changes: { kind_id: 9 } }], insert: [{ name: 'n' }] });
    assert.equal(r.statusCode, 403);
    assert.deepEqual(json(r), { success: false, error: 'not_editable', fields: [
      { name: 'PGD_Things', problem: 'add_rows' }, { name: 'PGD_Things.kind_id', problem: 'column_not_editable' },
    ] });
    assert.equal(servCalls('table/saveRows').length, 0);
  });

  it('a table without a policy row refuses any write', async () => {
    const r = await call('POST', 'sources/PGD_Kinds/rows', { update: [{ id: 1, version: V1, changes: { name: 'x' } }] });
    assert.deepEqual(json(r).fields, [{ name: 'PGD_Kinds', problem: 'table_not_editable' }]);
  });

  it('a row that moved: SERV\'s conflicts passed on as version_conflict', async () => {
    const conflicts = [{ table: 'PGD_Things', id: 1, reason: 'changed' }];
    answers['table/saveRows'] = { status: 409, body: { error: 'version_conflict', conflicts } };
    const r = await call('POST', 'sources/PGD_Things/rows', GRID);
    assert.deepEqual([r.statusCode, json(r).error, json(r).conflicts], [409, 'version_conflict', conflicts]);
  });

  it('SERV\'s refusal of the request\'s shape is invalid_writes, its message passed on', async () => {
    answers['table/saveRows'] = { status: 400, body: { error: 'update[0].version must be the version the row was read at' } };
    const r = await call('POST', 'sources/PGD_Things/rows', GRID);
    assert.deepEqual([r.statusCode, json(r).error], [400, 'invalid_writes']);
    assert.match(json(r).message, /update\[0\]\.version/);
  });

  for (const [what, source, code, status] of [
    ['an entity', 'Box', 'not_a_table', 400], ['a view', 'PGD_Totals', 'not_a_table', 400],
    ['an unknown source', 'PGD_Nope', 'source_not_found', 404], ['a PGC_ table', 'PGC_EditPolicy', 'source_not_found', 404],
  ]) {
    it(`refuses ${what}`, async () => {
      const r = await call('POST', `sources/${source}/rows`, GRID);
      assert.deepEqual([r.statusCode, json(r).error], [status, code]);
      assert.equal(servCalls('table/saveRows').length, 0);
    });
  }

  it('401 without a principal, 403 outside the household — nothing read or written', async () => {
    assert.equal((await call('POST', 'sources/PGD_Things/rows', GRID, {})).statusCode, 401);
    assert.equal((await call('POST', 'sources/PGD_Things/rows', GRID, { 'x-principal-user': 'sub-z' })).statusCode, 403);
    assert.equal(calls.length, 0);
  });
});

describe('the document routes', () => {
  const SAVED = { status: 200, body: { entityName: 'Box', entity: { id: 7, label: 'L', _version: V1 }, children: { PGD_BoxItems: [] }, batchId: 'b-2' } };

  it('GET reads the document with versions', async () => {
    answers['entity/getEntity'] = { status: 200, body: { entity: { id: 7, _version: V1 }, children: { PGD_BoxItems: [] } } };
    const r = await call('GET', 'sources/Box/records/7');
    assert.deepEqual(json(r), { success: true, entity: { id: 7, _version: V1 }, children: { PGD_BoxItems: [] } });
    assert.deepEqual(servCalls('entity/getEntity')[0].body, { entityName: 'Box', id: 7, withVersion: true });
  });

  it('GET of a missing record is record_not_found; of a table, not_an_entity', async () => {
    answers['entity/getEntity'] = { status: 404, body: { error: 'Entity "Box" with id 9 not found' } };
    assert.deepEqual(json(await call('GET', 'sources/Box/records/9')).error, 'record_not_found');
    const r = await call('GET', 'sources/PGD_Things/records/1');
    assert.deepEqual([r.statusCode, json(r).error], [400, 'not_an_entity']);
  });

  it('a save reaches SERV with id from the path, its version, and the change log', async () => {
    answers['entity/saveEntity'] = SAVED;
    const doc = { version: V1, root: { changes: { label: 'L' } }, children: { PGD_BoxItems: { insert: [{ thing_id: 1, count: 2 }] } } };
    const r = await call('POST', 'sources/Box/records/7', { ...doc, id: 99 });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(json(r), { success: true, entity: SAVED.body.entity, children: SAVED.body.children, batchId: 'b-2' });
    assert.deepEqual(servCalls('entity/saveEntity')[0].body, { entityName: 'Box', id: 7, ...doc, changeLog: { actor: 'sub-a', via: 'web', domain: 'stuff' } });
  });

  it('a save of children only needs nothing open on the root', async () => {
    answers['entity/saveEntity'] = SAVED;
    delete policies.PGD_Boxes;
    const r = await call('POST', 'sources/Box/records/7', { version: V1, children: { PGD_BoxItems: { update: [{ id: 3, version: V1, changes: { count: 5 } }] } } });
    assert.equal(r.statusCode, 200, r.body);
  });

  it('refused whole: a root column not open, and a child row naming its parent', async () => {
    const r = await call('POST', 'sources/Box/records/7', { version: V1, root: { changes: { note: 'n' } },
      children: { PGD_BoxItems: { insert: [{ box_id: 8, count: 1 }] } } });
    assert.equal(r.statusCode, 403);
    assert.deepEqual(json(r).fields, [{ name: 'PGD_Boxes.note', problem: 'column_not_editable' }, { name: 'PGD_BoxItems.box_id', problem: 'column_not_editable' }]);
    assert.equal(servCalls('entity/saveEntity').length, 0);
  });

  it('a new document needs add_rows on the root, and goes to SERV without id or version', async () => {
    answers['entity/saveEntity'] = SAVED;
    const r = await call('POST', 'sources/Box/records', { root: { changes: { label: 'new' } } });
    assert.equal(r.statusCode, 200, r.body);
    const sent = servCalls('entity/saveEntity')[0].body;
    assert.ok(!('id' in sent) && !('version' in sent));
    policies.PGD_Boxes.add_rows = false;
    const refused = await call('POST', 'sources/Box/records', { root: { changes: { label: 'new' } } });
    assert.deepEqual(json(refused).fields, [{ name: 'PGD_Boxes', problem: 'add_rows' }]);
  });

  it('a conflict, and a child row of another document, are passed on', async () => {
    answers['entity/saveEntity'] = { status: 409, body: { error: 'version_conflict', conflicts: [{ table: 'PGD_Boxes', id: 7, reason: 'changed' }] } };
    const doc = { version: V1, root: { changes: { label: 'L' } } };
    assert.equal((await call('POST', 'sources/Box/records/7', doc)).statusCode, 409);
    answers['entity/saveEntity'] = { status: 404, body: { error: 'Not rows of Box 7: PGD_BoxItems 4' } };
    const r = await call('POST', 'sources/Box/records/7', doc);
    assert.deepEqual([r.statusCode, json(r).error], [404, 'record_not_found']);
  });

  it('a table is not a document', async () => {
    const r = await call('POST', 'sources/PGD_Things/records/1', { version: V1 });
    assert.deepEqual([r.statusCode, json(r).error], [400, 'not_an_entity']);
  });
});

describe('the web keeps a conflict\'s rows', () => {
  it('WebError carries conflicts into its body', () => {
    const conflicts = [{ table: 'PGD_Things', id: 1, reason: 'deleted' }];
    assert.deepEqual(new WebError(409, 'version_conflict', undefined, undefined, conflicts).toBody(),
      { error: { code: 'version_conflict', message: 'Someone changed this since you opened it — read it again.', conflicts } });
  });
});
