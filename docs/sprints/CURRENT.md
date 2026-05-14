# Sprint 2 — create_workflow Reliability

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

### Track B — create_workflow Domain Context

`create_workflow` currently runs with `domain: null` throughout — the right brain has
no domain schema to reason about. This prevents it from generating steps that reference
actual PGD table columns, and prevents domain-specific preference questions.

1. **Resolve domain before dispatch** — in `classify-intent.mjs` (or the mind.mjs
   pre-pass), resolve the domain name from the user's intent and inject it into the
   CREATE_WORKFLOW SQS payload so `input.domain` is populated.

2. **Inject domain_schema into research step** — `research_workflow_domain` receives
   only `workflow_description` and `domain` (null). Add `domain_schema` (the full
   PGD table column map for that domain) as an input variable so the right brain can
   surface domain-specific preference questions (e.g. "which column holds the Spanish
   word?").

3. **`research_workflow_domain` prompt update** — update prompt to use `domain_schema`
   input and instruct the right brain to derive field references from actual column
   names, not guesses.

4. **`POST /api/v1/proc/delete-workflow` endpoint** — new HTTP + SQS (`DELETE_WORKFLOW`)
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

1. **Condition routing contract** — L1 currently applies generic `ROUTING_TOKEN_RE` to
   `on_truthy`/`on_falsy`. A value of `"next"` or `"cancel"` passes L1 silently but
   becomes a dead target at runtime (`executeCondition` prefixes it to `"step:next"`).
   Fix: condition-specific L1 check — values must be bare step keys that exist in
   `stepKeys`, not routing tokens.

2. **Nested template detection** — `{{quiz_state.cards.{{quiz_state.index}}.term}}`
   passes L1 but fails at runtime. Fix: scan all string fields for
   `/\{\{[^}]*\{\{/`, raise `unsupported_handlebars_syntax`.

3. **`reveal` field in step_type_contracts** — `PGC_SystemContext.step_type_contracts`
   and `seed_PGC_StepType.json` must document the `reveal` optional field on
   `human_gate` so that `generate_workflow_steps` LLM knows to use it. Without this
   the LLM cannot generate a gate with `reveal`.

4. **Additional L1 gaps** — any other L1 defects surfaced during flashcard quiz test
   runs are in scope for this track.

**L2 gaps to close:**

5. **Iterator body simulation** — L2 currently treats `iterator` as a single step that
   writes an empty array and jumps to `on_complete`, skipping body steps entirely. For
   the flashcard quiz, the human gates and score-tracking steps inside the iterator are
   never exercised in simulation — so the quiz's core logic is invisible to L2. Fix:
   when L2 encounters an `iterator` step, enter the body and simulate at least one
   iteration using the path's decision entries for those body-step keys. After decisions
   are exhausted or the loop-visit cap is hit, exit via `on_complete`. The body's
   `localState` writes (e.g. `score`, `answer`) must be visible to subsequent steps.

6. **`reveal.content` template resolution in L2** — L1 checks that `reveal.content` is
   a non-empty string, but does not verify that any `{{template}}` tokens inside it
   resolve to available `localState` keys at path execution time. Fix: L2 path execution
   must treat `reveal.content` the same as `message_template` — extract template refs
   and fail the path if any base key is missing from `localState` at that point.

7. **Additional L2 gaps** — any other L2 path execution defects surfaced during
   flashcard quiz simulation runs are in scope for this track.

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

**Track B — create_workflow domain context**
- [ ] `create_workflow` run for Spanish flashcard quiz: `input.domain` is populated
  (not null) by the time the workflow executes
- [ ] `research_workflow_domain` receives `domain_schema` and surfaces domain-specific
  preference questions about the flashcard table columns
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
