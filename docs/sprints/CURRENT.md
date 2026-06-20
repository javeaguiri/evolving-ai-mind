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

**P1 — X2: PGC_Prompt.domain column**
- `POST /api/v1/serv/schema/addColumn` → `PGC_Prompt.domain text nullable`
- Update `PGC_Schema` seed to register column
- Backfill `sm2_calculate` (id=79) → `domain: 'flashcards'`

**P2 — Update `generate_workflow_steps` prompt**
- Domain-specific `llm_call` steps emit `prompt_draft` / `prompt_category` / `prompt_model` / `output_schema` fields
- System prompts (intent_category) keep existing shape unchanged
- Update `PGC_StepType` `llm_call` input_contract. Run `upsert-prompt.mjs` + `upsert-step-type.mjs`.

**P3 — Add `design_workflow_prompts` step to `create_workflow`**
- New `llm_call` step between `generate_workflow_steps` and L1 simulate
- Input: draft steps + existing `PGC_Prompt.intent_category` list
- Output: `capability_decisions` (reuse/create/convert per step)
- Iterator applies decisions: create → `serv_insert PGC_Prompt` with domain; reuse → record `intent_category`; convert → rewrite step as `js_transform`
- Run `upsert-workflow.mjs`

**P4 — Prompt cleanup in `delete_workflow` / `delete_domain`**
- `delete_workflow`: add `serv_delete PGC_Prompt WHERE domain = workflow.domain`
- `delete_domain`: extend to `serv_delete PGC_Prompt WHERE domain = input.domain`
- Run `upsert-workflow.mjs`

**Validation test vehicles:**
- SM-2 (`sm2_calculate`) — convert case: domain-specific llm_call → rewritten as `js_transform`
- UC-P5 unit conversion — create case: new `PGC_Prompt` registered with `domain='pantry'`

---

### Track D — Domain creation

**D1 — Recreate Recipe domain**
- Delete existing recipe domain (PGD tables + PGC rows)
- Run `create_domain` → validates create_domain quality post seed-audit
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
- Reads all expenses for current month, groups by category, compares to `PGD_Budget` limits
- `llm_call` over rows for arithmetic (MVP acceptable at household scale)
- If `llm_call` is unreliable for arithmetic, scope `serv_aggregate` step type as a backlog item

**W5 — UC-P5: subtract recipe ingredients from pantry**
- Reads recipe ingredients + current pantry state
- `llm_call` step handles unit conversion (tablespoons → oz, etc.)
- Confirmation gate before any pantry writes
- Track P "create" test: unit conversion prompt registered as `PGC_Prompt` with `domain='pantry'`

---

### Track E — Embedding on insert

**E1 — Extend `table.mjs` `insertRow`**
- When `embed_source` is defined for the table in `PGC_Schema`, call `embedText()` on the concatenated embed_source fields and write to the vector column
- Mirrors the existing `updateRows` embed path
- Extend-not-prompt principle: SERV owns all embedding; callers never supply the vector value
- All three new domains discoverable immediately after `create_domain`

---

### Track H — Housekeeping

**H1 — `chk_triggered_by` constraint fix**
- ALTER TABLE `PGC_WorkflowRun` — add `minds_eye` and `intent_classify` as valid values
- Update `PGC_Schema` seed, `executeTriggerTool` in `minds-eye.mjs`, `classify-intent.mjs`

**H2 — R4 unit test: MINDS_EYE SQS payload**
- Assert `sessionId` key (not `existingSessionId`) is present in the SQS payload when continuing a session
- Add to `tests/unit/`

**H3 — `openapi.yaml` sync audit**
- Remove or update stale ping endpoint variants
- Confirm all active routes in `handler.mjs` (slackbot + proc) have corresponding entries
- `/novia` and `/proc/minds-eye` added this sprint (already done); verify completeness

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

**2026-06-20 (session 3):** P0 seed audit complete. Removed flashcard/quiz/Spanish/sm2/spaced_repetition references from 5 SystemContext rows and 8 Prompt rows. Generic replacement domain: book_reviews (PGD_Books). Loop variables genericised to loop_state/loop_done/current_item. Both upsert scripts run; DB confirmed current. Next: P1 (PGC_Prompt.domain column).
