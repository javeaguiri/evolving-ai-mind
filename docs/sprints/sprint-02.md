# Sprint 2 — create_workflow Reliability

**Outcome:** Partial success — Track C (simulation enrichment) and the end-to-end test vehicle completed; Track A (create_domain L/R brain) and Track B (delete-workflow) deferred to Sprint 3. Closed 2026-05-22.

**Branch:** `sprint/02-create-workflow-reliability` — merged/deployed to prod.

## Outcome Notes

**What shipped:**
- **Track A** — `create_domain` L/R brain pipeline complete: duplicate domain pre-check (step 2-4, `serv_query PGC_DomainHelp` + condition + confirm gate), right-brain research step (step 5, `research_domain_schema` prompt via Perplexity sonar), preference gate iterator (step 9), updated left-brain call with `research_findings` (step 10).
- **Track B** — `POST /api/v1/proc/delete-workflow` endpoint: `src/proc/delete-workflow.mjs` wired into PROC and Slackbot handlers; cascading delete of PGC_WorkflowRunStep, PGC_WorkflowRun, PGC_IntentMap, PGC_Workflow.
- **Track C** — Simulation enrichment complete (items 1–12). Routing matrix (`runRoutingMatrix`) + js_transform smoke test (`runJsTransformSmokeTest`) replace broken L2 path execution. `result.passed = routingMatrix.passed && smokeTest.passed`.
- **Prompt fixes** — `generate_workflow_steps` v22: routing token format rule; `{{#if}}`, `{{/if}}`, `{{else}}` explicitly banned; js_transform ternary pattern for conditional content. L1 iterator-scope false positive fixed (option fields with `iterator` skip the unresolved-key check).
- **Test vehicle** — `create_workflow` generates a working flashcard quiz workflow end-to-end in prod (run 365 completed). Generated workflow passed L1 + L2 after one `fix_workflow_routing` pass.
- 246 unit tests pass.

**What didn't ship:**
- Nothing deferred from original scope.

**Retro findings → backlog:**
- `generate_workflow_steps` and `fix_workflow_routing` maintain parallel copies of CRITICAL ROUTING RULES — any drift between them causes bugs (seen twice this sprint). Deduplicate to `PGC_SystemContext` inject_for.
- `{{#if}}` ban needs to be in both the prompt AND the L1 error message — LLM keeps reaching for it because the js_transform ternary pattern is unfamiliar. A concrete example in the correction prompt would help.

---

**Goal:** Make `create_workflow` produce a working workflow end-to-end, using a Spanish
flashcard quiz as the test vehicle. Success is: the user runs `create_workflow` for a
freshly created flashcard domain, the generated workflow uses `reveal` on its human gates,
and it runs correctly in prod with no L1/runtime failures.

**Branch:** `sprint/02-create-workflow-reliability`

---

## Scope

### Track A — L/R Brain Pattern for create_domain

Apply the reusable R/L brain design pattern (see `docs/architecture.md` §6.11 and
`docs/create-domain-design.md` Target Design section) to the `create_domain` workflow.
`create_domain` currently invokes the left brain directly from raw user input — no right
brain research pass, no pre-design preference gates. This produces schemas that reflect
LLM guesses rather than stated user choices and domain best practice.

The target design (create_domain v9) adds a pre-generation pipeline before the existing
step 1 LLM call:

1. **Duplicate domain pre-check** — `serv_query PGC_DomainHelp` before step 1. If
   domain exists: `human_gate` offering update aliases / recreate / cancel (Type 5 gap).

2. **Right brain research step** — `llm_call research_domain_schema` (Perplexity sonar).
   Input: `userInput` + inferred domain category. Retrieves data modelling best practices,
   canonical table structures, normalisation patterns. Surfaces Type 1 preference questions
   where the answer changes schema structure.

3. **Preference gate iterator** — `condition` on whether research found preference
   questions → `iterator` of `human_gate choice` steps, one per preference question.
   User picks from structured options derived from research, not a blank field.

4. **Left brain call updated** — existing step 1 `llm_call create_domain` now receives
   `userInput` + research findings + confirmed preferences. Steps 2–12 unchanged.

Prompts needed: `research_domain_schema` (new, right brain). `create_domain` prompt
updated to accept and use research + preference inputs.

### Track B — delete-workflow Endpoint

