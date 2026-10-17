// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/troubleshoot-workflow.test.mjs
//
// Unit tests for the pure logic used by troubleshoot-workflow.mjs — the
// diagnostic-only Level 1 analysis, run on request.
//
// What IS unit-testable without I/O:
//   1. runSimulation (simulation-engine.mjs) — the Level 1 engine troubleshoot uses
//   2. buildTroubleshootSummary — pure fn mirrored from troubleshoot-workflow
//
// Run: node --test tests/unit/troubleshoot-workflow.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../../src/proc/simulation-engine.mjs';

// ---------------------------------------------------------------------------
// Pure helpers — mirror logic from troubleshoot-workflow.mjs
// If source changes, update these too.
// ---------------------------------------------------------------------------

function buildTroubleshootSummary({ workflowName, workflowVersion, issues }) {
  const label = workflowName
    ? `*${workflowName}*${workflowVersion != null ? ` v${workflowVersion}` : ''}`
    : 'supplied step array';

  if (issues.length === 0) return `✅ ${label} — no structural issues found`;

  const bulletLines = issues.slice(0, 10).map(
    i => `• Step ${i.step} [${i.failure_class}]: ${i.detail}${i.suggestion ? ` — ${i.suggestion}` : ''}`
  );
  if (issues.length > 10) bulletLines.push(`• …and ${issues.length - 10} more`);
  return `❌ ${label} — ${issues.length} issue${issues.length !== 1 ? 's' : ''} found\n\n${bulletLines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Fixtures — exact steps from create_workflow v4 that failed in production
// ---------------------------------------------------------------------------

const BROKEN_CONDITION_STEPS = [
  { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'domain_schema', on_success: 'next', on_else: 'cancel' },
  { step: '2', type: 'llm_call',   input: { prompt: 'research_workflow_domain' }, output_key: 'right_brain_research', on_success: 'next', on_else: 'next' },
  { step: '3', type: 'js_transform', input_key: 'right_brain_research', output_key: 'preference_gates', expression: '(function(){ return []; })()', on_success: 'next' },
  // BUG: both sides use routing tokens instead of bare step keys
  { step: '4', type: 'condition', expression: '{{preference_gates.length}}', on_success: 'next', on_else: 'cancel' },
  { step: '5', type: 'end' },
  { step: '6', type: 'end' },
];

const FIXED_CONDITION_STEPS = [
  { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'domain_schema', on_success: 'next', on_else: 'cancel' },
  { step: '2', type: 'llm_call',   input: { prompt: 'research_workflow_domain' }, output_key: 'right_brain_research', on_success: 'next', on_else: 'next' },
  { step: '3', type: 'js_transform', input_key: 'right_brain_research', output_key: 'preference_gates', expression: '(function(){ return []; })()', on_success: 'next' },
  // FIXED: bare step keys
  { step: '4', type: 'condition', expression: '{{preference_gates.length}}', on_success: '5', on_else: '6' },
  { step: '5', type: 'end' },
  { step: '6', type: 'end' },
];

// All four condition bugs from create_workflow v4
const ALL_FOUR_CONDITION_BUGS = [
  ...BROKEN_CONDITION_STEPS,
  { step: '7', type: 'serv_query', input: { tableName: 'PGC_StepType', filters: [] }, output_key: 'step_type_contracts', on_success: 'next', on_else: 'cancel' },
  { step: '8', type: 'js_transform', input_key: 'step_type_contracts', output_key: 'routing_flags', expression: '(function(){ return { is_blocked: false, needs_schema: false }; })()', on_success: 'next' },
  { step: '9',  type: 'condition', expression: '{{routing_flags.is_blocked}}',  on_success: 'cancel', on_else: '11' },
  { step: '9a', type: 'notify', message_template: 'Blocked', on_success: 'end' },
  { step: '10', type: 'condition', expression: '{{routing_flags.needs_schema}}', on_success: 'next', on_else: '11' },
  { step: '10a', type: 'end' },
  { step: '11', type: 'end' },
];

const HEALTHY_STEPS = [
  { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'domain_schema', on_success: 'next', on_else: 'cancel' },
  { step: '2', type: 'condition', expression: '{{domain_schema.length}}', on_success: '3', on_else: '4' },
  { step: '3', type: 'notify', message_template: 'Found schema', on_success: 'end' },
  { step: '4', type: 'notify', message_template: 'No schema', on_success: 'end' },
  { step: '5', type: 'end' },
];

// ---------------------------------------------------------------------------
// 1. Level 1 — the diagnostic engine (used by troubleshoot-workflow)
// ---------------------------------------------------------------------------

describe('Level 1 static analysis — condition routing contract', () => {

  test('detects on_success: "next" — control token is invalid in condition step', () => {
    const result = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    assert.equal(result.static_analysis.passed, false);
    const issue = result.static_analysis.issues.find(i => i.step === '4' && i.detail.includes('on_success'));
    assert.ok(issue, 'Expected issue on step 4 on_success');
    assert.equal(issue.failure_class, 'condition_routing_invalid');
  });

  test('on_else: "cancel" is valid on condition step — not flagged', () => {
    const result = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    const issue = result.static_analysis.issues.find(i => i.step === '4' && i.detail.includes('on_else'));
    assert.equal(issue, undefined, 'cancel is a terminal token and must not be flagged on condition steps');
  });

  test('finds "next" routing bugs in condition steps (cancel/end are valid terminals)', () => {
    const result  = runSimulation({ steps: ALL_FOUR_CONDITION_BUGS });
    assert.equal(result.static_analysis.passed, false);
    // step 4 on_success:next, step 10 on_success:next — cancel/end no longer flagged
    const condIssues = result.static_analysis.issues.filter(i => ['4', '9', '10'].includes(i.step));
    assert.ok(condIssues.length >= 2, `Expected ≥2 condition issues, got ${condIssues.length}`);
  });

  test('passes after condition routing is fixed to bare step keys', () => {
    const result = runSimulation({ steps: FIXED_CONDITION_STEPS });
    assert.equal(result.static_analysis.passed, true);
    assert.equal(result.static_analysis.issues.length, 0);
  });

  test('each issue carries step, failure_class, detail and check', () => {
    const result = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    for (const issue of result.static_analysis.issues) {
      assert.ok(issue.step,          `issue.step missing in: ${JSON.stringify(issue)}`);
      assert.ok(issue.failure_class, `issue.failure_class missing in: ${JSON.stringify(issue)}`);
      assert.ok(issue.detail,        `issue.detail missing in: ${JSON.stringify(issue)}`);
      assert.ok(issue.check,         `issue.check missing in: ${JSON.stringify(issue)}`);
    }
  });
});

describe('Level 1 static analysis — other failure classes', () => {

  test('detects dead routing target', () => {
    const steps = [
      { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'rows', on_success: 'step:99', on_else: 'cancel' },
      { step: '2', type: 'end' },
    ];
    const issue = runSimulation({ steps }).static_analysis.issues.find(i => i.failure_class === 'dead_routing_target');
    assert.ok(issue);
    assert.match(issue.detail, /99/);
  });

  test('detects unresolved template variable', () => {
    const steps = [
      { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'rows', on_success: 'next', on_else: 'cancel' },
      { step: '2', type: 'notify', message_template: '{{nonexistent_key}}', on_success: 'end' },
      { step: '3', type: 'end' },
    ];
    const issue = runSimulation({ steps }).static_analysis.issues.find(i => i.failure_class === 'unresolved_template_variable');
    assert.ok(issue);
    assert.match(issue.detail, /nonexistent_key/);
  });

  test('detects human_gate missing cancel option', () => {
    const steps = [
      { step: '1', type: 'human_gate', gate_type: 'confirm', message_template: 'x', options: [{ label: 'OK', action: 'confirm', on_select: 'next' }], on_success: 'next', on_else: 'cancel' },
      { step: '2', type: 'end' },
    ];
    const issue = runSimulation({ steps }).static_analysis.issues.find(i => i.failure_class === 'missing_cancel_option');
    assert.ok(issue);
    assert.equal(issue.step, '1');
  });

  test('Level 1 only (no simulationPaths) returns passed:true with paths_run:0', () => {
    const result = runSimulation({ steps: HEALTHY_STEPS, mockOutputs: null, simulationPaths: null });
    assert.equal(result.passed, true);
    assert.equal(result.paths_run, 0);
  });

  test('Level 1 failure short-circuits path execution — paths_run stays 0', () => {
    const result = runSimulation({
      steps: BROKEN_CONDITION_STEPS,
      mockOutputs: {},
      simulationPaths: [{ path_name: 'happy', decisions: [], expected_terminal: 'end' }],
    });
    assert.equal(result.static_analysis.passed, false);
    assert.equal(result.paths_run, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Summary formatting
// ---------------------------------------------------------------------------

describe('buildTroubleshootSummary', () => {

  test('✅ prefix when no issues', () => {
    const s = buildTroubleshootSummary({ workflowName: 'create_workflow', workflowVersion: 4, issues: [] });
    assert.match(s, /^✅/);
    assert.match(s, /v4/);
  });

  test('❌ prefix and count when issues present', () => {
    const issues = [{ step: '4', failure_class: 'unknown_routing_value', detail: 'x', check: 'y' }];
    const s = buildTroubleshootSummary({ workflowName: 'create_workflow', workflowVersion: 4, issues });
    assert.match(s, /^❌/);
    assert.match(s, /1 issue/);
  });

  test('includes step key, failure_class, detail in each bullet', () => {
    const issues = [{ step: '4', failure_class: 'unknown_routing_value', detail: 'on_success next is invalid', check: 'y' }];
    const s = buildTroubleshootSummary({ workflowName: 'test', workflowVersion: 1, issues });
    assert.match(s, /Step 4/);
    assert.match(s, /unknown_routing_value/);
    assert.match(s, /on_success next is invalid/);
  });

  test('appends suggestion when present', () => {
    const issues = [{ step: '4', failure_class: 'unknown_routing_value', detail: 'x', suggestion: 'Use bare key "5"', check: 'y' }];
    const s = buildTroubleshootSummary({ workflowName: 'test', workflowVersion: 1, issues });
    assert.match(s, /Use bare key "5"/);
  });

  test('no trailing undefined when suggestion absent', () => {
    const issues = [{ step: '4', failure_class: 'unknown_routing_value', detail: 'x', check: 'y' }];
    assert.doesNotMatch(buildTroubleshootSummary({ workflowName: 'test', workflowVersion: 1, issues }), /undefined/);
  });

  test('caps at 10 bullets with overflow note', () => {
    const issues = Array.from({ length: 13 }, (_, i) => ({ step: String(i + 1), failure_class: 'unknown_routing_value', detail: `issue ${i}`, check: 'y' }));
    const s = buildTroubleshootSummary({ workflowName: 'test', workflowVersion: 1, issues });
    assert.match(s, /and 3 more/);
    assert.equal((s.match(/^•/gm) ?? []).length, 11);
  });

  test('plural "issues" when count > 1', () => {
    const issues = [
      { step: '4', failure_class: 'unknown_routing_value', detail: 'a', check: 'y' },
      { step: '9', failure_class: 'unknown_routing_value', detail: 'b', check: 'y' },
    ];
    assert.match(buildTroubleshootSummary({ workflowName: 'test', workflowVersion: 1, issues }), /2 issues/);
  });

  test('singular "issue" when count = 1', () => {
    const issues = [{ step: '4', failure_class: 'unknown_routing_value', detail: 'a', check: 'y' }];
    const s = buildTroubleshootSummary({ workflowName: 'test', workflowVersion: 1, issues });
    assert.match(s, /1 issue/);
    assert.doesNotMatch(s, /1 issues/);
  });

  test('null workflowName shows "supplied step array" with no "null" literal', () => {
    const s = buildTroubleshootSummary({ workflowName: null, workflowVersion: null, issues: [] });
    assert.match(s, /supplied step array/);
    assert.doesNotMatch(s, /null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Level 2a — Routing matrix
// ---------------------------------------------------------------------------

describe('Level 2a — routing matrix', () => {

  const UNREACHABLE_STEP_STEPS = [
    { step: '1', type: 'serv_query', input: { tableName: 'T', filters: [] }, output_key: 'rows', on_success: '3', on_else: 'cancel' },
    { step: '2', type: 'notify', message_template: 'orphan', on_success: 'end' }, // nothing routes to step 2
    { step: '3', type: 'end' },
  ];

  const SELF_LOOP_STEPS = [
    { step: '1', type: 'serv_query', input: { tableName: 'T', filters: [] }, output_key: 'rows', on_success: '2', on_else: 'cancel' },
    { step: '2', type: 'notify', message_template: 'loop', on_success: '2' }, // self-loop, no way to 'end'
  ];

  test('passes on HEALTHY_STEPS — all steps reachable, all can reach terminal', () => {
    const result = runSimulation({ steps: HEALTHY_STEPS });
    assert.ok(result.routing_matrix, 'routing_matrix must be present in result');
    assert.equal(result.routing_matrix.passed, true);
    assert.equal(result.routing_matrix.issues.length, 0);
  });

  test('routing_matrix field present in result after L1 passes', () => {
    const result = runSimulation({ steps: FIXED_CONDITION_STEPS });
    assert.ok(result.routing_matrix, 'routing_matrix missing from result');
    assert.equal(typeof result.routing_matrix.passed, 'boolean');
    assert.ok(Array.isArray(result.routing_matrix.issues));
    assert.equal(typeof result.routing_matrix.reachable_count, 'number');
  });

  test('detects unreachable_step for non-end step with no incoming routes', () => {
    const result = runSimulation({ steps: UNREACHABLE_STEP_STEPS });
    const issue = (result.routing_matrix?.issues ?? []).find(i => i.failure_class === 'unreachable_step' && i.step === '2');
    assert.ok(issue, 'Expected unreachable_step issue on step 2');
    assert.equal(result.routing_matrix.passed, false);
    assert.equal(result.passed, false);
  });

  test('unreachable end-type step is skipped (dead end steps are harmless)', () => {
    // HEALTHY_STEPS step 5 is type:end with no incoming routes — should not be flagged
    const result = runSimulation({ steps: HEALTHY_STEPS });
    const unreachableIssues = (result.routing_matrix?.issues ?? []).filter(i => i.failure_class === 'unreachable_step');
    assert.equal(unreachableIssues.length, 0);
  });

  test('detects no_terminal_path for step in a self-loop', () => {
    const result = runSimulation({ steps: SELF_LOOP_STEPS });
    const issue = (result.routing_matrix?.issues ?? []).find(i => i.failure_class === 'no_terminal_path' && i.step === '2');
    assert.ok(issue, 'Expected no_terminal_path issue on step 2');
    assert.equal(result.routing_matrix.passed, false);
  });

  test('reachable_count and unreachable_count are consistent with step array length', () => {
    const result = runSimulation({ steps: UNREACHABLE_STEP_STEPS });
    const rm = result.routing_matrix;
    assert.equal(rm.reachable_count + rm.unreachable_count, UNREACHABLE_STEP_STEPS.length);
  });

  test('routing_matrix absent when L1 fails (short-circuit)', () => {
    const result = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    assert.equal(result.static_analysis.passed, false);
    assert.equal(result.routing_matrix, undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. Level 2b — js_transform smoke test
// ---------------------------------------------------------------------------

describe('Level 2b — js_transform smoke test', () => {

  const SYNTAX_ERROR_STEPS = [
    { step: '1', type: 'js_transform', expression: 'if (', output_key: 'x', on_success: 'end' },
    { step: '2', type: 'end' },
  ];

  const VOID_RETURN_STEPS = [
    { step: '1', type: 'js_transform', expression: 'void 0', output_key: 'x', on_success: 'end' },
    { step: '2', type: 'end' },
  ];

  // Reads through `input`, which the root frame is always seeded with, so the array is
  // valid to L1 while the read still throws against mock state — the runtime error this
  // fixture exists to produce. Naming a bare key nothing writes would now be refused at
  // L1 by expression_reads_unwritten_key, and L1 short-circuits the smoke test.
  const RUNTIME_ERROR_STEPS = [
    { step: '1', type: 'js_transform', expression: 'local_state.input.nonexistent.property', output_key: 'x', on_success: 'end' },
    { step: '2', type: 'end' },
  ];

  const VALID_TRANSFORM_STEPS = [
    { step: '1', type: 'serv_query', input: { tableName: 'T', filters: [] }, output_key: 'rows', on_success: 'next', on_else: 'cancel' },
    { step: '2', type: 'js_transform', expression: '(function(){ return local_state.rows.length > 0; })()', output_key: 'has_rows', on_success: 'end' },
    { step: '3', type: 'end' },
  ];

  test('smoke_test field present in result after L1 passes', () => {
    const result = runSimulation({ steps: HEALTHY_STEPS });
    assert.ok(result.smoke_test, 'smoke_test missing from result');
    assert.equal(typeof result.smoke_test.passed, 'boolean');
    assert.ok(Array.isArray(result.smoke_test.issues));
    assert.equal(typeof result.smoke_test.steps_tested, 'number');
  });

  test('no js_transform steps gives steps_tested:0 and passed:true', () => {
    const result = runSimulation({ steps: HEALTHY_STEPS });
    assert.equal(result.smoke_test.steps_tested, 0);
    assert.equal(result.smoke_test.passed, true);
  });

  test('syntax error in expression is a hard failure — smoke_test.passed = false', () => {
    const result = runSimulation({ steps: SYNTAX_ERROR_STEPS });
    const issue = (result.smoke_test?.issues ?? []).find(i => i.failure_class === 'js_transform_syntax_error');
    assert.ok(issue, 'Expected js_transform_syntax_error issue');
    assert.equal(result.smoke_test.passed, false);
    assert.equal(result.passed, false);
  });

  test('undefined return is a hard failure — smoke_test.passed = false', () => {
    const result = runSimulation({ steps: VOID_RETURN_STEPS });
    const issue = (result.smoke_test?.issues ?? []).find(i => i.failure_class === 'js_transform_void_return');
    assert.ok(issue, 'Expected js_transform_void_return issue');
    assert.equal(result.smoke_test.passed, false);
  });

  test('runtime error is a soft warning — smoke_test.passed stays true', () => {
    const result = runSimulation({ steps: RUNTIME_ERROR_STEPS });
    const issue = (result.smoke_test?.issues ?? []).find(i => i.failure_class === 'js_transform_runtime_error');
    assert.ok(issue, 'Expected js_transform_runtime_error issue');
    assert.equal(issue.severity, 'warning');
    assert.equal(result.smoke_test.passed, true); // runtime errors are warnings, not failures
  });

  test('valid expression using mock state passes', () => {
    const result = runSimulation({ steps: VALID_TRANSFORM_STEPS });
    assert.equal(result.smoke_test.passed, true);
    assert.equal(result.smoke_test.steps_tested, 1);
    assert.equal(result.smoke_test.issues.length, 0);
  });

  test('smoke_test counts only js_transform steps', () => {
    const result = runSimulation({ steps: FIXED_CONDITION_STEPS }); // has exactly one js_transform
    assert.equal(result.smoke_test.steps_tested, 1);
  });

  test('smoke_test absent when L1 fails (short-circuit)', () => {
    const result = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    assert.equal(result.static_analysis.passed, false);
    assert.equal(result.smoke_test, undefined);
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end: detect → summarise
// ---------------------------------------------------------------------------

describe('detect → summarise', () => {

  test('broken steps produce issues with every field the summary reads', () => {
    const diag = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    assert.equal(diag.static_analysis.passed, false);
    const issues = diag.static_analysis.issues;
    assert.ok(issues.length >= 1);
    for (const i of issues) {
      assert.ok(i.step && i.failure_class && i.detail && i.check);
    }
  });

  test('summary shows ✅ and the version for a clean workflow', () => {
    const summary = buildTroubleshootSummary({
      workflowName: 'create_workflow', workflowVersion: 5, issues: [],
    });
    assert.match(summary, /✅/);
    assert.match(summary, /v5/);
  });

  test('troubleshoot summary for broken create_workflow v4 identifies step 4', () => {
    const diag = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    const summary = buildTroubleshootSummary({
      workflowName: 'create_workflow', workflowVersion: 4,
      issues: diag.static_analysis.issues,
    });
    assert.match(summary, /❌/);
    assert.match(summary, /Step 4/);
  });
});
