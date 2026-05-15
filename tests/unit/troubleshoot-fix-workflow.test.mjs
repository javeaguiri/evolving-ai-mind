// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/troubleshoot-fix-workflow.test.mjs
//
// Unit tests for the pure logic used by troubleshoot-workflow.mjs,
// fix-workflow.mjs, and the fix_workflow PGC_Workflow definition.
//
// Architecture note:
//   fix-workflow.mjs is a thin entry point (like create-domain.mjs) — it
//   validates inputs, creates a PGC_WorkflowRun, and enqueues execute_top.
//   All LLM, validation, gate, and DB-write logic lives in the fix_workflow
//   workflow definition in seed_PGC_Workflow.json, driven by the Step Processor.
//   There is nothing to unit-test in the handle() functions beyond input
//   validation — those are integration concerns tested via curl.
//
// What IS unit-testable without I/O:
//   1. runSimulation (step-executor.mjs) — the Level 1 engine used by
//      troubleshoot-workflow and the fix_workflow simulate step
//   2. buildTroubleshootSummary — pure fn mirrored from troubleshoot-workflow
//   3. validateCorrectedSteps — pure fn: run Level 1 on LLM output
//   4. resolveFixInputs — pure fn: input normalisation in fix-workflow.handle()
//   5. fix_workflow step definitions — structural validity of the workflow
//      itself (condition bare keys, dead targets, iterator contracts)
//
// Run: node --test tests/unit/troubleshoot-fix-workflow.test.mjs

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../../src/proc/simulation-engine.mjs';

// ---------------------------------------------------------------------------
// Pure helpers — mirror logic from troubleshoot-workflow.mjs / fix-workflow.mjs
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

function validateCorrectedSteps(correctedSteps) {
  if (!Array.isArray(correctedSteps) || correctedSteps.length === 0) {
    return { passed: false, reason: 'empty_corrected_steps', issues: [] };
  }
  const result = runSimulation({ steps: correctedSteps, mockOutputs: null, simulationPaths: null });
  const issues = result.static_analysis?.issues ?? [];
  return { passed: issues.length === 0, issues };
}

