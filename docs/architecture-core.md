# evolving-mind-ai — Architecture: Core System
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2
Status: Active development — Session 29 complete
Last updated: 2026-04-27 (session 29 — callback.mjs: HUMAN_GATE / HUMAN_NOTIFICATION consolidation;
special_buttons field on human_gate steps; interactive.mjs placeholder fix;
seed_PGC_Workflow.json step 1a migrated to special_buttons; unit tests callback.test.mjs;
integration tests callback-slack.test.mjs)

**Architecture document set:**
- `architecture-core.md` — this file: system overview, stack, Lambda tiers, SQS queues, data architecture, SERV layer, dev scripts
- `architecture-step-processor.md` — Step Processor execution engine: step types, stack, local_state, human gates, simulation, right-brain validation, safety
- `architecture-workflows.md` — Workflow definitions: create_domain, create_workflow, L/R brain collaboration, gap taxonomy, self-repair loop
- `architecture-reference.md` — pgvector, security, tech debt register, backlog, cost of ownership, refactoring history

---

## 1. System Purpose

A self-evolving, low-cost cognitive automation brain that:
- Accepts natural language intent from users via Slack (or any UI)
- Uses LLM sparingly — only for novel intents, workflow generation, and schema creation
- Persists generated workflows in PostgreSQL and reuses them — LLM is not called twice for the same problem
- Evolves its own workflows and schemas over time
- Runs at approximately $8–$13/month at household scale — see architecture-reference.md Section 16 for full cost breakdown

---

## 2. Stack — Final, Do Not Change

| Component | Choice | Reason |
|---|---|---|
| Runtime | Node.js 22.x ESM | Modern, fast cold starts |
| Bundler | esbuild | Fast, ESM-native, handles CJS interop |
| Infrastructure | AWS SAM + CloudFormation | Declarative, reproducible |
| Compute | AWS Lambda (arm64 Graviton2) | ~20% cheaper than x86 |
| Queuing | AWS SQS (standard) | Async workflow execution |
| Database | PostgreSQL 16.6 on RDS | Config (PGC) + Domain (PGD) |
| UI | Slack Bot | Primary interface — abstracted, others can be added |
| LLM | Pluggable (currently Perplexity) | Model selection is coded logic |
| Region | us-east-2 | Fixed |
| API Base | https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod | Fixed |

### Architectural constraints — never suggest alternatives to these

- All Lambdas use shared `LambdaExecutionRole` with inline policies
- SSM dynamic references `{{resolve:ssm:...}}` in per-function Environment blocks only — Globals does NOT resolve them
- `pg` uses `ssl: { rejectUnauthorized: false }` — Lambda connects over public internet, no VPC
- RDS is `PubliclyAccessible: true` — no VPC on Lambda avoids $32/mo NAT Gateway
- All esbuild configs use Banner CJS shim for dynamic require compatibility
- `OutExtension: .js=.mjs` on all functions — Lambda loads as ESM
- JSON template files imported as static ES module imports — NOT read via `fs.readFile` at runtime (esbuild bundles them)
- PROC endpoint modules are transport-agnostic — never import AWS SDK or Slack SDK. Check `req.source` ('http' or 'sqs') only to determine response path. Business logic is identical for both transports.
- **Seed file encoding — FINAL:** JSON seed files use `\uXXXX` escape sequences for all non-ASCII characters. `JSON.stringify` produces this natively — no round-trip drift. Markdown/YAML docs use UTF-8 rendered characters. `.gitattributes` and `.editorconfig` in repo root enforce LF line endings and UTF-8 encoding.

---

## 3. Lambda Architecture — Four Functions

| Function | Name | Triggers | Tier | Owns |
|---|---|---|---|---|
| SlackbotFunction | `evolving-mind-ai-slackbot` | API Gateway | Experience | `/api/v1/ui/slack/{proxy+}` — Slack parsing, ACK, threading |
| ProcFunction | `evolving-mind-ai-proc` | API Gateway + SQS WorkflowQueue | Process | `/api/v1/proc/{proxy+}` — business logic, LLM, intent, workflow execution |
| ServFunction | `evolving-mind-ai-serv` | API Gateway | Service | `/api/v1/serv/{proxy+}` — DB CRUD, DDL, data access |
| SlackCallbackListenerFunction | `evolving-mind-ai-slack-callback-listener` | SQS CallbackResults | Experience | Posts threaded Slack replies |

**Note:** `ProcStepOrchestrator` (`SYSLMBOrchestrator`) is eliminated as a separate Lambda.
`ProcFunction` handles both HTTP requests (API Gateway) and async workflow messages (SQS WorkflowQueue)
via dual event triggers in `template.yaml`. `handler.mjs` detects the event type and routes accordingly:
```js
if (event.Records) → SQS dispatch path → processWorkflowMessage()
if (event.httpMethod) → HTTP dispatch path → switch(req.route)
```
This eliminates the Lambda-to-Lambda hop, reduces cold start surface, and keeps all
process-tier logic in one deployable unit.

### 3.1 Three-tier architecture — Mulesoft model

The system follows a strict three-tier separation inspired by Mulesoft's API-led connectivity.
The system is designed for household-scale private deployment — PII is segmented per instance,
not shared across users of a multi-tenant service.

