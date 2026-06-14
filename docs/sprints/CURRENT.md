# Sprint 5 — Novia Phase 1 + Carried Engine Issues

**Sprint 4 closed 2026-06-11. See `docs/sprints/sprint-04.md` for retro.**

**Branch:** `sprint/05-novia-phase1`

**Duration:** ~2 weeks (target close: 2026-06-27)

---

## Sprint Goal

Implement Novia Phase 1: context assembly, read tools, and the `/novia` Slack command. Validate UC-1 (fix workflow) and UC-5 (inspect data) end-to-end. Complete Track P (design_workflow_prompts). Resolve carried engine issues from Sprint 4. Monitor Lambda recursive loop with a CloudWatch alarm in place.

---

## Acceptance Criteria

- **AC1 — `/novia` command:** `/novia <prompt>` invokes the minds-eye agent (`minds-eye.mjs`), assembles context (system + memory layers), responds in a Slack thread. Thread replies continue the session. Display name ("Novia") is read from `PGC_SystemContext.minds_eye_preferences.name` at runtime — not hardcoded.
- **AC2 — Read tools:** The agent can query any PGC or PGD table, read memory, and simulate a workflow — all without a confirmation gate.
- **AC3 — UC-5 (inspect data):** "show me my flashcard decks" returns a structured Slack response with deck names and card counts.
- **AC4 — UC-1 (improve workflow, Generation domain):** The agent diagnoses a routing issue in a domain workflow, proposes an improvement, posts a confirmation gate with the proposed diff, applies the change on approval, re-runs L1 to confirm it passes.
- **AC5 — Track P:** `create_workflow` generates domain workflows where domain-specific `llm_call` steps carry `prompt_draft`/`prompt_category`/`prompt_model` fields; a `design_workflow_prompts` step classifies each as reuse/create/convert and registers new `PGC_Prompt` rows with `domain` set.
- **AC6 — design_table Contract fix:** `design_table` prompt no longer allows `real` for columns with decimal boundary constraints. Validated by running `create_domain` with a schema that includes such a column.
- **AC7 — WorkflowRunStep decision:** Either `PGC_WorkflowRunStep` rows are written consistently (fix identified and deployed) or the table is formally removed from the step audit log design and backlog updated.
- **AC8 — Lambda loop alarm:** A CloudWatch alarm exists that fires before AWS recursive loop auto-remediation triggers. No alarms fired during Sprint 5 testing.

---

## Out of Scope

- Novia action tools beyond `fix_workflow_steps` (fix_prompt, fix_schema in Phase 2)
- UC-2 (fix prompt), UC-3 (fix schema), UC-6 (optimize system) — Phase 2
- PGC_Session / PGC_SessionEntry table bootstrap if not already done (prerequisite — do first)
- `/chat` and `/explain` full implementation — prerequisite for Novia thread continuity; complete before Novia work begins
- History threading (Track H)
- `PGC_Memory` semantic deduplication / TTL cleanup
- pgvector semantic intent matching

---

## Tracks

### Track N — Novia Phase 1 (primary)

Full design: `docs/novia-design.md`

**N0. Prerequisites** *(do before any Novia code)*
- Bootstrap `PGC_Session` + `PGC_SessionEntry` tables (session-chat-design.md §11)
- Implement `/chat` proc endpoint + thread continuation (session-chat-design.md §6.1)
- Implement `/explain` proc endpoint (session-chat-design.md §6.2)
- Validate both commands from Slack before proceeding to N1

**N1. Context assembly + endpoint**
- `PGC_SystemContext` seeds: `minds_eye_system_prompt`, `minds_eye_context_index`, `minds_eye_preferences` (JSONB: `{ "name": "Novia", "turn_limit": 8, "model": "anthropic/claude-sonnet-4-6", "max_actions_per_session": 5 }`)
- `MINDS_EYE` SQS type registered in `handler.mjs` dispatcher
- `minds-eye.mjs` PROC endpoint: receives MINDS_EYE, assembles Layer 1 (system context query) + Layer 2 (memory read), constructs initial session (`PGC_Session` row, `session_type = 'minds_eye'`)
- `/novia` Slack command → EXP routing → intent map entry (display name is a user preference; the Slack command name is fixed at Slack app config time)
- `PGC_Session` extended with `minds_eye_turn_count` + `minds_eye_action_count` columns

