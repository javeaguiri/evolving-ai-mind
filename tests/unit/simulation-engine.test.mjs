// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/simulation-engine.test.mjs
//
// Unit tests for the L2b data-flow trace (Track I, Sprint 7) — validates that
// resolved step-input shapes (filters, updates, row/rows, items_key,
// context_key) are checked against the same contracts table.mjs enforces at
// runtime, catching mismatches at create time instead of on first execution.
//
// Reproduces the run 623 bug class: a js_transform building a nested
// per-record filter-group array fed straight into a downstream serv_query's
// filters field, which only accepts a flat array of {column, op, value}.
//
// Run: node --test tests/unit/simulation-engine.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../../src/proc/simulation-engine.mjs';

describe('L2b data-flow trace — serv_query.filters shape (run 623 reproduction)', () => {
  it('flags a nested array-of-filter-groups fed into serv_query.filters', () => {
    const steps = [
      {
        step: '1', type: 'serv_query',
        input: { tableName: 'PGD_Records' },
        on_success: 'next', on_else: 'cancel',
        output_key: 'records',
      },
      {
        step: '2', type: 'js_transform',
        input_key: 'records',
        expression: `items.map(function(r){ return [{ column: 'year', op: 'eq', value: r.year }, { column: 'category_id', op: 'eq', value: r.category_id }]; })`,
        on_success: 'next',
        output_key: 'bad_filters',
      },
      {
        step: '3', type: 'serv_query',
        input: { tableName: 'PGD_Budgets', filters: '{{bad_filters}}' },
        on_success: 'next', on_else: 'cancel',
        output_key: 'existing_rows',
      },
      { step: 'end', type: 'end' },
    ];

    const result = runSimulation({ steps, mockOutputs: null, simulationPaths: null, runInput: {} });

    assert.equal(result.smoke_test.passed, false, 'smoke test must fail on nested filter-group shape');
    assert.equal(result.passed, false, 'overall simulation must fail');

    const issue = result.smoke_test.issues.find(
      i => i.failure_class === 'serv_input_shape_mismatch' && i.step === '3'
    );
    assert.ok(issue, `expected a serv_input_shape_mismatch issue on step 3; got: ${JSON.stringify(result.smoke_test.issues)}`);
  });

  it('does not flag a correctly flattened filter array', () => {
    const steps = [
      {
        step: '1', type: 'serv_query',
        input: { tableName: 'PGD_Records' },
        on_success: 'next', on_else: 'cancel',
        output_key: 'records',
      },
      {
        step: '2', type: 'js_transform',
        input_key: 'records',
        expression: `items.reduce(function(acc, r){ return acc.concat([{ column: 'year', op: 'eq', value: r.year }, { column: 'category_id', op: 'eq', value: r.category_id }]); }, [])`,
        on_success: 'next',
        output_key: 'good_filters',
      },
      {
        step: '3', type: 'serv_query',
        input: { tableName: 'PGD_Budgets', filters: '{{good_filters}}' },
        on_success: 'next', on_else: 'cancel',
        output_key: 'existing_rows',
      },
      { step: 'end', type: 'end' },
    ];

    const result = runSimulation({ steps, mockOutputs: null, simulationPaths: null, runInput: {} });

    assert.equal(result.smoke_test.passed, true, `smoke test must pass; issues: ${JSON.stringify(result.smoke_test.issues)}`);
  });
});

describe('L2b data-flow trace — inconclusive upstream data suppresses downstream cascade', () => {
  it('does not flag a downstream shape mismatch when the upstream js_transform threw against mock data', () => {
    // Simulates a flat-loop-pattern step (e.g. per-round accumulator state that
    // only makes sense after many real loop iterations) that a single-pass
    // smoke test cannot meaningfully mock — the expression throws because
    // round_state was never seeded, not because the workflow is broken.
    const steps = [
      {
        step: '1', type: 'js_transform',
        expression: `local_state.round_state.cards_remaining.map(function(c){ return { id: c.id }; })`,
        on_success: 'next',
        output_key: 'round_summary',
      },
      {
        step: '2', type: 'serv_upsert',
        input: {
          tableName:    'PGD_QuizResults',
          matchColumns: ['card_id'],
          rows:         '{{round_summary}}',
        },
        on_success: 'next', on_else: 'cancel',
        output_key: 'upserted',
      },
      { step: 'end', type: 'end' },
    ];

    const result = runSimulation({ steps, mockOutputs: null, simulationPaths: null, runInput: {} });

    const upstreamIssue = result.smoke_test.issues.find(
      i => i.failure_class === 'js_transform_runtime_error' && i.step === '1'
    );
    assert.ok(upstreamIssue, 'expected the upstream runtime error to still be reported');
    assert.equal(upstreamIssue.severity, 'warning');

    const cascadedIssue = result.smoke_test.issues.find(
      i => i.failure_class === 'serv_input_shape_mismatch' && i.step === '2'
    );
    assert.equal(cascadedIssue, undefined, `downstream shape check must be suppressed when upstream is inconclusive; got: ${JSON.stringify(result.smoke_test.issues)}`);

    assert.equal(result.smoke_test.passed, true, 'a soft upstream warning with no confirmed downstream defect must not fail the smoke test');
  });
});