1. **`POST /api/v1/proc/delete-workflow` endpoint** — new HTTP + SQS (`DELETE_WORKFLOW`)
   endpoint that removes a single named workflow and all its associated artifacts.
   Mirrors the cascading delete pattern in `delete-domain.mjs`.

   Deletion order (FK-safe — same constraint set as delete-domain):
   - Fetch `PGC_Workflow.id` by `name` (or reject 404 if not found)
   - Fetch all `PGC_WorkflowRun.id` rows where `workflow_id = <id>`
   - Delete `PGC_WorkflowRunStep` rows where `run_id IN (<run ids>)`
   - Delete `PGC_WorkflowRun` rows where `workflow_id = <id>`
   - Delete `PGC_IntentMap` rows where `workflow_id = <id>` (FK — cleaner than
     the LIKE-pattern approach delete-domain uses)
   - Delete `PGC_Workflow` row where `id = <id>`

   New file: `src/proc/delete-workflow.mjs`. Registration:
   - `openapi.yaml` — spec-first rule applies, add entry before coding
   - `src/proc/handler.mjs` — one `if (message.type === 'DELETE_WORKFLOW')` block in
     `processSqsBatch` and one `case 'delete-workflow':` in `dispatch()`
   - `template.yaml` is NOT touched — the PROC Lambda uses a `{proxy+}` catch-all
   Add `DELETE_WORKFLOW` to the SQS fire-and-forget category in `docs/architecture.md`.

### Track C — Simulation Enrichment

Enrich both L1 static analysis and L2 path execution to catch the failure
modes that cause generated workflows to fail during runtime. Driven by what
fails during flashcard quiz workflow at creation-time and run-time, and 
when create-domain and create-workflow fails during run-time and/or pass through 
Level 1 simulation in upsert-workflow during Track A and B development.

Note: Level 3 (skip-path analysis) was removed; this track covers L1 + L2.

**L1 gaps to close:**

1. **Condition routing contract** ✅ DONE — `condition_routing_invalid` check added to
   `simulation-engine.mjs`. `on_truthy`/`on_falsy` values that are control tokens
   (`next`, `end`, `cancel`) or `step:N`-prefixed now fail L1 with
   `failure_class: condition_routing_invalid`. Bare step keys in `stepKeys` are the
   only valid values.

2. **Bare step key routing — L1 + runtime** ✅ DONE (surfaced by routing standardisation
   session) — Three gaps closed together:
   - `ROUTING_TOKEN_RE` in `simulation-engine.mjs` did not accept bare step keys for
     `on_success`/`on_failure`/`on_select`/`on_complete`; dead-target check only handled
     `step:N` targets. Both updated.
   - `resolveNextStep` and `resolveOnSelect` in `run-workflow.mjs` treated bare step
     keys as "next" (advance to next array entry) instead of jumping to the named step.
     Fixed: any token matching an existing step key is treated as a direct jump.
   - `workflow-schema.json` `routingToken` pattern required `step:N` format; updated
     to also accept bare step keys.

3. **PGC routing context inconsistency** ✅ DONE (surfaced by routing standardisation
   session) — `routing_value_rules` v7 stated `step:N` is mandatory and bare keys are
   wrong. `step_type_contracts` condition entry said `step:N`. `step_usage_patterns`
   preference gate iterator example used `step:C`/`step:D`. All corrected to bare keys
   as canonical (routing_value_rules v8, step_type_contracts v14, step_usage_patterns v7,
   PGC_StepType condition entry updated). Duplicate routing rules removed from
   `design_workflow_dialogs`, `design_workflow_process`, `generate_workflow_steps`
   prompts — content now lives in PGC_SystemContext only.

4. **`serv_query` output shape missing from PGC_StepType** ✅ DONE — output_contract
   updated in `seed_PGC_StepType.json` and `step_type_contracts` SystemContext. Confirmed
   deployed (fingerprint match verified 2026-05-17).

5. **`llm_call` input-to-prompt binding not documented** ✅ DONE — `input.*` binding
   contract added to `llm_call` input_contract in `seed_PGC_StepType.json`. Confirmed
   deployed (fingerprint match verified 2026-05-17).

6. **Nested template detection** ✅ DONE — `unsupported_handlebars_syntax` L1 check
   added to `simulation-engine.mjs`. Confirmed deployed.

7. **`reveal` field in step_type_contracts** ✅ DONE — `reveal` field documented in
   `human_gate` input_contract in both `seed_PGC_StepType.json` and `step_type_contracts`
   SystemContext v15. Confirmed deployed (fingerprint + version match verified 2026-05-17).

8. **Additional L1 gaps** — any other L1 defects surfaced during flashcard quiz test
   runs are in scope for this track.

**L2 gaps to close:**

9. **Iterator body simulation** ✅ DONE — L2 now enters iterator body and simulates one
   iteration. Confirmed deployed.

