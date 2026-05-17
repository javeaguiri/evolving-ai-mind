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
| 12 | pending | Fix domain:null on create_workflow — inject domain_schema | Resolve domain before CREATE_WORKFLOW SQS dispatch; inject domain_schema into research_workflow_domain input |
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

### Low Priority

| Item | Notes |
|---|---|
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
