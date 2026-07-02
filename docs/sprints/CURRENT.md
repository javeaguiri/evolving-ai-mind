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
- **AC8 — `serv_upsert` step type live:** `/serv/table/upsertRows` endpoint + `serv_upsert` step type registered (`PGC_StepType`, `serv_db_step_shapes`, `generate_workflow_steps` known-step-types list); validated end-to-end from Slack.

---

## Track → AC Map

| Track item | AC(s) | Status |
|---|---|---|
| A1 `generate_workflow_steps` instruction fix | AC1 | ✅ DONE |
| A2 `design_workflow_prompts` instruction fix | AC1 | ✅ DONE |
| A3 `create_workflow` step 35a — show LLM-suggested phrases; step 35b skip fallback | AC1 | ✅ DONE |
| B1 `PGC_WorkflowRun.session_id` column migration | AC2 | ✅ N/A — column already exists (Sprint 4), unused; not needed (see Track B notes) |
| B2 PGC_SessionEntry writes for all `llm_call` steps | AC2 | ✅ DONE |
| B3 `/explain` step-selection gate | AC3 | ✅ DONE |
| C3 `PGC_Prompt` write access for Novia + SOP step | AC4 | ⬜ |
| A4 Standard global params (`userInput`, `domain`) in prompts + classify-intent domain fallback | AC1 | ✅ DONE |
| A5 Enum constraint rule in `design_workflow_process` + `design_workflow_prompts` | AC1 | ✅ DONE |
| A6 Reveal content rule in `design_workflow_dialogs` | AC1 | ✅ DONE |
| A7 Raw data parsing rule in `generate_workflow_steps` | AC1 | ✅ DONE |
| G1 `step-executor.mjs` — serv_insert bulk always returns array | AC1 | ✅ DONE |
| G2 `research_workflow_domain` surfaces raw input format (section headers, collapsed tables) | AC1 | ⬜ |
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
| H1 SERV-Table `upsertRows` (`table.mjs` + endpoint) | AC8 | ⬜ |
| H2 `serv_upsert` step type (`step-executor.mjs` + `PGC_StepType`) | AC8 | ⬜ |
| H3 Prompt/context wiring (`serv_db_step_shapes`, `generate_workflow_steps`, `step_type_contracts`) | AC8 | ⬜ |

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

### Track G — Raw Input Parsing + serv_insert Consistency

**G1 — `step-executor.mjs` — serv_insert bulk always returns array**
- The bulk insert path returns `resp.rows ?? { tableName, inserted: row.length }`. When SERV returns a single-item object instead of an array (one-row bulk), downstream js_transform `.forEach()` / `.map()` calls crash.
- Fix: `outputValue: Array.isArray(resp.rows) ? resp.rows : resp.rows ? [resp.rows] : []` — always array.

**G2 — `research_workflow_domain` — surface raw input format**
- When the workflow intent involves parsing copy-pasted spreadsheet data, receipt photos, or other degraded-format input, `research_workflow_domain` must emit a findings entry flagging the raw input format: section headers that double as type/category labels, collapsed columns, headings appearing as individual plain-text lines.
- This feeds `design_workflow_process` → `design_notes` for the parsing step → `generate_workflow_steps` prompt_draft, completing the chain that A7 starts from the other end.
- Update `research_workflow_domain` prompt to look for keywords like "paste", "copy", "photo", "receipt", "import", "spreadsheet" in userInput and emit a structured finding about expected input format.

### Track A — Prompt Instruction Fixes (additions)

**A4 — Standard global params in prompts + classify-intent domain fallback**
- `generate_workflow_steps` TRANSLATION RULES: document `{{input.userInput}}` (camelCase — never snake_case) and `{{input.domain}}` as standard variables always available without a preceding step.
- `design_workflow_process`, `design_workflow_dialogs`, `design_workflow_prompts`: add matching note on global params where relevant.
- `classify-intent.mjs` line 427: after fetching the workflow row, set `workflowDomain = result.domain ?? wfResp.rows[0].domain ?? null` and use it in `workflowInput.domain`. Ensures domain-registered workflows always receive their domain even when Pass 2 alias lookup didn't resolve it.

