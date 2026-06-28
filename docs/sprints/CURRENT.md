# Sprint 6 — Pantry, Expenses, Track P, MVP Hardening

**Sprint 5 closed 2026-06-18. See `docs/sprints/sprint-05.md` for retro.**

**Branch:** `sprint/06-pantry-expenses-trackp`

**Duration:** ~2 weeks

**Use case reference:** `docs/Javear-use-cases.md`

---

## Sprint Goal

Expand to Pantry/Inventory and Expenses/Budget domains. Validate UC-P4, UC-P4+E, UC-E3, UC-E4, and UC-P5 end-to-end. Complete Track P (design_workflow_prompts). Recreate Recipe domain with hardened prompts. If all ACs pass, this sprint yields a functional MVP ready for Sprint 7 release-readiness hardening.

---

## Acceptance Criteria

- **AC1 — Seed audit clean:** ✅ DONE (2026-06-20)
- **AC2 — Embedding on insert:** ✅ DONE (2026-06-20)
- **AC3 — Track P live:** `create_workflow` includes a `design_workflow_prompts` step. Domain-specific `llm_call` steps are classified (reuse/create/convert) and new `PGC_Prompt` rows registered with `domain` set. SM-2 convert case and UC-P5 unit conversion create case both validated.
- **AC4 — Recipe domain recreated:** ✅ DONE (2026-06-22)
- **AC5 — Pantry domain created:** UC-P1 (add), UC-P2 (list), UC-P3 (update) pass from Slack.
- **AC6 — UC-P4 (receipt → pantry):** Grocery receipt OCR text → translated item mapping → confirmation gate → pantry rows updated/inserted.
- **AC8 — Expenses domain created:** UC-E1 (add), UC-E2 (list) pass from Slack.
- **AC9 — UC-E3 (expense receipt):** Receipt OCR → expense record with line items inserted.
- **AC10 — UC-E4 (budget report):** Monthly spend vs budget by category posted to Slack. `llm_call` over rows is acceptable for MVP; `serv_aggregate` step type goes to backlog if not built.
- **AC11 — UC-P5 (subtract ingredients):** Recipe ingredients deducted from pantry using `llm_call` unit conversion. Confirmation gate before writes. Track P "create" case: unit conversion prompt registered as `PGC_Prompt` with `domain='pantry'`.
- **AC12 — PGC_Prompt.domain column live:** ✅ DONE (2026-06-20)
- **AC13 — Prompt cleanup in delete flows:** ✅ DONE (2026-06-20)
- **AC14 — `quiz_flashcards` workflow recreated:** ✅ DONE (2026-06-26)
- **AC15 — `chk_triggered_by` constraint updated:** ✅ DONE (2026-06-20)
- **AC16 — R4 unit test passes:** ✅ DONE (2026-06-20)
- **AC17 — `openapi.yaml` in sync:** ✅ DONE (2026-06-20)
- **AC18 — User alias input in `create_domain`:** ✅ DONE (2026-06-20)
- **AC19 — Novia recovery tools:** ✅ DONE (2026-06-20)
- **AC20 — Novia token truncation fix:** ✅ DONE (2026-06-20)

---

## Track → AC Map

| Track item | AC(s) | Status |
|---|---|---|
| P0 Seed audit | AC1 | ✅ |
| P1 PGC_Prompt.domain column | AC12 | ✅ |
| P2 generate_workflow_steps prompt | AC3 | ✅ |
| P3 design_workflow_prompts step | AC3 | ✅ |
| P4 Prompt cleanup in delete flows | AC13 | ✅ |
| D0 create_domain alias input | AC18 | ✅ |
| D1 Recreate Recipe domain | AC4 | ✅ |
| D2 Delete + recreate quiz_flashcards | AC3, AC14 | ✅ |
| D3 Create Pantry domain | AC5 | ⬜ |
| D4 Create Expenses domain | AC8 | ⬜ |
| W1 UC-P4 receipt → pantry | AC6 | ⬜ |
| W3 UC-E3 expense receipt | AC9 | ⬜ |
| W4 UC-E4 budget report | AC10 | ⬜ |
| W5 UC-P5 subtract ingredients | AC3, AC11 | ⬜ |
| E1 Embedding on insert | AC2 | ✅ |
| H1 chk_triggered_by fix | AC15 | ✅ |
| H2 R4 unit test | AC16 | ✅ |
| H3 openapi.yaml sync | AC17 | ✅ |
| H4 Novia recovery tools | AC19 | ✅ |
| H5 Novia token truncation fix | AC20 | ✅ |

