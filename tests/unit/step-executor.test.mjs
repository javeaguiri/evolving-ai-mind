// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/step-executor.test.mjs
//
// Unit tests for step-executor.mjs pure functions:
//   buildDialog()              — dialog construction from step definition
//   runSandboxedExpression()   — js_transform expression sandbox
//
// Tests are deliberately import-free from AWS/DB dependencies.
// Both functions are pure and side-effect-free.
//
// Run: node --test tests/unit/step-executor.test.mjs

import { describe, it }        from 'node:test';
import assert                  from 'node:assert/strict';
import { readFileSync }        from 'node:fs';
import { buildDialog, runSandboxedExpression, runSimulation } from '../../src/proc/step-executor.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const seed = JSON.parse(readFileSync(
  new URL('../../src/serv/templates/pgc/seeds/seed_PGC_Workflow.json', import.meta.url)
));

function getStep(workflowName, stepKey) {
  const wf = seed.find(w => w.name === workflowName);
  if (!wf) throw new Error(`workflow ${workflowName} not found in seed`);
  const step = wf.steps.find(s => s.step === stepKey);
  if (!step) throw new Error(`step ${stepKey} not found in workflow ${workflowName}`);
  return step;
}

const TABLES = [
  {
    tableName: 'PGD_Flashcards',
    foreignKeys: [],
    columns: [
      { name: 'id', type: 'serial' },
      { name: 'front_text', type: 'text' },
      { name: 'back_text', type: 'text' },
      { name: 'card_type', type: 'text' },
      { name: 'created_at', type: 'timestamptz' },
      { name: 'updated_at', type: 'timestamptz' },
    ],
  },
  {
    tableName: 'PGD_ReviewLogs',
    foreignKeys: [{ column: 'flashcard_id', references: 'PGD_Flashcards.id' }],
    columns: [
      { name: 'id', type: 'serial' },
      { name: 'flashcard_id', type: 'integer' },
      { name: 'result', type: 'text' },
      { name: 'created_at', type: 'timestamptz' },
    ],
  },
];

const NEW_TABLE = {
  tableName: 'PGD_FlashCardSets',
  foreignKeys: [],
  columns: [
    { name: 'id', type: 'serial' },
    { name: 'name', type: 'text' },
    { name: 'language', type: 'text' },
    { name: 'created_at', type: 'timestamptz' },
  ],
};

const SCAFFOLD = {
  domain: 'spanish_flashcards',
  tables: TABLES,
};

// ---------------------------------------------------------------------------
// buildDialog — modal descriptor passthrough (the regression)
// ---------------------------------------------------------------------------

