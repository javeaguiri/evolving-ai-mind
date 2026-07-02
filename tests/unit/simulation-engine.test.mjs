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
