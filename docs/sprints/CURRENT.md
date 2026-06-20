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

- **AC1 — Seed audit clean:** All user-specific names removed from `seed_PGC_SystemContext.json` and `seed_PGC_Prompt.json` before any domain creation runs.
- **AC2 — Embedding on insert:** New domains are immediately discoverable by Novia and Pass 2 intent matching without a manual `backfill-embeddings.mjs` run.
- **AC3 — Track P live:** `create_workflow` includes a `design_workflow_prompts` step. Domain-specific `llm_call` steps are classified (reuse/create/convert) and new `PGC_Prompt` rows registered with `domain` set. SM-2 convert case and UC-P5 unit conversion create case both validated.
- **AC4 — Recipe domain recreated:** `create_domain` run produces a clean schema with no SRS assumptions or type errors. `create_workflow` regenerates `add_recipe`, `list_recipe`, `get_recipe` workflows. UC-R1, UC-R2, UC-R3 pass from Slack.
- **AC5 — Pantry domain created:** UC-P1 (add), UC-P2 (list), UC-P3 (update) pass from Slack.
- **AC6 — UC-P4 (receipt → pantry):** Grocery receipt OCR text → translated item mapping → confirmation gate → pantry rows updated/inserted.
- **AC7 — UC-P4 extended (receipt → pantry + expenses):** Same receipt also creates an expense record. First cross-domain write workflow. If cross-domain `create_workflow` gap blocks it, the gap is documented and scoped as a fix.
- **AC8 — Expenses domain created:** UC-E1 (add), UC-E2 (list) pass from Slack.
- **AC9 — UC-E3 (expense receipt):** Receipt OCR → expense record with line items inserted.
- **AC10 — UC-E4 (budget report):** Monthly spend vs budget by category posted to Slack. `llm_call` over rows is acceptable for MVP; `serv_aggregate` step type goes to backlog if not built.
- **AC11 — UC-P5 (subtract ingredients):** Recipe ingredients deducted from pantry using `llm_call` unit conversion. Confirmation gate before writes. Track P "create" case: unit conversion prompt registered as `PGC_Prompt` with `domain='pantry'`.
- **AC12 — PGC_Prompt.domain column live:** Column exists in DB and seed. `sm2_calculate` (id=79) tagged `domain='flashcards'`. P3 can read domain during `design_workflow_prompts`.
- **AC13 — Prompt cleanup in delete flows:** `delete_workflow` deletes `PGC_Prompt` rows where `domain = workflow.domain`. `delete_domain` deletes `PGC_Prompt` rows where `domain = input.domain`. No orphaned domain prompts after a delete run.
- **AC14 — `quiz_flashcards` workflow recreated:** Existing workflow deleted and regenerated via `create_workflow`. SM-2 convert case fires: `sm2_calculate` llm_call rewritten as `js_transform`. Quiz runs end-to-end from Slack.
- **AC15 — `chk_triggered_by` constraint updated:** `PGC_WorkflowRun.triggered_by` accepts `minds_eye` and `intent_classify` without constraint violation. No new Novia or classify-intent run rejected by DB.
- **AC16 — R4 unit test passes:** `tests/unit/` contains assertion that MINDS_EYE SQS payload uses `sessionId` key (not `existingSessionId`) when continuing an existing session.
- **AC17 — `openapi.yaml` in sync:** All active routes in `handler.mjs` (slackbot + proc) have corresponding spec entries. Stale ping variants removed. `/novia` and `/proc/minds-eye` present and accurate.
- **AC18 — User alias input in `create_domain`:** Step 17c text_input gate allows user to supply additional aliases (comma-separated). Step 18 merges them with LLM-generated aliases. Blank input proceeds without additional aliases.

---

## Track → AC Map

| Track item | AC(s) |
|---|---|
| P0 Seed audit | AC1 |
| P1 PGC_Prompt.domain column | AC12 |
| P2 generate_workflow_steps prompt | AC3 |
| P3 design_workflow_prompts step | AC3 |
| P4 Prompt cleanup in delete flows | AC13 |
| D1 Recreate Recipe domain | AC4 |
| D2 Delete + recreate quiz_flashcards | AC3, AC14 |
| D3 Create Pantry domain | AC5 |
| D4 Create Expenses domain | AC8 |
| W1 UC-P4 receipt → pantry | AC6 |
| W2 UC-P4 extended cross-domain | AC7 |
| W3 UC-E3 expense receipt | AC9 |
| W4 UC-E4 budget report | AC10 |
| W5 UC-P5 subtract ingredients | AC3, AC11 |
| E1 Embedding on insert | AC2 |
| H1 chk_triggered_by fix | AC15 |
| H2 R4 unit test | AC16 |
| H3 openapi.yaml sync | AC17 |
| D0 create_domain alias input | AC18 |

---

## Out of Scope

- UC-P5 `js_transform` sandbox — deferred to Sprint 7 or later
- `/chat` dead code removal — deferred (intentional)
- Lambda loop alarm (Track L) — no active risk signal
- Checkpoint/revert for Novia writes — Sprint 7 or later
- AC6 `design_table` decimal-boundary validation — run as a side-test when convenient, not a blocker
- Log hygiene, README bootstrap, test environment — Sprint 7

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

**D1 — Recreate Recipe domain**
- Delete existing recipe domain (PGD tables + PGC rows)
- Run `create_domain` → validates create_domain quality post seed-audit
- After domain creation: verify `PGC_DomainHelp.embedding` is non-null (AC2 check — confirms embed-on-insert is working without a backfill run)
- Validate UC-R1, UC-R2, UC-R3 from Slack

**D2 — Delete `quiz_flashcards` workflow + recreate**
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

**W2 — UC-P4 extended: receipt → pantry + expenses (cross-domain write)**
- Same receipt also creates an expense record in Expenses domain
- First cross-domain write workflow — if `create_workflow` schema injection gap blocks it, document and scope fix

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

**2026-06-20 (session 3):** P0 seed audit complete. Removed flashcard/quiz/Spanish/sm2/spaced_repetition references from 5 SystemContext rows and 8 Prompt rows. Generic replacement domain: book_reviews (PGD_Books). Loop variables genericised to loop_state/loop_done/current_item. Both upsert scripts run; DB confirmed current. P1–P4 complete (PGC_Prompt.domain column, generate_workflow_steps P2 extension, design_workflow_prompts P3 steps 23a–23h, delete prompt cleanup). E1 confirmed already implemented. Track H complete (chk_triggered_by constraint, R4 unit test, openapi.yaml sync). D0 (alias input gate in create_domain step 17c) complete. W4 scoped to DB view approach (no LLM math). createView added to backlog. arch-create-domain.md and arch-data.md updated. 360/360 unit tests pass. Next: Track D (D1 recreate Recipe domain) and Track W from Slack.