**N2. Reasoning loop + read tools**
- LLM reasoning turn: given context + conversation history, output `{ action, params, reasoning }` or `{ action: "respond", message }`
- Read tools: `query_table`, `query_entity`, `read_memory`, `simulate_workflow`, `read_workflow`, `read_prompt`, `get_run_history`
- Tool calls appended to `PGC_SessionEntry` as `role = 'tool'`
- Turn limit: read from `PGC_SystemContext.minds_eye_preferences.turn_limit` (default 8) — not hardcoded
- When turn limit is reached: post a `human_gate` (choice type) with options Continue / Pause / Cancel — do NOT hard-stop
- Validate AC2 + AC3 (read-only use cases) before proceeding to N3

**N3. Action tools + confirmation gates**
- `fix_workflow_steps` action tool: reads current steps, proposes improved steps, posts HUMAN_GATE with diff
- Resume gate routing: `MINDS_EYE_RESUME` SQS action → `minds-eye.mjs` (separate from workflow `resume_gate`)
- Max action tools: read from `PGC_SystemContext.minds_eye_preferences.max_actions_per_session` (default 5)
- Validate AC4 (UC-1: improve workflow) end-to-end

**N4. Memory write**
- After each completed session: write episodic memory (what was diagnosed, what was changed, whether fix passed L1)
- Memory scope: `{ workflow: name }` for correction tasks, `{ domain: name }` for domain tasks

### Track P — design_workflow_prompts (carry-forward)

Full spec: `docs/sprints/sprint-04.md` Track P section

**P1.** X2: `POST /api/v1/serv/schema/addColumn` → `PGC_Prompt.domain text nullable`. Update `PGC_Schema` seed. Backfill `sm2_calculate` (id=79) → `domain: "flashcards"`.

**P2.** Update `generate_workflow_steps` prompt: domain-specific `llm_call` steps emit `prompt_draft`/`prompt_category`/`prompt_model`/`output_schema` fields. System prompts keep `input.prompt: intent_category`. Update `PGC_StepType` `llm_call` input_contract. Run `upsert-prompt.mjs` + `upsert-step-type.mjs`.

**P3.** Add `design_workflow_prompts` LLM step to `create_workflow` (between `generate_workflow_steps` and L1 simulate). Input: draft steps + existing `PGC_Prompt` intent_category list. Output: `capability_decisions` (reuse/create/convert per step). Iterator applies decisions: create → `serv_insert PGC_Prompt` with domain; reuse → record existing `intent_category`; convert → rewrite step as `js_transform`. Run `upsert-workflow.mjs`.

**P4.** `delete_workflow`: add `serv_delete PGC_Prompt WHERE domain = workflow.domain`. `delete_domain`: extend to `serv_delete PGC_Prompt WHERE domain = input.domain`. Run `upsert-workflow.mjs`.

Validate AC5 with a `create_workflow` run that includes a deterministic algorithm step (SM-2 is canonical convert test vehicle).

### Track S — System Context Migration (new, Sprint 5)

Reference: `docs/arch-prompt-rules.md` — decision framework, full migration backlog, contradiction log.

**Context:** Audit of all 16 prompts (2026-06-14) found 8 categories of rules duplicated across prompts that belong in `PGC_SystemContext`. W2 exposed the pattern: adding a type rule directly to `design_table` prompt_text created a contradiction with `create_domain` and `revise_domain_schema`. The fix is to centralise these rules so they can be updated once and applied consistently.

Ordered by impact (see §5 of arch-prompt-rules.md for rationale):

**S1.** `pgd_column_type_rules` ✅ DONE (2026-06-14) — New context entry (id: 21, v1) injected into `create_domain` (v17→v18), `design_table` (v7→v8), `revise_domain_schema` (v6→v7). Inline type rules removed from all three prompt_texts and replaced with `{{pgd_column_type_rules}}` placeholder. W2 inline rule merged into unified entry. Upserted to DB.

