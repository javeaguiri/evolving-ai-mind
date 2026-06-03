# evolving-mind-ai — Backlog

Active tech debt register, tangential feature designs, and build history. Items in architecture.md §7 and §15 were moved here to keep architecture.md focused on active decisions.

---

## 0. Active Task List

Mirrors the in-session TaskCreate list. Recreate at the start of each new session with TaskCreate so tasks are trackable. Last updated: 2026-05-11.

| # | Status | Task | Notes |
|---|--------|------|-------|
| 1 | ↩️ reverted | Change queryId to use PGC_Session.id integer | Reverted by commit `fd69d46` — diagnostic notifications show UUID query_id so integer regex broke all /explain commands; UUID_RE restored across all three files |
| 2 | ✅ done | Fix Ask Follow-up button in /explain reply threads | (1) `proc/explain.mjs`: restored `queryId: session.query_id` in HUMAN_NOTIFICATION. (2) `interactive.mjs`: `handleExplainFollowupButton` now calls `slack.chat.update` to replace the stale button before opening the modal. Completed tasks 3/4/5/7 moved to `docs/backlog-history.md` |
| 8 | ✅ done | Run PGC_SystemContext.content JSONB migration | content→jsonb, format column dropped. New schema.mjs endpoints: modifyColumn + dropColumn. seed rewritten to sections schema. |
| 9 | pending | Validate analyze_and_design_workflow field name fix | Prompt id 25; response_format + v10 deployed session 23 — not yet validated |
| 10 | pending | Add PGC_WorkflowRun.session_id FK column | Migration script needed — column did not exist at bootstrap |
| 11 | pending | Add Tier 1 post-write validation after workflow writes | After fix_workflow step 8 / create_workflow step 19, run L1 simulation and fail on dead routing targets |
| 12 | partial | Domain propagation — systemic audit needed | **Recurring pattern (3 occurrences):** (1) Sprint 2: domain not passed in CREATE_WORKFLOW SQS payload — fixed. (2) Sprint 3 session 8: domain not written to WorkflowRun.input for domain workflows dispatched by classify-intent — fixed. (3) Sprint 3 session 8: Pass 1a did not resolve domain for freely-named workflow intent categories (quiz_flashcards → verb-strip missed) — fixed via substring match. Root cause: domain is not treated as a first-class field that flows end-to-end; it gets added piecemeal. **Remaining gap (B AC3):** a fresh `create_workflow` run for flashcards should reference correct column names on first attempt, proving domain_schema injection is working in the LLM prompt. Not yet validated. Sprint 4 action: audit every place domain enters or crosses a system boundary and add a test that asserts domain is non-null at each handoff point. |
| 13 | ✅ done | Add L1 check: serv_* steps must declare required input fields | Added `serv_step_missing_required_input` check in `runLevel1StaticAnalysis`. Validates `serv_query` (`tableName`), `serv_insert` (`tableName`, `row`), `serv_update` (`tableName`, `filters`, `updates`), `serv_delete` (`tableName`, `filters`). 4 existing unit tests updated to use correct step definitions. 32/32 tests pass. |
| 14 | ✅ done | Remove stale Level 3 references from architecture.md and system context seed | architecture.md §15 lines 3817/3884 updated; stale `skip_path_warnings` removed from §6.5.6 result shape. `seed_PGC_SystemContext.json` simulate description updated (v8→v9); pushed to DB via `upsert-system-context.mjs`. |
| 15 | ✅ done | Report malformed output_key (non-string) as L1 error | `runLevel1StaticAnalysis`: when `output_key` is present but not a string, raises `malformed_output_key` issue. Same guard added for option-level `output_key`. L2 skip guards remain as-is since L1 now blocks them. |
| 16 | ✅ done | Investigate why simulate did not detect the missing serv_query tableName (run 323) | Root cause: L1 checked routing, template vars, iterator source, and gate cancel options, but had no serv_* required-field check. The LLM was given the `input.tableName: required` rule via `step_type_contracts` but omitted it; the simulation had no safety net. Fixed by task 13. |

---

## 1. Tech Debt — Active

Items are unresolved unless otherwise noted. ✅ items were resolved mid-session and are archived in git.

### High Priority

