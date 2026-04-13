# evolving-mind-ai — Session 22 Handoff

**Date:** 2026-04-13  
**Git tag:** `v3.2-local-state-sandbox-builtins-removed` (unchanged — no deploy this session)  
**Last session:** 21 — create_workflow L/R collaboration architecture designed and seeded; PGC_SystemContext injection in executeLlmCall; domain resolution fix for CREATE_WORKFLOW dispatch; step type seed and upsert tooling  

---

## Session 21 completion status

Session 21 pivoted from the original "run create_workflow against the quiz" plan into a
full architectural redesign of `create_workflow` based on the Left Brain / Right Brain
collaboration model and the Gap Taxonomy. This was the right call — running the old v2
against the quiz would have exposed fundamental design limitations that the new architecture
resolves correctly.

**All design, seed, and tooling work is complete. Nothing has been deployed or tested yet.**
Session 22 begins with deployment and end-to-end testing.

---

## Files changed this session

| File | Change |
|---|---|
| `src/proc/step-executor.mjs` | `executeLlmCall`: PGC_SystemContext injection — loads context rows, filters on `inject_always` or `inject_for.includes(intentCategory)`, merges into substitution map before prompt_text reduction. `step.input` values take precedence over context rows. |
| `src/proc/classify-intent.mjs` | `wrap()` helper now returns `{ result, entitySchemaRows, domainRows }`. `handle()` destructures and passes `domainRows` to `handoff()`. `handoff()` signature updated. Heavy-lift branch: when `sqsType === 'CREATE_WORKFLOW'` and `domain` is null, runs `matchDomainAlias(userInput, domainRows)` to resolve domain from user's free text. `domain` field added to `enqueueWorkflow` message. |
| `src/serv/templates/pgc/seeds/seed_PGC_Workflow.json` | `create_workflow` replaced at **v4** — 22 steps, L/R collaboration architecture (5 phases). All other 7 workflows unchanged. Step 12 `example` placeholder key removed so SystemContext injection works. |
| `src/serv/templates/pgc/seeds/seed_PGC_Prompt.json` | Three new prompts: `research_workflow_domain` v1 (Perplexity sonar), `analyze_and_design_workflow` v1 (Sonnet), `generate_workflow_steps` v2 (Sonnet — implements a spec, not a designer). All 11 existing prompts carried forward byte-identical. |
| `src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json` | 7 rows total. Three updated: `step_type_contracts` v4 and `create_domain_example` v5 — `analyze_and_design_workflow` added to `inject_for`. Four new rows: `step_usage_patterns`, `runtime_bindings`, `template_syntax`, `workflow_constraints`. |
| `src/serv/templates/pgc/seeds/seed_PGC_StepType.json` | **New file** — 16 live step type rows sourced from live DB. `js_transform` description corrected (removes stale `transform_type` built-in references, documents `local_state` binding, marks `input_key` required). `human_gate` `output_key` clarified. `condition` `on_truthy`/`on_falsy` bare-key warning added. `iterator` `execution_mode` added as required field. |
| `dev_scripts/upsert-system-context.mjs` | **New script** — upserts `PGC_SystemContext` rows via SERV API. Matches on `key`. Pattern: upsert-prompt.mjs. |
| `dev_scripts/upsert-step-type.mjs` | **New script** — upserts `PGC_StepType` rows via SERV API. Matches on `step_type`. Always overwrites (contracts are authoritative in seed file). |
| `src/serv/init-brain.mjs` | Added `seedStepType` import, Step 11 call `seedPGCStepType()`, and `seedPGCStepType` function using `ON CONFLICT (step_type) DO UPDATE SET`. Step 10 `seedPGCSystemContext` already present from prior session. |
| `docs/architecture.md` | Section 6.8: gap taxonomy retrospective for `create_domain`. Section 6.9: full replacement with `create_workflow` v3/v4 L/R architecture, five-phase step structure, gap taxonomy applied table, prompt dependencies, implementation notes. Section 6.11 (new): Gap Taxonomy reusable design pattern — five gap types, resolution sequence, ownership table, design rules, application to future `create_*` workflows. Section 4.3.7: updated with `upsert-step-type.mjs` and `upsert-system-context.mjs` entries, corrected env var from `PGC_DATABASE_URL` to `SERV_API_URL`, `upsert-workflow.mjs` argument requirement noted, stale `seed_PGC_StepType.mjs` and `seed_PGC_SystemContext.mjs` entries replaced. |

