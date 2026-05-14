# evolving-mind-ai — Backlog History

Completed and closed tasks from backlog.md, preserved for reference. Items moved here once definitively resolved.

---

## Closed Active Tasks

### Session 35 — completed tasks

| # | Status | Task | Resolution |
|---|--------|------|------------|
| 3 | ✅ done | Add typeof string guard to run-workflow.mjs output_key split | commit `1e687d8` — `typeof` guard added to `output_key.split()` call in `run-workflow.mjs` to prevent crash on non-string output_key values. Complements the same guard added to L1/L2 in `step-executor.mjs` (commit `8ebce82`) |
| 4 | ✅ done | Update flat_loop_example to document optional input_key and multi-output | commit `1e687d8` — `seed_PGC_SystemContext.json` updated; pushed to DB |
| 5 | ✅ done | Retest `/m create workflow Spanish flashcard quiz` | Run 321 succeeded — `spanish_flashcard_quiz` registered. `review-output` false-positive cancel check fixed (commit `beb99c7`) |
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
