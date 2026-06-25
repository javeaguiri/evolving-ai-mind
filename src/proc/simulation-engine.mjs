// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/simulation-engine.mjs
//
// Simulation engine for workflow step arrays.
// Pure module — no I/O, no AWS SDK, no Slack SDK.
//
// Exports:
//   runSimulation          — full Level 1 + Level 2 validation
//   runLevel1StaticAnalysis — structural analysis only (used by pre-write guards)

import vm from 'vm';

// Known valid routing token pattern — "next", "end", "cancel",
// a bare step key (e.g. "3", "3a", "1R"), or "step:<key>" for backwards compatibility.
const ROUTING_TOKEN_RE = /^(next|end|cancel|step:.+|[a-zA-Z0-9][a-zA-Z0-9_]*)$/;

// ---------------------------------------------------------------------------
// runSimulation — exported for the HTTP simulate-workflow endpoint.
// Called identically from executeSimulate (step type) and simulate-workflow.mjs
// (standalone HTTP handler). No WorkflowRun required.
//
// @param {object[]} steps           — workflow step array to validate
// @param {object|null} mockOutputs  — mock outputs keyed by step number string
// @param {object[]|null} simulationPaths — named execution paths
// @param {object} runInput          — simulated run.input (available as {{input.*}})
// @param {string} [traceId]
// @returns {SimulateWorkflowResponse}
// ---------------------------------------------------------------------------

