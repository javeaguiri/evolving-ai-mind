// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-read-workflow-run.test.mjs
//
// read_workflow_run (Sprint 15 scope 3) — projectWorkflowRun, the pure half of the tool.
// The traps it exists to close: PGC_WorkflowRun.state is written only at completion, so a live
// run's values are in its top frame; and output_snapshot is an 800-character summary, so the
// full output is the value at the step's output_key.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { projectWorkflowRun } from '../../src/proc/minds-eye.mjs';
import { buildDialog }        from '../../src/proc/step-executor.mjs';

const gateStep = {
  step: '3', type: 'human_gate', gate_type: 'confirm', description: 'Save the budget',
  message_template: 'Save the budget for {{month}}?',
  options: [{ action: 'confirm', label: 'Save' }, { action: 'cancel', label: 'Cancel', on_select: 'cancel' }],
};
const workflow = {
  name: 'edit_thing', version: 4,
  steps: [
    { step: '1', type: 'serv_query', output_key: 'rows' },
    { step: '2', type: 'js_transform', output_key: 'view.summary' },
    gateStep,
  ],
};
const row = (id, step, extra = {}) => ({
  id, step_number: Number(step), step_type: 'js_transform', status: 'completed', duration_ms: 2,
  input_snapshot: { step, type: 'js_transform' }, output_snapshot: { chars: 40, summary: `out ${step}` },
  executed_at: `2026-11-02T10:00:0${id}Z`, ...extra,
});
const stepRows = [row(1, '1'), row(2, '2'), row(3, '2', { status: 'failed', error: 'boom' })];
const live     = { month: 'November', rows: [{ id: 7 }], view: { summary: 'Total 120' } };

const waiting = {
  id: 900, workflow_id: 11, status: 'awaiting_human_gate', triggered_by: 'minds_eye',
  stack: [
    { type: 'workflow', current_step: '3', local_state: live },
    { type: 'human_gate', gate_type: 'confirm', step_ref: gateStep, step_number: '3', local_state: live, pushed_at: 'T', gate_id: 'g-1' },
  ],
  state: {},
};

describe('projectWorkflowRun — the waiting gate', () => {
  it('renders the gate as the person answering it sees it', () => {
    const out = projectWorkflowRun({ run: waiting, workflow, stepRows });
    assert.equal(out.status, 'awaiting_human_gate');
    assert.deepEqual(out.waiting_gate, {
      gate_id: 'g-1', gate_type: 'confirm', step: '3', waiting_since: 'T',
      dialog: buildDialog(gateStep, live),
    });
    assert.match(JSON.stringify(out.waiting_gate.dialog), /Save the budget for November\?/);
  });

  it('reports gate_id as null until gates carry one', () => {
    const { gate_id, ...frame } = waiting.stack[1];
    const out = projectWorkflowRun({ run: { ...waiting, stack: [waiting.stack[0], frame] }, workflow, stepRows });
    assert.equal(out.waiting_gate.gate_id, null);
  });

  it('has no waiting gate while the run is executing', () => {
    const out = projectWorkflowRun({ run: { ...waiting, status: 'running', stack: [waiting.stack[0]] }, workflow, stepRows });
    assert.equal(out.waiting_gate, null);
    assert.equal(out.current_step, '3');
  });
});

describe('projectWorkflowRun — projections', () => {
  it('outline gives one line per execution, named by the step identifier, not the execution id', () => {
    const out = projectWorkflowRun({ run: waiting, workflow, stepRows, outline: true });
    assert.deepEqual(out.outline.map(l => l.step), ['1', '2', '2']);
    assert.equal(out.outline[2].error, 'boom');
    assert.equal(out.outline[0].output_chars, 40);
    assert.equal(out.executed_step_count, 3);
  });

  it('steps returns every execution of the step and the full value now at its output_key', () => {
    const out = projectWorkflowRun({ run: waiting, workflow, stepRows, selected: ['2', '9'] });
    assert.equal(out.executions.length, 2);
    assert.equal(out.executions[0].output_summary, 'out 2');
    assert.deepEqual(out.current_output['2'], { output_key: 'view.summary', value: 'Total 120' });
    assert.deepEqual(out.not_run, ['9']);
  });

  it('a completed run reads its values from state, since its stack is empty', () => {
    const run = { ...waiting, status: 'completed', stack: [], state: { local_state: live } };
    const out = projectWorkflowRun({ run, workflow, stepRows, selected: ['1'] });
    assert.deepEqual(out.current_output['1'].value, [{ id: 7 }]);
    assert.equal(out.waiting_gate, null);
  });

  it('a cancelled run kept no state, and says so rather than returning nulls silently', () => {
    const run = { ...waiting, status: 'cancelled', stack: [], state: null };
    const out = projectWorkflowRun({ run, workflow, stepRows, selected: ['1'] });
    assert.equal(out.current_output['1'].value, null);
    assert.match(out.note, /kept no state/);
  });

  it('the default is the summary and the last executed step', () => {
    const out = projectWorkflowRun({ run: waiting, workflow, stepRows });
    assert.equal(out.workflow, 'edit_thing');
    assert.equal(out.workflow_version, 4);
    assert.equal(out.last_step.status, 'failed');
    assert.equal(out.outline, undefined);
  });
});
