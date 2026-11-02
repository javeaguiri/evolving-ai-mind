// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/proc-sandbox.test.mjs
//
// Sprint 15 scope 2 — the test sandbox's PROC half (docs/arch-sandbox.md §3): a test run's SERV
// calls carry x-sandbox, set once when run-workflow loads the run, scoped to one message so it
// can never reach the next; no episodic memory for a test run; serv_schema refused inside one.
// fetch is stubbed, so what is checked is the header each real SERV call actually sends.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';

import { getRows, sandboxScope, setSandbox, withSandbox, currentSandbox } from '../../src/shared/serv-client.mjs';
import { dispatchSqs, LOAD_RUN_COLUMNS }                                 from '../../src/proc/run-workflow.mjs';
import { shouldWriteEpisodicMemory }                                     from '../../src/proc/memory-writer.mjs';
import { executeStep }                                                   from '../../src/proc/step-executor.mjs';

const realFetch = globalThis.fetch;
let sent;
const respondWith = (fn) => {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body ?? '{}');
    sent.push({ url, sandbox: init.headers['x-sandbox'] ?? null, tableName: body.tableName });
    const out = fn(body, sent.length);
    return { ok: !out.__fail, status: out.__fail ? 500 : 200, json: async () => out };
  };
};
beforeEach(() => { sent = []; process.env.SERV_API_URL = 'http://serv'; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('serv-client — the x-sandbox header', () => {
  it('is sent only inside a sandbox', async () => {
    respondWith(() => ({ success: true, rows: [] }));
    await getRows('PGD_A');
    await withSandbox('sandbox_9', () => getRows('PGD_A'));
    await getRows('PGD_A');
    assert.deepEqual(sent.map(s => s.sandbox), [null, 'sandbox_9', null]);
  });

  it('setSandbox names it for the rest of its scope, and does nothing outside one', async () => {
    respondWith(() => ({ success: true, rows: [] }));
    setSandbox('sandbox_1');
    assert.equal(currentSandbox(), null);
    await sandboxScope(async () => {
      await getRows('PGD_A');
      setSandbox('sandbox_2');
      await getRows('PGD_A');
    });
    assert.deepEqual(sent.map(s => s.sandbox), [null, 'sandbox_2']);
  });

  it('two scopes running at once never see each other\'s sandbox', async () => {
    respondWith(() => ({ success: true, rows: [] }));
    const tick = () => new Promise(r => setImmediate(r));
    await Promise.all([
      sandboxScope(async () => { setSandbox('sandbox_1'); await tick(); await getRows('PGD_one'); }),
      sandboxScope(async () => { await tick(); await getRows('PGD_two'); }),
    ]);
    assert.deepEqual(Object.fromEntries(sent.map(s => [s.tableName, s.sandbox])), { PGD_one: 'sandbox_1', PGD_two: null });
  });
});

describe('run-workflow — a test run\'s calls go to its sandbox', () => {
  it('loads the sandbox column with the run', () => {
    assert.ok(LOAD_RUN_COLUMNS.includes('sandbox'));
  });

  it('from the moment the run is loaded, and not for the next message', async () => {
    const runs = { 1: { id: 1, workflow_id: 7, status: 'running', stack: [], sandbox: 'sandbox_4' },
                   2: { id: 2, workflow_id: 7, status: 'running', stack: [], sandbox: null } };
    respondWith((body) => {
      if (body.tableName === 'PGC_WorkflowRun') return { success: true, count: 1, rows: [runs[body.filters[0].value]] };
      if (body.tableName === 'PGC_Workflow')    return { __fail: true, error: 'stop here' };
      return { success: true, rows: [] };
    });
    await dispatchSqs({ action: 'execute_top', workflowRunId: 1, traceId: 't' }).catch(() => {});
    const first = sent.length;
    await dispatchSqs({ action: 'execute_top', workflowRunId: 2, traceId: 't' }).catch(() => {});

    assert.deepEqual(sent.slice(0, first).map(s => [s.tableName, s.sandbox]),
      [['PGC_WorkflowRun', null], ['PGC_Workflow', 'sandbox_4']], 'the run row is read from household data; everything after it from the sandbox');
    assert.deepEqual(sent.slice(first).map(s => s.sandbox), [null, null], 'the next message starts outside any sandbox');
  });
});

describe('a test run writes no household memory and creates no tables', () => {
  it('no episodic memory for a sandbox run', () => {
    const run = { input: { domain: 'flashcards' }, workflow_name: 'quiz' };
    assert.equal(shouldWriteEpisodicMemory(run), true);
    assert.equal(shouldWriteEpisodicMemory({ ...run, sandbox: 'sandbox_1' }), false);
  });

  it('serv_schema is refused inside a sandbox, naming the step and what it means for the test', async () => {
    respondWith(() => ({ success: true }));
    const step = { step: '5', type: 'serv_schema', input: { tableName: 'PGD_New', columns: [] } };
    await assert.rejects(
      withSandbox('sandbox_1', () => executeStep({ step, localState: {}, run: { id: 1 }, traceId: 't' })),
      /serv_schema createTable for "PGD_New" cannot run in a test run[\s\S]*not covered by the test/
    );
    assert.equal(sent.length, 0, 'nothing reached SERV');
  });
});