**S2.** `pgd_naming_conventions` ✅ DONE (2026-06-14) — id: 22, v1. create_domain v19, design_table v9, revise_domain_schema v8. Table name rules extracted; trigger/FK/constraint/embedding naming added.

**S3.** `pgd_required_columns` ✅ DONE (2026-06-14) — id: 23, v1. create_domain v20, design_table v10, revise_domain_schema v9. Two-line id/trigger invariant extracted from all three.

**S4.** `pgd_fk_constraint_rules` ✅ DONE (2026-06-14) — id: 24, v1. create_domain v21, design_table v11, revise_domain_schema v10. FK column/name/references/onDelete + constraint type/name/expression/empty-array rules extracted.

**S5.** `single_user_constraint` ✅ DONE (2026-06-14) — v2→v3. Added `"design_table"` to inject_for. Added `{{single_user_constraint}}` placeholder to design_table (v12).

**S6.** `workflow_gap_taxonomy` ✅ DONE (2026-06-14) — id: 25, v1. analyze_and_design_workflow v14, analyze_workflow_gaps v6. Type 1–4b definitions extracted; action-only rules remain in each prompt.

**S7.** `llm_model_selection_rules` ✅ DONE (2026-06-14) — id: 26, v1. analyze_and_design_workflow v15, analyze_workflow_gaps v7. Model rule reframed as brain type assignment; extracted from both prompts.

**S8.** `pgd_default_value_format` ✅ DONE (2026-06-14) — id: 27, v1. create_domain v22, design_table v13, revise_domain_schema v11. Default value SQL expression rules extracted; placeholder added to design_table.

**S9.** `schema_research_contract` ✅ DONE (2026-06-14) — id: 28, v1 (Cat G). Placeholder added to research_domain_schema v8, create_domain v23, revise_domain_schema v12. Defines findings[]/preference_questions[] shape and tradeoffs vs value key distinction.

**S10.** `workflow_research_contract` ✅ DONE (2026-06-14) — id: 29, v1 (Cat G). Placeholder added to research_workflow_domain v4, analyze_and_design_workflow v16. Defines findings/preference_questions shape + Type 2 resolution rule.

**S11.** `human_gate_dialog_rules` ✅ DONE (2026-06-14) — id: 30, v1 (Cat D). design_workflow_dialogs v7 (on_select block + Cancel requirement extracted), generate_workflow_steps v27 (placeholder added before TRANSLATION RULES). Structural gate vocabulary centralized; procedural rules remain prompt-local.

**Track S validated (2026-06-14):** All 9 S-track prompts (create_domain, design_table, revise_domain_schema, analyze_and_design_workflow, analyze_workflow_gaps, research_domain_schema, research_workflow_domain, design_workflow_dialogs, generate_workflow_steps) passed live LLM integration test after Track S changes. Integration test enhanced to use real `assembleInstructions()` from `llm-harness.mjs` and apply `PGC_SystemContext` injection — matching Lambda production code path exactly.

### Track W — Engine issues (carry-forward)

**W1. PGC_WorkflowRunStep not written (run 458)** ✅ DONE (2026-06-14)
- Contract: `step_key` missing from `PGC_Schema` → SERV rejected inserts silently. Registered via `addColumn schemaOnly:true`; seed updated.
- Execution: `servPost` now throws on non-2xx; `recordStepAudit` wrapped in try/catch (logs error, no SQS retry); `bestEffort()` utility added to `serv-client.mjs`; `delete-domain` and `delete-workflow` converted to use it.
- Decision: table retained — now reliably written. Resolves AC7.

**W2. design_table Contract fix** ✅ DONE (2026-06-14)
- Added rule to `design_table` prompt (v6→v7): decimal-constrained columns must use `numeric(p,s)`, never `real`/`float`. Includes canonical example. Upserted to DB. AC6 validation requires a `create_domain` run by user.