---

## Out of Scope

- UC-P5 `js_transform` sandbox — deferred to Sprint 7 or later
- `/chat` dead code removal — deferred (intentional)
- Lambda loop alarm (Track L) — no active risk signal
- Checkpoint/revert for Novia writes — Sprint 7 or later
- AC6 `design_table` decimal-boundary validation — run as a side-test when convenient, not a blocker
- Log hygiene, README bootstrap, test environment — Sprint 7
- **W2 / AC7 (UC-P4 extended, cross-domain write)** — removed; 5 gaps in `create_workflow` documented in backlog, all scoped to Sprint 7
- **H6 / AC21 (Watchdog Lambda)** — removed; obviated by `RecursiveLoop: Allow` fix (session 16)

---

## Tracks

### Track P — design\_workflow\_prompts

**P0 — Seed audit (prep, do first)** ✅ DONE (2026-06-20)
- Audit `seed_PGC_SystemContext.json` and `seed_PGC_Prompt.json` for user-specific names (flashcard, quiz, PGD_Flashcards, spaced_repetition, sm2, etc.)
- Replace with generic placeholders. Run `upsert-system-context.mjs` and `upsert-prompt.mjs`.
- Replaced: 5 SystemContext rows (loop_state generic pattern, runtime_bindings example, minds_eye tool list); 8 Prompt rows (probe_inputs → book_reviews domain, step label examples, flashcard-specific dialog copy).

**P1 — X2: PGC_Prompt.domain column** ✅ DONE (2026-06-20)
- `POST /api/v1/serv/schema/addColumn` → `PGC_Prompt.domain text nullable`
- Update `PGC_Schema` seed to register column
- Backfill `sm2_calculate` (id=79) → `domain: 'flashcards'` (user-created artifact, updated via SERV updateRows)

**P2 — Update `generate_workflow_steps` prompt** ✅ DONE (2026-06-20)
- Domain-specific `llm_call` steps emit `prompt_draft` / `prompt_category` / `prompt_model` / `output_schema` fields
- System prompts (intent_category) keep existing shape unchanged
- Updated `PGC_StepType` `llm_call` input_contract with 4 new optional fields. Upserts run.
- `prompt_model` uses alias names (`"cheap"` / `"smart"`); `llm-harness.mjs` resolves to actual model IDs at runtime via `llm_model_aliases` — never hardcode model ID strings in domain prompt drafts.

**P3 — Add `design_workflow_prompts` step to `create_workflow`** ✅ DONE (2026-06-20)
- 8 new steps (23a–23h) inserted between `generate_workflow_steps` (23) and user review (24).
- 23a counts domain-specific llm_call steps; 23b short-circuits to step 24 if count is 0 (no LLM call, no DB query for pure CRUD workflows).
- 23c loads existing PGC_Prompt categories; 23d classifies (reuse/create/convert); 23e–23g insert new prompts; 23h applies decisions and strips draft fields from `draft_workflow.steps`.
- New `design_workflow_prompts` prompt (id=80, model=smart) added to seed and DB.
- Model alias stored verbatim in `PGC_Prompt.model`; `llm-harness.mjs` resolves at runtime via `llm_model_aliases` — new models need only one alias update.
- `arch-create-workflow.md` updated with Phase 4.5 table and LLM model row.
- Run `upsert-prompt.mjs` + `upsert-workflow.mjs create_workflow`.

**P4 — Prompt cleanup in `delete-workflow.mjs` / `delete-domain.mjs`** ✅ DONE (2026-06-20)
- Both are system code Lambda handlers, not workflows — no new workflow artifacts needed.
- `delete-domain.mjs`: added step 5a — `deleteRows PGC_Prompt WHERE domain = domain` (bestEffort, after IntentMap cleanup). Result and notification updated.
- `delete-workflow.mjs`: added step 5a — `deleteRows PGC_Prompt WHERE domain = workflowDomain`, guarded by `if (workflowDomain)` so system workflows (domain: null) don't wipe shared prompts. Result and notification updated.
- `PGC_Prompt.allow_delete` flipped to `true` in DB and `seed_PGC_TableMap.json`.
- Stale backlog item "delete-domain.mjs missing PGC_Workflow + PGC_IntentMap cleanup" removed (was already fixed in Sprint 2).

**Validation test vehicles:**
- SM-2 (`sm2_calculate`) — convert case: domain-specific llm_call → rewritten as `js_transform`
- UC-P5 unit conversion — create case: new `PGC_Prompt` registered with `domain='pantry'`

