# evolving-mind-ai — Architecture: Reference
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2
Status: Active development — Session 29 complete
Last updated: 2026-04-27 (session 29 — callback.mjs: HUMAN_GATE / HUMAN_NOTIFICATION consolidation;
special_buttons field on human_gate steps; interactive.mjs placeholder fix)

**Architecture document set:**
- `architecture-core.md` — system overview, stack, Lambda tiers, SQS queues, data architecture, SERV layer, dev scripts
- `architecture-step-processor.md` — Step Processor execution engine: step types, stack, local_state, human gates, simulation, right-brain validation, safety
- `architecture-workflows.md` — Workflow definitions: create_domain, create_workflow, L/R brain collaboration, gap taxonomy, self-repair loop
- `architecture-reference.md` — this file: pgvector, security, tech debt register, backlog, cost of ownership, refactoring history

---

## 7. Tech Debt Register

| Item | Priority | Notes |
|---|---|---|
| Workflow safety guards (velocity detector, execution accumulator, cycle detector) | High | Required before Step Processor is production-ready — see Section 6.10. Right-brain can monitor `PGC_WorkflowStats` for anomalous run patterns and flag suspect workflows proactively |
| Semantic validation rules for create_domain scaffold | ~~High~~ | ✅ Implemented in `src/proc/review-output.mjs` — all three rules enforced in `runSemanticRules()` |
| `resume_gate` routes to HELP workflow only | ~~High~~ | ✅ Resolved — Step Processor dispatches generically via `run-workflow.mjs dispatchSqs()`. No per-workflow routing in handler |
| `create-domain.mjs` ignores scaffold from design-domain and calls LLM again | ~~High~~ | ✅ Resolved — Step Processor drives `create_domain` declaratively from `PGC_Workflow.steps` |
| Gate re-renders post new Slack messages instead of `chat.update` in-place | ~~Medium~~ | ✅ Resolved — `message_ts` threaded through SQS → `run-workflow.mjs` → `HUMAN_GATE` → `callback.mjs` `chat.update` |
| Duplicate domain detection — LLM runs every time | High | `/create-domain recipes` re-runs the LLM even if the domain already exists. Correct fix: add a `serv_query` pre-check step to `create_domain` workflow before the `llm_call` — now unblocked, fix in Phase 2 item 4a |
| `create_domain` prompt produces varying schemas across runs | Medium | LLM variance at `temperature: 0.2`. Correct fix: right-brain prompt evolution via `PGC_WorkflowStats` + `PGC_Prompt.error_log`. Do not invest in defensive patching before the feedback loop exists |
| ~~`js_transform` built-in `columnSummary` only~~ | ~~Medium~~ | ✅ Resolved — generic sandbox implemented in Session 19. `expression` field added to `js_transform` step type. acorn AST gate rejects async, network, eval, and Node globals before `vm.runInNewContext` executes. Built-ins retained as named transforms; `buildEntitySchema` removed and replaced by `serv_entity_schema` step type. See Section 6.5.1 |
| `PGC_WorkflowRunStep` idempotency uses `parseInt(stepNumber)` | ~~Medium~~ | ✅ Resolved — `step_key text` column added to `PGC_WorkflowRunStep`. `checkIdempotency` queries on `(run_id, frame_id, step_key)` string comparison. `parseInt` never used in idempotency paths. `migrate-step-key.mjs` backfilled existing rows |
| `created_tables_summary` hardcoded in iterator | ~~Low~~ | ✅ Resolved — `notify` step message_template now uses `proposed_scaffold.domain` and explicit command examples instead of the hardcoded iterator summary |
| `domain: null` on DDL-created tables | ~~Medium~~ | ✅ Resolved in Phase 2 item 4a — `js_transform` at step 2 enriches each table object with `domain: proposed_scaffold.domain` before the DDL iterator runs. `serv_schema createTable` writes domain to both `PGC_Schema` and `PGC_TableMap` |
| Tier 1 post-write validation — dead routing targets | High | After any `PGC_Workflow` write (fix_workflow step 8, create_workflow step 19), run Level 1 simulation on the written step array and fail immediately if dead routing targets are found. Currently the user discovers dead targets only when execution hits that branch. NOT Tier 3 — blocking defects must be caught before the user retries. |
| `analyze_and_design_workflow` persistent schema mismatch | High | Prompt id 25. LLM produces wrong field names on every attempt (4 failed runs). `response_format` + prompt rewrite deployed Session 23 — not yet validated. See `docs/prompt-issues.md` Issue 2 |
| `domain: null` on `create_workflow` runs | Medium | `input.domain` is null throughout `create_workflow` runs because the intent preprocessor passes only `userInput`, not a resolved domain. `research_workflow_domain` and `analyze_and_design_workflow` receive no schema context. Fix: resolve domain before CREATE_WORKFLOW SQS dispatch and inject `domain_schema` into `research_workflow_domain` input |
| `research_workflow_domain` receives no domain schema | Medium | Prompt only receives `workflow_description` and `domain` (the latter is null). Without schema context the right brain cannot surface domain-specific preference questions (e.g. "Evaluate quiz answers by LLM or user self-report?"). Fix: add `domain_schema` as an input variable. Schema metadata (column names/types) is safe to send — never send actual row data |
| `fix_workflow_steps` prompt text says "complete array" | Low | Prompt still instructs LLM to return the full corrected step array. Now that step 4b handles the merge, the prompt should say "return only the steps you changed". Reduces output tokens and eliminates risk of the LLM returning unrequested steps. Update in seed and re-upsert |
| `design-domain.mjs` dead code | Low | No longer receives traffic since Step Processor took over. Remove in next cleanup pass |
| `createTable` DDL + PGC_Schema insert not in a transaction | Medium | Physical table can exist without registry row on partial failure |
| Orphan table cleanup tooling | Low | Failed partial runs leave orphan tables in PGC_Schema — `delete-domain` covers full domains; per-table orphan cleanup is manual |
| AWS infrastructure cost — Bastion Host public IPv4 | Low | EC2 Bastion accrues ~$2.82/month in public IPv4 charges. Replace with AWS SSM Session Manager when promotional credits near exhaustion |
| W3C `traceparent` format for `traceId` | Low | Adopt `{version}-{traceId}-{parentId}-{flags}` when observability tooling added |
| `updateTable` ALTER TABLE | Medium | Currently metadata only — does not execute ALTER TABLE |
| Unit tests | ~~Medium~~ | ✅ Phase A complete — `tests/unit/classify-intent-tiers.test.mjs` (50 tests, 50 passing). Covers `matchIntentMap`, `matchDomainAlias`, `matchWorkflowByKeywords`, `extractSearchTerm`, `parseFieldValues` with UC 1.1–1.6 scenarios. Phase B unit tests (Groups 3–4) and integration tests pending — see Session 18 next steps |
| UC 1.1 Pass 2 keyword scan gap | ~~Medium~~ | ✅ Resolved — `matchWorkflowByKeywords` filter changed from `r.domain === domain` to `r.domain === domain \|\| r.domain === null`. Generic `*_entity` workflows with `domain: null` are now universal candidates for any domain's keyword scan |
| Option B name-based delete/update | Low | Allow `/m delete recipes SWEET POTATO` to find record by name then confirm delete by resolved id. Requires `serv_entity_query` step before confirmation gate. Backlog |
| `update_entity` missing field values instructive error | Low | `/m update recipes id=3` with no field=value pairs creates a `WorkflowRun` with `parsedUpdates: null`. The `serv_update` step will apply an empty update object. Add guard in `handoff()` when `parsedId` is set but `parsedUpdates` is null for `update_entity` — post instructive error without creating a WorkflowRun |
| Run/trace id missing from Slack gate acknowledgements | Low | Human gate dialogs do not surface `workflowRunId` or `traceId` in the Slack message, making it impossible to correlate interactions with CloudWatch logs without querying the DB |
| `generate_crud_workflows` prompt description length | Low | `PGC_DomainHelp.description` is used as part of help button labels. Labels exceeding 75 chars cause Slack `invalid_blocks`. Add rule to prompt: description must be 50 characters or fewer |
| `add_entity` child iterator timeout ceiling | Low | Inline sequential iterator is bounded by Lambda timeout. At 60s / ~400ms per insert, safe ceiling is ~120 child rows. Operational constraint — document in runbook |
| Integration tests | Low | Defer until intent pipeline complete — use `testcontainers` + PostgreSQL |
| CI/CD GitHub Actions | Low | Deliberately deferred until `template.yaml` stabilises |
| Dependency injection for DB clients | Medium | Needed for unit testability — clients currently instantiated at module level |
| PROC/SERV API Gateway resource policy | Medium | Restrict to AWS account-scoped requests before any public exposure — see Section 12.3 |
| `callback` routing pattern not enforced at compile time | Low | Every PROC endpoint reading callback from SQS must use `req.callback ?? req.body?.callback ?? null`. Currently convention only |
| Terraform state — legacy infrastructure | Low | Terraform config in `terraform-aws/` predates SAM migration. Check for orphaned AWS resources before decommissioning |
| Azure MSAL token utility (`src/lib/getAccessToken.js`) | Low | Vercel-era artifact. Assess for Teams Experience tier or decommission |
| `upsert-workflow.mjs` required on fresh deploys | Low | `init-brain` uses `ON CONFLICT DO NOTHING` — must run `upsert-workflow.mjs <name>` after any workflow step changes. Required after deploying the revised `create_domain` 12-step definition |
| `create_workflow` workflow steps empty | ~~Low~~ | Full step definition added in Section 6.9 — Phase 2 implementation item |
| ~~Tier 1 sub-pass 2b — intent_keywords keyword scan~~ | ~~Low~~ | ✅ Promoted to Phase 2 implementation — now Pass 2 of the redesigned two-pass intent preprocessor (Section 6.3). `matchWorkflowByKeywords()` and `extractSearchTerm()` in `classify-intent-tiers.mjs`. Backlog item 7 (pgvector) supersedes the keyword scan for novel phrasings |
| CRUD ad_hoc_step execution | ~~Medium~~ | ✅ Resolved — `serv_query`, `serv_update`, `serv_delete` step types live in `step-executor.mjs`. `executeCrudStep()` in `classify-intent.mjs` executes ad_hoc steps directly. All four verbs (list, add, update, delete) working. Structured input enforced: `id=<number>` for delete/update, `field=value` pairs for insert/update |
| `design_table` prompt not yet seeded | ~~High~~ | ✅ Resolved — `design_table` v1 in `seed_PGC_Prompt.json`. `create_domain` workflow v5 (13 steps) deployed and end-to-end complete |
| Guard 3 cycle detector — backward reference handling | Medium | Guard 3 must distinguish intentional gate-bounded loops (e.g. step 3c → step 3 in create_domain) from tight computational loops. Rule: a backward reference is safe if the path from target back to source contains at least one `human_gate` step |
| Session layer — PGC_Session + PGC_SessionEntry | Medium | Backlog. Requires `PGC_WorkflowRun.session_id` FK column migration. `mind.mjs` session lookup via `getRows` on `callback.threadId`. Step Processor writes activity entries at `end` steps and `confirm` gate resolutions. `classify-intent.mjs` writes message entries. See Section 4.3.4 and 6.13 |
| `PGC_WorkflowRun.session_id` FK column | Medium | Backlog — add `session_id integer FK → PGC_Session.id nullable` to `PGC_WorkflowRun`. Required by session layer. Migration script needed — column did not exist at bootstrap |
| Alias management workflow `/mind edit aliases for <domain>` | Low | Backlog. Allows users to view and update `PGC_DomainHelp.aliases` from Slack without touching the DB. Until this exists, aliases can be corrected directly via SERV table endpoint. Rule-based singular/plural derivation in Phase 2 item 4a covers the common case |
| Session context window size configurable | Low | `chat_defaults` key in `PGC_SystemContext` should define `session_context_limit` (default 20). Currently hardcoded in classify-intent.mjs spec — externalise when session layer is built |
| Live prompt export back to seed files | Medium | When the right-brain improves a prompt (via `PGC_Prompt.error_log` or manual correction), the improved version lives only in the DB. A fresh brain instance bootstrapped from `seed_PGC_Prompt.json` would revert to the original seed. Fix: `dev_scripts/export-prompts.mjs` reads live `PGC_Prompt` rows and overwrites `seed_PGC_Prompt.json`. Run before creating a new brain instance. Required before the right-brain improvement loop (Backlog item 8) is useful at scale |
| `PGC_SystemContext.step_type_contracts` can become stale | Low | The `step_type_contracts` content in `PGC_SystemContext` is derived from `PGC_StepType` rows at the time `seed_PGC_SystemContext.mjs` runs. When a new step type goes live, re-run `seed_PGC_StepType.mjs` then `seed_PGC_SystemContext.mjs` to update the injected context. This is intentional — the script is the locus of control, not the prompt text |
| Concurrent bootstrap race — `tuple concurrently updated` | ~~High~~ | ✅ Resolved — `bootstrap()` removed from Lambda cold start entirely. Now an explicit install-time HTTP endpoint `POST /api/v1/serv/bootstrap`. `serv/handler.mjs` routes to `bootstrap(req)` in `init-brain.mjs` which returns `ok()`/`err()` directly. All seed functions use `WHERE NOT EXISTS` or `ON CONFLICT DO NOTHING` |
| `PGC_IntentMap.workflow_id` false FK | ~~High~~ | ✅ Resolved — `workflow_id` column dropped from `PGC_IntentMap`. There is no structural relationship between the intent map and workflow table. Routing uses `action_type` + `intent_category` name lookup in `handoff()`. `matchIntentMap` sort uses `action_type` alone |
| Pass 1a `crud` intents returning `domain: null` | ~~High~~ | ✅ Resolved — Pass 1a now resolves domain and builds `ad_hoc_step` for `crud` intent rows. Domain extracted from `intent_category` (strip verb prefix), root table resolved via `PGC_EntitySchema` then `PGC_Schema` fallback, CRUD verb parsed identically to Pass 1c |
| Iterator single-item race condition | ~~High~~ | ✅ Resolved — `executeIteratorItem` completes inline after the last item instead of enqueuing a separate `execute_top` hop. Single-item iterators (step 10b — PGC_EntitySchema) were getting permanently stuck due to SQS concurrent delivery when `current_index` incremented and the completion check message arrived before the DB write was visible. `!item` fallback path retained for SQS redelivery safety |
| `PGC_IntentMap` duplicate rows on cold start | ~~High~~ | ✅ Resolved — `seedPGCIntentMap` uses `WHERE NOT EXISTS ON intent_category`. `ON CONFLICT DO NOTHING` was a no-op (no unique constraint) causing 84+ duplicate rows per table across development sessions. 332 duplicates cleaned |
| `create_domain` intent map rows missing `workflow_id` | ~~Medium~~ | ✅ Resolved — `workflow_id` column removed entirely. Intent rows inserted by `create_domain` step 10 need only `pattern`, `intent_category`, `action_type`. Routing works via `action_type` alone |
| `PGC_WorkflowRun` stuck after single-item iterator | ~~High~~ | ✅ Resolved — inline iterator completion fix (see iterator race condition above). Runs 40 and 41 manually completed |
| ~~`executeTop` does not discard messages for `status: completed`~~ | ~~Medium~~ | ✅ Resolved — `executeTop` now checks `status === 'completed'` immediately after `cancelled` and `failed` guards. Stale SQS `execute_top` messages arriving after a completed run are discarded before the empty stack triggers a new root frame. `v3.2-gap3-add-workflow` |
| `list_recipes` notify shows "Found recipes record(s)" without count | Low | `{{results.length}}` not resolving — LLM generated the template without the token on one run. Right-brain fix — prompt variance. Do not patch the template resolver |
| `generate_crud_workflows` v2 `add_<domain>` thin stub still in PGC_Prompt | Info | v2 row intentionally retained as history. v4 wins at runtime via `ORDER BY version DESC LIMIT 1`. No action needed |
| `add_<domain>` workflows already in DB from v2/v3 are thin stubs | Medium | Existing domains (e.g. recipes) have the old 2-step `add_recipes` workflow in `PGC_Workflow`. Delete and recreate the domain to get the v4 LLM-parse-first workflow. Or manually upsert the corrected step array via `upsert-workflow.mjs`. Required before testing Gap 3 on an existing domain |
| `parse_entity_input` generic prompt — domain-specific refinement | Low | Generic prompt with entity schema injection works for well-named columns. For domains where column semantics are non-obvious, parse quality may degrade. Right-brain fix — `PGC_Prompt.error_log` records parse failures; right brain generates domain-specific refinement from evidence. Deferred to Backlog item 8 |
| `iterator` cannot express multi-step per-item sequences | Medium | Requires `sub_workflow` step type (MVP) or flat loop pattern (Option B). Quiz workflow uses flat loop as workaround. |
| `formatRecordList` renders id-only for tables where the label column is not `name` | Low | `PGC_EntitySchema.entity_name`, `PGC_Workflow.name` etc render as `"N (id: N)"`. Per-table display config or a `display_column` hint in `PGC_TableMap`. Backlog. |
| `delete-domain` was matching `PGC_IntentMap` by `intent_category LIKE %_<domain>` | ~~Medium~~ | ✅ Fixed Session 19 — now matches on `pattern LIKE %<domain>%` (generic *_entity rows carry domain in pattern, not intent_category) |
| `delete-domain` was matching `PGC_EntitySchema` by `root_table IN (tableNames)` | ~~Medium~~ | ✅ Fixed Session 19 — now matches by `domain` column (Option C). Unreliable when tableNames empty after partial delete. |
| `toEntityName()` in `classify-intent.mjs` is now dead code (fallback only) | Low | Option C reads entity_name from `PGC_EntitySchema.domain`. Once all domains are recreated with the domain column populated, `toEntityName()` and its fallback can be removed. |
| `orderBy` hardcoded as `"name"` in `list_entity` step 1 | ~~Medium~~ | ✅ Fixed Session 19 — `orderBy` removed entirely from `list_entity`. Generic list workflow must not assume any column name. |
| `list_entity` routed to body text keyword match (`"list"` inside `"simplista"`) | ~~High~~ | ✅ Fixed Session 20 — `matchWorkflowByKeywords` now uses word-boundary regex (Unicode-aware). False positives from Spanish/accented-word bodies eliminated. Tiebreaker changed to verb-first (earliest keyword position). |
| `design_table` prompt did not support FK on existing tables for parent/grouping concepts | ~~Medium~~ | ✅ Fixed Session 20 — `existing_table_modifications` field added to output schema. LLM returns patches to existing tables when new table is a parent. step 3c applies patches and topologically sorts the table array before re-enriching. |
| FK dependency ordering in table creation iterator | ~~High~~ | ✅ Fixed Session 20 — step 3c expression applies topological sort (Kahn DFS) so FK target tables are always created before tables that reference them. `CREATE TABLE` FK errors eliminated. |
| `PGC_Schema` not updated when `ALTER TABLE` adds a column to a PGC table | Medium | The `domain` column was added to `PGC_EntitySchema` via `ALTER TABLE` in Session 20 but the `PGC_Schema` jsonb `columns` array was not updated. `serv_insert` validation failed with "column not found". Rule: every `ALTER TABLE` on a PGC table must be paired with an `UPDATE PGC_Schema SET columns = columns \|\| '[{"name":...}]' WHERE table_name = '...'`. Bootstrap templates (`PGC_EntitySchema.json`) are the authoritative source for the correct columns array. |
| `orderBy` field in entity queries is not driven by `PGC_EntitySchema` | Low | `serv_entity_query` and `serv_query` accept `orderBy` but workflows hardcode column names. Add optional `display_order_column` to `PGC_EntitySchema` — `list_entity` reads it when present, no ordering when absent. `create_domain` step 6 expression should populate `display_order_column` from the root table's first non-system, non-FK column. |
| Modal button `modal` descriptor dropped by `buildDialog()` in `step-executor.mjs` | ~~High~~ | ✅ Fixed Session 20 — `buildDialog()` buttons mapping now spreads `o.modal` when present. Regression test added to `step-executor.test.mjs`. |
| `transform_type` built-ins not accessible to `create_workflow`-generated workflows | ~~High~~ | ✅ Fixed Session 20 — all built-ins replaced by self-contained `expression` steps. `local_state` added to sandbox. Any expression can now read any workflow state key. |
| `/mind` ACK non-descriptive | ~~Low~~ | ✅ Resolved — ACK now echoes user input truncated to 100 chars. Slack angle-bracket tokens stripped |
| `matchDomainAlias` did not match domain name itself | ~~Medium~~ | ✅ Resolved — domain name checked as implicit alias before scanning aliases array |
| CRUD verb ambiguity not enforced uniformly | ~~Medium~~ | ✅ Resolved — insert requires `field=value` pairs, update requires `id=<number>` + `field=value`, delete requires `id=<number>`. Ambiguous requests return instructive errors listing available fields |
| `delete-domain.mjs` missing `PGC_Workflow` + `PGC_IntentMap` cleanup | Medium | When a domain is deleted, its 4 CRUD workflows in `PGC_Workflow` and 4 rows in `PGC_IntentMap` are not removed. Fix: query workflow IDs by `domain`, delete `PGC_IntentMap` rows where `workflow_id IN [ids]`, then delete `PGC_Workflow` rows. Requires `allow_delete: true` on both tables in `seed_PGC_TableMap.json` |
| `output_key` on non-`text_input` gates is misleading | Low | `review_object` and `confirm` gates do not write to `local_state[output_key]` on confirm — only `text_input` does. Should either throw a warning or be documented as invalid. Step definitions using `output_key` on confirm/review_object gates produce `undefined` in downstream steps |
| `init-brain.mjs` contains shared DDL utilities used by `schema.mjs` | Medium | `buildCreateTableSQL` and `getClient` are imported by `schema.mjs` directly from `init-brain.mjs`, coupling the bootstrap module to runtime DDL execution. Refactor: extract to `src/shared/serv-utils.mjs`. `init-brain.mjs` and `schema.mjs` both import from shared location |
| `generate_crud_workflows` v2 `input_variables` stale | Low | Seed row still lists `domain_help` as a required input variable, and prompt text has a `{{domain_help}}` reference in the rules section. `create_domain` step 6 no longer passes `domain_help`. Unresolved template renders as empty string — not breaking but should be cleaned up |
| `output_key` on `review_object` gate should warn if set | Low | See `output_key on non-text_input gates` item above. The specific case in `create_domain` v4 has been fixed (step 7 `output_key` removed, step 8 reads `generated.domainHelp` directly), but the executor itself has no guard |
| CHECK constraint `output_schema` validation | Low | `create_domain` `output_schema` does not require `expression` on check constraints and does not reject `columns` arrays on them. LLM produced `columns: ["quantity"]` instead of `expression: "quantity > 0"` — passed Ajv but failed DDL. Tighten schema to require `expression` and disallow `columns` on check type |
| ~~`on_failure: "human_feedback"` not implemented~~ | ~~High~~ | ✅ Resolved — `executeTop` and `executeIteratorItem` catch blocks in `run-workflow.mjs` now check `step.on_failure === "human_feedback"` before marking the run failed. When matched, `pushRecoveryGate()` pushes a `human_gate` frame with Retry / Skip / Cancel options using the existing gate machinery — no new step type, no schema change. `v3.2-create-workflow-complete` |
| ~~`PGC_StepType` rows not seeded with routing value contracts~~ | ~~High~~ | ✅ Resolved — `dev_scripts/seed_PGC_StepType.mjs` seeds one row per live step type (12 total) with `on_success_options`, `on_failure_options`, `input_contract`, `output_contract`, `description`, and `status`. `ON CONFLICT (step_type) DO UPDATE` — safe to re-run when new step types go live. `dev_scripts/seed_PGC_SystemContext.mjs` reads live rows and writes `step_type_contracts` to `PGC_SystemContext` for prompt injection. `v3.2-create-workflow-complete` |
| ~~Unknown routing values silently become `"next"`~~ | ~~Medium~~ | ✅ Resolved — `runRoutingValueRules()` added to `review-output.mjs` as Pass 2b. Runs when LLM output contains a `steps` array (workflow generation prompts only — does not run on `create_domain` output). Validates every `on_success`, `on_failure`, `on_complete`, and `on_select` value against the known routing token set (`next`, `end`, `cancel`, `human_feedback`, `step:<key>`). Also validates that every `step:N` target exists as a step key in the array, and that every `human_gate` has a cancel option. Returns errors in the same shape as `runSemanticRules()` — the correction loop handles them identically. `v3.2-create-workflow-complete` |