| Item | Notes |
|---|---|
| IntentMap pattern quality — `create_workflow` should capture user invocation phrasing | `create_workflow` currently writes the workflow name as the IntentMap pattern (e.g. `quiz_flashcards`). This never matches natural language ("quiz me on flashcards") so every invocation falls through to the Tier 2 LLM — adding ~$0.00013 and ~2s latency on every call that should be free. Root cause: the LLM cannot reliably infer how a user will phrase a request at generation time. Fix: add a human_gate step to `create_workflow` that asks "How would you like to invoke this workflow? (e.g. 'quiz me', 'start a quiz', 'test my flashcards')" and uses the answer to generate the IntentMap regex pattern. The gate can default to a suggested phrasing derived from the workflow description so the user can confirm or refine. This also gives the user ownership of their own invocation vocabulary. |
| Memory bridge validation — `create_domain` schema decisions surfaced to `create_workflow` | **Test case: flashcard quiz.** `create_domain` added SRS fields (`ease_factor`, `interval_days`, `next_review_date NOT NULL`) beyond what the quiz spec required. `create_workflow` faithfully used those fields, producing a workflow that fails on first-review cards where `next_review_date` is null. The immediate fix is a schema DDL patch (nullable). The systemic fix is to validate that the memory bridge works as designed: (1) `create_domain` `save_to_memory` should capture schema decisions that carry unstated assumptions — e.g. "I added SRS scaffolding beyond the stated spec; `next_review_date` will be null on first review." (2) `create_workflow` should retrieve that domain memory and generate a workflow that either omits the field from the insert or computes a sensible default. **Validation test:** delete and regenerate `quiz_flashcards` via `create_workflow`. Inspect the injected memory block in the LLM prompt (run log). Verify the regenerated workflow handles null `next_review_date` without manual intervention. If the memory does not capture the trap naturally, update `generate_domain_schema` prompt to explicitly reason about initial-state nullability for non-default columns. |
| Skeleton-first workflow generation — split `generate_workflow_steps` into routing frame + per-step content fill | Root cause of persistent generation failures: one LLM call is asked to simultaneously maintain a globally consistent routing graph AND write 25+ step implementations. Fix: (1) Update `design_workflow_process` to emit routing intent per step (`on_truthy`/`on_falsy`/`on_failure` using step labels). (2) Replace step 23 with a new `generate_workflow_skeleton` call that produces only routing fields (step keys, types, routing tokens) — no expressions, no queries, no templates. (3) Run L1/BFS on the skeleton immediately; fix routing only if broken. (4) Iterate through each step with a focused `generate_step_content` call that fills in expressions/queries/templates given the point-in-time state_map. Routing is locked before any content is written — the `enable_assessment` class of bug disappears, correction loops are per-step and cheap. Evaluate vs. lightweight Option A (state_map into step 22 + step 22b normalization + routing token rule in design_workflow_dialogs) during sprint planning — both address the same root cause at different depths. **Sprint 4 Track.** |
| Domain data initialization — initial field values for generated workflows | When `create_domain` designs tables, it makes assumptions about initial field values (e.g. `next_review_date = NOW()`, `ease_factor = 2.5`) that are implied by the schema design but not stored anywhere accessible to downstream workflows. When `serv_entity_insert` populates data later, the LLM has no visibility into these initial-value conventions and may omit or mis-set fields. Workflows that later filter or sort on those fields (e.g. quiz ordering by `next_review_date`) then behave incorrectly. Fix: `create_domain` should capture initial-value constraints (DEFAULT expressions or application-level conventions) in a structured form — either as PGC_Memory (semantic, domain-scoped) or as a new `defaults` sub-field on `PGC_EntitySchema`. `serv_entity_insert` and `add_entity` prompts should retrieve and apply these conventions at insert time. **Sprint 4 Track.** |
| Stack overwrite race condition — activate `PGC_WorkflowRunLock` | A long-running Lambda (e.g. 55s LLM call + correction loop) loads the run stack at t=0, then writes it back at t=1m45s — overwriting gate frames pushed by other Lambdas in between. Reproduces when: (1) a step with a slow LLM call is followed closely by a human_gate in the same run, and (2) the gate is suspended before the slow step's Lambda finishes. Root cause: `updateRows('PGC_WorkflowRun', ..., { stack: run.stack })` uses no compare-and-swap. Fix: activate `PGC_WorkflowRunLock` with optimistic locking — load `version`, include `version` in the WHERE clause of every stack update, retry on conflict. `PGC_WorkflowRunLock` table and column exist; the harness never writes to them. First seen in run 384. |
| Perplexity budget exhaustion — user-facing error and proactive warning | When Perplexity returns HTTP 402 (Insufficient credits) or 429 (budget exhausted), the current error bubbles as `Agent API error 402: {"error":"..."}` in the WORKFLOW_ERROR notification — not user-friendly and gives no remediation path. Two fixes needed: (1) `llm-client.mjs` — detect 402/budget error bodies and throw a named error with a clear message: "LLM budget exhausted — please top up your Perplexity account to continue." (2) `run-workflow.mjs` WORKFLOW_ERROR path — detect `budget_exhausted` error type and post a human-readable notification with a direct link to the Perplexity billing page instead of a generic failure message. Nice-to-have: proactive warning at 80% budget via a daily EventBridge check against Perplexity's usage API (if available). |
| Memory two-layer architecture — episodic vs semantic with provenance | Current `save_to_memory` flag writes LLM initial-proposal reasoning as semantic memory before user confirmation. This is misleading (may include rejected ideas, missing user preferences). Fix: (1) Flag layer → episodic only, tagged `initial_design_reasoning` so retrieval can weight it appropriately. (2) Explicit `write_memory` step post-confirmation for semantic facts (user preferences, confirmed schema). (3) Post-run consolidation job (Track G3) distills episodic → semantic with full context. AOP harness approach is right for episodic capture; explicit steps are right for confirmed semantic facts. Provenance tags are the key missing piece. |
| Surface prompt `intent_category` + `id` in workflow error notifications | Error notifications for failed LLM validation steps currently say "prompt has been logged for improvement" with no actionable reference. Surface `intent_category` and prompt `id` in the Slack error message so the user can hand both to `/chat` with memory context (`scope: intent_category`) to diagnose and fix the prompt directly. Prerequisite for the Track I Novia agentic prompt-repair loop. |
| JSON encoding consistency — DB-stored vs seed-file content | Seed files use `\uXXXX` escapes (project standard per `docs/data-architecture.md` §encoding). LLM-generated workflow content stored in `PGC_Workflow.steps` uses UTF-8 with literal Unicode (emojis, special chars). Risk: false-positive diffs when comparing live DB rows against seed files; potential double-encode / decode bugs in `fix_workflow`, `troubleshoot_workflow`, and any tool that round-trips steps JSON through `JSON.stringify`. Audit `dev_scripts/pull-*.mjs`, `upsert-*.mjs`, and SERV insert/read path for consistent normalization. |
| Workflow safety guards (velocity detector, execution accumulator, cycle detector) | Required before production. Right-brain can monitor `PGC_WorkflowStats` for anomalous run patterns and flag suspect workflows proactively |
| Duplicate domain detection — LLM runs every time | `/create-domain recipes` re-runs the LLM even if the domain already exists. Fix: add a `serv_query` pre-check step to `create_domain` workflow before the `llm_call` |
| Tier 1 post-write validation — dead routing targets | After any `PGC_Workflow` write (fix_workflow step 8, create_workflow step 19), run Level 1 simulation on the written step array and fail immediately if dead routing targets are found |
| L1 static analysis: detect nested `{{...{{...}}...}}` template tokens | `generate_workflow_steps` (run 321, step 7) produced `{{quiz_state.cards_array.{{quiz_state.index}}.term}}` which passes L1 but fails at runtime. L1 should scan all string fields for the pattern `/\{\{[^}]*\{\{/` and raise `unsupported_handlebars_syntax` so the correction loop can fix it before the workflow is registered. |
| `analyze_and_design_workflow` persistent schema mismatch | Prompt id 25. LLM produces wrong field names on every attempt. `response_format` + prompt rewrite deployed Session 23 — not yet validated. See `docs/prompt-issues.md` Issue 2 |
| Guard 3 cycle detector — backward reference handling | Guard 3 must distinguish gate-bounded loops from tight computational loops. Rule: a backward reference is safe if the path from target back to source contains at least one `human_gate` step |
| ✅ `workflow-schema.json` condition step bare key mismatch | Fixed. Stripped `step:` prefix from all `on_truthy`/`on_falsy` values in `create_workflow`, `fix_workflow`, `get_entity`, `diagnose_prompt_schema` seed definitions (10 occurrences). All 225 unit tests now pass. |
| L1 static analysis does not enforce condition routing contract | `runLevel1StaticAnalysis` applies generic `ROUTING_TOKEN_RE` to `on_truthy`/`on_falsy` values. This misses two classes of defect: (1) `on_truthy: "next"` passes L1 but at runtime `executeCondition` normalises it to `"step:next"` — a dead target. (2) `on_truthy: "step:6"` passes L1, but the condition contract requires bare keys; if a future refactor removes the normalisation, this silently breaks. Fix: add a condition-specific L1 check that validates `on_truthy`/`on_falsy` are bare step keys that exist in `stepKeys`, not routing tokens. Failing test suite: `troubleshoot-fix-workflow.test.mjs` (suites 1, 2, 4, 6, 7). |