**Experience tier** (`SlackbotFunction`, `SlackCallbackListenerFunction`)
- Owned by UI concerns — like for Slack (command parsing, ACK messages,
  thread formatting and Block Kit rendering)
  or any UI types implementation; teams, Web UIs, or PDA apps
- Never contains business logic
- `SlackbotFunction` handles inbound HTTP — slash commands and `/interactive` button clicks
- `SlackCallbackListenerFunction` handles outbound — consumes `SYSSQSSlackResults` and posts
  threaded Slack replies. Routes on `callback.provider` so adding a new UI is one new `case`
- Today: Slack. Tomorrow: Teams, webhook, or any other UI — swap the experience layer only

**Process tier** (`ProcFunction`)
- Contains all business logic and the true value of the system
- Experience layer may interface directly through Process tier or through SQS Queues
- Cloud-agnostic — no AWS SDK imports
- Calls SERV and LLM via HTTP API only (API Gateway URLs)
- Testable directly via the HTTP API without SQS or Slack
- Handles both HTTP (API Gateway) and async (SQS WorkflowQueue) event types
- All endpoints documented spec-first in `openapi.yaml`

**Service tier** (`ServFunction`)
- Interfaces external system touchpoints — PostgreSQL today
- If the database changes, only this layer is refactored
- No business logic — pure data access
- Accessed by Process layer via HTTP API endpoints — no direct imports
- All endpoints documented in `openapi.yaml`

---

### 3.2 SQS Queue Architecture

Two SQS standard queues carry all async traffic in the system. Every queue has a
Dead Letter Queue (DLQ) with a 14-day retention period for debugging failed messages.

#### WorkflowQueue (`SYSSQSWorkflow`)

**Purpose:** The single async channel between the Experience tier and the Process
tier. Every slash command that cannot be handled within Slack's 3-second ACK window
enqueues a message here. SlackbotFunction always returns immediately — all real work
happens asynchronously via this queue.

The queue carries two distinct categories of message that share this channel for the
same reason: neither can block the Experience tier.

**Two message categories:**

**Category 1 — Fire-and-forget entry messages**
Enqueued by `SlackbotFunction` on receipt of a slash command. No `workflowRunId` —
the workflow run does not exist yet when these are sent. PROC receives the message,
performs its work (classification, domain creation, help lookup), and routes results
back via the SlackResultsQueue. These messages *may* spawn a workflow run, but they
are not themselves workflow execution messages.

If a fire-and-forget message does spawn a workflow run, it transitions cleanly: PROC
creates the `PGC_WorkflowRun` row and enqueues the first `WORKFLOW_STEP execute_top`
to continue. The entry message is consumed and gone — workflow execution messages take
over from that point.

**Category 2 — Workflow execution messages**
All have `type: WORKFLOW_STEP` and always carry a `workflowRunId`. Drive the Step
Processor's execution stack one frame at a time.

**Producers:**
- `SlackbotFunction` — enqueues Category 1 on every slash command
- `interactive.mjs` — enqueues `WORKFLOW_STEP / resume_gate` (Category 2) when user clicks a Block Kit button
- `ProcFunction` itself — re-enqueues `WORKFLOW_STEP / execute_top` (Category 2) to advance the execution stack

**Consumer:** `ProcFunction` (SQS trigger, `BatchSize: 10`, `ReportBatchItemFailures`)

**Message types today:**

| type | action | Category | Sent by | Handled by |
|---|---|---|---|---|
| `PING_SQS` | — | 1 — fire-and-forget | SlackbotFunction | proc/handler inline |
| `PING_E2E` | — | 1 — fire-and-forget | SlackbotFunction | proc/handler inline |
| `CREATE_DOMAIN` | — | 1 — fire-and-forget | SlackbotFunction | proc/create-domain.mjs |
| `HELP` | — | 1 — fire-and-forget | SlackbotFunction | proc/help.mjs |
| `CLASSIFY_INTENT` | — | 1 — fire-and-forget | SlackbotFunction (mind.mjs) | proc/classify-intent.mjs |
| `CREATE_WORKFLOW` | — | 1 — fire-and-forget | SlackbotFunction / classify-intent.mjs | proc/create-workflow.mjs |
| `TROUBLESHOOT_WORKFLOW` | — | 1 — fire-and-forget | run-workflow.mjs (on failure) / developer curl | proc/troubleshoot-workflow.mjs |
| `FIX_WORKFLOW` | — | 1 — fire-and-forget → 2 on gate | troubleshoot-workflow.mjs (autoFix) / developer curl | proc/fix-workflow.mjs |
| `WORKFLOW_STEP` | `execute_top` | 2 — workflow execution | ProcFunction | proc/run-workflow.mjs |
| `WORKFLOW_STEP` | `resume_gate` | 2 — workflow execution | interactive.mjs | proc/run-workflow.mjs |
| `WORKFLOW_STEP` | `cancel` | 2 — workflow execution | ProcFunction /shutdown | proc/run-workflow.mjs |

