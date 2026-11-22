// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/reads.test.mjs
//
// Sprint 16 scope 4 (docs/arch-web-app.md §2.6, §3.1): the waiting gates of every provider, a
// workflow's latest output, and the read-only records read — each checked against the principal.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';

import { toWaitingGate, waitingGatesFor, handle as gates }      from '../../src/proc/gates.mjs';
import { handle as outputs }                                    from '../../src/proc/outputs.mjs';
import { parseSourceQuery, chooseColumns, pageOrder, handle as sources } from '../../src/proc/sources.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete process.env.HOUSEHOLD_PRINCIPALS; });

/** Stub SERV, answering each call from `answer(body, n)`. */
function stubServ(answer) {
  const calls = [];
  process.env.SERV_API_URL = 'https://serv.test';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(JSON.stringify({ success: true, ...answer(body, calls.length) }), { status: 200 });
  };
  return calls;
}
const req = (proxy, method, headers, extra = {}) => ({ method, proxy, route: proxy.split('/').pop(), headers, query: {}, correlationId: 'c', ...extra });
const member = { 'x-principal-user': 'sub-a' };
const body = r => JSON.parse(r.body);

const gateStep = { step: '3', type: 'human_gate', gate_type: 'confirm', message_template: 'Save {{month}}?',
  options: [{ action: 'confirm', label: 'Save' }, { action: 'cancel', label: 'Cancel' }] };
const atGate = (id, callback, pushedAt) => ({
  id, workflow_id: 5, label: null, status: 'awaiting_human_gate', callback,
  stack: [{ type: 'workflow', local_state: { month: 'May' } },
          { type: 'human_gate', gate_id: `g-${id}`, gate_type: 'confirm', step_ref: gateStep, workflow_name: 'w', local_state: { month: 'May' }, pushed_at: pushedAt }],
});

const pick = g => [g.workflowLabel, g.labelFallback];

describe('toWaitingGate — the dialog Slack is sent, rebuilt from the frame', () => {
  it('carries the gate_id an answer must name, and the resolved message', () => {
    const gate = toWaitingGate(atGate(9, { provider: 'slack', channel: 'C1' }, '2026-11-15T10:00:00Z'));
    assert.equal(gate.gateId, 'g-9');
    assert.equal(gate.dialog.gate_id, 'g-9');
    assert.equal(gate.dialog.fields[0].value, 'Save May?');
    assert.deepEqual([gate.runId, gate.workflowName, gate.gate_type, gate.provider], [9, 'w', 'confirm', 'slack']);
  });

  it('names its workflow for a person: the stored label in the household\'s language, else the humanised name', () => {
    const run = atGate(9, { provider: 'slack', channel: 'C1' }, 't');
    assert.deepEqual(pick(toWaitingGate(run, { label: { en: 'Do it', es: 'Hazlo' } }, 'es')), ['Hazlo', false]);
    assert.deepEqual(pick(toWaitingGate(run, null, 'en')), ['W', true]);
    run.stack[1].workflow_name = 'ping_core';
    assert.deepEqual(pick(toWaitingGate(run, { run_label: 'x' }, 'en')), ['Ping core', true]);
  });

  it('is null for a run that is not at a gate', () => {
    assert.equal(toWaitingGate({ id: 1, status: 'running', stack: [] }), null);
  });
});

describe('waitingGatesFor — every provider\'s, the principal\'s only, oldest first', () => {
  it('drops another user\'s web run and Novia\'s test run; keeps Slack and scheduled runs', () => {
    const p = { user: 'sub-a', roles: ['household'] };
    const runs = [
      atGate(1, { provider: 'slack', channel: 'C1' }, '2026-11-15T12:00:00Z'),
      atGate(2, null, '2026-11-15T09:00:00Z'),
      atGate(3, { provider: 'web', channel: 'sub-b' }, '2026-11-15T08:00:00Z'),
      atGate(4, { provider: 'novia', sessionId: 5 }, '2026-11-15T07:00:00Z'),
    ];
    assert.deepEqual(waitingGatesFor(p, runs).map(g => g.runId), [2, 1]);
  });
});