---

## 7a. Dependency Policy

Every npm dependency added to this project must be evaluated against the following
criteria before merging. A one-line registry entry is required in the table below.

### Evaluation criteria

**1. Download volume** — npm weekly downloads. Floor: 1M+/week for production use.

**2. Maintenance cadence** — last publish date and open GitHub issues.
No commits in 2+ years or unresolved security issues is a blocking concern.

**3. Single-purpose** — prefer libraries that do one thing well.

**4. Dependency footprint** — run `npm ls <package>` before installing.
Reject if >20 transitive deps without compelling justification.

**5. License** — must be MIT, Apache 2.0, or BSD.

**6. Security record** — run `npm audit` after install.
Any high/critical CVE blocks the addition unless a patch is available and pinned.

### What to avoid for this project

- **ORMs** (Prisma, Sequelize, TypeORM) — SERV is the DB abstraction layer.
- **HTTP frameworks** (Express, Fastify, Hapi) — API Gateway + `parseEvent` already handles routing.
- **Duplicate validators** (Zod, Yup) — `ajv` is the chosen validator. One is enough.
- **Any package with >20 transitive deps** without documented justification.

### Approved dependency registry

| Package | Version | Weekly DL | License | Purpose | Added |
|---|---|---|---|---|---|
| `pg` | ^8 | ~3M | MIT | PostgreSQL client — PGC + PGD connections in ServFunction | bootstrap |
| `@aws-sdk/client-sqs` | ^3 | ~5M | Apache-2.0 | SQS SendMessage — WorkflowQueue + SlackResultsQueue | bootstrap |
| `@aws-sdk/client-ssm` | ^3 | ~5M | Apache-2.0 | SSM GetParameter — reads SecureString API keys (OpenAI, Slack signing, etc.) in `embed-client.mjs` | Session 26 |
| `@slack/web-api` | ^7 | ~1M | MIT | Slack API — chat.postMessage, chat.update, Block Kit | bootstrap |
| `ajv` | ^8 | ~100M | MIT | JSON Schema validation — right-brain output validation loop | v3.2-design-domain-foundation |
| `acorn` | ^8 | ~50M | MIT | AST parser for `js_transform` sandbox gate — see Section 6.5.1 | Session 19 |

