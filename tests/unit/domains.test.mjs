// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/domains.test.mjs
//
// GET /proc/domains/{domain} (spec 3.14.0; docs/arch-web-app.md §4.4) — a domain's records, from
// the registry: an entity with child tables replaces its root table, every other table and view
// is its own source (Javear, 2026-11-22). And the records panels a domain page draws from them.
// The real route runs against a stubbed SERV; the domains are invented.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';

import { domainSources, handle } from '../../src/proc/domains.mjs';
import { domainPanels }          from '../../src/ui/web/app/records/query.mjs';
import { tableLabel }            from '../../src/shared/schema-utils.mjs';

const fk = (column, table) => ({ column, references: { table, column: 'id' } });
const TABLES = [
  { table_name: 'PGD_Boxes',     type: 'table', foreign_keys: [] },
  { table_name: 'PGD_BoxItems',  type: 'table', foreign_keys: [fk('box_id', 'PGD_Boxes'), fk('thing_id', 'PGD_Things')] },
  { table_name: 'PGD_Things',    type: 'table', foreign_keys: [] },
  { table_name: 'PGD_Shelves',   type: 'table', foreign_keys: [] },
  { table_name: 'PGD_BoxTotals', type: 'view',  foreign_keys: [] },
  { table_name: 'PGD_BoxLabels', type: 'table', foreign_keys: [fk('box_id', 'PGD_Boxes')] },   // a child and an entity of its own
];
const ENTITIES = [
  { entity_name: 'Box',   root_table: 'PGD_Boxes',   joins: [{ table: 'PGD_BoxItems' }, { table: 'PGD_BoxLabels' }] },
  { entity_name: 'Shelf', root_table: 'PGD_Shelves', joins: [] },                       // no children: just its table
  { entity_name: 'Thing', root_table: 'PGD_Things',  joins: [{ table: 'PGD_Shelves' }] }, // joined, but no key to it: no children
  { entity_name: 'Label', root_table: 'PGD_BoxLabels', joins: [] },
];

describe('domainSources', () => {
  it('an entity with children replaces its root; its children live in its documents unless an entity\'s root themselves', () => {
    assert.deepEqual(domainSources(TABLES, ENTITIES).map(s => [s.source, s.kind, s.label]), [
      ['Box', 'entity', 'Boxes'],
      ['PGD_BoxLabels', 'table', 'Box labels'],
      ['PGD_Shelves', 'table', 'Shelves'],
      ['PGD_Things', 'table', 'Things'],
      ['PGD_BoxTotals', 'view', 'Box totals'],
    ]);
  });
  it('every label is a fallback, derived from the table\'s name', () => {
    assert.ok(domainSources(TABLES, ENTITIES).every(s => s.labelFallback === true));
  });
  it('a domain with no records is an empty list', () => {
    assert.deepEqual(domainSources([], []), []);
  });
  it('tableLabel: words from the table\'s name', () => {
    assert.deepEqual(['PGD_RecipeIngredients', 'PGD_Inventory', 'PGD_BudgetExpenseSummary'].map(tableLabel),
      ['Recipe ingredients', 'Inventory', 'Budget expense summary']);
  });
});

describe('GET /proc/domains/{domain}', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.HOUSEHOLD_PRINCIPALS; });
  const stub = () => {
    const calls = [];
    process.env.SERV_API_URL = 'https://serv.test';
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const rows = body.tableName === 'PGC_Schema' ? TABLES : ENTITIES;
      return new Response(JSON.stringify({ success: true, rows }), { status: 200 });
    };
    return calls;
  };
  const call = (proxy, headers = { 'x-principal-user': 'sub-a' }, method = 'GET') =>
    handle({ method, proxy, headers, query: {}, correlationId: 'c' });

  it('reads the domain\'s tables (data tables only) and entities, and answers its sources', async () => {
    const calls = stub();
    const r = await call('domains/stuff');
    assert.equal(r.statusCode, 200, r.body);
    const b = JSON.parse(r.body);
    assert.equal(b.domain, 'stuff');
    assert.equal(b.sources[0].source, 'Box');
    assert.deepEqual(calls[0].filters, [{ column: 'domain', op: 'eq', value: 'stuff' }, { column: 'target', op: 'eq', value: 'pgd' }]);
    assert.deepEqual(calls[1].filters, [{ column: 'domain', op: 'eq', value: 'stuff' }]);
  });

  it('401 without a principal, 403 outside the household, 404 for another path — nothing read', async () => {
    const calls = stub();
    assert.equal((await call('domains/stuff', {})).statusCode, 401);
    assert.equal((await call('domains/stuff', { 'x-principal-user': 'sub-z' })).statusCode, 403);
    assert.equal((await call('domains/stuff/x')).statusCode, 404);
    assert.equal((await call('domains/stuff', undefined, 'POST')).statusCode, 404);
    assert.equal(calls.length, 0);
  });
});

describe('domainPanels — what a domain page draws', () => {
  it('a records panel per source, full width, titled by its label, naming its source only', () => {
    assert.deepEqual(domainPanels([{ source: 'Box', kind: 'entity', label: 'Boxes' }, { source: 'PGD_Things', kind: 'table', label: 'Things' }]), [
      { id: 'Box', kind: 'records', width: 'full', title: 'Boxes', config: { source: 'Box' } },
      { id: 'PGD_Things', kind: 'records', width: 'full', title: 'Things', config: { source: 'PGD_Things' } },
    ]);
  });
});
