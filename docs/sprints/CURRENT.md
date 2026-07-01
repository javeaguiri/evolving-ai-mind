# Sprint 7 — MVP Functionality Gaps

**Status: In progress**

## Sprint Goal

Close the functionality gaps uncovered during Sprint 6 MVP testing. Release-readiness work (test environment, README bootstrap, log hygiene) moves to Sprint 8.

**Branch:** `sprint/07-mvp-functionality-gaps`

**Use case reference:** `docs/Javear-use-cases.md`

---

## Retro (from Sprint 6)

**Prompt failures requiring multiple correction cycles:**
- `generate_workflow_steps` reused system prompt `parse_entity_input` on `modify_budget` (run 590) — AJV correctly rejected the flat budget object against the entity-specific output_schema. Root cause: Instruction fault — no rule preventing domain-specific steps from referencing system prompts.
- `design_workflow_prompts` classified a system prompt candidate as "reuse" — sharing output_schema across domains breaks AJV validation per domain. Companion Instruction fix required.

**UI gaps confirmed during testing:**
- Modal cancel was advancing workflows — `handleViewClosed` had to be fixed to keep gate suspended.
- Button clicks were clobbering message content — `chat.update` with new text replaced the original notify output.
- Dialog blocks mixed content and actions, making content-preservation on click brittle.
- Entity output (`get_entity`, `list_entity`) exposes raw FK ids, null/embedding columns, and unformatted child arrays — not user-readable.
- `mrkdwn` used throughout dialogs; LLMs produce standard markdown — rendering gap.

**Functionality gaps (carry-forward from Sprint 6 out-of-scope):**
- Pantry domain not created (D3/W1/W5 scoped out — depended on cross-domain capability not yet built).
- UC-E4 budget report blocked on data; DB view approach scoped but not built.
- Cross-domain `create_workflow` has 5 identified gaps — none resolved.

**Novia ceiling:**
- Novia's diagnostic capability is bounded by the always-injected system prompt — detailed procedure steps must be in the prompt or Novia can't use them. On-demand procedure lookup via `PGC_SystemContext` is the correct fix.

---

## Acceptance Criteria

- **AC1 — Instruction fixes deployed:** `generate_workflow_steps` (no system prompt reuse) + `design_workflow_prompts` (always "create" for system/cross-domain) upserted and validated via a `create_workflow` run.
- **AC2 — Session ID on every workflow run:** `PGC_WorkflowRun.session_id` FK column migrated; `PGC_SessionEntry` rows written for every `llm_call` step regardless of `triggered_by`.
- **AC3 — `/explain` step-selection gate:** Failed runs with multiple LLM steps show a Slack button list of steps; user picks one; explain thread scoped to that step.
- **AC4 — Novia diagnostic protocol live:** `novia_diagnostic_protocol` `PGC_SystemContext` row upserted; `minds_eye_system_prompt` updated with one-liner; Novia retrieves procedures on demand.
- **AC5 — UI Polish complete:** All five sub-items (markdown blocks, format_entity_display, notify template audit, button/content separation, modal cancel audit) validated from Slack.
- **AC6 — View infrastructure + UC-E4 budget report:** `/serv/schema/createView`, `/serv/schema/dropView`, and `/proc/addView` endpoints live; `create_view` core workflow registered; `PGD_MonthlyExpensesByCategory` view created via `create_view`; budget reporting workflow live and validated from Slack.
- **AC7 — IntentMap one row per phrase:** migration splits existing combined patterns; `create_workflow` steps 35b/36 write individual rows; `matchIntentMap` unchanged.

---

## Track → AC Map

