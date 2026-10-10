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

import { buildDialog, resolveFormFields }   from '../../src/proc/step-executor.mjs';
import { collectFormValues, extractFieldValue, FORM_BLOCK_PREFIX, EMPTY_OPTION_VALUE,
         numberActionId, parseNumberActionId, readNumber, invalidNumberFields,
         listIdBlockId, collectListIdValue }
  from '../../src/ui/slackbot/form-fields.mjs';
import { buildInputElement } from '../../src/ui/slackbot/callback.mjs';

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

  it('reads a transform-built { value, label } row without being told to', () => {
    // The shape a js_transform naturally emits when it builds a picker list, and the
    // same shape the inline `options` branch has always accepted. The rows branch used
    // to default to id/name alone, so every option rendered the string "undefined" —
    // live specimen: review_inventory step 3, a multi_select whose list never appeared.
    const dialog = buildDialog(
      formStep([{ name: 'selected_ids', type: 'multi_select', options_key: 'page_data' }]),
      { page_data: [{ value: '25', label: 'Red Wine [qty: 2]' }] },
    );
    assert.deepEqual(inputs(dialog)[0].options, [{ value: '25', label: 'Red Wine [qty: 2]' }]);
  });

  it('still reads an { id, name } table row, and settles each row on its own shape', () => {
    const dialog = buildDialog(
      formStep([{ name: 'pick', type: 'select', options_key: 'rows' }]),
      { rows: [{ id: 3, name: 'Groceries' }, { value: 'kg', label: 'Kilograms' }] },
    );
    assert.deepEqual(inputs(dialog)[0].options, [
      { value: '3',  label: 'Groceries' },
      { value: 'kg', label: 'Kilograms' },
    ]);
  });

  it('lets a declared key win over a row that carries the standard shape too', () => {
    const dialog = buildDialog(
      formStep([{
        name: 'pick', type: 'select', options_key: 'rows',
        option_value_key: 'id', option_label_key: 'name',
      }]),
      { rows: [{ id: 9, name: 'From the table', value: 'ignored', label: 'ignored too' }] },
    );
    assert.deepEqual(inputs(dialog)[0].options, [{ value: '9', label: 'From the table' }]);
  });

  it('falls back to the value as the label when a row carries no label at all', () => {
    const dialog = buildDialog(
      formStep([{ name: 'pick', type: 'select', options_key: 'rows' }]),
      { rows: [{ value: 'kg' }] },
    );
    assert.deepEqual(inputs(dialog)[0].options, [{ value: 'kg', label: 'kg' }]);
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

  it('resolves templates in an inline field\'s default and placeholder (run 870)', () => {
    // An inline field list has no other way to open on a value the workflow read.
    // Run 870's period picker rendered "{{default_year}}" literally in the box.
    const dialog = buildDialog(
      formStep([
        { name: 'year',  type: 'text',   default: '{{defaults.year}}', placeholder: 'e.g. {{defaults.year}}' },
        { name: 'label', type: 'text',   default: 'Budget {{defaults.year}}' },
        { name: 'tags',  type: 'multi_select', default: '{{chosen}}', options: ['a', 'b', 'c'] },
      ]),
      { defaults: { year: '2026' }, chosen: ['a', 'c'] },
    );
    const [year, label, tags] = inputs(dialog);
    assert.equal(year.initial, '2026');
    assert.equal(year.placeholder, 'e.g. 2026');
    assert.equal(label.initial, 'Budget 2026');
    assert.deepEqual(tags.initial, ['a', 'c'], 'a whole-token default keeps its array type');
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

// resolveFormFields is the single resolver shared by buildDialog (render) and run-workflow's
// form-gate resume validation. Run 730 crashed at the resume site because it filtered the RAW
// "{{edit_fields}}" string ("(stepRef.fields ?? []).filter is not a function"); one resolver,
// both call sites (rule 2e), and it always returns an array.
describe('resolveFormFields — shared by render and resume-validation', () => {
  it('returns an inline fields array unchanged', () => {
    const f = [{ name: 'a' }, { name: 'b' }];
    assert.deepEqual(resolveFormFields({ fields: f }, {}), f);
  });

  it('resolves a {{template}} reference to the array a js_transform built', () => {
    const built = [{ name: 'jan', optional: false }, { name: 'feb', optional: true }];
    assert.deepEqual(resolveFormFields({ fields: '{{edit_fields}}' }, { edit_fields: built }), built);
  });

  it('returns [] for an unresolvable reference — never a string, so .filter is safe (run 730)', () => {
    const r = resolveFormFields({ fields: '{{never_built}}' }, {});
    assert.deepEqual(r, []);
    assert.doesNotThrow(() => r.filter(x => x));
  });

  it('returns [] when the reference resolves to a non-array', () => {
    assert.deepEqual(resolveFormFields({ fields: '{{oops}}' }, { oops: 'not an array' }), []);
  });

  it('required-field check works on a templated form (regression for run 730)', () => {
    const built  = [{ name: 'jan', optional: false }, { name: 'feb', optional: false }];
    const values = { jan: 100 };   // feb left blank
    const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
    const missing = resolveFormFields({ fields: '{{edit_fields}}' }, { edit_fields: built })
      .filter(f => f.optional !== true && isEmpty(values[f.name]))
      .map(f => f.name);
    assert.deepEqual(missing, ['feb']);
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

  it('round-trips an empty-value "none" option through Slack as null (run 870)', () => {
    // Slack rejects an option whose value is '' — and with it the whole message.
    const field = {
      input_type: 'select', initial: '',
      options: [{ value: '', label: '(none)' }, { value: 'cash', label: 'Cash' }],
    };
    const { element } = buildInputElement(field);
    assert.ok(element.options.every(o => o.value !== ''), 'no empty option value reaches Slack');
    assert.equal(element.initial_option.value, EMPTY_OPTION_VALUE, "a '' default opens on the none option");
    assert.equal(extractFieldValue({ selected_option: element.initial_option }), null);
    assert.equal(extractFieldValue({ selected_option: element.options[1] }), 'cash');
    assert.deepEqual(
      extractFieldValue({ selected_options: [{ value: EMPTY_OPTION_VALUE }, { value: 'cash' }] }),
      ['cash'],
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

// A `number` field: Slack's number_input renders only in modals and a form gate is a
// message, so the field is a text box and the experience layer keeps the contract —
// what reaches /proc is a number or nothing. See form-fields.mjs.
describe('number field — declared in /proc, kept by the experience layer', () => {
  const numberBlock = name => `${FORM_BLOCK_PREFIX}42::${name}`;
  const typed = (rule, value) => ({ [numberActionId(rule)]: { type: 'plain_text_input', value } });

  it('buildDialog carries the field\'s decimal/min/max to the experience layer', () => {
    const dialog = buildDialog({
      gate_type: 'form',
      fields: [
        { name: 'year',   type: 'number', min: 1900, max: 2100, default: '{{y}}' },
        { name: 'amount', type: 'number', decimal: true },
      ],
    }, { y: '2026' });
    const [year, amount] = dialog.fields.filter(f => f.type === 'input');
    assert.equal(year.input_type, 'number');
    assert.equal(year.decimal, false, 'whole numbers unless the field says otherwise');
    assert.equal(year.min, 1900);
    assert.equal(year.max, 2100);
    assert.equal(year.initial, '2026');
    assert.equal(amount.decimal, true);
  });

  it('renders as a text box — never number_input, which a message cannot carry', () => {
    const built = buildInputElement({ input_type: 'number', name: 'year', decimal: false, min: 1900, initial: '2026' });
    assert.equal(built.element.type, 'plain_text_input');
    assert.deepEqual(parseNumberActionId(built.element.action_id), { decimal: false, min: 1900 },
      'the field\'s rule travels in the action_id');
    assert.equal(built.element.initial_value, '2026');
    assert.equal(built.element.placeholder.text, 'e.g. 1900');
  });

  it('a workflow\'s own placeholder wins over the default hint', () => {
    const built = buildInputElement({ input_type: 'number', name: 'amount', decimal: true, placeholder: 'in euros' });
    assert.equal(built.element.placeholder.text, 'in euros');
  });

  it('the rule round-trips, empty bounds meaning none', () => {
    assert.deepEqual(parseNumberActionId(numberActionId({ decimal: true })), { decimal: true });
    assert.deepEqual(parseNumberActionId(numberActionId({ min: -5, max: 0.5 })), { decimal: false, min: -5, max: 0.5 });
    assert.equal(parseNumberActionId('form_value'), null, 'any other field is not a number field');
  });

  it('reads a decimal comma as the decimal point — 12,50 is 12.5', () => {
    assert.deepEqual(readNumber('12,50', { decimal: true }), { value: 12.5 });
    assert.deepEqual(readNumber('12.50', { decimal: true }), { value: 12.5 });
    assert.deepEqual(readNumber(' -3 ', { decimal: false }), { value: -3 });
  });

  it('refuses rather than guesses', () => {
    assert.deepEqual(readNumber('1,234.50', { decimal: true }), { problem: 'must be a number' }, 'two separators are ambiguous');
    assert.deepEqual(readNumber('twenty', { decimal: false }), { problem: 'must be a number' });
    assert.deepEqual(readNumber('12,5', { decimal: false }), { problem: 'must be a whole number' });
    assert.deepEqual(readNumber('1850', { decimal: false, min: 1900 }), { problem: 'must be at least 1900' });
    assert.deepEqual(readNumber('2200', { decimal: false, max: 2100 }), { problem: 'must be at most 2100' });
  });

  it('collectFormValues hands a valid number on as a number, and leaves other fields as they were', () => {
    const values = collectFormValues({
      [numberBlock('amount')]: typed({ decimal: true }, '12,50'),
      [numberBlock('note')]:   { form_value: { value: '12,50' } },
      [numberBlock('qty')]:    typed({ decimal: false }, ''),
    });
    assert.deepEqual(values, { amount: 12.5, note: '12,50', qty: null });
  });

  it('invalidNumberFields names each number field that does not read, and nothing else', () => {
    const invalid = invalidNumberFields({
      [numberBlock('year')]:   typed({ decimal: false }, 'twenty'),
      [numberBlock('amount')]: typed({ decimal: true }, '12,50'),
      [numberBlock('qty')]:    typed({ decimal: false }, ''),
      [numberBlock('note')]:   { form_value: { value: 'twenty' } },
    });
    assert.deepEqual(invalid, [{ blockId: numberBlock('year'), name: 'year', problem: 'must be a number' }],
      'an empty field is the required-field check\'s call, and text fields are not numbers');
  });
});

describe('list_selection ID box — one per table group', () => {
  it('reads the box of the clicked button\'s group, and no other', () => {
    const state = {
      [listIdBlockId(42, 'PGD_Ingredients')]: { list_select_value: { value: ' 7 ' } },
      [listIdBlockId(42, 'PGD_RecipeSteps')]: { list_select_value: { value: '9' } },
    };
    assert.equal(collectListIdValue(state, 'PGD_Ingredients'), '7');
    assert.equal(collectListIdValue(state, 'PGD_RecipeSteps'), '9');
    assert.equal(collectListIdValue(state, 'PGD_Other'), null);
  });

  it('rows with no table use the empty group', () => {
    const state = { [listIdBlockId(42, undefined)]: { list_select_value: { value: '3' } } };
    assert.equal(collectListIdValue(state, ''), '3');
  });

  it('an empty box reads as nothing typed', () => {
    assert.equal(collectListIdValue({ [listIdBlockId(42, '')]: { list_select_value: { value: '  ' } } }, ''), null);
  });

  it('list ID boxes are not form fields', () => {
    assert.equal(collectFormValues({ [listIdBlockId(42, '')]: { list_select_value: { value: '3' } } }), null);
  });
});