### Candidates approved for future addition

| Package | Weekly DL | License | Purpose | When |
| `ajv-formats` | ~20M | MIT | Adds `date-time`, `uuid` format validators to Ajv | When output schemas use format keywords |

---

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
| `v3.2-architecture-semantic-validation` | Semantic validation rules documented in Section 6.10. Tech debt entry added |
| `v3.2-design-domain-foundation` | shared/llm-client + shared/serv-client extracted. proc/review-output (Ajv + semantic rules). proc/design-domain first pass (LLM + validation + WorkflowRun lifecycle). openapi.yaml v3.3.4 |
| `v3.2-design-domain-e2e` | callback routing fix (req.callback not req.body.callback). callback.mjs DESIGN_DOMAIN_RESULT + DESIGN_DOMAIN_ERROR handlers. Full Slack flow confirmed end-to-end |
| `v3.2-refactor-complete` | Phase 1 refactoring closed out. All pings passing. v3.2-clean-baseline re-tagged |
| `v3.2-design-domain-gate-complete` | proc/design-domain Block Kit review gate + in-place remove. human_gate suspend/resume wired |
| `v3.2-step-processor-complete` | Step Processor fully operational: run-workflow.mjs, step-executor.mjs, template-resolver.mjs. First successful create_domain end-to-end (WorkflowRun 12 — PGD_Recipes, PGD_Ingredients, PGD_RecipeTags). help workflow through Step Processor |
| `v3.2-tangential-features` | /create-domain + /help fully wired to Step Processor. proc/create-domain.mjs as Step Processor entry point. dev_scripts/upsert-workflow.mjs. seed_PGC_Workflow.json: create_domain v2 (8 steps) + help (3 steps) + create_workflow stub |
| `v3.2-intent-preprocessor-complete` | Intent Preprocessor fully operational end-to-end. mind.mjs + classify-intent.mjs + classify-intent-tiers.mjs. Three-tier pipeline verified: Pass 1a (exact), Pass 1b+1c (alias+CRUD with PGC_Schema fallback), Tier 2 (sonar via LLM_CHAT_URL, prompt from PGC_Prompt). Tier 3 routes to CREATE_DOMAIN / CREATE_WORKFLOW / HUMAN_NOTIFICATION. /mind and /m verified in Slack. openapi.yaml v3.3.5. seed_PGC_Prompt.json: classify_intent_tier2 row added. callback.mjs: runId suppressed when absent. Architecture session 7: WorkflowQueue two-category framing, PGC_Session + PGC_SessionEntry design, intent tuning surface, session architecture Section 6.13 |
| `v3.2-crud-adhoc-complete` | Ad_hoc CRUD execution from /mind fully operational. serv_query/update/delete step types live in step-executor.mjs. deleteRows wrapper in serv-client.mjs. executeCrudStep() in classify-intent.mjs executes ad_hoc steps directly for all four verbs. Structured input enforcement: id=N for delete/update, field=value for insert/update. Ambiguity errors with table field listing. Domain name as implicit alias in matchDomainAlias. matchCrudVerb returns ambiguous with reason for insert/update/delete. /mind ACK echoes truncated user input. init-brain concurrent cold-start race fixed (DO NOTHING). Code review fixes: cancelled status check, dynamic imports eliminated, callLlm user-turn resolved generically. Architecture session 9 |
| `v3.2-create-domain-with-crud` | First complete `create_domain` end-to-end: LLM schema design, 5 human gates, 4 PGD tables created, CRUD workflows + IntentMap registered, domain immediately usable from /mind. Guard 1 stuck-step detection proven. CHECK constraint expression guard in `buildCreateTableSQL`. `status=failed` check in `executeTop` stops SQS retry storm. `response_format` removed from Perplexity Agent API calls. Architecture sessions 9–10 |
| `v3.2-create-workflow-complete` | `create_workflow` workflow fully implemented. `on_failure: "human_feedback"` live in `run-workflow.mjs` (`pushRecoveryGate()` in both catch blocks). `simulate` step type live in `step-executor.mjs` (Level 1 static analysis, Level 2 path execution, Level 3 skip-path analysis). Pass 2b routing value rules in `review-output.mjs`. `seed_PGC_StepType.mjs` + `seed_PGC_SystemContext.mjs` new dev scripts. Four new prompts in `seed_PGC_Prompt.json`. `create_workflow` v2 (12 steps) in `seed_PGC_Workflow.json`. `seedPGCPrompt` extended to write `output_schema` + `input_variables`. Architecture session 11 |
| `v3.2-create-domain-complete-w-help` | Gap 4 (entity schema registration) + Gap 1 (interactive help) + structural refactoring. `create_domain` v5 (17 steps) — step 10b inserts `PGC_EntitySchema` rows via iterator. `generate_crud_workflows` v3 prompt produces `entitySchemas` array with joins + aggregations matching `buildSelectSQL()` in `entity.mjs`. `help` workflow v2 — 6-step interactive: `serv_query` PGC_DomainHelp → `buildHelpOptions` → dynamic `confirm` gate (one button per domain) → `resolveHelpContent` → `confirm` gate showing content. `delete-domain.mjs` cleans `PGC_Workflow` + `PGC_IntentMap` + `PGC_EntitySchema` + `PGC_DomainHelp`. `PGC_IntentMap.workflow_id` column dropped — no FK relationship exists between intent map and workflow table. `handoff()` looks up `PGC_Workflow` by `workflow_name` at dispatch time. `matchIntentMap` sort uses `action_type` alone (not `workflow_id`). `seedPGCIntentMap` uses `WHERE NOT EXISTS ON intent_category`. `executeIteratorItem` self-completes inline on last item — eliminates SQS message loss race on single-item iterators. `bootstrap()` moved from Lambda cold start to explicit `POST /api/v1/serv/bootstrap` HTTP endpoint — resolves concurrent-update race condition. Pass 1a now resolves domain + builds `ad_hoc_step` for `crud` intent rows — two coexisting CRUD paths: table-level (Pass 1a crud) and domain-level (workflow). Sessions 12–14 |
| `v3.2-gap3-add-workflow` | Gap 3 (rich multi-table ingestion) + Priority 2 (executeTop completed guard). `parse_entity_input` v1 — generic entity parser prompt: receives `{ userInput, entity_schema }` from `PGC_EntitySchema`, returns `{ root, children }`. `generate_crud_workflows` v4 — `add_<domain>` workflow is now 7-step LLM-parse-first: serv_query entity schema → llm_call parse_entity_input → review_object gate → serv_insert root row → iterator per child table → notify → end. All four IntentMap rows stay `action_type: workflow` — Tier 2 sonar routes free-text add intent without user keyword obligation. `run-workflow.mjs`: `executeTop` discards stale SQS messages when `run.status === 'completed'`. Session 15 |
| `v3.2-generic-crud-complete` | Session 17 — generic CRUD workflows replace domain-specific ones. Five universal `*_entity` workflows (`domain: null`) replace all domain-generated CRUD workflows. `create_domain` step 9 now inserts five `PGC_IntentMap` rows with `*_entity` categories directly. `generate_crud_workflows` prompt v9 — `intentMapRows.intent_category` Ajv-enforced enum prevents LLM drift. `buildChildInserts` js_transform built-in for child table insertion. `execution_mode: sequential` inline iterator eliminates Lambda recursive loop detection. Recipes domain operational with full child data (ingredients, steps) |
| `v3.2-intent-preprocessor-phase-b-complete` | Session 18 — Phase B pre-pass + unit tests. `classify-intent-tiers.mjs`: UC 1.1 fix (`domain: null` universal keyword candidates); `hasTablePrefix`, `extractTableName`, `hasCrudVerb`, `matchCrudVerb` for Groups 3–4. `classify-intent.mjs`: pre-pass before Pass 1 for `PGC_*/PGD_*` inputs; `hasCrudVerb` short-circuit after Pass 2 domain miss; `executeCrudStep` + `formatTableCrudResult` for direct table dispatch; full `crud_ambiguous` instructive error messages. `tests/unit/classify-intent-tiers.test.mjs`: 50 tests, 50 passing. Three fixture files |
| `v3.2-js-transform-sandbox-serv-entity-schema` | Session 19 — `condition` step type (expression eval, on_truthy/on_falsy). `get_entity` id-branch via `condition`. `js_transform` generic expression sandbox (acorn AST gate + `vm.runInNewContext`). `serv_entity_schema` step type. Intent fixes: Pass 1 domain derivation, `update_entity` missing fields guard, UC 1.4 `record_id` threading. Slack block 3000-char chunking. `serv_entity_get` not-found graceful handling. `extractSearchTerm` field=value prefix stripping. `seed_PGC_StepType.mjs` updated with `serv_entity_query`, `serv_entity_get`, `serv_entity_schema`. |
| `v3.2-option-c-domain-registration` | Session 20 — deterministic domain registration |
| `v3.2-local-state-sandbox-builtins-removed` | Session 21 — `local_state` added to `js_transform` sandbox; all five `transform_type` built-ins replaced by self-contained expressions in seed workflows; generic modal trigger for `add_table` (word-boundary keyword matching, verb-first tiebreaker); `existing_table_modifications` in `design_table` prompt v2; topological table sort in `create_domain` step 3c; `PGC_Schema` migration discipline; `list_entity` `orderBy` removed |: `create_domain` step 6 replaced `generate_crud_workflows` LLM call with `js_transform` expression (entity name, aliases, intent map rows, entity schemas derived from scaffold — no LLM, no variance). Option C: `PGC_EntitySchema.domain` column added; `classify-intent.mjs` reads entity name from DB instead of deriving it (`toEntityName()` kept as fallback). `delete-domain.mjs`: `PGC_EntitySchema` filter changed from `root_table IN` to `domain =`; `PGC_IntentMap` filter changed from `intent_category LIKE %_<domain>` to `pattern LIKE %<domain>%`. `text_input` human gates fixed: `interactive.mjs` opens Slack modal via `views.open` on `add_table` click; `handleViewSubmission()` handles `view_submission` payloads; `callback.mjs` skips posting for `text_input` gate type. Backlog audit: all Phase 3 references reclassified as Backlog or MVP per Javear use cases. |
| `v3.2-troubleshoot-fix-workflow-complete` | Session 22 — Tier 1 reactive self-repair loop. `troubleshoot-workflow.mjs` PROC module: loads steps from `PGC_Workflow`, Level 1 static analysis, formats TroubleshootWorkflowResponse, `autoFix` path enqueues `FIX_WORKFLOW`. `fix-workflow.mjs` PROC module: LLM corrects failing steps, single human gate before `PGC_Workflow` write, cancels broken runs, posts "fixed — retry" Slack reply. Neither uses PGC_WorkflowRun lifecycle — PROC module pattern is correct fit for single-gate operations. `TROUBLESHOOT_WORKFLOW` + `FIX_WORKFLOW` SQS message types added to WorkflowQueue. Architecture Section 6.12 Tier 1. |
| `v3.2-response-format-max-tokens` | Session 23 — `response_format: { type: "json_schema" }` restored on Perplexity Agent API calls via `callLlm`. `max_output_tokens` per-prompt ceiling forwarded through `callLlm` and `callLlmWithCorrection`. `PGC_Prompt.max_output_tokens` column added. `diagnose-prompt-schema.mjs` Tier 1b first implementation: R1–R6 rules, ephemeral WorkflowRun, human gate. `diagnose_prompt_schema` system workflow seeded. `DIAGNOSE_PROMPT_SCHEMA` SQS message type. `run-workflow.mjs` discriminates HTTP 400 → `DIAGNOSE_PROMPT_SCHEMA` vs other errors → `TROUBLESHOOT_WORKFLOW`. |
| `v3.2-session24-complete` | Session 24 — iterator gate resume fix: `resume_gate` correctly resumes iterator frames. `diagnose_prompt_schema` R1–R6 validated end-to-end. Repair loop guard prevents repeated repair attempts on the same `PGC_Prompt` row. `create_workflow` routing fixes: dead `step:N` targets detected by Level 1 analysis. pgvector promoted from Backlog to Active (Section 10). Architecture Section 6.12 updated with full Tier 1a/1b/1c/2/3 taxonomy. |
| `v3.2-session25-complete` | Session 25 — `llm-client.mjs`: `isSonar` guard — `response_format` only forwarded when model contains "sonar"; non-sonar models return HTTP 400 with it present. Fence extraction regex strips leading/trailing prose around fenced JSON. `step-executor.mjs`: `"false"` added to `executeCondition` falsy set; fixes `diagnose_prompt_schema` step 8 routing. `diagnose_prompt_schema` v3→v4: R7 rule (unsupported model names), step 10 patches `model` field, step 12 actionable guidance. `diagnose-prompt-schema.mjs`: `model` added to `repair_state`. `schema.mjs` + `openapi.yaml`: `POST /serv/schema/addColumn` with `schemaOnly: true` mode for metadata-only sync. `PGC_Prompt`: `probe_input jsonb` + `max_output_tokens integer` columns. `seed_PGC_Prompt.json`: 12 entries (one per intent_category), `probe_input` + `max_output_tokens` on all, `analyze_and_design_workflow` v10 constrains `prompts_needed.model`. `upsert-prompt.mjs` writes `probe_input` + `max_output_tokens`. `tests/integration/llm-prompt-schema.test.mjs`: one `it()` per prompt, `probe_input` substitution, HTTP 400 hard fail. |

