// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/gate-responses.test.mjs
//
// Sprint 15 scope 4 — gate_id and POST /proc/gates/{runId}/responses (arch-web-app.md §2.2,
// §3.1). A gate is answered by run AND gate: an answer naming any other gate is refused, so a
// stale answer is never applied to the gate that replaced it.

import { describe, it }  from 'node:test';
import assert            from 'node:assert/strict';
import { readFileSync }  from 'node:fs';

import { checkGateResponse }  from '../../src/proc/gates.mjs';
import { withGateId }         from '../../src/proc/run-workflow.mjs';
import { readNumber as sharedReadNumber, numberRule } from '../../src/shared/number-rule.mjs';
import { readNumber as slackReadNumber }  from '../../src/ui/slackbot/form-fields.mjs';

const formStep = {
  step: '4', type: 'human_gate', gate_type: 'form', message_template: 'Amounts',
  fields: [
    { name: 'amount', label: 'Amount', type: 'number' },
    { name: 'count',  label: 'Count',  type: 'number', decimal: false, min: 1 },
    { name: 'note',   label: 'Note',   type: 'text', optional: true },
  ],
  options: [{ action: 'confirm', label: 'Save' }, { action: 'cancel', label: 'Cancel', on_select: 'cancel' }],
};
const callback = { provider: 'novia', sessionId: 5 };
const waitingAt = (gate_type, step_ref, gate_id = 'g-1') => ({
  id: 77, status: 'awaiting_human_gate', callback,
  stack: [{ type: 'workflow', local_state: {} }, { type: 'human_gate', gate_id, gate_type, step_ref, local_state: {} }],
});

describe('checkGateResponse — which gate', () => {
  it('requires gateId and action', () => {
    assert.equal(checkGateResponse(waitingAt('confirm', {}), { action: 'confirm' }).status, 400);
    assert.equal(checkGateResponse(waitingAt('confirm', {}), { gateId: 'g-1' }).status, 400);
  });

  it('404 for a run that does not exist', () => {
    assert.deepEqual(checkGateResponse(null, { gateId: 'g-1', action: 'confirm' }), { status: 404, body: { error: 'run_not_found' } });
  });

  it('409 gate_not_waiting when the run is not at a gate', () => {
    const run = { ...waitingAt('confirm', {}), status: 'running' };
    assert.equal(checkGateResponse(run, { gateId: 'g-1', action: 'confirm' }).body.error, 'gate_not_waiting');
  });

  it('409 gate_moved for an answer to a gate the run has moved past, naming the waiting one', () => {
    const out = checkGateResponse(waitingAt('confirm', {}, 'g-2'), { gateId: 'g-1', action: 'confirm' });
    assert.deepEqual(out, { status: 409, body: { error: 'gate_moved', waitingGateId: 'g-2' } });
  });

  it('a gate pushed before gates carried an id cannot be answered by id', () => {
    const out = checkGateResponse(waitingAt('confirm', {}, null), { gateId: 'g-1', action: 'confirm' });
    assert.equal(out.body.error, 'gate_moved');
  });

  it('builds the resume_gate message with the gate id and the run\'s own callback', () => {
    const out = checkGateResponse(waitingAt('choice', {}), { gateId: 'g-1', action: 'pick', selectedValue: '2026-11' });
    assert.deepEqual(out.message, {
      type: 'WORKFLOW_STEP', action: 'resume_gate', workflowRunId: 77, gateId: 'g-1',
      userResponse: 'pick', responseData: { selectedValue: '2026-11' }, callback,
    });
  });
});

describe('checkGateResponse — a form\'s number fields', () => {
  const run = waitingAt('form', formStep);

  it('hands numbers on as numbers, reading a decimal comma as Slack does', () => {
    const out = checkGateResponse(run, { gateId: 'g-1', action: 'confirm', formValues: { amount: '12,50', count: 3, note: 'x' } });
    assert.deepEqual(out.message.responseData.formValues, { amount: 12.5, count: 3, note: 'x' });
  });

  it('422 invalid_fields when a number fails its rule; the run is not resumed', () => {
    const out = checkGateResponse(run, { gateId: 'g-1', action: 'confirm', formValues: { amount: 'twelve', count: '0' } });
    assert.deepEqual(out, { status: 422, body: { error: 'invalid_fields', fields: [
      { name: 'amount', problem: 'must be a number' },
      { name: 'count',  problem: 'must be at least 1' },
    ] } });
  });

  it('leaves an empty number field to the required-field check in resumeGate', () => {
    const out = checkGateResponse(run, { gateId: 'g-1', action: 'confirm', formValues: { amount: '' } });
    assert.ok(out.message);
  });

  it('never holds back a cancel', () => {
    const out = checkGateResponse(run, { gateId: 'g-1', action: 'cancel', formValues: { amount: 'twelve' } });
    assert.ok(out.message);
  });
});

describe('the number rule is one rule', () => {
  it('Slack reads numbers with the shared function, not a copy', () => {
    assert.equal(slackReadNumber, sharedReadNumber);
  });

  it('numberRule reads a field as Slack\'s action id encodes it', () => {
    assert.deepEqual(numberRule({ type: 'number' }), { decimal: true });
    assert.deepEqual(numberRule({ decimal: false, min: 1, max: '9' }), { decimal: false, min: 1, max: 9 });
  });
});

describe('gate_id is given when a gate frame is pushed', () => {
  const src = readFileSync('src/proc/run-workflow.mjs', 'utf8');

  it('both suspend sites give the frame an id and send it on the dialog', () => {
    assert.equal((src.match(/gate_id:\s+randomUUID\(\),/g) ?? []).length, 2);
    assert.equal((src.match(/withGateId\(result\.gatePayload, gateFrame\.gate_id\)/g) ?? []).length, 2);
  });

  it('every re-render of a waiting gate carries the same id', () => {
    assert.equal((src.match(/\{ \.\.\.buildDialog\(stepRef, localState\), gate_id: frame\.gate_id \?\? null \}/g) ?? []).length, 3);
    assert.ok(!/= buildDialog\(stepRef, localState\);/.test(src), 'a dialog re-rendered without the gate id');
  });

  it('resumeGate refuses an answer that names another gate, and accepts one that names none', () => {
    assert.match(src, /if \(gateId && gateId !== frame\.gate_id\) \{[\s\S]{0,300}reason: 'gate_moved'/);
  });

  it('withGateId puts the id on the dialog and leaves the payload otherwise as it was', () => {
    const payload = { type: 'HUMAN_GATE', workflowRunId: 1, dialog: { title: 't', fields: [] } };
    assert.deepEqual(withGateId(payload, 'g-9'), { ...payload, dialog: { title: 't', fields: [], gate_id: 'g-9' } });
    assert.equal(payload.dialog.gate_id, undefined);
  });
});