describe('buildDialog — modal descriptor passthrough', () => {
  it('passes modal field through to button value when option carries modal descriptor', () => {
    const step = {
      step:        '3',
      type:        'human_gate',
      gate_type:   'edit_list',
      description: 'Review tables',
      context_key: 'proposed_scaffold.tables',
      options: [
        { action: 'confirm',   label: 'Looks good', on_select: 'step:3d' },
        {
          action:    'add_table',
          label:     'Add a table',
          on_select: 'step:3a',
          modal: {
            title:       'Add a table',
            input_label: 'Describe the table',
            placeholder: 'What it stores and how it relates to the other tables.',
            multiline:   true,
          },
        },
        { action: 'cancel', label: 'Cancel', on_select: 'cancel' },
      ],
    };
    const localState = { proposed_scaffold: { domain: 'test_domain', tables: [] } };

    const dialog = buildDialog(step, localState);
    const actionsField = dialog.fields.find(f => f.type === 'actions');
    assert.ok(actionsField, 'actions field must be present');

    const addTableBtn = actionsField.buttons.find(b => b.action === 'add_table');
    assert.ok(addTableBtn, 'add_table button must be present');
    assert.deepEqual(addTableBtn.modal, step.options[1].modal,
      'modal descriptor must be forwarded verbatim to the button');
  });

  it('does not add modal field to buttons that have no modal descriptor', () => {
    const step = {
      step:        '3',
      type:        'human_gate',
      gate_type:   'edit_list',
      context_key: 'proposed_scaffold.tables',
      options: [
        { action: 'confirm', label: 'Looks good', on_select: 'next' },
        { action: 'cancel',  label: 'Cancel',     on_select: 'cancel' },
      ],
    };
    const localState = { proposed_scaffold: { domain: 'test_domain', tables: [] } };

    const dialog = buildDialog(step, localState);
    const actionsField = dialog.fields.find(f => f.type === 'actions');
    for (const btn of actionsField.buttons) {
      assert.ok(!('modal' in btn), `button ${btn.action} must not have modal field`);
    }
  });

  it('create_domain step 3 seed carries modal descriptor on add_table option', () => {
    // Guard: catches any future seed edit that accidentally drops the modal field
    const step = getStep('create_domain', '3');
    const addTableOpt = step.options.find(o => o.action === 'add_table');
    assert.ok(addTableOpt, 'add_table option must exist on step 3');
    assert.ok(addTableOpt.modal,                    'modal field must be present');
    assert.ok(addTableOpt.modal.title,               'modal.title must be present');
    assert.ok(addTableOpt.modal.input_label,         'modal.input_label must be present');
    assert.ok(typeof addTableOpt.modal.multiline === 'boolean', 'modal.multiline must be boolean');

    const localState = { proposed_scaffold: { domain: 'spanish_flashcards', tables: [] } };
    const dialog = buildDialog(step, localState);
    const actionsField = dialog.fields.find(f => f.type === 'actions');
    const btn = actionsField.buttons.find(b => b.action === 'add_table');
    assert.ok(btn.modal, 'modal must survive buildDialog()');
    assert.equal(btn.modal.title, addTableOpt.modal.title);
  });
});

// ---------------------------------------------------------------------------
// runSandboxedExpression — local_state access
// ---------------------------------------------------------------------------

describe('runSandboxedExpression — local_state binding', () => {
  it('exposes local_state in sandbox so expressions can read cross-key values', () => {
    const result = runSandboxedExpression(
      'local_state.foo + items',
      10,
      { foo: 32 },
      'test'
    );
    assert.equal(result, 42);
  });

  it('items resolves to the input_key value', () => {
    const result = runSandboxedExpression('items.length', [1, 2, 3], {}, 'test');
    assert.equal(result, 3);
  });

  it('throws on syntax error', () => {
    assert.throws(
      () => runSandboxedExpression('items ???', [], {}, 'test'),
      /syntax error/
    );
  });

  it('throws on timeout for infinite loop', () => {
    assert.throws(
      () => runSandboxedExpression('(function(){ while(true){} })()', [], {}, 'test'),
      /timed out/
    );
  });
});

// ---------------------------------------------------------------------------
// create_domain expressions
// ---------------------------------------------------------------------------

describe('create_domain step 2 — columnSummary expression', () => {
  it('enriches tables with columnSummary and domain, excluding system columns', () => {
    const step = getStep('create_domain', '2');
    const result = runSandboxedExpression(
      step.expression,
      TABLES,
      { proposed_scaffold: SCAFFOLD },
      'test'
    );
    assert.equal(result.length, 2);
    assert.equal(result[0].domain, 'spanish_flashcards');
    assert.ok(result[0].columnSummary.includes('front_text'));
    assert.ok(!result[0].columnSummary.includes('id'));
    assert.ok(!result[0].columnSummary.includes('created_at'));
    assert.ok(!result[0].columnSummary.includes('updated_at'));
  });
});