describe('/proc/gates over HTTP — every id checked against the principal', () => {
  it('401 on every gate route without a principal, and no SERV call', async () => {
    const calls = stubServ(() => ({ rows: [] }));
    for (const [proxy, method] of [['gates', 'GET'], ['gates/9', 'GET'], ['gates/9/responses', 'POST']]) {
      assert.equal((await gates(req(proxy, method, {}, { body: { gateId: 'g', action: 'confirm' } }))).statusCode, 401, proxy);
    }
    assert.equal(calls.length, 0);
  });

  it('an answer to another user\'s web run, or to Novia\'s test run, is refused before anything is enqueued', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    for (const callback of [{ provider: 'web', channel: 'sub-b' }, { provider: 'novia', sessionId: 5 }]) {
      const calls = stubServ(() => ({ rows: [atGate(9, callback, 't')] }));
      const r = await gates(req('gates/9/responses', 'POST', member, { body: { gateId: 'g-9', action: 'confirm' } }));
      assert.deepEqual([r.statusCode, body(r).error], [403, 'run_forbidden']);
      assert.equal(calls.length, 1);
    }
  });

  it('one run\'s gate, or 404 when it is not waiting', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    stubServ(() => ({ rows: [atGate(9, { provider: 'slack', channel: 'C1' }, 't')] }));
    const r = await gates(req('gates/9', 'GET', member));
    assert.deepEqual([r.statusCode, body(r).gateId], [200, 'g-9']);
    assert.equal(body(r).workflowLabel, 'W');
    stubServ(() => ({ rows: [{ id: 9, status: 'completed', stack: [], callback: { provider: 'slack' } }] }));
    const done = await gates(req('gates/9', 'GET', member));
    assert.deepEqual([done.statusCode, body(done).error], [404, 'gate_not_waiting']);
  });

  it('the list reads each waiting run\'s workflow display once, by id', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    process.env.HOUSEHOLD_LOCALE = 'en';
    const calls = stubServ((b, n) => (n === 1
      ? { rows: [atGate(1, { provider: 'slack' }, 'a'), atGate(2, { provider: 'slack' }, 'b')] }
      : { rows: [{ id: 5, display: { label: 'Do it' } }] }));
    const r = await gates(req('gates', 'GET', member));
    assert.deepEqual(body(r).gates.map(pick), [['Do it', false], ['Do it', false]]);
    assert.deepEqual(calls[1].filters, [{ column: 'id', op: 'in', value: [5] }]);
    delete process.env.HOUSEHOLD_LOCALE;
  });

  it('the list says when waiting runs past those read remain', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ(() => ({ rows: [], truncated: true }));
    const r = await gates(req('gates', 'GET', member));
    assert.deepEqual(body(r), { success: true, gates: [], more: true });
    assert.deepEqual(calls[0].filters, [{ column: 'status', op: 'eq', value: 'awaiting_human_gate' }]);
  });
});

describe('GET /proc/outputs/{workflow} — the latest completed run\'s last notification', () => {
  it('reads the inbox for the latest completed run', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ((b, n) => n === 1 ? { rows: [{ id: 4 }] }
      : n === 2 ? { rows: [{ id: 77, label: 'Nov', completed_at: 't' }] }
      : { rows: [{ payload: { message: 'Report' } }] });
    const r = await outputs(req('outputs/report_thing', 'GET', member));
    assert.deepEqual(body(r), { success: true, runId: 77, label: 'Nov', completedAt: 't', payload: { message: 'Report' } });
    assert.deepEqual(calls[2].filters, [{ column: 'workflow_run_id', op: 'eq', value: 77 }, { column: 'message_type', op: 'eq', value: 'HUMAN_NOTIFICATION' }]);
  });

  it('no_output before a completed run, 403 outside the household, 401 without a principal', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    stubServ((b, n) => n === 1 ? { rows: [{ id: 4 }] } : { rows: [] });
    assert.equal(body(await outputs(req('outputs/w', 'GET', member))).error, 'no_output');
    assert.equal((await outputs(req('outputs/w', 'GET', { 'x-principal-user': 'sub-z' }))).statusCode, 403);
    assert.equal((await outputs(req('outputs/w', 'GET', {}))).statusCode, 401);
  });
});

