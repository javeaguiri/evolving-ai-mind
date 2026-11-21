// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/pages.test.mjs
//
// Sprint 16 scope 3 (docs/arch-web-app.md §2.3, §4.2, v0.6): PGC_Page's contract — each panel's
// config checked against its kind before it is stored — and GET /proc/pages.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';
import { readFileSync }            from 'node:fs';

import { pageProblems, viewsFor }               from '../../src/proc/page-config.mjs';
import { resolveLanguageMap }                   from '../../src/shared/language-map.mjs';
import { latestPages, handle }                  from '../../src/proc/pages.mjs';

const registry = {
  sources:   new Map([
    ['PGD_Items', { type: 'table', columns: new Set(['id', 'name', 'qty', 'price', 'price_currency', 'share', 'bought']) }],
    ['PGD_ItemSummary', { type: 'view', columns: new Set(['name', 'total']) }],
  ]),
  entities:  new Map([['Item', 'PGD_Items']]),
  workflows: new Set(['do_thing', 'report_thing']),
  domains:   new Set(['things']),
};
const page = panels => ({ page_key: 'p', title: 'P', position: 1, panels });
const panel = (kind, config, extra = {}) => ({ id: 'a', kind, width: '1/2', config, ...extra });

describe('pageProblems — a valid page', () => {
  it('accepts every kind, with a records panel that names no widget', () => {
    const ok = page([
      panel('workflow', { workflow: 'do_thing', limit: 5 }, { id: 'w' }),
      panel('workflow', { domain: 'things', show_output: true }, { id: 'd' }),
      panel('records',  { source: 'PGD_Items', view: 'document', columns: ['name', { name: 'qty', label: 'Qty' }], filter: [{ column: 'qty', op: 'gt', value: 0 }], title_column: 'name' }, { id: 'r' }),
      panel('records',  { entity: 'Item' }, { id: 'e' }),
      panel('summary',  { widget: 'chart', source: 'PGD_ItemSummary', kind: 'bar', category_column: 'name', value_columns: ['total'] }, { id: 'c' }),
      panel('summary',  { widget: 'metric', source: 'PGD_ItemSummary', value_column: 'total' }, { id: 'm' }),
      panel('summary',  { widget: 'report', workflow: 'report_thing' }, { id: 'rep', title: { en: 'Report', es: 'Informe' } }),
      panel('minds_eye', { topic: 'Things' }, { id: 'n' }),
    ]);
    assert.deepEqual(pageProblems(ok, registry), []);
  });

  it('a view has no document view', () => {
    assert.deepEqual(viewsFor('view'), ['grid', 'list']);
    assert.deepEqual(viewsFor('table'), ['grid', 'list', 'document']);
  });
});