**A5 — Enum constraint rule**
- `design_workflow_process`: when designing a step that assigns an enum-constrained column (check constraint in domain_schema), include the exact allowed values in the step's `description` or `design_notes` so generate_workflow_steps can copy them into prompt_draft.
- `design_workflow_prompts`: when writing `prompt_text` for a step that assigns an enum-constrained column, copy the exact allowed values from domain_schema check constraints and explicitly forbid all other values.

**A6 — Reveal content rule in `design_workflow_dialogs`**
- `reveal.content` must reference a pre-formatted string key written by a preceding js_transform — never a raw array or object key. Directly referencing an array key renders as `[object Object]` at runtime.
- Add to design_workflow_dialogs reveal / reveals field instructions.

**A7 — Raw data parsing rule in `generate_workflow_steps`**
- When an llm_call step parses copy-pasted or scanned data, the input may originate from a pivot table or aggregated view where row group labels serve as dimension values for rows beneath them, not as data records. Copy-pasting may collapse the table structure so labels and column headers arrive as individual plain-text lines mixed with data.
- Where this pattern applies, prompt_draft should describe the un-pivot transformation in domain-specific language: group label levels adapted to actual domain column names and check constraint values from domain_schema. Avoid generic terms like "heading"/"sub-heading" in prompt_draft — prefer real column names where they can be inferred.
- Includes a state → city → person example showing pivot source, degraded arrival, and expected flat output. The parsing LLM should use judgment when input doesn't map cleanly; goal is the flattest representation the downstream serv_insert can consume.
- Language is intentionally softened (should/may/where applicable) since inference must adjust to actual data shape.

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
- `create_domain`/`design_table` compound unique constraint detection + native `ON CONFLICT` upgrade for `serv_upsert` — Sprint 8 (see backlog; Sprint 7's `serv_upsert` works around the missing constraint with query-then-write)

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

> **Priority note:** B2+B3 are a prerequisite for Novia's full diagnostic SOP (C1/C3). Without session entries for every workflow run, Novia can only read the prompt template — not the assembled prompt or LLM response. Prioritise B2+B3 before C3.

**B1 — `PGC_WorkflowRun.session_id` FK column — not needed**
- Re-diagnosed 2026-07-01: this column already exists (added Sprint 4) but is unused in code — no writer anywhere. It also points the wrong direction for what Track B needs: `PGC_Session.run_id` (already indexed) is the lookup Novia and `/explain` actually use, not `PGC_WorkflowRun.session_id`. No migration performed; column left as-is (harmless, unread).

**B2 — PGC_SessionEntry writes for all `llm_call` steps — DONE**
- The session-write mechanism already existed in `llm-harness.mjs`, gated by a `PGC_SystemContext.diagnostics_config.enabled_workflows` allowlist (only `create_workflow`/`create_domain`/`add_entity`) — this is exactly why Novia couldn't inspect the run 621 `parse_budget_input` step.
- Fix: removed the allowlist gate entirely — every `llm_call` step in every workflow now writes a `PGC_Session` + `PGC_SessionEntry` rows unconditionally (`llm-harness.mjs`). Removed the now-dead `diagnostics_config` entry from `seed_PGC_SystemContext.json` (DB row left orphaned — `PGC_SystemContext.allow_delete` is `false`, and it's unread by any code now).
- Also removed the standalone `LLM_DIAGNOSTIC` per-step Slack notification (`run-workflow.mjs`, `callback.mjs` `postLlmDiagnostic`) and the `diagnosticPayload` plumbing in `llm-harness.mjs` that fed it — with the gate removed it would have spammed one channel message per LLM call in every workflow run. `run_id` is already shown in every `HUMAN_NOTIFICATION`/`WORKFLOW_ERROR` footer, and B3 (`/explain <run_id>`) now supersedes the need to proactively surface `query_id` per step.

**B3 — `/explain <run_id>` step-selection gate — DONE**
- Two corrections made 2026-07-01 after user review: (1) first pass wrongly required the question to be typed inline with `run_id` and embedded it into every step button — the same question would get blindly reused regardless of which step got clicked; fixed by never accepting the question inline for `run_id`, collecting it only *after* a specific step is chosen. (2) the slash command no longer accepts a direct `query_id` at all — a user should never need to type or see one; `query_id` is now purely internal plumbing (step-select modal submission, "Ask follow-up" button), never a user-facing input.
- `ui/slackbot/explain.mjs`: `/explain <run_id>` is the only accepted form — `text` must be an integer, no prompt parsed at all. ACKs and fire-and-forget enqueues `EXPLAIN_QUERY` with just `runId`.
- `proc/explain.mjs`: `runId` always queries `PGC_Session` by `run_id` and always posts the step picker (even for a single session — no shortcut) via `EXPLAIN_STEP_SELECT`; never calls the LLM in this branch. The `queryId`+`prompt` branch is retained but is internal-only now (reached from interactive.mjs, not the slash command).
- `ui/slackbot/callback.mjs`: `EXPLAIN_STEP_SELECT` case + `postExplainStepSelect()` — one button per step (step key + `intent_category`); button value carries only `queryId`, no question.
- `ui/slackbot/interactive.mjs`: `explain_step_select` button handler disables the picker, then opens the *same* question-collection modal (`explain_followup_modal`) used by the existing "Ask follow-up" button, using the click's own fresh `trigger_id`. Modal submission reuses `handleExplainViewSubmission` unchanged, which enqueues `EXPLAIN_QUERY` with the resolved `query_id` + typed question — resumes exactly like a direct conversation turn, "Ask follow-up" button included.
- `docs/openapi.yaml` and `docs/architecture.md` (message-type table) updated.

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

**C3 — Novia SOP: prompt fix procedure**
- `PGC_Prompt` already has `allow_update: true` in `PGC_TableMap` — `update_data` works on it today. Novia's advisory claiming it was not registered was incorrect; the gap is knowledge, not access.
- Add procedure 10 to `novia_diagnostic_protocol` in `seed_PGC_SystemContext.json`: "To fix a prompt instruction gap — (a) query `PGC_SessionEntry` for the assembled prompt and LLM response for the failing step (requires B2 live — skip (a) until then); (b) identify the missing or wrong instruction; (c) read the current `prompt_text` via `read_prompt`; (d) apply the corrected `prompt_text` via `update_data` on `PGC_Prompt` filtered by `intent_category` — this is a direct write, no gate."
- Run `upsert-system-context.mjs`.
- **Depends on B1+B2** for step (a) — until session entries exist for user-triggered runs, Novia works from output shape alone.

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

### Track H — `serv_upsert` Step Type (workaround, no DB constraint)

**Context (run 623 diagnosis):** `import_budget_data` (workflow 348) hand-rolled insert-vs-update resolution across 4 steps — build per-record lookup filters (js_transform), query existing rows (serv_query), diff into insert/update lists (js_transform), conditional write. Step 11's js_transform produced an array of per-record filter-groups (`[[{col,op,val}×3], [...], ...]`) and fed it straight into step 12's `serv_query.filters`, which only accepts a flat AND-combined filter array — runtime failure "each filter must have a column". Root cause: Instruction gap (`serv_db_step_shapes` documents the flat-filter contract and `in` op but gives no pattern for "resolve insert vs update against existing rows"). Fix direction agreed: this reusable check-existence-then-write logic belongs in the harness as a step type, not re-derived by the LLM per workflow.

`PGD_Budgets` has no compound unique constraint on `(year, month, category_id)` today — no table in the system currently declares compound unique constraints. Native `INSERT ... ON CONFLICT` isn't available yet. Sprint 7 implements `serv_upsert` as a query-then-write workaround (system code does the lookup+diff that steps 10–13 did manually, in one step). Sprint 8 adds compound unique constraint inference to `design_table`/`create_domain` and upgrades `serv_upsert` to native `ON CONFLICT` where a constraint exists, falling back to the workaround otherwise — see backlog.

**H1 — SERV-Table `upsertRows` (`table.mjs` + new endpoint)**
- New `upsertRows({ tableName, matchColumns, rows })`: for each row, query existing row(s) matching `matchColumns` values against the row's own values, then `insertRow` or `updateRows` by id — inside a transaction per batch.
- No `ON CONFLICT` — query-then-write, matching the current manual pattern but as one system call instead of four workflow steps.
- New `/api/v1/serv/table/upsertRows` endpoint. Add to `openapi.yaml`.

**H2 — `serv_upsert` step type (`step-executor.mjs` + `PGC_StepType`)**
- Input: `{ tableName, matchColumns: string[], rows: array | {{template}} }`.
- Calls SERV `upsertRows`; returns `{ inserted: [...], updated: [...] }` as `output_key`.
- Register in `PGC_StepType`.

**H3 — Prompt/context wiring**
- Add `serv_upsert` example to `serv_db_step_shapes` (matchColumns + rows shape; when to use vs. `serv_insert`/`serv_update`; explicitly warn against building per-record filter-group arrays for `serv_query`).
- Add `serv_upsert` to `generate_workflow_steps` known-step-types list and `step_type_contracts` per the `PGC_StepType` registration rule in CLAUDE.md.
- Run `upsert-step-type.mjs` + `upsert-system-context.mjs` + `upsert-prompt.mjs`.

**Validation:** repair `import_budget_data` via `fix_workflow_steps` (not a manual patch) once `serv_upsert` is live, replacing steps 10–13/16; validate end-to-end from Slack with a re-run of the run 623 scenario.

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

**2026-07-02 (session 6):** Diagnosed run 623 (`import_budget_data`, workflow 348) with `/explain 623` — step 12 failed "each filter must have a column". Root cause: step 11 (js_transform) built a per-record array-of-filter-groups intended for OR-across-records matching; step 12 (`serv_query`) only accepts a flat AND-filter array per `serv_db_step_shapes`. Not a harness gap (no genuinely new OR-of-composite-tuples query capability needed — year/month were invariant across the batch, `in` on `category_id` alone would have worked). Agreed this is instead a step-type capability gap: insert-vs-update resolution is generic infra logic that belongs in the harness, not hand-rolled per workflow. Scoped **Track H — `serv_upsert`**: Sprint 7 implements it as a query-then-write workaround (`PGD_Budgets` has no compound unique constraint today, so native `ON CONFLICT` isn't available); Sprint 8 adds compound unique constraint inference to `design_table`/`create_domain` and upgrades to native `ON CONFLICT` (added to backlog). Not yet implemented — next session.

**2026-07-01 (session 5):** Track B implemented (B2, B3; B1 found unnecessary — see Track B notes). B2: removed the 3-workflow `enabled_workflows` allowlist gating diagnostic session writes in `llm-harness.mjs` (universal now) and the `LLM_DIAGNOSTIC` per-step notification it would otherwise spam; `run_id` already visible in every notify/error footer. B3 went through two corrections from live testing (run 621/622/623) and user review before landing: (1) initial design let a question typed inline with `run_id` get blindly reused across whichever step button was clicked — fixed by never accepting the question inline for `run_id`, always showing the step picker first and collecting the question via modal only after a step is chosen; (2) direct `query_id` slash-command input removed entirely — a user should never type/see one; it's internal-only now (step-select modal submission, "Ask follow-up" button). Also caught and fixed a real process gap along the way: code was pushed to GitHub but not deployed before live testing began, causing confusing stale-code errors — see `feedback_deploy_before_live_test` memory. Two `sam deploy`s done this session; both live. All 366 unit tests pass. **Not yet validated from Slack** — user will test `/explain 623` tomorrow. Next: validate B3 live, then C3 Novia SOP prompt-fix procedure (B2/B3 prerequisite now satisfied) or C1/C2 view tooling.

**2026-06-29 (session 1):** Sprint 7 scoped. Dead code removal (/chat, design-domain.mjs) moved to Sprint 8 along with test env, README, and log hygiene. Track A fleshed out: A1 (generate_workflow_steps no-reuse rule) + A2 (design_workflow_prompts — three defects identified: no domain check on reuse rule, example teaches cross-domain reuse, no uniqueness guard; primary fix is filtering domain:null from step 23c query). Track C expanded: C1 with 9 diagnostic procedures including view diagnostics, C1a (js_transform_timeout_ms configurable via PGC_SystemContext), C2 (Novia create_view/drop_view tools). Track E rescoped: E1 createView + E2 dropView SERV endpoints, E3 /proc/addView (callable standalone or from workflow step), E4 create_view core workflow (LLM design → create → serv_getRows live test → approve or drop+iterate), E5 UC-E4 budget report. UI Polish track (D1–D5) added. Functionality gap list TBD — additional items to be added to tracks as gaps are identified.

**2026-07-01 (session 4):** Completed A4–A7 + G1. Applied softened A7 pivot table rule to generate_workflow_steps v43 (neutral state→city→person example, hedged language). Added pivot table rules to design_workflow_process v18 (short flag in design_notes) and design_workflow_prompts v6 (full rule + generic example + expenses domain translation showing type/category_name/planned_amount mapping). Diagnosed run 621 (import_budget_data wf 348): parsing step produced 17 records — 13 correct, 4 spurious (section labels "DISCRETIONARY EXPENSES"/"NON-DISCRETIONARY EXPENSES" and column headers "Category"/"Monthly Amount" leaked as category_names with amt=0). Root fault: Generation (section labels explicitly excluded in prompt, LLM disobeyed) + minor Instruction ("Monthly Amount" not listed in header exclusion examples in design_workflow_prompts v6). Deferred fix: design_workflow_prompts v7 to add "Monthly Amount" + stronger "do not emit" wording; also needs parse_budget_input (id 107) Novia correction. Next session: implement Track B (B1 session_id column, B2 SessionEntry for all llm_call steps) — prerequisite for /explain step-selection gate and asking the LLM why it ignored prompt rules.

**2026-07-01 (session 3):** Diagnosed runs 613–617. Root causes: (1) generate_workflow_steps v40 — 6 of 10 SystemContext tokens were dead (inject_for declared but {{token}} missing from prompt text); wired step_type_contracts, step_usage_patterns, workflow_constraints. (2) workflow_routing_rules v2 — condition routing contradiction removed; both bare keys and step:N now accepted. (3) generate_workflow_steps v41 — output_schema serv_insert.row type constraint removed; template strings and arrays now accepted. (4) bulk_import_budgets run 617 — section headers treated as categories + invalid type values in budgets_parse_spreadsheet_input prompt_draft (Generation fault; Novia fixed workflow to v3; prompt fix deferred to C3). Added C3 (PGC_Prompt write access + Novia SOP step for prompt fixes) and priority note on B1+B2 as prerequisite for Novia run-scoped diagnostics.

**2026-06-30 (session 2):** Diagnosed and fixed multiple create_workflow + import_budget_from_csv failures (runs 608–613). Fixes: (1) string arrays in `reveals` collapsed into single bulleted reveal (step-executor.mjs); (2) empty reveal content guard in callback.mjs; (3) iterator catch blocks use optional chaining so WORKFLOW_ERROR always fires (run-workflow.mjs); (4) L1 iterator_missing_item_step check added to simulation-engine.mjs; (5) generate_workflow_steps output_schema allOf extended to enforce required fields for all 9 step types (v38); (6) design_workflow_prompts v4 — prior-pass reuse injects capability_decisions into retry so unchanged steps are copied verbatim; (7) create_workflow v73/74 — step 22a captures previous_prompt_designs, step 23d injects it + simulation_error_summary, step 18 reads p.prompt_model; (8) analyze_workflow_gaps v13 — explicit prompt_model field instruction, model alias removed from schema; (9) simulation-engine.mjs — iterator_missing_item_step skipped in skeleton mode (was false-positiving on step 21b BFS, causing infinite loop at step 21c); (10) generate_workflow_steps v39 — rule 8: prefer serv_insert array over iterator for bulk inserts of new rows.
