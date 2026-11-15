// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/runs.test.mjs
//
// Sprint 16 scope 2 (docs/arch-web-app.md §2.4, §3.1): a workflow's display, the run label the
// engine resolves from it, GET /proc/runs and starting a named workflow for the web.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';
import { SQSClient }               from '@aws-sdk/client-sqs';

import { displayProblem, resolveRunLabel }                     from '../../src/proc/workflow-display.mjs';
import { labelUpdate, LOAD_RUN_COLUMNS }                       from '../../src/proc/run-workflow.mjs';
import { parseRunsQuery, toRunsPage, handle, RUNS_MAX_LIMIT }  from '../../src/proc/runs.mjs';
import { resolveProposedSteps, displayLine }                   from '../../src/proc/minds-eye.mjs';

const realFetch = globalThis.fetch;
const realSend  = SQSClient.prototype.send;

/** Stub SERV: answer each call from `answer(path, body)` and record it. */
function stubServ(answer) {
  const calls = [];
  process.env.SERV_API_URL = 'https://serv.test';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: url.replace('https://serv.test', ''), body });
    return new Response(JSON.stringify({ success: true, ...answer(calls.at(-1).path, body) }), { status: 200 });
  };
  return calls;
}

describe('displayProblem — the display contract', () => {
  it('accepts absent, null, and the three Phase 0 keys', () => {
    for (const d of [undefined, null, {}, { label: 'Edit' }, { label: { en: 'Edit', es: 'Editar' } }, { menu: false }, { run_label: '{{period}} · {{count}} edits' }]) {
      assert.equal(displayProblem(d), null, JSON.stringify(d));
    }
  });

  it('refuses an unknown key, naming the ones it accepts', () => {
    assert.match(displayProblem({ icon: 'wallet' }), /accepts label, menu, run_label — not icon/);
  });

  it('refuses malformed values', () => {
    for (const d of [[], 'x', { label: '' }, { label: { english: 'x' } }, { label: { en: '' } }, { menu: 'no' }, { run_label: 3 }]) {
      assert.ok(displayProblem(d), JSON.stringify(d));
    }
  });
});

describe('resolveRunLabel — filled once, never formatted', () => {
  it('returns the label once every token resolves, the values as stored', () => {
    assert.equal(resolveRunLabel('{{period}} · {{count}} edits', { period: 'Nov', count: 4 }), 'Nov · 4 edits');
  });

  it('is null while any token is unresolved, or with no template', () => {
    assert.equal(resolveRunLabel('{{period}} · {{count}} edits', { period: 'Nov' }), null);
    assert.equal(resolveRunLabel(undefined, { a: 1 }), null);
    assert.equal(resolveRunLabel('  ', {}), null);
  });
});

describe('labelUpdate — written with the step, once', () => {
  const run = over => ({ label: null, workflow_display: { run_label: '{{period}}' }, stack: [{ local_state: { period: 'Nov' } }, { local_state: {} }], ...over });

  it('reads the root frame, and marks the run labelled', () => {
    const r = run();
    assert.deepEqual(labelUpdate(r), { label: 'Nov' });
    assert.equal(r.label, 'Nov');
    assert.deepEqual(labelUpdate(r), {});
  });

  it('writes nothing while unresolved, without a run_label, or once labelled', () => {
    assert.deepEqual(labelUpdate(run({ stack: [{ local_state: {} }] })), {});
    assert.deepEqual(labelUpdate(run({ workflow_display: null })), {});
    assert.deepEqual(labelUpdate(run({ label: 'Oct' })), {});
  });

  it('the run is loaded with its label', () => {
    assert.ok(LOAD_RUN_COLUMNS.includes('label'));
  });
});

describe('parseRunsQuery', () => {
  it('defaults, and reads every filter', () => {
    assert.deepEqual(parseRunsQuery({}), { workflow: null, domain: null, status: null, limit: 20, before: null });
    assert.deepEqual(parseRunsQuery({ workflow: 'w', domain: 'd', status: 'completed', limit: '5', before: '90' }),
      { workflow: 'w', domain: 'd', status: 'completed', limit: 5, before: 90 });
  });

  it('refuses out-of-range values', () => {
    for (const q of [{ limit: '0' }, { limit: String(RUNS_MAX_LIMIT + 1) }, { before: 'x' }, { status: 'done' }]) {
      assert.ok(parseRunsQuery(q).error, JSON.stringify(q));
    }
  });
});

