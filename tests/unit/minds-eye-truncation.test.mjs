// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-truncation.test.mjs
//
// A response severed at the output ceiling used to end the session (session 1121,
// 2026-08-01): Novia wrote 8192 tokens of prose and was cut mid-sentence, the parse
// failed, and the round exited with "Agent reasoning failed" in Slack. The turn's work
// was never written to PGC_SessionEntry, so nothing of it survived.
//
// Truncation is not a malformed response and must not be treated as one. The correction
// path echoes the raw output back to be re-emitted as valid JSON — which is the right
// remedy for bad escaping and precisely the wrong one here, since that output is what
// exhausted the budget. The same question is asked again instead, with the cut-off
// stated.
//
// Run: node --test tests/unit/minds-eye-truncation.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLlmFailure, roundBudgetExhausted } from '../../src/proc/minds-eye.mjs';

const truncated = () => {
  const e = new Error('LLM returned invalid JSON: Unexpected token \'G\'');
  e.isParseError = true;
  e.rawOutput    = 'Good catch — serv_upsert is exactly the right tool here.';
  e.isTruncated  = true;
  return e;
};

const badEscaping = () => {
  const e = new Error('LLM returned invalid JSON: Bad control character');
  e.isParseError = true;
  e.rawOutput    = '{ "action": "respond", "message": "line one\nline two" }';
  return e;
};

describe('classifyLlmFailure', () => {

  it('re-asks a truncated response instead of correcting it', () => {
    assert.equal(classifyLlmFailure(truncated(), false), 'reask');
  });

  it('gives up when a re-ask truncates too — the notice did not land', () => {
    assert.equal(classifyLlmFailure(truncated(), true), 'fail');
  });

  it('still corrects a complete response with broken escaping', () => {
    assert.equal(classifyLlmFailure(badEscaping(), false), 'correct');
  });

  it('corrects broken escaping even directly after a truncated turn', () => {
    // lastTurnTruncated only bars a second re-ask. A different failure on the retry is
    // its own case and gets its own remedy.
    assert.equal(classifyLlmFailure(badEscaping(), true), 'correct');
  });

  it('fails a transport error — nothing to correct and nothing to re-ask', () => {
    assert.equal(classifyLlmFailure(new Error('LLM call timed out after 170s'), false), 'fail');
  });

  it('fails a parse error carrying no raw output', () => {
    const e = new Error('LLM returned empty response');
    e.isParseError = true;
    assert.equal(classifyLlmFailure(e, false), 'fail');
  });

  it('does not throw on a missing error object', () => {
    assert.equal(classifyLlmFailure(undefined, false), 'fail');
  });
});

// ── The round's wall-clock budget ───────────────────────────────────────────
//
// The loop runs its turns inside ONE Lambda invocation, so turn_limit is not the budget
// that binds. Session 1121 spent 7s, 85s and 46s on three turns and the fourth was still
// running when the invocation hit its ceiling: Duration 240000ms, Status timeout. Nothing
// catches a Lambda timeout, so no notification was posted, the turn in flight wrote
// nothing, and the SQS message had already been deleted on receipt — the round vanished,
// which from Slack is indistinguishable from hanging.

describe('roundBudgetExhausted', () => {
  const BUDGET = 195_000;

  it('always allows the first turn — nothing has been observed yet', () => {
    assert.equal(roundBudgetExhausted(0, 0, BUDGET), false);
  });

  it('allows a turn there is room for', () => {
    // 40s elapsed, longest turn so far 85s → 125s, inside the budget.
    assert.equal(roundBudgetExhausted(40_000, 85_000, BUDGET), false);
  });

  it('stops the round when the next turn would not fit', () => {
    // Session 1121's actual shape: 138s spent over three turns, longest 85s. 223s > 195s,
    // so the fourth turn — the one that died with the Lambda — never starts.
    assert.equal(roundBudgetExhausted(138_000, 85_000, BUDGET), true);
  });

  it('treats the boundary as room to run', () => {
    assert.equal(roundBudgetExhausted(110_000, 85_000, BUDGET), false);
    assert.equal(roundBudgetExhausted(110_001, 85_000, BUDGET), true);
  });

  it('tightens as the estimate grows — late turns are the expensive ones', () => {
    // Same elapsed time, different evidence about what a turn now costs.
    assert.equal(roundBudgetExhausted(120_000,  7_000, BUDGET), false);
    assert.equal(roundBudgetExhausted(120_000, 85_000, BUDGET), true);
  });

  it('never stops a round when no budget is configured', () => {
    assert.equal(roundBudgetExhausted(600_000, 200_000, undefined), false);
    assert.equal(roundBudgetExhausted(600_000, 200_000, 0), false);
  });
});

// ── The current draft ───────────────────────────────────────────────────────
//
// Tool entries are persisted WITH their params, so every array Novia submitted is already
// in PGC_SessionEntry — but the transcript rendered only `result`, so she read verdicts
// naming step keys her context did not contain. Rebuilding the whole array from reasoning
// each turn is why session 1121 drifted 19 -> 21 -> 23 steps and why `step_label` came
// back two turns after she had corrected it.

const simEntry = (stepCount, verdict, keyField = 'step') => JSON.stringify({
  tool:   'simulate_workflow',
  params: { steps: Array.from({ length: stepCount }, (_, i) => ({ [keyField]: String(i + 1), type: 'end' })) },
  result: { passed: verdict, total_issues: verdict ? 0 : 3 },
});
