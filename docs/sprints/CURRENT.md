# Sprint 5 — Novia Phase 1 + Carried Engine Issues

**Sprint 4 closed 2026-06-11. See `docs/sprints/sprint-04.md` for retro.**

**Branch:** `sprint/05-novia-phase1`

**Duration:** ~2 weeks (target close: 2026-06-27)

---

## Sprint Goal

Implement Novia Phase 1: context assembly, read tools, and the `/novia` Slack command. Validate UC-1 (fix workflow) and UC-5 (inspect data) end-to-end. Resolve carried engine issues from Sprint 4. Monitor Lambda recursive loop with a CloudWatch alarm in place. Track P and AC6 deferred to Sprint 6 (require artifact recreation).

---

## Acceptance Criteria

- **AC1 — `/novia` command:** `/novia <prompt>` invokes the minds-eye agent (`minds-eye.mjs`), assembles context (system + memory layers), responds in a Slack thread. Thread replies continue the session. Display name ("Novia") is read from `PGC_SystemContext.minds_eye_preferences.name` at runtime — not hardcoded.
- **AC2 — Read tools:** The agent can query any PGC or PGD table, read memory, and simulate a workflow — all without a confirmation gate.
- **AC3 — UC-5 (inspect data):** "show me my flashcard decks" returns a structured Slack response with deck names and card counts.
- **AC4 — UC-1 (improve workflow, Generation domain):** The agent diagnoses a routing issue in a domain workflow, proposes an improvement, posts a confirmation gate with the proposed diff, applies the change on approval, re-runs L1 to confirm it passes.
- **AC5 — Track P:** `create_workflow` generates domain workflows where domain-specific `llm_call` steps carry `prompt_draft`/`prompt_category`/`prompt_model` fields; a `design_workflow_prompts` step classifies each as reuse/create/convert and registers new `PGC_Prompt` rows with `domain` set. **→ Deferred to Sprint 6** (requires deleting and recreating flashcard/quiz artifacts).
- **AC6 — design_table Contract fix:** `design_table` prompt no longer allows `real` for columns with decimal boundary constraints. Validated by running `create_domain` with a schema that includes such a column. **→ Deferred to Sprint 6** (requires deleting and recreating flashcard/quiz artifacts).
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

**N0. Prerequisites** ✅ DONE (2026-06-14) — /chat and /explain validated from Slack.

**N1. Context assembly + endpoint** ✅ DONE (2026-06-14)
- minds_eye_preferences (id:31), minds_eye_context_index (id:32), minds_eye_system_prompt (id:33) seeded
- MINDS_EYE + MINDS_EYE_RESUME SQS types registered in proc/handler.mjs
- minds-eye.mjs PROC endpoint: Layer 1 (PGC_Workflow + PGC_Prompt) + Layer 2 (PGC_Memory) assembly, session create, agentic loop with 6 read tools, HUMAN_NOTIFICATION on respond
- minds-eye.mjs EXP: /novia Slack command → 'minds-eye' route → MINDS_EYE SQS
- PGC_Session extended: minds_eye_turn_count, minds_eye_action_count columns added
- PGC_SessionEntry extended: compressed column added
- schema.mjs: modifyConstraint endpoint added; session_type constraint updated to include 'minds_eye'
- Validated: agent self-described capabilities correctly, enumerated workflows/prompts from DB, advisory fired autonomously on duplicate prompt versions

**N2. Reasoning loop + read tools** ✅ DONE (2026-06-14)
- Agentic loop with tool dispatch: `search_domain_help`, `list_tables`, `query_table`, `query_entity`, `read_memory`, `read_workflow`, `read_prompt`, `simulate_workflow`
- Tool calls appended to `PGC_SessionEntry` as `role = 'tool'` (constraint updated: `chk_pgc_sessionentry_role` now includes `'tool'`)
- Discovery sequence validated: agent called `search_domain_help` → `list_tables` → `query_table` in correct order — no table name guessing
- `PGC_DomainHelp` pgvector semantic search used to identify domain; `PGC_Schema` used to resolve exact table names and columns
- Layer 1 context trimmed: prompt list removed (agent uses `read_prompt` on demand); workflow list retained
- AC2 + AC3 validated: `/novia show me my flashcard decks` returned real structured data with correct deck names from DB; advisory fired on duplicate deck name from real data