| Track item | AC(s) | Status |
|---|---|---|
| A1 `generate_workflow_steps` instruction fix | AC1 | ✅ DONE |
| A2 `design_workflow_prompts` instruction fix | AC1 | ✅ DONE |
| A3 `create_workflow` step 35a — show LLM-suggested phrases; step 35b skip fallback | AC1 | ✅ DONE |
| B1 `PGC_WorkflowRun.session_id` column migration | AC2 | ⬜ |
| B2 PGC_SessionEntry writes for all `llm_call` steps | AC2 | ⬜ |
| B3 `/explain` step-selection gate | AC3 | ⬜ |
| C3 `PGC_Prompt` write access for Novia + SOP step | AC4 | ⬜ |
| C1 `novia_diagnostic_protocol` system context | AC4 | ✅ DONE |
| C1a `js_transform_timeout_ms` configurable via `PGC_SystemContext` | AC4 | ⬜ |
| C2 Novia view tooling (`create_view`, `drop_view`) | AC4 | ⬜ |
| D1 `markdown` block type in `dialogToBlocks()` | AC5 | ⬜ |
| D2 `format_entity_display` pretty-print formatter | AC5 | ⬜ |
| D3 Audit/fix `notify` templates in generated workflows | AC5 | ⬜ |
| D4 Button/content separation + preservation audit | AC5 | ⬜ |
| D5 Modal cancel audit + `on_modal_close` dead code removal | AC5 | ⬜ |
| E1 `/serv/schema/createView` endpoint | AC6 | ⬜ |
| E2 `/serv/schema/dropView` endpoint | AC6 | ⬜ |
| E3 `/proc/addView` endpoint | AC6 | ⬜ |
| E4 `create_view` core workflow | AC6 | ⬜ |
| E5 UC-E4 budget report | AC6 | ⬜ |
| F1 `PGC_IntentMap` one row per phrase structural refactor | AC7 | ⬜ |

---

### Track F — IntentMap Structural Refactor

**F1 — `PGC_IntentMap` — one row per phrase**
- Current model concatenates all invocation phrases into one pipe-delimited regex per workflow. Phrases are opaque and non-updatable.
- Fix: one row per phrase — `{pattern, intent_category, action_type, workflow_id, source}` where `source` ∈ `user | auto | name`.
- Migration: split existing combined patterns into individual rows.
- Update `create_workflow` steps 35b/36: build one-row-per-phrase inserts instead of a joined string.
- `matchIntentMap` in `classify-intent.mjs` already iterates rows and tests each pattern — no change needed there.
- `PGC_Workflow.intent_keywords` folds into this model as `source: auto` rows, eliminating the two-store split.

---

## Out of Scope

- `/chat` dead code removal — Sprint 8
- `design-domain.mjs` dead code removal — Sprint 8
- Test environment (separate SAM stack + RDS + Slack workspace) — Sprint 8
- README bootstrap completeness — Sprint 8
- Log hygiene / CloudWatch redaction — Sprint 8
- Watchdog Lambda (Zone C recovery) — Sprint 8 or later
- `PGC_WorkflowRunStep` audit log investigation — Sprint 8 or later
- Cross-domain `create_workflow` (5 gaps) — Sprint 8 (prerequisite: Pantry + cross-domain schema coherence)
- Pantry domain (D3), UC-P4 (W1), UC-P4+ cross-domain (W2), UC-P5 subtract ingredients (W5) — Sprint 8 (blocked on cross-domain)

---

## Tracks

### Track A — Prompt Instruction Fixes

**A1 — `generate_workflow_steps` — no system prompt reuse**
- Add rule: every domain-specific `llm_call` step must emit a unique `prompt_draft`; never reference an existing system prompt (`domain: null`) by `intent_category`.
- Naming convention: `<workflow_name>_<step_purpose>`.
- Edit `seed_PGC_Prompt.json` (`generate_workflow_steps`), run `upsert-prompt.mjs`.

**A2 — `design_workflow_prompts` — fix reuse rule, example, and uniqueness guard**
Three defects in the prompt (line 2743 of `seed_PGC_Prompt.json`):
1. **`reuse` rule has no domain check** — currently matches on name alone; add: "Only classify as `reuse` when the matching entry's `domain` equals `workflow_domain`. A prompt from a different domain must be classified as `create` with a unique domain-prefixed name."
2. **Example teaches cross-domain reuse** — `probe_input` has `workflow_domain: "pantry"` but shows `sm2_calculate` (domain: `"flashcards"`) classified as `"action": "reuse"`. Change to `"action": "create"` with a domain-prefixed `prompt_category`.
3. **No uniqueness guard on new prompt names** — add to the `create` rule: "Before choosing a `prompt_category`, verify it does not already exist in `existing_categories`. If it does, prefix with the domain (e.g. `pantry_sm2_calculate`)."
- Also: filter `domain: null` rows out of step 23c `serv_query` in `seed_PGC_Workflow.json` (`create_workflow`) so system prompts never appear as reuse candidates — this is the primary fix; the prompt rule is belt-and-suspenders.
- Run `upsert-prompt.mjs` + `upsert-workflow.mjs create_workflow`.

---

### Track B — Session & Explain Infrastructure