---

## 9. Build Order — Remaining Work

~~1. Callback abstraction~~              ✅ complete — v3.2-callback-abstraction-complete
~~2. PGC workflow table templates~~      ✅ complete — v3.2-pgc-workflow-tables-complete
~~3. PROC — /create-domain (Phase 2b)~~ ✅ complete — v3.2-create-domain-scaffold
~~4. PROC — /create-domain (Phase 2c)~~ ✅ complete — v3.2-create-domain-live-llm
~~5. SERV-Table (getRows + insertRow)~~  ✅ complete — v3.2-serv-table-partial
~~6. PGC schema v2 — 13 tables + seeds~~ ✅ complete — v3.2-pgc-schema-v2-complete

### Phase 1 — Refactoring (complete)

All Phase 1 refactoring complete as of `v3.2-clean-baseline`. See Section 13.

### Phase 2 — New Features

| # | Task | Status |
|---|---|---|
| 1 | Slack /interactive endpoint + Slack signing verification (Section 12.2) | ✅ complete — v3.2-interactive-complete |
| 1a | /help command — interactive loop proof + permanent intent pipeline foundation | ✅ complete — v3.2-interactive-complete |
| 2 | /shutdown Slack command — emergency stop, ProcFunction + SlackbotFunction | ✅ complete — v3.2-shutdown-complete |
| 2a | SERV-Table updateRows + deleteRows | ✅ complete — v3.2-serv-table-complete |
| 2b | SERV-Entity — six routes, PGC_EntitySchema upsert_key | ✅ complete — v3.2-serv-entity-complete |
| 3a | shared/llm-client + shared/serv-client + proc/review-output (Ajv + semantic rules) + proc/design-domain foundation | ✅ complete — v3.2-design-domain-e2e |
| 3b | proc/design-domain — Block Kit review message, in-place table remove, human gate pause | ✅ complete — v3.2-step-processor-complete |
| 3c | proc/create-domain — Step Processor entry point, full WorkflowRun lifecycle | ✅ complete — v3.2-step-processor-complete |
| 4 | PROC — Intent Preprocessor | ✅ complete — v3.2-intent-preprocessor-complete |
| | — `src/ui/slackbot/mind.mjs` — /mind Slack command, ACK + CLASSIFY_INTENT enqueue | ✅ |
| | — `src/proc/classify-intent.mjs` + `classify-intent-tiers.mjs` — three-tier pipeline | ✅ |
| | — Tier 1: Pass 1a (PGC_IntentMap regex), Pass 1b (PGC_DomainHelp alias + domain name), Pass 1c (CRUD verb) | ✅ |
| | — Tier 2: perplexity/sonar via LLM_CHAT_URL, domain hint injection, prompt loaded from PGC_Prompt | ✅ |
| | — Tier 3: enqueue CREATE_DOMAIN / CREATE_WORKFLOW, HUMAN_NOTIFICATION for unknowns | ✅ |
| | — openapi.yaml v3.3.5: /ui/slack/mind and /proc/classify-intent | ✅ |
| | — Pass 1c PGC_Schema fallback when PGC_EntitySchema not populated | ✅ |
| | — /m alias wired to /mind in Slack app | ✅ |
| 4 | PROC — Ad_hoc CRUD execution | ✅ complete — v3.2-crud-adhoc-complete |
| | — serv_query, serv_update, serv_delete step types in step-executor.mjs | ✅ |
| | — deleteRows convenience wrapper in serv-client.mjs | ✅ |
| | — executeCrudStep() in classify-intent.mjs — all four verbs live | ✅ |
| | — Structured input enforcement: id=N, field=value, ambiguity errors with field listing | ✅ |
| | — matchDomainAlias matches domain name as implicit alias | ✅ |
| | — init-brain concurrent cold-start race fixed | ✅ |
| | — /mind ACK echoes user input | ✅ |
| 4a | create_domain workflow revision | ✅ complete — v3.2-local-state-sandbox-builtins-removed (Session 21: modal, existing_table_modifications, topological sort) |
| | — callback.mjs: text_input and review_object gate types in dialogToBlocks() | ✅ |
| | — seed_PGC_Prompt.json: design_table v1, create_domain v3, generate_crud_workflows v2 | ✅ |
| | — seed_PGC_Workflow.json: create_domain v5 (13 steps incl. 3a/3b/3c/3d branch + step 3d review_object) | ✅ |
| | — step-executor.mjs: columnSummary js_transform enriches domain field on table objects | ✅ |
| | — run-workflow.mjs: Guard 1 stuck-step detection, step_key idempotency, iterator error Slack notify | ✅ |
| | — init-brain.mjs: CHECK constraint expression guard, FK column undefined guard | ✅ |
| | — llm-client.mjs: response_format removed (Perplexity Agent API does not support json_schema) | ✅ |
| | — First complete create_domain end-to-end: 4 PGD tables + 4 CRUD workflows + 4 IntentMap rows | ✅ |
| 4b | create_workflow workflow full implementation | ✅ complete — v3.2-create-workflow-complete |
| | — `run-workflow.mjs`: `on_failure: "human_feedback"` — `pushRecoveryGate()` in both catch blocks | ✅ |
| | — `step-executor.mjs`: `simulate` step type — Level 1 static analysis, Level 2 path execution, Level 3 skip-path analysis | ✅ |
| | — `review-output.mjs`: Pass 2b `runRoutingValueRules()` — routing token validation on steps arrays | ✅ |
| | — `dev_scripts/seed_PGC_StepType.mjs`: 12 live step types seeded with routing value contracts | ✅ |
| | — `dev_scripts/seed_PGC_SystemContext.mjs`: `step_type_contracts`, `routing_value_rules`, `create_domain_example` rows seeded | ✅ |
| | — `seed_PGC_Prompt.json`: `classify_workflow_intent` v1, `generate_workflow_steps` v1, `generate_workflow_mocks` v1, `generate_workflow_paths` v1 | ✅ |
| | — `seed_PGC_Workflow.json`: `create_workflow` v2 — full 12-step definition replacing stub | ✅ |
| | — `init-brain.mjs`: `seedPGCPrompt` extended to write `output_schema` and `input_variables` columns | ✅ |
| 4c | `/mind edit aliases for <domain>` — alias management workflow | ⬜ |
| | — Allows users to view and update PGC_DomainHelp.aliases from Slack | ⬜ |
| | — Until live: aliases updated directly via SERV table endpoint | ⬜ |
| Gap 1 | Interactive `/help` workflow | ✅ complete — v3.2-create-domain-complete-w-help |
| | — `help` workflow v2: 6-step interactive — serv_query PGC_DomainHelp → buildHelpOptions → dynamic confirm gate → resolveHelpContent → confirm gate showing content | ✅ |
| | — `js_transform` built-ins: `buildHelpOptions`, `resolveHelpContent` in `step-executor.mjs` | ✅ |
| | — Dynamic `confirm` gate: when `context_key` present, buttons built from array at runtime | ✅ |
| | — `interactive.mjs`: `selectedValue` extracted from radio/static_select state values | ✅ |
| | — `run-workflow.mjs`: dynamic confirm gate writes `userResponse` to `local_state[output_key]` on no matched option | ✅ |
| | — `/help` slash command wired in Slack app pointing to `/api/v1/ui/slack/help` | ✅ |
| Gap 3 | Rich multi-table ingestion via LLM-parse-first `add_<domain>` workflow | ✅ complete — v3.2-gap3-add-workflow |
| | — `parse_entity_input` v1 prompt: generic entity parser receives `{ userInput, entity_schema }` (from `PGC_EntitySchema`), returns `{ root, children }` — root fields for the root table, children keyed by aggregation `outputKey` for child tables | ✅ |
| | — `generate_crud_workflows` bumped to v4: `add_<domain>` is now a 7-step LLM-parse-first workflow — serv_query PGC_EntitySchema → llm_call parse_entity_input → review_object gate → serv_insert root row → iterator per child table → notify → end | ✅ |
| | — All four `PGC_IntentMap` rows stay `action_type: workflow` — Tier 2 sonar routes free-text add intent to `add_<domain>` workflow; no user keyword required | ✅ |
| | — `run-workflow.mjs`: `executeTop` discards stale SQS messages when `run.status === 'completed'` | ✅ |
| | — Domain-specific parse prompt refinement deferred to Backlog right-brain loop | ⬜ Backlog |
| Gap 4 | PGC_EntitySchema population at domain creation | ✅ complete — v3.2-create-domain-complete-w-help |
| | — `generate_crud_workflows` v3 produces `entitySchemas` array alongside domainHelp, workflows, intentMapRows | ✅ |
| | — `create_domain` v5 step 10b: iterator over `generated.entitySchemas` → `serv_insert PGC_EntitySchema` | ✅ |
| | — Entity schema shape matches `buildSelectSQL()` in `entity.mjs` exactly: joins[].{type,table,alias,on}, aggregations[].{alias,columns,outputKey} | ✅ |
| 5 | PROC — Step Processor — SQS-driven stack execution, full PGC_WorkflowRun lifecycle | ✅ complete — v3.2-step-processor-complete |
| | — `run-workflow.mjs`, `step-executor.mjs`, `template-resolver.mjs` | ✅ |
| | — velocity detector, execution accumulator, cycle detector (Section 6.10) | ⬜ deferred — see tech debt register |
| | — Step Processor checks PGC_WorkflowRun.status before executing (shutdown contract) | ✅ |
| 6 | Tier 1 reactive self-repair — troubleshoot + fix workflow | ✅ complete — v3.2-troubleshoot-fix-workflow-complete |
| | — `troubleshoot-workflow.mjs` + `fix-workflow.mjs` PROC modules (no WorkflowRun lifecycle) | ✅ |
| | — `on_failure: "human_feedback"` + `pushRecoveryGate()` in `run-workflow.mjs` | ✅ |
| | — `TROUBLESHOOT_WORKFLOW` + `FIX_WORKFLOW` SQS message types | ✅ |
| 7 | Tier 1b prompt schema repair — `diagnose-prompt-schema.mjs` | ✅ complete — v3.2-response-format-max-tokens / v3.2-session25-complete |
| | — R1–R7 deterministic compatibility rules | ✅ |
| | — `DIAGNOSE_PROMPT_SCHEMA` SQS type; `run-workflow.mjs` discriminates HTTP 400 | ✅ |
| | — `PGC_Prompt.probe_input` + `max_output_tokens` columns | ✅ |
| | — `POST /serv/schema/addColumn` with `schemaOnly` mode | ✅ |
| | — Integration test: one `it()` per prompt with `probe_input` substitution | ✅ |
| 8 | pgvector — semantic domain resolution | ⬜ Session 26 — see Section 10 |
| | — Enable pgvector extension on RDS | ⬜ |
| | — `embedding vector(1536)` column on `PGC_DomainHelp` via addColumn endpoint | ⬜ |
| | — `vector` added to `ALLOWED_TYPES` in `schema.mjs` | ⬜ |
| | — `src/shared/embed-client.mjs` — OpenAI text-embedding-3-small | ⬜ |
| | — `dev_scripts/backfill-embeddings.mjs` — backfill existing PGC_DomainHelp rows | ⬜ |
| | — `classify-intent-tiers.mjs` — `semanticDomainMatch()` replaces alias fallback | ⬜ |
| | — `create_domain` workflow — embedding step after DomainHelp insert | ⬜ |

