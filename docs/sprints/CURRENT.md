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
- **AC6 — UC-E4 budget report:** `PGD_MonthlyExpensesByCategory` DB view created and registered; reporting workflow live and validated from Slack.
- **AC7 — Additional functionality gaps:** TBD — items to be added from gap review.

---

## Track → AC Map

| Track item | AC(s) | Status |
|---|---|---|
| A1 `generate_workflow_steps` instruction fix | AC1 | ⬜ |
| A2 `design_workflow_prompts` instruction fix | AC1 | ⬜ |
| B1 `PGC_WorkflowRun.session_id` column migration | AC2 | ⬜ |
| B2 PGC_SessionEntry writes for all `llm_call` steps | AC2 | ⬜ |
| B3 `/explain` step-selection gate | AC3 | ⬜ |
| C1 `novia_diagnostic_protocol` system context | AC4 | ⬜ |
| D1 `markdown` block type in `dialogToBlocks()` | AC5 | ⬜ |
| D2 `format_entity_display` pretty-print formatter | AC5 | ⬜ |
| D3 Audit/fix `notify` templates in generated workflows | AC5 | ⬜ |
| D4 Button/content separation + preservation audit | AC5 | ⬜ |
| D5 Modal cancel audit + `on_modal_close` dead code removal | AC5 | ⬜ |
| E1 `PGD_MonthlyExpensesByCategory` DB view + reporting workflow | AC6 | ⬜ |

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

**A2 — `design_workflow_prompts` — always "create" for system/cross-domain**
- Add rule: if a candidate match is a system prompt (`domain: null`) or belongs to a different domain, classification must be `"create"` — never `"reuse"`.
- Add uniqueness check against existing `intent_categories` before naming.
- Edit `seed_PGC_Prompt.json` (`design_workflow_prompts`), run `upsert-prompt.mjs`.

---

### Track B — Session & Explain Infrastructure

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

### Track C — Novia Diagnostic Protocol

**C1 — `novia_diagnostic_protocol` PGC_SystemContext row**
- Add `novia_diagnostic_protocol` row to `seed_PGC_SystemContext.json` with detailed on-demand diagnostic steps: read `error_log`, query `PGC_WorkflowRun`, inspect LLM call history, propose fix path.
- Add one-liner to `minds_eye_system_prompt`: "For detailed diagnostic and modification procedures, query PGC_SystemContext by key before proceeding."
- Run `upsert-system-context.mjs`.

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

### Track E — Budget Report

**E1 — UC-E4 budget report**
- Create `PGD_MonthlyExpensesByCategory` DB view manually (`GROUP BY category_id, SUM(amount) WHERE date_trunc('month', date) = date_trunc('month', NOW())`).
- Register in `PGC_Schema` + `PGC_TableMap` (`allow_read: true`).
- Use `create_workflow` to generate the reporting workflow: `serv_getRows` on view → `serv_getRows` on `PGD_Budgets` → `llm_call` to format comparison as readable Slack output.
- LLM for formatting only — no arithmetic.
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

**2026-06-29 (session 1):** Sprint 7 scoped. Dead code removal (/chat, design-domain.mjs) moved to Sprint 8 along with test env, README, and log hygiene. UI Polish track (D1–D5) added based on modal/button/rendering gaps found during Sprint 6 testing. Functionality gap list TBD — additional items to be added to tracks as gaps are identified.
