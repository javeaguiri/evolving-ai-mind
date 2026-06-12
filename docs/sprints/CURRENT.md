# Sprint 5 — Novia Phase 1 + Carried Engine Issues

**Sprint 4 closed 2026-06-11. See `docs/sprints/sprint-04.md` for retro.**

**Branch:** `sprint/05-novia-phase1`

**Duration:** ~2 weeks (target close: 2026-06-27)

---

## Sprint Goal

Implement Novia Phase 1: context assembly, read tools, and the `/novia` Slack command. Validate UC-1 (fix workflow) and UC-5 (inspect data) end-to-end. Complete Track P (design_workflow_prompts). Resolve carried engine issues from Sprint 4. Monitor Lambda recursive loop with a CloudWatch alarm in place.

---

## Acceptance Criteria

- **AC1 — `/novia` command:** `/novia <prompt>` invokes Novia, assembles context (system + memory layers), responds in a Slack thread. Thread replies continue the session.
- **AC2 — Read tools:** Novia can query any PGC or PGD table, read memory, and simulate a workflow — all without a confirmation gate.
- **AC3 — UC-5 (inspect data):** "show me my flashcard decks" returns a structured Slack response with deck names and card counts.
- **AC4 — UC-1 (fix workflow, Generation domain):** Novia diagnoses a routing issue in a domain workflow, posts a confirmation gate with the proposed diff, applies the fix on approval, re-runs L1 to confirm it passes.
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
- `PGC_SystemContext` seeds: `novia_system_prompt`, `novia_context_index`
- `NOVIA_MESSAGE` SQS type registered in `handler.mjs` dispatcher
- `novia.mjs` PROC endpoint: receives NOVIA_MESSAGE, assembles Layer 1 (system context query) + Layer 2 (memory read), constructs initial Novia session (`PGC_Session` row, `session_type = 'novia'`)
- `/novia` Slack command → EXP routing → intent map entry
- `PGC_Session` extended with `novia_turn_count` + `novia_action_count` columns

**N2. Reasoning loop + read tools**
- LLM reasoning turn: given context + conversation history, output `{ action, params, reasoning }` or `{ action: "respond", message }`
- Read tools: `query_table`, `query_entity`, `read_memory`, `simulate_workflow`, `read_workflow`, `read_prompt`, `get_run_history`
- Tool calls appended to `PGC_SessionEntry` as `role = 'tool'`
- Safety limits: MAX_TURNS = 8 per NOVIA_MESSAGE
- Validate AC2 + AC3 (read-only use cases) before proceeding to N3

**N3. Action tools + confirmation gates**
- `fix_workflow_steps` action tool: reads current steps, proposes corrected steps, posts HUMAN_GATE with diff
- Resume gate routing: `NOVIA_RESUME` SQS action → `novia.mjs` (separate from workflow `resume_gate`)
- Safety limits: MAX_ACTION_TOOLS = 5 per session
- Validate AC4 (UC-1: fix workflow) end-to-end

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

### Track W — Engine issues (carry-forward)

**W1. PGC_WorkflowRunStep not written (run 458)**
- Read `step-executor.mjs` step audit log write path — identify why rows were not written for run 458
- Diagnose fault domain: Execution (harness bug) or Contract (schema/constraint issue)
- Decision: fix or remove. If the table is not reliably written it is not usable for idempotency or audit — document the decision.
- Resolves AC7.

**W2. design_table Contract fix**
- Update `design_table` prompt: explicit rule prohibiting `real` / `float` for any column that has a decimal boundary constraint (`>= N.NN`, `<= N.NN`, `CHECK ...`). Rule: use `numeric(p,s)` with precision matching the constraint literal.
- Add a type-matched example: `difficulty_level numeric(4,2) CHECK (difficulty_level >= 1.0 AND difficulty_level <= 5.0)`.
- Run `upsert-prompt.mjs`. Validate AC6.

**W3. Domain propagation systemic audit (backlog task 12)**
- Enumerate every boundary where `domain` crosses a system boundary or enters a PGC write
- For each boundary: assert domain is non-null, or document that null is valid and why
- Add unit tests per boundary point

**W4. PGC_WorkflowRun.session_id column (X1)**
- `POST /api/v1/serv/schema/addColumn`: `{ tableName: "PGC_WorkflowRun", columnName: "session_id", type: "integer", nullable: true }`
- Update `PGC_Schema` seed. No FK constraint (PGC_Session bootstrapped in Track N).

### Track L — Lambda Loop Watch

**Context:** Sprint 4 session 21 identified and fixed the recursive loop amplifier: `enqueueWorkflow` on the idempotency path in `run-workflow.mjs` was re-enqueuing on every `stuckCount===1` hit, causing N duplicate messages to sustain until AWS recursion counter hit 16. Fix removed that call. Whether a cold-start can trigger a new recursion path is unconfirmed.

**L1. Verify fix held**
- Check CloudWatch Lambda metrics (invocations, concurrent executions) and SQS ApproximateNumberOfMessagesVisible on WorkflowQueue for the period 2026-06-10 → present
- Confirm no recursive loop auto-remediation events since session 21
- Document finding in session notes

**L2. Add CloudWatch alarm**
- Alarm: `WorkflowQueue` ApproximateNumberOfMessagesVisible > 50 for 2 consecutive 1-minute periods → SNS notification
- Alarm: `evolving-mind-ai-proc` ConcurrentExecutions > 20 → SNS notification
- These fire before AWS auto-remediation (threshold 16 Lambda hops), giving visibility and time to intervene
- Add alarm definitions to `template.yaml`

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
2. `/novia the quiz workflow has a routing bug at step X` → Novia reads workflow, simulates, posts confirmation gate, applies fix on approval, L1 passes — AC4
3. `create_workflow` run with a domain that includes a deterministic algorithm → `design_workflow_prompts` classifies it as convert, step rewritten as js_transform, no inline prompt in final workflow — AC5
4. `create_domain` with a column that has a decimal boundary constraint → generated schema uses `numeric(p,s)` not `real` — AC6
5. CloudWatch alarm threshold test (manual): send 60 test SQS messages to WorkflowQueue → verify alarm fires — AC8

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] Simulate Level 1+2 pass on `create_workflow` (with Track P changes) and any new Novia workflows
- [ ] All ACs above validated from Slack
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated: Novia/NOVIA_MESSAGE, NOVIA_RESUME, novia.mjs, PGC_Session/PGC_SessionEntry, new SQS types
- [ ] `docs/data-architecture.md` updated: PGC_Session, PGC_SessionEntry, PGC_Prompt.domain, PGC_WorkflowRun.session_id
- [ ] `docs/novia-design.md` updated with any decisions resolved from Open Questions section
- [ ] `docs/session-chat-design.md` updated: implementation status table updated as /chat and /explain are built
- [ ] `openapi.yaml` updated: /chat, /explain, /novia endpoints added before implementation
- [ ] `README.md` updated if env or bootstrap changes
- [ ] `docs/backlog.md` updated
- [ ] `CURRENT.md` renamed to `sprint-05.md` with outcome notes

---

## Session Notes

**2026-06-12 (session 1):** Sprint 5 scoped. Retro written to sprint-04.md. Fault domain triage framework added to CLAUDE.md and memory. Novia design document created at docs/novia-design.md. CLAUDE.md Current State trimmed (Sprint 1–3 summaries removed; session notes moved to sprint files only). Working conventions added: diagnose-before-code, commit-and-push per unit of work. Memory updated: fault_domain, diagnose_before_code, novia_role, first_pass_quality, sprint state, push_after_changes.
