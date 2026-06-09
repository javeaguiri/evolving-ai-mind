# Sprint 4 — Memory Bridge + Skeleton-First Generation

**Sprint 3 closed 2026-05-31. See `docs/sprints/sprint-03.md` for retro.**

**Branch:** `sprint/04-memory-bridge-skeleton` — create at sprint open.

**Duration:** ~1 week (target close: 2026-06-08)

---

## Carry-in from Sprint 3 (complete before sprint implementation begins)

- [ ] `docs/architecture.md` — add memory layer: `memory-client.mjs`, `llm-harness.mjs`, `memory-writer.mjs`, `MEMORY_WRITE` SQS type, `write_memory` step type
- [ ] `docs/data-architecture.md` — add `PGC_Memory` table schema, `memory_config` column on `PGC_Prompt`
- [ ] `README.md` — update for Sprint 3 additions

---

## Sprint Goal

Close the memory bridge between `create_domain` and `create_workflow` so that schema decisions, initial-value conventions, and design rationale written during domain creation reliably inform workflow generation on the first attempt. Simultaneously introduce skeleton-first routing validation into `create_workflow` to eliminate the class of routing bugs caused by simultaneous routing + content generation.

---

## Acceptance Criteria

- **AC1 — Memory provenance:** `create_domain` writes episodic memory before user confirmation and semantic memory after. The saved_to_memory flag no longer writes pre-confirmation LLM reasoning as semantic. Confirmed by inspecting `PGC_Memory` rows after a domain creation run.
- **AC2 — Memory bridge (B AC3):** Delete and recreate the flashcard domain, then run `create_workflow quiz_flashcards`. The LLM prompt log must show the injected domain memory block. The generated workflow must handle null `next_review_date` correctly on first attempt with no manual correction.
- **AC3 — Initial-value conventions:** `create_domain` captures DEFAULT expressions and application-level initial-value conventions (e.g. `ease_factor = 2.5`) in `PGC_Memory` at confirmation time. `serv_entity_insert` and `add_entity` prompts receive and apply them.
- **AC4 — Domain propagation:** Audit complete. Every system boundary where `domain` is passed has an assertion or documented guarantee that it is non-null. At least one new unit test per boundary point added.
- **AC5 — Routing skeleton:** `design_workflow_process` output extended with per-step `routing` fields. A `js_transform` step derives a JSON routing skeleton. L1/BFS runs on the skeleton before `design_workflow_dialogs` and `generate_workflow_steps` run. A workflow with an invalid routing skeleton never reaches step generation.
- **AC6 — IntentMap phrasing:** `create_workflow` presents a `text_input` gate asking for invocation phrases. The pattern written to `PGC_IntentMap` is a `|`-joined regex of the user's phrases (lowercased, trimmed). Validated by running the new workflow from Slack using one of the provided phrases — it matches Pass 1a with no Tier 2 LLM call.
- **AC7 — fix_workflow post-write L1:** After `fix_workflow` writes to `PGC_Workflow`, a `simulate` Level 1 step runs on the written steps. A workflow with dead routing targets returns a 422 and is not persisted.
- **AC8 — session_id column:** `PGC_WorkflowRun.session_id nullable integer` column exists. No FK constraint (PGC_Session not yet bootstrapped). Registered in `PGC_Schema`.

---

## Out of Scope

- PGC_Session table creation and session chat (Sprint 5+)
- pgvector semantic intent matching — the right long-term solution for invocation phrasing; blocked on embedding population at workflow registration. Noted in backlog for Sprint 5+.
- History threading (Track H) — Sprint 5
- Richer episodic memory content — medium priority, no AC dependency
- Stack overwrite race condition (`PGC_WorkflowRunLock`) — separate sprint
- Novia Mode 4 agentic loop — Sprint 5
- Backlog item 9 (`analyze_and_design_workflow` v10 fix) — confirm obsolete if v4 workflow with separate `analyze_workflow_gaps` + `design_workflow_process` prompts is what's running in prod; close item at sprint open

---