**N3. Action tools + confirmation gates** ✅ DONE (2026-06-16)
- `fix_workflow_steps` moved from INLINE_WRITE_TOOLS to GATED_WRITE_TOOLS
- `buildGateText` diffs current vs proposed steps — shows only changed fields per step
- `callback.mjs` `minds_eye_gate` accepts `confirmLabel`/`confirmStyle` — fix_workflow_steps renders "Apply", delete_data renders "Delete" (danger)
- `gateButtonConfig` helper determines label/style per action type
- AC4 validated (2026-06-17): corrupted step 17 `on_else: "18"` → Novia diagnosed routing defect, proposed correct fix (gate diff: `"18" → "9"`), applied on approval, workflow now at v2 with `on_else: "9"`. ✅
- Caveat: Novia's respond explanation after gate approval was a hallucination — she described a fabricated step 7 `Array.isArray()` fix that was never applied. The gate diff and actual DB write were correct; the post-approval narrative was not. Noted as a Generation fault pattern to watch.

**N4. Memory write** ✅ DONE (2026-06-17)
- Harness (factual): `writeFactualMemory` called in `handleGateResume` after every successful gated write — diff summary, step counts, outcome, scope derived from params. Tagged `novia_fix`.
- Novia (diagnostic): `write_memory` housekeeping tool — no gate, no action limit, scope auto-derived from tool call history via `deriveScope`. Novia writes diagnostic reasoning before final respond.
- System prompt v13→v14: step 0 `read_memory` (scope-filtered) added to each diagnosis protocol; MEMORY WRITE block added.
- Validated session 550: factual row (id 77) + diagnostic row (id 78) written with correct scope `{ workflow: "spaced_repetition_quiz" }`. Novia's response grounded in diff — hallucination resolved.

### Track P — design_workflow_prompts (carry-forward) → **Sprint 6**

Full spec: `docs/sprints/sprint-04.md` Track P section

Requires deleting and recreating flashcard/quiz artifacts to validate AC5 cleanly. Carried to Sprint 6 to avoid disrupting Sprint 5 Novia validation with artifact churn.

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
4. `create_domain` with a domain that includes a column with a decimal boundary constraint (e.g. `score numeric >= 0.5`) → inspect generated schema and confirm column type is `numeric(p,s)`, not `real` or `float` — AC6
5. CloudWatch alarm threshold test (manual): deploy L2 alarms first, then send 60 test SQS messages to WorkflowQueue → verify alarm fires within 2 consecutive 1-minute periods — AC8

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

**2026-06-14 (session 4):** N0 + N1 already done. N2 implemented and validated. chk_pgc_sessionentry_role extended to include 'tool'. search_domain_help (pgvector on PGC_DomainHelp) and list_tables (PGC_Schema by domain/prefix) added as read tools. Discovery sequence (search_domain_help → list_tables → query_table) validated end-to-end: '/novia show me my flashcard decks' returned real data in 4 turns with advisory on duplicate deck name. System prompt v3 upserted; Layer 1 prompt list removed. AC2 + AC3 complete.

**2026-06-15 (session 5):** System prompt rewrite (v4–v6): agentic identity + .mjs loop framing, name/tone injection from minds_eye_preferences (tone changed to "concise but friendly"), markdown block rendering via Slack's `{ type: 'markdown' }` block type, formatting section added, per-call instruction enumerates allowed action names, session-wide protocol reinforcement appended. `docs/slack-block-kit.md` updated with markdown block reference. Thread continuation implemented: "Continue with Novia" button appended to Novia responses (`sessionId` passed in HUMAN_NOTIFICATION), button click opens "Ask Novia" modal, submission enqueues MINDS_EYE with `existingSessionId`. Button-click UX: strips actions block from `payload.message.blocks` via `chat.update` — preserves message content, removes stale button. Convention documented in backlog: apply same pattern to all interactive button handlers (flag: `handleExplainFollowupButton` still uses full-text replacement).