describe('L2b data-flow trace — serv_update.updates shape', () => {
  it('flags an array resolved into updates (must be a plain object)', () => {
    const steps = [
      {
        step: '1', type: 'js_transform',
        expression: `[1, 2, 3]`,
        on_success: 'next',
        output_key: 'bad_updates',
      },
      {
        step: '2', type: 'serv_update',
        input: {
          tableName: 'PGD_Budgets',
          filters: [{ column: 'id', op: 'eq', value: 1 }],
          updates: '{{bad_updates}}',
        },
        on_success: 'next', on_else: 'cancel',
        output_key: 'updated',
      },
      { step: 'end', type: 'end' },
    ];

    const result = runSimulation({ steps, mockOutputs: null, simulationPaths: null, runInput: {} });

    assert.equal(result.smoke_test.passed, false, 'smoke test must fail when updates resolves to an array');
    const issue = result.smoke_test.issues.find(
      i => i.failure_class === 'serv_input_shape_mismatch' && i.step === '2'
    );
    assert.ok(issue, `expected a serv_input_shape_mismatch issue on step 2; got: ${JSON.stringify(result.smoke_test.issues)}`);
  });
});

describe('L2b data-flow trace — serv_upsert.rows / matchColumns shape', () => {
  it('flags rows resolving to an array of non-objects', () => {
    const steps = [
      {
        step: '1', type: 'js_transform',
        expression: `[1, 2, 3]`,
        on_success: 'next',
        output_key: 'bad_rows',
      },
      {
        step: '2', type: 'serv_upsert',
        input: {
          tableName:    'PGD_Budgets',
          matchColumns: ['year', 'month', 'category_id'],
          rows:         '{{bad_rows}}',
        },
        on_success: 'next', on_else: 'cancel',
        output_key: 'upserted',
      },
      { step: 'end', type: 'end' },
    ];

    const result = runSimulation({ steps, mockOutputs: null, simulationPaths: null, runInput: {} });

    assert.equal(result.smoke_test.passed, false, 'smoke test must fail when rows resolves to non-object array');
    const issue = result.smoke_test.issues.find(
      i => i.failure_class === 'serv_input_shape_mismatch' && i.step === '2'
    );
    assert.ok(issue, `expected a serv_input_shape_mismatch issue on step 2; got: ${JSON.stringify(result.smoke_test.issues)}`);
  });

  it('does not flag a correctly shaped rows/matchColumns pair', () => {
    const steps = [
      {
        step: '1', type: 'js_transform',
        expression: `[{ year: 2026, month: 7, category_id: 3, planned_amount: 100 }]`,
        on_success: 'next',
        output_key: 'good_rows',
      },
      {
        step: '2', type: 'serv_upsert',
        input: {
          tableName:    'PGD_Budgets',
          matchColumns: ['year', 'month', 'category_id'],
          rows:         '{{good_rows}}',
        },
        on_success: 'next', on_else: 'cancel',
        output_key: 'upserted',
      },
      { step: 'end', type: 'end' },
    ];

    const result = runSimulation({ steps, mockOutputs: null, simulationPaths: null, runInput: {} });

    assert.equal(result.smoke_test.passed, true, `smoke test must pass; issues: ${JSON.stringify(result.smoke_test.issues)}`);
  });
});

describe('L2b data-flow trace — iterator.items_key is a soft warning', () => {
  it('flags a non-array items_key but does not fail the smoke test', () => {
    const steps = [
      {
        step: '1', type: 'js_transform',
        expression: `({ not: 'an array' })`,
        on_success: 'next',
        output_key: 'bad_items',
      },
      {
        step: '2', type: 'iterator',
        items_key:      'bad_items',
        item_step:      { type: 'serv_query', input: { tableName: 'PGD_Records' } },
        output_key:     'iter_results',
        execution_mode: 'sequential',
        on_complete:    'next',
      },
      { step: 'end', type: 'end' },
    ];

    const result = runSimulation({ steps, mockOutputs: null, simulationPaths: null, runInput: {} });

    const issue = result.smoke_test.issues.find(
      i => i.failure_class === 'serv_input_shape_mismatch' && i.step === '2'
    );
    assert.ok(issue, `expected a serv_input_shape_mismatch warning on step 2; got: ${JSON.stringify(result.smoke_test.issues)}`);
    assert.equal(issue.severity, 'warning', 'items_key shape issue must be a soft warning');
    assert.equal(result.smoke_test.passed, true, 'a warning-only issue must not fail the smoke test');
  });
});