**Step types — implemented vs deferred:**

| Type | Status | Notes |
|---|---|---|
| `llm_call` | ✅ live | Loads prompt from `PGC_Prompt`, calls LLM, runs `review-output` validation |
| `js_transform` | ✅ live (built-ins + generic expression sandbox) | Built-ins: `columnSummary`, `buildHelpOptions`, `resolveHelpContent`, `formatRecordList`, `buildChildInserts`. Generic `expression` sandbox via acorn AST gate + `vm.runInNewContext`. See Section 6.5.1 |
| `human_gate` | ✅ live | `confirm` + `edit_list` proven end-to-end |
| `serv_schema` | ✅ live | `createTable` via SERV |
| `serv_insert` | ✅ live | `insertRow` via SERV |
| `notify` | ✅ live | Resolves `message_template`, enqueues `HUMAN_NOTIFICATION` |
| `end` | ✅ live | Marks run completed |
| `iterator` | ✅ live | Sequential only — one SQS hop per item |
| `serv_query` | ✅ live | Resolves template vars in filters/orderBy/limit, writes rows array to output_key |
| `serv_entity_query` | ✅ live | Calls SERV-Entity listEntities — assembled entity array with child arrays at output_key |
| `serv_entity_get` | ✅ live | Calls SERV-Entity getEntity by id — single assembled entity at output_key |
| `serv_update` | ✅ live | Generic filter + updates shape, full template resolution, enforces non-empty filters |
| `serv_delete` | ✅ live | Generic filter shape, full template resolution, enforces non-empty filters |
| `simulate` | ✅ live | Level 1 static analysis + Level 2 path execution + Level 3 skip-path analysis (advisory). Used by `create_workflow` steps 4 and 7 |
| `sub_workflow` | ⬜ MVP | Required for multi-step iterator items (quiz workflow). Option B flat loop is workaround |
| `condition` | ✅ live | Session 19 — expression evaluation, on_truthy/on_falsy routing |
| `capability_call` | ⬜ Backlog | Not yet defined — see Section 15.1 |

