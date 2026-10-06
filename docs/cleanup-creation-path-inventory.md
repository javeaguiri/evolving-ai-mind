# Dead creation path — deletion inventory
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Status: **Inventory only — nothing has been deleted.** Branch `cleanup/dead-creation-path`.
Read live 2026-10-06 from the repository and the production database.

**How to use this list:** strike any item that must stay, then deletion runs pass by pass. Each item
carries the evidence that it is dead. Evidence is a reference search plus run history, never a grep
alone.

| Pass | Covers | When |
|---|---|---|
| **A** | The workflow-creation path Novia has replaced, and code already dead | Now, once this list is approved |
| **B** | The domain-creation path | After Novia can create a domain and it has been tested from Slack |
| **Decide** | Items alive in the code but questionable in value | Before Pass A |

---

## 1. Findings that change the plan

1. **The repair chain runs automatically on every workflow failure.** `run-workflow.mjs:229, 272,
   375` enqueue `TROUBLESHOOT_WORKFLOW` with `autoFix: true` whenever a step fails;
   `troubleshoot-workflow.mjs:137` then chains `FIX_WORKFLOW`, which runs `fix_workflow` (316) — last
   run 2026-09-10, **failed**. `run-workflow.mjs:367` likewise enqueues `DIAGNOSE_PROMPT_SCHEMA` on any
   `llm_call` API 400. Deleting `fix_workflow` without changing these triggers leaves every failure
   enqueuing a message whose handler is gone. See D1–D2.
2. **Novia cannot create a table.** Her write tools are `register_workflow`, `propose_workflow_fix`,
   `propose_schema_fix`, `delete_data`, `drop_table`, `create_view`, `drop_view` and the inline data
   writes; table DDL runs only inside `create_domain`'s `serv_schema` steps. **Pass B waits on a new
   gated domain-creation tool.**
3. **Deleting a workflow row deletes its run history.** `PGC_WorkflowRun.workflow_id` is `ON DELETE
   RESTRICT`. The system's own `/delete-workflow` route already removes runs and run steps first
   (`delete-workflow.mjs`), so it is the deletion mechanism for workflow rows: `create_workflow` takes
   98 runs with it, `create_domain` 47.
4. **Most dead prompts are not in any seed file.** 29 dead prompt categories live only in the database
   (§5.3). Seeded rows are removed through the seed file and the upsert scripts; unseeded rows need
   a deletion route — Novia's gated `delete_data`, or a dev script.
5. **Two things that look dead are alive.** `classify_intent_tier2` is used by `classify-intent.mjs`
   with no workflow reference, and Novia's sessions read `template_syntax` (14 `minds_eye` sessions,
   last 2026-09-20). Both stay.

---

## 2. Workflows

Run history read live.

| Item | Runs | Last run | Pass | Evidence |
|---|---|---|---|---|
| `create_workflow` (2) | 98 | 2026-07-25 | **A** | Replaced by Novia's `register_workflow` |
| `fix_workflow` (316) | 4 | 2026-09-10 (failed) | **A**, after D1 | Replaced by Novia's `propose_workflow_fix`; still auto-triggered (finding 1) |
| `create_domain` (1) | 47 | 2026-08-10 | **B** | Only path that creates tables today (finding 2) |
| `diagnose_prompt_schema` (317) | 2 | 2026-06-21 | **Decide** (D2) | Auto-triggered on `llm_call` API 400 |
| `update_entity` (344) | 0 | never | **Decide** (D3) | Generic CRUD, 12 intent patterns route to it, never run |
| `delete_entity` (315) | 0 | never | **Decide** (D3) | Same |
| `domain_request` | — | — | **A** | Present in `seed_PGC_Workflow.json`, absent from the database |

**Keep:** `help`, `get_entity`, `list_entity`, `add_entity`, `ping_core`, and every domain workflow.

---

## 3. PROC code — `src/proc/`