---

## Deploy checklist — must be done before testing

These must be run in order. Nothing has been deployed from this session yet.

```cmd
sam build && sam deploy

node dev_scripts/upsert-workflow.mjs create_workflow

node dev_scripts/upsert-prompt.mjs research_workflow_domain analyze_and_design_workflow generate_workflow_steps

set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-system-context.mjs

set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-step-type.mjs
```

Note: `upsert-step-type.mjs` must run before `upsert-system-context.mjs` if `step_type_contracts`
needs to reflect any contract changes — but since we are seeding from live data the order does
not matter for this first run.

---

## Session 22 primary goal: first run of create_workflow v4

### Test case: Spanish vocabulary quiz

```
/m create workflow Spanish vocabulary quiz
```

This exercises the full pipeline:

1. `classify-intent.mjs` — should route `CREATE_WORKFLOW` with `domain: "spanish_flashcards"` now that the alias lookup fix is deployed
2. Step 1 — `serv_query PGC_Schema` filters by `input.domain` — should return `PGD_Flashcards`, `PGD_FlashcardSets` schema rows
3. Step 2 — `research_workflow_domain` (Perplexity sonar) — retrieves flashcard/vocabulary learning best practices. Verify `right_brain_research.preference_questions` contains meaningful questions (e.g. eval method, loop behaviour)
4. Steps 3–5 — Tier 1 preference gate iterator — user answers preference questions in Slack. Verify each gate renders correctly and selections accumulate in `user_preferences`
5. Step 6 — `serv_query PGC_StepType` — verify returns 16 rows
6. Step 7 — `analyze_and_design_workflow` (Sonnet) — receives domain schema + research + preferences + step type contracts. Verify `design_spec` contains: complete `process_design`, correct `state_map` with `quiz_state`, `current_card`, `user_answer`, `eval_result`, `prompts_needed` with `evaluate_translation` (exists: false + prompt_text), `schema_changes` for `PGD_QuizResults` (blocking: false)
7. Steps 8–10 — routing flags and schema gap gate — user should see the non-blocking schema gap gate for `PGD_QuizResults`; choosing "Build without it" should continue
8. Steps 11a–11c — `evaluate_translation` prompt seeded from `design_spec.prompts_needed` — verify row appears in `PGC_Prompt`
9. Step 12 — `generate_workflow_steps` v2 — translates `design_spec` to step array. Review draft in step 13 gate — verify flat loop pattern: `serv_entity_query`, `js_transform` shuffle/init, `condition`, `js_transform` pick-card, `human_gate confirm` (flip), `human_gate text_input` (answer), `llm_call evaluate_translation`, `js_transform` update-score, `human_gate confirm` (result + Next/Finish)
10. Steps 14–17 — Level 1 static analysis, mock generation, path generation, Level 2+3 simulation. If simulation fails, routes back to step 13 review gate with failure context
11. Steps 18–21 — user confirms registration, workflow and intent map rows inserted, notify

### What to watch for

**Step 1 domain resolution** — If `input.domain` is null, the `serv_query` filter returns all PGC_Schema rows (or fails). Check CloudWatch for `CREATE_WORKFLOW domain resolved from alias lookup` log line. If absent, the `classify-intent.mjs` fix did not deploy correctly.

