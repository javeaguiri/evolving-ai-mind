// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-read-offset.test.mjs
//
// Sprint 18 item 9: getRows reads a later page of the same read with `offset`, so a records panel
// can read on as it is scrolled. The real route runs here against a stubbed pg.Client holding
// 120 matching rows.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';
import pg                                      from 'pg';

import { handle }            from '../../src/serv/table.mjs';
import { resolveReadOffset } from '../../src/serv/query-utils.mjs';

const TOTAL = 120;
const proto = pg.Client.prototype;
const real  = { connect: proto.connect, query: proto.query, end: proto.end };
let sqls;

beforeEach(() => {
  sqls = [];
  proto.connect = async () => {};
  proto.end     = async () => {};
  proto.query   = async function (sql) {
    sqls.push(sql);
    if (/PGC_TableMap/.test(sql)) return { rows: [{ id: 1, target: 'pgd', columns: [{ name: 'id', type: 'serial' }] }] };
    if (/COUNT\(\*\)/.test(sql))  return { rows: [{ total: TOTAL }] };
    const [, limit, offset] = sql.match(/LIMIT (\d+) OFFSET (\d+)/).map(Number);
    const ids = Array.from({ length: TOTAL }, (_, i) => ({ id: i + 1 })).slice(offset, offset + limit);
    return { rows: ids };
  };
});
afterEach(() => Object.assign(proto, real));

const read = async body => JSON.parse((await handle({ subRoute: 'getRows', body: { tableName: 'PGD_X', orderBy: 'id ASC', ...body }, correlationId: 'c' })).body);

describe('getRows offset — a later page of the same read', () => {
  it('the first page is cut, and says so', async () => {
    const r = await read({ limit: 50 });
    assert.deepEqual([r.count, r.rows[0].id, r.truncated, r.total_matching, r.offset], [50, 1, true, TOTAL, undefined]);
    assert.match(sqls.at(-2), /LIMIT 50 OFFSET 0/);
  });

  it('a middle page skips the rows before it, and rows remain past it', async () => {
    const r = await read({ limit: 50, offset: 50 });
    assert.deepEqual([r.count, r.rows[0].id, r.truncated, r.offset], [50, 51, true, 50]);
  });

  it('the page that fills its limit at the very end is complete, not cut', async () => {
    const r = await read({ limit: 60, offset: 60 });
    assert.deepEqual([r.count, r.truncated, r.total_matching], [60, undefined, TOTAL]);
  });

  it('the last, short page is complete and uncounted', async () => {
    const r = await read({ limit: 50, offset: 100 });
    assert.deepEqual([r.count, r.rows.at(-1).id, r.truncated, r.total_matching], [20, TOTAL, undefined, undefined]);
  });

  it('an offset that is not a whole number of rows is refused', async () => {
    for (const offset of [-1, 1.5, 'ten']) {
      const r = await handle({ subRoute: 'getRows', body: { tableName: 'PGD_X', offset }, correlationId: 'c' });
      assert.equal(r.statusCode, 400, String(offset));
      assert.match(JSON.parse(r.body).error ?? r.body, /offset must be a whole number/);
    }
  });

  it('resolveReadOffset: none is 0; a numeral is read', () => {
    assert.deepEqual([undefined, null, 0, '40', 40].map(resolveReadOffset), [0, 0, 0, 40, 40]);
  });
});