| File | Pass | Entered by | Evidence |
|---|---|---|---|
| `create-workflow.mjs` | **A** | `CREATE_WORKFLOW` (Slack `/create-workflow`, `classify-intent.mjs:547` heavy_lift) and HTTP `create-workflow` | Starts the `create_workflow` workflow |
| `fix-workflow.mjs` | **A**, after D1 | `FIX_WORKFLOW` from `troubleshoot-workflow.mjs:137` | Starts `fix_workflow` |
| `design-domain.mjs` | **A** | `DESIGN_DOMAIN` and HTTP `design-domain` | No code enqueues `DESIGN_DOMAIN`; confirmed dead earlier. Imports `review-output.mjs`; mentioned in a comment at `callback.mjs:556` |
| `llm-test.mjs` | **A** | Nothing | No import, no route |
| `migrations/seed-create-domain-prompt.mjs`, `-v2.mjs` | **A** | Nothing | One-off seed migrations, superseded by `upsert-prompt.mjs` |
| `scaffolds/recipes.json` | **A** | Nothing | No reference in `src/` |
| `troubleshoot-workflow.mjs` | **Decide** (D1) | `TROUBLESHOOT_WORKFLOW`, auto on failure; HTTP | Also a named consumer of `simulation-engine.mjs` |
| `diagnose-prompt-schema.mjs` | **Decide** (D2) | `DIAGNOSE_PROMPT_SCHEMA`, auto on API 400; HTTP | Starts `diagnose_prompt_schema` |
| `create-domain.mjs` | **B** | `CREATE_DOMAIN` (Slack `/create-domain`, heavy_lift); HTTP | Starts `create_domain` |
| `handler.mjs` | A / B | — | Remove each deleted module's import, SQS branch and HTTP case |
| `classify-intent.mjs`, `classify-intent-tiers.mjs` | A / B | — | Remove the `create_workflow` (A) and `create_domain` (B) routes in `resolveTier3Route`, `classify-intent-tiers.mjs:471-476` |
| `run-workflow.mjs` | per D1/D2 | — | The automatic triggers in finding 1 |
| `step-executor.mjs` | **A** | — | The `simulate` case and `executeSimulate` (§4) |

**Keep, though adjacent:** `monitor-prompt-quality.mjs` — triggered by `review-output.mjs:177` on
every `llm_call` validation failure, for any prompt. `simulate-workflow.mjs` and
`simulation-engine.mjs` — Novia's `simulate_workflow` and `upsert-workflow.mjs`'s guard use them.
`delete-domain.mjs`, `delete-workflow.mjs` — the deletion routes this cleanup itself uses.

---

## 4. Slack, step types and intent routes

| Item | Pass | Evidence |
|---|---|---|
| `src/ui/slackbot/create-workflow.mjs` and the `create-workflow` route in `handler.mjs` | **A** | Enqueues `CREATE_WORKFLOW` |
| The `/create-workflow` slash command in the Slack app configuration | **A** | Outside the repository — removed in the Slack app settings |
| `src/ui/slackbot/create-domain.mjs`, its route, the `/create-domain` slash command | **B** | Enqueues `CREATE_DOMAIN` |
| `PGC_StepType` row `simulate` + its seed entry | **A** | Used only by `create_workflow` and `fix_workflow` |
| `PGC_StepType` row `serv_schema` | **Decide** (D4) | Used only by `create_domain`; Novia's domain tool may call SERV schema endpoints directly instead |
| `PGC_IntentMap` heavy_lift `create_workflow` | **A** | Seeded |
| `PGC_IntentMap` heavy_lift `create_domain` | **B** | Seeded |

**Keep:** `write_memory` — only `create_domain` uses it today, but it is a generic step type Novia
can author.

---

## 5. Prompts — `PGC_Prompt`

Usage is a match on `"prompt": "<category>"` in every live `PGC_Workflow.steps`, plus a code search.

### 5.1 Pass A — the workflow-creation chain (seeded)

`analyze_workflow_gaps`, `design_workflow_dialogs`, `design_workflow_process`,
`design_workflow_prompts`, `fix_workflow_routing`, `generate_workflow_mocks`,
`generate_workflow_paths`, `generate_workflow_steps`, `research_workflow_domain`,
`review_workflow_redundancy` — used only by `create_workflow`. `fix_workflow_steps` — used only by
`fix_workflow`.

Seeded but used by nothing: `analyze_and_design_workflow`, `generate_crud_workflows`,
`classify_workflow_intent`.

### 5.2 Pass B — the domain-creation chain (seeded)

`create_domain`, `design_table`, `research_domain_schema`, `revise_domain_schema`,
`generate_domain_aliases`, `propose_domain_view` — used only by `create_domain`. **Read these
before writing Novia's domain tool**: they hold the current schema-design knowledge.

### 5.3 Orphaned — database only, no live workflow (Pass A)

Leftovers of generated workflows that no longer exist, several in duplicate rows:

`budget_csv_parser` (names `import_budget_csv`, absent), `calculate_sm2_next_review`,
`calculate_sm2_update`, `calculate_spaced_repetition`, `calculate_sr_update`, `calculation`,
`classification`, `compute_sm2_update`, `compute_sm2_updates`, `compute_spaced_repetition`,
`data_extraction`, `embedding`, `evaluate_flashcard_answer`, `extraction`, `flashcards_sm2_update`,
`format_deck_summary`, `format_display_output`, `formatting`, `generate_flashcard_distractors`,
`generate_flashcard_quiz`, `generate_flashcard_quiz_spec`, `generate_flashcards`,
`grade_flashcard_answer`, `matching`, `parse_budget_edits` and `parse_month_year` (both name
`edit_monthly_budget`, absent), `parse_budget_input`, `parse_budget_paste`,
`parse_budget_spreadsheet`.