**2026-06-16 (session 7):** N3 planning. Two test approaches agreed: (1) Revert `ease_factor` column in flashcard schema from `numeric(p,s)` → `real` — gives Novia a live schema defect to diagnose; this is `fix_schema` (Phase 2 / UC-3), not N3, but useful as an early smoke test of Novia's Contract-domain diagnosis. (2) Corrupt quiz workflow steps (introduce a bad condition or routing field, similar to the domain field approach) — this is the actual N3 (`fix_workflow_steps`) test: Novia reads steps, simulates, identifies the defect, proposes fix, posts gate, applies on approval, L1 passes. AC6 validation (fp-value <= 1.3 create_domain run) is a separate pending user test. Implementation not yet started.

**2026-06-16 (session 8):** N3 validation in progress. Three fixes deployed this session. (1) Tool-result truncation fix (commit c6c0f11): `buildUserMessage` in `minds-eye.mjs` was slicing tool results to 500 chars — the quiz workflow's 22 steps serialize to 7,232 chars, so Novia only saw Step 1. Raised limit to 15,000. This was the root cause of the 20× `read_workflow` re-read behaviour. (2) Rename `fix_workflow_steps` → `propose_workflow_fix` everywhere (commit 586600c) + system prompt catalog of system workflows to prevent Novia calling `run_workflow: fix_workflow` instead of her own tool. (3) Follow-up gate (commit 8ad2ee9): turn-limit gate now has Continue / Follow-up / Cancel; Follow-up opens a modal, adds user question as session entry, resets turn count, re-runs loop with `postContinueGateAfterRespond: true`. System prompt v10→v11: added WORKFLOW FIX RULES section (minimal diff principle, valid step type list, no re-read rule). Session 547 outcome: Novia read workflow once, called `simulate_workflow`, correctly diagnosed Step 17 condition inverted — but then returned prose markdown instead of a JSON action, causing a parse error. Two bugs remain unfixed: (A) **Execution**: turn-limit gate fires after LLM parse error (`!responded` is true on any loop break); fix = track error exits with a flag and skip gate. (B) **Instruction**: after `simulate_workflow` confirms a bug, Novia should call `propose_workflow_fix` — not write prose. Fix = add rule to `minds_eye_system_prompt`: "after simulate_workflow confirms an issue, next action must be `propose_workflow_fix`". Prose-to-respond harness fallback discussed and rejected — prose doesn't contain corrected steps, so it doesn't recover the intended action. Both fixes agreed; neither yet implemented.

**2026-06-17 (session 9):** Both session 8 bugs fixed (commit 6612c69). (A) Execution: `earlyExit` flag added to `runReasoningLoop` — set on LLM error, action-limit exits, unknown-action exits, and after `postActionGate` fires; turn-limit gate only posts on natural turn-limit exhaustion or follow-up mode. (B) Instruction: WORKFLOW FIX RULES section in system prompt (v11→v12) replaced with DIAGNOSIS AND FIX PROTOCOL — two parallel protocols sharing the same structural rule ("once confirmed, call the tool — never respond with prose first"): workflow path (read_workflow → simulate_workflow → propose_workflow_fix) and domain data path (search_domain_help → list_tables → query_table/query_entity → update_data/insert_data/delete_data). Ambiguous-result escape hatch added. Schema issues protocol added (v12→v13): list_tables → propose_schema_fix. `propose_schema_fix` added as new gated write tool routing to `/serv/schema/{addColumn|modifyColumn|dropColumn|modifyConstraint}`; dropColumn gets danger-style gate; FK constraints not supported (escalate via respond). Deployed + upserted. AC4 re-tested after re-corrupting step 17: Novia diagnosed routing defect in one pass, applied fix (gate diff: `on_else "18" → "9"`), quiz now at v4. Post-approval response was diff-grounded with no hallucination — `propose_workflow_fix` result enriched with `diff` + `steps_written` (root cause of prior hallucination: `__pending__` stripped proposed steps from transcript; LLM had no ground truth on resume). N4 fully implemented: harness writes factual row (`writeFactualMemory` in `handleGateResume` — diff summary, tagged `novia_fix`, scope from params); Novia writes diagnostic row via `write_memory` housekeeping tool (new `HOUSEKEEPING_TOOLS` set: no gate, no action limit, scope auto-derived from `workingHistory` via `deriveScope`). System prompt v13→v14: step 0 `read_memory` (scope-filtered) added to each protocol; MEMORY WRITE block added. Validated session 550: PGC_Memory rows 77 + 78 written with correct scope `{ workflow: "spaced_repetition_quiz" }`. N4 ✅. `/chat` dead code added to backlog (High Priority — obviated by Novia). L1 false positive for `mastered_card_ids.indexOf` analyzed: simulator checks steps in isolation; array initialized in step 1 is not inferred in step 7 — structural false positive until simulator gains cross-step type inference. Added to backlog (Low Priority). Sprint planning: Track P (P1-P4, AC5) and AC6 deferred to Sprint 6 — both require deleting and recreating flashcard/quiz artifacts. Remaining Sprint 5 scope: L1, L2, L3 (CloudWatch) — to be completed next session.