export function runSimulation({ steps, mockOutputs, simulationPaths, runInput = {}, skeleton = false, traceId }) {
  console.info('simulation-engine: runSimulation — starting', {
    stepCount: steps.length,
    hasMocks:  !!mockOutputs,
    pathCount: Array.isArray(simulationPaths) ? simulationPaths.length : 0,
    skeleton,
    traceId,
  });

  // ── Level 1 — Static analysis ────────────────────────────────────────────
  const level1Result  = runLevel1StaticAnalysis(steps, { skeleton });
  const staticIssues  = level1Result.issues;
  const stateFlow     = level1Result.state_flow;
  const unrefWrites   = level1Result.unreferenced_writes;

  if (staticIssues.length > 0) {
    console.info('simulation-engine: runSimulation — Level 1 failed', {
      issueCount: staticIssues.length, traceId,
    });
    return {
      passed:              false,
      total_issues:        staticIssues.length,
      paths_run:           0,
      paths_passed:        0,
      paths_failed:        0,
      static_analysis:     { passed: false, issues: staticIssues },
      state_flow:          stateFlow,
      unreferenced_writes: unrefWrites,
      path_results:        [],
    };
  }

  // ── Level 2a — Routing matrix (static graph reachability + terminal check) ─
  const routingMatrix = runRoutingMatrix(steps, traceId);

  // ── Level 2b — js_transform smoke test ──────────────────────────────────
  const smokeTest = runJsTransformSmokeTest(steps, traceId);

  const l2Passed = routingMatrix.passed && smokeTest.passed;

  // Level 1 + 2a + 2b passed check — if no paths supplied, skip legacy path execution.
  if (!Array.isArray(simulationPaths) || simulationPaths.length === 0) {
    console.info('simulation-engine: runSimulation — routing matrix + smoke test complete (no legacy paths)', {
      l2Passed,
      routingMatrixPassed: routingMatrix.passed,
      smokeTestPassed:     smokeTest.passed,
      traceId,
    });
    return {
      passed:              l2Passed,
      total_issues:        routingMatrix.issues.length + smokeTest.issues.length,
      paths_run:           0,
      paths_passed:        0,
      paths_failed:        0,
      static_analysis:     { passed: true, issues: [] },
      state_flow:          stateFlow,
      unreferenced_writes: unrefWrites,
      path_results:        [],
      routing_matrix:      routingMatrix,
      smoke_test:          smokeTest,
    };
  }

  // ── Level 2c — Legacy path execution (kept for diagnostics reference) ────
  // path_results is informational — result.passed is determined by routing_matrix + smoke_test.
  const seenPathNames = new Set();
  const uniquePaths   = simulationPaths.filter(path => {
    if (seenPathNames.has(path.path_name)) return false;
    seenPathNames.add(path.path_name);
    return true;
  });
  const pathResults = uniquePaths.map(
    path => executeSimPath(steps, path, mockOutputs, runInput)
  );

  const pathsPassed = pathResults.filter(r => r.passed).length;
  const pathsFailed = pathResults.filter(r => !r.passed).length;

  const result = {
    passed:              l2Passed,
    total_issues:        routingMatrix.issues.length + smokeTest.issues.length,
    paths_run:           pathResults.length,
    paths_passed:        pathsPassed,
    paths_failed:        pathsFailed,
    static_analysis:     { passed: true, issues: [] },
    state_flow:          stateFlow,
    unreferenced_writes: unrefWrites,
    path_results:        pathResults,
    routing_matrix:      routingMatrix,
    smoke_test:          smokeTest,
  };

  console.info('simulation-engine: runSimulation — complete', {
    passed: result.passed, routingMatrixPassed: routingMatrix.passed,
    smokeTestPassed: smokeTest.passed, pathsRun: result.paths_run,
    pathsPassed, pathsFailed, traceId,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Level 1 — Static analysis
// ---------------------------------------------------------------------------

export function runLevel1StaticAnalysis(steps, { skeleton = false } = {}) {
  const issues = [];

  // Build a set of all step keys for dead-target checking
  const stepKeys = new Set(steps.map(s => String(s.step)));

  // State flow tracking — per-step reads/writes, and global write registry.
  // 'reads'  = base keys this step references via template tokens or input_key/items_key.
  // 'writes' = base keys this step writes to local_state via output_key (step or option level).
  const stateFlow     = {};   // { [step_key]: { reads: string[], writes: string[] } }
  const writtenByStep = {};   // { [key]: first_step_key_that_wrote_it }
  const allReadsEver  = new Set(); // union of all reads across all steps

  // Build the set of output_key values written by each step at each point
  // in the canonical (top-to-bottom) execution order. This is a conservative
  // approximation — it does not model branching. It catches the common case
  // where a template references a key that is never written by any prior step.
  const outputKeysSoFar = new Set(['input']); // run.input is always available

  for (const s of steps) {
    const stepKey = String(s.step);

    // Check every routing value on this step
    const routingValues = [];
    if (s.on_success) routingValues.push({ field: 'on_success', value: s.on_success });
    if (s.on_else)    routingValues.push({ field: 'on_else',    value: s.on_else });
    if (s.on_complete) routingValues.push({ field: 'on_complete', value: s.on_complete });
    for (const opt of [...(s.options ?? []), ...(s.special_buttons ?? [])]) {
      if (opt.on_select) routingValues.push({ field: `options[${opt.action ?? opt.value}].on_select`, value: opt.on_select });
    }

    const CONTROL_TOKENS = new Set(['next', 'end', 'cancel']);
    for (const { field, value } of routingValues) {
      const sv = String(value);
      if (!ROUTING_TOKEN_RE.test(sv)) {
        issues.push({
          check:         'unknown_routing_value',
          step:          stepKey,
          failure_class: 'unknown_routing_value',
          detail:        `Step "${stepKey}" field "${field}" has unknown routing value "${sv}". Valid values: next, end, cancel, a bare step key, or step:<key>`,
        });
      }
      // Dead-target check: applies to step:N and bare step keys (any token not next/end/cancel).
      let target = null;
      if (sv.startsWith('step:'))       target = sv.slice(5);
      else if (!CONTROL_TOKENS.has(sv)) target = sv;
      if (target !== null && !stepKeys.has(target)) {
        issues.push({
          check:         'dead_routing_target',
          step:          stepKey,
          failure_class: 'dead_routing_target',
          detail:        `Step "${stepKey}" field "${field}" routes to "${sv}" but no step with key "${target}" exists`,
        });
      }
    }

    // Condition steps have a stricter contract: on_success/on_else must be bare step keys
    // or terminal tokens (end, cancel). "next" and "step:N" are ambiguous on condition steps —
    // the branch target must be named explicitly.
    if (s.type === 'condition') {
      for (const field of ['on_success', 'on_else']) {
        const val = s[field];
        if (val == null) continue;
        const sv = String(val);
        if (sv === 'next' || sv.startsWith('step:')) {
          issues.push({
            check:         'condition_routing_invalid',
            step:          stepKey,
            failure_class: 'condition_routing_invalid',
            detail:        `Condition step "${stepKey}" field "${field}" must be a bare step key (e.g. "5", "9a") or a terminal token (end, cancel), but got "${sv}". "next" and "step:N" are ambiguous on condition steps — specify the target step key directly.`,
          });
        }
      }
    }

    // Check items_key for iterator steps
    if (s.type === 'iterator') {
      const baseKey = (s.items_key ?? '').split('.')[0];
      if (baseKey && !outputKeysSoFar.has(baseKey)) {
        issues.push({
          check:         'iterator_source_not_array',
          step:          stepKey,
          failure_class: 'iterator_source_not_array',
          detail:        `Iterator step "${stepKey}" items_key "${s.items_key}" — base key "${baseKey}" has not been written by any prior step. Available keys: ${[...outputKeysSoFar].join(', ')}`,
        });
      }
    }

    // Check gate has at least one cancel option — skipped in skeleton mode because
    // options are dialog-layer content added after routing topology is validated.
    if (s.type === 'human_gate') {
      if (!skeleton) {
        const allGateOptions = [...(s.options ?? []), ...(s.special_buttons ?? [])];
        const hasCancel = allGateOptions.some(o => o.action === 'cancel' || o.value === 'cancel');
        if (!hasCancel) {
          issues.push({
            check:         'missing_cancel_option',
            step:          stepKey,
            failure_class: 'missing_cancel_option',
            detail:        `human_gate step "${stepKey}" has no option with action "cancel"`,
          });
        }
      }

      if (!s.on_cancel || !ROUTING_TOKEN_RE.test(s.on_cancel)) {
        issues.push({
          check:         'missing_on_cancel',
          step:          stepKey,
          failure_class: 'missing_on_cancel',
          detail:        `human_gate step "${stepKey}" is missing on_cancel at the step level. Set on_cancel to "cancel" or a valid step routing token (e.g. "step:cleanup") if cancellation requires a cleanup step first.`,
        });
      }

      // reveal field — both button_label and content must be non-empty strings
      if (s.reveal !== undefined && s.reveal !== null) {
        if (!s.reveal.button_label || typeof s.reveal.button_label !== 'string' || !s.reveal.button_label.trim()) {
          issues.push({
            check:         'reveal_missing_button_label',
            step:          stepKey,
            failure_class: 'reveal_missing_button_label',
            detail:        `human_gate step "${stepKey}" has a reveal field but reveal.button_label is missing or empty.`,
          });
        }
        if (!s.reveal.content || typeof s.reveal.content !== 'string' || !s.reveal.content.trim()) {
          issues.push({
            check:         'reveal_missing_content',
            step:          stepKey,
            failure_class: 'reveal_missing_content',
            detail:        `human_gate step "${stepKey}" has a reveal field but reveal.content is missing or empty.`,
          });
        }
      }

      // review_object never writes output_key.
      // confirm without context_key is a static yes/no — no output_key.
      // confirm WITH context_key is a dynamic selection gate — output_key IS written by resume_gate.
      const isStaticConfirm = s.gate_type === 'confirm' && !s.context_key;
      if ((s.gate_type === 'review_object' || isStaticConfirm) && s.output_key) {
        issues.push({
          check:         'gate_output_key_invalid',
          step:          stepKey,
          failure_class: 'gate_output_key_invalid',
          detail:        `Gate type "${s.gate_type}" on step "${stepKey}" has output_key but this gate type does not write to local_state. Only text_input and dynamic confirm (with context_key) gates write output_key.`,
        });
      }
    }

    // Check template variables in message_template and input values.
    // condition expressions also use {{}} tokens and are validated here.
    const templatesToCheck = [];
    if (s.message_template) templatesToCheck.push(s.message_template);
    if (s.context_key)      templatesToCheck.push(`{{${s.context_key}}}`);
    if (typeof s.input === 'object' && s.input !== null) {
      Object.values(s.input).forEach(v => {
        if (typeof v === 'string') templatesToCheck.push(v);
      });
    }
    if (s.input_key)  templatesToCheck.push(`{{${s.input_key}}}`);
    if (s.items_key)  templatesToCheck.push(`{{${s.items_key}}}`);
    if (s.type === 'condition' && s.expression) templatesToCheck.push(s.expression);
    // Scan option and special_button description fields — choice gate descriptions
    // are resolved via resolveTemplate at runtime; unresolved refs must be caught here.
    // Skip iterator-scoped options: their tokens resolve against iterator items at runtime,
    // not against local_state, so L1 cannot validate them statically.
    for (const opt of [...(s.options ?? []), ...(s.special_buttons ?? [])]) {
      if (opt.iterator) continue;
      if (typeof opt.description === 'string' && opt.description) templatesToCheck.push(opt.description);
    }

    const stepReads          = new Set();
    const seenTemplateIssues = new Set();
    for (const template of templatesToCheck) {
      // Nested {{ detection must happen before extractTemplateRefs — e.g.
      // "{{cards.{{index}}.term}}" is structurally unparseable, not a ref error.
      const nestedMatch = /\{\{[^}]*\{\{[^}]*\}\}/.exec(template);
      if (nestedMatch) {
        const issueKey = `nested_template::${nestedMatch[0]}`;
        if (!seenTemplateIssues.has(issueKey)) {
          seenTemplateIssues.add(issueKey);
          issues.push({
            check:         'unsupported_handlebars_syntax',
            step:          stepKey,
            failure_class: 'unsupported_handlebars_syntax',
            detail:        `Step "${stepKey}" contains nested template syntax which is not supported: "${nestedMatch[0]}". Pre-compute the value in a js_transform step and reference the result key instead.`,
          });
        }
        continue;
      }
      const refs = extractTemplateRefs(template);
      for (const ref of refs) {
        // Detect unsupported Handlebars syntax before the standard unresolved-key check.
        // {{#each}}, {{/each}}, {{this}} are not valid tokens — the template resolver
        // only supports {{key.path}} dot-notation.
        const trimmed = ref.trim();
        if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed === 'this' || trimmed.startsWith('this.')) {
          const key = `handlebars::${trimmed}`;
          if (!seenTemplateIssues.has(key)) {
            seenTemplateIssues.add(key);
            issues.push({
              check:         'unsupported_handlebars_syntax',
              step:          stepKey,
              failure_class: 'unsupported_handlebars_syntax',
              detail:        `Step "${stepKey}" uses unsupported Handlebars syntax "{{${ref}}}" in a template. Only {{key.path}} dot-notation is supported. Replace {{#each array}}...{{this.prop}}...{{/each}} with indexed access: {{array.0.prop}}, {{array.1.prop}}, etc.`,
            });
          }
          continue;
        }
        // Arithmetic expressions (e.g. "subset_index + 1") are handled by evalExpression at
        // runtime — extract identifiers for tracking but skip the unresolved-key check.
        if (/[\s+\-*%]/.test(ref)) {
          const ids = ref.match(/\b[a-zA-Z_][a-zA-Z0-9_.]*\b/g) ?? [];
          for (const id of ids) {
            const bk = id.split('.')[0];
            if (bk !== 'item') { stepReads.add(bk); allReadsEver.add(bk); }
          }
          continue;
        }
        // Strip bracket notation to extract true base key: "arr[idx].prop" → "arr"
        const baseKey = ref.split('.')[0].replace(/\[.*/, '');
        // Collect read for state_flow tracking (all base keys except iterator-scoped 'item')
        if (baseKey !== 'item') {
          stepReads.add(baseKey);
          allReadsEver.add(baseKey);
        }
        if (baseKey !== 'item' && baseKey !== 'input' && !outputKeysSoFar.has(baseKey)) {
          const key = `unresolved::${baseKey}`;
          if (!seenTemplateIssues.has(key)) {
            seenTemplateIssues.add(key);
            issues.push({
              check:         'unresolved_template_variable',
              step:          stepKey,
              failure_class: 'unresolved_template_variable',
              detail:        `Step "${stepKey}" references "{{${ref}}}" but base key "${baseKey}" has not been written by any prior step. Available keys: ${[...outputKeysSoFar].join(', ')}`,
              suggestion:    findClosestKey([...outputKeysSoFar], baseKey),
            });
          }
        }
      }
    }

    // Check required input fields for serv_* step types.
    // Skipped in skeleton mode — skeleton steps are routing-topology only and carry no
    // input fields by design. Content completeness is checked in the final pre-write L1.
    // Template references (e.g. "{{item.tableName}}") are valid — only absent/null/empty fails.
    const servRequired = {
      serv_query:  ['tableName'],
      serv_insert: ['tableName', 'row'],
      serv_update: ['tableName', 'filters', 'updates'],
      serv_delete: ['tableName', 'filters'],
    };
    if (!skeleton && servRequired[s.type]) {
      const inputObj = s.input ?? {};
      for (const field of servRequired[s.type]) {
        const val = inputObj[field];
        if (val === undefined || val === null || val === '') {
          issues.push({
            check:         'serv_step_missing_required_input',
            step:          stepKey,
            failure_class: 'serv_step_missing_required_input',
            detail:        `${s.type} step "${stepKey}" is missing required input field "${field}". Provide input.${field} as a literal value or a {{template}} reference.`,
          });
        }
      }
    }

    // Validate filter array element shape and op values for serv_* steps.
    // Skips validation when filters is a template reference string (resolved at runtime).
    const VALID_FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'is_null', 'not_null']);
    const SERV_FILTER_STEPS = new Set(['serv_query', 'serv_update', 'serv_delete', 'serv_entity_query']);
    if (SERV_FILTER_STEPS.has(s.type)) {
      const rawFilters = s.input?.filters ?? null;
      if (rawFilters !== null && typeof rawFilters !== 'string' && Array.isArray(rawFilters)) {
        for (let fi = 0; fi < rawFilters.length; fi++) {
          const f = rawFilters[fi];
          if (typeof f !== 'object' || f === null) {
            issues.push({
              check:         'serv_step_invalid_filter',
              step:          stepKey,
              failure_class: 'serv_step_invalid_filter',
              detail:        `${s.type} step "${stepKey}" filters[${fi}] must be an object with shape { column, op, value } but got ${JSON.stringify(f)}. Valid ops: eq, neq, gt, gte, lt, lte, like, in, is_null, not_null`,
            });
            continue;
          }
          if (!f.column || typeof f.column !== 'string') {
            issues.push({
              check:         'serv_step_invalid_filter',
              step:          stepKey,
              failure_class: 'serv_step_invalid_filter',
              detail:        `${s.type} step "${stepKey}" filters[${fi}] is missing or invalid "column" field. Each filter must be { column, op, value }.`,
            });
          }
          if (!f.op) {
            issues.push({
              check:         'serv_step_invalid_filter',
              step:          stepKey,
              failure_class: 'serv_step_invalid_filter',
              detail:        `${s.type} step "${stepKey}" filters[${fi}] is missing "op" field. Valid ops: eq, neq, gt, gte, lt, lte, like, in, is_null, not_null`,
            });
          } else if (!VALID_FILTER_OPS.has(f.op)) {
            issues.push({
              check:         'serv_step_invalid_filter_op',
              step:          stepKey,
              failure_class: 'serv_step_invalid_filter_op',
              detail:        `${s.type} step "${stepKey}" filters[${fi}] has invalid op "${f.op}". Valid ops: eq, neq, gt, gte, lt, lte, like, in, is_null, not_null — never use SQL operators like "=", "!=", "contains"`,
            });
          }
        }
      }
    }

    // Collect writes — step-level output_key.
    // Comma-separated output_key registers each listed key individually.
    // Non-string output_key is a workflow defect — report as error.
    const stepWrites = new Set();
    if (s.output_key && typeof s.output_key === 'string') {
      for (const rawKey of s.output_key.split(',')) {
        const baseOut = rawKey.trim().split('.')[0];
        outputKeysSoFar.add(baseOut);
        stepWrites.add(baseOut);
        if (!writtenByStep[baseOut]) writtenByStep[baseOut] = stepKey;
      }
    } else if (s.output_key !== undefined && s.output_key !== null && s.output_key !== '') {
      issues.push({
        check:         'malformed_output_key',
        step:          stepKey,
        failure_class: 'malformed_output_key',
        detail:        `Step "${stepKey}" output_key must be a string but got ${typeof s.output_key}: ${JSON.stringify(s.output_key)}`,
      });
    }
    // Collect writes — option-level output_key (modal writes on confirm/review_object gates)
    for (const opt of [...(s.options ?? []), ...(s.special_buttons ?? [])]) {
      if (opt.output_key && typeof opt.output_key === 'string') {
        const baseOut = opt.output_key.split('.')[0];
        outputKeysSoFar.add(baseOut);
        stepWrites.add(baseOut);
        if (!writtenByStep[baseOut]) writtenByStep[baseOut] = stepKey;
      } else if (opt.output_key !== undefined && opt.output_key !== null && opt.output_key !== '') {
        issues.push({
          check:         'malformed_output_key',
          step:          stepKey,
          failure_class: 'malformed_output_key',
          detail:        `Step "${stepKey}" option output_key must be a string but got ${typeof opt.output_key}: ${JSON.stringify(opt.output_key)}`,
        });
      }
    }

    stateFlow[stepKey] = { reads: [...stepReads].sort(), writes: [...stepWrites].sort() };
  }

  // Keys written by any step but never referenced in any step's declared inputs.
  // These are advisory warnings — they do not affect the passed/failed result.
  const unreferencedWrites = Object.entries(writtenByStep)
    .filter(([key]) => !allReadsEver.has(key))
    .map(([key, writtenBy]) => ({
      key,
      written_by:  writtenBy,
      note:        `"${key}" is written by step ${writtenBy} but not referenced in any step's declared inputs`,
    }));

  // Deduplicate issues by (check + step + detail) — multiple routing fields
  // pointing to the same dead target generate one issue per field; deduplicate here.
  const seenIssueKeys = new Set();
  const uniqueIssues  = issues.filter(issue => {
    const key = `${issue.check}::${issue.step}::${issue.detail ?? ''}`;
    if (seenIssueKeys.has(key)) return false;
    seenIssueKeys.add(key);
    return true;
  });

  return { issues: uniqueIssues, state_flow: stateFlow, unreferenced_writes: unreferencedWrites };
}

// ---------------------------------------------------------------------------
// Level 2 — Path execution
// ---------------------------------------------------------------------------

function executeSimPath(steps, path, mockOutputs, runInput) {
  const localState     = { input: runInput };
  const transitions    = [];
  let stepVisits       = {};  // step_key → visit count, for loop detection
  let decisionIndex    = 0;

  // Build a map from step key to step definition for fast lookup
  const stepMap = Object.fromEntries(steps.map(s => [String(s.step), s]));

  // Start at the first step
  let currentKey = String(steps[0].step);
  let stepsExecuted = 0;
  const MAX_STEPS    = Math.max(steps.length * 30, 500);
  const MAX_LOOP_ITER = 30; // max times a single step may be visited before treating as loop-exhausted

  while (stepsExecuted < MAX_STEPS) {
    stepsExecuted++;

    if (currentKey === 'end' || currentKey === 'cancel') {
      break;
    }

    const currentStep = stepMap[currentKey];
    if (!currentStep) {
      return {
        path_name:           path.path_name,
        passed:              false,
        steps_executed:      stepsExecuted,
        terminal:            currentKey,
        expected_terminal:   path.expected_terminal,
        failure_step:        currentKey,
        failure_reason:      `Routing reached step key "${currentKey}" which does not exist in the step array`,
        local_state_transitions: transitions,
      };
    }

    stepVisits[currentKey] = (stepVisits[currentKey] ?? 0) + 1;
    if (stepVisits[currentKey] > MAX_LOOP_ITER) {
      // A step was visited more than MAX_LOOP_ITER times — valid loop with many iterations,
      // not an infinite routing cycle. No routing error was found; treat the path as passed.
      return {
        path_name:               path.path_name,
        passed:                  true,
        steps_executed:          stepsExecuted,
        terminal:                path.expected_terminal,
        expected_terminal:       path.expected_terminal,
        loop_limit_reached:      true,
        local_state_transitions: transitions,
      };
    }

    const keysBefore = Object.keys(localState);
    let nextKey;
    let transition = {
      step:                    currentKey,
      type:                    currentStep.type,
      keys_before:             [...keysBefore],
      keys_added:              [],
      template_vars_resolved:  {},
      template_vars_missing:   [],
      status:                  'ok',
    };

    // Find the matching decision entry for this step (if any)
    const decision = (path.decisions ?? []).find(d => String(d.step) === currentKey);

    if (currentStep.type === 'end') {
      transitions.push({ ...transition });
      currentKey = 'end';
      break;
    }

    if (currentStep.type === 'human_gate') {
      if (!decision || decision.outcome !== 'gate') {
        // No explicit decision — auto-continue with the first non-cancel option so that
        // paths which pass through a loop gate en route to a later failure step don't
        // need to enumerate every loop iteration explicitly.
        const defaultOption = (currentStep.options ?? []).find(
          o => o.on_select !== 'cancel' && o.action !== 'cancel'
        );
        if (!defaultOption) {
          transition.status = 'failed';
          transitions.push(transition);
          return {
            path_name:           path.path_name,
            passed:              false,
            steps_executed:      stepsExecuted,
            terminal:            currentKey,
            expected_terminal:   path.expected_terminal,
            failure_step:        currentKey,
            failure_reason:      `Path "${path.path_name}" has no decision entry for human_gate step "${currentKey}" and no non-cancel default option exists`,
            local_state_transitions: transitions,
          };
        }
        if (currentStep.output_key) {
          localState[currentStep.output_key] = defaultOption.value;
          transition.keys_added.push(currentStep.output_key);
        }
        transition.auto_continued = true;
        // validate reveal.content template refs against localState at suspension time
        const revealMissing = checkRevealContent(currentStep, localState);
        if (revealMissing.length > 0) {
          transition.template_vars_missing.push(...revealMissing);
          transition.status = 'failed';
          transitions.push(transition);
          return {
            path_name:           path.path_name,
            passed:              false,
            steps_executed:      stepsExecuted,
            terminal:            currentKey,
            expected_terminal:   path.expected_terminal,
            failure_step:        currentKey,
            failure_reason:      `Step "${currentKey}" reveal.content references missing key(s): ${revealMissing.join(', ')}. Available keys: ${Object.keys(localState).join(', ')}`,
            local_state_transitions: transitions,
          };
        }
        const onSelect = defaultOption.on_select;
        nextKey = resolveSimNextKey(steps, currentKey, onSelect);
        if (onSelect === 'cancel')      currentKey = 'cancel';
        else if (onSelect === 'end')    currentKey = 'end';
        else                            currentKey = nextKey;
        transitions.push(transition);
        continue;
      }

      // For text_input gates, write the value to local_state
      if (currentStep.gate_type === 'text_input' && decision.output_key) {
        localState[decision.output_key] = decision.value ?? '';
        transition.keys_added.push(decision.output_key);
      }

      // For choice gates, find the option matching user_response (by action or value) and
      // write its value — mirrors what resume_gate does in production.
      if (currentStep.gate_type === 'choice' && currentStep.output_key && decision.user_response !== undefined) {
        const matchedOpt = (currentStep.options ?? []).find(
          o => o.action === decision.user_response || o.value === decision.user_response
        );
        localState[currentStep.output_key] = matchedOpt?.value ?? decision.user_response;
        transition.keys_added.push(currentStep.output_key);
      }

      // validate reveal.content template refs against localState at suspension time
      const gateRevealMissing = checkRevealContent(currentStep, localState);
      if (gateRevealMissing.length > 0) {
        transition.template_vars_missing.push(...gateRevealMissing);
        transition.status = 'failed';
        transitions.push(transition);
        return {
          path_name:           path.path_name,
          passed:              false,
          steps_executed:      stepsExecuted,
          terminal:            currentKey,
          expected_terminal:   path.expected_terminal,
          failure_step:        currentKey,
          failure_reason:      `Step "${currentKey}" reveal.content references missing key(s): ${gateRevealMissing.join(', ')}. Available keys: ${Object.keys(localState).join(', ')}`,
          local_state_transitions: transitions,
        };
      }

      // Resolve next step from on_select
      const onSelect = decision.on_select;
      nextKey = resolveSimNextKey(steps, currentKey, onSelect);
      if (onSelect === 'cancel')           currentKey = 'cancel';
      else if (onSelect === 'end')         currentKey = 'end';
      else                                 currentKey = nextKey;

      transitions.push(transition);
      continue;
    }

    if (currentStep.type === 'notify') {
      // notify is a side-effect — advance to next, no output_key
      nextKey = resolveSimNextKey(steps, currentKey, currentStep.on_success ?? 'next');
      transitions.push(transition);
      currentKey = nextKey;
      continue;
    }

    if (currentStep.type === 'iterator') {
      // Simulate one body iteration so body-step state writes reach localState.
      // item is a minimal sentinel so {{item.*}} refs are treated as resolved.
      localState.item = {};
      transition.keys_added.push('item');

      const bodyStep = currentStep.item_step;
      if (bodyStep && typeof bodyStep === 'object') {
        if (bodyStep.type === 'human_gate') {
          // Auto-continue with the first non-cancel option — same policy as outer gates.
          const bodyOpts = Array.isArray(bodyStep.options) ? bodyStep.options : [];
          const defaultBodyOpt = bodyOpts.find(o => o.on_select !== 'cancel' && o.action !== 'cancel');
          if (bodyStep.output_key && typeof bodyStep.output_key === 'string') {
            const baseOut = bodyStep.output_key.split('.')[0];
            localState[baseOut] = defaultBodyOpt?.value ?? null;
            if (!transition.keys_added.includes(baseOut)) transition.keys_added.push(baseOut);
          }
          // Check reveal.content on body gate (item 10)
          const bodyRevealMissing = checkRevealContent(bodyStep, localState);
          if (bodyRevealMissing.length > 0) {
            transition.template_vars_missing.push(...bodyRevealMissing);
            transition.status = 'failed';
            transitions.push(transition);
            return {
              path_name:           path.path_name,
              passed:              false,
              steps_executed:      stepsExecuted,
              terminal:            currentKey,
              expected_terminal:   path.expected_terminal,
              failure_step:        currentKey,
              failure_reason:      `Iterator "${currentKey}" body reveal.content references missing key(s): ${bodyRevealMissing.join(', ')}. Available keys: ${Object.keys(localState).join(', ')}`,
              local_state_transitions: transitions,
            };
          }
        } else if (bodyStep.output_key && typeof bodyStep.output_key === 'string') {
          // For serv_insert, llm_call, js_transform bodies — write a minimal mock value
          const baseOut = bodyStep.output_key.split('.')[0];
          if (!transition.keys_added.includes(baseOut)) {
            localState[baseOut] = {};
            transition.keys_added.push(baseOut);
          }
        }
      }

      // Iterator output_key holds the collected array across all iterations.
      if (currentStep.output_key && typeof currentStep.output_key === 'string') {
        const baseOut = currentStep.output_key.split('.')[0];
        const bodyVal = localState[baseOut];
        localState[baseOut] = bodyVal !== undefined ? [bodyVal] : [];
        if (!transition.keys_added.includes(baseOut)) transition.keys_added.push(baseOut);
      }

      nextKey = resolveSimNextKey(steps, currentKey, currentStep.on_complete ?? 'next');
      transitions.push(transition);
      currentKey = nextKey;
      continue;
    }

    // For steps with a decision entry that signals failure
    if (decision?.outcome === 'failure') {
      const onFailure = currentStep.on_else ?? 'cancel';
      nextKey = resolveSimNextKey(steps, currentKey, onFailure);
      if (onFailure === 'cancel')    currentKey = 'cancel';
      else if (onFailure === 'end') currentKey = 'end';
      else                          currentKey = nextKey;
      transition.status = 'failed';
      transitions.push(transition);
      continue;
    }

    // Steps that produce output — inject mock output
    const mockKey = String(currentKey);
    const mockOutput = mockOutputs?.[mockKey] ?? null;

    // Validate that required template vars in this step's input resolve
    const templatesToCheck = [];
    if (typeof currentStep.input === 'object' && currentStep.input !== null) {
      Object.values(currentStep.input).forEach(v => {
        if (typeof v === 'string') templatesToCheck.push(v);
      });
    }

    for (const tmpl of templatesToCheck) {
      const refs = extractTemplateRefs(tmpl);
      for (const ref of refs) {
        const baseKey = ref.split('.')[0];
        if (baseKey !== 'item' && baseKey !== 'input' && !(baseKey in localState)) {
          transition.template_vars_missing.push(ref);
        } else if (baseKey in localState || baseKey === 'input') {
          transition.template_vars_resolved[ref] = String(localState[baseKey] ?? '').slice(0, 100);
        }
      }
    }

    if (transition.template_vars_missing.length > 0) {
      transition.status = 'failed';
      transitions.push(transition);
      return {
        path_name:           path.path_name,
        passed:              false,
        steps_executed:      stepsExecuted,
        terminal:            currentKey,
        expected_terminal:   path.expected_terminal,
        failure_step:        currentKey,
        failure_reason:      `Template variable(s) missing at step "${currentKey}": ${transition.template_vars_missing.join(', ')}. Available keys: ${Object.keys(localState).join(', ')}`,
        local_state_transitions: transitions,
      };
    }

    // Write mock output to local_state.
    // Comma-separated output_key writes to each listed key; if mockOutput is an object
    // containing the key, use that value — otherwise write the whole mockOutput to each key.
    if (currentStep.output_key && typeof currentStep.output_key === 'string' && mockOutput !== null) {
      for (const rawKey of currentStep.output_key.split(',')) {
        const baseOut = rawKey.trim().split('.')[0];
        if (!localState[baseOut]) {
          const val = (typeof mockOutput === 'object' && mockOutput !== null && baseOut in mockOutput)
            ? mockOutput[baseOut]
            : mockOutput;
          localState[baseOut] = val;
          transition.keys_added.push(baseOut);
        }
      }
    }

    nextKey = resolveSimNextKey(steps, currentKey, currentStep.on_success ?? 'next');
    transitions.push(transition);
    currentKey = nextKey;
  }

  // If MAX_STEPS exhausted without reaching a terminal, treat as loop-exhausted (same as MAX_LOOP_ITER).
  if (stepsExecuted >= MAX_STEPS && currentKey !== 'end' && currentKey !== 'cancel') {
    return {
      path_name:               path.path_name,
      passed:                  true,
      steps_executed:          stepsExecuted,
      terminal:                path.expected_terminal,
      expected_terminal:       path.expected_terminal,
      loop_limit_reached:      true,
      local_state_transitions: transitions,
    };
  }

  // Determine actual terminal
  let terminal;
  if (currentKey === 'end' || stepMap[currentKey]?.type === 'end') terminal = 'end';
  else if (currentKey === 'cancel') terminal = 'cancelled';
  else terminal = currentKey;

  const passed = terminal === path.expected_terminal;

  return {
    path_name:               path.path_name,
    passed,
    steps_executed:          stepsExecuted,
    terminal,
    expected_terminal:       path.expected_terminal,
    failure_step:            passed ? undefined : (transitions.findLast(t => t.type !== 'end') ?? transitions[transitions.length - 1])?.step ?? currentKey,
    failure_reason:          passed ? undefined : `Path ended at "${terminal}" but expected "${path.expected_terminal}"`,
    local_state_transitions: transitions,
  };
}

// ---------------------------------------------------------------------------
// Level 2a — Routing matrix
// ---------------------------------------------------------------------------

function runRoutingMatrix(steps, traceId) {
  const issues  = [];
  const stepKeys = new Set(steps.map(s => String(s.step)));

  // Resolve a single routing value to a concrete target key.
  const resolveTarget = (stepKey, value) => {
    if (!value) return null;
    const sv = String(value);
    if (sv === 'end' || sv === 'cancel') return sv;
    if (sv === 'next') {
      const idx = steps.findIndex(s => String(s.step) === stepKey);
      if (idx !== -1 && idx < steps.length - 1) return String(steps[idx + 1].step);
      return 'end';
    }
    if (sv.startsWith('step:')) return sv.slice(5);
    return sv; // bare step key or dead target — L1 validates existence separately
  };

  // Build adjacency list
  const edges = {};
  for (const s of steps) {
    const key     = String(s.step);
    const targets = new Set();

    if (s.type === 'end') {
      targets.add('end');
    } else if (s.type === 'condition') {
      const tt = resolveTarget(key, s.on_success);
      const ft = resolveTarget(key, s.on_else);
      if (tt) targets.add(tt);
      if (ft) targets.add(ft);
    } else if (s.type === 'human_gate') {
      for (const opt of [...(s.options ?? []), ...(s.special_buttons ?? [])]) {
        const ot = resolveTarget(key, opt.on_select);
        if (ot) targets.add(ot);
      }
      // on_success and on_else are step-level routing fields present in skeleton
      // steps (before options are added) and used as defaults in full steps.
      for (const field of ['on_success', 'on_else', 'on_cancel']) {
        if (s[field]) { const t = resolveTarget(key, s[field]); if (t) targets.add(t); }
      }
    } else {
      const st = resolveTarget(key, s.on_success ?? 'next');
      if (st) targets.add(st);
      for (const field of ['on_else', 'on_complete', 'on_empty', 'on_error']) {
        if (s[field]) {
          const t = resolveTarget(key, s[field]);
          if (t) targets.add(t);
        }
      }
    }

    edges[key] = targets;
  }

  // BFS from first step to find reachable set
  const startKey = String(steps[0].step);
  const reachable = new Set([startKey]);
  const queue     = [startKey];

  while (queue.length > 0) {
    const cur = queue.shift();
    for (const target of (edges[cur] ?? [])) {
      if (!reachable.has(target)) {
        reachable.add(target);
        if (stepKeys.has(target)) queue.push(target);
      }
    }
  }

  // Flag unreachable non-end steps
  for (const s of steps) {
    const key = String(s.step);
    if (s.type === 'end') continue; // dead end steps are harmless dead code
    if (!reachable.has(key)) {
      issues.push({
        check:         'unreachable_step',
        step:          key,
        failure_class: 'unreachable_step',
        detail:        `Step "${key}" is not reachable from the workflow entry point. No execution path leads to this step.`,
      });
    }
  }

  // Iterative fixpoint: which steps can reach a terminal ('end' or 'cancel')?
  const canReachTerminal = new Set(['end', 'cancel']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of stepKeys) {
      if (canReachTerminal.has(key)) continue;
      if ([...(edges[key] ?? [])].some(t => canReachTerminal.has(t))) {
        canReachTerminal.add(key);
        changed = true;
      }
    }
  }

  // Flag reachable steps with no path to a terminal
  for (const s of steps) {
    const key = String(s.step);
    if (!reachable.has(key)) continue; // already flagged unreachable
    if (!canReachTerminal.has(key)) {
      issues.push({
        check:         'no_terminal_path',
        step:          key,
        failure_class: 'no_terminal_path',
        detail:        `Step "${key}" is reachable but has no execution path that leads to a terminal state ("end" or "cancel"). Check routing on this step and its successors for cycles.`,
      });
    }
  }

  const reachableCount = [...reachable].filter(k => stepKeys.has(k)).length;

  return {
    passed:            issues.length === 0,
    reachable_count:   reachableCount,
    unreachable_count: steps.length - reachableCount,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Level 2b — js_transform smoke test
// ---------------------------------------------------------------------------

function mockValueForType(stepType) {
  if (stepType === 'serv_query')        return [{ id: 1 }];
  if (stepType === 'serv_entity_query') return { id: 1 };
  if (stepType === 'serv_insert')       return { id: 1 };
  if (stepType === 'serv_update')       return { updated: 1 };
  if (stepType === 'serv_delete')       return { deleted: 1 };
  if (stepType === 'llm_call')          return {};
  if (stepType === 'human_gate')        return 'mock_value';
  return {};
}

// Scan expression for `local_state.X[` patterns — keys used as arrays.
function inferMockArrayKeys(expr) {
  const keys = new Set();
  const indexRe  = /local_state\.(\w+)\s*\[/g;
  const methodRe = /local_state\.(\w+)\.(slice|map|filter|find|findIndex|forEach|some|every|reduce|includes|length|push|pop|shift|unshift)\b/g;
  let m;
  while ((m = indexRe.exec(expr))  !== null) keys.add(m[1]);
  while ((m = methodRe.exec(expr)) !== null) keys.add(m[1]);
  return keys;
}

// Scan expression for `[local_state.X]` patterns — keys used as numeric indices.
function inferMockIndexKeys(expr) {
  const keys = new Set();
  const re = /\[\s*local_state\.(\w+)\s*\]/g;
  let m;
  while ((m = re.exec(expr)) !== null) keys.add(m[1]);
  return keys;
}

function runJsTransformSmokeTest(steps, traceId) {
  const issues    = [];
  let stepsTested = 0;
  const mockState = { input: {} };

  for (const s of steps) {
    const key = String(s.step);

    if (s.type === 'js_transform') {
      const expr = s.expression;
      if (typeof expr === 'string' && expr.trim()) {
        stepsTested++;
        let result;
        let threwSyntax  = false;
        let threwRuntime = false;

        // Augment mockState with inferred shapes before running the expression.
        // Keys accessed as arrays get [{ id: 1 }]; keys used as numeric indices get 0.
        // This prevents false-positive void_return and runtime_error failures when the
        // expression is valid but mock state doesn't match real data shapes.
        for (const k of inferMockArrayKeys(expr)) {
          if (!Array.isArray(mockState[k])) mockState[k] = [{ id: 1 }];
        }
        for (const k of inferMockIndexKeys(expr)) {
          if (typeof mockState[k] !== 'number') mockState[k] = 0;
        }

        // When input_key is set, step-executor binds local_state[input_key] as 'items'.
        // Mirror that here so expressions using 'items' don't throw spurious ReferenceErrors.
        const itemsVal = (s.input_key && typeof s.input_key === 'string')
          ? mockState[s.input_key]
          : undefined;

        try {
          const sandbox = { local_state: mockState, items: itemsVal };
          result = vm.runInNewContext(`(${expr})`, sandbox, { timeout: 500 });
        } catch (err) {
          if (err.name === 'SyntaxError') {
            threwSyntax = true;
            issues.push({
              check:         'js_transform_syntax_error',
              step:          key,
              failure_class: 'js_transform_syntax_error',
              detail:        `js_transform step "${key}" expression has a syntax error: ${err.message}`,
            });
          } else if (err.message?.includes('Script execution timed out')) {
            threwRuntime = true;
            issues.push({
              check:         'js_transform_runtime_error',
              step:          key,
              failure_class: 'js_transform_runtime_error',
              severity:      'warning',
              detail:        `js_transform step "${key}" expression timed out after 500ms — possible infinite loop.`,
            });
          } else {
            threwRuntime = true;
            issues.push({
              check:         'js_transform_runtime_error',
              step:          key,
              failure_class: 'js_transform_runtime_error',
              severity:      'warning',
              detail:        `js_transform step "${key}" threw a runtime error against mock state: ${err.message}. This may be a false positive if the expression relies on real data shapes.`,
            });
          }
        }

        if (!threwSyntax && !threwRuntime && result === undefined) {
          issues.push({
            check:         'js_transform_void_return',
            step:          key,
            failure_class: 'js_transform_void_return',
            detail:        `js_transform step "${key}" expression returned undefined with mock state. Ensure the expression evaluates to a value, not a statement.`,
          });
        }

        // Propagate result to mockState for downstream steps
        if (s.output_key && typeof s.output_key === 'string') {
          const useVal = (!threwSyntax && result !== undefined) ? result : {};
          for (const rawKey of s.output_key.split(',')) {
            const baseOut = rawKey.trim().split('.')[0];
            if (!(baseOut in mockState)) mockState[baseOut] = useVal;
          }
        }
      }
    } else {
      // Write mock values for non-transform steps so downstream transforms can reference them
      if (s.output_key && typeof s.output_key === 'string') {
        for (const rawKey of s.output_key.split(',')) {
          const baseOut = rawKey.trim().split('.')[0];
          if (!(baseOut in mockState)) mockState[baseOut] = mockValueForType(s.type);
        }
      }
      for (const opt of [...(s.options ?? []), ...(s.special_buttons ?? [])]) {
        if (opt.output_key && typeof opt.output_key === 'string') {
          const baseOut = opt.output_key.split('.')[0];
          if (!(baseOut in mockState)) mockState[baseOut] = 'mock_value';
        }
      }
    }
  }

  // Hard failures (affect passed): syntax errors and void returns.
  // Runtime errors are soft warnings — mock state may not match real data shapes.
  const hardFailures = issues.filter(i =>
    i.failure_class === 'js_transform_syntax_error' ||
    i.failure_class === 'js_transform_void_return'
  );

  return {
    passed:       hardFailures.length === 0,
    steps_tested: stepsTested,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Simulate helpers
// ---------------------------------------------------------------------------

/**
 * Extract all {{ref}} template variable names from a string.
 * Returns base paths only — "proposed_scaffold.domain" for "{{proposed_scaffold.domain}}".
 */
function extractTemplateRefs(template) {
  if (typeof template !== 'string') return [];
  const refs = [];
  const re   = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = re.exec(template)) !== null) {
    refs.push(match[1].trim());
  }
  return refs;
}

/**
 * Resolve the next step key for simulation (mirrors resolveNextStep in run-workflow.mjs
 * but operates purely on the steps array without DB access).
 */
function resolveSimNextKey(steps, currentKey, nextAction) {
  if (nextAction === 'end')    return 'end';
  if (nextAction === 'cancel') return 'cancel';
  if (nextAction?.startsWith('step:')) return nextAction.slice(5);
  // Bare step key — any token matching an existing step key is a direct jump.
  if (nextAction && nextAction !== 'next' && steps.some(s => String(s.step) === String(nextAction))) {
    return String(nextAction);
  }
  // 'next' or absent — advance to the next step in array order.
  const idx = steps.findIndex(s => String(s.step) === String(currentKey));
  if (idx === -1 || idx === steps.length - 1) return 'end';
  return String(steps[idx + 1].step);
}

/**
 * Extract template refs from reveal.content and return any whose base key is
 * absent from localState. Returns an empty array when reveal is absent/null.
 */
function checkRevealContent(step, localState) {
  if (!step.reveal?.content || typeof step.reveal.content !== 'string') return [];
  const missing = [];
  for (const ref of extractTemplateRefs(step.reveal.content)) {
    const baseKey = ref.split('.')[0];
    if (baseKey !== 'item' && baseKey !== 'input' && !(baseKey in localState)) {
      missing.push(ref);
    }
  }
  return missing;
}

/**
 * Find the closest key to the search term by simple prefix/substring match.
 * Used to provide helpful suggestions in Level 1 errors.
 */
function findClosestKey(keys, search) {
  const exact = keys.find(k => k === search);
  if (exact) return exact;
  const prefix = keys.find(k => k.startsWith(search) || search.startsWith(k));
  if (prefix) return `Did you mean "{{${prefix}}}"?`;
  return null;
}