### Medium Priority

| Item | Notes |
|---|---|
| Cross-domain workflows — `create_workflow` spanning multiple domains | The Step Processor has no single-domain constraint at runtime — a step can reference any registered table regardless of domain. The gaps are: (1) `create_workflow` only injects one domain's schema into the LLM; (2) `PGC_Workflow.domain` is a single nullable text column, making multi-domain workflows invisible to `delete_domain` and domain-scoped queries. Fix: extend `create_workflow` to accept a list of participating domains and inject all their schemas into the generation prompts. `PGC_Workflow.domain` could be changed to a jsonb array or left null for cross-domain workflows (consistent with generic `*_entity` workflows). **Two validation test vehicles:** (A) *Make a recipe* — user picks a recipe from their recipes domain; workflow subtracts each ingredient from the inventory domain by quantity. Read-then-write chain across two domains. (B) *Add grocery receipt* — user submits a receipt; workflow fans out to write matching items to both the inventory domain and the expenses domain. Side-effect fan-out pattern. Both patterns require the LLM to reason about schemas from at least two domains simultaneously and to write to tables outside the workflow's primary domain. |
| pgvector semantic matching for IntentMap (Pass 1.5) — supersedes phrasing-gate regex | Sprint 4 added a `text_input` gate to `create_workflow` that captures user invocation phrases and writes them as a `\|`-joined regex to `PGC_IntentMap.pattern`. This is a workable MVP but requires the user to predict their own phrasings at creation time and provides no tolerance for synonym variation. The correct long-term fix is a **Pass 1.5** pgvector semantic search: at classification time, embed the user's raw input and run a cosine similarity query against `PGC_Workflow.intent_embedding` (or a dedicated `PGC_IntentMap.embedding` column). A match above a configurable threshold routes directly to that workflow — no regex, no Tier 2 LLM call. **Prerequisites:** (1) `PGC_Workflow.intent_embedding` column populated at workflow registration (see Low Priority item below — embedding generation step in `create_workflow` step 35 area). (2) New classification pass in `classify-intent.mjs` between Pass 1c (alias match) and Pass 2 (cheap LLM): `runPass1d` — pgvector ANN query via SERV, threshold configurable via `PGC_SystemContext`. (3) `PGC_IntentMap` may need an `embedding` column if matching against IntentMap rows rather than `PGC_Workflow` directly. Once live, the phrasing gate can remain as a user-friendly labelling step but its regex output becomes optional metadata rather than the primary matching mechanism. |
| Richer episodic memory content for domain workflow runs | `distillContent` in `memory-writer.mjs` writes a generic one-liner ("Completed workflow 'quiz_flashcards' for domain 'flashcards'") for all runs — no session data, no outcomes. For workflows that produce meaningful results (quiz scores, entity counts, etc.), this is too thin to be useful in future LLM context. Fix: inspect `run.state.local_state` at distillation time and extract key outcome fields based on workflow name (e.g. for quiz_flashcards: mastered_count, total_cards, step_count → "Completed quiz_flashcards for flashcards: 13/13 cards mastered in 42 answers"). Could be deterministic (field mapping per workflow name) or a cheap sonar call for rich multi-step runs. Either way, the distilled content should be meaningful enough to inform future `create_workflow` or `fix_workflow` calls about how the workflow performs in practice. |
| `create_domain` final confirm gate — feedback text box | The last confirm gate (step 16) has approve/cancel but no way to request minor changes before committing. Add a free-text feedback input to the gate; on submission, route through a lightweight `revise_domain_schema` llm_call that applies the feedback to the current scaffold, then re-present the updated schema for a final confirmation. Keeps the lightweight "tweak before commit" path distinct from the full preference-gate re-run loop. |
| `/explain-run <run_id> <prompt>` — run-level diagnostic chat | Aggregates step outputs across an entire `PGC_WorkflowRun` and seeds a chat session with that context (see `docs/session-chat-design.md` §6.3). **G3 dependency:** G3 writes a `PGC_Memory` row with `source_run_id = run.id` for every qualifying domain run. `/explain-run` queries `PGC_Memory WHERE source_run_id = <run_id>` to get the pre-distilled episodic anchor, then builds on it with the full `PGC_WorkflowRunStep` output sequence. Without G3, `/explain-run` must reconstruct run context from raw step records with no distilled narrative. New SQS type `EXPLAIN_RUN`, new intent category `explain_run`, and handler additions to `classify-intent-tiers.mjs` + `handler.mjs`. Full schema slot already reserved in `PGC_Session`. |
| Table maintenance — PGC_Memory TTL cleanup | Nightly job deletes PGC_Memory rows WHERE `expires_at < NOW()`. Episodic memories are written with `expires_at = NOW() + INTERVAL '90 days'`. Semantic and procedural rows have `expires_at = NULL` and are not touched. Implement as an EventBridge Scheduler → PROC `maintenance` endpoint → SERV deleteRows. Configurable via `PGC_SystemContext` key `episodic_ttl_days` (default 90). |
| Table maintenance — PGC_WorkflowRun archival | Completed/failed/cancelled runs older than 90 days are moved to a `PGC_WorkflowRunArchive` table (same schema). Active table stays small; stats view performance stays predictable. Nightly EventBridge → PROC maintenance. Child `PGC_WorkflowRunStep` rows must be moved first (FK order). Only terminal-status runs are eligible — never archive `running` or `awaiting_human_gate` rows. |
| Table maintenance — PGC_WorkflowRunStep archival | Cascades with `PGC_WorkflowRun` archival. `PGC_WorkflowRunStep` is the idempotency log — only rows whose parent run is in a terminal state are eligible. Move to `PGC_WorkflowRunStepArchive` in the same transaction as the parent run archival. Add `ON DELETE CASCADE` to FK if not already present so future hard-deletes clean up automatically. |
| Memory consolidation — semantic deduplication | When multiple semantic memories accumulate for the same domain+topic, a weekly job consolidates them: query memories older than 30 days with scope `{"domain":X}` and tags containing `schema`, run a cheap sonar call to distil into one record, delete originals. Consolidated record gets `priority 2`. Prevents unbounded corpus growth for active domains. |
| Novia Mode 4 /chat agent — agentic companion | Upgrade `/chat` from Mode 2 (managed history) to Mode 4 (agentic tool use loop). LLM can call tools: `get_workflow`, `analyze_workflow`, `propose_workflow_fix`, `apply_workflow_fix`, `serv_query`, `write_memory`, `add_system_context`, etc. Tool definitions in `PGC_Capability`. Write tools require human gate before execution. Persona (Novia/Javier) stored in `PGC_Memory` scope `{"topic":"persona"}` — global, no user scoping needed (single-user instance). See `docs/memory-design.md` Section 9 for full design. |
| LLM model alias system | Add `llm_model_aliases` jsonb entry to `PGC_SystemContext`. `PGC_Prompt.model` stores aliases (`smart`, `cheap`, `fast`) or pinned literal model IDs. Harness resolves aliases at call time. One `PGC_SystemContext` update upgrades all alias-using prompts when a new model ships. Add `dev_scripts/audit-model-ids.mjs` to find all pinned literal IDs. See `docs/memory-design.md` Section 11. |
| EventBridge Scheduler for scheduled workflows | User-created scheduled runs stored in new `PGC_Schedule` table. `manage_schedule` workflow creates/deletes EventBridge Scheduler rules. `LambdaExecutionRole` needs `scheduler:CreateSchedule`, `scheduler:DeleteSchedule`, `scheduler:GetSchedule` permissions. EventBridge → ProcFunction Lambda directly (not via API Gateway). See `docs/memory-design.md` Section 12. |
| PGC_Memory table — create and register | DDL with jsonb scope, GIN indexes, token_estimate, priority, expires_at. Register in PGC_Schema + PGC_TableMap (`allow_insert: true`, `allow_delete: true`). First step in memory layer implementation sequence. |
| Deduplicate shared prompt instruction blocks into PGC_SystemContext | `generate_workflow_steps` and `fix_workflow_routing` maintain parallel copies of CRITICAL ROUTING RULES and REPAIR RULES. Drift between them caused the condition routing bug in Sprint 2 (fix_workflow_routing Rule 6 contradicted generate_workflow_steps Rule 2 for months). Move shared blocks (routing rules, condition format contract, loop back-edge rules) into named `PGC_SystemContext` keys and inject via `inject_for`. One update fixes all consuming prompts. |
| Domain schema awareness across llm_call steps in create_workflow | `research_workflow_domain` explores domain schema and user preferences but its findings are discarded when the LLM call ends — `generate_workflow_steps` receives no schema context. Fix: add a `serv_query` step before `generate_workflow_steps` that fetches `PGC_Schema` rows for the target domain and injects them as `domain_schema`. No new step types required. Also applies to `fix_workflow_routing` — the repair agent currently has no visibility into the domain tables the workflow reads from. |
| /chat session context — inject environment snapshot | `/chat` answers in a vacuum: it has no knowledge of the user's domains, registered workflows, or domain data. Enrich the system message with a real-time snapshot: `PGC_DomainHelp` rows (what domains exist, their aliases and commands), `PGC_Workflow` rows for those domains (workflow names, descriptions, intent keywords), and optionally recent `PGC_WorkflowRun` activity (status, last-run timestamp). Implement as a `serv_query` step before the first `llm_call` in the chat flow, storing the snapshot in `local_state` and resolving it into the prompt via `{{template}}` injection. |
| `create_domain_example` system context is stale (pre-Sprint-2) | `PGC_SystemContext.create_domain_example` describes the v1 12-step linear workflow — it does not include the Sprint 2 additions (duplicate pre-check 0a–0d, right-brain research step 1R, preference gate iterator 1a–1c, updated left-brain call). Generation and troubleshooting LLMs that receive this context see the old pattern and have no reference for the L/R brain structure. Fix: rewrite `create_domain_example` to reflect the v9 data flow. |
| `PGC_Prompt.input_probe` column | Add `input_probe jsonb nullable` to `PGC_Prompt`. Steps: (1) `POST /api/v1/serv/table/addColumn` with `tableName: "PGC_Prompt", columnName: "input_probe", type: "jsonb", nullable: true` (also registers the column in `PGC_Schema`). (2) Add an `input_probe` object to each row in `seed_PGC_Prompt.json` — the canonical test input exercising that prompt's required variables. (3) Run `node dev_scripts/upsert-prompt.mjs`. Why: gives simulation, `/troubleshoot`, and dev scripts a stable probe input per prompt without constructing one ad-hoc; enables automated prompt regression testing. |
| `domain: null` on `create_workflow` runs | `input.domain` is null throughout — intent preprocessor passes only `userInput`. Fix: resolve domain before CREATE_WORKFLOW SQS dispatch and inject `domain_schema` into `research_workflow_domain` input |
| `research_workflow_domain` receives no domain schema | Prompt only receives `workflow_description` and `domain` (the latter is null). Without schema context the right brain cannot surface domain-specific preference questions. Fix: add `domain_schema` as an input variable |
| `fix_workflow_steps` prompt text says "complete array" | Prompt still instructs LLM to return the full corrected step array. Should say "return only the steps you changed". Reduces output tokens, eliminates risk of unrequested steps |
| `createTable` DDL + PGC_Schema insert not in a transaction | Physical table can exist without registry row on partial failure |
| `updateTable` ALTER TABLE | Currently metadata only — does not execute ALTER TABLE |
| `iterator` cannot express multi-step per-item sequences | Requires `sub_workflow` step type (MVP) or flat loop pattern (Option B) |
| `sub_workflow` step type — create_domain add-table migration | Option B (text_input gate + inline LLM) should be replaced with Option C: a reusable `design_table` sub-workflow. Prerequisite: `sub_workflow` step type live |
| `serv_aggregate` step type | GROUP BY + aggregation at DB level. Required for budget reports, portfolio summaries. Alternative to `llm_call` for arithmetic over query results |
| SERV-Query cross-entity parameterised SELECT | Join across multiple PGD tables with pagination. Required for complex entity reports |
| Gate types: `select_one`, `select_many` | `buildDialog()` stubs exist in step-executor.mjs. `select_one` limited to flat entity lists via `context_key`. Use `choice` for options with descriptions until live |
| `PGC_Workflow.intent_embedding` population at domain creation | Add embedding generation step to `create_domain` workflow and `generate_crud_workflows` prompt. Prerequisite for pgvector Pass 2 semantic search |
| `delete-domain.mjs` missing `PGC_Workflow` + `PGC_IntentMap` cleanup | When a domain is deleted, its 4 CRUD workflows + 4 IntentMap rows are not removed. Fix: query workflow IDs by `domain`, delete IntentMap where `workflow_id IN [ids]`, delete Workflow rows. Requires `allow_delete: true` on both tables |
| `PGC_WorkflowRun.session_id` FK column | Add `session_id integer FK → PGC_Session.id nullable` to `PGC_WorkflowRun`. Migration script needed — column did not exist at bootstrap |
| Live prompt export back to seed files | When the right-brain improves a prompt, the improvement lives only in DB. Fix: `dev_scripts/export-prompts.mjs` reads live rows and overwrites `seed_PGC_Prompt.json`. Required before right-brain improvement loop is useful at scale |
| Dependency injection for DB clients | Needed for unit testability — clients currently instantiated at module level |
| `add_<domain>` workflows already in DB from v2/v3 are thin stubs | Existing domains (e.g. recipes) have the old 2-step workflow. Delete and recreate domain to get the v4 LLM-parse-first workflow, or manually upsert via `upsert-workflow.mjs` |
| `init-brain.mjs` shared DDL utilities | `buildCreateTableSQL` and `getClient` imported by `schema.mjs` from `init-brain.mjs`. Refactor: extract to `src/shared/serv-utils.mjs` |
| `PGC_Schema` not updated when `ALTER TABLE` adds a column | Every `ALTER TABLE` on a PGC table must be paired with an `UPDATE PGC_Schema SET columns = columns \|\| '[{"name":...}]'` |
| Implement remaining Block Elements | Create-workflow LLM design-workflow-dialogues need a complete menu of widgets to handle any dialog requirement like date-picker, URL links, etc. See Block Elements table in slack-block-kit.md |