describe('create_domain step 3c — merge + columnSummary expression', () => {
  it('merges new_table (child FK) from local_state and re-enriches all tables', () => {
    const step = getStep('create_domain', '3c');
    const result = runSandboxedExpression(
      step.expression,
      TABLES,
      { proposed_scaffold: SCAFFOLD, new_table: NEW_TABLE },
      'test'
    );
    assert.equal(result.length, 3, 'new table must be appended');
    const added = result.find(t => t.tableName === 'PGD_FlashCardSets');
    assert.ok(added, 'PGD_FlashCardSets must be present in merged result');
    assert.equal(added.domain, 'spanish_flashcards');
    assert.ok(added.columnSummary.includes('name'));
    assert.ok(added.columnSummary.includes('language'));
    assert.ok(!added.columnSummary.includes('id'));
    assert.ok(!('existing_table_modifications' in added),
      'existing_table_modifications must be stripped from stored table');
  });

  it('applies existing_table_modifications when new table is a parent/grouping concept', () => {
    const step = getStep('create_domain', '3c');
    const newParentTable = {
      tableName: 'PGD_FlashCardSets',
      foreignKeys: [],
      columns: [
        { name: 'id', type: 'serial' },
        { name: 'name', type: 'text' },
        { name: 'language', type: 'text' },
        { name: 'created_at', type: 'timestamptz' },
        { name: 'updated_at', type: 'timestamptz' },
      ],
      existing_table_modifications: [
        {
          tableName: 'PGD_Flashcards',
          add_columns: [{ name: 'flashcard_set_id', type: 'integer', nullable: true }],
          add_foreign_keys: [{
            name: 'fk_flashcards_flashcardsets',
            column: 'flashcard_set_id',
            references: { table: 'PGD_FlashCardSets', column: 'id' },
            onDelete: 'SET NULL',
          }],
        },
      ],
    };
    const result = runSandboxedExpression(
      step.expression,
      TABLES,
      { proposed_scaffold: SCAFFOLD, new_table: newParentTable },
      'test'
    );
    assert.equal(result.length, 3, 'new table must be appended');
    const flashcards = result.find(t => t.tableName === 'PGD_Flashcards');
    assert.equal(flashcards.foreignKeys.length, 1, 'FK must be added to PGD_Flashcards');
    assert.equal(flashcards.foreignKeys[0].column, 'flashcard_set_id');
    assert.equal(flashcards.foreignKeys[0].references.table, 'PGD_FlashCardSets');
    assert.ok(flashcards.columnSummary.includes('flashcard_set_id'),
      'columnSummary must include the new FK column');
    const sets = result.find(t => t.tableName === 'PGD_FlashCardSets');
    assert.ok(!('existing_table_modifications' in sets),
      'existing_table_modifications must be stripped from stored table');
    // FK target must precede referencing table so CREATE TABLE succeeds
    const names = result.map(t => t.tableName);
    assert.ok(names.indexOf('PGD_FlashCardSets') < names.indexOf('PGD_Flashcards'),
      'PGD_FlashCardSets must be ordered before PGD_Flashcards (FK dependency)');
  });

  it('re-enriches without merge when new_table is null', () => {
    const step = getStep('create_domain', '3c');
    const result = runSandboxedExpression(
      step.expression,
      TABLES,
      { proposed_scaffold: SCAFFOLD, new_table: null },
      'test'
    );
    assert.equal(result.length, 2, 'table count must be unchanged');
    assert.ok(result[0].columnSummary);
    assert.equal(result[0].domain, 'spanish_flashcards');
  });

  it('re-enriches without merge when new_table is absent from local_state', () => {
    const step = getStep('create_domain', '3c');
    const result = runSandboxedExpression(
      step.expression,
      TABLES,
      { proposed_scaffold: SCAFFOLD },
      'test'
    );
    assert.equal(result.length, 2);
  });
});

// ---------------------------------------------------------------------------
// help expressions
// ---------------------------------------------------------------------------

describe('help step 2 — buildHelpOptions expression', () => {
  const DOMAINS = [
    { domain: 'recipes',             description: 'Manage recipes' },
    { domain: 'spanish_flashcards',  description: 'Flash card practice' },
  ];

  it('produces domainButtons array with action and label per domain', () => {
    const step = getStep('help', '2');
    const result = runSandboxedExpression(step.expression, DOMAINS, {}, 'test');
    assert.equal(result.domainButtons.length, 2);
    assert.equal(result.domainButtons[0].action, 'recipes');
    assert.ok(result.domainButtons[0].label.includes('recipes'));
  });

  it('produces domainMap keyed by domain name', () => {
    const step = getStep('help', '2');
    const result = runSandboxedExpression(step.expression, DOMAINS, {}, 'test');
    assert.ok(result.domainMap.recipes);
    assert.ok(result.domainMap.spanish_flashcards);
  });

  it('truncates labels longer than 75 characters', () => {
    const step = getStep('help', '2');
    const longDesc = 'A'.repeat(80);
    const result = runSandboxedExpression(
      step.expression,
      [{ domain: 'x', description: longDesc }],
      {},
      'test'
    );
    assert.ok(result.domainButtons[0].label.length <= 75);
  });
});