---

### Track D — Domain creation

**D0 — create_domain alias input** ✅ DONE (2026-06-20)
- Added step 17c (human_gate text_input) between LLM alias generation (17b) and js_transform (18)
- User can type comma-separated custom aliases (or leave blank + Done to use only AI-generated ones)
- Step 18 js_transform merges user aliases into the aliases Set alongside LLM-generated ones
- `create_domain` v14 in seed; upserted to DB (DB v43). All 360 unit tests pass.

**D1 — Recreate Recipe domain** ✅ DONE (2026-06-22)
- Recipe domain recreated (domestic scope). UC-R1 (add), UC-R2 (list), UC-R3 (get) validated from Slack.
- AC2 confirmed: `PGC_DomainHelp.embedding` populated on insert — no backfill run needed.
- `get_entity` step 3 hardcoded `name` broke on recipes (`title` column). Fixed: search column changed to `title`; `pgd_naming_conventions` system context updated to mandate `title` as root table label column (reference tables use `name`).

**D2 — Delete `quiz_flashcards` workflow + recreate** ✅ DONE (2026-06-26)
- Delete workflow via `delete_workflow`
- Run `create_workflow` for quiz — Track P SM-2 convert test vehicle
- Validate quiz runs end-to-end

**D3 — Create Pantry/Inventory domain**
- Watch for: reference table classification (units, categories as standalone lookup tables)
- Validate UC-P1, UC-P2, UC-P3 from Slack

**D4 — Create Expenses/Budget domain**
- Expected gap: `create_domain` does not distinguish reference tables (categories, account types) from transactional tables
- Document the gap; if it blocks UC-E1/E2, scope the `create_domain` reference table fix

---

### Track W — Workflow creation and UC validation

**W1 — UC-P4: grocery receipt → pantry update**
- Input: Apple Photos OCR text pasted into `/m`
- `llm_call` translates cryptic item names to pantry names, reads current pantry via `serv_entity_query`
- Confirmation gate → update/insert pantry rows

**W3 — UC-E3: expense receipt → expense record**
- Receipt OCR → `llm_call` extracts merchant, total, date, line items
- Confirmation gate → insert `PGD_Expenses` root + `PGD_ExpenseItems` children

**W4 — UC-E4: monthly budget report**
- After D4, manually create a DB view `PGD_MonthlyExpensesByCategory` (GROUP BY category, SUM(amount) WHERE current month) and register it in PGC_Schema + PGC_TableMap
- Workflow: `serv_getRows` on the view → `serv_getRows` on `PGD_Budget` → `llm_call` to format the comparison as readable Slack output (LLM for *formatting*, not *math*)
- No `llm_call` aggregation — view handles all arithmetic at the DB level
- `createView` SERV endpoint added to backlog for future domains

**W5 — UC-P5: subtract recipe ingredients from pantry**
- Reads recipe ingredients + current pantry state
- `llm_call` step handles unit conversion (tablespoons → oz, etc.)
- Confirmation gate before any pantry writes
- Track P "create" test: unit conversion prompt registered as `PGC_Prompt` with `domain='pantry'`

---

### Track E — Embedding on insert

**E1 — Extend `table.mjs` `insertRow`** ✅ DONE (already implemented — verified 2026-06-20)
- `insertRow` already calls `getEmbedColumns` + `resolveEmbedding` on every insert (lines 350–366).
- `PGC_DomainHelp.embedding` has `embed_source: [domain, description, aliases]` in `PGC_Schema`.
- New domains are embedded automatically on `create_domain` — no `backfill-embeddings.mjs` run needed.
- Stale "NULL until backfill" note removed from `docs/arch-data.md`.

---

### Track H — Housekeeping

**H1 — `chk_triggered_by` constraint fix** ✅ DONE (2026-06-20)
- `modifyConstraint` call updated constraint to: `triggered_by IN ('slack', 'api', 'workflow', 'system', 'minds_eye', 'intent_classify')`
- `seed_PGC_Schema.json` constraint expression updated to match
- `minds-eye.mjs`: `triggered_by: 'system'` → `triggered_by: 'minds_eye'`
- `classify-intent.mjs`: `triggered_by: 'slack'` → `triggered_by: 'intent_classify'`

**H2 — R4 unit test: MINDS_EYE SQS payload** ✅ DONE (2026-06-20)
- Created `tests/unit/minds-eye-contract.test.mjs` — 2 assertions:
  1. `proc/minds-eye.mjs` reads `body.sessionId` (aliased as `existingSessionId`) — not `body.existingSessionId`
  2. `slackbot/interactive.mjs` sends `sessionId` key (not `existingSessionId`) in MINDS_EYE SQS payload