## Tracks

### Track M — Memory Bridge (must-have)

**M1. Memory two-layer architecture**
- Edit `memory-writer.mjs` / `llm-harness.mjs` / `write_memory` step logic:
  - `save_to_memory: true` flag → writes episodic only, tagged `initial_design_reasoning`
  - Add explicit `write_memory` step to `create_domain` workflow after user confirms scaffold (post-confirmation semantic facts)
- Update `seed_PGC_Workflow.json` (`create_domain`), run `upsert-workflow.mjs`
- Produces: episodic + semantic rows with correct provenance tags

**M2. Memory bridge validation (B AC3)**
- Test sequence: delete flashcard domain → `create_domain flashcards` (Slack) → inspect `PGC_Memory` rows → `create_workflow quiz_flashcards` (Slack) → inspect LLM prompt log for injected memory block → verify generated workflow handles null `next_review_date` on first attempt

**M3. Domain data initialization**
- `create_domain` post-confirmation `write_memory` step (added in M1) must also capture initial-value conventions: DEFAULT expressions, application-level invariants (e.g. `ease_factor = 2.5`, `interval_days = 1`)
- Update `generate_domain_schema` prompt to reason explicitly about initial-state nullability and emit an `initial_value_conventions` field in its output
- `serv_entity_insert` and `add_entity` prompts: add `initial_value_conventions` as an optional injected variable from retrieved memory

### Track S — Skeleton-First Generation (should-have)

**S1. Extend `design_workflow_process` output schema**
- Add `routing` field to each `process_design` item: `{ on_success?, on_else?, on_success?, on_else?, on_cancel? }` using step_label references (not step numbers)
- Update `design_workflow_process` prompt output schema, update `seed_PGC_Prompt.json`, run `upsert-prompt.mjs`

**S2. Skeleton derivation js_transform + L1/BFS**
- Add a new `js_transform` step between step 21 and step 22 in `create_workflow`:
  - Builds a minimal step array (step key, type, routing fields only) from `process_spec.process_design[*].routing`
  - `output_key: routing_skeleton`
- Add a `simulate` Level 1 step immediately after, running BFS on `routing_skeleton`
- On L1 failure: route to a `human_gate confirm` notifying the user that process design produced an invalid routing graph; options: "Redesign process" → step:21, "Cancel" → cancel
- On L1 pass: proceed to step 22 (`design_workflow_dialogs`) with routing locked

**S3. `generate_workflow_steps` receives locked skeleton**
- Pass `routing_skeleton` as an additional input to step 23 so the step generator fills in content against already-validated routing (never invents routing from scratch)
- Update `generate_workflow_steps` prompt: "routing fields are locked from the skeleton; do not modify `on_success`, `on_else`, etc."

### Track I — IntentMap Phrasing (should-have)

**I1. Invocation phrasing gate**
- Add `human_gate text_input` step to `create_workflow` between step 36 (`serv_insert PGC_IntentMap`) and step 37 (`notify`):
  - Message: "How will you invoke this workflow? Enter one or more phrases separated by commas (e.g. `quiz me, start a quiz, test my flashcards`)"
  - `output_key: invocation_phrases`
  - Options: Submit → next; Skip → next (falls back to `draft_workflow.name` as pattern); Cancel → cancel

**I2. Pattern builder js_transform**
- `js_transform` step after I1: lowercase, split on `,`, trim each phrase, filter empty, join with `|`
  - If result is empty (user skipped), use `draft_workflow.name` as fallback
  - `output_key: intent_pattern`

**I3. Update PGC_IntentMap insert**
- Step 36 (`serv_insert PGC_IntentMap`) writes `pattern: intent_pattern` instead of `draft_workflow.name`
- Add `draft_workflow.name` as an extra alternation appended to `intent_pattern` so the exact name still matches Pass 1a

### Track F — fix_workflow Post-Write L1 (should-have)