// ---------------------------------------------------------------------------
// Skeleton drift — translation must not invent steps (the A8 lock)
// ---------------------------------------------------------------------------

describe('runSimulation — skeleton drift', () => {
  // Run 702's real shape: a 15-item design (5 js_transform) translated into 20 steps
  // (10 js_transform). The five extra "format X for display" transforms were invented
  // at translation time, so they were never in the graph the skeleton validated and
  // never seen by the consolidation critic.
  const skeleton = [
    { step: 'load_rows',    type: 'serv_query'   },
    { step: 'build_view',   type: 'js_transform' },
    { step: 'show_gate',    type: 'human_gate'   },
    { step: 'end',          type: 'end'          },
  ];

  it('flags steps translation invented, naming what was added', () => {
    const drifted = [
      { step: '1', type: 'serv_query',   on_success: 'next' },
      { step: '2', type: 'js_transform', on_success: 'next' },
      { step: '3', type: 'js_transform', on_success: 'next' },   // invented — "format for display"
      { step: '4', type: 'human_gate',   on_success: 'next',
        options: [{ label: 'OK', action: 'confirm', on_select: 'next' },
                  { label: 'Cancel', action: 'cancel', on_select: 'cancel' }],
        on_cancel: 'cancel', message_template: 'x' },
      { step: '5', type: 'end' },
    ];
    const result = runSimulation({ steps: drifted, lockedSkeleton: skeleton, traceId: 't' });

    assert.equal(result.passed, false);
    const drift = result.static_analysis.issues.find(i => i.check === 'skeleton_drift');
    assert.ok(drift, 'an invented step must be caught');
    assert.match(drift.detail, /1× js_transform/, 'names what was added, so the retry can act on it');
  });

  it('passes an honest 1:1 translation', () => {
    const faithful = [
      { step: '1', type: 'serv_query',   on_success: 'next' },
      { step: '2', type: 'js_transform', on_success: 'next' },
      { step: '3', type: 'human_gate',   on_success: 'next',
        options: [{ label: 'OK', action: 'confirm', on_select: 'next' },
                  { label: 'Cancel', action: 'cancel', on_select: 'cancel' }],
        on_cancel: 'cancel', message_template: 'x' },
      { step: '4', type: 'end' },
    ];
    const result = runSimulation({ steps: faithful, lockedSkeleton: skeleton, traceId: 't' });
    assert.equal(result.static_analysis.issues.filter(i => i.check === 'skeleton_drift').length, 0);
  });

  it('tolerates the skeleton builder appending its own end step', () => {
    // 21a pushes an `end` even when the design already declared one — so end steps are
    // ignored in the comparison. Without that, every honest translation would false-positive.
    const doubleEnd = [...skeleton, { step: 'end', type: 'end' }];
    const faithful  = [
      { step: '1', type: 'serv_query',   on_success: 'next' },
      { step: '2', type: 'js_transform', on_success: 'next' },
      { step: '3', type: 'human_gate',   on_success: 'next',
        options: [{ label: 'OK', action: 'confirm', on_select: 'next' },
                  { label: 'Cancel', action: 'cancel', on_select: 'cancel' }],
        on_cancel: 'cancel', message_template: 'x' },
      { step: '4', type: 'end' },
    ];
    const result = runSimulation({ steps: faithful, lockedSkeleton: doubleEnd, traceId: 't' });
    assert.equal(result.static_analysis.issues.filter(i => i.check === 'skeleton_drift').length, 0);
  });

  it('is inert when no skeleton is supplied', () => {
    const result = runSimulation({ steps: [{ step: '1', type: 'end' }], traceId: 't' });
    assert.equal(result.static_analysis.issues.filter(i => i.check === 'skeleton_drift').length, 0);
  });
});

// ---------------------------------------------------------------------------
// error_summary — the single rendering of why a simulation failed.
//
// Run 709 reproduction: create_workflow step 26 kept its OWN list of hard
// failure classes and never learned about serv_input_shape_mismatch (added to
// the engine by Track I). A real data-flow failure was therefore reported to
// the user as "Validation failed - no specific issues reported", and the
// regeneration loop — which is fed the same summary — was handed nothing to
// fix. The engine now emits the summary itself and stamps `hard` on each
// issue, so no consumer can hold a second, staler opinion.
// ---------------------------------------------------------------------------