**Gate types — implemented in `dialogToBlocks()` vs deferred:**

| Gate type | Status |
|---|---|
| `confirm` | ✅ live — static options array or dynamic buttons from `context_key` (runtime array) |
| `edit_list` | ✅ live — per-row Remove button, in-place `chat.update` re-render, Add table branch (Phase 2 item 4a) |
| `text_input` | ✅ live — add-table branch step 3a, value written to local_state[output_key] |
| `review_object` | ✅ live — domain help confirmation step 7, column detail review step 3d |
| `choice` | ✅ live — Session 23. Preference gate iterator in `create_workflow` step 5. Typography heading + description list + lettered buttons. HTML radio semantics: `value` submitted and written to `output_key` |
| `select_one` | ⬜ Backlog — `buildDialog()` stub exists; limited to flat entity lists via `context_key`. Use `choice` for options with descriptions |
| `select_many` | ⬜ Backlog — `buildDialog()` stub exists |

### Backlog — Deferred

| # | Task |
|---|---|
| 1 | SERV-Query — cross-entity parameterised SELECT with pagination |
| 1a | `serv_aggregate` step type — GROUP BY + aggregation at DB level. Required for UC-E4 (budget report), UC-S4 (portfolio by sector), UC-S5. Alternative to `llm_call` for arithmetic | MVP |
| 2 | ~~Generic `js_transform` sandbox~~ | ✅ Implemented Session 19 — see Section 6.5.1 |
| ~~3~~ | ~~`serv_query`, `serv_update`, `serv_delete` step types~~ ✅ live — v3.2-crud-adhoc-complete |
| 4 | `sub_workflow` and `condition` step types |
| 5 | `capability_call` step type + External API Registry (Section 15.1) |
| 6 | Remaining gate types: `select_one`, `select_many` |
| 7 | pgvector semantic search — Pass 2 Backlog extension (Section 10). After `intent_keywords` keyword scan miss and before Tier 2 sonar: embed input, cosine-similarity query against `PGC_Workflow.intent_embedding` filtered by resolved domain. Supersedes keyword scan for novel phrasings. Also used for `/help` semantic domain search and prompt deduplication. `intent_embedding` column already on `PGC_Workflow` — no schema change. Does not block any Phase 2 feature |
| 7a | Populate `PGC_Workflow.intent_embedding` at domain creation time — add embedding generation step to `create_domain` workflow and `generate_crud_workflows` prompt. Required prerequisite for item 7 |
| 7b | Alias management workflow `/mind edit aliases for <domain>` — update PGC_DomainHelp.aliases from Slack. Until live, rule-based singular/plural derivation from Phase 2 item 4a covers the common case |
| 8 | Right brain — workflow improvement loop using `PGC_WorkflowStats` + `PGC_Prompt.error_log` |
| 8a | Session layer — PGC_Session + PGC_SessionEntry tables + bootstrap migration (Section 4.3.4) |
| 8b | mind.mjs session lookup — getRows by callback.threadId before CLASSIFY_INTENT enqueue |
| 8c | classify-intent.mjs session context injection — Tier 1c domain fallback + Tier 2 prompt injection + message entries |
| 8d | Step Processor session writes — activity entries at end steps and confirm gate resolutions |
| 8e | PGC_WorkflowRun.session_id FK column migration — nullable, set by classify-intent on SQS path |
| 8f | Right-brain improvement loop reads PGC_SessionEntry — pattern detection across sessions to drive alias and prompt improvements |
| 9 | `create_domain` add-table → `sub_workflow` migration — replace Option B (text_input gate + LLM inline) with Option C (reusable `design_table` sub-workflow) |
| 10 | Parallel execution — fan-out/fan-in, optimistic locking |
| 11 | Unit + integration tests — node:test, testcontainers |
| 12 | CI/CD — GitHub Actions / SAM pipeline / CodePipeline (after template.yaml stabilises) |

## 10. pgvector — Semantic Search

Extension: pgvector (available on RDS PostgreSQL 15+, no extra cost)
Enable: `CREATE EXTENSION IF NOT EXISTS vector;`

Embedding model: `pplx-embed-v1-4b` (Perplexity), 2560 dimensions, INT8 quantization
Cost: $0.03/million tokens — at household scale ~$0.01/month at heavy use
Used in: `PGC_DomainHelp` (domain resolution), `PGC_Workflow` (workflow routing — Backlog)

**Implemented — Session 26.**

The alias-based domain resolution in `matchDomainAlias` is a structural weakness confirmed
across multiple sessions. "Spanish flashcard quiz", "flashcard quiz", "quiz my Spanish" all
fail to resolve `spanish_flashcards` because the alias list cannot anticipate every user
phrasing. Every new domain will have the same problem. This is not a data maintenance problem
— it is a wrong architectural primitive. pgvector replaces it.

### Two problems pgvector solves

**Problem 1 — domain resolution (Pass 2 of Intent Preprocessor)**
`matchDomainAlias` does substring token matching against `PGC_DomainHelp.aliases`.
Any paraphrase not anticipated at domain-creation time silently returns `domain: null`,
causing `domain_schema: []` to be sent to the LLM which then invents tables that already exist.

Fix: `semanticDomainMatch()` in `classify-intent.mjs` — sends `queryText` to SERV
`getRows` with a `vectorSearch` descriptor. SERV embeds the query and ranks domains
by cosine similarity. Threshold 0.40 (calibrated for pplx-embed-v1-4b).
`matchDomainAlias` runs first as a zero-cost exact check; semantic match only fires
when alias lookup returns null.

**Problem 2 — workflow routing (Pass 2 keyword scan miss)**
Pass 2 uses `intent_keywords` on `PGC_Workflow` for token presence. Novel phrasings
fall through to Tier 2 sonar. After domain is resolved via semantic match, workflow
routing can also use vector similarity against `PGC_Workflow.intent_embedding` — Backlog.

---

### Architectural principle: embedding belongs in the Service tier

Embedding computation is a prerequisite for persistence — the same category of
concern as hashing before storing a password. It is not business logic. Therefore:

- `embed-client.mjs` lives in `src/shared/` but is imported **only by ServFunction**
- `table.mjs` (SERV) calls `embedText()` on `insertRow` and `updateRows` automatically
  when the column's PGC_Schema definition includes `embed_source`
- PROC never imports `embed-client.mjs`. `classify-intent.mjs` sends plain text to
  SERV via `getRows` with a `vectorSearch` descriptor — SERV handles the embedding

This means direct curl calls to SERV endpoints, the backfill script, and
workflow-driven inserts all get embeddings for free with no workflow step type change.

---

### embed_source in PGC_Schema.columns — the authoritative embedding spec

The specification of what text to embed for a vector column lives in
`PGC_Schema.columns` alongside the column's type definition:

```json
{
  "name": "embedding",
  "type": "vector",
  "nullable": true,
  "embed_source": ["domain", "description", "aliases"],
  "comment": "pgvector embedding — SERV auto-computes on insert/update"
}
```

`embed_source` is an array of sibling column names whose values are concatenated
(after normalization) and passed to `embedText()`. This is the single source of
truth — no workflow step, no endpoint, and no application code needs to know which
fields contribute to the embedding. SERV reads it from the schema at runtime.

**Why PGC_Schema is the right home:**

PGC_Schema already owns the column contract (type, nullable, default, constraints).
Embedding is a persistence-time computation that depends on column values — it
belongs in the schema definition, not in workflow step definitions. Any table in the
system (PGC or PGD) can gain semantic search capability by adding a vector column
with `embed_source` — no code changes, only a schema update.

**Normalization before embedding:**