**F1.**
- After `fix_workflow` step 8 (`serv_update PGC_Workflow`), add a `simulate` Level 1 step that reads the written steps
- On L1 failure: return structured 422 error with issue list; the write is rolled back (or the row is deleted if insert)
- Update `seed_PGC_Workflow.json` (`fix_workflow`), run `upsert-workflow.mjs`

### Track D — Domain Propagation Audit (must-have)

**D1.**
- Enumerate every place `domain` enters or crosses a system boundary: `classify-intent.mjs`, `create-workflow.mjs`, `fix-workflow.mjs`, SQS payloads, `PGC_WorkflowRun` input field
- For each boundary: add an assertion that domain is non-null at handoff, or document explicitly that null is valid and why
- Add unit tests in `step-executor.test.mjs` or a new `domain-propagation.test.mjs` asserting domain flows through each handoff

### Track X — schema migration (small, any time)

**X1. PGC_WorkflowRun.session_id**
- `POST /api/v1/serv/schema/addColumn` with `{ tableName: "PGC_WorkflowRun", columnName: "session_id", type: "integer", nullable: true }`
- Update `PGC_Schema` seed to reflect new column
- No FK constraint — PGC_Session does not yet exist

---

## Test Scenarios

1. `create_domain flashcards` (fresh) → inspect `PGC_Memory` rows: episodic row exists pre-confirm, semantic row exists post-confirm with `initial_value_conventions` — AC1, AC3
2. `create_workflow quiz_flashcards` after fresh domain → prompt log shows injected memory block; workflow handles null `next_review_date` on first attempt — AC2
3. Invoke new workflow via one of the phrasing gate phrases from Slack → Pass 1a match (no Tier 2 LLM call in logs) — AC6
4. `design_workflow_process` intentionally generates a broken routing reference (dead step label) → skeleton L1 fires before dialogs/steps are generated; user sees redesign gate — AC5
5. `fix_workflow` with a routing fix that introduces a dead target → post-write L1 fires 422, workflow not persisted — AC7
6. `SELECT session_id FROM "PGC_WorkflowRun" LIMIT 1` returns null cleanly — AC8

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] Simulate Level 1+2 pass on `create_workflow` and `fix_workflow` seed definitions
- [ ] All ACs above validated from Slack
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated (new step in create_workflow, memory two-layer, skeleton derivation)
- [ ] `docs/data-architecture.md` updated (`PGC_WorkflowRun.session_id`, `PGC_Memory` provenance tags)
- [ ] `docs/create-workflow-design.md` updated (skeleton track, phrasing gate, routing fields on process_design)
- [ ] `README.md` updated if any env or bootstrap changes
- [ ] `docs/backlog.md` updated — completed items marked, pgvector intent matching added as Sprint 5+ item
- [ ] Item 9 (`analyze_and_design_workflow`) confirmed obsolete and closed or kept open with rationale
- [ ] `CURRENT.md` renamed to `sprint-04.md` with outcome notes

---

## Session Notes

**2026-06-09 (session 19):** Three prompt defects found and fixed via LLM diagnostic sessions (PGC_Session/PGC_SessionEntry).

(1) `create_domain` v17 / `design_table` v6 — `initial_value_conventions` case (2) reworded: "Any aggregations needed during data loads (even if a SQL DEFAULT is present)..." so the LLM no longer skips `card_count`-style counters that have `DEFAULT 0`. `expire_prior` confirmed working — old schema snapshots correctly expired on new runs.

(2) `revise_domain_schema` v6 — added tie-breaker rule: USER PREFERENCES override RESEARCH FINDINGS when they address the same topic and conflict. Diagnosed via session 455 (run 443 step 12b, query 369828aa): LLM self-confirmed it received `state_only` preference AND a research recommendation for "State table plus history log" with no conflict resolution rule, and chose the research recommendation.

(3) `research_domain_schema` v7 — structural fix for the deeper root cause: research was making firm recommendations on the same topics it was generating preference questions for, creating contradictory directives. Fixed with: mutual exclusivity rule (a topic decided in findings cannot also appear in preference_questions), test 3 reworded to "is best practice unclear?", pre-output validation checklist (3 self-checks), concrete `affects` field guidance. Diagnosed via session 458 (run 444 step 10): research recommended "Deck-local card state" (m:m junction) while simultaneously generating a `card_deck_cardinality` preference question; user answered `one_to_many` but m:m schema was generated.