describe('runSimulation — error_summary', () => {
  const upsertShapeMismatch = [
    {
      step: '1', type: 'js_transform',
      expression: `({ budget_rows: [], totals: { income: 0 } })`,
      on_success: 'next', output_key: 'payload',
    },
    {
      step: '2', type: 'serv_upsert',
      input: { tableName: 'PGD_Budgets', matchColumns: ['year'], rows: '{{payload}}' },
      on_success: 'next', on_else: 'cancel', output_key: 'written',
    },
    { step: '3', type: 'end' },
  ];

  it('reports a serv_input_shape_mismatch instead of falling silent (run 709)', () => {
    const result = runSimulation({ steps: upsertShapeMismatch, traceId: 't' });

    assert.equal(result.passed, false);
    // The bug: passed:false with nothing to show for it.
    assert.notEqual(result.error_summary, '');
    assert.match(result.error_summary, /data-flow/);
    assert.match(result.error_summary, /Step "?2"?/);
  });

  it('stamps hard on gating issues so no consumer re-derives the predicate', () => {
    const result = runSimulation({ steps: upsertShapeMismatch, traceId: 't' });
    const gating = result.smoke_test.issues.filter(i => i.hard);

    assert.equal(gating.length, 1);
    assert.equal(gating[0].failure_class, 'serv_input_shape_mismatch');
    // passed is derived from the same stamp the summary reads.
    assert.equal(result.smoke_test.passed, gating.length === 0);
  });

  it('excludes soft warnings — they never block, so they are not why it failed', () => {
    const steps = [
      {
        step: '1', type: 'js_transform',
        expression: `({ not: 'an array' })`,
        on_success: 'next', output_key: 'bad_items',
      },
      {
        step: '2', type: 'iterator',
        items_key:      'bad_items',
        item_step:      { type: 'serv_query', input: { tableName: 'PGD_Records' } },
        output_key:     'iter_results',
        execution_mode: 'sequential',
        on_complete:    'next',
      },
      { step: 'end', type: 'end' },
    ];
    const result = runSimulation({ steps, traceId: 't' });
    const soft = result.smoke_test.issues.filter(i => !i.hard);

    assert.ok(soft.length > 0, 'expected at least one soft warning');
    assert.equal(result.smoke_test.passed, true, 'soft warnings must not gate');
    assert.equal(result.error_summary, '', 'soft warnings must not appear as failure reasons');
  });

  it('renders L1 static analysis failures', () => {
    const steps = [
      { step: '1', type: 'js_transform', expression: `1`, on_success: 'nowhere', output_key: 'x' },
      { step: '2', type: 'end' },
    ];
    const result = runSimulation({ steps, traceId: 't' });

    assert.equal(result.passed, false);
    assert.match(result.error_summary, /Step "?1"?/);
  });

  it('is empty when the simulation passes', () => {
    const steps = [
      { step: '1', type: 'js_transform', expression: `1`, on_success: 'next', output_key: 'x' },
      { step: '2', type: 'end' },
    ];
    const result = runSimulation({ steps, traceId: 't' });

    assert.equal(result.passed, true);
    assert.equal(result.error_summary, '');
  });
});

// ---------------------------------------------------------------------------
// action_key — a gate's outcome must be readable downstream (run 719).
//
// A `form` gate's output_key holds the FIELD VALUES; which button was pressed was
// used for routing and then discarded. So a save-and-continue loop was undesignable:
// "Update" and "Done" must run the SAME write and diverge only afterwards, which means
// the decision has to survive the write. The designer wrote {{edit_action}} and noted it
// was "tracked via a hidden mechanism or gate action value" — it knew exactly what it
// needed, and the harness did not have it. L1 correctly rejected the workflow.
// ---------------------------------------------------------------------------