**2026-06-16 (session 6):** Four bug fixes, all deployed. (1) `postTurnLimitGate` — added `sessionId` + `format: 'markdown'` to HUMAN_NOTIFICATION; Continue with Novia button now renders on turn-limit exhaustion. (2) `run_workflow` trigger tool: fixed `chk_triggered_by` constraint (`minds_eye` → `system` workaround); fixed thread contamination — quiz now runs in Novia session thread via `threadTs` from `session.slack_thread_ts`. (3) Turn budget: `for` loop replaced with `while (turnCost < turn_limit)` — failed tool calls cost 0.5 turns instead of 1.0; system prompt v9 adds schema discovery rule (call `list_tables` before `query_entity` to confirm column names). (4) Loop idempotency: `enqueueWorkflow` now stamps every `execute_top` message with `stepExecutionId: randomUUID()`; `checkIdempotency` and `recordStepAudit` use it as the key — SQS redeliveries carry the same UUID (correctly blocked), new loop iterations get a new UUID (correctly allowed). Quiz validated end-to-end for the first time. Checkpoint/revert feature added to backlog (High Priority). AC6 + AC8 test scenarios corrected in CURRENT.md.

**2026-06-14 (session 3):** arch-minds-eye.md design review — no code written. (1) Added Advisor as third primary role (§1.2); advisory output added to respond action shape in §6.1. (2) Tone preferences added to minds_eye_preferences: tone, advisory_level, response_format, technical_level — full schema in §3.1, preference tables in §6.3 (renamed from Safety Limits). update_preferences added as Phase 2 action tool. (3) Phase column added to §4.2 action tools table; update_intent_map and update_domain_help added as Phase 2 tools. (4) UC-6 extended with cost pattern variant (high-frequency workflows with no Pass 1 IntentMap coverage). UC-8 added: user help and cost guidance, read-only in Phase 1. (5) §4.1 read tools updated: all single-table lookups use existing getRows; simulate_workflow wired to existing /proc/simulate-workflow endpoint; get_run_history documented as three-call chain requiring X1. FK join paths documented in minds_eye_context_index seed block. Phase 2 /serv/run/diagnostic option noted. (6) §3.3 rewritten: three-call diagnostic chain explicit; X1 hard prerequisite noted; W1 conditional (PGC_WorkflowRunStep fix vs remove) documented with both branches; Layer 3 blocked until W1 resolved. (7) Session compression added to §6.1 turn-limit gate (Continue/Pause paths); PGC_SessionEntry.compressed column prerequisite noted; §6.2 replay description updated. (8) UC-1 corrected: L1 runs on proposed steps before gate (autonomous re-reason loop); gate is Approve/Cancel only; post-write L1 is verification; "upserts" corrected to updateRows + version+1. (9) preview_gate added to backlog (Phase 2 Novia tool). openapi.yaml sync audit added to backlog. Memory: no-decision-notes-in-docs convention saved.
