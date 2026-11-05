// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-run-event-bounds.test.mjs
//
// A test-run event says what happened, not every pass of it. In session 1293 `answer_gate`
// returned 191K characters over 15 calls: each event listed every iterator pass (111 lines, 51
// of them the same serv_query once per receipt item) and the gate's whole dialog (51 items).
// Consecutive steps of one type and status are one line with their count; a gate's long lists
// show their first entries and say where the rest is.
//
// Run: node --test tests/unit/minds-eye-run-event-bounds.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collapseStepLines, boundGateDialog, describeRunEvent, projectWorkflowRun } from '../../src/proc/minds-eye.mjs';

const row = (id, step, type, extra = {}) => ({ id, step_number: step, step_type: type, status: 'completed',
  duration_ms: 10, input_snapshot: {}, output_snapshot: { chars: 100, summary: 's' }, ...extra });

// Step 8 iterates a serv_query over 51 items, then a notify, then two transforms and the gate.
const rows = [
  row(1, 8, 'iterator', { output_snapshot: null }),
  ...Array.from({ length: 51 }, (_, i) => row(10 + i, i, 'serv_query')),
  row(70, 9, 'notify', { output_snapshot: { chars: 9, summary: 'Matched 51' } }),
  row(71, 10, 'js_transform'),
  row(72, 11, 'js_transform'),
  row(73, 12, 'human_gate', { output_snapshot: null }),
];

const gateStep = { step: '12', type: 'human_gate', gate_type: 'confirm', message_template: 'Apply?',
  options: [{ action: 'confirm', label: 'Apply' }] };
const items = Array.from({ length: 51 }, (_, i) => ({ name_original: `ITEM ${i}`, quantity: 1 }));
const atGate = {
  id: 967, workflow_id: 2, status: 'awaiting_human_gate', sandbox: 'sandbox_1',
  stack: [{ type: 'workflow', current_step: '12', local_state: {} },
          { type: 'human_gate', gate_id: 'g-12', gate_type: 'confirm', step_ref: gateStep, step_number: '12', local_state: {} }],
};
const sentDialog = { title: 'Review', gate_id: 'g-12',
  fields: [{ type: 'typography', value: 'Receipt parsed.' }, { type: 'reveal', button_label: 'View items (51)', content: items }] };

describe('collapseStepLines', () => {
  const lines = rows.map(r => ({ step: String(r.step_number), type: r.step_type, status: r.status,
    duration_ms: r.duration_ms, output_chars: r.output_snapshot?.chars ?? null }));

  it("folds an iterator's passes into one line with their count and totals", () => {
    const out = collapseStepLines(lines);
    const passes = out.find(l => l.type === 'serv_query');
    assert.deepEqual(passes, { steps: '0…50', type: 'serv_query', status: 'completed', count: 51, duration_ms: 510, output_chars: 5100 });
    assert.equal(out.length, 6);
  });

  it('leaves a run shorter than three as it is', () => {
    const out = collapseStepLines(lines);
    assert.deepEqual(out.filter(l => l.type === 'js_transform').map(l => l.step), ['10', '11']);
  });

  it('never folds a line with an error, a retry or a notify message into a run', () => {
    const marked = [0, 1, 2, 3, 4].map(i => ({ step: String(i), type: 'serv_query', status: 'completed' }));
    marked[2] = { ...marked[2], error: 'boom' };
    const out = collapseStepLines(marked);
    assert.deepEqual(out.map(l => l.step ?? l.steps), ['0', '1', '2', '3', '4'], 'the error line splits the run into two short ones');
    assert.equal(out[2].error, 'boom');
  });
});

describe('boundGateDialog', () => {
  it('shows the first ten of a long list and says where the rest is', () => {
    const out = boundGateDialog(sentDialog, 967);
    const content = out.fields[1].content;
    assert.equal(content.length, 11);
    assert.deepEqual(content.slice(0, 10), items.slice(0, 10));
    assert.match(content[10].withheld, /^41 more of 51\. read_workflow_run\(\{ runId: 967 \}\) shows the waiting gate in full\.$/);
  });

  it('leaves a list of twenty or fewer whole, and everything else untouched', () => {
    const small = { fields: [{ type: 'checkboxes', options: Array.from({ length: 20 }, (_, i) => ({ value: i })) }], title: 'T' };
    assert.deepEqual(boundGateDialog(small, 1), small);
  });
});

describe('describeRunEvent — a gate event after an iterator', () => {
  const out = describeRunEvent({ message: { type: 'HUMAN_GATE', dialog: sentDialog }, run: atGate, stepRows: rows });

  it('lists the iterator once, and keeps the notify message on its own line', () => {
    assert.equal(out.steps_since.length, 6);
    assert.equal(out.steps_since.find(l => l.type === 'serv_query').count, 51);
    assert.equal(out.steps_since.find(l => l.type === 'notify').notified, 'Matched 51');
  });

  it("bounds the sent dialog's long list", () => {
    assert.equal(out.waiting_gate.dialog.fields[1].content.length, 11);
    assert.equal(out.waiting_gate.gate_id, 'g-12');
  });

  it('is a fraction of the size it was', () => {
    assert.ok(JSON.stringify(out).length < 4000, `${JSON.stringify(out).length} characters`);
  });
});

describe('projectWorkflowRun — the outline collapses too, and steps still read each execution', () => {
  it('outline folds the passes; a named step returns every execution of it', () => {
    const outline = projectWorkflowRun({ run: atGate, stepRows: rows, outline: true });
    assert.equal(outline.outline.length, 6);
    assert.match(outline.note, /one line with their count/);
    const one = projectWorkflowRun({ run: atGate, stepRows: rows, selected: ['7'] });
    assert.equal(one.executions.length, 1);
    assert.equal(one.executions[0].step, '7');
  });

  it('read_workflow_run still shows the waiting gate in full', () => {
    const full = projectWorkflowRun({ run: atGate, stepRows: rows });
    assert.equal(full.waiting_gate.gate_id, 'g-12');
  });
});