10. **`reveal.content` template resolution in L2** ✅ DONE — L2 validates `reveal.content`
   template variables against `localState` at suspension time. Confirmed deployed.

11. **Additional L2 gaps** — any other L2 path execution defects surfaced during
   flashcard quiz simulation runs are in scope for this track.

12. **`create_workflow` seed fails L1 — step 23 unresolved templates** 🔴 NEW FINDING
   (surfaced by upsert-workflow.mjs fingerprint check on 2026-05-17). Step 23 references
   four keys that are not written by any prior step:
   - `{{user_workflow_feedback}}` — not in available keys at step 23
   - `{{static_analysis_result}}` — not in available keys at step 23
   - `{{draft_workflow.steps}}` — not in available keys at step 23
   - `{{simulation_error_summary}}` — not in available keys at step 23
   The workflow was **not upserted** — DB is still running the previous version. Must
   investigate step 23 and identify which prior step(s) should write these keys (or
   whether step 23 input bindings reference the wrong key names). Fix before running
   the flashcard quiz test vehicle.

### Test Vehicle — Spanish Flashcard Quiz

A new flashcard domain will be created fresh via `create_domain` at the start of
testing. `create_workflow` is then run against that domain to generate the quiz workflow.
The generated workflow must:

- Iterate over flashcard rows (one human gate per card)
- Show the Spanish term as the question
- Use a `reveal` field on the gate to surface the English definition / mnemonic inline
  (as an inline `task_card` above the answer choices)
- Present multiple-choice answer options
- Track score across iterations
- Show a summary at the end

This is the acceptance vehicle — not a seeded workflow. It must be generated by
`create_workflow` from a natural language description.

---

## Out of Scope

- Task 9: `analyze_and_design_workflow` field name validation (separate validation task)
- `PGC_WorkflowRun.session_id` FK migration
- Workflow safety guards (velocity detector, cycle detector)
- `capability_call` step type
- Prompt improvements to `fix_workflow_steps` (return only changed steps)

---

## Acceptance Criteria

**Track A — create_domain L/R**
- [ ] `create_domain` pre-checks for duplicate domain before running LLM
- [ ] Right brain research step runs before left brain schema generation
- [ ] Preference gates surface from research output; user answers before schema is designed
- [ ] Left brain receives research findings + confirmed preferences; produces schema
  implementing known choices, not guesses

**Track B — delete-workflow endpoint**
- [ ] `POST /api/v1/proc/delete-workflow` deletes PGC_WorkflowRunStep, PGC_WorkflowRun,
  PGC_IntentMap, and PGC_Workflow rows for the named workflow; returns 404 for unknown
  names; openapi.yaml and architecture.md updated before implementation

**Track C — simulation enrichment**
- [ ] L1 rejects `on_truthy`/`on_falsy` values that are routing tokens (`"next"`,
  `"cancel"`, `"end"`) or `step:N`-prefixed — must be bare step keys in `stepKeys`
- [ ] L1 raises `unsupported_handlebars_syntax` for nested `{{...{{...}}...}}` patterns
- [ ] `PGC_StepType` + `PGC_SystemContext.step_type_contracts` document the `reveal`
  field so the generation LLM knows to use it
- [ ] L2 enters iterator body for at least one iteration — body-step human gates and
  state writes are exercised, not skipped
- [ ] L2 validates `reveal.content` template variables against `localState` at path
  execution time (same as `message_template`)

**End-to-end (test vehicle)**
- [ ] Fresh flashcard domain created via `create_domain` using the new L/R pipeline
- [ ] Generated flashcard quiz workflow passes L1+L2 simulation with 0 issues
- [ ] Generated flashcard quiz human gate uses `reveal` (inline `task_card` with the
  English definition shown above the answer choices)
- [ ] Flashcard quiz runs end-to-end in prod: cards iterate, reveal renders, score
  tracked, summary shown
- [ ] `node --test tests/unit/*.test.mjs` passes

---

## Sprint Close Checklist

- [ ] Unit tests pass
- [ ] L1+L2 simulation pass on generated flashcard quiz workflow
- [ ] `CLAUDE.md` Current State updated
- [ ] `docs/architecture.md` updated (L/R pattern in create_domain, condition L1 contract,
  nested template check, domain injection, reveal in step_type_contracts)
- [ ] `docs/create-domain-design.md` updated if create_domain step flow changes
- [ ] `docs/data-architecture.md` updated if any schema changes
- [ ] `docs/backlog.md` updated — Task 11 marked done (post-write L1 completed Sprint 1);
  new items added
- [ ] This file renamed to `docs/sprints/sprint-02.md` with outcome notes