**Step 2 sonar call** — Perplexity sonar must respond with valid JSON matching `research_workflow_domain` output_schema. First failure point. If it fails, `on_failure: next` means the left brain proceeds without research — watch for `right_brain_research` being null or empty in step 7.

**Step 7 design_spec quality** — This is the most important gate to inspect. Read the `design_spec` output in CloudWatch or via a `PGC_WorkflowRun` state query. Key things to verify:
- `process_design` covers the full quiz loop
- `state_map` includes `quiz_state` (cards, index, score), `current_card`, `user_answer`, `eval_result`
- `prompts_needed` includes `evaluate_translation` with `exists: false` and a complete `prompt_text`
- `schema_changes` includes `PGD_QuizResults` with `blocking: false`
- `confidence` is `needs_schema` (for the non-blocking gap) or `complete`

**Step 12 generated steps** — Review carefully at the step 13 gate. Check:
- `condition` step uses bare step keys on `on_truthy`/`on_falsy` (not `step:N`)
- `iterator` has `execution_mode: sequential` — if absent the LLM missed the workflow_constraints context
- `text_input` gate has `output_key` set and no `context_key`
- `js_transform` expressions are IIFEs, not bare expressions
- Backward reference from loop anchor gate goes to the card-pick step, and a `human_gate` exists between them

**Level 1 simulation failure** — Most likely causes: a `condition` step with `on_truthy: "step:3"` instead of `"3"`, or a `human_gate` missing cancel option. Both are caught by Level 1 static analysis. User sees them at step 13 review gate. The LLM should regenerate correctly on the second pass since `workflow_constraints` context is now injected.

**SystemContext injection verification** — Before testing, confirm injection is working with a curl to run a test llm_call step and check CloudWatch that `executeLlmCall` logs show the context rows being applied. Alternatively, inspect a `PGC_WorkflowRunStep` output_snapshot after step 12 completes to see if `step_type_contracts` was present in the resolved prompt.

---

## Known gaps and deferred items entering Session 22

### Must fix before quiz end-to-end works

None identified — all known blockers were addressed this session. The domain resolution fix, the `example` placeholder removal, and the SystemContext injection are all deployed together.

### To verify during testing

**`create-workflow.mjs` reads `req.body.domain`** — This file was not uploaded this session. The assumption is that it reads `req.body.userInput` and `req.body.domain` when creating the `PGC_WorkflowRun` and building `run.input`. If `input.domain` is null in the WorkflowRun despite the `classify-intent.mjs` fix, inspect `create-workflow.mjs` to confirm it passes `domain` through to the run input.

**Tier 1 preference gate iterator with `human_gate` item_step** — The `create_workflow` step 5 iterator has `item_step.type: "human_gate"`. This is the first time an iterator drives `human_gate` steps. The iterator pushes a human_gate frame for each item; the resume_gate path must correctly pop the gate frame and advance the iterator to the next item. Verify in the first preference question gate interaction.

**`generate_workflow_paths` output schema mismatch** — The bak `generate_workflow_paths` output schema wraps in `{ simulation_paths: [...] }`. The step 16 mock generation and step 17 Level 2 simulation depend on this shape being consistent. If simulation fails at Level 2 with a schema error, check whether `generate_workflow_paths` produces `{ simulation_paths: [...] }` (old schema) or a bare array (the new schema in the updated seed). The live DB has the old schema (v1 row was preserved unchanged from bak).

---

## Backlog items from Session 21 (carried forward)

| Item | Priority | Notes |
|---|---|---|
| `orderBy` field in `PGC_EntitySchema` | Low | Add `display_order_column`; `list_entity` reads it when present; `create_domain` step 6 populates from first non-system non-FK column |
| `PGC_Schema` migration discipline | Medium | Every `ALTER TABLE` on PGC table must be paired with `UPDATE PGC_Schema SET columns = columns \|\| '[{...}]'` |
| `toEntityName()` dead code in `classify-intent.mjs` | Low | Remove once all domains recreated with `domain` column populated |
| Word-boundary regression test | Low | Add to `classify-intent-tiers.test.mjs` (template in Session 21 handoff) |