### Low Priority

| Item | Notes |
|---|---|
| Stale buttons persist intermittently after gate selection | When a user selects a preference in an iterator human_gate, the `chat.update` call that replaces the buttons occasionally does not arrive before the next gate posts, leaving the previous gate's buttons visible. Intermittent. Likely a Slack API race between `chat.update` and `chat.postMessage` — investigate whether the update should be fire-and-forget before resuming the gate or whether a retry/ack pattern is needed in `callback.mjs`. |
| ✅ Peek reveal: `task_card` block | Implemented. `peek_reveal` now posts a `task_card` block (`status: complete`, `output`: rich_text) as a thread reply via `chat.postMessage` instead of opening a modal. `button_label` passed in button value and used as card `title`. See `docs/slack-bot-kit.md` for block reference. |
| Test environment | Stand up a parallel AWS environment (separate SAM stack, separate RDS instance, separate Slack workspace) so changes can be validated end-to-end before touching prod. Needed before any concurrent contributors or automated integration test runs against live infra. |
| `README.md` environment bootstrap coverage | README currently describes what the system does but not how to create a new environment from scratch. Add a "Bootstrapping a new environment" section covering: AWS prerequisites, SSM parameter names and values, `sam build && sam deploy`, `POST /api/v1/serv/bootstrap`, and the `dev_scripts/upsert-*.mjs` seed sequence. Should be the single reference for spinning up prod or test. |
| `design-domain.mjs` dead code | No longer receives traffic since Step Processor took over. Remove in next cleanup pass |
| Orphan table cleanup tooling | Failed partial runs leave orphan tables — `delete-domain` covers full domains; per-table cleanup is manual |
| AWS infrastructure cost — Bastion Host public IPv4 | EC2 Bastion accrues ~$2.82/month. Replace with AWS SSM Session Manager when promotional credits near exhaustion |
| W3C `traceparent` format for `traceId` | Adopt `{version}-{traceId}-{parentId}-{flags}` when observability tooling added |
| Option B name-based delete/update | Allow `/m delete recipes SWEET POTATO` to find by name then confirm by resolved id. Requires `serv_entity_query` pre-step |
| `update_entity` missing field values instructive error | `/m update recipes id=3` with no field=value pairs should post instructive error without creating a WorkflowRun |
| Run/trace id missing from Slack gate acknowledgements | Human gate dialogs do not surface `workflowRunId` or `traceId` — impossible to correlate with CloudWatch without querying DB |
| `generate_crud_workflows` prompt description length | `PGC_DomainHelp.description` used in help button labels. Add prompt rule: description ≤ 50 chars |
| `add_entity` child iterator timeout ceiling | Sequential iterator bounded by Lambda timeout. At 60s / ~400ms per insert, safe ceiling ~120 child rows. Document in runbook |
| Integration tests | Defer until intent pipeline complete — use `testcontainers` + PostgreSQL |
| CI/CD GitHub Actions | Deliberately deferred until `template.yaml` stabilises |
| `callback` routing pattern not enforced at compile time | Every PROC endpoint must use `req.callback ?? req.body?.callback ?? null`. Currently convention only |
| Terraform state — legacy infrastructure | Terraform config in `terraform-aws/` predates SAM migration. Check for orphaned AWS resources before decommissioning |
| Azure MSAL token utility (`src/lib/getAccessToken.js`) | Vercel-era artifact. Assess for Teams Experience tier or decommission |
| `upsert-workflow.mjs` required on fresh deploys | `init-brain` uses `ON CONFLICT DO NOTHING` — must run `upsert-workflow.mjs <name>` after any workflow step changes |
| `output_key` on non-`text_input` gates is misleading | `review_object` and `confirm` gates do not write to `local_state[output_key]` on confirm |
| `PGC_SystemContext.step_type_contracts` can become stale | Re-run `seed_PGC_StepType.mjs` then `seed_PGC_SystemContext.mjs` when a new step type goes live |
| `toEntityName()` in `classify-intent.mjs` is dead code (fallback only) | Remove once all domains are recreated with `domain` column populated |
| `orderBy` field in entity queries not driven by `PGC_EntitySchema` | Add optional `display_order_column` to `PGC_EntitySchema` — `list_entity` reads it when present |
| `formatRecordList` renders id-only for tables where label column is not `name` | Add `display_column` hint in `PGC_TableMap` |
| `parse_entity_input` generic prompt — domain-specific refinement | For domains where column semantics are non-obvious, parse quality degrades. Fix: `PGC_Prompt.error_log` + right-brain refinement |
| `generate_crud_workflows` v2 `input_variables` stale | Seed row still lists `domain_help` as required; create_domain step 6 no longer passes it. Renders as empty string — not breaking |
| CHECK constraint `output_schema` validation | Tighten schema to require `expression` and disallow `columns` on check type constraints |
| `output_key` on `review_object` gate should warn if set | Executor has no guard; only `text_input` gates write to `local_state[output_key]` |
| Session context window size configurable | `chat_defaults` key in `PGC_SystemContext` should define `session_context_limit` (default 20). Currently not implemented |
| Alias management workflow `/mind edit aliases for <domain>` | View and update `PGC_DomainHelp.aliases` from Slack without touching the DB |
| Pass 2 keyword scan excludes `domain: null` workflows | System workflows unreachable via Pass 2 — causes unnecessary Tier 2 sonar LLM calls |
| `list_recipes` notify shows "Found recipes record(s)" without count | `{{results.length}}` not resolving on one run. Right-brain fix — prompt variance. Do not patch template resolver |