// A gate past the field ceiling cannot be rendered at all — the run wedges waiting for
// a message that was never posted. Before this check the only detection was at runtime,
// with a user already waiting; run 719 shipped a 63-field form (21 rows x 3 fields, two
// of the three never requested) and was found that way.
describe('L1 — gate size', () => {
  const formGate = fields => [
    {
      step: '1', type: 'human_gate', gate_type: 'form',
      message_template: 'Edit them all', fields, output_key: 'edits',
      options: [
        { label: 'Save',   action: 'save',   on_select: 'next' },
        { label: 'Cancel', action: 'cancel', on_select: 'cancel' },
      ],
      on_cancel: 'cancel', on_success: 'next',
    },
    { step: '2', type: 'end' },
  ];
  const nFields = n =>
    Array.from({ length: n }, (_, i) => ({ name: `f_${i}`, type: 'text', label: `Field ${i}` }));

  const sizeIssue = steps =>
    runSimulation({ steps, traceId: 't' })
      .static_analysis.issues.find(i => i.check === 'gate_too_many_fields');

  it('rejects a form that declares more fields than one gate can present (run 719)', () => {
    const issue = sizeIssue(formGate(nFields(63)));
    assert.ok(issue, 'a 63-field form must be caught before registration');
    assert.match(issue.detail, /63 fields/);
    assert.match(issue.detail, /picks ONE record/i, 'the fix must be named, not just the fault');
    assert.equal(issue.step, '1');
  });

  it('accepts a form at the ceiling — the limit is inclusive', () => {
    assert.equal(sizeIssue(formGate(nFields(40))), undefined);
  });

  it('accepts an ordinary small form', () => {
    assert.equal(sizeIssue(formGate(nFields(3))), undefined);
  });

  it('skips a {{template}} fields reference rather than guessing its length', () => {
    // Built by a preceding js_transform — the count is unknowable at L1, and a guess
    // here would either false-positive or give false assurance.
    assert.equal(sizeIssue(formGate('{{edit_fields}}')), undefined);
  });

  it('does not fire in skeleton mode, where fields are not yet designed', () => {
    const result = runSimulation({ steps: formGate(nFields(63)), skeleton: true, traceId: 't' });
    assert.equal(
      result.static_analysis.issues.find(i => i.check === 'gate_too_many_fields'),
      undefined,
    );
  });
});

describe('L1 state flow — action_key records the gate outcome', () => {
  // Run 719's shape: form gate -> transform -> upsert -> condition on the button pressed.
  const saveAndContinueLoop = actionKey => [
    { step: '1', type: 'serv_query', input: { tableName: 'PGD_Budgets' }, on_success: 'next', on_else: 'cancel', output_key: 'budgets' },
    {
      step: '2', type: 'human_gate', gate_type: 'form',
      message_template: 'Edit the budget',
      fields: [{ name: 'amount_1', type: 'text', label: 'Groceries' }],
      output_key: 'budget_edits',
      ...(actionKey ? { action_key: 'edit_action' } : {}),
      options: [
        { label: 'Save',   action: 'save',   on_select: 'next' },
        { label: 'Done',   action: 'done',   on_select: 'next' },
        { label: 'Cancel', action: 'cancel', on_select: 'cancel' },
      ],
      on_cancel: 'cancel', on_success: 'next',
    },
    { step: '3', type: 'js_transform', expression: `[{ id: 1 }]`, on_success: 'next', output_key: 'rows' },
    { step: '4', type: 'serv_upsert', input: { tableName: 'PGD_Budgets', matchColumns: ['id'], rows: '{{rows}}' }, on_success: 'next', on_else: 'cancel', output_key: 'written' },
    { step: '5', type: 'condition', expression: `{{edit_action}}`, on_success: '2', on_else: '6' },
    { step: '6', type: 'end' },
  ];

  it('rejects the gate outcome being read when no action_key declares it (run 719)', () => {
    const result = runSimulation({ steps: saveAndContinueLoop(false), traceId: 't' });
    const issue  = result.static_analysis.issues.find(i => /edit_action/.test(i.detail ?? ''));

    assert.ok(issue, 'reading a key nothing writes must be caught');
    assert.match(issue.detail, /has not been written by any prior step/);
  });

  it('accepts it once the gate declares action_key', () => {
    const result = runSimulation({ steps: saveAndContinueLoop(true), traceId: 't' });
    const issue  = result.static_analysis.issues.find(i => /edit_action/.test(i.detail ?? ''));

    assert.equal(issue, undefined,
      `action_key must register as a write; got: ${JSON.stringify(result.static_analysis.issues)}`);
    assert.equal(result.passed, true);
  });

  it('mocks action_key from the gate\'s own first option, so L2b can resolve it', () => {
    const steps = [
      ...saveAndContinueLoop(true).slice(0, 5),
      { step: '6', type: 'js_transform', expression: `local_state.edit_action === 'save'`, on_success: 'next', output_key: 'looping' },
      { step: '7', type: 'end' },
    ];
    steps[4] = { step: '5', type: 'condition', expression: `{{edit_action}}`, on_success: '6', on_else: '7' };

    const result = runSimulation({ steps, traceId: 't' });
    assert.equal(result.passed, true, JSON.stringify(result.error_summary));
  });
});
