# evolving-mind-ai — Backlog History

Completed and closed tasks from backlog.md, preserved for reference. Items moved here once definitively resolved.

---

## Sprint 15 — closed items (2026-11-02)

| Item | Resolution |
|---|---|
| **DEFERRED (Javear, 2026-11-02) — Novia calls Anthropic directly, not through the Perplexity gateway (Javear, 2026-10-24).** Chosen for a 1h TTL across a human-paced test cycle; Sprint 15 AC5 measures whether a self-paced one fits the 5-minute TTL, and decides whether this returns | **Not needed for self-testing — Sprint 15 AC5.** Session 1284's whole self-test cycle (43 calls) cost $1.79 at 96% cache reads: every wake arrived within seconds and read its full prefix, so the 5-minute TTL suffices. The 1h TTL was for a human-paced cycle, which self-testing removed. Reopen only on new evidence about human-paced sessions. |
| **Novia tests her own work — `read_workflow_run` (Javear, 2026-10-25; added to Sprint 14 as scope item 8, moved here the same day)** | **Done Sprint 15 (scope 3).** `projectWorkflowRun` reads the stack or `state`, renders a waiting gate with `buildDialog`, and returns each step's value at its `output_key`. Tool live in `minds_eye_tool_schemas`. |
| **Novia tests her own work — wake her when her run reaches a gate (Javear, 2026-10-25)** | **Done Sprint 15 (scope 5).** A `novia` run's messages become `run_event` wakes; `run_workflow { test: true }`, `answer_gate`, `replay_run` and `resolve_replay_break` record her wait first and the event becomes their result (no `await_run`). Bounded by `max_test_events`. Proven live, session 1284. |
| **IN SPRINT 15 (Javear, 2026-11-02) — decided: option A, a sandbox schema. Novia tests her own work — a test-data policy for prod (Javear, 2026-10-25)** | **Done Sprint 15 (scope 2, AC2, AC6).** `docs/arch-sandbox.md`: `sandbox_<n>` schemas, `search_path` via `x-sandbox`, PGD writes outside the sandbox refused. Household rows proven unchanged across runs 955–960. |
| **IN SPRINT 15 (Javear, 2026-11-02) — A turn whose tool arguments will not parse is never persisted (2026-08-30)** | **Done Sprint 15 (scope 8–9, AC9).** Persisted with the turn's own items; unit-tested. |
| **IN SPRINT 15 (Javear, 2026-11-02) — `PGC_SessionEntry.json` template omits `tool` from its role check (2026-08-30)** | **Done Sprint 15 (scope 8, AC9), and widened to the four-way schema audit (scope 11, AC11).** |
| **IN SPRINT 15 (Javear, 2026-11-02) — last in the sprint, through the sandbox. Give Novia the replay harness as a tool (2026-08-26)** | **Done Sprint 15 (scope 10, AC10).** `replay_run` / `resolve_replay_break`; a replay reads its source run's clock (`arch-replay.md` §9a). Proven live, session 1287: run 946 replayed with no LLM call. |

---

## Sprint 7 — closed items (2026-06-30)

| Item | Resolution |
|---|---|
| Watchdog Lambda — Zone C recovery | **Obviated.** Zone C Lambda death issue mitigated by Lambda timeout (240s) + SQS VisibilityTimeout (600s) widening in Sprint 4. No further incidents. |
| `chk_triggered_by` constraint — expand to all trigger paths | **Confirmed done.** `seed_PGC_Schema.json` constraint already includes `minds_eye` and `intent_classify` values. |
| L1 static analysis does not enforce condition routing contract | **Confirmed done.** `condition_routing_invalid` check implemented in `simulation-engine.mjs` — validates `on_success`/`on_else` on condition steps must be bare step keys. |
| IntentMap pattern quality — `create_workflow` should capture user invocation phrasing | **Done Sprint 7 session 2.** Step 35k (js_transform) formats `intent_keywords_display`; step 35a shows LLM-suggested phrases instead of hardcoded flashcard examples; step 35b falls back to `draft_workflow.intent_keywords` when user skips. |
| `generate_workflow_steps` Instruction fix — no system prompt reuse | **Done Sprint 7 session 2 (Track A1).** CRITICAL rule added prohibiting system prompt names for domain-specific steps. v32→v33. |
| `design_workflow_prompts` Instruction fix — always "create" for system/cross-domain reuse | **Done Sprint 7 session 2 (Track A2).** Domain equality check on reuse rule, uniqueness guard on create rule, cross-domain example fixed, domain:null rows filtered from step 23c query. v1→v2. |
| `PGC_WorkflowRunStep` audit log not written — fix or remove | **Removed from scope.** Write path complexity exceeds value at current scale; Novia diagnostic queries and session-scoped LLM call tracking (Sprint 7 Track B) address the observability gap. `PGC_WorkflowRunStep` table retained in schema but not actively written. |
| Memory bridge validation — `create_domain` schema decisions surfaced to `create_workflow` | **Closed.** Validated during Sprint 4–5 flashcard testing. `create_domain` `write_memory` captures schema decisions; `create_workflow` retrieves domain memory via semantic search. Richer episodic content remains a low-priority backlog item. |
| Skeleton-first workflow generation — split `generate_workflow_steps` into routing frame | **Implemented.** Routing skeleton (`routing_skeleton` field) generated in an earlier step, validated with L1 BFS, then passed to `generate_workflow_steps` as locked routing. Content generation now works against a pre-validated routing frame. |
| Domain data initialization — initial field values for generated workflows | **Addressed.** `create_domain` scaffold design captures `initial_value_conventions`; these are injected into `add_entity` workflow prompts. Remaining gaps tracked under `parse_entity_input` and `serv_entity_insert` items. |
| Memory two-layer architecture — episodic vs semantic with provenance | **Implemented.** `PGC_Memory` live with episodic/semantic/procedural distinction and provenance tags. `write_memory` step type active. Post-run consolidation deferred to low priority. |
| JSON encoding consistency — DB-stored vs seed-file content | **Resolved.** Seed files enforce `\uXXXX` via `.gitattributes`; SERV layer normalizes on read/write. No false-positive diffs observed in active development. |
| Tier 1 post-write validation — dead routing targets | **Superseded.** Routing skeleton approach + L1 validation loop in `create_workflow` catch dead routing targets before the workflow is registered. Post-write L1 pass on `fix_workflow` still a gap but lower priority. |
| L1 static analysis: detect nested `{{...{{...}}...}}` template tokens | **Fixed.** `unsupported_handlebars_syntax` L1 check added, covering nested brace patterns and block helpers. |
| `analyze_and_design_workflow` persistent schema mismatch | **Resolved.** Prompt rewritten with `response_format` + corrected field names. Validated across multiple `create_workflow` runs in Sprint 5–6. |
| ✅ `workflow-schema.json` condition step bare key mismatch | **Already closed.** Stripped `step:` prefix from all `on_success`/`on_else` values in seed definitions (10 occurrences). |

