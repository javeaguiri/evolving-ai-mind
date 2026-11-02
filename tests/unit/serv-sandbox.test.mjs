// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-sandbox.test.mjs
//
// Sprint 15 scope 2 — the test sandbox's SERV half (docs/arch-sandbox.md): what a create
// request may name, which tables a named one pulls in, how a trigger moves onto its copy, the
// x-sandbox checks that need no database, and getClient pointing a connection at the sandbox.
// The SQL itself was verified against the live database (create, filtered copy, own sequences,
// triggers, NOT VALID foreign keys, cascade, write refusal, reset, drop).

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { normaliseSpec, fkParents, retargetTrigger, sandboxRefusal } from '../../src/serv/sandbox.mjs';
import { inSandbox, currentSandbox, SANDBOX_NAME }                   from '../../src/serv/sandbox-context.mjs';
import { getClient }                                                 from '../../src/serv/init-brain.mjs';
import pg                                                            from 'pg';

describe('normaliseSpec — what start_test may ask for', () => {
  it('accepts names with all, none or filters, defaulting to all', () => {
    assert.deepEqual(normaliseSpec({ tables: [{ name: 'PGD_A' }, { name: 'PGD_B', rows: 'none' }, { name: 'PGD_C', rows: [{ column: 'x', op: 'eq', value: 1 }] }] }), {
      tables: [{ name: 'PGD_A', rows: 'all' }, { name: 'PGD_B', rows: 'none' }, { name: 'PGD_C', rows: [{ column: 'x', op: 'eq', value: 1 }] }],
    });
  });

  it('refuses anything but a PGD table — the sandbox never holds a copy she chose of a system table', () => {
    assert.match(normaliseSpec({ tables: [{ name: 'PGC_Prompt' }] }).error, /not a PGD_ table/);
    assert.match(normaliseSpec({ tables: [{ name: 'PGD_X"; drop' }] }).error, /not a PGD_ table/);
  });

  it('refuses an empty list, a name given twice, and an unknown rows value', () => {
    assert.ok(normaliseSpec({ tables: [] }).error);
    assert.match(normaliseSpec({ tables: ['PGD_A', 'PGD_A'] }).error, /twice/);
    assert.match(normaliseSpec({ tables: [{ name: 'PGD_A', rows: 'some' }] }).error, /all", "none"/);
  });
});

describe('fkParents — the tables a named table needs', () => {
  const edges = [
    { child: 'PGD_ReviewLog', parent: 'PGD_Cards' },
    { child: 'PGD_Cards',     parent: 'PGD_Decks' },
    { child: 'PGD_Decks',     parent: 'PGD_Decks' },
    { child: 'PGD_Other',     parent: 'PGD_Unrelated' },
    { child: 'PGD_Cards',     parent: 'PGC_Something' },
  ];

  it('follows foreign keys transitively, once each, and only to PGD tables', () => {
    assert.deepEqual(fkParents(['PGD_ReviewLog'], edges), ['PGD_Cards', 'PGD_Decks']);
  });

  it('adds nothing a named table already covers', () => {
    assert.deepEqual(fkParents(['PGD_Cards', 'PGD_Decks'], edges), []);
  });
});

describe('retargetTrigger — a trigger moves onto the copy of its table', () => {
  const def = 'CREATE TRIGGER trg_cards_updated_at BEFORE UPDATE ON public."PGD_Cards" FOR EACH ROW EXECUTE FUNCTION set_updated_at()';

  it('names the sandbox table instead of the real one', () => {
    assert.equal(retargetTrigger(def, 'PGD_Cards', 'sandbox_1'),
      'CREATE TRIGGER trg_cards_updated_at BEFORE UPDATE ON "sandbox_1"."PGD_Cards" FOR EACH ROW EXECUTE FUNCTION set_updated_at()');
  });

  it('throws rather than leave a trigger on the household table', () => {
    assert.throws(() => retargetTrigger(def, 'PGD_Decks', 'sandbox_1'), /does not name/);
  });
});

describe('sandboxRefusal — the checks that need no database', () => {
  it('a name that is not sandbox_<digits> never reaches SQL', async () => {
    assert.equal((await sandboxRefusal({ route: 'table', subRoute: 'getRows' }, 'sandbox_1"; drop')).status, 400);
    assert.equal((await sandboxRefusal({ route: 'table', subRoute: 'getRows' }, 'public')).status, 400);
    assert.ok(!SANDBOX_NAME.test('sandbox_'));
  });

  it('no schema change, bootstrap or sandbox management from inside a sandbox', async () => {
    assert.equal((await sandboxRefusal({ route: 'schema', subRoute: 'createTable' }, 'sandbox_1')).status, 403);
    assert.equal((await sandboxRefusal({ route: 'schema', subRoute: 'addColumn' }, 'sandbox_1')).status, 403);
    assert.equal((await sandboxRefusal({ route: 'bootstrap', subRoute: 'bootstrap' }, 'sandbox_1')).status, 403);
    assert.equal((await sandboxRefusal({ route: 'sandbox', subRoute: 'drop' }, 'sandbox_1')).status, 403);
  });
});

describe('getClient — a connection opened in a sandbox points at it', () => {
  it('sets search_path after connecting, only inside the sandbox', async () => {
    // Stub the class's connect and query before the clients exist: getClient binds connect at
    // creation, so a stub added afterwards would never be reached.
    const proto   = pg.Client.prototype;
    const real    = { connect: proto.connect, query: proto.query };
    const issued  = [];
    proto.connect = async function () { issued.push('connect'); };
    proto.query   = async function (sql) { issued.push(sql); };
    try {
      await getClient('postgres://x@localhost/db').connect();
      assert.deepEqual(issued, ['connect'], 'a client outside a sandbox is untouched');

      issued.length = 0;
      await inSandbox('sandbox_7', () => getClient('postgres://x@localhost/db')).connect();
      assert.deepEqual(issued, ['connect', 'SET search_path TO "sandbox_7", public']);
    } finally {
      Object.assign(proto, real);
    }
  });

  it('the context does not leak past the call that entered it', () => {
    inSandbox('sandbox_7', () => assert.equal(currentSandbox(), 'sandbox_7'));
    assert.equal(currentSandbox(), null);
  });
});