> **Priority note:** B1+B2 are a prerequisite for Novia's full diagnostic SOP (C1/C3). Without session entries for user-triggered workflow runs, Novia can only read the prompt template — not the assembled prompt or LLM response. Prioritise B1+B2 before C3.

**B1 — `PGC_WorkflowRun.session_id` FK column**
- Migration: `POST /api/v1/serv/schema/addColumn` → `PGC_WorkflowRun.session_id integer nullable FK → PGC_Session.id`.
- Update `PGC_Schema` seed to register column.

**B2 — PGC_SessionEntry writes for all `llm_call` steps**
- `run-workflow.mjs`: assign/generate a `session_id` for every `PGC_WorkflowRun` at start.
- Write `PGC_SessionEntry` rows for every `llm_call` step regardless of `triggered_by`.

**B3 — `/explain` step-selection gate**
- When `/explain` is invoked on a failed run with multiple LLM steps, present a Slack button list of the run's `llm_call` steps (step key + `intent_category` label).
- User picks one; spawns explain thread scoped to that step only.
- Existing single-step behaviour preserved when the run has exactly one LLM step.

---

### Track C — Novia Diagnostic Protocol & View Tooling

**C1 — `novia_diagnostic_protocol` PGC_SystemContext row**
Procedures to include (on-demand, not always-injected):
1. **Failed run triage** — `query_table PGC_WorkflowRun` → read `stack` for failing step + error; branch to relevant procedure.
2. **LLM validation failure** — `read_prompt intent_category` → inspect `output_schema` + `error_log`; classify AJV error (wrong field / wrong type / wrong shape); identify fault domain; propose prompt or schema fix.
3. **Token truncation** — `read_prompt` → check `error_log.error_type: token_truncation`; double `max_output_tokens` via `update_data`; instruct user to re-run.
4. **`js_transform` timeout** — read `js_transform_timeout_ms` from `PGC_SystemContext`; increase value via `update_data`; instruct user to re-run. *(Requires C1a code change — see below.)*
5. **Routing dead end** — `read_workflow` → trace routing graph from failing step; identify dead `on_success`/`on_else` targets; propose `fix_workflow_steps`.
6. **Intent not routing / domain not found** — `query_table PGC_IntentMap` + `query_table PGC_DomainHelp`; verify pattern + aliases; propose `update_data`.
7. **Schema / FK constraint failure** — `query_table PGC_Schema` + `query_table PGC_EntitySchema`; DDL fix → `propose_schema_fix` (gated); entity schema fix → `update_data`.
8. **View diagnostics** — view returns wrong data → read view SQL from `PGC_Schema`, trace to underlying table columns; view not found → check `PGC_Schema` (type: view) + `PGC_TableMap` registration; use `create_view` to (re)register; view out of sync → `drop_view` + `create_view`.
9. **Fix authority boundary** — fix directly (no gate): token truncation, IntentMap pattern, `js_transform_timeout_ms`, entity schema. Propose + confirm: prompt text, workflow steps, DDL, views. Escalate (code change required): Execution fault domain.

Implementation:
- Add `novia_diagnostic_protocol` row to `seed_PGC_SystemContext.json`.
- Add one-liner to `minds_eye_system_prompt`: "For detailed diagnostic and modification procedures, query PGC_SystemContext by key='novia_diagnostic_protocol' before proceeding."
- Run `upsert-system-context.mjs`.

**C1a — `js_transform_timeout_ms` configurable via `PGC_SystemContext`**
- Add `js_transform_timeout_ms` row to `seed_PGC_SystemContext.json` (default: `{ "simulation": 500, "runtime": 200 }`).
- Update `simulation-engine.mjs` and `template-resolver.mjs` to read the value from `PGC_SystemContext` at call time (with hardcoded fallback).
- Run `upsert-system-context.mjs`.

**C2 — Novia view tooling (`minds-eye.mjs`)**
- Add `create_view` to `GATED_WRITE_TOOLS`: accepts `{ viewName, selectSql }`; calls `/api/v1/serv/schema/createView`; confirms with user before executing.
- Add `drop_view` to `GATED_WRITE_TOOLS`: accepts `{ viewName }`; calls drop endpoint; danger gate (same pattern as `drop_table`).
- `query_table` already works on registered views (they appear in `PGC_TableMap`) — no change needed.
- Update `minds_eye_system_prompt` to document both tools with when-to-use guidance.
- Run `upsert-system-context.mjs`.