---

## 2. Tangential Features

Features designed but deferred — require the Step Processor to exist first, or represent meaningful scope expansion.

### 2.0 Pre-Sprint 5 Design Session — Primitive Taxonomy

**Do this during Sprint 5 planning before scoping any agentic loop work.**

Define clear boundaries between: **workflow**, **workflow step**, **skill**, and **tool**. These terms are currently used informally and the distinctions will matter once agents can compose capabilities dynamically. The agentic loop (Novia, Sprint 5) requires the taxonomy to be decided first — otherwise the architecture will drift as soon as agents start generating or selecting their own execution paths.

Questions to resolve:
- What makes something a workflow vs a single step? (atomicity boundary, SQS envelope, human gate eligibility)
- What is a skill? Is it a named workflow, a named capability in `PGC_Capability`, or something else entirely?
- What is a tool? Is it a `capability_call` step, an MCP-style callable, or a pre-built `serv_*` step type?
- Which of these can an agentic loop generate at runtime vs which must be pre-registered?
- How does the static/evolving artifact boundary apply to each primitive?

Output: a 1-page decision record added to `docs/architecture.md` before any Sprint 5 implementation starts.

### 2.1 External API Registry — capability_call Step Type

#### The problem

`js_transform` is restricted to pure synchronous data transformations. External data enrichment from third-party APIs cannot be done safely in LLM-generated JS:
- `vm.runInNewContext` timeout does not apply to async operations
- LLM-generated fetch calls are an exfiltration vector — a prompt injection attack or hallucinated URL could send workflow state to an attacker's endpoint
- API keys embedded in generated code are exposed in `PGC_Workflow` rows
- No rate limiting, retry logic, or circuit breaking on arbitrary fetch

