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
import { buildDialog, runSandboxedExpression, buildMemoryRow, resolveGateOptions, resolveOptionSource, resolveDisplayText } from '../../src/proc/step-executor.mjs';
import { runSimulation }                      from '../../src/proc/simulation-engine.mjs';
import { resolvePath, resolveInput, resolveTemplate } from '../../src/proc/template-resolver.mjs';

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
// buildDialog — choice gate, iterator-driven options
// ---------------------------------------------------------------------------

describe('buildDialog — choice gate with iterator-expanded options', () => {
  // Reproduces the live edit_budget (workflow 352) defect: the buttons expanded the
  // iterator and bound each row correctly, but the description_list rendered above them
  // was built from the RAW step.options — so the user saw one row reading literally
  // "{{label}} — {{is_placeholder ? '(New month)' : ''}}" instead of one row per month.
  const monthStep = {
    step: '3', type: 'human_gate', gate_type: 'choice',
    message_template: "Which month's budget would you like to edit?",
    options: [
      {
        label: '{{label}}', value: '{{id}}', iterator: 'selectable_months',
        on_select: 'next',
        description: "{{is_placeholder ? '(New month)' : ''}}",
      },
      { label: 'Cancel', value: 'cancel', on_select: 'cancel', description: 'Stop workflow' },
    ],
    output_key: 'selected_month_id',
  };
  // Exactly the shape workflow 352's step-2 js_transform emits.
  const localState = {
    selectable_months: [
      { id: '2026-07', label: '07/2026', is_placeholder: true  },
      { id: '2026-06', label: '06/2026', is_placeholder: false },
    ],
  };

  it('expands the iterator into one description row per item, with tokens resolved', () => {
    const dialog = buildDialog(monthStep, localState);
    const list   = dialog.fields.find(f => f.type === 'description_list');

    assert.equal(list.items.length, 3, 'two months plus Cancel — not one unexpanded row');
    assert.deepEqual(list.items.map(i => i.label), ['07/2026', '06/2026', 'Cancel']);
    assert.deepEqual(list.items.map(i => i.value), ['2026-07', '2026-06', 'cancel']);
    assert.ok(!JSON.stringify(list.items).includes('{{'),
      'no raw template token may survive into the rendered list');
  });

  it('evaluates a per-row expression in a description against that row', () => {
    const list = buildDialog(monthStep, localState).fields.find(f => f.type === 'description_list');
    assert.equal(list.items[0].description, '(New month)', 'is_placeholder true → the label');
    assert.equal(list.items[1].description, '',            'is_placeholder false → empty');
    assert.equal(list.items[2].description, 'Stop workflow', 'non-iterator option unaffected');
  });

  it('keeps the buttons and the description list in step with each other', () => {
    const dialog  = buildDialog(monthStep, localState);
    const list    = dialog.fields.find(f => f.type === 'description_list');
    const buttons = dialog.fields.find(f => f.type === 'actions').buttons;
    assert.deepEqual(buttons.map(b => b.label), list.items.map(i => i.label),
      'both are built from one expanded option list, so they cannot diverge');
  });

  it('an iterator naming a missing/empty array contributes no rows', () => {
    const list = buildDialog(monthStep, {}).fields.find(f => f.type === 'description_list');
    assert.deepEqual(list.items.map(i => i.label), ['Cancel']);
  });
});

// ---------------------------------------------------------------------------
// buildDialog — modal descriptor passthrough (the regression)
// ---------------------------------------------------------------------------

