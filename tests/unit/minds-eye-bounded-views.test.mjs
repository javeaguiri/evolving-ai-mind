// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-bounded-views.test.mjs
//
// Two views Novia works through, both of which used to bound themselves silently.
//
// read_workflow returned all 28 steps of process_receipt as one 19,125-character result, past
// the transcript cap, so the last two steps never arrived and step 13's message_template was
// rewritten from memory. Fetching less is the fix; a bigger cap is not.
//
// The propose_workflow_fix gate diffed against a fixed six-field allow-list, omitting
// message_template, output_key, input, items_key, item_step, fields and options. On the v5->v6
// gate it printed a heading for step 13 and listed nothing beneath it, and four unagreed
// changes were approved without ever being rendered.
//
// Run: node --test tests/unit/minds-eye-bounded-views.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { projectWorkflowSteps, diffStepFields, renderGateValue } from '../../src/proc/minds-eye.mjs';

const steps = [
  { step: '1',  type: 'serv_query',  output_key: 'receipt',  on_success: '2' },
  { step: '12', type: 'js_transform', output_key: 'plan',    on_success: '12c' },
  { step: '12c', type: 'serv_upsert', output_key: 'updated_rows', on_success: '13' },
  { step: '13', type: 'notify', message_template: 'Aliases written: {{n}}', on_success: 'end' },
];

describe('projectWorkflowSteps', () => {

  it('returns every step when nothing is selected', () => {
    const out = projectWorkflowSteps(steps);
    assert.equal(out.steps.length, 4);
    assert.equal(out.step_count, 4);
  });

  it('returns only the steps asked for, and says how many it withheld', () => {
    const out = projectWorkflowSteps(steps, { selected: ['12c', '13'] });
    assert.deepEqual(out.returned, ['12c', '13']);
    assert.equal(out.omitted, 2);
    assert.equal(out.step_count, 4, 'the full count is always stated');
  });

  it('names a step identifier it could not find, rather than returning a short list', () => {
    const out = projectWorkflowSteps(steps, { selected: ['13', '99'] });
    assert.deepEqual(out.not_found, ['99']);
    assert.equal(out.steps.length, 1);
  });

  it('matches a numeric identifier against the stored string form', () => {
    const out = projectWorkflowSteps(steps, { selected: [13] });
    assert.equal(out.steps.length, 1);
    assert.equal(out.steps[0].step, '13');
  });

  it('outlines shape before content, and is far smaller than the steps', () => {
    const out = projectWorkflowSteps(steps, { outline: true });
    assert.equal(out.outline.length, 4);
    assert.deepEqual(out.outline[3], {
      step: '13', type: 'notify', output_key: null, on_success: 'end', on_else: null,
      description: null, chars: JSON.stringify(steps[3]).length,
    });
  });

  // The point of an outline is a workflow whose steps carry real bodies: process_receipt is
  // 19,125 characters over 28 steps. On four skeleton steps an outline is bigger than the
  // steps, which is not the case it exists for.
  it('is much smaller than the steps once they carry real bodies', () => {
    const heavy = Array.from({ length: 28 }, (_, i) => ({
      step: String(i + 1),
      type: 'js_transform',
      output_key: `out_${i}`,
      on_success: String(i + 2),
      expression: `const rows = {{alias_candidate_sets}}; ${'/* body */'.repeat(60)}`,
    }));
    const outlined = JSON.stringify(projectWorkflowSteps(heavy, { outline: true })).length;
    const whole    = JSON.stringify(projectWorkflowSteps(heavy)).length;
    assert.ok(outlined * 4 < whole, `outline ${outlined} vs steps ${whole}`);
  });

  it('survives a workflow with no steps at all', () => {
    assert.deepEqual(projectWorkflowSteps(undefined), { step_count: 0, steps: [] });
  });
});

describe('diffStepFields', () => {

  // Every one of these was invisible on the v5->v6 gate.
  it('reports message_template, which the allow-list omitted', () => {
    const d = diffStepFields(
      { step: '13', message_template: 'Aliases written: {{a}}' },
      { step: '13', message_template: 'Done' }
    );
    assert.deepEqual(d.message_template, { from: 'Aliases written: {{a}}', to: 'Done' });
  });

  it('reports an output_key rename', () => {
    const d = diffStepFields(
      { step: '12c', output_key: 'quantity_update_results' },
      { step: '12c', output_key: 'updated_rows' }
    );
    assert.deepEqual(d.output_key, { from: 'quantity_update_results', to: 'updated_rows' });
  });

  it('reports an input change, row -> rows plus matchColumns', () => {
    const d = diffStepFields(
      { step: '12k', input: { row: {} } },
      { step: '12k', input: { rows: [], matchColumns: ['inventory_id'] } }
    );
    assert.ok(d.input, 'the field carrying the change must be reported');
  });

  it('reports a field the proposal drops entirely', () => {
    const d = diffStepFields({ step: '12h', on_success: '12i' }, { step: '12h' });
    assert.deepEqual(d.on_success, { from: '12i', to: undefined });
  });

  it('reports a field the proposal adds', () => {
    const d = diffStepFields({ step: '4' }, { step: '4', execution_mode: 'inline' });
    assert.deepEqual(d.execution_mode, { from: undefined, to: 'inline' });
  });

  it('says nothing about fields that did not change', () => {
    const step = { step: '13', type: 'notify', message_template: 'same' };
    assert.deepEqual(diffStepFields(step, { ...step }), {});
  });

  it('compares by value, not by reference', () => {
    const d = diffStepFields({ input: { a: [1, 2] } }, { input: { a: [1, 2] } });
    assert.deepEqual(d, {});
  });
});

describe('renderGateValue', () => {

  it('renders a small value whole', () => {
    assert.equal(renderGateValue('Done'), '"Done"');
  });

  it('distinguishes an absent field from a null one', () => {
    assert.equal(renderGateValue(undefined), '_(absent)_');
    assert.equal(renderGateValue(null), 'null');
  });

  // A gate Slack rejects leaves the run suspended at a gate nobody saw.
  it('bounds a large value and states its full size', () => {
    const out = renderGateValue({ expression: 'x'.repeat(5000) });
    assert.ok(out.length < 400, 'bounded for display');
    assert.match(out, /\[\d+ chars total\]/, 'and says what it withheld');
  });
});