#### The design

The system maintains a **capability registry** of approved external integrations. Each registered capability defines what can be called, how to authenticate, and what parameters are allowed. The LLM generates workflow steps that reference capability keys — it never constructs URLs, never sees API keys, and cannot call anything outside the registry.

**PGC_Capability schema extension:**

| Column | Type | Notes |
|---|---|---|
| base_url | text | Root URL for the API |
| endpoints | jsonb | Named endpoint templates |
| auth | jsonb | Auth config — `{ type: "query_param", key: "token", ssm_path: "..." }` |
| allowed_params | jsonb | Whitelist of parameter names the LLM may supply |
| rate_limit | text | Human-readable limit — e.g. "60/minute" |
| timeout_ms | integer | Per-call timeout. Default 5000ms |

Auth credentials are stored in SSM, never in the database.

**New step type: capability_call**

```json
{
  "step": "3",
  "type": "capability_call",
  "capability_key": "finnhub_quote",
  "endpoint": "quote",
  "params": { "symbol": "{{state.ticker}}" },
  "output_key": "current_price",
  "on_success": "next",
  "on_failure": "cancel"
}
```

#### Finnhub integration — first planned capability

```json
{
  "capability_key": "finnhub",
  "category": "external_api",
  "description": "Finnhub stock market data — quotes, candles, company profiles",
  "status": "planned",
  "base_url": "https://finnhub.io/api/v1",
  "endpoints": {
    "quote":        "/quote?symbol={{symbol}}",
    "candles":      "/stock/candle?symbol={{symbol}}&resolution={{resolution}}&from={{from}}&to={{to}}",
    "company_info": "/stock/profile2?symbol={{symbol}}"
  },
  "auth": {
    "type": "query_param",
    "key": "token",
    "ssm_path": "/evolving-mind-ai/finnhub-api-key"
  },
  "allowed_params": ["symbol", "resolution", "from", "to"],
  "rate_limit": "60/minute",
  "timeout_ms": 5000
}
```