Also fixed: `upsert-prompt.mjs` never bumped DB version on update, and `ok` output showed stale DB version (e.g. `v4 ok` when seed was v17), causing repeated false "prompts not deployed" diagnoses across sessions. Fixed: `ok` path syncs DB version to seed version; update path writes `version: seedVersion`. All 19 prompt DB versions now synced. `memory-client.mjs` jsonb_contains optimization added to backlog.

**2026-06-08 (session 18):** Debugged quiz "no decks available" — root cause: PGD_Deck.total_cards = 0 on all decks because add_entity never set it. Traced to create_domain prompt: initial_value_conventions rule only covered 2 cases (nullable-at-creation, wrong-starting-value); app-maintained counters like total_cards fell through. LLM correctly omitted it, memory id=26 said "db sets: total_cards(0)", parse_entity_input respected that and left it out of inserts. Fix: added case 3 (app-maintained counters) to create_domain prompt initial_value_conventions rule, v12→v13, with generic examples only (no domain references). parse_entity_input already had memory_config in DB (id=19, v3, 400-token semantic budget) — no prompt change needed there. Permission prompt root cause also found and fixed: settings.local.json takes precedence over settings.json for allow lists; Bash(curl *) and Bash(aws *) were only in settings.json, never fired. Added both to settings.local.json (gitignored, not committed). PGD_Deck.total_cards still 0 on decks 1–5 — backfill + full chain validation (delete/recreate domain, then add_entity, then quiz) pending next session.

**2026-06-08 (session 17):** `create_workflow` ran end-to-end including new IntentMap phrasing gate (Track I) — user confirmed last dialog worked. Quiz can't find flashcard decks: run 434 hit "no decks available" branch despite runs 431–433 successfully inserting decks. Root cause not yet identified — suspect initial-value issue (AC3) left `PGD_Deck` rows in broken state, or quiz `serv_query` filters are wrong. Next session: check `PGD_Deck` rows, quiz step 1 filter, and whether PGC_Memory domain context is injecting correctly into quiz LLM calls. Session also fixed `.claude/settings.json` — all `Bash(cmd*)` wildcard rules were missing a space before `*`, causing permission prompts on every curl/aws/node command. Corrected to `Bash(cmd *)` format.

**2026-06-08 (session 16):** Lambda OOM root cause confirmed and fixed. Two redundancies eliminated: (1) `step_type_contracts` (31KB PGC_StepType payload) removed from `create_workflow` step 10; `llm-harness.mjs` now auto-injects `step_type_contracts` at LLM call time for any prompt whose `prompt_text` contains `{{step_type_contracts}}` token. (2) `run.state.local_state` mirror removed from all intermediate `PGC_WorkflowRun` writes in `run-workflow.mjs` — `state` column is now deprecated and written only at workflow completion. Combined reduction: ~117KB off every DB write payload. Run 427 confirmed fix — step 24 rendered at 136MB Lambda memory. js_transform smoke test false positives fixed: `inferMockArrayKeys` and `inferMockIndexKeys` helpers added to `simulation-engine.mjs` — pre-augment `mockState` before each expression runs, injecting `[{id:1}]` for array-accessed keys and `0` for numeric-index keys. Eliminates `js_transform_void_return` false positive for expressions like `local_state.current_subset[local_state.subset_index]`. `PGC_WorkflowRun.state` deprecated status documented in `docs/data-architecture.md`, `CLAUDE.md`, and memory. Cadence note: commit-then-deploy drift caused user to lose a run — added to backlog (Medium Priority) with deploy as a hard bye-checklist gate going forward. All changes deployed. 345 unit tests pass.