- All 360 unit tests pass

**H4 — Novia recovery tools** ✅ DONE (2026-06-20)
- `listPhysicalTables` SERV endpoint: queries `information_schema.tables` for physical PGD tables, returns `registered:bool` per table (cross-referenced against `PGC_Schema`)
- `deleteTable` extended with `force: true`: skips 404 when no `PGC_Schema` row exists, assumes `pgd` target, best-effort cleanup of schema/tablemap rows
- `minds-eye.mjs`: `list_physical_tables` → `READ_TOOLS`; `drop_table` → `GATED_WRITE_TOOLS` (danger gate); scope tracking added
- `minds_eye_system_prompt` v15→v16: both tools documented with use cases and recovery flow

**H3 — `openapi.yaml` sync audit** ✅ DONE (2026-06-20)
- `/novia` and `/proc/minds-eye` already present — confirmed accurate
- Added missing slackbot routes: `/api/v1/ui/slack/help`, `/api/v1/ui/slack/explain`
- Added missing proc routes: `/api/v1/proc/troubleshoot-workflow`, `/api/v1/proc/fix-workflow`, `/api/v1/proc/diagnose-prompt-schema`, `/api/v1/proc/monitor-prompt-quality`
- No stale ping variants found — unified `/ui/slack/ping` already covers all types

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] L1 + L2 simulation passes on all new and recreated workflows
- [ ] All ACs above validated from Slack (by user)
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated if any `.mjs` files added/removed/renamed
- [ ] `docs/arch-data.md` updated for any schema changes (PGC_Prompt.domain, embedding on insert)
- [ ] `docs/Javear-use-cases.md` updated — mark UC-P4, UC-E3, UC-E4, UC-P5 status
- [ ] `docs/backlog.md` updated — completed items, new items from sprint
- [ ] `openapi.yaml` updated (H3)
- [ ] `CURRENT.md` renamed to `sprint-06.md` with outcome notes

---

## Session Notes

**2026-06-18 (session 1):** Sprint 6 scoped. Retro written to sprint-05.md. Goal: Pantry + Expenses domains, Track P complete, MVP hardening. Sprint 7 intent: release-readiness (usability, log hygiene, README, test environment). Branch: `sprint/06-pantry-expenses-trackp`.

**2026-06-18 (session 2):** Sprint 5 merged to main and pushed. Prod deployment confirmed current (sam deploy — no changes, all 4 bundles matched). Fixed CURRENT.md on main (sprint/05 merge had brought over stale Sprint 5 version). Sprint 6 implementation starts next session with P0 seed audit.

**2026-06-20 (session 4):** Three `create_domain` failures diagnosed and fixed: (1) `design_table` prompt restructured into 7 numbered sections; `pgd_column_type_rules` and `pgd_naming_conventions` system context updated to close type/naming gaps (Instruction fault). (2) Topological sort step (16d) added to `create_domain` to order tables by FK dependency before `createTable` iterator (Execution fault). (3) `user_preferences` enrichment step (9a) added — answers now carry question text and option description so LLM has full context (Instruction fault). `delete-domain.mjs` fixed to report `deletedDomainHelpCount` integer in Slack notification. Novia recovery tools implemented: `listPhysicalTables` SERV endpoint + `deleteTable` force flag + `list_physical_tables`/`drop_table` tools in `minds-eye.mjs` + `minds_eye_system_prompt` v16 (H4 / AC19). CLAUDE.md session-start updated to reference `arch-data.md` §5.5.

**2026-06-20 (session 5):** Novia token truncation recovery: `read_prompt` now returns `id`, `max_output_tokens`, and `error_log`; `minds_eye_system_prompt` v17 adds TOKEN TRUNCATION protocol — Novia reads `error_log.attempts` for `error_type: token_truncation`, doubles `max_output_tokens` via `update_data`, instructs user to re-run. 360/360 unit tests pass. Next: Track D (D1 recreate Recipe domain) and Track W from Slack.

