// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-table-connections.test.mjs
//
// Every connection a SERV table route opens is closed, whatever happens to its query. The five
// read/write routes closed their PGD connection only after a successful query, so a failed one —
// a NOT NULL or foreign-key violation, a bad filter — left it open for the life of the Lambda
// container (found 2026-11-02 testing the sandbox: the test process hung on one idle connection).
// The real routes run here against a stubbed pg.Client that fails the data query.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';
import { readFileSync }                        from 'node:fs';
import pg                                      from 'pg';

import { handle } from '../../src/serv/table.mjs';

const proto = pg.Client.prototype;
const real  = { connect: proto.connect, query: proto.query, end: proto.end };
let opened, closed;

beforeEach(() => {
  opened = 0; closed = 0;
  proto.connect = async function () { opened += 1; };
  proto.end     = async function () { closed += 1; };
  proto.query   = async function (sql) {
    // The registry gate answers; the data query fails, as a constraint violation does.
    if (/PGC_TableMap/.test(sql)) {
      return { rows: [{ id: 1, target: 'pgd', allow_insert: true, allow_update: true, allow_delete: true,
        columns: [{ name: 'id', type: 'serial' }, { name: 'name', type: 'text' }] }] };
    }
    const error = new Error('null value in column "name" violates not-null constraint');
    error.code = '23502';
    throw error;
  };
});
afterEach(() => Object.assign(proto, real));

const call = (subRoute, body) => handle({ subRoute, body, correlationId: 'c' });

describe('SERV table routes close every connection when the query fails', () => {
  for (const [subRoute, body] of [
    ['getRows',    { tableName: 'PGD_X' }],
    ['insertRow',  { tableName: 'PGD_X', row: { name: 'a' } }],
    ['updateRows', { tableName: 'PGD_X', filters: [{ column: 'id', op: 'eq', value: 1 }], updates: { name: 'b' } }],
    ['deleteRows', { tableName: 'PGD_X', filters: [{ column: 'id', op: 'eq', value: 1 }] }],
    ['upsertRows', { tableName: 'PGD_X', matchColumns: ['id'], rows: [{ id: 1, name: 'c' }] }],
  ]) {
    it(`${subRoute}: the PGC and the PGD connection both close`, async () => {
      const resp = await call(subRoute, body);
      assert.ok(resp.statusCode >= 400, `the failure is reported (got ${resp.statusCode})`);
      assert.equal(opened, 2, 'a PGC and a PGD connection were opened');
      assert.equal(closed, opened, 'every connection opened was closed');
    });
  }
});

describe('the PGD connection closes in finally, never after the query', () => {
  const src = readFileSync('src/serv/table.mjs', 'utf8');

  it('no route closes it inline', () => {
    assert.ok(!/await dbClient\.end\(\)/.test(src));
  });

  it('all five routes close it in finally, beside the PGC connection', () => {
    assert.equal((src.match(/\} finally \{\n    await pgdClient\?\.end\(\);\n    await pgcClient\.end\(\);/g) ?? []).length, 5);
  });
});