describe('help step 4 — resolveHelpContent expression', () => {
  const HELP_OPTIONS = {
    domainButtons: [],
    domainMap: {
      recipes: {
        domain:      'recipes',
        description: 'Manage your recipe collection',
        commands: [
          { syntax: '/m list recipes',   description: 'List all recipes' },
          { syntax: '/m add recipe ...',  description: 'Add a new recipe' },
        ],
      },
    },
  };

  it('resolves content for a known selection', () => {
    const step = getStep('help', '4');
    const result = runSandboxedExpression(
      step.expression,
      HELP_OPTIONS,
      { help_selection: 'recipes', help_options: HELP_OPTIONS },
      'test'
    );
    assert.equal(result.selection, 'recipes');
    assert.ok(result.content.includes('Manage your recipe collection'));
    assert.ok(result.content.includes('/m list recipes'));
  });

  it('returns fallback message for unknown selection', () => {
    const step = getStep('help', '4');
    const result = runSandboxedExpression(
      step.expression,
      HELP_OPTIONS,
      { help_selection: 'unknown_domain', help_options: HELP_OPTIONS },
      'test'
    );
    assert.ok(result.content.includes('No help found'));
  });

  it('returns fallback message when selection is null', () => {
    const step = getStep('help', '4');
    const result = runSandboxedExpression(
      step.expression,
      HELP_OPTIONS,
      { help_selection: null, help_options: HELP_OPTIONS },
      'test'
    );
    assert.ok(result.content.includes('No topic selected'));
  });
});

// ---------------------------------------------------------------------------
// get_entity / list_entity expressions
// ---------------------------------------------------------------------------

describe('get_entity step 4 — formatRecordList expression (with children)', () => {
  const RESULTS = [
    {
      id:           1,
      front_text:   'hola',
      back_text:    'hello',
      created_at:   '2026-01-01',
      updated_at:   '2026-01-01',
      review_logs:  [{ id: 10, result: 'pass', created_at: '2026-01-01' }],
    },
  ];

  it('formats root columns and includes child arrays', () => {
    const step = getStep('get_entity', '4');
    const result = runSandboxedExpression(step.expression, RESULTS, {}, 'test');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('front_text=hola'));
    assert.ok(result.includes('review_logs'));
    assert.ok(!result.includes('created_at='));  // system cols suppressed
  });

  it('returns "No records found." for empty array', () => {
    const step = getStep('get_entity', '4');
    const result = runSandboxedExpression(step.expression, [], {}, 'test');
    assert.equal(result, 'No records found.');
  });
});

describe('list_entity step 2 — formatRecordList expression (root only)', () => {
  const RESULTS = [
    { id: 1, front_text: 'hola', back_text: 'hello', created_at: '2026', updated_at: '2026',
      review_logs: [{ result: 'pass' }] },
    { id: 2, front_text: 'adiós', back_text: 'goodbye', created_at: '2026', updated_at: '2026',
      review_logs: [] },
  ];

  it('formats root columns and suppresses child arrays', () => {
    const step = getStep('list_entity', '2');
    const result = runSandboxedExpression(step.expression, RESULTS, {}, 'test');
    assert.ok(result.includes('front_text=hola'));
    assert.ok(!result.includes('review_logs'), 'child arrays must be suppressed');
  });

  it('includes record count in output', () => {
    const step = getStep('list_entity', '2');
    const result = runSandboxedExpression(step.expression, RESULTS, {}, 'test');
    assert.ok(result.includes('Found 2 record(s)'));
  });
});