`resolveEmbedding()` in `table.mjs` normalizes each source field value before
embedding. Array fields (e.g. `aliases: ["flashcard", "quiz"]`) contribute each
element as a separate space-delimited token. All values have underscores replaced
with spaces (`spanish_flashcards` → `spanish flashcards`) so snake_case identifiers
tokenize correctly. Only array-type embed_source fields are used — scalar fields
like `description` are excluded because generic management text ("Manage your data")
pulls the centroid away from the user-vocabulary terms in the aliases.

**updateRows read-before-write:**

When any `embed_source` field appears in the `updates` payload, `table.mjs` performs
a `SELECT` of the current row, merges it with `updates`, then recomputes the
embedding from the complete post-update state. This ensures partial updates (changing
only `aliases` without including `description`) produce a correct embedding.

---

### vectorSearch switch on getRows

`getRows` accepts an optional `vectorSearch` descriptor alongside standard `filters`:

```json
{
  "tableName": "PGC_DomainHelp",
  "vectorSearch": {
    "column": "embedding",
    "queryText": "spanish flashcard quiz",
    "threshold": 0.40,
    "limit": 1
  }
}
```

When `vectorSearch` is present:
1. SERV calls `embedText(queryText)` — the caller supplies plain text only
2. SQL uses pgvector `<=>` cosine distance operator to rank and filter rows
3. Each result row gains a `similarity` float field (0–1)
4. Standard `filters` can combine with `vectorSearch` to pre-qualify rows before ranking

**Vector columns are stripped from getRows responses.** The `embedding` field is
never returned to callers. Direct SQL via the bastion is the appropriate path for
inspection or debugging.

---

### embed-client.mjs

`src/shared/embed-client.mjs`:

- **`embedText(text, traceId) → number[]`** — single string, used for query-time
  vectorSearch in `getRows`. Calls the Perplexity embeddings API with one input.
- **`embedTexts(texts[], traceId) → number[]`** — batch embed multiple strings
  and return a component-wise averaged vector. Available for future batch use cases.
  (Currently `table.mjs` uses `embedText` with the pre-concatenated source text.)
- **`parseVector(pgVal) → number[]`** — parse PostgreSQL vector string
  (`"[1,2,3,...]"`) to `number[]`. pgvector returns vector columns as text because
  the `pg` library does not know the `vector` OID.

Credentials are injected into `ServFunction` via CloudFormation at deploy time:
```yaml
EMBEDDING_API_URL: 'https://api.perplexity.ai/v1/embeddings'
EMBEDDING_API_KEY: '{{resolve:ssm:/evolving-mind-ai/llm-api-key}}'
```
The same SSM key is reused for both the agent API (PROC) and the embeddings API (SERV).
No runtime SSM SDK call — CloudFormation resolves `{{resolve:ssm:...}}` at deploy time.

Response format: Perplexity returns base64-encoded signed INT8 per the `base64_int8`
encoding. `decodeBase64Int8()` decodes to `number[]`. pgvector stores as float4 and
normalises internally for cosine distance.

---

### Similarity threshold calibration

| Model | Threshold | Notes |
|---|---|---|
| `pplx-embed-v1-4b` | 0.40 | Calibrated from live data — exact alias matches score ~0.55–0.60; unrelated domains score ~0.08–0.12 |

The threshold is hardcoded in `classify-intent.mjs` as `DOMAIN_SIMILARITY_THRESHOLD`.
Threshold calibration per model should eventually be stored in `PGC_SystemContext.pgvector_config`
so it is adjustable without a code deploy. This is a low-priority Backlog item.

---

### How the Intent Preprocessor uses pgvector

```
PASS 2 — domain resolution (with pgvector, Session 26):
  1. matchDomainAlias() — zero-cost exact substring check against aliases array
  2. If no alias match: semanticDomainMatch() via SERV getRows vectorSearch
     - SERV embeds userInput, returns top-1 domain by cosine similarity
     - Threshold 0.40 — returns null if no domain exceeds it
  3. If domain resolved (either path): matchWorkflowByKeywords() keyword scan
  4. If no keyword match: fall to Tier 2 sonar

PASS 2 Backlog — workflow routing via intent_embedding:
  After keyword-scan miss, embed user input and query PGC_Workflow.intent_embedding
  filtered by resolved domain. Threshold 0.40 (to be calibrated when implemented).
```

Pass 2 domain resolution is also used in `create-workflow.mjs` before creating the
`PGC_WorkflowRun` — so `input.domain` is populated with the best available match
before step 1 (`serv_query PGC_Schema`) runs.

---

### create_domain workflow — automatic embedding on DomainHelp insert

`PGC_DomainHelp.embedding` is populated automatically by SERV on `insertRow` because
the column definition in `PGC_Schema` includes `embed_source: ["domain", "description", "aliases"]`.
No workflow step change is needed. The `serv_insert PGC_DomainHelp` step in
`create_domain` already triggers embedding computation transparently.

---

### Backfill script

`dev_scripts/backfill-embeddings.mjs`:
- Fetches ALL `PGC_DomainHelp` rows (not just null-embedding rows — backfill is
  unconditional so re-running after model or normalization changes recomputes everything)
- For each row: calls `updateRows` with `description` in the updates payload,
  triggering SERV's read-before-write embed path
- Run after: pgvector extension enabled, `embedding` column added, SAM deployed

---

### Status — Session 26

| Item | Status |
|---|---|
| pgvector extension enabled on RDS | ✅ Complete |
| `vector` added to `ALLOWED_TYPES` in `schema.mjs` | ✅ Complete |
| `embed_source` persisted in `addColumn` → PGC_Schema | ✅ Complete |
| `PGC_DomainHelp.embedding` column added via `addColumn` curl | ✅ Complete |
| `seed_PGC_Schema.json` PGC_DomainHelp entry updated with `embed_source` | ✅ Complete |
| `embed-client.mjs` — Perplexity pplx-embed-v1-4b, base64 INT8 decode | ✅ Complete |
| `table.mjs` — auto-embed on insertRow/updateRows; vectorSearch on getRows | ✅ Complete |
| `serv-client.mjs` — vectorSearch param added to getRows wrapper | ✅ Complete |
| `classify-intent.mjs` — semanticDomainMatch via SERV getRows vectorSearch | ✅ Complete |
| `create-workflow.mjs` — domain resolution before WorkflowRun creation | ✅ Complete |
| `backfill-embeddings.mjs` — unconditional backfill via updateRows | ✅ Complete |
| Threshold calibration — 0.40 for pplx-embed-v1-4b | ✅ Complete |
| `PGC_Workflow.intent_embedding` vector column — workflow routing | ⬜ Backlog |
| Threshold config in `PGC_SystemContext.pgvector_config` | ⬜ Backlog |

---

## 12. Security

### 12.1 Threat Model

evolving-mind-ai is a household-scale private deployment. The attack surfaces are:

- **Slack endpoints** — publicly reachable API Gateway URLs. Anyone who knows the URL
  can POST to them without authentication unless protected.
- **PROC endpoints** — business logic layer. A fake request can trigger LLM calls,
  DDL execution, or workflow cancellation.
- **SERV endpoints** — data layer. A fake request can read or write PGC/PGD tables.
- **Prompt injection** — malicious content in user input or LLM output attempting to
  manipulate workflow execution. Covered by the right-brain validation loop (Section 6.5.1).

### 12.2 Slack Endpoint Security — Signing Secret Verification

**All `/api/v1/ui/slack/*` routes verify the Slack signing secret before any routing
or business logic executes.** This includes the new `/mind` endpoint.

Every genuine Slack request includes two headers:
- `X-Slack-Signature` — HMAC-SHA256 of `"v0:{timestamp}:{raw_body}"` signed with the signing secret
- `X-Slack-Request-Timestamp` — Unix timestamp of when Slack sent the request

The handler computes the expected signature independently and compares using
`timingSafeEqual` (Node.js `crypto`) — constant-time comparison that prevents
timing attacks. Requests older than 5 minutes are rejected regardless of signature.

**Implementation:**
```js
// src/ui/slackbot/handler.mjs
import { createHmac, timingSafeEqual } from 'crypto';

const sigBase  = `v0:${timestamp}:${rawBody}`;
const expected = 'v0=' + createHmac('sha256', signingSecret)
                           .update(sigBase, 'utf8')
                           .digest('hex');

if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
  return err(401, 'Unauthorized — invalid Slack signature');
}
```

**Exempt routes:** `EXEMPT_ROUTES` in `handler.mjs` — ping routes only. `/mind` is
NOT exempt — it enqueues to SQS and must be verified.

**SSM parameter:** `/evolving-mind-ai/slack-signing-secret` — `SecureString`.

### 12.3 PROC and SERV Endpoint Security

PROC and SERV endpoints have no authentication today. Target state: AWS API Gateway
resource policy restricting to requests originating from within the AWS account.
Medium priority — implement before any public exposure.

### 12.4 Security Implementation Status

| Surface | Protection | Status |
|---|---|---|
| `/ui/slack/command` | Slack signing secret — HMAC-SHA256 + replay protection | ✅ Implemented |
| `/ui/slack/interactive` | Slack signing secret — same verifySlackSignature() | ✅ Implemented |
| `/ui/slack/mind` | Slack signing secret — same verifySlackSignature() | ⬜ Phase 2 item 4 |
| `/proc/*` | AWS API Gateway resource policy — account-scoped | ⬜ Deferred |
| `/serv/*` | AWS API Gateway resource policy — account-scoped | ⬜ Deferred |
| Prompt injection | Right-brain validation loop — Ajv + AST gate | ✅ Implemented |
| API keys (external callers) | API Gateway usage plans | ⬜ Backlog |

### 12.5 What Is Deliberately Not Done

- **No VPC on Lambda** — cost decision ($32/month NAT Gateway avoided). Final — do not suggest VPC.
- **No WAF** — AWS WAF adds ~$5-10/month minimum. Not justified at this scale.
- **No API keys on Slack endpoints** — Slack signing secret is the correct mechanism.

---

## 13. Refactoring Decisions — Completed

All Phase 1 refactoring is complete as of `v3.2-clean-baseline`.