#### What needs to be built

1. PGC_Capability schema extension — add the API Registry columns listed above
2. SSM parameter for Finnhub API key
3. New `capability_call` row in `PGC_StepType` seed data
4. Step Processor handler for `capability_call`
5. Finnhub seed row in `PGC_Capability`
6. Rate limiting — token bucket in `PGC_WorkflowRun` state or a dedicated table

### 2.2 js_transform Safety Analysis — Synchronous Constraint

`vm.runInNewContext({ timeout: N })` in Node.js reliably kills synchronous infinite loops. It does NOT apply to async operations. The chosen approach — prohibit async in `js_transform`, use `capability_call` for I/O — is correct for this system. External data enrichment is a `capability_call` concern. The distinction between "transform data I already have" and "fetch data I don't have" is architecturally meaningful and enforced.

---

## 3. Build History

Session tags and what was completed. Authoritative source is `git log --oneline`.

| Tag | What was completed |
|---|---|
| `v3.2-scaffolding-complete` | All 5 pings pass (ping-api, ping-llm, ping-sqs, ping-db, ping-e2e) |
| `v3.2-ping-complete` | ping-sqs threading fixed, ping-e2e full round trip with RDS version string |
| `v3.2-serv-schema-complete` | SERV-Schema all CRUD endpoints, init-brain bootstrap, 4 PGC system tables |
| `v3.2-pgc-workflow-tables-complete` | 10 PGC system tables bootstrapped and seeded |
| `v3.2-callback-abstraction-complete` | Generic callback object, SYSSQSCallbackResults queue rename |
| `v3.2-serv-table-partial` | SERV-Table getRows + insertRow, wired into serv handler |
| `v3.2-create-domain-scaffold` | /create-domain end to end with hardcoded recipes scaffold |
| `v3.2-create-domain-live-llm` | /create-domain live LLM via Perplexity Agent API + json_schema output |
| `v3.2-r14-r15-complete` | FK/constraint normalisation moved to SERV layer; response_format restored on LLM call |
| `v3.2-slack-signing-complete` | Slack signing secret verification added to SlackbotFunction handler |
| `v3.2-template-cleanup` | SchemaQueue + DLQ removed, LambdaInvokePolicy removed, stale env vars cleaned |
| `v3.2-clean-baseline` | All pings passing, Lambda invoke pattern fully gone, clean foundation for Phase 2 |
| `v3.2-interactive-complete` | /interactive endpoint live, /help command proves full interactive loop end-to-end |
| `v3.2-serv-table-complete` | SERV-Table updateRows + deleteRows complete. openapi.yaml v3.3.2 |
| `v3.2-shutdown-complete` | /shutdown command — SlackbotFunction + ProcFunction, ephemeral Slack response |
| `v3.2-serv-entity-complete` | SERV-Entity all six routes complete. PGC_EntitySchema upsert_key added. openapi.yaml v3.3.3 |
| `v3.2-bootstrap-clean` | init-brain installs set_updated_at() on PGD. seed_PGC_Schema upsert_key synced |
| `v3.2-design-domain-foundation` | shared/llm-client + shared/serv-client extracted. proc/review-output. proc/design-domain first pass. openapi.yaml v3.3.4 |
| `v3.2-design-domain-e2e` | callback routing fix. callback.mjs DESIGN_DOMAIN_RESULT + ERROR handlers. Full Slack flow confirmed |
| `v3.2-refactor-complete` | Phase 1 refactoring closed out. All pings passing |
| `v3.2-design-domain-gate-complete` | proc/design-domain Block Kit review gate + in-place remove. human_gate suspend/resume wired |
| `v3.2-step-processor-complete` | Step Processor fully operational. First successful create_domain end-to-end (WorkflowRun 12) |
| `v3.2-tangential-features` | /create-domain + /help fully wired to Step Processor. dev_scripts/upsert-workflow.mjs |
| `v3.2-intent-preprocessor-complete` | Intent Preprocessor fully operational. mind.mjs + classify-intent.mjs + classify-intent-tiers.mjs |
| `v3.2-crud-adhoc-complete` | Ad_hoc CRUD execution from /mind fully operational. All four CRUD verbs working |
| `v3.2-create-domain-with-crud` | First complete create_domain end-to-end: 5 human gates, 4 PGD tables, CRUD registered |
| `v3.2-create-workflow-complete` | create_workflow fully implemented. on_failure human_feedback. simulate step type. Pass 2b routing rules |
| `v3.2-create-domain-complete-w-help` | Gap 4 (entity schema) + Gap 1 (interactive help). create_domain v5 (17 steps). help workflow v2 |
| `v3.2-gap3-add-workflow` | Gap 3 rich ingestion. parse_entity_input v1. generate_crud_workflows v4. executeTop completed guard |
| `v3.2-generic-crud-complete` | Generic *_entity workflows. create_domain step 9 inserts IntentMap directly. Recipes full CRUD |
| `v3.2-intent-preprocessor-phase-b-complete` | Phase B pre-pass + 50 unit tests passing |
| `v3.2-js-transform-sandbox-serv-entity-schema` | condition step type. js_transform generic expression sandbox (acorn + vm). serv_entity_schema |
| `v3.2-option-c-domain-registration` | Deterministic domain registration |
| `v3.2-local-state-sandbox-builtins-removed` | local_state in js_transform sandbox. All transform_type built-ins replaced by self-contained expressions |
| `v3.2-troubleshoot-fix-workflow-complete` | Tier 1 reactive self-repair loop. troubleshoot-workflow.mjs + fix-workflow.mjs |
| `v3.2-response-format-max-tokens` | response_format restored on Perplexity. max_output_tokens per-prompt. diagnose-prompt-schema.mjs Tier 1b |
| `v3.2-session24-complete` | Iterator gate resume fix. diagnose_prompt_schema R1–R6 validated. pgvector promoted to Active |
| `v3.2-session25-complete` | isSonar guard in llm-client. fence extraction regex. diagnose_prompt_schema v4. PGC_Prompt probe_input + max_output_tokens |