// ---------------------------------------------------------------------------
// add_entity step 5 — buildChildInserts expression
// ---------------------------------------------------------------------------

describe('add_entity step 5 — buildChildInserts expression', () => {
  const ENTITY_SCHEMA = {
    children: [
      { table: 'PGD_ReviewLogs', fk_column: 'flashcard_id', output_key: 'review_logs' },
    ],
  };
  const PARSED_ENTITY = {
    root:     { front_text: 'hola', back_text: 'hello' },
    children: { review_logs: [{ result: 'pass', notes: 'good' }] },
  };
  const NEW_RECORD = { id: 42 };

  it('builds flat child insert array with FK injected', () => {
    const step = getStep('add_entity', '5');
    const result = runSandboxedExpression(
      step.expression,
      ENTITY_SCHEMA,
      { parsed_entity: PARSED_ENTITY, new_record: NEW_RECORD },
      'test'
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].tableName, 'PGD_ReviewLogs');
    assert.equal(result[0].row.flashcard_id, 42, 'FK must be injected as root record id');
    assert.equal(result[0].row.result, 'pass');
  });

  it('returns empty array when child rows array is empty', () => {
    const step = getStep('add_entity', '5');
    const result = runSandboxedExpression(
      step.expression,
      ENTITY_SCHEMA,
      {
        parsed_entity: { root: {}, children: { review_logs: [] } },
        new_record: { id: 1 },
      },
      'test'
    );
    assert.equal(result.length, 0, 'empty child rows must produce empty inserts array');
  });

  it('returns empty array when required local_state keys are missing', () => {
    const step = getStep('add_entity', '5');
    const result = runSandboxedExpression(step.expression, ENTITY_SCHEMA, {}, 'test');
    assert.equal(result.length, 0, 'missing local_state keys must produce empty inserts array');
  });

  it('handles multiple child tables', () => {
    const step = getStep('add_entity', '5');
    const schema = {
      children: [
        { table: 'PGD_Ingredients', fk_column: 'recipe_id', output_key: 'ingredients' },
        { table: 'PGD_Steps',       fk_column: 'recipe_id', output_key: 'steps' },
      ],
    };
    const parsed = {
      root:     { name: 'Pasta' },
      children: {
        ingredients: [{ name: 'pasta', quantity: 200 }, { name: 'egg', quantity: 2 }],
        steps:       [{ order: 1, instruction: 'Boil water' }],
      },
    };
    const result = runSandboxedExpression(
      step.expression,
      schema,
      { parsed_entity: parsed, new_record: { id: 7 } },
      'test'
    );
    assert.equal(result.length, 3);
    assert.ok(result.every(r => r.row.recipe_id === 7));
    assert.equal(result.filter(r => r.tableName === 'PGD_Ingredients').length, 2);
    assert.equal(result.filter(r => r.tableName === 'PGD_Steps').length, 1);
  });
});

// ---------------------------------------------------------------------------
// runSimulation — choice gate output_key propagation
// ---------------------------------------------------------------------------

