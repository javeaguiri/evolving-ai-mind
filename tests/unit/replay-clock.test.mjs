// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/replay-clock.test.mjs
//
// A replay reads the source run's clock (docs/arch-replay.md §9a). Found live 2026-11-02: replay
// 959 of process_receipt run 946 broke at parse_receipt with hard input drift because step 1b,
// `new Date().toISOString().slice(0, 10)`, gave 2026-11-02 where the source had 2026-10-31.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { replayDate, runSandboxedExpression, executeStep } from '../../src/proc/step-executor.mjs';

const DAY = 86_400_000;
const step1b = { step: '1b', type: 'js_transform', expression: 'new Date().toISOString().slice(0, 10)', output_key: 'current_date' };

describe('replayDate — a Date whose now is the source run\'s', () => {
  const ReplayDate = replayDate(-2 * DAY);

  it('now, constructed or read, is shifted by the offset', () => {
    assert.ok(Math.abs(new ReplayDate().getTime() - (Date.now() - 2 * DAY)) < 1000);
    assert.ok(Math.abs(ReplayDate.now() - (Date.now() - 2 * DAY)) < 1000);
  });

  it('a date built from explicit arguments is not shifted', () => {
    assert.equal(new ReplayDate('2026-10-31T09:38:00Z').toISOString(), '2026-10-31T09:38:00.000Z');
    assert.equal(new ReplayDate(2026, 0, 1).getFullYear(), 2026);
    assert.equal(ReplayDate.parse('2026-10-31T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z'));
  });

  it('behaves as a Date for the code that receives it', () => {
    assert.ok(new ReplayDate() instanceof Date);
    assert.equal(typeof ReplayDate(), 'string', 'called without new, as Date() is');
  });
});

describe('the expression sandbox reads the clock it is given', () => {
  it('process_receipt step 1b gives the source run\'s date under a replay clock', () => {
    const sourceDay = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    assert.equal(runSandboxedExpression(step1b.expression, null, {}, 't', replayDate(-2 * DAY)), sourceDay);
    assert.equal(runSandboxedExpression(step1b.expression, null, {}, 't'), new Date().toISOString().slice(0, 10), 'and today without one');
  });

  it('js_transform and condition steps take the run\'s clock', async () => {
    const run = { id: 1, clock: replayDate(-2 * DAY) };
    const sourceDay = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    const transform = await executeStep({ step: step1b, localState: {}, run, traceId: 't' });
    assert.equal(transform.outputValue, sourceDay);

    const due = { step: '6', type: 'condition', expression: `new Date().toISOString().slice(0, 10) === '${sourceDay}'`, on_success: '7', on_else: '8' };
    const routed = await executeStep({ step: due, localState: {}, run, traceId: 't' });
    assert.equal(routed.nextAction, '7', 'the condition saw the source run\'s day');
  });
});

describe('run-workflow sets the clock on a replay only', () => {
  const src = readFileSync('src/proc/run-workflow.mjs', 'utf8');

  it('from the source run\'s created_at, when it loads a replay run', () => {
    assert.match(src, /if \(run\.replay_source_run_id != null\) \{[\s\S]{0,300}run\.clock = replayDate\(Date\.parse\(src\.rows\[0\]\.created_at\) - Date\.parse\(run\.created_at\)\);/);
  });

  it('loads created_at with the run', async () => {
    const { LOAD_RUN_COLUMNS } = await import('../../src/proc/run-workflow.mjs');
    assert.ok(LOAD_RUN_COLUMNS.includes('created_at'));
  });
});