**W3. Domain propagation systemic audit (backlog task 12)**
- Enumerate every boundary where `domain` crosses a system boundary or enters a PGC write
- For each boundary: assert domain is non-null, or document that null is valid and why
- Add unit tests per boundary point

**W4. PGC_WorkflowRun.session_id column (X1)** ✅ DONE (2026-06-14)
- Column and seed entry already present from prior session. No changes needed. Fixed stale `addColumn` curl example in `arch-data.md`.

### Track L — Lambda Loop Watch

**Context:** Sprint 4 session 21 identified and fixed the recursive loop amplifier: `enqueueWorkflow` on the idempotency path in `run-workflow.mjs` was re-enqueuing on every `stuckCount===1` hit, causing N duplicate messages to sustain until AWS recursion counter hit 16. Fix removed that call. Whether a cold-start can trigger a new recursion path is unconfirmed.

**L1. Verify fix held**
- Check CloudWatch Lambda metrics (invocations, concurrent executions) and SQS ApproximateNumberOfMessagesVisible on WorkflowQueue for the period 2026-06-10 → present
- Confirm no recursive loop auto-remediation events since session 21
- Document finding in session notes

**L2. Add CloudWatch alarms**
- Alarm: `WorkflowQueue` ApproximateNumberOfMessagesVisible > 50 for 2 consecutive 1-minute periods → SNS notification
- Alarm: `evolving-mind-ai-proc` ConcurrentExecutions > 20 → SNS notification
- These fire before AWS auto-remediation (threshold 16 Lambda hops), giving visibility and time to intervene
- Add alarm definitions to `template.yaml`

**L2b. Auto-halt on alarm**
- SNS alarm → Lambda (or SNS subscription to existing PROC HTTP endpoint) → `updateRows PGC_WorkflowRun WHERE status IN ('running', 'awaiting_human_gate') SET status = 'cancelled'`
- This is `/shutdown` triggered automatically — equivalent to running it from Slack but without requiring a human to be watching
- SQS messages already in flight continue to arrive but are immediately discarded (run status = cancelled)
- Queue drains naturally at its own delivery rate; no purge needed
- Note: `/shutdown` does not interrupt a currently-executing Lambda invocation, only prevents future ones from proceeding

**L3. Cold-start risk assessment**
- Check configured SQS visibility timeout on WorkflowQueue — if < Lambda cold-start + execution time, a timeout expiry could cause redelivery
- Confirm idempotency path in `run-workflow.mjs` is safe without the re-enqueue: redelivered message → idempotency hit → skip + return (no SQS re-enqueue) → message deleted
- Document result: if safe, add a comment in `run-workflow.mjs` explaining the invariant

**L4. Monitor during Sprint 5 testing**
- Novia will produce new SQS patterns (NOVIA_MESSAGE, tool calls, resume gates). Monitor ConcurrentExecutions after each Novia test session.
- If any new recursive pattern is observed, stop and diagnose before proceeding.

---

## Test Scenarios

1. `/novia show me my flashcard decks` → returns structured deck list — AC2, AC3
2. `/novia the quiz workflow routes incorrectly after step X` → agent reads workflow, simulates, proposes improvement, posts confirmation gate with diff, applies change on approval, L1 passes — AC4
3. `create_workflow` run with a domain that includes a deterministic algorithm → `design_workflow_prompts` classifies it as convert, step rewritten as js_transform, no inline prompt in final workflow — AC5
4. `create_domain` with a column that has a decimal boundary constraint → generated schema uses `numeric(p,s)` not `real` — AC6
5. CloudWatch alarm threshold test (manual): send 60 test SQS messages to WorkflowQueue → verify alarm fires — AC8

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] Simulate Level 1+2 pass on `create_workflow` (with Track P changes) and any new Novia workflows
- [ ] All ACs above validated from Slack
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated: minds-eye agent / MINDS_EYE / MINDS_EYE_RESUME / minds-eye.mjs, PGC_Session/PGC_SessionEntry, new SQS types
- [ ] `docs/arch-data.md` updated: PGC_Session, PGC_SessionEntry, PGC_Prompt.domain, PGC_WorkflowRun.session_id
- [ ] `docs/novia-design.md` updated with any decisions resolved from Open Questions section
- [ ] `docs/session-chat-design.md` updated: implementation status table updated as /chat and /explain are built
- [ ] `openapi.yaml` updated: /chat, /explain, /novia endpoints added before implementation
- [ ] `README.md` updated if env or bootstrap changes
- [ ] `docs/backlog.md` updated
- [ ] `CURRENT.md` renamed to `sprint-05.md` with outcome notes