describe('runSimulation — choice gate writes output_key to local_state', () => {
  // Minimal 3-step workflow: serv_query → human_gate(choice) → serv_insert
  // The insert uses {{selected_id}} which comes from the choice gate.
  const steps = [
    {
      step: '1', type: 'serv_query',
      input: { tableName: 'PGD_Sets' },
      on_failure: 'cancel', on_success: 'next',
      output_key: 'active_sets',
    },
    {
      step: '2', type: 'human_gate', gate_type: 'choice',
      output_key: 'selected_id',
      on_success: 'next', on_cancel: 'cancel', on_failure: 'cancel',
      options: [
        { label: 'A', value: '{{active_sets.0.id}}', action: 'next', description: '' },
        { label: 'Cancel', value: 'cancel', action: 'cancel', description: '' },
      ],
    },
    {
      step: '3', type: 'serv_insert',
      input: { tableName: 'PGD_Sessions', row: { set_id: '{{selected_id}}' } },
      on_failure: 'cancel', on_success: 'end',
      output_key: 'session',
    },
    { step: 'end', type: 'end' },
  ];

  const mockOutputs = {
    '1': [{ id: 42, name: 'Set A' }],
    '3': { id: 99 },
  };

  it('happy path passes when choice gate user_response populates output_key', () => {
    const result = runSimulation({
      steps,
      mockOutputs,
      simulationPaths: [{
        path_name: 'happy_path',
        expected_terminal: 'end',
        decisions: [
          { step: '1', outcome: 'success' },
          { step: '2', outcome: 'gate', on_select: 'next', user_response: '42' },
          { step: '3', outcome: 'success' },
        ],
      }],
      runInput: {},
    });

    const path = result.path_results[0];
    assert.equal(path.passed, true, `path must pass; got: ${path.failure_reason}`);
    assert.equal(path.terminal, 'end');

    const step2 = path.local_state_transitions.find(t => t.step === '2');
    assert.ok(step2.keys_added.includes('selected_id'), 'step 2 must add selected_id to keys_added');

    const step3 = path.local_state_transitions.find(t => t.step === '3');
    assert.ok(step3.keys_before.includes('selected_id'), 'selected_id must be in local_state when step 3 runs');
  });

  it('cancel path passes and does not fail on missing output_key', () => {
    const result = runSimulation({
      steps,
      mockOutputs,
      simulationPaths: [{
        path_name: 'cancel_path',
        expected_terminal: 'cancelled',
        decisions: [
          { step: '1', outcome: 'success' },
          { step: '2', outcome: 'gate', on_select: 'cancel', user_response: 'cancel' },
        ],
      }],
      runInput: {},
    });

    const path = result.path_results[0];
    assert.equal(path.passed, true, `cancel path must pass; got: ${path.failure_reason}`);
    assert.equal(path.terminal, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// runSimulation — choice gate resolves option value from action field
// ---------------------------------------------------------------------------

describe('runSimulation — choice gate resolves option value, not raw user_response', () => {
  // Step 2 options: { value: 'correct', action: 'confirm' } and { value: 'incorrect', action: 'incorrect' }.
  // decision.user_response = 'confirm' (the action). The simulation must write 'correct' (the value).
  const steps = [
    {
      step: '1', type: 'serv_query',
      input: { tableName: 'PGD_Cards' },
      on_success: 'next', on_failure: 'cancel',
      output_key: 'cards',
    },
    {
      step: '2', type: 'human_gate', gate_type: 'choice',
      output_key: 'user_result',
      on_success: 'next', on_cancel: 'cancel',
      options: [
        { label: '✅ Correct',   value: 'correct',   action: 'confirm',   on_select: 'next' },
        { label: '❌ Incorrect', value: 'incorrect', action: 'incorrect', on_select: 'next' },
        { label: 'Cancel',       value: 'cancel',    action: 'cancel',    on_select: 'cancel' },
      ],
    },
    {
      step: '3', type: 'serv_insert',
      input: { tableName: 'PGD_TestLogs', row: { result: '{{user_result}}' } },
      on_success: 'end', on_failure: 'cancel',
      output_key: 'log',
    },
    { step: 'end', type: 'end' },
  ];
  const mockOutputs = { '1': [{ id: 1 }], '3': { id: 9 } };

  it('writes option.value when user_response matches option action', () => {
    const result = runSimulation({
      steps, mockOutputs,
      simulationPaths: [{
        path_name: 'correct_path',
        expected_terminal: 'end',
        decisions: [
          { step: '1', outcome: 'success' },
          { step: '2', outcome: 'gate', on_select: 'next', user_response: 'confirm' },
        ],
      }],
      runInput: {},
    });
    const path = result.path_results[0];
    assert.equal(path.passed, true, path.failure_reason);
    const step3 = path.local_state_transitions.find(t => t.step === '3');
    assert.ok(step3?.keys_before.includes('user_result'), 'user_result must be in local_state when step 3 runs');
  });

  it('writes option.value when user_response matches option value directly', () => {
    const result = runSimulation({
      steps, mockOutputs,
      simulationPaths: [{
        path_name: 'incorrect_path',
        expected_terminal: 'end',
        decisions: [
          { step: '1', outcome: 'success' },
          { step: '2', outcome: 'gate', on_select: 'next', user_response: 'incorrect' },
        ],
      }],
      runInput: {},
    });
    const path = result.path_results[0];
    assert.equal(path.passed, true, path.failure_reason);
    const step3 = path.local_state_transitions.find(t => t.step === '3');
    assert.ok(step3?.keys_before.includes('user_result'), 'user_result must be in local_state when step 3 runs');
  });
});

// ---------------------------------------------------------------------------
// runSimulation — auto-continue human_gate when no decision provided
// ---------------------------------------------------------------------------

describe('runSimulation — auto-continues human_gate with no decision using first non-cancel option', () => {
  const steps = [
    {
      step: '1', type: 'serv_query',
      input: { tableName: 'PGD_Items' },
      on_success: 'next', on_failure: 'cancel',
      output_key: 'items',
    },
    {
      step: '2', type: 'human_gate', gate_type: 'choice',
      output_key: 'choice',
      on_success: 'next', on_cancel: 'cancel',
      options: [
        { label: 'Go', value: 'go', action: 'confirm', on_select: 'next' },
        { label: 'Cancel', value: 'cancel', action: 'cancel', on_select: 'cancel' },
      ],
    },
    {
      step: '3', type: 'serv_insert',
      input: { tableName: 'PGD_Results', row: {} },
      on_success: 'end', on_failure: 'cancel',
      output_key: 'result',
    },
    { step: 'end', type: 'end' },
  ];
  const mockOutputs = { '1': [{ id: 1 }], '3': { id: 5 } };

  it('path passes and gate is marked auto_continued when no decision exists', () => {
    const result = runSimulation({
      steps, mockOutputs,
      simulationPaths: [{
        path_name: 'no_gate_decision',
        expected_terminal: 'end',
        decisions: [
          { step: '1', outcome: 'success' },
          // no decision for step '2' — should auto-continue
        ],
      }],
      runInput: {},
    });
    const path = result.path_results[0];
    assert.equal(path.passed, true, path.failure_reason);
    const step2 = path.local_state_transitions.find(t => t.step === '2');
    assert.equal(step2?.auto_continued, true, 'step 2 must be marked auto_continued');
    assert.ok(step2?.keys_added.includes('choice'), 'step 2 must write output_key when auto-continued');
  });
});

// ---------------------------------------------------------------------------
// runSimulation — loop limit reached returns passed: true
// ---------------------------------------------------------------------------

describe('runSimulation — loop limit reached treats path as passed', () => {
  // A 2-step loop: serv_query → human_gate that routes back to step 1 indefinitely.
  // After MAX_LOOP_ITER visits to step 1, the simulation must return loop_limit_reached: true.
  const steps = [
    {
      step: '1', type: 'serv_query',
      input: { tableName: 'PGD_Cards' },
      on_success: 'next', on_failure: 'cancel',
      output_key: 'cards',
    },
    {
      step: '2', type: 'human_gate', gate_type: 'choice',
      output_key: 'ans',
      on_success: 'next', on_cancel: 'cancel',
      options: [
        { label: 'Again', value: 'again', action: 'again', on_select: 'step:1' },
        { label: 'Cancel', value: 'cancel', action: 'cancel', on_select: 'cancel' },
      ],
    },
    { step: 'end', type: 'end' },
  ];

  it('returns passed:true with loop_limit_reached when a step is visited too many times', () => {
    const result = runSimulation({
      steps,
      mockOutputs: { '1': [] },
      simulationPaths: [{
        path_name: 'loop_forever',
        expected_terminal: 'end',
        decisions: [
          { step: '2', outcome: 'gate', on_select: 'step:1', user_response: 'again' },
        ],
      }],
      runInput: {},
    });
    const path = result.path_results[0];
    assert.equal(path.passed, true, 'loop-exhausted path must be passed');
    assert.equal(path.loop_limit_reached, true, 'loop_limit_reached flag must be set');
  });
});
