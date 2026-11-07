// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-commit-tested-copy.test.mjs
//
// A tested copy is committed as tested. Session 1293 sent the same patch three times — simulate,
// sandbox, commit — and the third could differ from what passed. propose_workflow_fix
// { fromSandbox: true } reads the steps from the sandbox's PGC_Workflow copy; the gate text, the
// pre-gate refusal and the write all resolve through resolveProposedSteps, so all three see it.
// The real function runs against a stubbed SERV.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProposedSteps } from '../../src/proc/minds-eye.mjs';

const LIVE = { id: 358, name: 'process_receipt', version: 13, steps: [{ step: '1', type: 'end' }] };
const COPY = { id: 358, name: 'process_receipt', version: 14, steps: [{ step: '1', type: 'end' }, { step: '2', type: 'end' }] };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serv({ sandbox = 'sandbox_9', copy = COPY } = {}) {
  process.env.SERV_API_URL = 'http://serv';
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body ?? '{}');
    const sb = init.headers?.['x-sandbox'] ?? null;
    seen.push({ url, sb, tableName: body.tableName });
    let json;
    if (url.endsWith('/sandbox/current')) json = { success: true, sandbox };
    else if (url.endsWith('/getRows')) json = { success: true, count: 1, rows: [sb ? copy : LIVE] };
    else json = { success: true };
    return { ok: true, status: 200, json: async () => json };
  };
  return seen;
}

describe('resolveProposedSteps — fromSandbox', () => {
  it("returns the sandbox copy's steps, diffed against the live ones", async () => {
    const seen = serv();
    const r = await resolveProposedSteps({ workflowName: 'process_receipt', fromSandbox: true, baseVersion: 13 });
    assert.equal(r.mode, 'from_sandbox');
    assert.deepEqual(r.currentSteps, LIVE.steps);
    assert.deepEqual(r.merged, COPY.steps);
    assert.equal(r.sandbox, 'sandbox_9');
    assert.ok(seen.some(s => s.tableName === 'PGC_Workflow' && s.sb === 'sandbox_9'), 'the copy is read through x-sandbox');
    assert.ok(seen.some(s => s.tableName === 'PGC_Workflow' && s.sb === null), 'the live row is read without it');
  });

  it('refuses when the live workflow moved since the copy was made', async () => {
    serv();
    const r = await resolveProposedSteps({ workflowName: 'process_receipt', fromSandbox: true, baseVersion: 12 });
    assert.match(r.error, /changed since the test copy was made/);
    assert.equal(r.currentVersion, 13);
  });

  it('refuses without a baseVersion, without a sandbox, or with a patch as well', async () => {
    serv();
    assert.match((await resolveProposedSteps({ workflowName: 'process_receipt', fromSandbox: true })).error, /baseVersion is required/);
    assert.match((await resolveProposedSteps({ workflowName: 'process_receipt', fromSandbox: true, baseVersion: 13, patch: [] })).error, /without patch or steps/);
    serv({ sandbox: null });
    assert.match((await resolveProposedSteps({ workflowName: 'process_receipt', fromSandbox: true, baseVersion: 13 })).error, /Commit before end_test/);
  });

  it('refuses a copy identical to the live workflow — nothing was changed', async () => {
    serv({ copy: LIVE });
    assert.match((await resolveProposedSteps({ workflowName: 'process_receipt', fromSandbox: true, baseVersion: 13 })).error, /nothing to commit/);
  });

  it('a call with neither patch, steps nor fromSandbox names all three', async () => {
    serv();
    assert.match((await resolveProposedSteps({ workflowName: 'process_receipt' })).error, /fromSandbox: true/);
  });
});