describe('toRunsPage — visibility after the bound, cursor at the last run examined', () => {
  const wfs = new Map([[1, { name: 'w', display: { label: 'Do it' } }]]);
  const row = (id, callback) => ({ id, workflow_id: 1, label: id === 9 ? 'Nov' : null, status: 'completed', started_at: null, created_at: `t${id}`, callback });
  const member = { user: 'sub-a', roles: ['household'] };

  it('drops runs the principal may not see without moving the cursor back', () => {
    const rows = [row(9, { provider: 'web', channel: 'sub-b' }), row(8, { provider: 'slack', channel: 'C1' }), row(7, null)];
    const page = toRunsPage(rows, wfs, member, 2);
    assert.deepEqual(page.runs.map(r => r.runId), [8]);
    assert.equal(page.cursor, 8);
    assert.equal(page.more, true);
    assert.deepEqual(page.runs[0], { runId: 8, workflowName: 'w', workflowLabel: 'Do it', label: null, status: 'completed', startedAt: 't8' });
  });

  it('an empty page has no cursor', () => {
    assert.deepEqual(toRunsPage([], wfs, member, 20), { runs: [], cursor: null, more: false });
  });
});

describe('/proc/runs — the principal, and starting a run', () => {
  afterEach(() => { globalThis.fetch = realFetch; SQSClient.prototype.send = realSend; delete process.env.HOUSEHOLD_PRINCIPALS; });
  const req = (method, headers, extra = {}) => ({ method, proxy: 'runs', route: 'runs', headers, query: {}, correlationId: 'c', ...extra });
  const out = r => [r.statusCode, JSON.parse(r.body)];

  it('401 without a principal, for both methods', async () => {
    const calls = stubServ(() => ({ rows: [] }));
    assert.equal((await handle(req('GET', {}))).statusCode, 401);
    assert.equal((await handle(req('POST', {}, { body: { workflow: 'w' } }))).statusCode, 401);
    assert.equal(calls.length, 0);
  });

  it('403 when a principal outside the household starts a run', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ(() => ({ rows: [] }));
    const [status, body] = out(await handle(req('POST', { 'x-principal-user': 'sub-z' }, { body: { workflow: 'w' } })));
    assert.deepEqual([status, body.error], [403, 'household_required']);
    assert.equal(calls.length, 0);
  });

  it('404 for a system workflow (domain null) and for an unknown name', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    for (const rows of [[{ id: 1, domain: null }], []]) {
      stubServ(() => ({ rows }));
      const [status, body] = out(await handle(req('POST', { 'x-principal-user': 'sub-a' }, { body: { workflow: 'w' } })));
      assert.deepEqual([status, body.error], [404, 'workflow_not_found']);
    }
  });

  it('starts a domain workflow for the web: its callback names the principal, no threadId', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    process.env.SQS_WORKFLOW_URL = 'workflow-queue';
    const sent = [];
    SQSClient.prototype.send = async function (command) { sent.push(command.input); };
    const calls = stubServ(path => path.endsWith('insertRow') ? { row: { id: 77 } } : { rows: [{ id: 5, domain: 'd' }] });
    const [status, body] = out(await handle(req('POST', { 'x-principal-user': 'sub-a' }, { body: { workflow: 'w' } })));
    assert.deepEqual([status, body.runId], [202, 77]);
    const inserted = calls.find(c => c.path.endsWith('insertRow')).body.row;
    assert.deepEqual(inserted.callback, { provider: 'web', channel: 'sub-a' });
    assert.equal(inserted.triggered_by, 'web');
    assert.deepEqual(inserted.input, { domain: 'd' });
    assert.equal(JSON.parse(sent[0].MessageBody).workflowRunId, 77);
  });

  it('lists with explicit columns — never the stack — newest first', async () => {
    process.env.HOUSEHOLD_PRINCIPALS = 'sub-a';
    const calls = stubServ(() => ({ rows: [] }));
    const r = await handle(req('GET', { 'x-principal-user': 'sub-a' }, { query: { status: 'completed', before: '50' } }));
    assert.equal(r.statusCode, 200);
    const list = calls[0].body;
    assert.equal(list.tableName, 'PGC_WorkflowRun');
    assert.ok(!list.columns.includes('stack'));
    assert.equal(list.orderBy, 'id DESC');
    assert.deepEqual(list.filters, [{ column: 'status', op: 'eq', value: 'completed' }, { column: 'id', op: 'lt', value: 50 }]);
  });
});

describe('Novia writes a workflow\'s display', () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  it('a display can be proposed on its own, against the version she read', async () => {
    stubServ(() => ({ rows: [{ id: 3, version: 4, steps: [{ step: '1', type: 'end' }], display: null }] }));
    const resolved = await resolveProposedSteps({ workflowName: 'w', display: { run_label: '{{period}}' }, baseVersion: 4 });
    assert.equal(resolved.error, undefined);
    assert.deepEqual(resolved.merged, [{ step: '1', type: 'end' }]);
    const stale = await resolveProposedSteps({ workflowName: 'w', display: { run_label: '{{period}}' }, baseVersion: 3 });
    assert.match(stale.error, /has changed since you read it/);
  });

  it('the gate shows a display in one line', () => {
    assert.equal(displayLine(null), '_(none)_');
    assert.equal(displayLine({ label: 'Do it', menu: false, run_label: '{{period}}' }), 'label `Do it` · kept out of menus · runs named `{{period}}`');
  });
});