**2026-06-07 (session 15):** Unified routing vocabulary (`on_truthy`/`on_falsy`→`on_success`, `on_failure`→`on_else`) across all system code, seeds, tests, and docs. Root cause: design_workflow_process LLM under cognitive load defaults to the common `on_success` pattern even for condition-step fields, self-diagnosed as "what I did wrong". Architectural fix: eliminate dual-pattern — all steps use `on_success`/`on_else`, condition steps retain stricter value contract (bare step keys only; control tokens and step:N format remain invalid). Restored condition-specific L1 check (`condition_routing_invalid` failure class) in simulation-engine.mjs after it was lost during bulk rename. Fixed residual `on_truthy` occurrences in fix_workflow_steps prompt CRITICAL RULE (was wrongly instructing LLM to use step:N for condition routing) and step_usage_patterns system context. Removed `runRoutingValueRules` from `review-output.mjs` entirely — routing structural validation belongs exclusively in simulation-engine.mjs; the removed function had untested rules with a narrower ROUTING_TOKEN_RE that rejected valid condition bare-step-key routing values, creating false correction signals. Rewrote all four upsert scripts (workflow/prompt/system-context/step-type) to emit one line per item + summary line; fingerprint-based idempotency replaces version-number comparison. 345/345 unit tests pass. Deployed and all seeds upserted. Runs 422/423 cancelled (422: stuck, 423: skeleton L1 condition routing bugs now fixed). Pending: design_workflow_process model upgrade to claude-sonnet-4-6; retest create_workflow quiz_flashcards from Slack.

**2026-06-07 (session 14):** Memory bridge + skeleton defect fixes. Root cause: `save_to_memory` scope in `llm-harness.mjs` was merge-not-replace — `workflow` key survived explicit scope overrides. Fixed: explicit scope replaces baseScope entirely when non-empty. `create_domain` step 10 scope changed from `{}` to `{domain:"{{input.domain}}"}` so domain-level memories land at `{domain}` scope (readable by any workflow in the domain). Existing PGC_Memory rows id=24/25 patched via API. Skeleton L1 false positives fixed: (1) `missing_cancel_option` check now skipped in skeleton mode (same `!skeleton` guard as serv required-field check); (2) human_gate edge builder now includes `on_success`/`on_else` in BFS targets — previously flagged all downstream steps as unreachable; (3) `runSimulation` now returns `total_issues` on all three return paths; gate message template changed to `{{skeleton_validation.total_issues}}`. `design_workflow_process` prompt now has `memory_config: {memory_budget_tokens: 600, memory_types: ["semantic","episodic"]}` — was zero-budget, no memories injected. `analyze_workflow_gaps` correction message now includes `output_shape` hint when null/string is returned instead of JSON Schema object. L1 nested template error message now shows the actual matched token (e.g. `{{outer[{{inner}}]}}`) instead of first 80 chars of the template string. `generate_workflow_steps` v26: Rule 3a (dynamic array access via js_transform pre-step), Rule 4a (comma-separated output_key), Rule 2 (on_cancel routing flexibility), correction mode example of level1_applied/level1_issue. All fixes deployed + upserted. Next: retest `create_workflow quiz_flashcards` from Slack.

**2026-06-06 (session 13):** add_entity + create_workflow validation. AC3 (memory injection) confirmed — parse_entity_input correctly omits all SRS fields from card inserts; DB defaults apply. Entity schema root_table bug found and fixed: create_domain step 18 used `foreignKeys.length === 0` to find root, which excluded PGD_Deck after self-ref FK was added in revise_domain_schema; fixed to filter out self-referential FKs first (create_domain v39). PGC_EntitySchema id=23 manually corrected (root_table PGD_Tag → PGD_Deck). Backlog: parent deck self-ref FK lookup gap in add_entity. create_workflow run 416 failed: design_workflow_process max_output_tokens 2000 was too low (truncated mid-fence); llm-client fence stripper now handles unclosed fences; max_output_tokens raised to 8000. Run 417 reached skeleton L1 with 16 issues: 12 false positives (serv_step_missing_required_input on content-free skeleton steps) + 4 genuine (missing on_cancel on 2 human gates). Fixes: skeleton mode flag on simulate step (input.skeleton: true on step 21b skips serv required-field checks); on_cancel marked required: true in PGC_StepType human_gate contract; architecture.md updated with both decisions. All 345 unit tests pass. Next: retest create_workflow quiz_flashcards from Slack.