| Decision | Rationale | Status |
|---|---|---|
| `ProcStepOrchestrator` eliminated — `ProcFunction` dual HTTP+SQS trigger | Eliminates Lambda-to-Lambda hop, reduces cold start surface | ✅ complete |
| `invokeServ` replaced with `fetch(SERV_API_URL)` | Cloud portability — Lambda invoke is AWS-only; HTTP fetch works anywhere | ✅ complete |
| All PROC endpoint modules transport-agnostic | No AWS SDK in business logic — `req.source` determines response path only | ✅ complete |
| `shared/ping-utils.mjs` → `shared/lambda-utils.mjs` | Accurate name — utility serves all Lambdas, not just pings | ✅ complete |
| `workflowId` → `traceId` throughout | `workflowId` conflated with `PGC_WorkflowRun.id` — `traceId` is accurate | ✅ complete |
| FK + constraint normalisation moved to `buildCreateTableSQL` | SERV layer owns DDL contract — PROC should not pre-process LLM output | ✅ complete |
| `response_format json_schema` restored on Agent API call | Model-level JSON enforcement reduces malformed output | ✅ complete |
| `SchemaQueue` + `LambdaInvokePolicy` removed from `template.yaml` | Orphaned resources — no trigger, no application references | ✅ complete |
| `PROC_FUNCTION_NAME` + stale env vars removed | Lambda invoke pattern gone — env vars were dead references | ✅ complete |

**Planned PROC endpoints** (documented in `openapi.yaml`):

| Endpoint | Description |
|---|---|
| `POST /proc/create-domain` | ✅ Live — Step Processor entry point |
| `POST /proc/design-domain` | ✅ Live — LLM design + validation + WorkflowRun lifecycle |
| `POST /proc/review-output` | ✅ Live — Ajv + semantic validation, 2-attempt correction loop |
| `POST /proc/shutdown` | ✅ Live — emergency stop, cancel active runs |
| `POST /proc/classify-intent` | ✅ Live — Intent Preprocessor (Phase 2 item 4) |
| `POST /proc/run-workflow` | ✅ Live — Step Processor |
| `POST /proc/troubleshoot-workflow` | ✅ Live — Tier 1 static analysis, optional autoFix |
| `POST /proc/fix-workflow` | ✅ Live — Tier 1 LLM repair + human gate confirm |
| `POST /proc/diagnose-prompt-schema` | ✅ Live — Tier 1b deterministic R1–R7 schema repair |
| `POST /proc/simulate-workflow` | ✅ Live — Level 1 + Level 2 analysis without WorkflowRun |
| `POST /proc/improve-prompt` | ⬜ Backlog — prompt evolution |

**Planned SERV endpoints** (documented in `openapi.yaml`):

| Endpoint | Description |
|---|---|
| `POST /serv/schema/createTable` | ✅ Live — DDL + PGC_Schema + PGC_TableMap write |
| `POST /serv/schema/updateTable` | ✅ Live — metadata update (ALTER TABLE not yet executed) |
| `POST /serv/schema/addColumn` | ✅ Live (Session 25) — physical DDL + PGC_Schema sync; `schemaOnly: true` for metadata-only |
| `POST /serv/table/getRows` | ✅ Live |
| `POST /serv/table/insertRow` | ✅ Live |
| `POST /serv/table/updateRows` | ✅ Live |
| `POST /serv/table/deleteRows` | ✅ Live |
| `POST /serv/entity/listEntities` | ✅ Live |
| `POST /serv/entity/getEntity` | ✅ Live |
| `POST /serv/entity/insertEntity` | ✅ Live |
| `POST /serv/entity/upsertEntity` | ✅ Live |
| `POST /serv/entity/updateEntity` | ✅ Live |
| `POST /serv/entity/deleteEntity` | ✅ Live |
| `POST /serv/bootstrap` | ✅ Live — install-time only |
| `POST /serv/embed/domain-help` | ⬜ Session 26 — embed + update PGC_DomainHelp.embedding for a given domain id |

---

## 15. Tangential Features

Features discussed and designed but deferred — either because they require the Step
Processor to exist first, or because they represent a meaningful expansion of scope
that warrants explicit architectural review before implementation.

---

### 15.1 External API Registry — capability_call Step Type

#### The problem

The `js_transform` step type is restricted to pure synchronous data transformations.
External data enrichment from third-party APIs — fetching stock prices from Finnhub,
weather data, exchange rates — cannot be done safely in LLM-generated JS because:

- `vm.runInNewContext` timeout does not apply to async operations
- LLM-generated fetch calls are an exfiltration vector — a prompt injection attack
  or hallucinated URL could send workflow state to an attacker's endpoint
- API keys embedded in generated code are exposed in PGC_Workflow rows
- No rate limiting, retry logic, or circuit breaking on arbitrary fetch

#### The design

The system maintains a **capability registry** of approved external integrations.
Each registered capability defines what can be called, how to authenticate, and
what parameters are allowed. The LLM generates workflow steps that reference
capability keys — it never constructs URLs, never sees API keys, and cannot call
anything outside the registry.

**PGC_Capability schema extension** (Backlog):

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
  "on_failure": "human_feedback"
}
```

#### Finnhub integration — first capability

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

#### What needs to be built (Backlog)

1. PGC_Capability schema extension — add the API Registry columns listed above
2. SSM parameter for Finnhub API key
3. New capability_call row in PGC_StepType seed data
4. Step Processor handler for capability_call
5. Finnhub seed row in PGC_Capability
6. Rate limiting — token bucket in PGC_WorkflowRun state or a dedicated table

---

### 15.2 js_transform Safety Analysis — Synchronous Constraint

`vm.runInNewContext({ timeout: N })` in Node.js reliably kills synchronous infinite
loops. It does NOT apply to async operations. The chosen approach — prohibit async in
`js_transform`, use `capability_call` for I/O — is correct for this system. External
data enrichment is a `capability_call` concern. The distinction between "transform data
I already have" and "fetch data I don't have" is architecturally meaningful and enforced.

---

## 16. Cost of Ownership

### 16.1 Actual March 2026 Charges (us-east-2, household-scale dev)

| Service | Usage | Raw Cost | Notes |
|---|---|---|---|
| RDS db.t4g.micro | ~294 hours | $4.71 | PostgreSQL 16.6, arm64 |
| RDS Storage | 20 GB gp2 | $0.91 | PGC + PGD databases |
| VPC Public IPv4 | ~563 hours | $2.82 | $0.005/hr per address — Bastion + RDS |
| EC2 (Bastion t3.nano) | ~294 hours | $1.78 | SSH access host |
| Secrets Manager | — | $0.16 | SSM parameters |
| Lambda | ~1M requests | ~$0.00 | Well within free tier |
| API Gateway | ~10K requests | ~$0.00 | Well within free tier |
| SQS | ~50K messages | ~$0.00 | Well within free tier |
| **Raw total** | | **~$10.38/month** | Before credits |
| AWS Free Tier / Promotional credits | | ($10.38) | Applied automatically |
| **Net payable** | | **$0.00** | During credit period |

### 16.2 Cost Breakdown by Component

| Component | Monthly Cost | Scales With |
|---|---|---|
| RDS db.t4g.micro (compute) | $4.71 | Instance class only — flat rate |
| RDS Storage | $0.91 | Data volume — $0.115/GB/month (gp2) |
| Bastion Host (t3.nano) | $1.78 | Instance running hours |
| Public IPv4 addresses | $2.82 | Number of attached IPs × hours |
| Lambda (4 functions) | ~$0.00 | Invocation count + duration |
| API Gateway | ~$0.00 | Request count |
| SQS (2 queues + 2 DLQs) | ~$0.00 | Message count |
| SSM Parameters | $0.16 | Number of SecureString parameters |
| **Total infrastructure** | **~$10.38** | |

### 16.3 Database Size Scenarios

evolving-mind-ai stores **structured relational data only** — rows of text, numbers,
dates, and jsonb. It does not store files, images, documents, or binary content.

| Scenario | Example Domains | Typical Data | Est. DB Size | Storage Cost | Total Monthly |
|---|---|---|---|---|---|
| Small | Recipes, golf scores | Hundreds of records per domain | Under 1 GB | $0.23 | ~$10 |
| Medium | Inventory, budgets, stock portfolio, fitness tracking | Tens of thousands of records | 1–5 GB | $0.23–$0.58 | ~$10–$11 |
| Large | High-frequency data: sensor readings, transaction logs | Millions of rows | 5–15 GB | $0.58–$1.73 | ~$11–$13 |

### 16.4 LLM Cost Estimates (Perplexity)

LLM is called **only for novel intents** — repeat operations use cached `PGC_Workflow` rows and cost $0.

| Operation | Tokens (approx) | Cost per call | Monthly estimate |
|---|---|---|---|
| `/create-domain` (design) | ~3K in / ~2K out | ~$0.025 | $0.25 (10 new domains/month) |
| `/create-domain` (correction attempt 2) | ~4K in / ~2K out | ~$0.035 | Occasional — <$0.10 |
| Workflow generation (future) | ~5K in / ~3K out | ~$0.045 | $0.45 (10 new workflows/month) |
| Intent classification Tier 2 (sonar) | ~0.5K in / ~0.1K out | ~$0.001 | Negligible |
| **Total LLM** | | | **~$0.50–$1.00/month** |

### 16.5 Total Cost of Ownership Summary

| Scenario | AWS Infrastructure | LLM | Total/Month |
|---|---|---|---|
| Small (recipes, golf, 2-3 domains) | ~$10 | $0.50 | ~$10–11/month |
| Medium (inventory, budgets, stock portfolio) | ~$10–11 | $0.75 | ~$11–12/month |
| Large (high-frequency time-series, 10+ domains) | ~$11–13 | $1.00 | ~$12–14/month |

### 16.6 Cost Reduction Opportunities

| Action | Monthly Saving | When to Apply |
|---|---|---|
| Replace Bastion with AWS SSM Session Manager | ~$1.78 + $0.94 IPv4 | When promotional credits near exhaustion |
| Switch RDS to Graviton2 Reserved Instance (1yr) | ~30% on compute (~$1.40) | After system stabilises |
| Stop RDS when not in use (dev only) | Up to $4.71 | Dev/test environments only — not production |
| Use RDS Aurora Serverless v2 | Variable — cheaper at low use | Backlog — revisit if usage patterns justify it |

**Highest impact action today:** Replacing the Bastion with SSM Session Manager
eliminates the EC2 instance ($1.78) and one public IPv4 address ($0.94) — saving
~$2.72/month with no loss of functionality. Tracked in tech debt register.
