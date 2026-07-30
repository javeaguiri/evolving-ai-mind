# Simulation Engine
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture. Main doc: `docs/architecture.md`. See also: `docs/arch-step-types.md` for the `simulate` step type's place in the step type catalog, `docs/arch-step-processor.md` for the Step Processor execution engine it validates against, `docs/arch-create-workflow.md` for how `create_workflow` drives it end to end.

## Overview

`src/proc/simulation-engine.mjs` is a standalone, pure-function module — no I/O,
no AWS SDK, no database access. Given a workflow step array (and optionally mock
outputs and named execution paths), it validates the array's structure and traces
data flow through it, returning a structured pass/fail result with per-issue
detail. It is the mechanism that lets a generated workflow be checked for defects
*before* it is registered in `PGC_Workflow` and runs against real data.

It is consumer-agnostic — four independent call sites use it, none of which own it:

| Consumer | How |
|---|---|
| `create_workflow` / `fix_workflow` | The `simulate` step type (`step-executor.mjs`'s `executeSimulate`) — a workflow step that dry-runs another workflow's generated step array as part of the authoring flow. See `docs/arch-step-processor.md` §6.5.6 and `docs/arch-create-workflow.md`. |
| Novia (`minds-eye.mjs`) | The `simulate_workflow` tool calls the standalone HTTP endpoint (below) directly — no `WorkflowRun` involved. See `docs/arch-minds-eye.md`. |
| `dev_scripts/upsert-workflow.mjs` | Runs Level 0 + Level 1 on every seed workflow before writing it to `PGC_Workflow`, as a pre-write guard against shipping a structurally broken seed. Aborts if `PGC_StepType` cannot be read, rather than dropping to Level 1 silently. |
| `troubleshoot-workflow.mjs` | Runs simulation against a registered workflow's current step array to diagnose reported failures. |

## Why simulation is not optional for `create_workflow`

Without simulation, the only way to discover a broken workflow is to deploy it
and run it. Given that `create_workflow` produces workflows that will themselves
execute against real data, an undetected broken step is a production incident.
The `confirmed_domain_help` class of bug — a template reference to a key that
was never written to `local_state` — is invisible to Ajv validation and only
manifests at execution time. Simulation catches it before registration.

## Inputs

Simulation is driven by three structures, typically produced by `create_workflow`'s
LLM generation steps and passed to `runSimulation` (directly via the HTTP endpoint,
or via the `simulate` step type's `steps_key`/`mock_outputs_key`/`paths_key`
dot-paths into `local_state`):

**`steps`** — the workflow step array. Step keys, types, routing values, templates.

**`mock_outputs`** — a plain object keyed by step number. Only steps that produce
output need mocks (`llm_call`, `serv_query`). Steps that are pure side-effects
(`serv_insert`, `notify`, `end`) do not.

```json
{
  "mock_outputs": {
    "1": { "domain": "recipes", "tables": [{ "tableName": "PGD_Recipes", "columns": [] }] },
    "6": { "domainHelp": { "domain": "recipes", "aliases": ["recipe", "recipes"] }, "workflows": [] }
  }
}
```

**`simulation_paths`** — an array of named execution paths. Each path is an ordered
list of decisions — one entry per branch point (gate step, failure point, iterator
outcome). Human gates are simulated by injecting `user_response` and `on_select`
as if the user clicked that option. LLM steps, SERV steps, and `js_transform` steps
are simulated using their mock output. The path terminates when it reaches `end`,
or `cancel`.

```json
{
  "simulation_paths": [
    {
      "path_name": "happy_path",
      "decisions": [
        { "step": "1",  "outcome": "success" },
        { "step": "3",  "outcome": "gate", "user_response": "confirm", "on_select": "step:3d" },
        { "step": "3d", "outcome": "gate", "user_response": "confirm", "on_select": "next" },
        { "step": "4",  "outcome": "gate", "user_response": "confirm", "on_select": "next" },
        { "step": "5",  "outcome": "success" }
      ],
      "expected_terminal": "end"
    },
    {
      "path_name": "user_cancels_at_review",
      "decisions": [
        { "step": "1",  "outcome": "success" },
        { "step": "3",  "outcome": "gate", "user_response": "cancel", "on_select": "cancel" }
      ],
      "expected_terminal": "cancelled"
    },
    {
      "path_name": "llm_step_fails",
      "decisions": [
        { "step": "1", "outcome": "failure", "error": "LLM returned invalid JSON" }
      ],
      "expected_terminal": "cancelled"
    }
  ]
}
```

The LLM is expected to enumerate at minimum: the happy path, one cancel path per
gate step, and one failure path per `llm_call` or `serv_*` step. The `output_schema`
for the `generate_workflow_paths` prompt enforces this minimum coverage.
`mock_outputs` and `simulation_paths` are both optional — when absent, only Level 1,
2a, and 2b run (see below); Level 2c is skipped entirely.

## What the simulator validates

`runSimulation` combines five independent checks. **`result.passed` is determined
by Level 0 + Level 1 + Level 2a + Level 2b.** Level 2c (legacy path execution) still runs
when `simulation_paths` is supplied and its results are returned for diagnostic
display, but does not gate `passed` — see the note on each level below. Checks run
in order; a level only runs if the previous one passed.

The `level` parameter (0, 1 or 2 — default 2) stops the run at a chosen depth. It
replaced the `skeleton: true` flag, which switched four content checks off inside
Level 1 so a routing sketch could be validated: the question that flag was reaching
for is what Level 0 asks directly. `input.skeleton: true` on a `simulate` step is
still accepted and means `level: 0`.

**Level 0 — Shape (`runLevel0ShapeCheck`) — is each element a step of the type it claims?**

Level 1 asks whether a step array is a coherent program. Level 0 asks the question
below that: does each element carry the fields its step type requires. It is
answerable on a sketch, which is why it is the level a content-free routing topology
is validated at.

| Check | Failure class |
|---|---|
| `type` names a live row in `PGC_StepType` | `unknown_step_type` |
| Every field the type's `input_contract` marks `required` is present and non-empty | `missing_required_field` |

Every assertion is **composed from `PGC_StepType.input_contract` and none is written
in the engine**. The contract's `field` names already encode placement —
`input.tableName` sits under the step's `input` object, `gate_type` at the step root —
so a required field is a dot path resolved against the step. Adding a step type, or
making one of its fields required, changes what Level 0 enforces with no code change.
It replaced a hand-written map covering five of the nineteen step types.

Two structural rules qualify it, both stated once rather than as per-type exceptions:

- An iterator's `item_step` is held to the same contract, reported against its
  parent's key (`"6.item_step"`).
- `output_key` is not required *in* an `item_step`: the iterator collects each item's
  return value and writes that array to its own `output_key` on the parent frame, so
  an item's own `output_key` is never read.

The contracts are **passed in, never fetched** — the engine is pure.
`src/proc/step-type-registry.mjs` is the single reader on behalf of validation, used
by all four consumers. When contracts are absent Level 0 returns `ran: false` rather
than passing, and a `level: 0` request that supplied none is an error: a validator
that silently no-ops when its input is missing reads as a pass, which is the failure
mode that produced the Sprint 7 schema-registry defect.

**Level 1 — Static analysis (`runLevel1StaticAnalysis`) — no execution, no mocks needed**

Catches structural errors in the step array itself:

| Check | Failure class |
|---|---|
| Every `on_success`, `on_else`, `on_select` value is a known routing token | Unknown routing value |
| Every `step:N` routing target exists in the step array | Dead routing target |
| Every `{{template}}` reference resolves to an `output_key` written by a prior step | Unresolved template variable |
| Every `items_key` in an `iterator` resolves to an array written by a prior step | Iterator source not an array |
| Every `input.prompt` in an `llm_call` names an `intent_category` in `PGC_Prompt` | Unknown prompt reference |
| No `output_key` is set on a `review_object` or `confirm` gate | Gate type does not write output |
| Every `human_gate` has at least one option with `action: "cancel"` | Missing cancel path |
| `output_key` (step-level or option-level) is a string, not another type | Malformed output_key |

Required-field presence was checked here, from a hand-written map of five step types.
It is a shape assertion, so it moved to Level 0 where it is composed from the registry
and covers all nineteen.

Level 1 failures are returned immediately — no Level 2 checks run.

**Level 2a — Routing matrix (`runRoutingMatrix`) — static graph reachability, no mocks**

Builds an adjacency list from every routing field across all step types (`on_success`,
`on_else`, `on_select`, `on_cancel`, `on_complete`, `on_empty`, `on_error`, resolving
`next`/`step:N`/bare keys to concrete target keys) and checks every step is reachable
from step 1 and every reachable step has a path to `end` or `cancel`. Returns
`{ passed, reachable_count, unreachable_count, issues }`.

**Level 2b — Data-flow trace (`runJsTransformSmokeTest`) — real execution against mock state**

Two things happen in one forward pass over the steps, in document order, sharing one
`mockState` object:

1. *js_transform smoke test* — runs every `js_transform` expression against `mockState`
   via `vm.runInNewContext` (500ms timeout). A syntax error or a `void` return (the
   expression evaluates to `undefined`) is a hard failure. A runtime error against mock
   data is a soft warning (mock state may not match real data shapes). When the
   expression ran cleanly, its real computed result — not a placeholder — is written
   into `mockState[output_key]` so downstream steps see the actual shape the expression
   produces. When it didn't (threw, timed out, or returned `undefined`), a `{}`
   placeholder is written instead and the output key is recorded as **uncertain** —
   see the cascade rule below.
2. *Step-input contract check* (`checkStepInputContracts`, Sprint 7 Track I) — for every
   step, resolves its declared input fields against `mockState` (via `resolveInput`/
   `resolvePath` from `template-resolver.mjs` — the same functions the runtime uses) and
   validates the resolved value's shape against a declarative contract table:
   - `STEP_INPUT_CONTRACTS` (`{{template}}`-resolved `input.*` fields) — `filters` on
     `serv_query`/`serv_update`/`serv_delete` must be a flat array of `{column, op, value}`
     objects; `updates` on `serv_update` and `row` on `serv_insert` must be plain objects;
     `rows` on `serv_insert`/`serv_upsert` must be an array of objects; `matchColumns` on
     `serv_upsert` must be an array of strings. These mirror `table.mjs`'s own runtime
     validators — a mismatch here is a **hard failure**, since the equivalent request
     throws a 400 at runtime today.
   - `STEP_PATH_CONTRACTS` (dot-path fields, not `{{ }}`-wrapped) — `items_key` on
     `iterator` and `context_key` on `human_gate` must resolve to an array. These fall
     back silently at runtime (`?? []`) rather than throwing, so a mismatch here is a
     **soft warning** — it predicts a workflow that quietly does nothing, not a crash.

   This check exists because a `js_transform` can be syntactically valid and still build
   the wrong shape for a downstream step — e.g. mapping each record to its own filter
   array (`[[{...}], [{...}]]`) instead of one flat filter array, which `serv_query`
   rejects at runtime with "each filter must have a column" (diagnosed from run 623).
   Level 1 cannot catch this because the bad value only exists after a `js_transform`
   actually runs; Level 2b catches it by actually running it, against mock data, before
   the workflow is registered.

   **Uncertain-key cascade suppression.** A single forward pass over the step array
   visits every step exactly once — it does not unroll loops. Flat-loop-pattern
   workflows (e.g. testing each of 10 flashcards 3 times before advancing to the next
   subset, then testing all subsets before the results reach a `human_gate`) depend on
   accumulator state that only becomes meaningful after many real iterations; a single
   mock pass frequently can't reconstruct it, causing the accumulating `js_transform` to
   throw against placeholder mock data. When a field's entire value is inherited via a
   bare `{{key}}` reference from a step recorded as uncertain (see above), the shape
   check for that field is **skipped, not failed** — the upstream problem (if real) is
   still visible as that step's own soft warning; the downstream check does not compound
   it into a second, misleading hard failure. Absence of confirmation is not proof of a
   defect — a check that can't determine a shape confidently must not report one.

   Returns `{ passed, steps_tested, issues }`. `passed` is `false` only for hard
   failures (`js_transform_syntax_error`, `js_transform_void_return`, or
   `serv_input_shape_mismatch` without `severity: "warning"`).

**Level 2c — Legacy path execution (`executeSimPath`) — informational, does not gate `passed`**

Runs when `simulation_paths` is supplied. For each named path: resets `local_state` to
`{ input: run.input }`, walks steps in execution order driven by the path's decision
script, injects the mock output or decision at each step instead of calling the real
service or LLM, and records the `local_state` transition log (keys present before, keys
added or mutated after, template variables resolved and to what values). Fails the path
if a template variable is unresolvable or the terminal step doesn't match
`expected_terminal`. Also detects backward-reference loops: a step key reached more times
than there are gate decisions for it is flagged as a potential infinite loop (safe if a
`human_gate` exists on the path from target back to source — the same rule as Guard 3).
`path_results` is returned for diagnostic display (shown to the user on correction) but
`result.passed` is computed from Level 1 + 2a + 2b only — a workflow can pass simulation
and register even if a supplied `simulation_paths` entry fails, and conversely
`simulation_paths` is optional (when absent, `paths_run: 0` and Level 2c is skipped
entirely).

**Level 3 — Skip-path analysis**

Removed. Previously flagged data flow risks for skipped failure-path steps.

## Skeleton drift — translation may not invent steps

`checkSkeletonDrift()` runs inside Level 1 whenever the `simulate` step is given
`input.locked_skeleton_key`.

The routing skeleton is built from `process_design` and BFS-validated *before* any content
is generated. From that moment the step set is **locked**: `generate_workflow_steps` emits
exactly one step per design item and may not add its own. It is a translator, not a designer.

It does not always obey. Run 702 shipped 20 steps from a 15-item design — five `js_transform`
steps ("format X into a markdown display", "parse Y") invented at translation time. That is
not cosmetic. Those steps were never in the graph the skeleton validated, and they arrive
*after* the consolidation critic has reviewed the design — so they are invisible to both. A
step nobody authorised and nobody reviewed is exactly where redundancy accumulates.

The comparison is on the ordered sequence of step **types**, ignoring `end` steps: translation
renumbers `step_label`s to numeric keys (so keys cannot be compared), and the skeleton builder
appends its own `end` even when the design already declared one. Types are sufficient — an
invented step always shows up as an extra type in the sequence.

Deterministic, not heuristic: the design either authorised a step or it did not. A drift issue
fails Level 1 and routes through `create_workflow`'s existing regeneration loop
(25 → 26 → 27 → 22a → 23), naming the added types so the retry can act on them.

The fix for a genuinely missing step belongs in `design_workflow_process` (its
PREPARATION-STEP RULE), never in translation — that is the only stage permitted to add a step.

## Simulation result structure

`static_analysis` is `null` when Level 0 failed and Level 1 never ran — a consumer
reading only that field must treat `null` as a failure, not as an absence of issues.

```json
{
  "passed": true,
  "level": 2,
  "total_issues": 0,
  "paths_run": 3,
  "paths_passed": 3,
  "paths_failed": 0,
  "shape_analysis": { "ran": true, "passed": true, "issues": [] },
  "static_analysis": { "passed": true, "issues": [] },
  "routing_matrix": { "passed": true, "reachable_count": 12, "unreachable_count": 0, "issues": [] },
  "smoke_test": { "passed": true, "steps_tested": 4, "issues": [] },
  "path_results": [
    {
      "path_name": "happy_path",
      "passed": true,
      "steps_executed": 11,
      "terminal": "end",
      "expected_terminal": "end",
      "local_state_transitions": [
        {
          "step": "1",
          "keys_before": ["input"],
          "keys_added": ["proposed_scaffold"],
          "template_vars_resolved": {},
          "template_vars_missing": []
        }
      ]
    }
  ],
}
```

On failure, `passed: false`. `routing_matrix.issues` and `smoke_test.issues` carry the
Level 2a/2b failures (including `serv_input_shape_mismatch`); `path_results` carries the
Level 2c diagnostic detail when `simulation_paths` was supplied — the first failed path's
transition log shows exactly which step failed and what `local_state` contained at that
point. When invoked via the `simulate` step type inside `create_workflow`, this is
presented to the user in the `review_object` gate when `on_else: "step:3"` routes back
for correction.

## Simulation mode flag on WorkflowRun

When `run-workflow.mjs` executes a `simulate` step, it sets
`PGC_WorkflowRun.state.simulation_mode = true` before the simulation begins and
clears it after. This flag is checked by every step handler in `step-executor.mjs`
— when true, the handler returns the mock output from the decision script instead
of calling the real service. No new Lambda, no new SQS queue — the same Step
Processor executes both live runs and simulations. The only difference is the
execution context. This mechanism only applies to the `simulate` step type path;
the standalone HTTP endpoint below never touches `PGC_WorkflowRun` at all.

## HTTP endpoint

`POST /api/v1/proc/simulate-workflow` accepts the step array, mock outputs, and
simulation paths directly, without a `WorkflowRun`. This is the developer-facing
test surface for validating workflow definitions during development, before they
are registered in `PGC_Workflow` — and the surface Novia's `simulate_workflow` tool
calls directly, independent of any `create_workflow`/`fix_workflow` run. See
openapi.yaml for the full request/response contract.
