// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/gate-answer-record.test.mjs
//
// A gate's answer is recorded, and a replay can be answered with it. Gate answers were recorded
// nowhere — run 964's gate rows have a null output — so in session 1293 Novia dug the receipt out
// of the source run with run_sql and pasted it into every replay's first gate. resumeGate now
// writes the answer as sent beside the gate's own row; answer_gate { asSourceRun: true } picks the
// source run's answer for the same gate and the same visit.
//
// Run: node --test tests/unit/gate-answer-record.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildGateAnswerRecord } from '../../src/proc/run-workflow.mjs';
import { pickSourceAnswer, collapseStepLines } from '../../src/proc/minds-eye.mjs';

const gateFrame = { type: 'human_gate', frame_id: 'f-1', gate_id: 'g-1', step_number: '1', gate_type: 'form' };

describe('buildGateAnswerRecord', () => {
  const rec = buildGateAnswerRecord({ gateFrame, userResponse: 'confirm', responseData: { formValues: { receipt_text: 'MERCADONA' } } });

  it('records the answer exactly as sent, under the gate step', () => {
    assert.deepEqual(rec.outputSnapshot.answer, { userResponse: 'confirm', responseData: { formValues: { receipt_text: 'MERCADONA' } } });
    assert.equal(rec.outputSnapshot.summary, 'answered: confirm');
    assert.deepEqual(rec.inputSnapshot, { step: '1', type: 'human_gate', answer_to: 'g-1' });
  });

  it("uses a step key the idempotency check never matches against the gate's own row", () => {
    assert.equal(rec.stepKey, '1:answer:g-1');
    assert.notEqual(rec.stepKey, '1');
  });

  it('records an answer with no data as null', () => {
    assert.equal(buildGateAnswerRecord({ gateFrame, userResponse: 'cancel' }).outputSnapshot.answer.responseData, null);
  });

  it('resumeGate writes it before anything routes on the answer', () => {
    const src  = readFileSync('src/proc/run-workflow.mjs', 'utf8');
    const body = src.slice(src.indexOf('async function resumeGate'));
    assert.ok(body.indexOf('buildGateAnswerRecord(') > -1);
    assert.ok(body.indexOf('buildGateAnswerRecord(') < body.indexOf("userResponse === 'cancel'"));
  });
});

const suspended = (id, step) => ({ id, step_number: Number(step), input_snapshot: { step, type: 'human_gate' }, output_snapshot: null });
const answered  = (id, step, userResponse, responseData) => ({ id, step_number: Number(step),
  input_snapshot: { step, type: 'human_gate', answer_to: `g-${id}` },
  output_snapshot: { summary: `answered: ${userResponse}`, chars: 10, answer: { userResponse, responseData } } });

describe('pickSourceAnswer', () => {
  // The source run answered gate 1 once, then gate 4 twice (an edit loop), then gate 11.
  const sourceRows = [
    suspended(1, '1'), answered(2, '1', 'confirm', { formValues: { receipt_text: 'R' } }),
    suspended(3, '4'), answered(4, '4', 'edit', null),
    suspended(5, '4'), answered(6, '4', 'confirm', null),
    suspended(7, '11'), answered(8, '11', 'confirm', null),
  ];

  it("the first visit to a gate takes the source's first answer to it", () => {
    assert.deepEqual(pickSourceAnswer({ replayRows: [suspended(20, '1')], sourceRows, step: '1' }),
      { userResponse: 'confirm', responseData: { formValues: { receipt_text: 'R' } } });
  });

  it('a second visit takes the second answer', () => {
    const replayRows = [suspended(20, '4'), answered(21, '4', 'edit', null), suspended(22, '4')];
    assert.equal(pickSourceAnswer({ replayRows, sourceRows, step: '4' }).userResponse, 'confirm');
  });

  it('returns null where the source has no answer for that visit — a run from before answers were recorded', () => {
    assert.equal(pickSourceAnswer({ replayRows: [], sourceRows: [suspended(1, '1')], step: '1' }), null);
    const replayRows = [answered(21, '11', 'confirm', null), suspended(22, '11')];
    assert.equal(pickSourceAnswer({ replayRows, sourceRows, step: '11' }), null);
  });
});

describe('an answered gate in the outline', () => {
  it('names the answer and is never folded into a run of lines', () => {
    const lines = [0, 1, 2, 3].map(i => ({ step: String(i), type: 'human_gate', status: 'completed' }));
    lines[1] = { ...lines[1], answered: 'confirm' };
    const out = collapseStepLines(lines);
    assert.equal(out.length, 4);
    assert.equal(out[1].answered, 'confirm');
  });
});