function resolveFixInputs(body) {
  if (body.troubleshootResult) {
    const r = body.troubleshootResult;
    if (r.passed) return { error: 'troubleshootResult.passed is true — nothing to fix' };
    return {
      workflowName:    r.workflowName    ?? null,
      issues:          r.staticAnalysis?.issues ?? [],
      workflowVersion: r.workflowVersion ?? null,
      brokenSteps:     body.brokenSteps  ?? null,
      stackTrace:      body.stackTrace   ?? r.stackTrace ?? null,
    };
  }
  if (!body.workflowName) return { error: 'workflowName is required' };
  if (!body.issues || body.issues.length === 0) return { error: 'issues array is required and must be non-empty' };
  return {
    workflowName:    body.workflowName,
    issues:          body.issues,
    workflowVersion: body.workflowVersion ?? null,
    brokenSteps:     body.brokenSteps     ?? null,
    stackTrace:      body.stackTrace      ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fixtures — exact steps from create_workflow v4 that failed in production
// ---------------------------------------------------------------------------

const BROKEN_CONDITION_STEPS = [
  { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'domain_schema', on_success: 'next', on_failure: 'cancel' },
  { step: '2', type: 'llm_call',   input: { prompt: 'research_workflow_domain' }, output_key: 'right_brain_research', on_success: 'next', on_failure: 'next' },
  { step: '3', type: 'js_transform', input_key: 'right_brain_research', output_key: 'preference_gates', expression: '(function(){ return []; })()', on_success: 'next' },
  // BUG: both sides use routing tokens instead of bare step keys
  { step: '4', type: 'condition', expression: '{{preference_gates.length}}', on_truthy: 'next', on_falsy: 'cancel' },
  { step: '5', type: 'end' },
  { step: '6', type: 'end' },
];

const FIXED_CONDITION_STEPS = [
  { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'domain_schema', on_success: 'next', on_failure: 'cancel' },
  { step: '2', type: 'llm_call',   input: { prompt: 'research_workflow_domain' }, output_key: 'right_brain_research', on_success: 'next', on_failure: 'next' },
  { step: '3', type: 'js_transform', input_key: 'right_brain_research', output_key: 'preference_gates', expression: '(function(){ return []; })()', on_success: 'next' },
  // FIXED: bare step keys
  { step: '4', type: 'condition', expression: '{{preference_gates.length}}', on_truthy: '5', on_falsy: '6' },
  { step: '5', type: 'end' },
  { step: '6', type: 'end' },
];

// All four condition bugs from create_workflow v4
const ALL_FOUR_CONDITION_BUGS = [
  ...BROKEN_CONDITION_STEPS,
  { step: '7', type: 'serv_query', input: { tableName: 'PGC_StepType', filters: [] }, output_key: 'step_type_contracts', on_success: 'next', on_failure: 'cancel' },
  { step: '8', type: 'js_transform', input_key: 'step_type_contracts', output_key: 'routing_flags', expression: '(function(){ return { is_blocked: false, needs_schema: false }; })()', on_success: 'next' },
  { step: '9',  type: 'condition', expression: '{{routing_flags.is_blocked}}',  on_truthy: 'cancel', on_falsy: '11' },
  { step: '9a', type: 'notify', message_template: 'Blocked', on_success: 'end' },
  { step: '10', type: 'condition', expression: '{{routing_flags.needs_schema}}', on_truthy: 'next', on_falsy: '11' },
  { step: '10a', type: 'end' },
  { step: '11', type: 'end' },
];

const HEALTHY_STEPS = [
  { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'domain_schema', on_success: 'next', on_failure: 'cancel' },
  { step: '2', type: 'condition', expression: '{{domain_schema.length}}', on_truthy: '3', on_falsy: '4' },
  { step: '3', type: 'notify', message_template: 'Found schema', on_success: 'end' },
  { step: '4', type: 'notify', message_template: 'No schema', on_success: 'end' },
  { step: '5', type: 'end' },
];

// ---------------------------------------------------------------------------
// 1. Level 1 — the diagnostic engine (used by troubleshoot-workflow and
//    the fix_workflow simulate step)
// ---------------------------------------------------------------------------

describe('Level 1 static analysis — condition routing contract', () => {

  test('detects on_truthy: "next" — control token is invalid in condition step', () => {
    const result = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    assert.equal(result.static_analysis.passed, false);
    const issue = result.static_analysis.issues.find(i => i.step === '4' && i.detail.includes('on_truthy'));
    assert.ok(issue, 'Expected issue on step 4 on_truthy');
    assert.equal(issue.failure_class, 'condition_routing_invalid');
  });

  test('detects on_falsy: "cancel" — control token is invalid in condition step', () => {
    const result = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    const issue = result.static_analysis.issues.find(i => i.step === '4' && i.detail.includes('on_falsy'));
    assert.ok(issue, 'Expected issue on step 4 on_falsy');
    assert.equal(issue.failure_class, 'condition_routing_invalid');
  });

  test('finds all four condition routing bugs in create_workflow v4', () => {
    const result  = runSimulation({ steps: ALL_FOUR_CONDITION_BUGS });
    assert.equal(result.static_analysis.passed, false);
    const condIssues = result.static_analysis.issues.filter(i => ['4', '9', '10'].includes(i.step));
    assert.ok(condIssues.length >= 4, `Expected ≥4 condition issues, got ${condIssues.length}`);
  });

  test('passes after condition routing is fixed to bare step keys', () => {
    const result = runSimulation({ steps: FIXED_CONDITION_STEPS });
    assert.equal(result.static_analysis.passed, true);
    assert.equal(result.static_analysis.issues.length, 0);
  });

  test('each issue has the fields the fix_workflow_steps LLM prompt expects', () => {
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
      { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'rows', on_success: 'step:99', on_failure: 'cancel' },
      { step: '2', type: 'end' },
    ];
    const issue = runSimulation({ steps }).static_analysis.issues.find(i => i.failure_class === 'dead_routing_target');
    assert.ok(issue);
    assert.match(issue.detail, /99/);
  });

  test('detects unresolved template variable', () => {
    const steps = [
      { step: '1', type: 'serv_query', input: { tableName: 'PGC_Schema', filters: [] }, output_key: 'rows', on_success: 'next', on_failure: 'cancel' },
      { step: '2', type: 'notify', message_template: '{{nonexistent_key}}', on_success: 'end' },
      { step: '3', type: 'end' },
    ];
    const issue = runSimulation({ steps }).static_analysis.issues.find(i => i.failure_class === 'unresolved_template_variable');
    assert.ok(issue);
    assert.match(issue.detail, /nonexistent_key/);
  });

  test('detects human_gate missing cancel option', () => {
    const steps = [
      { step: '1', type: 'human_gate', gate_type: 'confirm', message_template: 'x', options: [{ label: 'OK', action: 'confirm', on_select: 'next' }], on_success: 'next', on_failure: 'cancel' },
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
    const issues = [{ step: '4', failure_class: 'unknown_routing_value', detail: 'on_truthy next is invalid', check: 'y' }];
    const s = buildTroubleshootSummary({ workflowName: 'test', workflowVersion: 1, issues });
    assert.match(s, /Step 4/);
    assert.match(s, /unknown_routing_value/);
    assert.match(s, /on_truthy next is invalid/);
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
// 3. Post-fix validation gate
// ---------------------------------------------------------------------------

describe('validateCorrectedSteps', () => {

  test('passed=false for null', () => { assert.equal(validateCorrectedSteps(null).passed, false); });

  test('passed=false and reason=empty_corrected_steps for []', () => {
    const r = validateCorrectedSteps([]);
    assert.equal(r.passed, false);
    assert.equal(r.reason, 'empty_corrected_steps');
  });

  test('passed=false when corrected steps still have condition routing bugs', () => {
    const r = validateCorrectedSteps(BROKEN_CONDITION_STEPS);
    assert.equal(r.passed, false);
    assert.ok(r.issues.length > 0);
  });

  test('passed=true for correctly fixed steps', () => {
    const r = validateCorrectedSteps(FIXED_CONDITION_STEPS);
    assert.equal(r.passed, true);
    assert.equal(r.issues.length, 0);
  });

  test('issues array is structured when failed', () => {
    const r = validateCorrectedSteps(BROKEN_CONDITION_STEPS);
    assert.ok(r.issues.every(i => i.step && i.failure_class && i.detail));
  });
});

// ---------------------------------------------------------------------------
// 4. Input resolution — fix-workflow.handle() normalisation
// ---------------------------------------------------------------------------

describe('resolveFixInputs', () => {

  test('extracts all fields from troubleshootResult', () => {
    const r = resolveFixInputs({
      troubleshootResult: {
        workflowName: 'create_workflow', workflowVersion: 4, passed: false,
        staticAnalysis: { issues: [{ step: '4', failure_class: 'unknown_routing_value', detail: 'x', check: 'y' }] },
      },
    });
    assert.equal(r.workflowName, 'create_workflow');
    assert.equal(r.workflowVersion, 4);
    assert.equal(r.issues.length, 1);
    assert.equal(r.error, undefined);
  });

  test('error when troubleshootResult.passed is true', () => {
    const r = resolveFixInputs({ troubleshootResult: { workflowName: 'test', passed: true, staticAnalysis: { issues: [] } } });
    assert.ok(r.error);
    assert.match(r.error, /nothing to fix/);
  });

  test('extracts from direct fields when no troubleshootResult', () => {
    const r = resolveFixInputs({ workflowName: 'create_workflow', issues: [{ step: '4', failure_class: 'x', detail: 'x', check: 'y' }] });
    assert.equal(r.workflowName, 'create_workflow');
    assert.equal(r.workflowVersion, null);
    assert.equal(r.issues.length, 1);
  });

  test('error when no troubleshootResult and no workflowName', () => {
    assert.match(
      resolveFixInputs({ issues: [{ step: '4', failure_class: 'x', detail: 'x', check: 'y' }] }).error,
      /workflowName is required/
    );
  });

  test('error when no troubleshootResult and empty issues', () => {
    assert.match(
      resolveFixInputs({ workflowName: 'test', issues: [] }).error,
      /issues array is required/
    );
  });

  test('body.brokenSteps overrides null default', () => {
    const r = resolveFixInputs({
      troubleshootResult: {
        workflowName: 'test', passed: false,
        staticAnalysis: { issues: [{ step: '1', failure_class: 'x', detail: 'x', check: 'y' }] },
      },
      brokenSteps: HEALTHY_STEPS,
    });
    assert.deepEqual(r.brokenSteps, HEALTHY_STEPS);
  });

  test('stackTrace forwarded from troubleshootResult when absent in body', () => {
    const r = resolveFixInputs({
      troubleshootResult: {
        workflowName: 'test', passed: false,
        stackTrace: 'Error: step not found',
        staticAnalysis: { issues: [{ step: '1', failure_class: 'x', detail: 'x', check: 'y' }] },
      },
    });
    assert.equal(r.stackTrace, 'Error: step not found');
  });

  test('body.stackTrace overrides troubleshootResult.stackTrace', () => {
    const r = resolveFixInputs({
      troubleshootResult: {
        workflowName: 'test', passed: false,
        stackTrace: 'from result',
        staticAnalysis: { issues: [{ step: '1', failure_class: 'x', detail: 'x', check: 'y' }] },
      },
      stackTrace: 'from body',
    });
    assert.equal(r.stackTrace, 'from body');
  });
});

// ---------------------------------------------------------------------------
// 5. fix_workflow workflow definition — structural validity
// The workflow itself must pass Level 1 before it can repair other workflows.
// ---------------------------------------------------------------------------

describe('fix_workflow workflow definition — structural validity', () => {
  let fixWorkflowSteps;

  // Load from seed file synchronously
  before(async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const seedPath = resolve(__dirname, '../../src/serv/templates/pgc/seeds/seed_PGC_Workflow.json');
    const workflows = JSON.parse(readFileSync(seedPath, 'utf8'));
    const fw = workflows.find(w => w.name === 'fix_workflow');
    assert.ok(fw, 'fix_workflow must exist in seed_PGC_Workflow.json');
    fixWorkflowSteps = fw.steps;
  });

  test('fix_workflow step array passes Level 1 static analysis', () => {
    const result = runSimulation({ steps: fixWorkflowSteps });
    if (!result.static_analysis.passed) {
      const issueLines = result.static_analysis.issues.map(i => `  step ${i.step} [${i.failure_class}]: ${i.detail}`).join('\n');
      assert.fail(`fix_workflow has structural issues:\n${issueLines}`);
    }
    assert.equal(result.static_analysis.passed, true);
  });

  test('all condition steps use bare step keys (not routing tokens or pre-prefixed)', () => {
    const conditions = fixWorkflowSteps.filter(s => s.type === 'condition');
    assert.ok(conditions.length > 0, 'Expected at least one condition step');
    const stepKeys = new Set(fixWorkflowSteps.map(s => String(s.step)));
    for (const s of conditions) {
      assert.ok(stepKeys.has(String(s.on_truthy)),
        `Step ${s.step} on_truthy "${s.on_truthy}" is not a valid step key`);
      assert.ok(stepKeys.has(String(s.on_falsy)),
        `Step ${s.step} on_falsy "${s.on_falsy}" is not a valid step key`);
      assert.doesNotMatch(String(s.on_truthy), /^(next|end|cancel)$/,
        `Step ${s.step} on_truthy must be a bare step key, not a routing token`);
      assert.doesNotMatch(String(s.on_falsy), /^(next|end|cancel)$/,
        `Step ${s.step} on_falsy must be a bare step key, not a routing token`);
      assert.doesNotMatch(String(s.on_truthy), /^step:/,
        `Step ${s.step} on_truthy must not be pre-prefixed with step:`);
      assert.doesNotMatch(String(s.on_falsy), /^step:/,
        `Step ${s.step} on_falsy must not be pre-prefixed with step:`);
    }
  });

  test('fix_workflow ends with type: end', () => {
    const last = fixWorkflowSteps[fixWorkflowSteps.length - 1];
    assert.equal(last.type, 'end');
  });

  test('fix_workflow has exactly one human_gate step (the confirmation gate)', () => {
    const gates = fixWorkflowSteps.filter(s => s.type === 'human_gate');
    assert.equal(gates.length, 1, 'Expected exactly one human_gate in fix_workflow');
  });

  test('human_gate has cancel option', () => {
    const gate = fixWorkflowSteps.find(s => s.type === 'human_gate');
    const hasCancel = (gate.options ?? []).some(o => o.action === 'cancel');
    assert.ok(hasCancel, 'human_gate must have a cancel option');
  });

  test('human_gate has Try again option routing back to llm_call step', () => {
    const gate    = fixWorkflowSteps.find(s => s.type === 'human_gate');
    const retry   = (gate.options ?? []).find(o => o.action === 'retry');
    assert.ok(retry, 'human_gate should have a retry option');
    // retry routes back to the llm_call step (step 4)
    assert.match(retry.on_select, /^step:4$/, 'retry should route to step:4 (llm_call)');
  });

  test('step 4b js_transform merges corrected steps into full array — output_key is merged_steps', () => {
    const merge = fixWorkflowSteps.find(s => s.step === '4b');
    assert.ok(merge, 'Expected a step 4b merge transform');
    assert.equal(merge.type, 'js_transform');
    assert.equal(merge.output_key, 'merged_steps');
    assert.match(merge.expression, /corrected/, 'expression should reference corrected steps');
    assert.match(merge.expression, /fullSteps|workflow_row/, 'expression should reference full step array');
  });

  test('simulate step uses steps_key pointing to merged_steps (full merged array)', () => {
    const simulate = fixWorkflowSteps.find(s => s.type === 'simulate');
    assert.ok(simulate, 'Expected a simulate step');
    assert.equal(simulate.input?.steps_key, 'merged_steps');
  });

  test('serv_update for PGC_Workflow writes merged_steps (not fix_result.corrected_steps)', () => {
    const wfUpdate = fixWorkflowSteps.find(s =>
      s.type === 'serv_update' &&
      String(s.input?.tableName ?? '').includes('PGC_Workflow')
    );
    assert.ok(wfUpdate, 'Expected a serv_update step targeting PGC_Workflow');
    assert.match(
      JSON.stringify(wfUpdate.input?.updates ?? {}),
      /merged_steps/,
      'serv_update must write merged_steps, not fix_result.corrected_steps'
    );
  });

  test('serv_update for PGC_Workflow uses name filter (not id)', () => {
    const wfUpdate = fixWorkflowSteps.find(s =>
      s.type === 'serv_update' &&
      String(s.input?.tableName ?? '').includes('PGC_Workflow')
    );
    assert.ok(wfUpdate, 'Expected a serv_update step targeting PGC_Workflow');
    const filters = wfUpdate.input?.filters ?? [];
    const nameFilter = filters.find(f => f.column === 'name');
    assert.ok(nameFilter, 'PGC_Workflow update must filter by name');
  });

  test('iterate over context_updates uses item.key and item.updated_content', () => {
    const ctxIter = fixWorkflowSteps.find(s =>
      s.type === 'iterator' &&
      s.items_key === 'fix_result.context_updates'
    );
    assert.ok(ctxIter, 'Expected iterator over fix_result.context_updates');
    const itemStep = ctxIter.item_step;
    assert.equal(itemStep.type, 'serv_update');
    assert.match(JSON.stringify(itemStep.input), /item\.key/);
    assert.match(JSON.stringify(itemStep.input), /item\.updated_content/);
  });
});

// ---------------------------------------------------------------------------
// 6. End-to-end: detect → correct → validate cycle
// ---------------------------------------------------------------------------

describe('detect → correct → validate cycle', () => {

  test('broken steps produce issues that pass to fix_workflow_steps LLM as-is', () => {
    const diag = runSimulation({ steps: BROKEN_CONDITION_STEPS });
    assert.equal(diag.static_analysis.passed, false);
    const issues = diag.static_analysis.issues;
    // Verify the issues array has the schema the fix_workflow_steps prompt expects
    assert.ok(issues.length >= 2);
    for (const i of issues) {
      assert.ok(i.step && i.failure_class && i.detail && i.check);
    }
  });

  test('valid LLM correction passes post-fix validation — fix proceeds', () => {
    const postFix = validateCorrectedSteps(FIXED_CONDITION_STEPS);
    assert.equal(postFix.passed, true, 'Corrected steps must pass Level 1 before commit');
  });

  test('invalid LLM correction fails post-fix validation — fix is blocked', () => {
    const postFix = validateCorrectedSteps(BROKEN_CONDITION_STEPS);
    assert.equal(postFix.passed, false);
    assert.ok(postFix.issues.length > 0);
  });

  test('fix summary shows ✅ and incremented version after successful repair', () => {
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
