// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-schema-defaults.test.mjs
//
// A column default on a table that already exists. createTable wrote one and the registry
// recorded it, but addColumn ignored the default its OpenAPI ColumnDefinition offers, and
// modifyColumn had no SET DEFAULT. So in session 1308 Novia could not give item_type the
// default it needed before it could become required. The real routes run here against a
// stubbed pg.Client; every statement and the registry write are checked.
//
// Run: node --test tests/unit/serv-schema-defaults.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';
import pg                                      from 'pg';

import { handle, validateColumnDefault } from '../../src/serv/schema.mjs';

const COLUMNS = [
  { name: 'id', type: 'serial', nullable: false },
  { name: 'kind', type: 'text', nullable: true },
];

const proto = pg.Client.prototype;
const real  = { connect: proto.connect, query: proto.query, end: proto.end };
let sent;

beforeEach(() => {
  sent = [];
  proto.connect = async function () {};
  proto.end     = async function () {};
  proto.query   = async function (sql, params) {
    sent.push({ sql, params });
    if (/SELECT id, target, columns FROM "PGC_Schema"/.test(sql)) {
      return { rows: [{ id: 3, target: 'pgd', columns: COLUMNS }] };
    }
    return { rows: [], rowCount: 1 };
  };
});
afterEach(() => Object.assign(proto, real));

const call = async (subRoute, body) => {
  const resp = await handle({ subRoute, body, correlationId: 'c' });
  return { status: resp.statusCode, body: JSON.parse(resp.body) };
};
const ddl      = () => sent.map(s => s.sql).filter(q => /^ALTER TABLE/.test(q));
const registry = () => JSON.parse(sent.find(s => /UPDATE "PGC_Schema"/.test(s.sql)).params[0]);

describe('validateColumnDefault', () => {
  for (const ok of ["'regular'", "'it''s'", "'{}'::jsonb", "'a'::double precision", '0', '-2.5', 'true', 'FALSE', 'null', 'now()', 'CURRENT_DATE', 'gen_random_uuid()']) {
    it(`accepts ${ok}`, () => assert.equal(validateColumnDefault(ok), null));
  }
  for (const bad of ['regular', "'x'; DROP TABLE y", "'a'::evil", "nextval('s')", "'a' || 'b'", '', '  ']) {
    it(`refuses ${JSON.stringify(bad)}`, () => assert.ok(validateColumnDefault(bad)));
  }
});

describe('addColumn with a default', () => {
  it('adds the column with its DEFAULT before NOT NULL, so existing rows are filled', async () => {
    const r = await call('addColumn', { tableName: 'PGD_T', column: { name: 'item_kind', type: 'text', nullable: false, default: "'regular'" } });
    assert.equal(r.status, 200);
    assert.deepEqual(ddl(), [`ALTER TABLE "PGD_T" ADD COLUMN IF NOT EXISTS "item_kind" text DEFAULT 'regular' NOT NULL`]);
  });

  it('records the default in the registry beside the column', async () => {
    await call('addColumn', { tableName: 'PGD_T', column: { name: 'item_kind', type: 'text', default: "'regular'" } });
    assert.deepEqual(registry(), [{ name: 'item_kind', type: 'text', nullable: true, default: "'regular'" }]);
  });

  it('refuses a default it will not splice into DDL, and runs nothing', async () => {
    const r = await call('addColumn', { tableName: 'PGD_T', column: { name: 'item_kind', type: 'text', default: 'regular' } });
    assert.equal(r.status, 400);
    assert.equal(sent.length, 0);
  });

  it('adds a column without a default as before', async () => {
    await call('addColumn', { tableName: 'PGD_T', column: { name: 'note', type: 'text' } });
    assert.deepEqual(ddl(), ['ALTER TABLE "PGD_T" ADD COLUMN IF NOT EXISTS "note" text']);
    assert.deepEqual(registry(), [{ name: 'note', type: 'text', nullable: true }]);
  });
});

describe('modifyColumn with a default', () => {
  it('sets the default, then NOT NULL, in that order', async () => {
    const r = await call('modifyColumn', { tableName: 'PGD_T', columnName: 'kind', default: "'regular'", nullable: false });
    assert.equal(r.status, 200);
    assert.deepEqual(ddl(), [
      `ALTER TABLE "PGD_T" ALTER COLUMN "kind" SET DEFAULT 'regular'`,
      'ALTER TABLE "PGD_T" ALTER COLUMN "kind" SET NOT NULL',
    ]);
    assert.deepEqual(registry().find(c => c.name === 'kind'), { name: 'kind', type: 'text', nullable: false, default: "'regular'" });
    assert.equal(r.body.default, "'regular'");
  });

  it('takes a default on its own — no type or nullability needed', async () => {
    const r = await call('modifyColumn', { tableName: 'PGD_T', columnName: 'kind', default: '0' });
    assert.equal(r.status, 200);
    assert.deepEqual(ddl(), ['ALTER TABLE "PGD_T" ALTER COLUMN "kind" SET DEFAULT 0']);
  });

  it('drops the default for dropDefault: true, and for default: null as SQL reads it', async () => {
    for (const body of [{ dropDefault: true }, { default: null }]) {
      sent = [];
      const r = await call('modifyColumn', { tableName: 'PGD_T', columnName: 'kind', ...body });
      assert.equal(r.status, 200);
      assert.deepEqual(ddl(), ['ALTER TABLE "PGD_T" ALTER COLUMN "kind" DROP DEFAULT']);
      assert.equal('default' in registry().find(c => c.name === 'kind'), false);
    }
  });

  it('refuses a default it will not splice into DDL, and runs nothing', async () => {
    const r = await call('modifyColumn', { tableName: 'PGD_T', columnName: 'kind', default: "'x'; DROP TABLE y" });
    assert.equal(r.status, 400);
    assert.equal(sent.length, 0);
  });

  it('still refuses a call that changes nothing', async () => {
    const r = await call('modifyColumn', { tableName: 'PGD_T', columnName: 'kind' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /newType, nullable, default or dropDefault is required/);
  });
});