**2026-06-03 (session 12):** create_domain validation + bug fixes. Carry-in docs complete (architecture.md, data-architecture.md, README.md). Purged 320 old WorkflowRun rows + 13 stuck runs. AC1 validated — step 10 episodic scope fix (removed `{{proposed_scaffold.domain}}` from save_to_memory.scope; harness already enriches from finalOutput.domain). Six create_domain seed fixes: (1) step 10 scope; (2) step 14 on_success 12→11a (schema_summary refresh after add_table); (3) step 18 embedding column exclusion from bulk-add; (4) step 22→22a→23 bulk-add command included in final notify; (5) step 16b optional-vs-omit split in schema snapshot memory; (6) cross-domain workflows added to backlog with test vehicles (recipe→inventory, grocery receipt→inventory+expenses). Architecture.md §6.2 stale "PGC_Workflow (4 CRUD workflows)" corrected. create_domain v38 live. Next session: validate add_entity with memory injection, then AC2 (create_workflow quiz_flashcards) — confirm PGC_Memory id=26 injected into LLM prompt.

**2026-06-02 (session 11):** Documentation sprint. Updated create-domain-design.md (full rewrite — Sprint 3/4 current), create-workflow-design.md (skeleton validation §21a/21b/21c, phrasing gate §35a/35b), memory-design.md (full rewrite — pre-implementation → live, two-layer provenance, initial_value_conventions, implementation status table), architecture.md (v3.2→v3.3: §6.13 memory layer new section, write_memory step type, MEMORY_WRITE SQS, llm_call hooks 4/5, §6.8/6.9 Sprint 4 notes). All docs harmonized — architecture.md = decision/rationale, design docs = implementation detail.

**2026-06-02 (session 10):** All Sprint 4 code complete. Deployed to prod (evomind-infrastructure). All upsert scripts run. 345 unit tests pass.
- Tracks F, X, I, D completed first (smaller); then M (memory bridge) and S (skeleton-first)
- Track D: `classify-intent.mjs` domain always written as `null` not omitted; 16 new tests document all 5 propagation boundaries
- Track M: memory two-layer (episodic pre-confirm, semantic post-confirm); `revise_domain_schema` + `design_table` accumulate semantic schema_expectations; `parse_entity_input` gets 400-token semantic memory budget for classify-intent data loads; `initial_value_conventions` added to all three design prompts
- Track S: `design_workflow_process` now emits routing fields per step; steps 21a/21b/21c validate routing topology before dialog/step generation; `generate_workflow_steps` receives locked routing_skeleton
- `workflow-schema.json` extended with `writeMemoryStep` definition
- Ready to validate: AC1/AC2 (flashcard memory bridge), AC5 (skeleton routing gate), AC6 (phrasing gate Pass 1a match)
- Sprint 3 carry-in docs (architecture.md, data-architecture.md, README.md) still pending — do before merge

**2026-06-01 (session 9):** Sprint 4 scoped. Key decisions:
- `design_workflow_process` is left-brain — correct place to add routing fields; js_transform derives skeleton without extra LLM call
- Memory bridge test requires domain recreation (episodic memory must be written fresh with new provenance tags)
- IntentMap phrasing: js_transform phrase-join is MVP; pgvector semantic matching is the long-term solution (deferred to Sprint 5+, requires embedding population at workflow registration)
- Backlog item 9 (`analyze_and_design_workflow` v10): likely obsolete if v4 prompts are deployed; confirm at sprint open
- Backlog item 10 (session_id column): pulled in as nullable integer, no FK until PGC_Session exists
- Backlog item 11 (post-write L1): pulled in for fix_workflow only; create_workflow already has pre-write L1 at step 25