**C3 — `PGC_Prompt` write access for Novia + SOP step**
- C1 (novia_diagnostic_protocol) lists "propose + confirm: prompt text" as a fix authority, but `update_data` silently fails on `PGC_Prompt` because it is not registered in `PGC_TableMap` as writable.
- Fix 1: register `PGC_Prompt` in `PGC_TableMap` with `allow_write: true` (gated — Novia proposes, user confirms, same pattern as other PGC write operations).
- Fix 2: add procedure 10 to `novia_diagnostic_protocol`: "To fix a prompt instruction gap — (a) query `PGC_SessionEntry` for the assembled prompt content (requires B2 live); (b) identify the missing or wrong instruction; (c) read the current `prompt_text` via `read_prompt`; (d) propose the corrected text via `update_data PGC_Prompt` (gated — user must confirm before write)."
- Run `upsert-system-context.mjs` after updating `seed_PGC_SystemContext.json`.
- **Depends on B1+B2** for full effectiveness (step (a) above requires session entries to exist).

---

### Track D — UI Polish

**D1 — `markdown` block type in `dialogToBlocks()`**
- Replace `mrkdwn` with `markdown` blocks for `typography` and `description_list` fields in `callback.mjs`.
- Update `design_workflow_dialogs` prompt to document available formatting syntax so generated workflows produce richer gate dialogs.

**D2 — `format_entity_display` pretty-print formatter**
- Add shared `format_entity_display` PGC_Prompt (right-brain, cheap model).
- Inputs: `entity_json` (raw result), `entity_schema` (column definitions + FK lookup hints).
- Output: clean Slack-ready markdown — nulls and `*_embedding` columns elided, FK ids replaced with lookup values, child arrays rendered as readable lists.
- Wire as final `llm_call` step before `notify` in both `get_entity` and `list_entity` workflows.

**D3 — Audit/fix `notify` templates in generated domain workflows**
- Identify templates emitting raw JSON or unformatted field dumps across all registered domain workflows.
- Update `generate_crud_workflows` and `design_workflow_dialogs` prompts to produce markdown-rich output by default.

**D4 — Button/content separation + content-preservation audit**
- Enforce structural convention: content blocks (section, markdown, description_list) and action blocks (buttons) must always be separate `blocks` array entries.
- On any button click or dialog submission, filter out only the `actions` block and call `chat.update` with remaining content blocks intact — never replace the full message.
- Audit all interactive handlers in `slackbot/` (`handleExplainFollowupButton`, `handleMindsEyeFollowupButton`, all gate response paths).
- Update `design_workflow_dialogs` prompt to always emit content and buttons as separate blocks.

**D5 — Modal cancel audit + `on_modal_close` dead code removal**
- Confirm `handleViewClosed` does not enqueue `resume_gate` (gate stays suspended — correct).
- Remove `on_modal_close` dead code branch from `run-workflow.mjs`.
- Scan all `PGC_Workflow` rows for `on_modal_close` option declarations and remove them.

---

### Track E — View Infrastructure & Budget Report

**E1 — `/serv/schema/createView` endpoint**
- Add `createView` case to `schema.mjs` alongside `createTable`.
- Accepts `{ viewName, selectSql, target }`: runs `CREATE OR REPLACE VIEW "${viewName}" AS ${selectSql}`, registers in `PGC_Schema` (target: pgd, type: view) and `PGC_TableMap` (allow_read: true).
- Existing `serv_getRows` can query registered views with no step type changes.
- Add endpoint to `openapi.yaml`.

**E2 — `/serv/schema/dropView` endpoint**
- Accepts `{ viewName }`: runs `DROP VIEW IF EXISTS "${viewName}"`, removes rows from `PGC_Schema` and `PGC_TableMap`.
- Used by the `create_view` workflow iteration loop when the user rejects the current design and requests changes.
- Also used by Novia `drop_view` tool (C2).
- Add endpoint to `openapi.yaml`.

**E3 — `/proc/addView` endpoint**
- New `proc/add-view.mjs` handler: accepts `{ viewName, selectSql, description }`, calls SERV `createView`, returns registration confirmation.
- First-class callable endpoint — invocable directly from Slack/Novia AND as a workflow step in the `create_view` workflow.
- Wire into `proc/handler.mjs`.
- Add endpoint to `openapi.yaml`.