**2026-06-21 (session 6):** Recipe domain entity insert (`add_entity`) hardened end-to-end. (1) `add_entity` v13: steps 2a–2f (ref FK enrichment + LLM confirmation gate + iterator insert); `executeServEntitySchema` threads `allowed_values` from DB check constraints; `resolveRefTableId` is find-only. (2) `buildSelectSQL` in `entity.mjs`: fallback to `to_jsonb(alias.*)` for aggregations with no columns list — fixes "argument list must have even number of elements" on 5-column junction tables. (3) `extractSearchTerm` redesigned: strips matched alias (not domain name), uses `parseFieldValues`, handles `dish id=1`, `dish id = 1`, `dish NAME`, `name="NAME"`. `matchDomainAlias` returns `_matched_alias`. `matchWorkflowByKeywords` keyword scan limited to first line — prevents recipe body text ("find", "show") false-matching `get_entity` over `add_entity`. (4) `schema.mjs` `dropConstraint` endpoint added (DDL + PGC_Schema sync, any constraint type); wired into Novia `propose_schema_fix` + gate description + system prompt catalog + `openapi.yaml`. Used immediately to drop `uq_recipeingredients_recipe_ingredient` — same ingredient can now appear twice in a recipe (different quantity/prep). (5) `backlog.md`: `format_entity_display` LLM pretty-print item added (High Priority). 366/366 unit tests pass. Buddha Bowl recipe added successfully (id=2); Novia rendered it with full ingredient partitioning. Next: Track D (D1 recreate Recipe domain with hardened prompts), Track W.

**2026-06-22 (session 7):** Execution bug in `executeServEntitySchema` (step-executor.mjs:871): self-referential root FKs (e.g. `PGD_Deck.parent_deck_fk → PGD_Deck`) were excluded from `rootRefFkCols` by `!== rootTable` filter, leaving ref enrichment pipeline blind to them. LLM correctly produced `parent_deck_fk: "Spanish Vocabulary"` but step 4 insert failed with "invalid input syntax for type integer". Fix: removed the exclusion — self-referential root FKs now flow through to `ref_fk_columns`, ref candidate detection fires, enrichment pipeline resolves name → ID before insert. 366/366 unit tests pass. Next: deploy + retry flashcard add with parent deck; then D1 (recreate Recipe domain).

**2026-06-22 (session 9):** Fixed third `c.type === 'vector'` exact-match bug in `table.mjs` vectorSearch validator (`startsWith` fix). Validated vector search end-to-end ("sweet potato" → "sweet potatoes"). Updated `add_entity` step 2d gate message. Added §6.17 system workflow catalog to `arch-workflow-patterns.md`. Fixed vector column I/O: `table.mjs` `getRows` now truncates to 5 chars + `...` (populated vs null visible without full payload); `entity.mjs` `getEntity`/`listEntities` strips vector columns entirely (no embedding data in Slack display). AC2 confirmed via `PGC_DomainHelp.embedding` truncated preview. D1 complete: Recipe domain recreated, UC-R1/R2/R3 validated. Enforced `title` as mandatory root table label column in `pgd_naming_conventions`; `get_entity` step 3 updated from `name` → `title`. Next: D2 (delete + recreate quiz_flashcards workflow).

**2026-06-22 (session 8):** Two `add_entity` harness bugs fixed. (1) Junction table FK fallback (Execution fault): `executeServEntityInsert` was injecting `rootId` as `tag_fk` when `PGD_Tag` had 0 rows, causing FK constraint violation on `PGD_CardTag`. Fix: skip junction table child entirely if any named FK parent has 0 inserted rows (`step-executor.mjs`). (2) Novia wrong entity name (Instruction fault): Novia called `run_workflow → list_entity` with `entity_name: "Deck"` (guessed from DomainHelp aliases) instead of looking up registered `entity_name: "Flashcard"` from `PGC_EntitySchema`. Fix: `minds_eye_system_prompt` v18 — two new rules: use `query_entity` for data lookup requests (not `run_workflow`); verify `entity_name` via `query_table PGC_EntitySchema` before triggering entity workflows. Orphaned deck 7 (artifact of failed run 509) confirmed deleted by Novia including 29 flashcards. Recursive loop email investigated: 3 dropped invocations on 2026-06-21 (1 at 10:57 UTC, 2 at 11:57 UTC) traced to session 6 recipe testing — rapid SQS retry chains from `add_entity` failures (`"medium bowls"` integer error + LLM validation errors), all bugs now fixed. 366/366 unit tests pass. Deployed. Next: D1 (recreate Recipe domain).

