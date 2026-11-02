// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-replay.test.mjs
//
// Sprint 15 scope 10 — the replay harness as Novia's tool (docs/arch-minds-eye.md §4.4,
// docs/arch-replay.md): a replay runs in her sandbox and reports to her session; a break ends her
// wait as an LLM_BREAK event; she resolves it with resolve_replay_break.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';
import { readFileSync }            from 'node:fs';
import { SQSClient }               from '@aws-sdk/client-sqs';

import { breakReport, createReplayRun } from '../../src/proc/replay.mjs';
import { describeRunEvent }             from '../../src/proc/minds-eye.mjs';

const breakFrame = {
  type: 'llm_break',
  break: {
    step_id: '7', intent_category: 'parse_receipt', reason: 'drift', policy: 'on_miss',
    drift: ['input'], instructions: 'x'.repeat(30000), candidate_session_id: 41, candidate_ids: [41, 42],
    input_diff: { changed: ['items'] }, disposition: { verdict: 'intended' },
  },
};
const atBreak = { id: 70, workflow_id: 3, status: 'awaiting_llm_break', sandbox: 'sandbox_1',
  stack: [{ type: 'workflow', current_step: '7', local_state: {} }, breakFrame] };

describe('breakReport', () => {
  it('reads the report off the break frame', () => {
    const r = breakReport(atBreak);
    assert.equal(r.step_id, '7');
    assert.deepEqual(r.drift, ['input']);
    assert.deepEqual(r.candidate_ids, [41, 42]);
  });

  it('is null for a run that is not at a break', () => {
    assert.equal(breakReport({ ...atBreak, status: 'running' }), null);
    assert.equal(breakReport({ status: 'awaiting_llm_break', stack: [] }), null);
  });
});

describe('describeRunEvent — a replay break ends her wait', () => {
  const message = { type: 'HUMAN_NOTIFICATION', message: 'BROKE at step 7', breakActions: [
    { resolution: 'use_recorded', sessionId: 41, label: 'Use recording 41' },
    { resolution: 'use_recorded', sessionId: 42, label: 'Use recording 42' },
    { resolution: 'call_live', label: 'Call the LLM (1 call)' },
    { resolution: 'abort', label: 'Abort' },
  ] };

  it('as LLM_BREAK, with the drift and every resolution offered', () => {
    const out = describeRunEvent({ message, run: atBreak });
    assert.equal(out.event, 'LLM_BREAK');
    assert.deepEqual(out.break.drift, ['input']);
    assert.deepEqual(out.resolutions, [
      { resolution: 'use_recorded', sessionId: 41 }, { resolution: 'use_recorded', sessionId: 42 },
      { resolution: 'call_live' }, { resolution: 'abort' },
    ]);
  });

  it('without the assembled prompt, which is the size of a whole prompt', () => {
    const out = describeRunEvent({ message, run: atBreak });
    assert.equal(out.break.instructions, undefined);
    assert.ok(JSON.stringify(out).length < 5000);
  });

  it('a notification from a running replay still does not', () => {
    assert.equal(describeRunEvent({ message: { type: 'HUMAN_NOTIFICATION' }, run: { ...atBreak, status: 'running', stack: [] } }), null);
  });
});

describe('createReplayRun — her replay runs in her sandbox and reports to her', () => {
  const realFetch = globalThis.fetch;
  const realSend  = SQSClient.prototype.send;
  afterEach(() => { globalThis.fetch = realFetch; SQSClient.prototype.send = realSend; });

  it('marks the run with the sandbox and her callback, and records her wait before the first step', async () => {
    const order = [];
    let inserted = null;
    process.env.SERV_API_URL = 'http://serv';
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/getRows')) return { ok: true, status: 200, json: async () => ({ success: true, count: 1, rows: [{ id: 950, workflow_id: 3, input: { x: 1 } }] }) };
      inserted = body.row;
      return { ok: true, status: 200, json: async () => ({ success: true, row: { id: 71 } }) };
    };
    SQSClient.prototype.send = async function () { order.push('dispatch'); };
    const callback = { provider: 'novia', sessionId: 5, reply: { provider: 'slack', channel: 'C' } };

    const out = await createReplayRun({ sourceRunId: 950, breakPolicy: 'on_miss', callback, sandbox: 'sandbox_1',
      triggeredBy: 'minds_eye', beforeDispatch: async (runId) => order.push(`wait ${runId}`), traceId: 't' });

    assert.deepEqual(out, { runId: 71, sourceRunId: 950 });
    assert.equal(inserted.sandbox, 'sandbox_1');
    assert.deepEqual(inserted.callback, callback);
    assert.equal(inserted.replay_source_run_id, 950);
    assert.equal(inserted.triggered_by, 'minds_eye');
    assert.deepEqual(inserted.input, { x: 1 }, 'the source run\'s input');
    assert.deepEqual(order, ['wait 71', 'dispatch']);
  });

  it('refuses an unknown break policy before touching anything', async () => {
    const out = await createReplayRun({ sourceRunId: 950, breakPolicy: 'sometimes', traceId: 't' });
    assert.equal(out.status, 400);
  });
});

describe('resolving a break waits like answering a gate', () => {
  it('her wait is recorded before the resolution is applied', () => {
    const src  = readFileSync('src/proc/minds-eye.mjs', 'utf8');
    const body = src.slice(src.indexOf('async function startResolveBreak'), src.indexOf('/** Start a test run in the sandbox'));
    assert.ok(body.includes('isOwnTestRun(run, session.id)'));
    assert.ok(body.indexOf('await pend(') > -1 && body.indexOf('await pend(') < body.indexOf('await applyBreakResolution('));
  });
});