**E4 — `create_view` core workflow**
- New system workflow following the `create_domain` pattern: user-guided LLM design → create → test with live data → iterate → confirm.
- Steps: (1) load domain schema from `PGC_Schema`; (2) LLM (left-brain, smart) designs `SELECT` / `GROUP BY` / aggregations + view name; (3) human gate — review proposed SQL; (4) call `/proc/addView` to create the view; (5) `serv_getRows` on the new view — sample rows from live data; (6) human gate — show sample results, approve or request changes; (7) if changes → `dropView` + loop back to step 2 with feedback; (8) if approved → notify.
- Registered as a seed workflow in `seed_PGC_Workflow.json`.

**E5 — UC-E4 budget report**
- Run `create_view` workflow to create `PGD_MonthlyExpensesByCategory` (GROUP BY category, SUM(amount), current month).
- Use `create_workflow` to generate the reporting workflow: `serv_getRows` on view → `serv_getRows` on `PGD_Budgets` → `llm_call` to format comparison as readable Slack output. LLM for formatting only — no arithmetic.
- Validate end-to-end from Slack once expenses + budgets have sufficient real data.

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] L1 + L2 simulation passes on all new or modified workflows
- [ ] All ACs validated from Slack (by user)
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated if any `.mjs` files added/removed/renamed
- [ ] `docs/arch-data.md` updated for any schema changes
- [ ] `docs/backlog.md` updated — completed items, new items from sprint
- [ ] `openapi.yaml` updated for any new endpoints
- [ ] `CURRENT.md` renamed to `sprint-07.md` with outcome notes

---

## Session Notes

**2026-06-29 (session 1):** Sprint 7 scoped. Dead code removal (/chat, design-domain.mjs) moved to Sprint 8 along with test env, README, and log hygiene. Track A fleshed out: A1 (generate_workflow_steps no-reuse rule) + A2 (design_workflow_prompts — three defects identified: no domain check on reuse rule, example teaches cross-domain reuse, no uniqueness guard; primary fix is filtering domain:null from step 23c query). Track C expanded: C1 with 9 diagnostic procedures including view diagnostics, C1a (js_transform_timeout_ms configurable via PGC_SystemContext), C2 (Novia create_view/drop_view tools). Track E rescoped: E1 createView + E2 dropView SERV endpoints, E3 /proc/addView (callable standalone or from workflow step), E4 create_view core workflow (LLM design → create → serv_getRows live test → approve or drop+iterate), E5 UC-E4 budget report. UI Polish track (D1–D5) added. Functionality gap list TBD — additional items to be added to tracks as gaps are identified.

**2026-07-01 (session 3):** Diagnosed runs 613–617. Root causes: (1) generate_workflow_steps v40 — 6 of 10 SystemContext tokens were dead (inject_for declared but {{token}} missing from prompt text); wired step_type_contracts, step_usage_patterns, workflow_constraints. (2) workflow_routing_rules v2 — condition routing contradiction removed; both bare keys and step:N now accepted. (3) generate_workflow_steps v41 — output_schema serv_insert.row type constraint removed; template strings and arrays now accepted. (4) bulk_import_budgets run 617 — section headers treated as categories + invalid type values in budgets_parse_spreadsheet_input prompt_draft (Generation fault; Novia fixed workflow to v3; prompt fix deferred to C3). Added C3 (PGC_Prompt write access + Novia SOP step for prompt fixes) and priority note on B1+B2 as prerequisite for Novia run-scoped diagnostics.

**2026-06-30 (session 2):** Diagnosed and fixed multiple create_workflow + import_budget_from_csv failures (runs 608–613). Fixes: (1) string arrays in `reveals` collapsed into single bulleted reveal (step-executor.mjs); (2) empty reveal content guard in callback.mjs; (3) iterator catch blocks use optional chaining so WORKFLOW_ERROR always fires (run-workflow.mjs); (4) L1 iterator_missing_item_step check added to simulation-engine.mjs; (5) generate_workflow_steps output_schema allOf extended to enforce required fields for all 9 step types (v38); (6) design_workflow_prompts v4 — prior-pass reuse injects capability_decisions into retry so unchanged steps are copied verbatim; (7) create_workflow v73/74 — step 22a captures previous_prompt_designs, step 23d injects it + simulation_error_summary, step 18 reads p.prompt_model; (8) analyze_workflow_gaps v13 — explicit prompt_model field instruction, model alias removed from schema; (9) simulation-engine.mjs — iterator_missing_item_step skipped in skeleton mode (was false-positiving on step 21b BFS, causing infinite loop at step 21c); (10) generate_workflow_steps v39 — rule 8: prefer serv_insert array over iterator for bulk inserts of new rows.