**2026-06-23 (session 10):** Three harness fixes. (1) `template-resolver.mjs`: arrays in `{{...}}` tokens now render as `join(', ')` instead of `JSON.stringify` — standard template behaviour across all step fields. `create_domain` step 17c `message_template` updated to show `{{domain_aliases.aliases}}` directly (extend-harness fix; initial workaround of adding step 17b2 reversed). `create_domain` v49 deployed. (2) `interactive.mjs` `handleViewClosed`: modal cancel no longer enqueues `resume_gate` — workflow stays suspended at same gate, gate message stays active in Slack. Fixes bug where Cancel on step 12 "Request changes" modal acted as a submit. `on_modal_close` routing in `run-workflow.mjs` is now dead code — backlog item added to remove it. `docs/slack-modals.md` reference doc added. (3) All changes deployed. 366/366 unit tests pass. Next: D2 (delete + recreate quiz_flashcards workflow).

**2026-06-24 (session 11):** Five `/shutdown` bugs fixed and feature hardened. (1) Modal cancel bug: `interactive.mjs` was replacing gate message (removing buttons) on modal open — moved `chat.update` from button-click to `handleViewSubmission` so buttons survive cancel and are only cleared on submit. (2) `slackbot/shutdown.mjs` missing `x-api-key` on Slackbot→PROC call (403). (3) `proc/shutdown.mjs` missing `x-api-key` on both SERV calls (403) + wrong status filter (`'active'` → `in ['running','awaiting_human_gate']`). (4) Refactored `/shutdown` to ack-and-notify: Slackbot enqueues `SHUTDOWN` to WorkflowQueue → ephemeral ack → ProcFunction handles + `enqueueCallback HUMAN_NOTIFICATION`. Fixed `req.body.callback` → `req.callback` (buildReqFromSqs pattern). (5) Workflow names in result resolved via secondary `PGC_Workflow` lookup (no `workflow_name` column on `PGC_WorkflowRun`). Backlog item added: audit all inter-Lambda HTTP calls for missing `x-api-key`. 366/366 unit tests pass. Next: D2 (delete + recreate quiz_flashcards workflow).

**2026-06-24 (session 12):** Diagnosed and fixed `new Function()` / vm timeout gap across three callsites. (1) `simulation-engine.mjs` `runJsTransformSmokeTest`: replaced `new Function()` (no timeout) with `vm.runInNewContext` + 500ms timeout — prevents generated js_transform expressions with infinite loops from spinning Lambda for 240s with no logs. Used `err.name === 'SyntaxError'` (not `instanceof`) to handle vm cross-realm error type. (2) `template-resolver.mjs` `evalExpression` + `evalItemCondition`: same replacement with 200ms timeout. Deployed. CLAUDE.md updated: wiring rules for new SystemContext/StepType entries added to Key Conventions. Backlog updated: inject_for audit + inter-Lambda x-api-key audit. Diagnosed create_workflow cold-start/ESM hang pattern: Lambda never invoked (no INIT_START, no START in CloudWatch) for step 23a after a 46s LLM call — confirmed as transient AWS SQS Event Source Mapping issue, not a code bug. Manually restarted run 543 via SQS enqueue. 366/366 unit tests pass.

**2026-06-24 (session 13):** Diagnosis session — no code changes. Investigated the "no line 81 after step 23" hang pattern and recursive loop alerts. Ruled out handler.mjs as the swallow site: `enqueueWorkflow` has no try/catch, any SQS failure propagates cleanly to handler.mjs catch. Key finding: the explain notification (LLM_DIAGNOSTIC) fires BEFORE the DB advance and enqueue, so receiving it in Slack places us before line 475. Mapped three failure zones after the explain notification: Zone A (after notification, before updateRows) — run stranded, stuckCount=1 discards the redelivery silently because the guard incorrectly assumes the continuation was already enqueued; Zone B (after updateRows, before enqueueWorkflow) — DB shows current_step='23a' but no SQS message, redelivery behavior depends on checkIdempotency matching step 23's UUID against step 23a; Zone C (after enqueueWorkflow, Lambda timeout before return) — both step 23a original and step 23 redelivery in queue simultaneously, the recursive loop source. Next: run a test tomorrow to observe which zone logs appear; then check checkIdempotency signature to close Zone B.

**2026-06-25 (session 15):** Four prompt/harness fixes while running D2 (study_flashcards create_workflow). (1) `simulation-engine.mjs`: condition steps now accept `end` and `cancel` as valid routing targets — only `next` and `step:N` remain blocked. Unit tests updated. Deployed. (2) `generate_workflow_steps` v30→v31: Rule 2 extended — `reveal` field now included in dialog_designs copy list; one-to-one constraint added (one dialog_design = one human_gate, never split a reveal gate into two steps). (3) `generate_workflow_mocks` v2→v3: `max_output_tokens` set to 16000 (was null → 8192 default, causing truncation on 25-step workflows). (4) Zone C confirmed recurring pattern: step 24 execute_top consistently dropped after step 23 (49s LLM call). Re-enqueued manually twice. H6 (Watchdog Lambda) scoped as AC21 — non-optional. D2 run 549 failed at generate_workflow_mocks (token truncation, now fixed). User confirmed: subset management is intentional; breadcrumb query (steps 21-24) is candidate for simplification. Next: restart D2 run with simplified design (no breadcrumb, single summary), then H6 Watchdog Lambda.