describe('GET /proc/sources/{source}/rows — read-only, registered columns only', () => {
  const registered = [{ name: 'id', type: 'serial' }, { name: 'name', type: 'varchar' }, { name: 'name_embedding', type: 'vector(2560)' }];

  it('parses the query, and refuses a malformed one', () => {
    assert.deepEqual(parseSourceQuery({ columns: 'id, name', filter: '[{"column":"id","op":"gt","value":3}]', order_by: 'name ASC', limit: '20' }),
      { columns: ['id', 'name'], filter: [{ column: 'id', op: 'gt', value: 3 }], orderBy: 'name ASC', limit: 20, offset: 0, withVersion: false });
    assert.equal(parseSourceQuery({ offset: '100' }).offset, 100);
    for (const q of [{ limit: '501' }, { filter: 'nope' }, { filter: '[{"op":"eq"}]' }, { offset: '-1' }, { offset: 'x' }]) assert.ok(parseSourceQuery(q).error, JSON.stringify(q));
  });

  it('a page\'s order ends on id where the source has one, so pages neither repeat nor skip a row (item 9)', () => {
    assert.equal(pageOrder('date DESC', registered), 'date DESC, id ASC');
    assert.equal(pageOrder(null, registered), 'id ASC');
    assert.equal(pageOrder('name ASC, id DESC', registered), 'name ASC, id DESC');
    assert.equal(pageOrder('"id"', registered), '"id"');
    assert.equal(pageOrder('identifier ASC', registered), 'identifier ASC, id ASC');
    assert.equal(pageOrder('year DESC', [{ name: 'year', type: 'integer' }]), 'year DESC', 'a view without id keeps its own order');
    assert.equal(pageOrder(null, [{ name: 'year', type: 'integer' }]), undefined);
  });

  it('?offset reads the next page, in the page order', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ((b, n) => n === 1 ? { rows: [{ table_name: 'PGD_Items', type: 'table', columns: registered }] }
      : { rows: [{ id: 101, name: 'z' }], offset: 100 });
    const r = await sources(req('sources/PGD_Items/rows', 'GET', member, { query: { order_by: 'name ASC', offset: '100' } }));
    assert.deepEqual([body(r).rows, body(r).more], [[{ id: 101, name: 'z' }], false]);
    assert.deepEqual([calls[1].offset, calls[1].orderBy, calls[1].limit], [100, 'name ASC, id ASC', 100]);
  });

  it('defaults to every non-vector column; any column named must be registered', () => {
    assert.deepEqual(chooseColumns(registered, { columns: null, filter: [] }).columns.map(c => c.name), ['id', 'name']);
    assert.match(chooseColumns(registered, { columns: ['colour'], filter: [{ column: 'size', op: 'eq' }] }).error, /no column "colour", "size"/);
  });

  it('each column carries its humanised name as its label, marked labelFallback', () => {
    assert.deepEqual(chooseColumns([{ name: 'purchase_date', type: 'date' }, { name: 'id', type: 'serial' }], { columns: null, filter: [] }).columns, [
      { name: 'purchase_date', type: 'date', label: 'Purchase date', labelFallback: true },
      { name: 'id', type: 'serial', label: 'Id', labelFallback: true },
    ]);
  });

  it('a PGC_ table is never a source', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ(() => ({ rows: [] }));
    const r = await sources(req('sources/PGC_WorkflowRun/rows', 'GET', member));
    assert.deepEqual([r.statusCode, body(r).error], [404, 'source_not_found']);
    assert.equal(calls.length, 0);
  });

  it('an entity reads its root table, and a withheld page says so', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ((b, n) => n === 1 ? { rows: [] }
      : n === 2 ? { rows: [{ root_table: 'PGD_Items' }] }
      : n === 3 ? { rows: [{ table_name: 'PGD_Items', type: 'table', columns: registered }] }
      : { rows: [{ id: 1, name: 'a' }], truncated: true, total_matching: 900 });
    const r = await sources(req('sources/Item/rows', 'GET', member, { query: { limit: '1' } }));
    assert.deepEqual(body(r), { success: true, columns: [{ name: 'id', type: 'serial', label: 'Id', labelFallback: true }, { name: 'name', type: 'varchar', label: 'Name', labelFallback: true }], rows: [{ id: 1, name: 'a' }], more: true, totalMatching: 900 });
    assert.deepEqual([calls[3].tableName, calls[3].columns], ['PGD_Items', ['id', 'name']]);
  });

  it('403 outside the household, 401 without a principal', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    stubServ(() => ({ rows: [] }));
    assert.equal((await sources(req('sources/PGD_Items/rows', 'GET', { 'x-principal-user': 'sub-z' }))).statusCode, 403);
    assert.equal((await sources(req('sources/PGD_Items/rows', 'GET', {}))).statusCode, 401);
  });
});