**Design decisions:**
- `BatchSize: 10` — cost optimisation. Up to 10 messages delivered per invocation.
  The one-SQS-message-per-`workflowRunId` rule (Category 2) means batching only ever
  handles *concurrent runs across different workflow runs* — never parallel steps within
  a single run. Category 1 messages have no run ID and are unaffected by this rule.
- `ReportBatchItemFailures` — only failed records return to queue. Successful records
  in the same batch are not reprocessed.
- Standard queue (not FIFO) — ordering within a workflow run is enforced by the
  execution stack in `PGC_WorkflowRun`, not by the queue. Category 1 messages are
  stateless and order-independent by nature.

#### SlackResultsQueue (`SYSSQSSlackResults`)

**Purpose:** Carries result and notification messages from ProcFunction back to the
Experience tier for posting to Slack. Decouples business logic from UI delivery —
PROC never calls Slack directly.

**Producer:** `ProcFunction` via `enqueueCallback()` in `src/shared/sqs-callback.mjs` —
the ONLY place `@aws-sdk/client-sqs` is imported in the Process tier.

**Message envelope:** Every message carries `callback: { provider, channel, threadId }` —
the provider-agnostic routing object that makes the UI layer swappable.

**Consumer:** `SlackCallbackListenerFunction` — Lambda event source mapping with `BatchSize: 1`.
Each invocation receives and processes exactly one message, posting one Slack reply per call.

**Message types today:**

Two canonical types handle all live traffic. Ping types are dev/system diagnostics.

| type | Rendered by | Produced by |
|---|---|---|
| `HUMAN_GATE` | `postHumanGate()` → `dialogToBlocks()` — interactive dialog, Block Kit with action buttons | `step-executor.mjs` (human_gate steps), `design-domain.mjs` (legacy create_domain path) |
| `HUMAN_NOTIFICATION` | `postHumanNotification()` → `textToBlocks()` — plain text with 3000-char chunking | `run-workflow.mjs` (notify + cancel steps), `classify-intent.mjs` (CRUD results, errors), `create-domain.mjs` (error), `design-domain.mjs` (error, cancel) |
| `WORKFLOW_ERROR` | `postWorkflowError()` → `textToBlocks()` — error summary (EXP summarises raw PROC errors) | `run-workflow.mjs` (step failure, stuck-step guard, step-not-found) |
| `PING_SQS_RESULT` | `postPingSqsResult()` — hop timing context block | `proc/handler.mjs` (inline ping handler) |
| `PING_E2E_RESULT` | `postPingE2eResult()` — round-trip timing context block | `proc/handler.mjs` (inline ping handler) |

**Dead types removed (Session 29):**

| Removed type | Why removed |
|---|---|
| `WORKFLOW_GATE` | Renamed `HUMAN_GATE` — canonical name reflects the EXP/PROC boundary contract |
| `WORKFLOW_NOTIFY` | Merged into `HUMAN_NOTIFICATION` — was identical in structure and rendering |
| `WORKFLOW_CANCELLED` | Merged into `HUMAN_NOTIFICATION` — no distinction needed at the EXP layer |
| `SERV_NOTIFICATION` | Merged into `HUMAN_NOTIFICATION` — same text rendering path |
| `CREATE_DOMAIN_RESULT` | Dead code — `create-domain.mjs` delegates to Step Processor which emits `HUMAN_NOTIFICATION` |
| `HELP_GATE` | Dead code — `help.mjs` delegates to Step Processor which emits `HUMAN_GATE` |
| `HELP_RESULT` | Dead code — Step Processor notify step emits `HUMAN_NOTIFICATION` |
| `DESIGN_DOMAIN_GATE` | Replaced by `HUMAN_GATE` — `design-domain.mjs` now emits a UI-neutral dialog spec |
| `DESIGN_DOMAIN_ERROR` | Replaced by `HUMAN_NOTIFICATION` — same text rendering path |

**Design decisions:**
- `BatchSize: 1` — one message per invocation keeps Slack post ordering clean
  and avoids hitting the Slack API rate limit under burst conditions.
- `callback.provider` routing — `routeCallback()` in `callback.mjs` switches on
  provider. Adding Teams or webhook support is one new `case` with no other changes.
- PROC never imports `@slack/web-api` — all Slack SDK code is isolated to
  `SlackCallbackListenerFunction` and `SlackbotFunction`.