**2026-06-25 (session 14):** OOM-at-step-24 root cause confirmed and fixed. (1) `analyze_workflow_gaps` prompt v11: determinism gate added to Type 4a — before classifying any logic as needing an LLM prompt, check if it's expressible as `js_transform` (math, scoring, aggregations, sorting, statistics, date arithmetic, counters, fixed branching). SM-2 example replaced with broader mathematical formulations. Upserted. (2) `loadRun` in `run-workflow.mjs`: replaced `SELECT *` with 8-column whitelist (`LOAD_RUN_COLUMNS`) via new `columns` param on `getRows`/`servPost`. `serv-client.mjs` `getRows` extended with optional `columns` parameter; `table.mjs` `getRows` handler validates and applies column selection. (3) `template.yaml`: ProcFunction `MemorySize: 1024`; `WorkflowQueue VisibilityTimeout: 60`; `BastionEC2Role` CloudWatch permissions added (`GetMetricStatistics`, `GetMetricData`, `ListMetrics`). (4) All changes deployed. Zone C pattern confirmed: step 24 message enqueued at 13:26:38 but Lambda never triggered (ESM polling gap or silent post-delete crash, no logs). Re-enqueued manually at 13:42; step 24 ran fine at 124MB peak — OOM is resolved. Run 546 now `awaiting_human_gate` (step 42). Watchdog Lambda (EventBridge) confirmed as non-optional — added to sprint scope.

**2026-06-26 (session 17):** Four fixes shipped. (1) `delete-workflow`: `resolveWorkflowName()` now uses Pass 1 (PGC_IntentMap regex) + Pass 2 (domain alias → keyword scan) before returning not-found — same resolution chain as classify-intent. (2) `create_workflow` step 35b: original `userInput` phrase truncated at first stop word ("flashcard quiz that uses SM-2..." → "flashcard quiz") now appended to IntentMap pattern at creation time, closing the create/delete symmetry gap. (3) `/explain` markdown rendering: `format:'markdown'` added to enqueueCallback so responses use `markdownToBlocks` (GFM headers, bold, code fences) instead of plain `mrkdwn` section blocks. (4) `llm-harness.mjs` diagnostics: user message (`userInput || JSON.stringify(resolvedInput)`) now stored as `role:user` seq 2 in PGC_SessionEntry — explain LLM previously had system prompt + output but not the input that produced it. D2 create_workflow part complete (quiz runs end-to-end validation pending).

**2026-06-26 (session 16):** Recursive loop alert on run 550 diagnosed and fixed. Root cause: AWS Lambda's 16-hop chain limit hit after step 9 human_gate resume — 15 consecutive steps (11→23b) exhaust the limit; step 24 invocation dropped silently (not sent to DLQ). Zone C (SQS redelivery) ruled out — pre-delete fix confirmed working. Fix: `RecursiveLoop: Allow` on ProcFunction in `template.yaml` (intentional SQS chaining pattern). Added `lambda:PutFunctionRecursionConfig`, `lambda:GetFunctionRecursionConfig`, `cloudformation:ContinueUpdateRollback` to BastionEC2Role; `DependsOn: BastionRole` on ProcFunction to prevent parallel-update IAM race (caused two UPDATE_ROLLBACK_FAILED requiring CloudShell recovery). Deployed. D2 run 551: step 24 executed (recursive loop fix confirmed). Failed at step 35 — duplicate key in PGC_Workflow (`review_flashcards` already exists from Jun 24). `generate_workflow_steps` first-pass split reveal into two human_gates confirmed via `/explain fa42f043` — Instruction fault. `dialog_spec` from `analyze_workflow_gaps` was correct; second pass (after user feedback) generated correctly. `generate_workflow_steps` v31→v32: replaced flashcard-specific one-gate rule with generic reveal-as-add-on consolidation principle. Upserted. Next: delete `review_flashcards` from Slack, rerun D2 create_workflow.