describe('pageProblems — refused, not stored', () => {
  const problemsOf = (...panels) => pageProblems(page(panels), registry);

  it('an unknown kind, widget or key', () => {
    assert.match(problemsOf(panel('data', {}))[0], /kind is one of workflow, records, summary, minds_eye/);
    assert.match(problemsOf(panel('summary', { widget: 'table', source: 'PGD_Items' }))[0], /widget is one of chart, metric, report/);
    assert.match(problemsOf(panel('records', { source: 'PGD_Items', widget: 'table' }))[0], /not widget/);
  });

  it('a view that does not fit, and names the registry does not hold', () => {
    assert.match(problemsOf(panel('records', { source: 'PGD_ItemSummary', view: 'document' }))[0], /view is one of grid, list for a view/);
    assert.match(problemsOf(panel('records', { source: 'PGD_Nope' }))[0], /no table or view "PGD_Nope"/);
    assert.match(problemsOf(panel('records', { source: 'PGD_Items', title_column: 'colour' }))[0], /no column "colour"/);
    assert.match(problemsOf(panel('summary', { widget: 'report', workflow: 'gone' }))[0], /no workflow "gone"/);
  });

  it('a column\'s label and format (§4.2, §6.3): accepted as defined, refused otherwise', () => {
    const records = columns => problemsOf(panel('records', { source: 'PGD_Items', columns }));
    assert.deepEqual(records([
      'name',
      { name: 'price', label: { en: 'Price', es: 'Precio' }, format: 'currency', currency_column: 'price_currency' },
      { name: 'qty', format: 'currency', currency: 'EUR' },
      { name: 'share', format: 'percent' },
      { name: 'bought', format: 'date', label: 'Bought' },
    ]), []);
    for (const [columns, expected] of [
      [{ name: 'price', format: 'money' }, /column "price": format is one of currency, percent, date/],
      [{ name: 'price', format: 'currency' }, /column "price": a currency names its currency_column or its currency, one of the two/],
      [{ name: 'price', format: 'currency', currency: 'EUR', currency_column: 'price_currency' }, /one of the two/],
      [{ name: 'price', format: 'currency', currency_column: 'colour' }, /no column "colour"/],
      [{ name: 'price', format: 'currency', currency: 'euro' }, /column "price": currency is an ISO 4217 code/],
      [{ name: 'share', currency: 'EUR' }, /column "share": currency only with format currency/],
      [{ name: 'price', width: 3 }, /column "price": unknown key width/],
      [{ name: 'price', label: 7 }, /column "price": label is a string or a language map/],
      [{ label: 'x' }, /a column is a name, or \{ name, label\?, format\? \}/],
      [{ name: 'colour' }, /no column "colour"/],
    ]) {
      const problems = records([columns]);
      assert.equal(problems.length, 1, `${JSON.stringify(columns)} → ${problems.join(' | ')}`);
      assert.match(problems[0], expected);
    }
    assert.match(records('name')[0], /columns is an array/);
  });

  it('a source and an entity together, or a workflow and a domain together', () => {
    assert.match(problemsOf(panel('records', { source: 'PGD_Items', entity: 'Item' }))[0], /not both/);
    assert.match(problemsOf(panel('workflow', { workflow: 'do_thing', domain: 'things' }))[0], /not both/);
  });

  it('page-level problems, and every problem rather than the first', () => {
    const bad = pageProblems({ page_key: 'Bad Key', title: '', position: -1, panels: [
      panel('minds_eye', {}, { id: 'x', width: 'half' }), panel('minds_eye', { topic: 't' }, { id: 'x' }),
    ] }, registry);
    assert.ok(bad.length >= 5, bad.join('\n'));
    assert.ok(bad.some(m => /id is used twice/.test(m)));
    assert.ok(bad.some(m => /width is one of/.test(m)));
  });
});

describe('the system seed stays generic', () => {
  it('holds only an empty Home', () => {
    const seed = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_Page.json', 'utf8'));
    assert.deepEqual(seed, [{ page_key: 'home', title: 'Home', position: 0, panels: [] }]);
  });
});

describe('latestPages and resolveLanguageMap', () => {
  it('keeps each page\'s latest version, ordered by position', () => {
    const rows = [
      { page_key: 'money', version: 1, title: 'Money', position: 10, panels: [] },
      { page_key: 'home',  version: 2, title: { es: 'Inicio', en: 'Home' }, position: 0, panels: [{ id: 'a' }] },
      { page_key: 'home',  version: 1, title: 'Home', position: 0, panels: [] },
    ];
    assert.deepEqual(latestPages(rows), [
      { pageKey: 'home',  version: 2, title: 'Home',  position: 0,  panels: [{ id: 'a' }] },
      { pageKey: 'money', version: 1, title: 'Money', position: 10, panels: [] },
    ]);
  });

  it('a title falls back to English, then to the first language held', () => {
    assert.equal(resolveLanguageMap({ es: 'Inicio', en: 'Home' }, 'es'), 'Inicio');
    assert.equal(resolveLanguageMap({ es: 'Inicio', en: 'Home' }, 'fr'), 'Home');
    assert.equal(resolveLanguageMap({ es: 'Inicio' }), 'Inicio');
  });
});

describe('GET /proc/pages — the household\'s, and never part of them', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.HOUSEHOLD_PRINCIPALS; });
  const req = headers => ({ method: 'GET', proxy: 'pages', route: 'pages', headers, query: {}, correlationId: 'c' });
  const stub = body => { process.env.SERV_API_URL = 'https://serv.test'; globalThis.fetch = async () => new Response(JSON.stringify({ success: true, ...body }), { status: 200 }); };

  it('401 without a principal, 403 outside the household', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    stub({ rows: [] });
    assert.equal((await handle(req({}))).statusCode, 401);
    assert.equal((await handle(req({ 'x-principal-user': 'sub-z' }))).statusCode, 403);
  });

  it('a read SERV cut short is refused rather than served without a page', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    stub({ rows: [], truncated: true, total_matching: 9000, limit: 1000 });
    const r = await handle(req({ 'x-principal-user': 'sub-a' }));
    assert.equal(r.statusCode, 500);
    assert.equal(JSON.parse(r.body).error, 'pages_truncated');
  });
});
