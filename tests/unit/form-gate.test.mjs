// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/form-gate.test.mjs
//
// Unit tests for the `form` gate type — the multi-field data-collection gate that
// removes the need for a new gate_type per widget (select_one, select_many,
// date_input, ...). Covers the full round trip:
//
//   buildDialog (proc)  ->  UI-agnostic { type: 'input' } field descriptors
//   form-fields.mjs     ->  Slack state.values parsed back into a field map
//
// buildDialog and the form-fields helpers are imported directly (no copies).
//
// Run: node --test tests/unit/form-gate.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { buildDialog }                      from '../../src/proc/step-executor.mjs';
import { collectFormValues, extractFieldValue, FORM_BLOCK_PREFIX }
  from '../../src/ui/slackbot/form-fields.mjs';

const formStep = (fields, extra = {}) => ({
  step: '1', type: 'human_gate', gate_type: 'form',
  message_template: 'Which month do you want to edit?',
  fields,
  output_key: 'budget_edit',
  options: [
    { label: 'Submit', action: 'confirm', on_select: 'step:2' },
    { label: 'Cancel', action: 'cancel',  on_select: 'cancel'  },
  ],
  ...extra,
});

const inputs = dialog => dialog.fields.filter(f => f.type === 'input');

describe('buildDialog — form gate', () => {
  it('emits one UI-agnostic input field per declared field, in order', () => {
    const dialog = buildDialog(formStep([
      { name: 'period', type: 'date',     label: 'Budget month' },
      { name: 'notes',  type: 'textarea', label: 'Notes', optional: true },
    ]), {});

    const fields = inputs(dialog);
    assert.equal(fields.length, 2);
    assert.deepEqual(fields.map(f => f.name), ['period', 'notes']);
    // The dialog names WHAT to collect, never a Slack widget — the experience layer
    // decides that 'date' means a datepicker.
    assert.equal(fields[0].input_type, 'date');
    assert.equal(fields[0].label, 'Budget month');
    assert.equal(fields[0].optional, false, 'required unless explicitly optional');
    assert.equal(fields[1].optional, true);
  });

  it('still renders the message and the option buttons, like every other gate', () => {
    const dialog = buildDialog(formStep([{ name: 'period', type: 'date' }]), {});
    assert.equal(dialog.fields.find(f => f.type === 'typography').value,
      'Which month do you want to edit?');
    const actions = dialog.fields.find(f => f.type === 'actions');
    assert.deepEqual(actions.buttons.map(b => b.action), ['confirm', 'cancel']);
  });

  it('builds dropdown options from local_state so choices can be queried data', () => {
    // The point of options_key: the categories the workflow just loaded become the
    // dropdown's options, so the user picks deterministically instead of typing free
    // text that an llm_call then has to parse.
    const dialog = buildDialog(
      formStep([{ name: 'category_id', type: 'select', label: 'Category', options_key: 'categories' }]),
      { categories: [{ id: 3, name: 'Groceries' }, { id: 7, name: 'Utilities' }] },
    );
    assert.deepEqual(inputs(dialog)[0].options, [
      { value: '3', label: 'Groceries' },
      { value: '7', label: 'Utilities' },
    ]);
  });

  it('honours option_value_key / option_label_key when the rows are shaped differently', () => {
    const dialog = buildDialog(
      formStep([{
        name: 'unit', type: 'select', options_key: 'units',
        option_value_key: 'code', option_label_key: 'title',
      }]),
      { units: [{ code: 'kg', title: 'Kilograms' }] },
    );
    assert.deepEqual(inputs(dialog)[0].options, [{ value: 'kg', label: 'Kilograms' }]);
  });

  it('accepts inline options, as objects or bare strings', () => {
    const dialog = buildDialog(formStep([
      { name: 'a', type: 'radio',  options: [{ value: 1, label: 'One' }] },
      { name: 'b', type: 'select', options: ['yes', 'no'] },
    ]), {});
    const [a, b] = inputs(dialog);
    assert.deepEqual(a.options, [{ value: '1', label: 'One' }]);
    assert.deepEqual(b.options, [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }]);
  });

  it('resolves templates in a field label', () => {
    const dialog = buildDialog(
      formStep([{ name: 'period', type: 'date', label: 'Month for {{domain}}' }]),
      { domain: 'budgets' },
    );
    assert.equal(inputs(dialog)[0].label, 'Month for budgets');
  });

  it('carries `default` through as the dialog\'s initial value', () => {
    // `default` is the standard name for a pre-filled value (JSON Schema, HTML forms)
    // and what an LLM emits unprompted — run 695 was rejected for using it. The dialog
    // calls it `initial` only because that is Slack's name for it.
    const dialog = buildDialog(
      formStep([{ name: 'amount', type: 'text', default: '250.00' }]),
      {},
    );
    assert.equal(inputs(dialog)[0].initial, '250.00');
  });

  it('accepts `fields` as a {{template}} reference to a js_transform-built array', () => {
    // A form with one field per data row: the field list cannot be known at design time,
    // so a preceding js_transform builds it. Same shape `options`/`reveals` already accept.
    const dialog = buildDialog(
      formStep('{{budget_edit_fields}}'),
      {
        budget_edit_fields: [
          { name: 'cat_3_amount', type: 'text',   label: 'Groceries — Amount', default: '400' },
          { name: 'cat_7_amount', type: 'text',   label: 'Utilities — Amount', default: '120' },
          { name: 'cat_3_type',   type: 'select', label: 'Groceries — Type',
            options: ['income', 'savings'], default: 'savings' },
        ],
      },
    );
    const fields = inputs(dialog);
    assert.equal(fields.length, 3, 'one input per row built by the transform');
    assert.deepEqual(fields.map(f => f.name), ['cat_3_amount', 'cat_7_amount', 'cat_3_type']);
    assert.equal(fields[0].initial, '400');
    assert.equal(fields[2].options[1].value, 'savings');
  });

  it('an unresolvable fields reference yields no inputs rather than throwing', () => {
    const dialog = buildDialog(formStep('{{never_built}}'), {});
    assert.equal(inputs(dialog).length, 0);
  });
});