**2026-06-27 (session 18):** Reveal contract extended and hardened. (1) Unified three-mode reveal contract: string → `task_card.output.rich_text_section` (plain text); array → `task_card.details.rich_text_list` (bulleted list); `reveals` plural (data-driven multi-panel). (2) `step-executor.mjs`: swapped `resolveTemplate` → `resolveInput` for reveal content — pure `{{var}}` references to arrays now pass through as arrays. (3) `callback.mjs`: `case 'reveal'` branches on `Array.isArray(field.content)` — array path uses `details.rich_text_list`, string path unchanged. (4) `design_workflow_dialogs` v12: `reveals` added to output_schema (fixes AJV rejection from run 556); content description updated. (5) `design_workflow_process` v10→v13: replaced prescriptive ❌/✅ anti-pattern (incorrectly flagged valid two-gate active-recall pattern) with nuanced one/two-gate rule based on cognitive state boundary; reveals feed content changed to array-of-strings in both dynamic data rule and self-referential FK trigger; content-must-be-array constraint added (no join); step ordering constraint added (leaf query must precede options build). (6) `arch-step-types.md`: updated reveal/reveals contract section. Deployed. D2 quiz run 559 (create_workflow) complete — accordion hierarchy renders correctly; parent decks shown as reveals, child deck names bulleted. Found two Generation faults in workflow 339: options mapped from parent nodes (not children) due to wrong step order; content produced as numbered join string instead of array. Prompt fixes applied (v13) to prevent in future generations. Need to delete workflow 339 and regenerate next session to validate fixes.

**2026-06-28 (session 19):** Five prompt/harness/bug fixes. (1) `seed_PGC_StepType.json` human_gate reveal contract: removed `task_card` Slack-rendering terminology, replaced with workflow nomenclature (reveal panel, progressive disclosure). Added when-to-use / when-NOT-to-use guidance. Added choice + reveal pattern hint to `gate_type` description. Removed all "does not advance" limitation framing. (2) `seed_PGC_StepType.json` js_transform: added parseFloat() warning for PostgreSQL `numeric`/`decimal`/`money` columns returned as JS strings by pg driver — arithmetic without parseFloat() silently concatenates instead of adding (Instruction fault root cause for SM-2 ease_factor bug). (3) `proc/explain.mjs`: LLM errors now surfaced to Slack via HUMAN_NOTIFICATION (was silently logged only). (4) `callback.mjs` `postHumanNotification`: chunked at 48 content blocks per Slack message (50-block API limit) — suffix (context + actions) appended to last chunk only. (5) `interactive.mjs` grade 0 falsy guard: `!userResponse` → `userResponse === undefined || userResponse === null` — SM-2 grade 0 ("complete blackout") was being rejected as if the action were missing. Also updated `design_workflow_process` v13: user_design_notes priority rule (no qualifier); single-gate reveal is now the default for attempt→verify→decide; two-gate required only when structurally necessary. All changes deployed. Next: D3 Pantry domain.

**2026-06-28 (session 20):** Two choice gate fixes + one prompt fix. (1) `step-executor.mjs buildDialog`: choice gate Cancel button was encoding `action: undefined` (no `value` field on Cancel option → `o.value ?? o.action` fallback added) — interactive.mjs was rejecting the click with 400. (2) `callback.mjs` + `interactive.mjs`: button label now encoded in Slack button JSON payload; confirmation text shows label ("✅ Perfect recall.") instead of raw value ("✅ 5."). Both confirmed working from Slack. (3) `parse_entity_input` v9: added two-step header parsing rule — (a) semantic inference to match header tokens to DB column names (front→front_text, name→title, etc.), (b) positional assignment locked after name resolution; value content must never override position. Confirmed working. 366/366 unit tests pass. Next: D3 Pantry domain.

**2026-06-20 (session 3):** P0 seed audit complete. Removed flashcard/quiz/Spanish/sm2/spaced_repetition references from 5 SystemContext rows and 8 Prompt rows. Generic replacement domain: book_reviews (PGD_Books). Loop variables genericised to loop_state/loop_done/current_item. Both upsert scripts run; DB confirmed current. P1–P4 complete (PGC_Prompt.domain column, generate_workflow_steps P2 extension, design_workflow_prompts P3 steps 23a–23h, delete prompt cleanup). E1 confirmed already implemented. Track H complete (chk_triggered_by constraint, R4 unit test, openapi.yaml sync). D0 (alias input gate in create_domain step 17c) complete. W4 scoped to DB view approach (no LLM math). createView added to backlog. arch-create-domain.md and arch-data.md updated. 360/360 unit tests pass. Next: Track D (D1 recreate Recipe domain) and Track W from Slack.