- `textToBlocks(text, contextText)` — shared utility in `callback.mjs` splits text on newlines
  into ≤2800-char section blocks (below Slack's 3000-char hard limit). All notification
  handlers call this — the char limit is enforced uniformly and cannot be missed by new handlers.
- `dialogToBlocks(dialog, workflowRunId)` — shared renderer for `HUMAN_GATE` messages.
  Both the Step Processor and `design-domain.mjs` (legacy path) produce the same UI-neutral
  dialog spec; `callback.mjs` renders it identically for all gate types. Adding a new gate type
  is one new `case` in `dialogToBlocks`.
- `special_buttons` field on `human_gate` steps — appended to actions block only, never
  appear in `description_list`. Used for UI controls (Other + modal, Cancel) that are independent
  from the selectable `options`. `resume_gate` searches both `options` and `special_buttons`
  for `on_select` routing. Static analysis validates routing tokens in both arrays.
- Error summarisation is an EXP responsibility — PROC emits raw technical error strings for
  `WORKFLOW_ERROR` to preserve full fidelity in CloudWatch. `callback.mjs` summarises before
  posting to Slack so users see a human-readable message, not AJV error arrays.

#### DLQs

| Queue | DLQ Name | Retention | Action on message |
|---|---|---|---|
| WorkflowQueue | `SYSSQSWorkflowDLQ` | 14 days | Inspect via AWS Console — indicates ProcFunction crash or unhandled message type |
| SlackResultsQueue | `SYSSQSSlackResultsDLQ` | 14 days | Inspect — indicates Slack API failure or malformed callback payload |

Both DLQs have `maxReceiveCount: 3` — a message is moved to the DLQ after 3 failed
processing attempts.

### 3.3 Route dispatch pattern

```
ProcFunction handler.mjs
  if (event.Records)    → SQS path → processSqsBatch(event)
  if (event.httpMethod) → HTTP path:
      parseEvent() → normalised req
      segments = path.split('/').filter(Boolean)
      req.subRoute = segments.pop()
      req.route    = segments.pop()
      switch(req.route) → delegate to endpoint module

All other Lambda handlers follow the same HTTP dispatch pattern.
```

### 3.4 Directory structure and file partitioning rules

```
evolving-mind-ai/
├── src/
│   ├── ui/
│   │   └── slackbot/                 Experience tier — Slack only
│   │       ├── handler.mjs           Lambda entry point — HTTP dispatch, Slack signing verification
│   │       ├── ping.mjs              GET /ui/slack/ping-api
│   │       ├── ping-sqs.mjs          POST /ui/slack/ping-sqs — enqueues PING_SQS to WorkflowQueue
│   │       ├── ping-llm.mjs          POST /ui/slack/ping-llm
│   │       ├── ping-e2e.mjs          POST /ui/slack/ping-e2e — enqueues PING_E2E to WorkflowQueue
│   │       ├── create-domain.mjs     POST /ui/slack/create-domain — ACK + CREATE_DOMAIN SQS enqueue
│   │       ├── create-workflow.mjs   POST /ui/slack/create-workflow — ACK + CREATE_WORKFLOW SQS enqueue
│   │       ├── mind.mjs              POST /ui/slack/mind — ACK + CLASSIFY_INTENT SQS enqueue (/mind, /m)
│   │       ├── help.mjs              POST /ui/slack/help — ACK + HELP SQS enqueue
│   │       ├── interactive.mjs       POST /ui/slack/interactive — Block Kit button clicks, modal submissions;
│   │       │                         routes resume_gate + view_submission via enqueueCallback
│   │       ├── shutdown.mjs          POST /ui/slack/shutdown — ACK + cancel active WorkflowRuns
│   │       └── callback.mjs          SQS SlackResultsQueue consumer — routes on callback.provider,
│   │                                 posts threaded Slack replies via @slack/web-api
│   │
│   ├── proc/                         Process tier — business logic only, NO AWS SDK
│   │   ├── handler.mjs               Lambda entry — HTTP + SQS dual dispatch
│   │   │                             Detects event.Records vs event.httpMethod; NO AWS SDK imports
│   │   ├── ping-llm.mjs              POST /proc/ping-llm
│   │   ├── create-domain.mjs         POST /proc/create-domain — Step Processor entry for CREATE_DOMAIN
│   │   ├── create-workflow.mjs       POST /proc/create-workflow — Step Processor entry for CREATE_WORKFLOW;
│   │   │                             initiates create_workflow PGC_WorkflowRun
│   │   ├── design-domain.mjs         POST /proc/design-domain — standalone LLM call + Ajv validation,
│   │   │                             no DB writes; used directly from curl / integration tests
│   │   ├── diagnose-prompt-schema.mjs POST /proc/diagnose-prompt-schema — Tier 1b self-repair;
│   │   │                             deterministic R1–R7 compatibility rules; no LLM; human gate confirm
│   │   ├── fix-workflow.mjs          POST /proc/fix-workflow — Tier 1 reactive repair; LLM corrects steps,
│   │   │                             human gate confirms before PGC_Workflow write; SQS FIX_WORKFLOW type
│   │   ├── help.mjs                  POST /proc/help — HELP SQS handler; drives help workflow execution
│   │   ├── llm.test.mjs              Developer integration test harness — calls live LLM endpoints directly;
│   │   │                             not a unit test runner; run manually with node
│   │   ├── run-workflow.mjs          POST /proc/run-workflow — Step Processor; executes one stack frame per
│   │   │                             SQS message (execute_top, resume_gate, cancel)
│   │   ├── simulate-workflow.mjs     POST /proc/simulate-workflow — standalone workflow simulation endpoint;
│   │   │                             runs Level 1 + Level 2 analysis without creating a WorkflowRun
│   │   ├── step-executor.mjs         Step type dispatch — llm_call, js_transform, human_gate, serv_schema,
│   │   │                             serv_insert, serv_query, serv_update, serv_delete, serv_entity_query,
│   │   │                             serv_entity_get, serv_entity_schema, iterator, condition, simulate, notify, end
│   │   ├── template-resolver.mjs     Resolves {{key.path}} tokens against local_state; pure function, no I/O
│   │   ├── classify-intent.mjs       POST /proc/classify-intent — Intent Preprocessor entry; three-tier pipeline;
│   │   │                             executes ad_hoc CRUD steps for Pass 1a/1c matches
│   │   ├── classify-intent-tiers.mjs Pure functions — matchIntentMap, matchDomainAlias, matchWorkflowByKeywords,
│   │   │                             extractSearchTerm, matchCrudVerb, hasCrudVerb — no I/O, unit-testable
│   │   ├── delete-domain.mjs         POST /proc/delete-domain — drops PGD tables; cleans PGC_Schema,
│   │   │                             PGC_TableMap, PGC_EntitySchema, PGC_DomainHelp, PGC_Workflow, PGC_IntentMap
│   │   ├── shutdown.mjs              POST /proc/shutdown — cancels all active PGC_WorkflowRun rows
│   │   ├── review-output.mjs         Internal module — Ajv validation + semantic rules + routing value rules;
│   │   │                             called by step-executor llm_call; not an HTTP endpoint
│   │   ├── troubleshoot-workflow.mjs POST /proc/troubleshoot-workflow — Tier 1 static analysis on
│   │   │                             PGC_Workflow.steps; SQS TROUBLESHOOT_WORKFLOW; optionally enqueues FIX_WORKFLOW
│   │   ├── migrations/               One-time DB migration scripts — run manually via node
│   │   │   └── seed-*.mjs
│   │   └── scaffolds/                Phase 2b static scaffolds — superseded by LLM output
│   │       └── recipes.json
│   │
│   ├── serv/                         Service tier — DB access only; pg client allowed here
│   │   ├── handler.mjs               Lambda entry — HTTP dispatch only
│   │   ├── ping-db.mjs               GET /serv/ping-db
│   │   ├── schema.mjs                POST /serv/schema/createTable — DDL + PGC_Schema + PGC_TableMap write
│   │   │                             POST /serv/schema/updateTable — metadata update (ALTER TABLE not yet live)
│   │   │                             POST /serv/schema/addColumn — physical DDL + PGC_Schema sync;
│   │   │                               schemaOnly: true mode for metadata-only sync without DDL
│   │   ├── table.mjs                 POST /serv/table/getRows — parameterised SELECT with filters + orderBy
│   │   │                             POST /serv/table/insertRow — single row INSERT; gated by PGC_TableMap
│   │   │                             POST /serv/table/updateRows — filtered UPDATE; enforces non-empty filters
│   │   │                             POST /serv/table/deleteRows — filtered DELETE; enforces non-empty filters
│   │   ├── entity.mjs                POST /serv/entity/listEntities — assembled entity + child arrays via
│   │   │                               jsonb_agg joins defined in PGC_EntitySchema
│   │   │                             POST /serv/entity/getEntity — single assembled entity by id
│   │   │                             POST /serv/entity/insertEntity — root + child inserts in sequence
│   │   │                             POST /serv/entity/upsertEntity — upsert on PGC_EntitySchema.upsert_key
│   │   │                             POST /serv/entity/updateEntity — root row update by id
│   │   │                             POST /serv/entity/deleteEntity — root row delete by id
│   │   ├── init-brain.mjs            POST /serv/bootstrap — install-time only; idempotent PGC table creation
│   │   │                             + seeding; never called on cold start
│   │   └── templates/
│   │       └── pgc/                  JSON table definitions — static ES module imports (not fs.readFile)
│   │           ├── PGC_Schema.json
│   │           ├── PGC_TableMap.json
│   │           ├── PGC_EntitySchema.json
│   │           ├── PGC_DomainHelp.json
│   │           ├── PGC_Workflow.json
│   │           ├── PGC_WorkflowRun.json
│   │           ├── PGC_WorkflowRunStep.json
│   │           ├── PGC_IntentMap.json
│   │           ├── PGC_Prompt.json
│   │           ├── PGC_StepType.json
│   │           ├── PGC_SystemContext.json
│   │           ├── PGC_Capability.json
│   │           └── seeds/            Seed JSON consumed by dev_scripts/upsert-*.mjs
│   │               ├── seed_PGC_Workflow.json
│   │               ├── seed_PGC_Prompt.json
│   │               ├── seed_PGC_IntentMap.json
│   │               ├── seed_PGC_StepType.json
│   │               └── seed_PGC_SystemContext.json
│   │
│   └── shared/                       Cross-cutting utilities — no business logic, no tier-specific imports
│       ├── lambda-utils.mjs          parseEvent, ok, err, buildReqFromSqs — used by all Lambda handlers
│       ├── sqs-callback.mjs          enqueueCallback(), enqueueWorkflow() — ONLY place @aws-sdk/client-sqs
│       │                             lives in ProcFunction
│       ├── llm-client.mjs            callLlm(), callLlmWithCorrection() — shared LLM caller;
│       │                             isSonar guard (response_format only on sonar); fence extraction regex
│       ├── serv-client.mjs           servPost(), getRows(), insertRow(), updateRows(), deleteRows()
│       │                             — shared SERV HTTP client; proc→serv cross-tier only
│       └── embed-client.mjs          embedText(text) → float[2560] — Perplexity pplx-embed-v1-4b;
│                                     reads EMBEDDING_API_KEY from CloudFormation env var at runtime
│
├── docs/
│   ├── architecture-core.md          Core system — this file
│   ├── architecture-step-processor.md Step Processor execution engine
│   ├── architecture-workflows.md     Workflow definitions and L/R brain collaboration
│   ├── architecture-reference.md     pgvector, security, tech debt, backlog, cost
│   ├── code-review-checklist.md      Per-session code review checklist — patterns, anti-patterns, rules
│   ├── github-file-index.md          Raw GitHub URL index for all source files — used for direct session-start fetches
│   ├── Javear-use-cases.md           User-facing use case definitions — source of truth for scope decisions
│   ├── openapi.yaml                  OpenAPI 3.0 spec — all PROC and SERV HTTP endpoints; spec-first rule
│   ├── perplexityapi.yaml            Perplexity Agent API reference — response_format, model names, constraints
│   ├── perplexity-embeddings.yaml    Perplexity embedding API reference
│   ├── perplexityLLMS.md             Perplexity model catalogue and constraints
│   ├── slack-block-kit.md            Slack Block Kit element reference with JSON snippets
│   ├── slack-messaging.md            Slack messaging API reference
│   ├── prompt-issues.md              LLM prompt quality log — failure patterns, root causes, mitigations
│   ├── session-handoff.md            Session-to-session continuity doc — last known state + next steps
│   ├── unit-test-setup.md            node:test runner setup guide — ESM fixtures, test structure
│   ├── user-intent-use-cases.md      UC 1.x intent pipeline use case specs
│   └── evolving_mind_use_cases.html  Visual use case map — rendered HTML for stakeholder review
│
├── dev_scripts/                      Developer tooling — run manually, never imported by Lambda code
│   ├── upsert-workflow.mjs           Upserts one or more PGC_Workflow rows from seed_PGC_Workflow.json
│   │                                 Usage: node dev_scripts/upsert-workflow.mjs <workflow_name>
│   ├── upsert-prompt.mjs             Upserts PGC_Prompt rows; idempotent via SHA-256 fingerprint;
│   │                                 Usage: node dev_scripts/upsert-prompt.mjs <intent_category>
│   ├── upsert-step-type.mjs          Upserts PGC_StepType rows from seed_PGC_StepType.json
│   │                                 Usage: node dev_scripts/upsert-step-type.mjs <step_type>
│   ├── upsert-system-context.mjs     Upserts PGC_SystemContext rows from seed_PGC_SystemContext.json
│   │                                 Usage: node dev_scripts/upsert-system-context.mjs <key>
│   ├── pull-prompt.mjs               Pulls highest-version DB row per intent_category; writes directly
│   │                                 to seed_PGC_Prompt.json in place; removes old-version cluster entries
│   │                                 Usage: node dev_scripts/pull-prompt.mjs <intent_category>
│   ├── extract-run-data.mjs          CLI: extract all values at a relative dot-path from a JSON file;
│   │                                 fans through arrays; --raw flag for piping
│   │                                 Usage: node dev_scripts/extract-run-data.mjs <file> <dot.path>
│   ├── backfill-embeddings.mjs       One-shot — embeds all PGC_DomainHelp rows where embedding IS NULL
│   └── seed_PGC_StepType.mjs         Seeds PGC_StepType rows with routing contracts; safe to re-run
│                                     (Note: prefer upsert-step-type.mjs for targeted updates)
│
├── tests/
│   ├── unit/
│   │   ├── classify-intent-tiers.test.mjs   50 tests — matchIntentMap, matchDomainAlias,
│   │   │                                    matchWorkflowByKeywords, extractSearchTerm, parseFieldValues
│   │   └── callback.test.mjs                48 tests — textToBlocks chunking, dialogToBlocks all field types
│   │                                        including [object Object] regression guard
│   └── integration/
│       ├── llm-prompt-schema.test.mjs        One it() per prompt; probe_input substitution mirrors
│       │                                     step-executor; HTTP 400 always hard fail
│       └── callback-slack.test.mjs           Posts real messages to TEST_SLACK_CHANNEL; validates
│                                             block rendering for all HUMAN_GATE and HUMAN_NOTIFICATION types
│
├── template.yaml                     SAM/CloudFormation — infrastructure, Lambda env vars, SQS triggers
├── samconfig.toml
├── package.json
└── .samignore
```

### 3.5 File partitioning rules — where does new code go?

**Experience tier (`src/ui/`):**
- Slack command parsing, ACK messages, thread formatting
- SQS enqueueing to WorkflowQueue (fire and forget — no business logic)
- Slack callback posting (`callback.mjs`)
- `@aws-sdk/client-sqs` and `@slack/web-api` are allowed here
- Never contains business logic or DB calls

**Process tier (`src/proc/`):**
- All business logic — LLM calls, workflow orchestration, intent classification
- Every endpoint module is transport-agnostic:
  - No `@aws-sdk/*` imports in endpoint modules
  - No `@slack/*` imports in endpoint modules
  - Use `fetch()` for all external calls (SERV, LLM)
  - Check `req.source` only to determine response path
- `handler.mjs` is the only file in proc that handles SQS event structure
- `enqueueCallback()` from `src/shared/sqs-callback.mjs` is how proc sends results back

**Service tier (`src/serv/`):**
- PostgreSQL access only — `pg` client is allowed here
- No business logic — pure data access and DDL
- No LLM calls, no SQS, no Slack
- `init-brain.mjs` is the only file allowed to create tables or seed rows at bootstrap

**Shared (`src/shared/`):**
- Pure utilities with no business logic and no tier-specific imports
- `lambda-utils.mjs` — `parseEvent`, `ok`, `err`, `buildReqFromSqs`
- `sqs-callback.mjs` — `enqueueCallback()` — the ONLY place `@aws-sdk/client-sqs`
  is imported in `ProcFunction`. Isolated here so endpoint modules stay AWS-agnostic.
- `llm-client.mjs` — `callLlm()`, `callLlmWithCorrection()` — shared LLM caller;
  `isSonar` guard gates `response_format` to sonar models only; fence extraction
  regex strips leading/trailing prose around fenced JSON
- `serv-client.mjs` — `servPost()`, `getRows()`, `insertRow()`, `updateRows()`, `deleteRows()` — shared SERV HTTP client
- `embed-client.mjs` — `embedText(text) → float[2560]` — Perplexity `pplx-embed-v1-4b`;
  reads API key from `process.env.EMBEDDING_API_KEY` (injected by CloudFormation at deploy time).

### 3.5a Inter-module call rules — FINAL

These rules govern how modules call each other. They are final and must not be violated.

| Call direction | Mechanism | Reason |
|---|---|---|
| exp → exp | Direct import | Same Lambda, same tier |
| proc → proc | Direct import | Same Lambda, same tier |
| serv → serv | Direct import | Same Lambda, same tier |
| any → shared | Direct import | Shared utilities, available to all |
| exp → proc | HTTP API Gateway | Cross-tier — keeps PROC independently testable |
| proc → serv | HTTP API Gateway | Cross-tier — keeps SERV independently swappable |
| SQS → proc | `buildReqFromSqs()` normalisation in `handler.mjs` | Async cross-tier delivery |
| proc → exp | Never | PROC never calls EXP — results go via SQS callback |
| serv → proc/exp | Never | SERV is the bottom tier — no upward calls |

**`req.callback` vs `req.body.callback` — critical SQS pattern:**

`buildReqFromSqs()` destructures the SQS message envelope explicitly:
```js
const { type, traceId, callback, ...rest } = message;
return { ..., body: rest, callback: callback ?? null, traceId, ... };
```

This means `callback` is always at `req.callback` — **never** at `req.body.callback`.
Every PROC endpoint that reads callback from an SQS message must use:
```js
const callback = req.callback ?? req.body?.callback ?? null;
```

**When adding a new PROC endpoint:**
1. Create `src/proc/<endpoint-name>.mjs` — export `handle(req)`
2. Add `case '<endpoint-name>': return handle(req)` to HTTP switch in `handler.mjs`
3. Add `case '<SQS_MESSAGE_TYPE>': return handle(buildReq(message))` to SQS switch
4. Document in `openapi.yaml` spec-first
5. Never import AWS SDK in the endpoint module
6. Read callback as `req.callback ?? req.body?.callback ?? null` — never `req.body.callback`

### 3.6 Transport-agnostic endpoint pattern — IMPORTANT

`ProcFunction` endpoint modules are called identically whether the request
arrived via HTTP (API Gateway) or SQS (WorkflowQueue). Business logic is transport-agnostic.

`handler.mjs` detects the event source and routes accordingly:

```js
export async function handler(event) {
  if (event.Records) {
    return processSqsBatch(event.Records);   // SQS WorkflowQueue trigger
  }
  return processHttpRequest(event);          // API Gateway trigger
}
```

The endpoint module receives identical input either way:

```js
// HTTP delivery
POST /api/v1/proc/classify-intent  { userInput: 'plan my meals for the week' }
  → parseEvent(event)
  → req = { route: 'classify-intent', body: { userInput }, source: 'http', traceId, ... }
  → dispatch(req) → classifyIntent(req)

// SQS delivery
{ type: 'CLASSIFY_INTENT', userInput: 'plan my meals for the week', callback: {...}, traceId: '...' }
  → processSqsBatch([record])
  → buildReqFromSqs(message)
  → req = { route: 'classify-intent', body: { userInput }, source: 'sqs', callback, traceId, ... }
  → dispatch(req) → classifyIntent(req)
```

The endpoint checks `req.source` only to determine how to deliver results — not to branch business logic.

---

## 4. Data Architecture

### 4.1 One PostgreSQL Instance, Two Login URLs

| Login URL | Purpose | Primary Use |
|---|---|---|
| PGC | Config / system tables | PGC_* tables — system metadata, workflow definitions, prompts |
| PGD | Domain / user data | PGD_* tables — user-created domain tables |

### 4.2 Naming Conventions and Bootstrap

**Naming:**
- System config tables: `PGC_*` (live in PGC database)
- User domain tables: `PGD_*` (live in PGD database)
- Table names are mixed case and MUST be quoted in SQL: `"PGC_Schema"`

**Bootstrap — `init-brain.mjs`**

`bootstrap()` is an **install-time HTTP handler**, not a cold-start routine.
It is called once during installation via `POST /api/v1/serv/bootstrap` and is
idempotent — safe to call again if needed. It is NOT called automatically on Lambda cold start.

Bootstrap steps:
1. Install `set_updated_at()` trigger function on PGC and PGD
2. `CREATE TABLE IF NOT EXISTS` for all PGC system tables (from imported JSON templates)
3. Seed self-referential rows into `PGC_Schema` (`ON CONFLICT DO NOTHING`)
4. Seed gatekeeper rows into `PGC_TableMap` (`ON CONFLICT DO NOTHING`)
5. Seed `PGC_Workflow` rows for system workflows (`WHERE NOT EXISTS`)
6. Seed `PGC_IntentMap` rows (`WHERE NOT EXISTS ON intent_category`)
7. Seed `PGC_Prompt` rows for system workflows (`WHERE NOT EXISTS ON intent_category + version`)
8. Set `bootstrapComplete = true` — returns cached result on subsequent calls within same container

All seed operations use `WHERE NOT EXISTS` or `ON CONFLICT DO NOTHING` — never `DO UPDATE`.

### 4.3 PGC System Tables

[Full PGC table reference is unchanged from Session 28. See git history for complete table
schemas for PGC_Schema, PGC_TableMap, PGC_EntitySchema, PGC_DomainHelp, PGC_Workflow,
PGC_WorkflowRun, PGC_WorkflowRunStep, PGC_Prompt, PGC_IntentMap, PGC_StepType,
PGC_Capability, PGC_SystemContext, PGC_Session (Backlog), PGC_SessionEntry (Backlog).]

**Total: 13 physical PGC tables (bootstrapped) + 2 session tables (Backlog) + 1 view**

### 4.3.7 Dev Scripts — PGC Data Management

All upsert scripts communicate via the SERV API — no direct DB connection required.
Set `SERV_API_URL` before running:

```cmd
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/<script>.mjs
```

All upsert scripts accept an optional name argument to target a single row:

```cmd
node dev_scripts/upsert-prompt.mjs generate_workflow_steps
node dev_scripts/upsert-workflow.mjs create_workflow
node dev_scripts/upsert-step-type.mjs js_transform
node dev_scripts/upsert-system-context.mjs create_domain_example
```

**Run order when adding a new step type:**
```cmd
node dev_scripts/upsert-step-type.mjs <new_step_type>
node dev_scripts/upsert-system-context.mjs step_type_contracts
```

---

## 5. Service Layer — SERV

### 5.1 SERV-Schema (complete)

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/schema/createTable` | POST | Execute DDL + register in PGC_Schema + PGC_TableMap |
| `/api/v1/serv/schema/listTables` | POST | List entries from PGC_Schema, optional target filter |
| `/api/v1/serv/schema/getTable` | POST | Get one entry by tableName |
| `/api/v1/serv/schema/updateTable` | POST | Update metadata in PGC_Schema (NOT ALTER TABLE) |
| `/api/v1/serv/schema/deleteTable` | POST | DROP TABLE + remove from PGC_Schema + PGC_TableMap |
| `/api/v1/serv/schema/addColumn` | POST | Physical DDL + PGC_Schema sync; `schemaOnly: true` for metadata-only |

### 5.2 SERV-Table (complete)

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/table/getRows` | POST | Parameterised SELECT — filters, orderBy, limit |
| `/api/v1/serv/table/insertRow` | POST | Single INSERT RETURNING * — gated by `allow_insert` |
| `/api/v1/serv/table/updateRows` | POST | Parameterised UPDATE RETURNING * — gated by `allow_update` |
| `/api/v1/serv/table/deleteRows` | POST | Parameterised DELETE — gated by `allow_delete` |

Security gate on all operations:
- Table must be registered in `PGC_TableMap`
- Column names validated against `PGC_Schema.columns`
- Filter operators validated against whitelist (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `is_null`, `not_null`)
- `updateRows` and `deleteRows` require non-empty `filters`
- `allow_insert`, `allow_update`, `allow_delete` checked per-table from `PGC_TableMap`

### 5.3 SERV-Entity (complete)

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/entity/getEntity` | POST | Fetch one entity by id — with configured joins and jsonb_agg aggregations |
| `/api/v1/serv/entity/listEntities` | POST | List entities — filters, orderBy, limit — entity default filters always applied |
| `/api/v1/serv/entity/createEntity` | POST | INSERT root row — system cols (id, created_at, updated_at) stripped automatically |
| `/api/v1/serv/entity/updateEntity` | POST | UPDATE root row — patch (default) or replace mode — children unaffected |
| `/api/v1/serv/entity/upsertEntity` | POST | INSERT ... ON CONFLICT DO UPDATE — requires `upsert_key` defined in PGC_EntitySchema |
| `/api/v1/serv/entity/deleteEntity` | POST | DELETE root row — CASCADE handles children via FK — gated by `allow_delete` |

**Tier separation:**
- `SERV/table` — system config operations on PGC tables. Used by PROC for workflow state, prompts, etc.
- `SERV/entity` — user domain data operations on PGD tables. Used by PROC for workflow step execution.