---

## Closed Active Tasks

### Session 35 — completed tasks

| # | Status | Task | Resolution |
|---|--------|------|------------|
| 3 | ✅ done | Add typeof string guard to run-workflow.mjs output_key split | commit `a6b873b` — `typeof` guard added to `output_key.split()` call in `run-workflow.mjs` to prevent crash on non-string output_key values. Complements the same guard added to L1/L2 in `step-executor.mjs` (commit `35e0a81`) |
| 4 | ✅ done | Update flat_loop_example to document optional input_key and multi-output | commit `a6b873b` — `seed_PGC_SystemContext.json` updated; pushed to DB |
| 5 | ✅ done | Retest `/m create workflow Spanish flashcard quiz` | Run 321 succeeded — `spanish_flashcard_quiz` registered. `review-output` false-positive cancel check fixed (commit `db83267`) |
| 7 | ✅ done | Fix conditional increment in serv_update | Resolved in run 321 — LLM pre-computed delta values in step 8 js_transform (`card_updates`) and used flat references in step 9 |

---

## Archived — Section 9 Build Order (completed phases)

All Phase 1 refactoring and Phase 2 features are complete. Step types and gate types
live in `PGC_StepType` seed and `docs/architecture.md` §6.5.1. Deferred items from
the original Section 9 backlog are carried into `backlog.md` §1 (active tech debt).

### Phase 1 — complete (git tag: v3.2-clean-baseline)

Refactoring decisions preserved in Section 13 archive below.

### Phase 2 — complete features

| # | Task | Git tag |
|---|---|---|
| 1 | Slack /interactive + signing verification | v3.2-interactive-complete |
| 2 | /shutdown command | v3.2-shutdown-complete |
| 2a | SERV-Table updateRows + deleteRows | v3.2-serv-table-complete |
| 2b | SERV-Entity six routes | v3.2-serv-entity-complete |
| 3a/3b/3c | design-domain, Step Processor foundation | v3.2-step-processor-complete |
| 4 | Intent Preprocessor (classify-intent, mind.mjs) | v3.2-intent-preprocessor-complete |
| 4 | Ad_hoc CRUD execution | v3.2-crud-adhoc-complete |
| 4a | create_domain v5 (13 steps, modal, branch, topological sort) | v3.2-local-state-sandbox-builtins-removed |
| 4b | create_workflow full implementation (simulate step type) | v3.2-create-workflow-complete |
| Gap 1 | Interactive /help workflow | v3.2-create-domain-complete-w-help |
| Gap 3 | Rich multi-table ingestion (add_\<domain\> LLM-parse-first) | v3.2-gap3-add-workflow |
| Gap 4 | PGC_EntitySchema population at domain creation | v3.2-create-domain-complete-w-help |
| 5 | Step Processor SQS-driven lifecycle | v3.2-step-processor-complete |
| 6 | Tier 1 self-repair (troubleshoot + fix workflow) | v3.2-troubleshoot-fix-workflow-complete |
| 7 | Tier 1b prompt schema repair (diagnose-prompt-schema) | v3.2-response-format-max-tokens |

---

## Archived — Section 13 Refactoring Decisions (all complete)

| Decision | Rationale |
|---|---|
| ProcStepOrchestrator eliminated — ProcFunction dual HTTP+SQS trigger | Eliminates Lambda-to-Lambda hop |
| `invokeServ` replaced with `fetch(SERV_API_URL)` | Cloud portability |
| All PROC endpoint modules transport-agnostic | No AWS SDK in business logic |
| `shared/ping-utils.mjs` → `shared/lambda-utils.mjs` | Accurate name |
| `workflowId` → `traceId` throughout | Avoids conflation with PGC_WorkflowRun.id |
| FK + constraint normalisation moved to `buildCreateTableSQL` | SERV owns DDL contract |
| `response_format json_schema` restored on Agent API call | Reduces malformed LLM output |
| `SchemaQueue` + `LambdaInvokePolicy` removed from template.yaml | Orphaned resources |
| `PROC_FUNCTION_NAME` + stale env vars removed | Lambda invoke pattern gone |