## New backlog items from Session 22

| Item | Priority | Notes |
|---|---|---|
| `create_domain` v9 — L/R architecture | Low | Right-brain research pass + Tier 1 preference gates before LLM call. Deferred until right-brain improvement loop is running. Only Type 5 (duplicate domain detection) fix is worth doing sooner — single `serv_query` pre-check step. |
| `create-workflow.mjs` domain pass-through | High | Confirm this file passes `req.body.domain` into `PGC_WorkflowRun.input.domain`. If not, `input.domain` is null despite the `classify-intent.mjs` fix and step 1 `serv_query` filter returns wrong results. Inspect and fix if needed before Session 22 testing. |
| `PGC_SystemContext.step_type_contracts` stale in DB | Medium | Live DB has old `js_transform` description referencing removed `transform_type` built-ins. `upsert-step-type.mjs js_transform` + `upsert-system-context.mjs step_type_contracts` fixes it. Both scripts now exist. Add to Session 22 deploy checklist. |
| Type 5 ambiguity pre-check in `create_workflow` | Low | A pre-step clarification gate when `input.userInput` is too vague to research. Not needed for the quiz test case but needed for general-purpose workflow creation. |
| Sub-workflow return-to-caller after `create_domain` | Backlog | When schema gap gate suggests "create domain first", returning to `create_workflow` after `create_domain` completes requires sub-workflow dependency tracking. Deferred until sub_workflow step type lands. |
| `generate_workflow_paths` schema consistency | Medium | Verify live DB `generate_workflow_paths` v1 output_schema shape matches what `executeSimulate` Level 2 expects. Live row uses `{ simulation_paths: [...] }` wrapper. Session 22 testing will surface this if it's wrong. |

---

## Key files needed at Session 22 start

```
src/proc/create-workflow.mjs           — verify domain pass-through to PGC_WorkflowRun input
src/proc/step-executor.mjs             — verify SystemContext injection is in deployed version
src/proc/classify-intent.mjs           — verify domain alias lookup fix is in deployed version
src/proc/run-workflow.mjs              — verify human_gate iterator item behaviour
```

Share via raw GitHub URLs or attach directly.

---

## Architecture decisions made this session (summary for architecture.md git tag)

1. **L/R collaboration model** — Right brain researches first (Perplexity sonar, no dependency on left brain). User answers Tier 1 preference questions between right brain and left brain. Left brain produces `design_spec`. Step generator translates spec.

2. **Gap taxonomy** (Section 6.11) — Five gap types formalised: Preference (user), Knowledge (right brain), Schema non-blocking/blocking (user), Missing prompt (left brain auto-seeded), Missing step type (developer hard stop), Ambiguity (user pre-check). Resolution order is mandatory. Applies to all future `create_*` workflows.

3. **PGC_SystemContext injection in executeLlmCall** — Context rows injected automatically based on `inject_for` matching `intentCategory`. `step.input` values take precedence. `example` key removed from step 12 input to unblock injection.

4. **Left brain writes missing prompts inline** — `analyze_and_design_workflow` includes `prompt_text` for `exists: false` entries in `prompts_needed`. Auto-seeded before step generation. Eliminates manual seeding prerequisite.

5. **Domain resolution fix for CREATE_WORKFLOW** — Pass 1 heavy-lift match sets `domain: null`. `handoff()` now runs `matchDomainAlias` on `userInput` for `CREATE_WORKFLOW` when domain is null. `domain` flows through SQS message to `create-workflow.mjs`.

6. **`PGC_StepType` seed and upsert tooling** — `seed_PGC_StepType.json` authored from live data. `upsert-step-type.mjs` follows same pattern as other upsert scripts. `seedPGCStepType` added to `init-brain.mjs` bootstrap with `ON CONFLICT DO UPDATE` (contracts are authoritative, unlike prompts).