describe('buildDialog — modal descriptor passthrough', () => {
  it('passes modal field through to button value when option carries modal descriptor', () => {
    const step = {
      step:        '3',
      type:        'human_gate',
      gate_type:   'list_selection',
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
      gate_type:   'list_selection',
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

  it('list_selection gate renders one row per item with a caller-configured action button (not the defaults)', () => {
    // Sprint 7 Track D2 drill-down — list_selection unifies what were briefly
    // two gate types (edit_list/row_list) into one: same 'list' field rendering
    // regardless of what the button does. item_action's label/style/action/
    // on_select are all caller-configurable; context_key items are expected
    // pre-formatted as { id, fields?, secondaryAction? }.
    const step = {
      step:         '9c',
      type:         'human_gate',
      gate_type:    'list_selection',
      context_key:  'row_items',
      item_action:  { action: 'view_record', label: 'View', style: 'default', on_select: 'step:20' },
      output_key:   'selected_record_id',
      options:      [{ label: 'Done', action: 'cancel', on_select: 'cancel' }],
    };
    const localState = {
      row_items: [
        { id: 3, fields: { title: 'Nov 20, 2024', card_count: 2 } },
        { id: 4, fields: { title: 'Spanish Grammer' } },
      ],
    };

    const dialog = buildDialog(step, localState);
    const listField = dialog.fields.find(f => f.type === 'list');
    assert.ok(listField, 'list field must be present');
    assert.equal(listField.items.length, 2);
    assert.equal(listField.items[0].id, 3);
    assert.deepEqual(listField.items[0].fields, { title: 'Nov 20, 2024', card_count: 2 });
    assert.equal(listField.items[0].secondaryAction.action, 'view_record');
    assert.equal(listField.items[0].secondaryAction.label, 'View');
    assert.equal(listField.items[0].secondaryAction.style, 'default');

    // "Done" still renders as a real bottom button — view_record does NOT,
    // since it's resolved via item_action.on_select directly (see run-workflow.mjs),
    // not via a duplicate options[] entry.
    const actionsField = dialog.fields.find(f => f.type === 'actions');
    assert.equal(actionsField.buttons.length, 1);
    assert.equal(actionsField.buttons[0].action, 'cancel');
  });

  it('list_selection gate defaults item_action label to Select, and sends no style when omitted', () => {
    const step = {
      step: '9c', type: 'human_gate', gate_type: 'list_selection',
      context_key: 'row_items',
      item_action: { action: 'select_row', on_select: 'step:40' },
      options: [{ label: 'Looks good', action: 'confirm', on_select: 'next' }],
    };
    const localState = { row_items: [{ id: 1, fields: { title: 'Row 1' } }] };

    const dialog = buildDialog(step, localState);
    const listField = dialog.fields.find(f => f.type === 'list');
    assert.equal(listField.items[0].secondaryAction.label, 'Select');
    assert.equal(listField.items[0].secondaryAction.style, undefined,
      'no style default — Slack rejects style: "default", and callback.mjs forwards only danger/primary');
  });

  it('list_selection gate passes an item\'s own pre-built secondaryAction through untouched, ignoring step.item_action', () => {
    // Some items (e.g. a referenced parent row) get no action at all, decided
    // per-item upstream, not by this generic renderer.
    const step = {
      step: '9c', type: 'human_gate', gate_type: 'list_selection',
      context_key: 'row_items',
      item_action: { action: 'select_row', on_select: 'step:40' },
      options: [{ label: 'Looks good', action: 'confirm', on_select: 'next' }],
    };
    const localState = {
      row_items: [
        { id: 1, fields: { title: 'Child' }, secondaryAction: { label: 'Open', action: 'select_row' } },
        { id: 2, fields: { title: 'Parent (referenced)' }, secondaryAction: null },
      ],
    };

    const dialog = buildDialog(step, localState);
    const listField = dialog.fields.find(f => f.type === 'list');
    assert.ok(listField.items[0].secondaryAction, 'child item keeps its own action');
    assert.equal(listField.items[1].secondaryAction, null, 'parent item explicitly has no action, step.item_action must not override it');
  });

  it('create_domain step 12 is a choice gate with per-table reveals and inline modal', () => {
    // Step 12 is the schema review gate — per-table reveal panels, modal for Request changes.
    const step = getStep('create_domain', '12');
    assert.equal(step.gate_type, 'choice', 'step 12 must be a choice gate');
    assert.ok(step.reveals, 'step 12 must have a reveals field for per-table schema cards');
    assert.ok(!step.reveal, 'step 12 must NOT have the old single reveal field');

    const approveOpt = step.options.find(o => o.value === 'approve');
    assert.ok(approveOpt,                            'approve option must exist');
    assert.equal(approveOpt.on_select, '16',         'approve must route to final confirm (step 16)');

    const changesOpt = step.options.find(o => o.value === 'request_changes');
    assert.ok(changesOpt,                            'request_changes option must exist');
    assert.equal(changesOpt.on_select, '12b',        'request_changes must route to step 12b');
    assert.ok(changesOpt.modal,                      'request_changes must carry a modal descriptor');
    assert.equal(changesOpt.output_key, 'design_feedback', 'request_changes modal must write to design_feedback');

    const addTableOpt = step.options.find(o => o.value === 'add_table');
    assert.ok(addTableOpt,                           'add_table option must exist');
    assert.equal(addTableOpt.on_select, '12c',       'add_table must route to step 12c (table description input)');

    // Step 12a must no longer exist — collapsed into the step 12 modal
    const wf = seed.find(w => w.name === 'create_domain');
    assert.ok(!wf.steps.find(s => s.step === '12a'), 'step 12a must be removed (request_changes is now handled by step 12 modal)');
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

describe('create_domain step 11 — columnSummary expression', () => {
  it('enriches tables with columnSummary and domain, excluding system columns', () => {
    const step = getStep('create_domain', '11');
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

describe('create_domain step 14 — merge + columnSummary expression', () => {
  it('merges new_table (child FK) from local_state and re-enriches all tables', () => {
    const step = getStep('create_domain', '14');
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
    const step = getStep('create_domain', '14');
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
    const step = getStep('create_domain', '14');
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
    const step = getStep('create_domain', '14');
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

// Sprint 7 Track D9 — get_entity/list_entity's presentation step builds a
// { entity_name, entities: [{fields, children?}] } structure, then formats it
// into markdown deterministically (no LLM call — format_entity_display was
// removed as a Type-4a overcorrection, see Track A8/A9). These tests cover the
// pre-processing builder (FK resolution, system/embedding/null stripping,
// scalar/child separation) — the formatter itself is covered separately below.
describe('get_entity step 11 — entity_display_data builder (with children)', () => {
  const RESULTS = [
    {
      id:           1,
      front_text:   'hola',
      back_text:    'hello',
      created_at:   '2026-01-01',
      updated_at:   '2026-01-01',
      parent_id:    5,
      review_logs:  [{ id: 10, result: 'pass', created_at: '2026-01-01' }],
    },
  ];
  const ROOT_TABLE_SCHEMA = [{
    foreign_keys: [{ column: 'parent_id', references: { table: 'PGD_Decks', column: 'id' } }],
  }];
  const FK_LABEL_MAP = { 'PGD_Decks:5': 'Spanish Vocabulary' };

  it('strips system/embedding columns, elides nulls, resolves FK columns, and keeps child arrays separately', () => {
    const step = getStep('get_entity', '11');
    const localState = { results: RESULTS, root_table_schema: ROOT_TABLE_SCHEMA, fk_label_map: FK_LABEL_MAP };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.entities.length, 1);
    const entity = result.entities[0];
    assert.equal(entity.fields.front_text, 'hola');
    assert.equal(entity.fields.parent_id, 'Spanish Vocabulary'); // FK resolved to label, not raw id
    assert.equal(entity.fields.id, 1);                   // id kept — needed to reference this record in get/update/delete
    assert.equal(entity.fields.created_at, undefined);  // system col suppressed
    assert.equal(entity.fields.review_logs, undefined); // arrays never land in fields
    assert.equal(entity.children.review_logs.length, 1);
    assert.equal(entity.children.review_logs[0].result, 'pass');
    assert.equal(entity.children.review_logs[0].created_at, undefined); // system col suppressed on children too
  });

  it('returns an empty entities array for no results', () => {
    const step = getStep('get_entity', '11');
    const result = runSandboxedExpression(step.expression, null, { results: [] }, 'test');
    assert.deepEqual(result.entities, []);
  });
});

describe('get_entity step 12 — deterministic formatter (replaces format_entity_display llm_call)', () => {
  it('renders scalar fields as bold lines and keeps the id visible', () => {
    const step = getStep('get_entity', '12');
    const localState = {
      entity_display_data: {
        entity_name: 'Deck',
        entities: [ { fields: { id: 3, title: 'Spanish Vocabulary', card_count: 2 } } ],
      },
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.match(result.formatted_markdown, /Spanish Vocabulary \(id: 3\)/);
    assert.match(result.formatted_markdown, /\*Card Count:\* 2/);
    assert.equal(result.reveals.length, 0);
  });

  it('collapses a child collection over the reveal threshold into a reveal panel instead of inline', () => {
    const step = getStep('get_entity', '12');
    const many = Array.from({ length: 8 }, (_, i) => ({ front: `card${i}`, back: `back${i}` }));
    const localState = {
      entity_display_data: {
        entity_name: 'Deck',
        entities: [ { fields: { id: 3, title: 'Spanish Vocabulary' }, children: { cards: many } } ],
      },
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.doesNotMatch(result.formatted_markdown, /card0/, 'dense collection must not appear inline');
    assert.equal(result.reveals.length, 1);
    assert.equal(result.reveals[0].content.length, 8);
  });

  it('keeps a short child collection inline, no reveal', () => {
    const step = getStep('get_entity', '12');
    const localState = {
      entity_display_data: {
        entity_name: 'Deck',
        entities: [ { fields: { id: 3, title: 'Spanish Vocabulary' }, children: { cards: [{ front: 'hola', back: 'hello' }] } } ],
      },
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.match(result.formatted_markdown, /## cards/);
    assert.equal(result.reveals.length, 0);
  });
});

// Sprint 7 Track D9/D12 — list_entity replaced its fixed "list root → view one
// child level → end" shape with a recursive loop over dynamic, click-time FK
// lookups (see docs/sprints/CURRENT.md Track D). These tests cover the loop's
// pure js_transform steps directly, independent of the engine's step routing.
describe('list_entity step 23 — row_build (fetch → resolved row_items + full_rows_map)', () => {
  const LOOP_STATE = {
    defs: [
      {
        table: 'PGD_Parent',
        fkColumn: 'parent_id',
        foreign_keys: [{ column: 'parent_id', references: { table: 'PGD_Parent', column: 'id' } }],
      },
      {
        table: 'PGD_Child',
        fkColumn: 'parent_ref_id',
        foreign_keys: [],
      },
    ],
    parent_id: 3,
    nav_stack: [],
  };
  const FETCHED = [
    [ { id: 7, title: 'Nested Parent A', created_at: '2026', updated_at: '2026', parent_id: 3 } ], // PGD_Parent rows
    [ { id: 20, front_text: 'hola', back_text: 'hello', parent_ref_id: 3, log_entries: [{ result: 'pass' }] } ], // PGD_Child rows
  ];

  it('flattens rows across defs, strips system/embedding/null fields, and resolves outgoing FK labels', () => {
    const step = getStep('list_entity', '23');
    const localState = { loop_state: LOOP_STATE, fetched_rows_by_def: FETCHED, fk_label_map: {} };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.row_items.length, 2);
    const parentRow = result.row_items.find(r => r.responseData.table === 'PGD_Parent');
    assert.equal(parentRow.id, 7, 'item.id is the record\'s own plain id, not a table-prefixed composite');
    assert.equal(parentRow.fields.id, undefined, 'id is not duplicated inside fields — it is already the top-level item.id');
    assert.equal(parentRow.fields.title, 'Nested Parent A', 'no forced label synthesis — the record\'s own field name/value passes through as-is');
    assert.equal(parentRow.responseData.id, 7);
    assert.equal(parentRow.responseData.hasChildren, false, 'hasChildren starts false — tagged later by step 26');
    assert.equal(result.full_rows_map['PGD_Parent:7'].created_at, undefined, 'system column suppressed');
    assert.equal(result.full_rows_map['PGD_Child:20'].log_entries, undefined, 'array-valued fields are stripped at list level — never split into a children key');
  });

  it('keeps full cleaned fields in full_rows_map for a later leaf-detail render without a re-fetch', () => {
    const step = getStep('list_entity', '23');
    const localState = { loop_state: LOOP_STATE, fetched_rows_by_def: FETCHED, fk_label_map: {} };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.full_rows_map['PGD_Child:20'].front_text, 'hola');
  });
});

// Sprint 7 Track D12 (refined) — "does anything reference this table" was too
// broad a signal for hasChildren: a table can have an incidental FK pointing
// at it (e.g. an audit-log-style table) without that relationship being
// something a user would ever want to navigate into. hasChildren now requires
// either a self-reference or a relationship create_domain already curated
// into some entity's own `joins` — driven entirely by domain_schemas (loaded
// once at step 1) and discovered table names, never a hardcoded table name,
// so this must behave identically for any domain, not just the one these
// fixtures happen to resemble.
describe('list_entity step 25a — hasChildren requires self-reference or a curated domain_schemas join', () => {
  const DOMAIN_SCHEMAS = [
    {
      entity_name: 'Widget',
      root_table:  'PGD_Parent',
      joins:       [{ table: 'PGD_Child', alias: 'children', on: 'children.parent_id = r.id' }],
    },
  ];

  it('self-reference is always further-navigable, even with no domain_schemas entry for it', () => {
    const step = getStep('list_entity', '25a');
    const localState = {
      domain_schemas: [],
      distinct_child_tables: ['PGD_Parent'],
      child_discover_results: [[{ table_name: 'PGD_Parent' }]], // parent references itself
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.PGD_Parent, true);
  });

  it('a table curated as a join child of the parent in domain_schemas is further-navigable', () => {
    const step = getStep('list_entity', '25a');
    const localState = {
      domain_schemas: DOMAIN_SCHEMAS,
      distinct_child_tables: ['PGD_Parent'],
      child_discover_results: [[{ table_name: 'PGD_Child' }]],
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.PGD_Parent, true);
  });

  it('a table with an incidental FK but no curated relationship is NOT further-navigable', () => {
    const step = getStep('list_entity', '25a');
    const localState = {
      domain_schemas: DOMAIN_SCHEMAS,
      distinct_child_tables: ['PGD_Child'],
      child_discover_results: [[{ table_name: 'PGD_Log' }]], // references PGD_Child, but not curated anywhere
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.PGD_Child, false, 'PGD_Log referencing PGD_Child does not make PGD_Child further-navigable — it is attached detail data');
  });
});

describe('list_entity step 41b — next-level defs filtered to curated children only', () => {
  it('excludes a discovered table that is not curated as a join child of the clicked row\'s table', () => {
    const step = getStep('list_entity', '41b');
    const localState = {
      domain_schemas: [{ root_table: 'PGD_Parent', joins: [{ table: 'PGD_Child' }] }],
      selected_row: { table: 'PGD_Parent', id: 3 },
      clicked_referencing_tables: [
        { table_name: 'PGD_Child', foreign_keys: [{ column: 'parent_id', references: { table: 'PGD_Parent', column: 'id' } }] },
        { table_name: 'PGD_Log',   foreign_keys: [{ column: 'parent_id', references: { table: 'PGD_Parent', column: 'id' } }] },
      ],
      nav_stack_pushed: [],
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.deepEqual(result.defs.map(d => d.table), ['PGD_Child']);
    assert.equal(result.parent_id, 3);
  });

  it('includes a self-referencing table even though it is not in any joins list', () => {
    const step = getStep('list_entity', '41b');
    const localState = {
      domain_schemas: [],
      selected_row: { table: 'PGD_Parent', id: 3 },
      clicked_referencing_tables: [
        { table_name: 'PGD_Parent', foreign_keys: [{ column: 'parent_id', references: { table: 'PGD_Parent', column: 'id' } }] },
      ],
      nav_stack_pushed: [],
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.deepEqual(result.defs.map(d => d.table), ['PGD_Parent']);
  });
});

describe('list_entity steps 50/50a/50b — leaf detail children (non-curated attached data)', () => {
  it('step 50 reuses cached (non-curated) discovery from the level this row was listed on, no new schema query', () => {
    const step = getStep('list_entity', '50');
    const localState = {
      selected_row: { table: 'PGD_Child', id: 20 },
      distinct_child_tables: ['PGD_Child'],
      child_discover_results: [[
        { table_name: 'PGD_Log', foreign_keys: [{ column: 'child_id', references: { table: 'PGD_Child', column: 'id' } }] },
      ]],
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.length, 1);
    assert.equal(result[0].table, 'PGD_Log');
    assert.equal(result[0].fkColumn, 'child_id');
    assert.equal(result[0].foreign_keys[0].column, 'child_id');
  });

  it('step 50b attaches fetched detail-child rows as entity.children, keyed by table name', () => {
    const step = getStep('list_entity', '50b');
    const localState = {
      selected_row: { table: 'PGD_Child', id: 20 },
      leaf_child_defs: [{ table: 'PGD_Log', fkColumn: 'child_id', foreign_keys: [] }],
      leaf_child_rows_by_def: [[
        { id: 1, child_id: 20, result: 'pass', created_at: '2026' },
      ]],
      row_build: { full_rows_map: { 'PGD_Child:20': { id: 20, front: 'hola' } } },
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.entities[0].fields.front, 'hola');
    assert.equal(result.entities[0].children.PGD_Log.length, 1);
    assert.equal(result.entities[0].children.PGD_Log[0].result, 'pass');
    assert.equal(result.entities[0].children.PGD_Log[0].created_at, undefined, 'system column suppressed on detail children too');
  });
});

describe('list_entity step 26 — hasChildren tagging', () => {
  it('tags each row true/false from has_children_map keyed by its own table', () => {
    const step = getStep('list_entity', '26');
    const localState = {
      has_children_map: { PGD_Parent: true, PGD_Child: false },
      row_build: {
        row_items: [
          { id: 7, fields: { title: 'Nested Parent A' }, responseData: { table: 'PGD_Parent', id: 7, hasChildren: false } },
          { id: 20, fields: { title: 'hola' }, responseData: { table: 'PGD_Child', id: 20, hasChildren: false } },
        ],
      },
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.row_items.find(r => r.responseData.table === 'PGD_Parent').responseData.hasChildren, true);
    assert.equal(result.row_items.find(r => r.responseData.table === 'PGD_Child').responseData.hasChildren, false);
    assert.match(result.message, /Found 2 record/);
  });

  it('reports "no related records" when row_items is empty', () => {
    const step = getStep('list_entity', '26');
    const result = runSandboxedExpression(step.expression, null, { has_children_map: {}, row_build: { row_items: [] } }, 'test');
    assert.equal(result.row_items.length, 0);
    assert.match(result.message, /No related records/);
  });

  // Regression: run 668 hit Slack's msg_blocks_too_long under the old one-Block-
  // Kit-block-pair-per-row rendering (a row cap was the workaround at the time).
  // The row list now renders as a single markdown table regardless of row count
  // (Sprint 7 Track D, follow-up), so no combined-row cap is needed here — the
  // per-def serv_query limit (step 20's iterator, 20 rows) is the only bound left.
  it('does not cap combined row_items — the table renders as one block regardless of row count', () => {
    const step = getStep('list_entity', '26');
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i, fields: { title: `item${i}` }, responseData: { table: 'PGD_Child', id: i, hasChildren: false },
    }));
    const localState = { has_children_map: { PGD_Child: false }, row_build: { row_items: many } };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.equal(result.row_items.length, 40, 'all combined rows must pass through uncapped');
    assert.match(result.message, /Found 40 record/);
  });
});

describe('list_entity step 51 — deterministic leaf formatter (same contract as get_entity step 12)', () => {
  it('produces formatted_markdown and reveals from entity_display_data without an LLM call', () => {
    const step = getStep('list_entity', '51');
    const localState = {
      entity_display_data: {
        entity_name: 'PGD_Child',
        entities: [ { fields: { id: 20, front_text: 'hola', back_text: 'hello' } } ],
      },
    };
    const result = runSandboxedExpression(step.expression, null, localState, 'test');
    assert.match(result.formatted_markdown, /PGD_Child \(id: 20\)/, 'falls back to entity_name when the record has no title/name field');
    assert.match(result.formatted_markdown, /\*Front Text:\* hola/);
    assert.equal(result.reveals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// add_entity — serv_entity_insert workflow step present
// ---------------------------------------------------------------------------

describe('add_entity workflow — uses serv_entity_insert (steps 4-6 replaced)', () => {
  it('add_entity step 4 is serv_entity_insert', () => {
    const step = getStep('add_entity', '4');
    assert.equal(step.type, 'serv_entity_insert');
  });

  it('add_entity step 4 passes entitySchema and parsedEntity', () => {
    const step = getStep('add_entity', '4');
    assert.ok(step.input.entitySchema, 'entitySchema input required');
    assert.ok(step.input.parsedEntity, 'parsedEntity input required');
  });

  it('add_entity has no step 5 with js_transform child-insert expression', () => {
    const wf    = seed.find(w => w.name === 'add_entity');
    const step5 = wf?.steps?.find(s => s.step === '5');
    assert.ok(!step5 || step5.type !== 'js_transform', 'old flat-insert js_transform must be gone');
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
      on_else: 'cancel', on_success: 'next',
      output_key: 'active_sets',
    },
    {
      step: '2', type: 'human_gate', gate_type: 'choice',
      output_key: 'selected_id',
      on_success: 'next', on_cancel: 'cancel', on_else: 'cancel',
      options: [
        { label: 'A', value: '{{active_sets.0.id}}', action: 'next', description: '' },
        { label: 'Cancel', value: 'cancel', action: 'cancel', description: '' },
      ],
    },
    {
      step: '3', type: 'serv_insert',
      input: { tableName: 'PGD_Sessions', row: { set_id: '{{selected_id}}' } },
      on_else: 'cancel', on_success: 'end',
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
      on_success: 'next', on_else: 'cancel',
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
      on_success: 'end', on_else: 'cancel',
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
      on_success: 'next', on_else: 'cancel',
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
      on_success: 'end', on_else: 'cancel',
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
// buildDialog — reveal field
// ---------------------------------------------------------------------------

describe('buildDialog — reveal field', () => {
  it('adds reveal field to dialog when step.reveal is present', () => {
    const step = {
      step:      '6r',
      type:      'human_gate',
      gate_type: 'choice',
      message_template: 'Pick an answer.',
      reveal: {
        button_label: 'Show Definition',
        content:      'A workflow is a reusable sequence of declarative steps.',
      },
      output_key: 'answer',
      options: [
        { value: 'a', label: 'A', description: 'Option A', on_select: 'next' },
        { value: 'cancel', label: 'Cancel', on_select: 'cancel' },
      ],
    };
    const dialog = buildDialog(step, {});
    const revealField = dialog.fields.find(f => f.type === 'reveal');
    assert.ok(revealField, 'reveal field must be present');
    assert.equal(revealField.button_label, 'Show Definition');
    assert.equal(revealField.content, 'A workflow is a reusable sequence of declarative steps.');
  });

  it('resolves template tokens in reveal.content', () => {
    const step = {
      step:      'r1',
      type:      'human_gate',
      gate_type: 'choice',
      message_template: 'Test.',
      reveal: {
        button_label: 'Show',
        content:      'The answer is {{definition}}.',
      },
      options: [{ value: 'cancel', label: 'Cancel', on_select: 'cancel' }],
    };
    const dialog = buildDialog(step, { definition: 'forty-two' });
    const revealField = dialog.fields.find(f => f.type === 'reveal');
    assert.ok(revealField);
    assert.equal(revealField.content, 'The answer is forty-two.');
  });

  it('does not add reveal field when step.reveal is absent', () => {
    const step = {
      step:      'r2',
      type:      'human_gate',
      gate_type: 'choice',
      message_template: 'No reveal.',
      options: [{ value: 'cancel', label: 'Cancel', on_select: 'cancel' }],
    };
    const dialog = buildDialog(step, {});
    const revealField = dialog.fields.find(f => f.type === 'reveal');
    assert.equal(revealField, undefined, 'reveal field must not be present');
  });

  it('reveal field appears before actions field in dialog.fields', () => {
    const step = {
      step:      'r3',
      type:      'human_gate',
      gate_type: 'choice',
      message_template: 'Order test.',
      reveal: { button_label: 'Reveal', content: 'Some content.' },
      options: [{ value: 'cancel', label: 'Cancel', on_select: 'cancel' }],
    };
    const dialog = buildDialog(step, {});
    const revealIdx  = dialog.fields.findIndex(f => f.type === 'reveal');
    const actionsIdx = dialog.fields.findIndex(f => f.type === 'actions');
    assert.ok(revealIdx !== -1, 'reveal must be present');
    assert.ok(actionsIdx !== -1, 'actions must be present');
    assert.ok(revealIdx < actionsIdx, 'reveal must appear before actions');
  });
});

// ---------------------------------------------------------------------------
// runSimulation — L1 reveal field validation
// ---------------------------------------------------------------------------

describe('runSimulation — L1 reveal field validation', () => {
  function makeRevealStep(reveal) {
    return {
      step: '1', type: 'human_gate', gate_type: 'choice',
      message_template: 'Test.',
      reveal,
      options: [
        { value: 'a', label: 'A', description: '', on_select: 'end' },
        { value: 'cancel', label: 'Cancel', on_select: 'cancel' },
      ],
      on_success: 'end', on_cancel: 'cancel',
    };
  }

  it('passes L1 when reveal has non-empty button_label and content', () => {
    const result = runSimulation({
      steps: [
        makeRevealStep({ button_label: 'Show', content: 'Some content.' }),
        { step: 'end', type: 'end' },
      ],
      mockOutputs: null, simulationPaths: null, runInput: {},
    });
    assert.equal(result.static_analysis.passed, true, JSON.stringify(result.static_analysis.issues));
  });

  it('fails L1 when reveal.button_label is empty', () => {
    const result = runSimulation({
      steps: [
        makeRevealStep({ button_label: '', content: 'Some content.' }),
        { step: 'end', type: 'end' },
      ],
      mockOutputs: null, simulationPaths: null, runInput: {},
    });
    assert.equal(result.static_analysis.passed, false);
    const issue = result.static_analysis.issues.find(i => i.check === 'reveal_missing_button_label');
    assert.ok(issue, 'reveal_missing_button_label issue must be present');
  });

  it('fails L1 when reveal.content is empty', () => {
    const result = runSimulation({
      steps: [
        makeRevealStep({ button_label: 'Show', content: '' }),
        { step: 'end', type: 'end' },
      ],
      mockOutputs: null, simulationPaths: null, runInput: {},
    });
    assert.equal(result.static_analysis.passed, false);
    const issue = result.static_analysis.issues.find(i => i.check === 'reveal_missing_content');
    assert.ok(issue, 'reveal_missing_content issue must be present');
  });

  it('fails L1 when both reveal fields are missing', () => {
    const result = runSimulation({
      steps: [
        makeRevealStep({ button_label: '', content: '' }),
        { step: 'end', type: 'end' },
      ],
      mockOutputs: null, simulationPaths: null, runInput: {},
    });
    assert.equal(result.static_analysis.passed, false);
    assert.equal(result.static_analysis.issues.length, 2);
  });
});

// ---------------------------------------------------------------------------
// ping_core seed — reveal step present and valid
// ---------------------------------------------------------------------------

describe('ping_core seed — step 6r reveal gate', () => {
  it('has step 6r with gate_type choice and a reveal field', () => {
    const step = getStep('ping_core', '6r');
    assert.equal(step.gate_type, 'choice');
    assert.ok(step.reveal, 'step 6r must have reveal field');
    assert.ok(step.reveal.button_label, 'reveal.button_label must be non-empty');
    assert.ok(step.reveal.content, 'reveal.content must be non-empty');
  });

  it('step 6r passes L1 validation', () => {
    const wf = seed.find(w => w.name === 'ping_core');
    const result = runSimulation({ steps: wf.steps, mockOutputs: null, simulationPaths: null, runInput: {} });
    assert.equal(result.static_analysis.passed, true, JSON.stringify(result.static_analysis.issues));
  });

  it('step 8p, 8t, 8y, 8n are all present', () => {
    for (const key of ['8p', '8t', '8y', '8n']) {
      const step = getStep('ping_core', key);
      assert.ok(step, `step ${key} must exist`);
    }
  });

  it('step 8 condition routes to 8y on truthy and 8n on falsy', () => {
    const step = getStep('ping_core', '8');
    assert.equal(step.on_success, '8y');
    assert.equal(step.on_else,  '8n');
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
      on_success: 'next', on_else: 'cancel',
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

// ---------------------------------------------------------------------------
// L1 — nested {{ detection (item 6)
// ---------------------------------------------------------------------------

describe('runSimulation — L1 rejects nested {{...{{...}}...}} syntax', () => {
  it('raises unsupported_handlebars_syntax for nested template in message_template', () => {
    const steps = [
      {
        step: '1', type: 'serv_query',
        input: { tableName: 'PGD_Cards' },
        output_key: 'cards', on_success: 'next', on_else: 'cancel',
      },
      {
        step: '2', type: 'human_gate', gate_type: 'choice',
        // nested {{ — dynamically computed index inside a template token
        message_template: '{{cards.{{current_index}}.term}}',
        options: [
          { label: 'A', value: 'a', action: 'a', on_select: 'next' },
          { label: 'Cancel', value: 'cancel', action: 'cancel', on_select: 'cancel' },
        ],
        on_success: 'next', on_else: 'cancel',
      },
      { step: '3', type: 'end' },
    ];
    const result = runSimulation({ steps, simulationPaths: [], runInput: {} });
    const issue = result.static_analysis.issues.find(i => i.failure_class === 'unsupported_handlebars_syntax');
    assert.ok(issue, 'must report unsupported_handlebars_syntax');
    assert.equal(issue.step, '2');
    assert.equal(result.static_analysis.passed, false, 'L1 must fail');
  });

  it('does not flag valid single-level templates', () => {
    const steps = [
      {
        step: '1', type: 'serv_query',
        input: { tableName: 'PGD_Cards' },
        output_key: 'cards', on_success: 'next', on_else: 'cancel',
      },
      {
        step: '2', type: 'human_gate', gate_type: 'choice',
        message_template: '{{cards.0.term}}',
        options: [
          { label: 'A', value: 'a', action: 'a', on_select: 'next' },
          { label: 'Cancel', value: 'cancel', action: 'cancel', on_select: 'cancel' },
        ],
        on_success: 'next', on_else: 'cancel',
      },
      { step: '3', type: 'end' },
    ];
    const result = runSimulation({ steps, simulationPaths: [], runInput: {} });
    const nested = result.static_analysis.issues.filter(i => i.failure_class === 'unsupported_handlebars_syntax');
    assert.equal(nested.length, 0, 'no nested template issues for valid template');
  });
});

// ---------------------------------------------------------------------------
// L2 — iterator body simulation (item 9)
// ---------------------------------------------------------------------------

describe('runSimulation — L2 simulates one iterator body iteration', () => {
  // Iterator whose body is a choice gate that writes output_key.
  // A downstream step uses {{answers}} — must be available after the iterator.
  const steps = [
    {
      step: '1', type: 'serv_query',
      input: { tableName: 'PGD_Cards' },
      output_key: 'cards', on_success: 'next', on_else: 'cancel',
    },
    {
      step: '2', type: 'iterator',
      items_key: 'cards',
      item_step: {
        type: 'human_gate', gate_type: 'choice',
        message_template: '{{item.term}}',
        output_key: 'answers',
        options: [
          { label: 'A', value: 'correct', action: 'correct', on_select: 'next' },
          { label: 'Cancel', value: 'cancel', action: 'cancel', on_select: 'cancel' },
        ],
        on_success: 'next', on_else: 'cancel',
      },
      execution_mode: 'sequential',
      output_key: 'answers',
      on_complete: 'next', on_else: 'cancel',
    },
    {
      step: '3', type: 'notify',
      message_template: 'Done — {{answers.length}} answers',
      on_success: 'end',
    },
    { step: '4', type: 'end' },
  ];

  it('body output_key is available to downstream steps', () => {
    const result = runSimulation({
      steps,
      mockOutputs: { '1': [{ id: 1, term: 'hola' }] },
      simulationPaths: [{
        path_name: 'happy_path',
        expected_terminal: 'end',
        decisions: [
          { step: '1', outcome: 'success' },
        ],
      }],
      runInput: {},
    });
    const path = result.path_results[0];
    assert.equal(path.passed, true, `path must pass; got: ${path.failure_reason}`);

    const iter = path.local_state_transitions.find(t => t.step === '2');
    assert.ok(iter, 'iterator step must appear in transitions');
    assert.ok(iter.keys_added.includes('answers'), 'answers must be added by iterator');
  });

  it('L1 still passes for a valid iterator with body gate', () => {
    const result = runSimulation({ steps, simulationPaths: [], runInput: {} });
    assert.equal(result.static_analysis.passed, true, `L1 must pass; issues: ${JSON.stringify(result.static_analysis.issues)}`);
  });
});

// ---------------------------------------------------------------------------
// L2 — reveal.content template validation (item 10)
// ---------------------------------------------------------------------------

describe('runSimulation — L2 validates reveal.content template vars', () => {
  it('fails path when reveal.content references a key not yet in localState', () => {
    const steps = [
      {
        step: '1', type: 'serv_query',
        input: { tableName: 'PGD_Cards' },
        output_key: 'cards', on_success: 'next', on_else: 'cancel',
      },
      {
        step: '2', type: 'human_gate', gate_type: 'choice',
        message_template: '{{cards.0.term}}',
        reveal: {
          button_label: 'Show Answer',
          content: '{{definition}}',  // 'definition' never written to localState
        },
        options: [
          { label: 'A', value: 'a', action: 'a', on_select: 'next' },
          { label: 'Cancel', value: 'cancel', action: 'cancel', on_select: 'cancel' },
        ],
        on_success: 'next', on_else: 'cancel', on_cancel: 'cancel',
      },
      { step: '3', type: 'end' },
    ];

    const result = runSimulation({
      steps,
      mockOutputs: { '1': [{ id: 1, term: 'hola', definition: 'hello' }] },
      simulationPaths: [{
        path_name: 'reveal_missing',
        expected_terminal: 'end',
        decisions: [{ step: '1', outcome: 'success' }],
      }],
      runInput: {},
    });
    const path = result.path_results[0];
    assert.equal(path.passed, false, 'path must fail due to missing reveal.content key');
    assert.ok(path.failure_reason.includes('reveal.content'), `failure_reason must mention reveal.content; got: ${path.failure_reason}`);
    assert.ok(path.failure_step === '2', `failure_step must be step 2; got: ${path.failure_step}`);
  });

  it('passes when reveal.content keys are all available in localState', () => {
    const steps = [
      {
        step: '1', type: 'serv_query',
        input: { tableName: 'PGD_Cards' },
        output_key: 'cards', on_success: 'next', on_else: 'cancel',
      },
      {
        step: '2', type: 'human_gate', gate_type: 'choice',
        message_template: '{{cards.0.term}}',
        reveal: {
          button_label: 'Show Answer',
          content: '{{cards.0.definition}}',  // cards IS in localState after step 1
        },
        options: [
          { label: 'A', value: 'a', action: 'a', on_select: 'next' },
          { label: 'Cancel', value: 'cancel', action: 'cancel', on_select: 'cancel' },
        ],
        on_success: 'next', on_else: 'cancel', on_cancel: 'cancel',
      },
      { step: '3', type: 'end' },
    ];

    const result = runSimulation({
      steps,
      mockOutputs: { '1': [{ id: 1, term: 'hola', definition: 'hello' }] },
      simulationPaths: [{
        path_name: 'reveal_ok',
        expected_terminal: 'end',
        decisions: [{ step: '1', outcome: 'success' }],
      }],
      runInput: {},
    });
    const path = result.path_results[0];
    assert.equal(path.passed, true, `path must pass; got: ${path.failure_reason}`);
  });
});

// ---------------------------------------------------------------------------
// write_memory — buildMemoryRow pure function
// ---------------------------------------------------------------------------

describe('buildMemoryRow — scope template resolution', () => {
  it('resolves {{template}} tokens in scope values against local_state', () => {
    const step = {
      input: {
        memory_type: 'semantic',
        scope: { domain: '{{input.domain}}', workflow: '{{wf_name}}' },
        content_key: 'design_reasoning',
        tags: ['schema'],
        priority: 2,
      },
    };
    const localState = {
      input: { domain: 'recipes' },
      wf_name: 'add_recipe',
      design_reasoning: 'The table stores recipe metadata.',
    };
    const row = buildMemoryRow(step, localState);
    assert.equal(row.scope.domain, 'recipes');
    assert.equal(row.scope.workflow, 'add_recipe');
    assert.equal(row.memory_type, 'semantic');
    assert.equal(row.content, 'The table stores recipe metadata.');
    assert.deepEqual(row.tags, ['schema']);
    assert.equal(row.priority, 2);
  });

  it('computes token_estimate as Math.ceil(content.length / 4)', () => {
    const content = 'a'.repeat(100);
    const step = {
      input: { memory_type: 'episodic', scope: {}, content_key: 'my_content' },
    };
    const row = buildMemoryRow(step, { my_content: content });
    assert.equal(row.token_estimate, 25);
  });

  it('computes token_estimate rounds up for non-divisible lengths', () => {
    const step = {
      input: { memory_type: 'procedural', scope: {}, content_key: 'txt' },
    };
    const row = buildMemoryRow(step, { txt: 'hello' });
    assert.equal(row.token_estimate, 2);
  });

  it('produces empty content string when content_key is missing from local_state', () => {
    const step = {
      input: { memory_type: 'semantic', scope: {}, content_key: 'nonexistent' },
    };
    const row = buildMemoryRow(step, {});
    assert.equal(row.content, '');
    assert.equal(row.token_estimate, 0);
  });

  it('applies defaults for tags, priority when absent from step input', () => {
    const step = {
      input: { memory_type: 'episodic', scope: {}, content_key: 'val' },
    };
    const row = buildMemoryRow(step, { val: 'x' });
    assert.deepEqual(row.tags, []);
    assert.equal(row.priority, 5);
    assert.equal(row.source_workflow, null);
    assert.equal(row.source_step, null);
  });

  it('passes source_workflow and source_step through to the row', () => {
    const step = {
      input: {
        memory_type: 'procedural',
        scope: {},
        content_key: 'v',
        source_workflow: 'create_domain',
        source_step: '18',
      },
    };
    const row = buildMemoryRow(step, { v: 'some content' });
    assert.equal(row.source_workflow, 'create_domain');
    assert.equal(row.source_step, '18');
  });
});

// ---------------------------------------------------------------------------
// executeCondition — JS expression evaluation path
// ---------------------------------------------------------------------------

describe('executeCondition — JS expression path (no {{ in expression)', () => {
  // Access via runSimulation which exercises the full step executor pipeline.
  // For direct unit testing we exercise runSandboxedExpression (the same
  // sandbox used by the JS eval path) with representative condition expressions.

  it('length === 0 is falsy when array has items', () => {
    const localState = { unmastered_cards: [60, 61, 62] };
    const result = runSandboxedExpression('local_state.unmastered_cards.length === 0', null, localState, 'test');
    assert.equal(Boolean(result), false);
  });

  it('length === 0 is truthy when array is empty', () => {
    const localState = { unmastered_cards: [] };
    const result = runSandboxedExpression('local_state.unmastered_cards.length === 0', null, localState, 'test');
    assert.equal(Boolean(result), true);
  });

  it('compound && expression evaluates correctly', () => {
    const localState = { count: 5, active: true };
    const result = runSandboxedExpression('local_state.count > 3 && local_state.active', null, localState, 'test');
    assert.equal(Boolean(result), true);
  });

  it('comparison against threshold routes correctly', () => {
    const localState = { mastered_count: 10, total_cards: 10 };
    const result = runSandboxedExpression('local_state.mastered_count >= local_state.total_cards', null, localState, 'test');
    assert.equal(Boolean(result), true);
  });

  it('negation of property', () => {
    const localState = { quiz_complete: false };
    const result = runSandboxedExpression('!local_state.quiz_complete', null, localState, 'test');
    assert.equal(Boolean(result), true);
  });
});

// ---------------------------------------------------------------------------
// template-resolver — resolvePath JSONPath bracket notation + resolveInput integration
// ---------------------------------------------------------------------------

describe('resolvePath — JSONPath [*] wildcard field extraction', () => {
  const state = {
    cards: [
      { id: 10, name: 'Alpha', deck_id: 1 },
      { id: 20, name: 'Beta',  deck_id: 1 },
      { id: 30, name: 'Gamma', deck_id: 1 },
    ],
    nested: {
      items: [{ key: 'a' }, { key: 'b' }],
    },
  };

  it('extracts a single field from every array element', () => {
    assert.deepEqual(resolvePath(state, 'cards[*].id'), [10, 20, 30]);
  });

  it('extracts a string field from every array element', () => {
    assert.deepEqual(resolvePath(state, 'cards[*].name'), ['Alpha', 'Beta', 'Gamma']);
  });

  it('works with nested path after wildcard', () => {
    assert.deepEqual(resolvePath(state, 'nested.items[*].key'), ['a', 'b']);
  });

  it('returns undefined when wildcard applied to non-array', () => {
    assert.equal(resolvePath(state, 'nested[*].key'), undefined);
  });

  it('bare wildcard on array returns the array itself', () => {
    assert.deepEqual(resolvePath(state, 'cards[*]'), state.cards);
  });

  it('bracket index [0] accesses first element', () => {
    assert.deepEqual(resolvePath(state, 'cards[0].name'), 'Alpha');
  });
});

describe('resolveInput — null field value passes through as null (serv_insert nullable columns)', () => {
  it('single token resolving to null returns null, not the unresolved token string', () => {
    const state = { current_card: { card_id: 60, next_review_date: null } };
    assert.strictEqual(resolveInput('{{current_card.next_review_date}}', state), null);
  });

  it('row object with null field produces null value, not unresolved string', () => {
    const state = { current_card: { card_id: 60, next_review_date: null } };
    const row = { card_id: '{{current_card.card_id}}', next_review_date: '{{current_card.next_review_date}}' };
    const resolved = resolveInput(row, state);
    assert.strictEqual(resolved.card_id, 60);
    assert.strictEqual(resolved.next_review_date, null);
  });

  it('undefined path still leaves token unresolved', () => {
    const state = { current_card: { card_id: 60 } };
    assert.strictEqual(resolveInput('{{current_card.missing_field}}', state), '{{current_card.missing_field}}');
  });
});

describe('resolveInput — JSONPath wildcard token resolves to array (serv_query in filter)', () => {
  const state = {
    all_cards: [
      { id: 1, front: 'Q1' },
      { id: 2, front: 'Q2' },
      { id: 3, front: 'Q3' },
    ],
  };

  it('{{all_cards[*].id}} single token resolves to array of ids', () => {
    assert.deepEqual(resolveInput('{{all_cards[*].id}}', state), [1, 2, 3]);
  });

  it('filter object with wildcard value produces array suitable for op:in', () => {
    const input = {
      tableName: 'PGD_CardSides',
      filters: [{ op: 'in', value: '{{all_cards[*].id}}', column: 'card_id' }],
    };
    const resolved = resolveInput(input, state);
    assert.deepEqual(resolved.filters[0].value, [1, 2, 3]);
    assert.ok(Array.isArray(resolved.filters[0].value));
  });
});

describe('resolveInput — arithmetic expression in {{}} token', () => {
  const state = { current_card: { card_id: 7, total_reviews: 4 }, offset: 2 };

  it('resolves integer arithmetic and returns native number', () => {
    assert.strictEqual(resolveInput('{{current_card.total_reviews + 1}}', state), 5);
  });

  it('resolves subtraction', () => {
    assert.strictEqual(resolveInput('{{current_card.total_reviews - 1}}', state), 3);
  });

  it('resolves expression using two local_state keys', () => {
    assert.strictEqual(resolveInput('{{current_card.total_reviews + offset}}', state), 6);
  });

  it('interpolates arithmetic result mid-string via resolveTemplate', () => {
    const result = resolveInput('reviewed {{current_card.total_reviews + 1}} times', state);
    assert.strictEqual(result, 'reviewed 5 times');
  });

  it('leaves unresolvable path unchanged (no operators)', () => {
    assert.strictEqual(resolveInput('{{current_card.missing_field}}', state), '{{current_card.missing_field}}');
  });

  it('leaves token unchanged when expression throws', () => {
    assert.strictEqual(resolveInput('{{undefined_var + 1}}', state), '{{undefined_var + 1}}');
  });
});

describe('resolveTemplate — array interpolation', () => {
  it('joins an array of primitives as plain comma-separated values', () => {
    const state = { missing_category_names: ['Dining Out', 'Subscriptions', 'Clothing'] };
    assert.strictEqual(
      resolveTemplate('{{missing_category_names}}', state),
      'Dining Out, Subscriptions, Clothing'
    );
  });

  it('JSON-stringifies each element of an array of objects instead of producing [object Object]', () => {
    const state = {
      budget_rows_with_ids: [
        { category_id: 1, planned_amount: 3300 },
        { category_id: 2, planned_amount: 450 },
      ],
    };
    const result = resolveTemplate('{{budget_rows_with_ids}}', state);
    assert.ok(!result.includes('[object Object]'), `expected no [object Object], got: ${result}`);
    assert.strictEqual(
      result,
      '{"category_id":1,"planned_amount":3300}, {"category_id":2,"planned_amount":450}'
    );
  });
});

describe('resolvePath — variable-based array index [varName]', () => {
  const state = {
    current_subset: [
      { front_text: 'Hello', back_text: 'Hola' },
      { front_text: 'Dog',   back_text: 'Perro' },
      { front_text: 'Cat',   back_text: 'Gato' },
    ],
    subset_index: 1,
  };

  it('resolves array[varName].field using localState variable as numeric index', () => {
    assert.strictEqual(resolvePath(state, 'current_subset[subset_index].front_text'), 'Dog');
  });

  it('resolves to the last element when index points to it', () => {
    const s = { ...state, subset_index: 2 };
    assert.strictEqual(resolvePath(s, 'current_subset[subset_index].back_text'), 'Gato');
  });

  it('returns undefined when variable index is out of bounds', () => {
    const s = { ...state, subset_index: 99 };
    assert.strictEqual(resolvePath(s, 'current_subset[subset_index].front_text'), undefined);
  });

  it('resolveInput resolves full {{arr[var].field}} template token', () => {
    assert.strictEqual(resolveInput('{{current_subset[subset_index].front_text}}', state), 'Dog');
  });
});

describe('L1 static analysis — arithmetic expression and bracket-notation false positives', () => {
  it('does not flag {{subset_index + 1}} as unresolved — arithmetic handled by evalExpression', () => {
    const steps = [
      { step: '1', type: 'js_transform', expression: '0', output_key: 'subset_index', on_success: 'next', on_else: 'end' },
      { step: '2', type: 'notify', message_template: 'Card {{subset_index + 1}} of 10', on_success: 'end', on_else: 'end' },
      { step: '3', type: 'end' },
    ];
    const result = runSimulation({ steps });
    const issues = result.static_analysis.issues.filter(i => i.failure_class === 'unresolved_template_variable');
    assert.strictEqual(issues.length, 0, `Expected no unresolved issues, got: ${JSON.stringify(issues)}`);
  });

  it('does not flag {{current_subset[subset_index].front_text}} as unresolved when base key exists', () => {
    const steps = [
      { step: '1', type: 'js_transform', expression: '[]', output_key: 'current_subset', on_success: 'next', on_else: 'end' },
      { step: '2', type: 'js_transform', expression: '0',  output_key: 'subset_index',   on_success: 'next', on_else: 'end' },
      { step: '3', type: 'notify', message: '{{current_subset[subset_index].front_text}}', on_success: 'end', on_else: 'end' },
      { step: '4', type: 'end' },
    ];
    const result = runSimulation({ steps });
    const issues = result.static_analysis.issues.filter(i => i.failure_class === 'unresolved_template_variable');
    assert.strictEqual(issues.length, 0, `Expected no unresolved issues, got: ${JSON.stringify(issues)}`);
  });

  it('still flags genuinely missing base key', () => {
    const steps = [
      { step: '1', type: 'notify', message_template: '{{missing_key.field}}', on_success: 'end', on_else: 'end' },
      { step: '2', type: 'end' },
    ];
    const result = runSimulation({ steps });
    const issues = result.static_analysis.issues.filter(i => i.failure_class === 'unresolved_template_variable');
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0].detail, /missing_key/);
  });
});

// ---------------------------------------------------------------------------
// resolveGateOptions — one resolver for rendering AND for matching the answer back
// ---------------------------------------------------------------------------

describe('resolveGateOptions', () => {
  // Live workflow 353 (edit_budget) step 5. resumeGate used to match the user's answer
  // against step.options RAW, where the value is still "{{year}}-{{month}}" — so it could
  // never match the "2026-07" that came back, and silently fell through to 'next'.
  const step = {
    step: '5', type: 'human_gate', gate_type: 'choice',
    options: [
      { label: '{{label}}', value: '{{year}}-{{month}}', iterator: 'month_summary',
        on_select: 'next', description: 'Net: {{net_cash_flow}}' },
      { label: 'Cancel', value: 'cancel', on_select: 'cancel', description: 'Exit' },
    ],
  };
  const localState = {
    month_summary: [
      { year: '2026', month: '07', label: '07/2026', net_cash_flow: 250 },
      { year: '2026', month: '06', label: '06/2026', net_cash_flow: -80 },
    ],
  };

  it('expands an iterator option into one resolved option per row', () => {
    const opts = resolveGateOptions(step, localState);
    assert.equal(opts.length, 3, 'two months plus Cancel');
    assert.deepEqual(opts.map(o => o.value), ['2026-07', '2026-06', 'cancel']);
    assert.deepEqual(opts.map(o => o.label), ['07/2026', '06/2026', 'Cancel']);
  });

  it('resolves the value the user actually picks — so resumeGate can match it', () => {
    const opts = resolveGateOptions(step, localState);
    const picked = opts.find(o => o.value === '2026-07');
    assert.ok(picked, 'the answer coming back from Slack must find its option');
    assert.equal(picked.on_select, 'next', 'and carry that option\'s routing');
  });

  it('resolves per-row tokens in a description', () => {
    const opts = resolveGateOptions(step, localState);
    assert.equal(opts[0].description, 'Net: 250');
    assert.equal(opts[1].description, 'Net: -80');
  });

  it('leaves a plain options array alone', () => {
    const plain = { options: [{ label: 'Yes', action: 'confirm', on_select: 'next' }] };
    assert.deepEqual(resolveGateOptions(plain, {}).map(o => o.action), ['confirm']);
  });

  it('an iterator naming a missing array contributes nothing', () => {
    assert.deepEqual(resolveGateOptions(step, {}).map(o => o.value), ['cancel']);
  });
});

// ---------------------------------------------------------------------------
// resolveDisplayText — the one string in the gate payload nobody resolved
//
// Run 776, workflow 358 step 4: button_label "View items ({{parsed_receipt.items.length}})"
// reached Slack verbatim. `content` was resolved on the same object, and a gate option's
// label/value/description are resolved immediately above — so this was an omission, not a
// decision. `.length` on an array has always been supported by the resolver; nothing ever
// handed it the string.
// ---------------------------------------------------------------------------

describe('resolveDisplayText', () => {
  const localState = { parsed_receipt: { items: [{ n: 1 }, { n: 2 }, { n: 3 }], store_name: 'ALDI' } };

  it('resolves a .length token — the run 776 case', () => {
    assert.equal(
      resolveDisplayText('View items ({{parsed_receipt.items.length}})', localState),
      'View items (3)'
    );
  });

  it('resolves a plain value token', () => {
    assert.equal(resolveDisplayText('Receipt from {{parsed_receipt.store_name}}', localState), 'Receipt from ALDI');
  });

  it('leaves a label with no tokens exactly as written', () => {
    assert.equal(resolveDisplayText('🆕 New items', localState), '🆕 New items');
  });

  it('passes an absent label through untouched, so the renderer default still applies', () => {
    // Defaulting to '' here would send Slack an empty plain_text, which it rejects
    // outright — the same failure class as the empty container in run 774.
    assert.equal(resolveDisplayText(undefined, localState), undefined);
    assert.equal(resolveDisplayText(null, localState), null);
    assert.equal(resolveDisplayText('', localState), '');
  });
});

describe('buildDialog — reveal labels resolve on the real gate path', () => {
  const localState = { parsed_receipt: { items: [{ n: 1 }, { n: 2 }] } };

  it('resolves button_label on a reveals[] entry alongside its content', () => {
    const step = {
      step: '4', type: 'human_gate', gate_type: 'confirm',
      message_template: 'Review',
      reveals: [{ content: '{{parsed_receipt.items}}', button_label: 'View items ({{parsed_receipt.items.length}})' }],
      options: [{ label: 'Approve', action: 'confirm', on_select: 'next' }],
    };
    const reveal = buildDialog(step, localState).fields.find(f => f.type === 'reveal');
    assert.equal(reveal.button_label, 'View items (2)');
    assert.equal(reveal.content.length, 2, 'content still resolves to the array itself');
  });

  it('resolves a list row\'s item_action label against that row', () => {
    // Per-item context, like confirm_template beside it — the label is what makes a row's
    // button say what it acts on, so a shared localState-only resolve would be wrong.
    const step = {
      step: '2', type: 'human_gate', gate_type: 'list_selection',
      message_template: 'Pick one',
      context_key: 'rows',
      item_action: { action: 'select', label: 'Open {{item.name}}', on_select: 'next' },
      options: [{ label: 'Cancel', action: 'cancel', on_select: 'cancel' }],
    };
    const state = { rows: [{ id: 1, name: 'Aisle A' }, { id: 2, name: 'Aisle B' }] };
    const list  = buildDialog(step, state).fields.find(f => f.type === 'list');
    assert.deepEqual(list.items.map(i => i.secondaryAction.label), ['Open Aisle A', 'Open Aisle B']);
  });

  it('resolves a text_input label and placeholder', () => {
    const step = {
      step: '3', type: 'human_gate', gate_type: 'text_input',
      message_template: 'Notes',
      input_label:  'Notes for {{store}}',
      placeholder:  'e.g. {{example}}',
      options: [{ label: 'Submit', action: 'confirm', on_select: 'next' }],
    };
    const box = buildDialog(step, { store: 'ALDI', example: 'damaged tin' })
      .fields.find(f => f.type === 'textbox');
    assert.equal(box.label, 'Notes for ALDI');
    assert.equal(box.placeholder, 'e.g. damaged tin');
  });

  it('resolves special_buttons labels without re-resolving already-resolved options', () => {
    // expandedOptions come back from resolveGateOptions already resolved. Running the
    // combined list through a second pass would re-resolve user data containing braces.
    const step = {
      step: '4', type: 'human_gate', gate_type: 'confirm',
      message_template: 'Go?',
      options: [{ label: '{{verb}} it', action: 'confirm', on_select: 'next' }],
      special_buttons: [{ label: 'Skip {{count}} items', action: 'skip', description: '{{count}} left' }],
    };
    const buttons = buildDialog(step, { verb: 'Apply', count: 3 })
      .fields.find(f => f.type === 'actions').buttons;
    assert.deepEqual(buttons.map(b => b.label), ['Apply it', 'Skip 3 items']);
    assert.equal(buttons[1].description, '3 left');
  });

  it('leaves a literal {{ in resolved user data alone — no second pass', () => {
    // A product genuinely named with braces must survive. It reaches the payload through
    // an already-resolved option, so nothing may look at it again.
    const step = {
      step: '5', type: 'human_gate', gate_type: 'confirm',
      message_template: 'Go?',
      options: [{ label: '{{odd_name}}', action: 'confirm', on_select: 'next' }],
      special_buttons: [{ label: 'Cancel', action: 'cancel' }],
    };
    const buttons = buildDialog(step, { odd_name: 'Sauce {{spicy}}' })
      .fields.find(f => f.type === 'actions').buttons;
    assert.equal(buttons[0].label, 'Sauce {{spicy}}');
  });

  it('item_label_template resolves through the shared resolver, not a private regex', () => {
    // Live shape (create_workflow step 24): single-word keys against each element.
    const step = {
      step: '6', type: 'human_gate', gate_type: 'review_object',
      message_template: 'Review',
      context_key: 'draft.steps',
      item_label_template: 'Step {{step}} ({{type}}): {{description}}',
      item_secondary_key: 'on_success',
      options: [{ label: 'OK', action: 'confirm', on_select: 'next' }],
    };
    const state = { draft: { steps: [
      { step: '1', type: 'llm_call', description: 'Parse it', on_success: 'next' },
    ] } };
    const list = buildDialog(step, state).fields.find(f => f.type === 'review_object');
    assert.equal(list.items[0].key, 'Step 1 (llm_call): Parse it');
  });

  it('item_label_template now accepts dotted paths and .length, which the old regex could not', () => {
    const step = {
      step: '6', type: 'human_gate', gate_type: 'review_object',
      message_template: 'Review',
      context_key: 'draft.tables',
      item_label_template: '{{tableName}} — {{columns.length}} cols, owner {{meta.owner}}',
      item_secondary_key: 'columns',
      options: [{ label: 'OK', action: 'confirm', on_select: 'next' }],
    };
    const state = { draft: { tables: [
      { tableName: 'PGD_Thing', columns: [{ name: 'a' }, { name: 'b' }], meta: { owner: 'ops' } },
    ] } };
    const list = buildDialog(step, state).fields.find(f => f.type === 'review_object');
    assert.equal(list.items[0].key, 'PGD_Thing — 2 cols, owner ops');
  });

  it('resolves button_label on the singular reveal too', () => {
    const step = {
      step: '4', type: 'human_gate', gate_type: 'confirm',
      message_template: 'Review',
      reveal: { content: '{{parsed_receipt.items}}', button_label: '{{parsed_receipt.items.length}} items' },
      options: [{ label: 'Approve', action: 'confirm', on_select: 'next' }],
    };
    const reveal = buildDialog(step, localState).fields.find(f => f.type === 'reveal');
    assert.equal(reveal.button_label, '2 items');
  });
});

// ---------------------------------------------------------------------------
// A cancel-action option that routes elsewhere must NOT cancel the run
// ---------------------------------------------------------------------------

describe('cancel option routing — on_select wins over the action name', () => {
  // Live workflow 353 (edit_budget) step 16. The routing rules require every gate to carry
  // an option with action "cancel", but nothing says that option must exit: this one is
  // labelled "Edit More" and routes back to the category picker. resumeGate used to cancel
  // the run on the action name alone, so "Edit More" killed the workflow.
  //
  // resumeGate is not exported (SQS handler module), so this pins the decision resumeGate
  // makes — the same expression, over the real option shape.
  const options = [
    { label: 'Save Budget', action: 'confirm', on_select: 'next' },
    { label: 'Edit More',   action: 'cancel',  on_select: '11'   },
  ];
  const routesAway = opts => {
    const cancelOption = opts.find(o => o.action === 'cancel');
    return !!(cancelOption?.on_select && cancelOption.on_select !== 'cancel');
  };

  it('a cancel-action option pointing at a step routes there instead of cancelling', () => {
    assert.equal(routesAway(options), true);
    assert.equal(options.find(o => o.action === 'cancel').on_select, '11');
  });

  it('an ordinary Cancel option still cancels', () => {
    assert.equal(routesAway([
      { label: 'Save',   action: 'confirm', on_select: 'next'   },
      { label: 'Cancel', action: 'cancel',  on_select: 'cancel' },
    ]), false);
  });

  it('a cancel option with no on_select still cancels', () => {
    assert.equal(routesAway([{ label: 'Cancel', action: 'cancel' }]), false);
  });
});

// ---------------------------------------------------------------------------
// resolveOptionSource — where a gate's option set came from
// ---------------------------------------------------------------------------
//
// The property the renderer needs and could not have: buildDialog expands `iterator`
// and strips it, so callback.mjs saw only a count and could not tell a fixed rating
// scale from a twelve-month picker. This states the fact; the widget stays the
// experience layer's call.

describe('resolveOptionSource', () => {
  it('reads an inline option list as static', () => {
    assert.equal(resolveOptionSource({
      gate_type: 'choice',
      options: [
        { value: '0', label: 'A', on_select: 'next' },
        { value: '1', label: 'B', on_select: 'next' },
        { label: 'Cancel', action: 'cancel', on_select: 'cancel' },
      ],
    }), 'static');
  });

  it('reads an option carrying iterator as dynamic', () => {
    assert.equal(resolveOptionSource({
      gate_type: 'choice',
      options: [
        { value: '{{value}}', label: '{{label}}', iterator: 'period_options', on_select: 'next' },
        { label: 'Cancel', action: 'cancel', on_select: 'cancel' },
      ],
    }), 'dynamic');
  });

  it('reads a templated option list as dynamic — the entries come from local_state either way', () => {
    assert.equal(resolveOptionSource({ gate_type: 'choice', options: '{{card_options}}' }), 'dynamic');
  });

  it('an explicit declaration overrides the inference in both directions', () => {
    assert.equal(resolveOptionSource({
      option_source: 'static',
      options: [{ value: '{{v}}', label: '{{l}}', iterator: 'rows' }],
    }), 'static');
    assert.equal(resolveOptionSource({
      option_source: 'dynamic',
      options: [{ value: '0', label: 'A' }],
    }), 'dynamic');
  });

  it('ignores an unrecognised declaration and falls back to the inference', () => {
    assert.equal(resolveOptionSource({
      option_source: 'dropdown',
      options: [{ value: '{{v}}', label: '{{l}}', iterator: 'rows' }],
    }), 'dynamic');
  });

  it('reads a gate with no options at all as static', () => {
    assert.equal(resolveOptionSource({ gate_type: 'form' }), 'static');
  });

  it('buildDialog carries the resolved source on the dialog it returns', () => {
    const staticSet = buildDialog({
      gate_type: 'choice',
      message_template: 'How well did you recall it?',
      options: [
        { value: '0', label: 'A', description: 'Total blackout', on_select: 'next' },
        { value: '5', label: 'F', description: 'Perfect recall',  on_select: 'next' },
        { label: 'Cancel', action: 'cancel', on_select: 'cancel' },
      ],
    }, {});
    assert.equal(staticSet.option_source, 'static');

    const dynamicSet = buildDialog({
      gate_type: 'choice',
      message_template: 'Which period?',
      options: [
        { value: '{{period}}', label: '{{period}}', iterator: 'period_options', on_select: 'next' },
        { label: 'Cancel', action: 'cancel', on_select: 'cancel' },
      ],
    }, { period_options: [{ period: '2026-06' }, { period: '2026-07' }] });
    assert.equal(dynamicSet.option_source, 'dynamic');
  });
});