### 5.4 Keep

`classify_intent_tier2` (code), `parse_entity_input`, `enrich_ref_records`, `select_entity_schema`
(generic CRUD), `parse_spreadsheet_budget`, `match_inventory_items`, `parse_receipt` (domain
workflows).

---

## 6. System context — `PGC_SystemContext`

A row is dead when every `inject_for` target is a deleted prompt and nothing else reads it. Reads
were checked in code and in `PGC_SessionEntry` by session type.

| Rows | Pass | Evidence |
|---|---|---|
| `routing_value_rules`, `flat_loop_example`, `step_usage_patterns`, `workflow_constraints`, `serv_db_step_shapes`, `workflow_routing_rules`, `human_gate_dialog_rules`, `markdown_formatting_syntax`, `slack_message_formatting`, `runtime_bindings`, `workflow_gap_taxonomy`, `workflow_research_contract`, `llm_model_selection_rules`, `create_domain_example` | **A** | Inject only into §5.1 prompts; read only in `llm_call_diagnostic` sessions, never by Novia |
| `step_type_contracts` | **A** | Injects only into §5.1 prompts. Shadowed even there: `llm-harness.mjs:274-284` re-reads `PGC_StepType` for the `{{step_type_contracts}}` token. The harness code goes when no live prompt carries the token |
| `pgd_column_type_rules`, `pgd_naming_conventions`, `pgd_required_columns`, `pgd_fk_constraint_rules`, `pgd_attribute_placement`, `pgd_default_value_format`, `schema_research_contract`, `single_user_constraint`, `embedding_config` | **B** | Inject only into §5.2 prompts. **Candidates for Novia's domain tool** — the rules, not their injection, are what a domain design needs |
| `diagnostics_config` | **Decide** (D5) | No `inject_for`, no code reference, no session read |

**Keep:** `template_syntax` (Novia reads it), `general_chat_system_prompt` (`chat.mjs`),
`llm_model_aliases` (`llm-harness.mjs`), every `minds_eye_*` and `sop_*` row,
`workflow_convention_bridge`.

---

## 7. Tests, docs and scripts

| Item | Pass | Note |
|---|---|---|
| `tests/unit/troubleshoot-fix-workflow.test.mjs` | per D1 | Tests the chain in finding 1 |
| References in `step-executor.test.mjs`, `simulation-engine.test.mjs`, `domain-propagation.test.mjs`, `memory-writer.test.mjs`, `state-utils.test.mjs`, `replay-break-notification.test.mjs` | A / B | Most use `create_workflow`/`create_domain` as fixture names; each is read before it is changed, and a fixture name alone is no reason to change a test |
| `docs/arch-create-workflow.md` | **A** | Plus references in `architecture.md`, `arch-workflow-patterns.md`, `arch-simulation-engine.md`, `arch-prompt-rules.md`, `arch-step-types.md`, `README.md`, `CLAUDE.md` |
| `docs/arch-create-domain.md` | **B** | Same set of referencing docs |
| `openapi.yaml` | A / B | The HTTP routes of every deleted module |
| `dev_scripts/migrate-*.mjs` | **Decide** (D6) | One-off migrations already applied; not part of the creation path |

---

## 8. Decisions needed before Pass A

| # | Question | Options |
|---|---|---|
| **D1** | What happens when a workflow fails, once `fix_workflow` is gone? | Keep `TROUBLESHOOT_WORKFLOW` as a diagnostic-only notification (drop `autoFix` and the `FIX_WORKFLOW` chain); hand the failure to Novia; or remove the automatic trigger and leave the `WORKFLOW_ERROR` message the user already receives |
| **D2** | Keep `diagnose_prompt_schema` and its automatic trigger on API 400? | Two runs, last in June |
| **D3** | `update_entity` and `delete_entity` have never run. Keep them as generic CRUD, or retire them with the app's direct edits (`arch-home-brain.md` §4.8) in view? | — |
| **D4** | Does Novia's domain tool use the `serv_schema` step type, or call SERV schema endpoints directly? | Decides whether `serv_schema` survives Pass B |
| **D5** | `diagnostics_config` — read by nothing found. Delete? | — |
| **D6** | Include the applied one-off `dev_scripts/migrate-*.mjs` in this cleanup? | — |
| **D7** | Prompt version history — superseded rows of prompts that stay (e.g. older `parse_entity_input` versions). In scope, or kept as history? | — |
