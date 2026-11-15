// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/workflows-me.test.mjs
//
// Sprint 17 scope 2 (docs/arch-web-app.md §3.1, v0.8): GET /proc/workflows — the Domains menu —
// and GET /proc/me — the principal with the household's locale and timezone.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';

import { humanise, domainMenus, handle as workflows } from '../../src/proc/workflows.mjs';
import { describePrincipal, handle as me }            from '../../src/proc/me.mjs';

const wf = (name, domain, version, display = null, description = null) => ({ name, domain, version, display, description });

describe('domainMenus — what the Domains menu draws', () => {
  it('humanises an identifier with no label', () => {
    assert.equal(humanise('budgets_expenses'), 'Budgets expenses');
    assert.equal(humanise('edit_budget'), 'Edit budget');
  });

  it('lists the latest version of each domain workflow, labelled from its display', () => {
    const menus = domainMenus(
      [{ domain: 'things', display: { label: 'All the things' } }],
      [wf('do_thing', 'things', 1, { label: 'Old label' }), wf('do_thing', 'things', 3, { label: 'Do a thing' }, 'Does it'), wf('do_thing', 'things', 2)],
      'en');
    assert.deepEqual(menus, [{
      domain: 'things', label: 'All the things', labelFallback: false,
      workflows: [{ name: 'do_thing', label: 'Do a thing', labelFallback: false, description: 'Does it' }],
    }]);
  });

  it('leaves out system workflows and those whose latest display.menu is false', () => {
    const menus = domainMenus([], [
      wf('ping_core', null, 1),
      wf('hidden', 'things', 1),
      wf('hidden', 'things', 2, { menu: false }),
      wf('shown', 'things', 1, { menu: true }),
    ], 'en');
    assert.deepEqual(menus.map(d => d.domain), ['things']);
    assert.deepEqual(menus[0].workflows.map(w => w.name), ['shown']);
  });

  it('a domain with no workflows is listed, and a workflow\'s domain with no help row is too', () => {
    const menus = domainMenus([{ domain: 'empty_one', display: null }], [wf('do_it', 'orphan_domain', 1)], 'en');
    assert.deepEqual(menus.map(d => [d.domain, d.label, d.labelFallback, d.workflows.length]),
      [['empty_one', 'Empty one', true, 0], ['orphan_domain', 'Orphan domain', true, 1]]);
    assert.deepEqual(menus[1].workflows[0], { name: 'do_it', label: 'Do it', labelFallback: true, description: null });
  });

  it('resolves a language map to the locale, then English, then its first entry', () => {
    const rows = [
      { domain: 'a', display: { label: { en: 'Alpha', es: 'Alfa' } } },
      { domain: 'b', display: { label: { fr: 'Bêta' } } },
    ];
    assert.deepEqual(domainMenus(rows, [], 'es').map(d => d.label), ['Alfa', 'Bêta']);
    assert.deepEqual(domainMenus(rows, [], 'de').map(d => d.label), ['Alpha', 'Bêta']);
  });

  it('a malformed label falls back to the identifier rather than showing it', () => {
    const [d] = domainMenus([{ domain: 'things', display: { label: '' } }], [], 'en');
    assert.deepEqual([d.label, d.labelFallback], ['Things', true]);
  });

  it('sorts domains and workflows by label in the locale, not by identifier', () => {
    const menus = domainMenus(
      [{ domain: 'z_domain', display: { label: 'Apples' } }, { domain: 'a_domain', display: { label: 'Zebras' } }],
      [wf('b_flow', 'z_domain', 1, { label: 'ébauche' }), wf('a_flow', 'z_domain', 1, { label: 'Fin' })],
      'fr');
    assert.deepEqual(menus.map(d => d.label), ['Apples', 'Zebras']);
    assert.deepEqual(menus[0].workflows.map(w => w.label), ['ébauche', 'Fin']);
  });
});

describe('GET /proc/workflows — the household\'s', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.HOUSEHOLD_PRINCIPALS; delete process.env.HOUSEHOLD_LOCALE; });
  const req = headers => ({ method: 'GET', proxy: 'workflows', route: 'workflows', headers, query: {}, correlationId: 'c' });
  const calls = [];
  const stub = byTable => {
    calls.length = 0;
    process.env.SERV_API_URL = 'https://serv.test';
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return new Response(JSON.stringify({ success: true, ...byTable[body.tableName] }), { status: 200 });
    };
  };

  it('401 without a principal, 403 outside the household', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    stub({ PGC_DomainHelp: { rows: [] }, PGC_Workflow: { rows: [] } });
    assert.equal((await workflows(req({}))).statusCode, 401);
    assert.equal((await workflows(req({ 'x-principal-user': 'sub-z' }))).statusCode, 403);
    assert.equal(calls.length, 0);
  });

  it('reads domain workflows only, with explicit columns, and serves the menu', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    process.env.HOUSEHOLD_LOCALE = 'en';
    stub({
      PGC_DomainHelp: { rows: [{ domain: 'things', display: { label: 'Things' } }] },
      PGC_Workflow:   { rows: [wf('do_thing', 'things', 1, { label: 'Do a thing' })] },
    });
    const r = await workflows(req({ 'x-principal-user': 'sub-a' }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body).domains[0].workflows.map(w => w.label), ['Do a thing']);
    const wfRead = calls.find(c => c.tableName === 'PGC_Workflow');
    assert.deepEqual(wfRead.filters, [{ column: 'domain', op: 'not_null' }]);
    assert.deepEqual(wfRead.columns, ['name', 'domain', 'version', 'description', 'display']);
    assert.deepEqual(calls.find(c => c.tableName === 'PGC_DomainHelp').columns, ['domain', 'display']);
  });

  it('a read SERV cut short is refused rather than served without a workflow', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    stub({ PGC_DomainHelp: { rows: [] }, PGC_Workflow: { rows: [], truncated: true, total_matching: 4000, limit: 1000 } });
    const r = await workflows(req({ 'x-principal-user': 'sub-a' }));
    assert.equal(r.statusCode, 500);
    assert.deepEqual([JSON.parse(r.body).error, JSON.parse(r.body).totalMatching], ['workflows_truncated', 4000]);
  });
});

describe('GET /proc/me — the principal, in the household\'s language and timezone', () => {
  afterEach(() => { delete process.env.HOUSEHOLD_PRINCIPALS; delete process.env.HOUSEHOLD_LOCALE; delete process.env.HOUSEHOLD_TIMEZONE; });
  const req = headers => ({ method: 'GET', proxy: 'me', route: 'me', headers, query: {}, correlationId: 'c' });

  it('describes a principal from configuration', () => {
    assert.deepEqual(describePrincipal({ user: 'sub-a', roles: ['household'] }, { HOUSEHOLD_LOCALE: 'en', HOUSEHOLD_TIMEZONE: 'Europe/Madrid' }),
      { user: 'sub-a', roles: ['household'], locale: 'en', timezone: 'Europe/Madrid' });
  });

  it('401 without a principal; any principal is told its roles, household or none', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    process.env.HOUSEHOLD_LOCALE = 'en';
    process.env.HOUSEHOLD_TIMEZONE = 'Europe/Madrid';
    assert.equal((await me(req({}))).statusCode, 401);
    const inside = JSON.parse((await me(req({ 'x-principal-user': 'sub-a' }))).body);
    assert.deepEqual([inside.user, inside.roles, inside.locale, inside.timezone], ['sub-a', ['household'], 'en', 'Europe/Madrid']);
    const outside = JSON.parse((await me(req({ 'x-principal-user': 'sub-z' }))).body);
    assert.deepEqual(outside.roles, []);
  });
});