describe('form-fields — reading Slack answers back', () => {
  const block = name => `${FORM_BLOCK_PREFIX}42::${name}`;

  it('extracts each element type to the value the workflow wants', () => {
    assert.equal(extractFieldValue({ value: '  hello  ' }), 'hello');
    assert.equal(extractFieldValue({ selected_option: { value: '3' } }), '3');
    assert.equal(extractFieldValue({ selected_date: '2026-07-01' }), '2026-07-01');
    assert.equal(extractFieldValue({ selected_time: '09:30' }), '09:30');
    assert.deepEqual(
      extractFieldValue({ selected_options: [{ value: 'a' }, { value: 'b' }] }),
      ['a', 'b'],
      'multi_select and checkbox answer with an array',
    );
  });

  it('treats an untouched input as null, not an empty string', () => {
    assert.equal(extractFieldValue({ value: '   ' }), null);
    assert.equal(extractFieldValue({}), null);
    assert.equal(extractFieldValue(null), null);
  });

  it('rebuilds every field of a multi-field form, keyed by name', () => {
    const values = collectFormValues({
      [block('period')]:      { form_value: { selected_date: '2026-07-01' } },
      [block('category_id')]: { form_value: { selected_option: { value: '3' } } },
      [block('notes')]:       { form_value: { value: 'rent went up' } },
    });
    assert.deepEqual(values, { period: '2026-07-01', category_id: '3', notes: 'rent went up' });
  });

  it('recovers field names containing underscores', () => {
    // Why block_id uses '::' and not '_' as the separator.
    const values = collectFormValues({
      [block('spending_category_id')]: { form_value: { selected_option: { value: '9' } } },
    });
    assert.deepEqual(values, { spending_category_id: '9' });
  });

  it('reports an unanswered optional field as null rather than dropping it', () => {
    const values = collectFormValues({ [block('notes')]: { form_value: { value: '' } } });
    assert.deepEqual(values, { notes: null }, 'the workflow sees every field it asked for');
  });

  it('ignores non-form blocks, so other gates are unaffected', () => {
    assert.equal(collectFormValues({
      list_select_input_42:  { list_select_value: { value: '7' } },
      text_input_block_42_x: { text_input_value:  { value: 'hi' } },
    }), null, 'no form fields present — nothing collected');
  });
});