---

## Session Notes

**2026-06-12 (session 1):** Sprint 5 scoped. Retro written to sprint-04.md. Fault domain triage framework added to CLAUDE.md and memory. Novia design document created at docs/novia-design.md. CLAUDE.md Current State trimmed (Sprint 1–3 summaries removed; session notes moved to sprint files only). Working conventions added: diagnose-before-code, commit-and-push per unit of work. Memory updated: fault_domain, diagnose_before_code, novia_role, first_pass_quality, sprint state, push_after_changes.

**2026-06-13 (session 2, extended):** Documentation restructuring — no code written. (1) Completed novia-design.md and CURRENT.md naming update: NOVIA_MESSAGE → MINDS_EYE, novia.mjs → minds-eye.mjs, seed key renames, Section 11 implementation sequence updated. (2) Major architecture doc split: architecture.md (4018 → 1010 lines) — extracted Sections 6.3/6.5/6.5.1/6.6–6.16 into arch-intent.md (467L), arch-step-types.md (574L), arch-step-processor.md (791L), arch-workflow-patterns.md (1000L). Section 3.4 file tree replaced with compact tier map. (3) Renamed data-architecture.md → arch-data.md, security-architecture.md → arch-security.md; all active-doc references updated. (4) CLAUDE.md Key Reference Files updated with navigation table. (5) Section 10 pgvector triaged: kept orthogonal decisions (why/principle/embed_source/API), moved intent pipeline usage to arch-intent.md, removed Session 26 status table and backfill script note (already in backlog/code). (6) Renamed 5 design docs to arch-*.md pattern: memory-design→arch-memory, novia-design→arch-minds-eye, session-chat-design→arch-session, create-domain-design→arch-create-domain, create-workflow-design→arch-create-workflow. Added Design Documents table to architecture.md §6 section map; updated CLAUDE.md Key Reference Files.

**2026-06-14 (session 3):** arch-minds-eye.md design review — no code written. (1) Added Advisor as third primary role (§1.2); advisory output added to respond action shape in §6.1. (2) Tone preferences added to minds_eye_preferences: tone, advisory_level, response_format, technical_level — full schema in §3.1, preference tables in §6.3 (renamed from Safety Limits). update_preferences added as Phase 2 action tool. (3) Phase column added to §4.2 action tools table; update_intent_map and update_domain_help added as Phase 2 tools. (4) UC-6 extended with cost pattern variant (high-frequency workflows with no Pass 1 IntentMap coverage). UC-8 added: user help and cost guidance, read-only in Phase 1. (5) §4.1 read tools updated: all single-table lookups use existing getRows; simulate_workflow wired to existing /proc/simulate-workflow endpoint; get_run_history documented as three-call chain requiring X1. FK join paths documented in minds_eye_context_index seed block. Phase 2 /serv/run/diagnostic option noted. (6) §3.3 rewritten: three-call diagnostic chain explicit; X1 hard prerequisite noted; W1 conditional (PGC_WorkflowRunStep fix vs remove) documented with both branches; Layer 3 blocked until W1 resolved. (7) Session compression added to §6.1 turn-limit gate (Continue/Pause paths); PGC_SessionEntry.compressed column prerequisite noted; §6.2 replay description updated. (8) UC-1 corrected: L1 runs on proposed steps before gate (autonomous re-reason loop); gate is Approve/Cancel only; post-write L1 is verification; "upserts" corrected to updateRows + version+1. (9) preview_gate added to backlog (Phase 2 Novia tool). openapi.yaml sync audit added to backlog. Memory: no-decision-notes-in-docs convention saved.
