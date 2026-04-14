# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2  
Status: Active development — Session 23 complete  
Last updated: 2026-04-14 (session 23 — Tier 1 repair loop end-to-end, choice gate type, iterator human_gate suspension, LLM response_format, prompt issue tracking, Slack error hardening)

---

## 1. System Purpose

A self-evolving, low-cost cognitive automation brain that:
- Accepts natural language intent from users via Slack (or any UI)
- Uses LLM sparingly — only for novel intents, workflow generation, and schema creation
- Persists generated workflows in PostgreSQL and reuses them — LLM is not called twice for the same problem
- Evolves its own workflows and schemas over time
- Runs at approximately $8–$13/month at household scale — see Section 16 for full cost breakdown

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
- Accessed by Process layer via HTTP API enpoints--no direct imports  
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
over from that point. For example: `CLASSIFY_INTENT` arrives fire-and-forget,
`classify-intent.mjs` resolves the intent, and if it matches a named workflow it
enqueues `WORKFLOW_STEP execute_top` with the new `workflowRunId`. The
`CLASSIFY_INTENT` message never directly drives the Step Processor stack.

**Category 2 — Workflow execution messages**
All have `type: WORKFLOW_STEP` and always carry a `workflowRunId`. Drive the Step
Processor's execution stack one frame at a time. The one-SQS-message-per-`workflowRunId`
rule applies exclusively to this category — it has no meaning for fire-and-forget
entry messages, which carry no run ID and are consumed once.

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

| type | Posted by callback.mjs as |
|---|---|
| `PING_SQS_RESULT` | Plain text threaded reply |
| `PING_E2E_RESULT` | Plain text threaded reply with RDS version |
| `CREATE_DOMAIN_RESULT` | Plain text threaded reply with table list |
| `HELP_GATE` | Block Kit message with confirm/cancel buttons |
| `HELP_RESULT` | Plain text threaded reply |
| `SERV_NOTIFICATION` | Plain text threaded reply |
| `WORKFLOW_NOTIFY` | Plain text threaded reply — used for intent classification results and unexecutable CRUD intents |

**Design decisions:**
- `BatchSize: 1` — one message per invocation keeps Slack post ordering clean
  and avoids hitting the Slack API rate limit under burst conditions.
- `callback.provider` routing — `routeCallback()` in `callback.mjs` switches on
  provider. Adding Teams or webhook support is one new `case` with no other changes.
- PROC never imports `@slack/web-api` — all Slack SDK code is isolated to
  `SlackCallbackListenerFunction` and `SlackbotFunction`.

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
│   │       ├── handler.mjs           Lambda entry point — HTTP dispatch only
│   │       ├── ping.mjs              /ping-api
│   │       ├── ping-sqs.mjs          /ping-sqs
│   │       ├── ping-llm.mjs          /ping-llm
│   │       ├── ping-e2e.mjs          /ping-e2e
│   │       ├── create-domain.mjs     /create-domain — ACK + SQS enqueue only
│   │       ├── mind.mjs              /mind — ACK + CLASSIFY_INTENT SQS enqueue only
│   │       └── callback.mjs          SQS CallbackResults consumer — Slack reply
│   │
│   ├── proc/                         Process tier — business logic only
│   │   ├── handler.mjs               Lambda entry — HTTP + SQS dual dispatch
│   │   │                             Detects event.Records vs event.httpMethod
│   │   │                             NO AWS SDK imports
│   │   ├── ping-llm.mjs              /proc/ping-llm
│   │   ├── create-domain.mjs         /proc/create-domain — transport-agnostic
│   │   ├── design-domain.mjs         /proc/design-domain — LLM call, no DB writes
│   │   ├── run-workflow.mjs          /proc/run-workflow — Step Processor entry point
│   │   ├── step-executor.mjs         Step type handlers — llm_call, human_gate, serv_schema, etc.
│   │   ├── template-resolver.mjs     Resolves {{key.path}} against local_state
│   │   ├── classify-intent.mjs       /proc/classify-intent — Intent Preprocessor
│   │   ├── classify-intent-tiers.mjs Pure functions — matchIntentMap, matchWorkflowByKeywords,
│   │   │                             extractSearchTerm, matchCrudVerb — no I/O
│   │   ├── delete-domain.mjs         /proc/delete-domain — drops PGD tables + registry
│   │   ├── shutdown.mjs              /proc/shutdown
│   │   ├── migrations/               One-time DB seed scripts — run manually
│   │   │   └── seed-*.mjs
│   │   └── scaffolds/                Phase 2b only — deleted when LLM takes over
│   │       └── recipes.json
│   │
│   ├── serv/                         Service tier — DB access only
│   │   ├── handler.mjs               Lambda entry — HTTP dispatch only
│   │   ├── ping-db.mjs               /serv/ping-db
│   │   ├── schema.mjs                /serv/schema/* — DDL
│   │   ├── table.mjs                 /serv/table/* — DML
│   │   ├── init-brain.mjs            Bootstrap — PGC table creation + seeding
│   │   └── templates/
│   │       └── pgc/                  JSON table definitions imported at build time
│   │           ├── PGC_Schema.json
│   │           ├── PGC_TableMap.json
│   │           └── ...
│   │
│   └── shared/                       Cross-cutting utilities — no business logic
│       ├── lambda-utils.mjs          parseEvent, ok, err — used by all Lambda handlers
│       └── sqs-callback.mjs          enqueueCallback() — ONLY place @aws-sdk/client-sqs
│                                     lives in ProcFunction
│
├── docs/
│   └── architecture.md
├── template.yaml                     SAM/CloudFormation — infrastructure only
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
- `llm-client.mjs` — `callLlm()`, `callLlmWithCorrection()` — shared LLM caller
- `serv-client.mjs` — `servPost()`, `getRows()`, `insertRow()`, `updateRows()` — shared SERV HTTP client

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

**Why exp→proc and proc→serv go through HTTP :**
To preserve the 3 layer Mule-soft architecture: Experience, Process and Service Layers
In AWS, they are separate Lambdas, HTTP  through API Gateway is the only
transport-agnostic option that keep the layers individually testable
via testing tool like curl and Postman without AWS infrastructure.

**`req.callback` vs `req.body.callback` — critical SQS pattern:**

`buildReqFromSqs()` destructures the SQS message envelope explicitly:
```js
const { type, traceId, callback, ...rest } = message;
return { ..., body: rest, callback: callback ?? null, traceId, ... };
```

This means `callback` is always at `req.callback` — **never** at `req.body.callback`.
`req.body` contains only the remaining fields after `type`, `traceId`, and `callback`
are lifted out. Every PROC endpoint that reads callback from an SQS message must use:
```js
const callback = req.callback ?? req.body?.callback ?? null;
```
The `req.body?.callback` fallback handles HTTP test calls that include callback in the
request body directly. Without this pattern, callback will be `undefined` on the SQS
path and the SlackCallbackListenerFunction will receive `provider: undefined`.

**When adding a new PROC endpoint:**
1. Create `src/proc/<endpoint-name>.mjs` — export `handle(req)`
2. Add `case '<endpoint-name>': return handle(req)` to HTTP switch in `handler.mjs`
3. Add `case '<SQS_MESSAGE_TYPE>': return handle(buildReq(message))` to SQS switch
4. Document in `openapi.yaml` spec-first
5. Never import AWS SDK in the endpoint module
6. Read callback as `req.callback ?? req.body?.callback ?? null` — never `req.body.callback`


### 3.6 Transport-agnostic endpoint pattern — IMPORTANT

`ProcFunction` endpoint modules are called identically whether the request
arrived via HTTP (API Gateway) or SQS (WorkflowQueue). This is the core of
the Mulesoft process tier principle — business logic is transport-agnostic.

**How it works:**

`handler.mjs` detects the event source and routes accordingly:

```js
// ProcFunction handler.mjs entry point
export async function handler(event) {
  if (event.Records) {
    return processSqsBatch(event.Records);   // SQS WorkflowQueue trigger
  }
  return processHttpRequest(event);          // API Gateway trigger
}
```

`processSqsBatch` iterates the SQS batch, calls `buildReqFromSqs` on each record
to produce the same normalised `req` object that `parseEvent` produces from HTTP
events, then dispatches to the same endpoint modules. Batch failures are collected
and returned in `batchItemFailures` so only failed records return to the queue.

```js
async function processSqsBatch(records) {
  const failures = [];
  for (const record of records) {
    try {
      const message = JSON.parse(record.body);
      const req     = buildReqFromSqs(message);   // normalise — same shape as HTTP req
      await dispatch(req);                         // same switch as HTTP path
    } catch (err) {
      console.error('proc: SQS record failed', { messageId: record.messageId, err });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
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

The endpoint function `classifyIntent(req)` never imports AWS SDK or Slack SDK.
It contains only business logic and HTTP fetch calls to SERV and LLM.

**The one difference — response path:**

The endpoint checks `req.source` to determine how to deliver results:

```js
// src/proc/classify-intent.mjs
export async function handle(req) {
  const result = await doClassification(req.body);

  if (req.source === 'http') {
    return ok(result, req.traceId);          // JSON response to API Gateway caller
  }

  // SQS — hand off to downstream workflow or enqueue WORKFLOW_NOTIFY
  await handoff(result, req.callback, req.traceId);
}
```

This pattern means every PROC endpoint is:
- **Directly testable** — no SQS, no Slack required
- **Callable from Slack** — via SQS async path
- **Cloud-agnostic** — no AWS SDK in the endpoint module itself
- **Single source of truth** — one function, two transports, identical business logic

---

## 4. Data Architecture

### 4.1 One PostgreSQL Instances, two login URLs

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
idempotent — safe to call again if needed. It is NOT called automatically on
Lambda cold start. Running bootstrap on cold start caused PostgreSQL
`tuple concurrently updated` errors when multiple Lambda containers initialised
simultaneously and raced to seed the same rows.

`serv/handler.mjs` routes `case 'bootstrap': return bootstrap(req)` — the
same one-line delegation pattern as all other SERV routes. `bootstrap(req)`
returns `ok()`/`err()` directly, following the established SERV handler pattern.

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

Bootstrap template files live in `src/serv/templates/pgc/` and are imported as ES module
static imports — NOT read via `fs.readFile` at runtime.

### 4.3 PGC System Tables
#### 4.3.1 PGC Schema Registry Tables
##### PGC_Schema
Registry of ALL table definitions — both system (PGC) and user domain (PGD).
Every table in the system has a row here including the system tables themselves (self-referential).

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| table_name | text UNIQUE | Quoted in SQL |
| target | text | `pgc` or `pgd` |
| domain | text | ✦ Domain this table belongs to — e.g. `recipes`, `stock_portfolio`. NULL for system tables |
| description | text | |
| columns | jsonb | Array of ColumnDefinition |
| foreign_keys | jsonb | Array of ForeignKeyDefinition |
| constraints | jsonb | Array of ConstraintDefinition |
| triggers | jsonb | Array of TriggerDefinition |
| created_at | timestamptz | |
| updated_at | timestamptz | Auto-updated by trigger |

##### PGC_TableMap
SERV-Table security gatekeeper. SERV-Table rejects writes to any table not registered here.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| table_name | text UNIQUE | |
| target | text | `pgc` or `pgd` |
| domain | text | ✦ Mirrors `PGC_Schema.domain` — denormalised for gatekeeper queries without join |
| schema_id | integer FK | → PGC_Schema.id, ON DELETE RESTRICT |
| allow_insert | boolean | Default true |
| allow_update | boolean | Default true |
| allow_delete | boolean | Default false |
| views | jsonb | SQL view definitions |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_EntitySchema
Defines business entities that span multiple PGD tables.
SERV-Entity reads this to build `jsonb_agg` queries and execute entity-level DML.
Populated at runtime by `/create-domain`. Empty on fresh bootstrap.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| entity_name | text UNIQUE | e.g. "Recipe" |
| description | text | |
| root_table | text | Primary PGD table for the entity — e.g. `PGD_Recipes` |
| joins | jsonb | Array of EntityJoin — related tables to LEFT/INNER JOIN for read operations |
| aggregations | jsonb | Array of EntityAggregation — jsonb_agg columns to assemble in read results |
| filters | jsonb | Default row-level filters always applied to this entity |
| upsert_key | jsonb | ✦ Array of column names forming the natural unique key — e.g. `["ticker"]`. Empty array means upsert not supported. Must match an existing UNIQUE constraint on root_table |
| created_at | timestamptz | |
| updated_at | timestamptz | Auto-updated by trigger |

##### PGC_DomainHelp
User-facing command aliases and help text per domain.
Powers `/help {domain}` responses and Pass 2 domain alias matching in the Intent Preprocessor.
Populated at runtime by PROC when a domain is created. The `aliases` array is
human-reviewed and confirmed via a gate step in the `create_domain` workflow before
being written — aliases are not assumed from LLM output alone.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| domain | text UNIQUE | e.g. "recipes" |
| aliases | jsonb | e.g. ["recipe", "cooking"] — human-confirmed at domain creation |
| description | text | |
| commands | jsonb | Array of command definitions with examples |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

#### 4.3.2 PGC Workflow Tables

These six tables support the PROC layer workflow execution engine.

##### PGC_Workflow
Stores reusable workflow definitions generated by LLM or created manually.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE | e.g. `deduct_inventory` |
| domain | text | Domain this workflow belongs to. NULL for system/cross-domain workflows |
| description | text | |
| intent_keywords | jsonb | Authoritative verb vocabulary for Pass 2 domain-workflow lookup — token-based scan in `matchWorkflowByKeywords()`. Data-driven: adding a verb here requires no code change. e.g. `["get","find","show","fetch","lookup"]` for `get_<domain>` workflows |
| intent_embedding | vector | For pgvector similarity matching (Backlog) |
| steps | jsonb | Array of StepDefinition (see Section 6.2) |
| state_strategy | text | `fire_and_forget`, `sequential`, `sequential_with_confirmation` |
| confirmation_required_at | jsonb | Step indices requiring human gate |
| js_extensions | jsonb | Optional sandboxed JS for complex steps (Option C) |
| model_used | text | Which LLM generated this workflow |
| quality_score | numeric | Human or auto-rated |
| max_execution_ms | integer | Guard 2 ceiling. NULL = use system default from PGC_SystemContext `guardrail_defaults` |
| max_steps_per_window | integer | Guard 1 threshold. NULL = use system default |
| window_seconds | integer | Guard 1 window duration. NULL = use system default |
| version | integer | |
| parent_workflow_id | integer FK | Self-referential — workflow evolution history |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_WorkflowRun
One row per workflow execution. Holds the execution stack, accumulated state,
callback routing, and runtime safety counters.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| workflow_id | integer FK | → PGC_Workflow.id |
| trace_id | text | Correlation ID carried end-to-end from Slack message through all hops. Replaces `workflowId` in SQS payloads |
| triggered_by | text | `slack`, `api`, `workflow`, `system` — who initiated this run |
| status | text | `pending`, `running`, `awaiting_confirmation`, `awaiting_human_gate`, `completed`, `failed`, `cancelled` |
| input | jsonb | Original user intent + parameters |
| stack | jsonb | Execution stack — array of FrameDefinition (see Section 6.3). Controls frame flow only |
| state | jsonb | Accumulated cross-step data bag. Steps write `output_key` values here; subsequent steps read from here. Copied to `output` at run completion |
| output | jsonb | Final workflow output — copied from `state` at completion |
| callback | jsonb | Provider-agnostic UI callback — `{ provider, channel, threadId }` |
| total_execution_ms | integer | Running sum of all step `duration_ms` values. Incremented in same UPDATE as stack write. Used by Guard 2 |
| step_count | integer | Total steps executed this run. Incremented in same UPDATE as stack write |
| steps_in_window | integer | Steps executed since last `human_gate` completion. Reset to 0 when a human_gate step completes. Used by Guard 1 |
| window_started_at | timestamptz | Timestamp when current velocity window started. Reset with `steps_in_window`. Used by Guard 1 |
| error | jsonb | Last error details |
| started_at | timestamptz | |
| completed_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_WorkflowRunStep
Append-only audit log — one row per step execution attempt. Never updated after insert.
Used for idempotency checks on SQS redelivery and debugging.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| run_id | integer FK | → PGC_WorkflowRun.id |
| frame_id | text | UUID of the frame that executed |
| step_number | integer | |
| step_type | text | |
| capability_key | text | → PGC_Capability.capability_key — which capability was exercised. NULL for built-in step types |
| status | text | `completed`, `failed`, `skipped` |
| retry_count | integer | Attempts before this final status. Default 0. Supports idempotency debugging |
| input_snapshot | jsonb | What was passed in |
| output_snapshot | jsonb | What came out |
| error | jsonb | Error details if failed |
| duration_ms | integer | |
| executed_at | timestamptz | |

##### PGC_Prompt
Stores LLM prompts with versioning and quality tracking for self-improvement.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| intent_category | text | e.g. `create_domain`, `design_table`, `create_workflow` |
| prompt_text | text | Actual prompt sent to LLM |
| input_variables | jsonb | Variables this prompt expects — `[{ name, description, required }]`. Documents contract for prompt improvement |
| output_schema | jsonb | Expected JSON shape of the LLM response. Used to validate output and guard downstream steps |
| output_sample | jsonb | Representative successful output stored on first clean run. Used for regression checking when prompt is evolved |
| model | text | Which LLM was used |
| version | integer | |
| parent_prompt_id | integer FK | Self-referential — prompt evolution history |
| was_successful | boolean | |
| quality_score | numeric | |
| error_log | jsonb | Structured: `{ attempts: [{ at, error_type, error_message, llm_raw_output, recovery_action }] }` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_IntentMap
Maps user input patterns to workflows or action types for the Intent Preprocessor.
Rows are seeded at bootstrap for system-level intents, and written at runtime by
`create_workflow` completion for user-defined workflows.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| pattern | text | Regex or keyword pattern — e.g. `create.domain\|new.domain\|build.domain` |
| intent_category | text | |
| workflow_id | integer FK | → PGC_Workflow.id (nullable — some intents are ad-hoc) |
| action_type | text | `crud`, `workflow`, `heavy_lift` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**How PGC_IntentMap and PGC_DomainHelp divide the work:**

These two tables answer different questions and are consulted in a strict order by the Intent Preprocessor (see Section 6.3).

`PGC_IntentMap` answers: "Is this a known system-level or registered workflow intent?" — create domain, create workflow, help, or any user-defined workflow. Its patterns are written by developers (bootstrap seed) or by the brain itself when a new domain is created. It has no FK to `PGC_Workflow` — routing uses `action_type` + `intent_category` name lookup in `handoff()`. Pass 1 in the pipeline — always runs first.

`PGC_DomainHelp` answers: "Does the user's input mention something in their personal data?" — stocks, recipes, meals, budget. It has no FK to `PGC_Workflow` and no awareness of workflows. It only knows that "stocks", "portfolio", and "holdings" all mean `stock_portfolio`. Pass 2 in the pipeline — only consulted when no `PGC_IntentMap` pattern matched. Once a domain is resolved from `PGC_DomainHelp`, the preprocessor runs a workflow keyword scan against `PGC_Workflow.intent_keywords` for that domain, then falls back to CRUD detection or Tier 2.

The handoff is one-way and ordered: `PGC_IntentMap` always runs first. A match short-circuits — `PGC_DomainHelp` is never read.

**Intent Preprocessor tuning surface:**

When classification misbehaves, most fixes are now data changes — no code deploys required:

| Symptom | Which pass | Fix |
|---|---|---|
| System-level intent misrouted or missed | Pass 1 | Update `PGC_IntentMap.pattern` regex |
| Domain not recognised from user input | Pass 2 | Update `PGC_DomainHelp.aliases` for that domain |
| Domain workflow not triggered by natural phrasing | Pass 2 | Add verb to `PGC_Workflow.intent_keywords` for that workflow — no code change |
| Novel verb not recognised for any domain workflow | Pass 2 | Add verb to `PGC_Workflow.intent_keywords` — no code change |
| Structured `field=value` CRUD not detected | Pass 2 CRUD fallback | Update `matchCrudVerb()` in `classify-intent-tiers.mjs` |
| Domain resolved but correct workflow not matched | Pass 2 | Enrich `intent_keywords` across that domain's workflows |
| Novel phrasing reaches Tier 2 too often | Pass 2 (Backlog) | Populate `PGC_Workflow.intent_embedding` via pgvector — semantic match supersedes keyword scan |
| Aliases outdated after domain changes | Pass 2 | Phase 2 item 4c — `/mind edit aliases for <domain>` management workflow |

The alias management workflow (`/mind edit aliases for recipes`) is a Phase 2 item.
Until it exists, aliases can be updated directly in `PGC_DomainHelp` via the SERV table endpoint.

##### PGC_WorkflowRunLock
Reserved for future parallel execution — optimistic locking. NOT used in sequential mode.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| run_id | integer FK UNIQUE | → PGC_WorkflowRun.id, CASCADE |
| locked_by | text | Lambda request ID |
| locked_at | timestamptz | |
| version | integer | Incremented on every stack update |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

#### 4.3.3 PGC Intelligence Tables — LLM Runtime Context

These three tables exist solely to make the LLM effective at runtime.
They are injected into heavy-lift prompts by PROC before calling the LLM.
None of them affect workflow execution — they are read-only from the execution
engine's perspective.

##### PGC_SystemContext
Compact runtime self-description of the system. Injected into every heavy-lift LLM
prompt so the model knows what it is operating inside, what it can do, and what the
rules are. Replaces `architecture.md` at runtime. Seeded on bootstrap.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| key | text UNIQUE | Logical name — e.g. `system_overview`, `naming_conventions`, `allowed_column_types`, `serv_endpoints`, `guardrail_defaults` |
| section | text | Groups related keys — e.g. `architecture`, `rules`, `endpoints`, `schema` |
| content | text | The actual context text — plain prose or compact JSON. Injected verbatim into prompts |
| format | text | `prose` or `json` — tells the prompt builder how to format this block |
| inject_always | boolean | If true, always injected into heavy-lift prompts regardless of intent. Default false |
| inject_for | jsonb | Array of `intent_category` values this context is injected for. NULL = use `inject_always` only |
| version | integer | Incremented when content is updated by LLM or operator |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**Bootstrap seed rows:**

| key | section | format | inject_always | content summary |
|---|---|---|---|---|
| `system_overview` | `architecture` | `prose` | true | What this system is and how it works |
| `naming_conventions` | `rules` | `prose` | true | PGC_/PGD_ prefixes, quoting rules, snake_case domains |
| `allowed_column_types` | `rules` | `json` | false | Whitelist of valid column types for createTable |
| `serv_endpoints` | `endpoints` | `json` | false | All SERV endpoints with request/response shapes |
| `sqs_message_format` | `schema` | `json` | false | SQS message envelope — type, traceId, callback, action |
| `guardrail_defaults` | `rules` | `json` | true | `{ "max_steps_per_window": 20, "window_seconds": 10, "max_execution_ms": 300000, "extension_minutes": 5 }` |

##### PGC_StepType
Canonical catalogue of all valid workflow step types with their input/output contracts.
Seeded on bootstrap. Injected into workflow generation and improvement prompts so the
LLM produces valid step definitions.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| step_type | text UNIQUE | e.g. `serv_query`, `llm_call`, `human_gate`, `js_transform`, `notify`, `end` |
| description | text | Human and LLM readable explanation of what this step does |
| input_contract | jsonb | Required and optional fields — `[{ field, type, required, description }]` |
| output_contract | jsonb | Fields produced — `[{ field, type, description }]`. NULL for steps with no output (e.g. `notify`) |
| on_success_options | jsonb | Valid values for `on_success` — e.g. `["next", "end", "step:N"]` |
| on_failure_options | jsonb | Valid values for `on_failure` |
| requires_capability | text | → PGC_Capability.capability_key — NULL if always available |
| status | text | `live`, `planned`, `deprecated` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_Capability
Registry of what this system can currently do. Injected into heavy-lift prompts so the
LLM proposes only feasible workflows and gives honest answers when asked for something
not yet supported.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| capability_key | text UNIQUE | e.g. `serv_table_insert`, `slack_notify`, `llm_agent_call`, `human_gate`, `js_transform` |
| category | text | `serv`, `notify`, `llm`, `ui`, `execution` |
| description | text | What this capability does — LLM readable |
| status | text | `live`, `planned`, `not_supported` |
| available_in | jsonb | Which Lambda functions expose this — e.g. `["proc", "serv"]` |
| notes | text | Constraints, limits, or caveats — e.g. `"js_transform requires security gate approval"` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

#### 4.3.4 PGC Session Tables

Two tables that give the brain persistent conversational memory, scoped to a
Slack thread (or any other UI thread). Together they form the session layer —
the foundation for context-aware intent classification and the right-brain
improvement loop.

These tables are Backlog. They are defined here so their design informs the
Intent Preprocessor and Step Processor contracts now.

##### PGC_Session
One row per conversation thread. Created by PROC when a `/mind` message arrives
with no existing session for that thread. The identity key is a UUID generated by
the Experience tier — not `thread_ts`, which is Slack-specific and must not be a
database primary key.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| session_id | text UNIQUE | UUID generated by `mind.mjs` on first message in a thread |
| callback | jsonb | Provider-agnostic routing — `{ provider, channel, threadId }`. `threadId` = Slack `thread_ts`. Same pattern as `PGC_WorkflowRun.callback` |
| status | text | `active`, `idle`, `closed` |
| created_at | timestamptz | |
| last_active_at | timestamptz | Updated on every new entry — not `updated_at`, since sessions are append-driven |

**Why `session_id` is a UUID and not `thread_ts`:** `thread_ts` is a Slack
concept. Storing it as the PK would make `PGC_Session` Slack-coupled — a Teams
or webhook UI would have no `thread_ts`. The UUID is the session identity.
`thread_ts` lives inside `callback.threadId` alongside every other UI-specific
routing field. Adding Teams or any other UI later requires zero schema changes.

**Session lookup by Experience tier:**
`mind.mjs` performs one SERV read before enqueuing — a `getRows` on `PGC_Session`
filtering by `callback.threadId = thread_ts`:
- Found → retrieve `session_id`, pass in `CLASSIFY_INTENT` SQS message
- Not found → generate new UUID, PROC creates `PGC_Session` row on receipt

##### PGC_SessionEntry
Append-only log of everything that happened in a session — user messages,
assistant replies, and system activity summaries. Never updated after insert.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| session_id | integer FK | → PGC_Session.id |
| entry_type | text | `message` — conversational turn. `activity` — workflow milestone summary |
| role | text | `user`, `assistant`, `system` |
| content | text | Plain text. Injected verbatim into LLM prompts — no JSON transformation needed |
| workflow_run_id | integer FK | → PGC_WorkflowRun.id. Nullable — `message` entries have no run |
| created_at | timestamptz | |

**`message` entries** are written by `classify-intent.mjs` — one row for the
user's input, one for the assistant's classification response or workflow
handoff summary.

**`activity` entries** are written automatically by the Step Processor at two
points — no workflow definition changes required:
- At every `end` step: the `notify` step's resolved `message_template` text is
  reused as the activity summary. The same text the user sees in Slack becomes
  the session record of what happened. No new step type. No new LLM call.
- At every `confirm` gate resolution: a one-line summary is written — "User
  confirmed: [gate message text]". Gives follow-up LLM calls a factual record
  of what the user approved at each decision point.

**Append-only rationale:** Session entries are evidence. Updating them would
destroy the audit trail. All reads are forward-sequential — no update path
is needed.

**PGC_WorkflowRun FK:**
`PGC_WorkflowRun` gains a `session_id` FK column (→ PGC_Session.id, nullable).
A `WorkflowRun` originating from `/mind` always has `session_id` populated.
A `WorkflowRun` originating from a direct HTTP call (curl testing, API) has
`session_id: null`. The FK is formal — not a soft `thread_ts` string link —
because multiple workflow runs can belong to the same session and that
relationship needs to be queryable.

---

#### 4.3.5 PGC_WorkflowStats — SQL View

Not a physical table. Queried by PROC only when building LLM prompts for workflow
evaluation or improvement. Not on the execution hot path — guards operate on
`PGC_WorkflowRun` columns updated in-transaction with the stack write.
Registered in `PGC_TableMap.views` on the `PGC_WorkflowRun` row.
```sql
CREATE OR REPLACE VIEW "PGC_WorkflowStats" AS
SELECT
  workflow_id,
  COUNT(*)                                             AS run_count,
  COUNT(*) FILTER (WHERE status = 'failed')            AS failure_count,
  COUNT(*) FILTER (WHERE status = 'completed')         AS success_count,
  COUNT(*) FILTER (WHERE status = 'cancelled')         AS cancelled_count,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'failed')::numeric
    / NULLIF(COUNT(*), 0) * 100, 1
  )                                                    AS failure_rate_pct,
  MAX(created_at)                                      AS last_run_at,
  (ARRAY_AGG(status ORDER BY created_at DESC))[1]      AS last_status,
  AVG(total_execution_ms)
    FILTER (WHERE status = 'completed')                AS avg_execution_ms
FROM "PGC_WorkflowRun"
GROUP BY workflow_id;
```

---

#### 4.3.6 Updated PGC Table Count

| # | Table | Status |
|---|---|---|
| 1 | PGC_Schema | `domain` column added |
| 2 | PGC_TableMap | `domain` column added |
| 3 | PGC_EntitySchema | `upsert_key` column added |
| 4 | PGC_DomainHelp | aliases human-confirmed at domain creation (see Section 6.8) |
| 5 | PGC_Workflow | `domain`, `max_execution_ms`, `max_steps_per_window`, `window_seconds` added |
| 6 | PGC_WorkflowRun | `trace_id`, `triggered_by`, `state`, `total_execution_ms`, `step_count`, `steps_in_window`, `window_started_at`, `session_id` added |
| 7 | PGC_WorkflowRunStep | `capability_key`, `retry_count` added |
| 8 | PGC_Prompt | `input_variables`, `output_schema`, `output_sample`, `error_log` added |
| 9 | PGC_IntentMap | written at runtime by create_workflow completion |
| 10 | PGC_WorkflowRunLock | unchanged |
| 11 | PGC_SystemContext | new |
| 12 | PGC_StepType | new |
| 13 | PGC_Capability | new |
| 14 | PGC_Session | Backlog — session identity, UI-agnostic, UUID keyed |
| 15 | PGC_SessionEntry | Backlog — append-only conversational + activity log |
| — | PGC_WorkflowStats | SQL view — not a physical table |

**Total: 13 physical PGC tables (bootstrapped) + 2 session tables (Backlog) + 1 view**


---

#### 4.3.7 Dev Scripts — PGC Data Management

These scripts in `dev_scripts/` manage the authoritative data that drives the brain's
intelligence at runtime. They are not part of the Lambda deployment — they run locally
against the live PGC database to push, update, or export seed data.

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

---

##### `upsert-prompt.mjs`

Pushes prompt definitions from `src/serv/templates/pgc/seeds/seed_PGC_Prompt.json`
into `PGC_Prompt`.

**When to run:** After any change to `seed_PGC_Prompt.json` — new prompts, version
bumps, output schema changes. Must be run before the new prompt version is active at
runtime, since the Step Processor loads prompts from the DB at execution time
(`ORDER BY version DESC LIMIT 1` per `intent_category`).

**Idempotency:** Uses `WHERE NOT EXISTS ON (intent_category, version)` — safe to
re-run. Existing rows at the same version are not overwritten. Bump the version number
to deploy a changed prompt. Old versions are retained as history.

**Key behaviour:**
- Writes `prompt_text`, `output_schema`, `input_variables`, `model`, `version`
- `error_log` and `output_sample` are never written by this script — those are
  populated by the right-brain improvement loop (Backlog)

**Argument:** `intent_category` name — e.g. `upsert-prompt.mjs generate_workflow_steps`.
Omit to push all prompts in the seed file.

---

##### `upsert-workflow.mjs`

Pushes workflow definitions from `src/serv/templates/pgc/seeds/seed_PGC_Workflow.json`
into `PGC_Workflow`.

**When to run:** After any change to `seed_PGC_Workflow.json` — new workflows, step
changes, version bumps. Required on every fresh brain instance after `bootstrap` since
`init-brain.mjs` seeds with `ON CONFLICT DO NOTHING` and will not overwrite step
arrays that were already seeded.

**Argument:** A workflow `name` argument is **required** when targeting a specific
workflow — e.g. `upsert-workflow.mjs create_workflow`. Without an argument the script
upserts all workflows in the seed file. Prefer the targeted form on live systems to
avoid touching workflows that have active runs.

**Idempotency:** Update if exists (`updateRows`), insert if not. Matches on `name`.
Safe to re-run — the script reads the current DB state before deciding insert vs update.

**Key behaviour:**
- Writes `name`, `domain`, `description`, `intent_keywords`, `steps`, `state_strategy`,
  `model_used`, `version`
- Domain-generated workflows are written at runtime by `create_domain` — this script
  only manages system workflows (`create_domain`, `help`, `create_workflow`, and the
  five generic `*_entity` workflows)

---

##### `upsert-step-type.mjs`

Pushes step type definitions from `src/serv/templates/pgc/seeds/seed_PGC_StepType.json`
into `PGC_StepType`.

**When to run:** When a step type's contract changes — new input fields, corrected
description, status change from `planned` to `live`. Run before `upsert-system-context.mjs`
when adding a new step type, so the injected `step_type_contracts` context is current.

**Idempotency:** Update if exists, insert if not. Matches on `step_type`. Unlike prompts,
step type contracts are authoritative in the seed file and always overwrite live rows —
there is no right-brain improvement loop for step type contracts.

**What it seeds:** 16 live step types, each with `description`, `input_contract`,
`output_contract`, `on_success_options`, `on_failure_options`, and `status`. These
contracts are injected by `executeLlmCall` into `generate_workflow_steps` and
`analyze_and_design_workflow` so the LLM knows exactly what each step type accepts
and produces.

**Argument:** `step_type` name — e.g. `upsert-step-type.mjs js_transform`.
Omit to push all step types in the seed file.

---

##### `upsert-system-context.mjs`

Pushes key-value context rows from `src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json`
into `PGC_SystemContext`. These rows are injected by `executeLlmCall` into LLM prompts
at runtime based on the `inject_for` array on each row.

**When to run:** After any change to `seed_PGC_SystemContext.json` — updated worked
examples, new usage pattern rows, routing rule changes. Also run after adding a new
step type so `step_type_contracts` is regenerated.

**Idempotency:** `WHERE NOT EXISTS ON key` at bootstrap; update if exists at upsert time.
`init-brain.mjs` preserves live rows on fresh installs to protect right-brain improvements.
`upsert-system-context.mjs` always overwrites — use it to force content updates.

**Rows it manages:**

| Key | inject_for | Purpose |
|---|---|---|
| `step_type_contracts` | `generate_workflow_steps`, `analyze_and_design_workflow`, `create_workflow`, `fix_workflow_steps` | Full step type catalogue — injected so LLM knows the instruction set |
| `routing_value_rules` | `generate_workflow_steps`, `analyze_and_design_workflow`, `generate_workflow_paths`, `create_workflow`, `fix_workflow_steps` | Valid routing tokens and Guard 3 backward reference rule |
| `create_domain_example` | `generate_workflow_steps`, `analyze_and_design_workflow`, `create_workflow` | Annotated `create_domain` + flat loop quiz example — reference for correct step structure |
| `step_usage_patterns` | `generate_workflow_steps`, `analyze_and_design_workflow`, `fix_workflow_steps` | Concrete correct step definitions per type with common mistake notes |
| `runtime_bindings` | `generate_workflow_steps`, `analyze_and_design_workflow` | What the Step Processor injects automatically: `input.*`, `item`, `output_key` lifecycle per gate type, `local_state` in expressions |
| `template_syntax` | `generate_workflow_steps`, `analyze_and_design_workflow` | `{{key}}`, `{{key.field}}`, `{{key.0.field}}`, `{{input.field}}` — resolution rules and silent-empty-on-miss behaviour |
| `workflow_constraints` | `generate_workflow_steps`, `analyze_and_design_workflow`, `fix_workflow_steps` | Structural rules: `end` required, `notify` no on_failure, Guard 3, Guard 1 stuck-step detection |

**Argument:** `key` name — e.g. `upsert-system-context.mjs create_domain_example`.
Omit to push all rows in the seed file.

**Run order when adding a new step type:**
```cmd
node dev_scripts/upsert-step-type.mjs <new_step_type>
node dev_scripts/upsert-system-context.mjs step_type_contracts
```

---
## 5. Service Layer â€” SERV

### 5.1 SERV-Schema (complete)
DDL executor and PGC metadata registry.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/schema/createTable` | POST | Execute DDL + register in PGC_Schema + PGC_TableMap |
| `/api/v1/serv/schema/listTables` | POST | List entries from PGC_Schema, optional target filter |
| `/api/v1/serv/schema/getTable` | POST | Get one entry by tableName |
| `/api/v1/serv/schema/updateTable` | POST | Update metadata in PGC_Schema (NOT ALTER TABLE) |
| `/api/v1/serv/schema/deleteTable` | POST | DROP TABLE + remove from PGC_Schema + PGC_TableMap |

Security gate on `createTable`:
- Column types validated against whitelist (serial, text, integer, jsonb, timestamptz, etc.)
- Table names must match `^(PGC|PGD)_[A-Za-z][A-Za-z0-9_]*$`
- Protected system tables (`PGC_Schema`, `PGC_TableMap`, `PGC_EntitySchema`, `PGC_DomainHelp`) cannot be dropped

### 5.2 SERV-Table (complete)
DML executor gated by `PGC_TableMap`. All four operations live.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/table/getRows` | POST | Parameterised SELECT — filters, orderBy, limit |
| `/api/v1/serv/table/insertRow` | POST | Single INSERT RETURNING * — gated by `allow_insert` |
| `/api/v1/serv/table/updateRows` | POST | Parameterised UPDATE RETURNING * — gated by `allow_update` |
| `/api/v1/serv/table/deleteRows` | POST | Parameterised DELETE — gated by `allow_delete` |

Security gate on all operations:
- Table must be registered in `PGC_TableMap`
- Column names validated against `PGC_Schema.columns` for that table
- Filter operators validated against whitelist (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `is_null`, `not_null`)
- `updateRows` and `deleteRows` require non-empty `filters` — unfiltered mass writes rejected at 400
- `allow_insert`, `allow_update`, `allow_delete` checked per-table from `PGC_TableMap`

**PGC_TableMap defaults:**
- PGC system tables: `allow_insert` varies, `allow_update: true`, `allow_delete: false`
- PGD domain tables: `allow_insert: true`, `allow_update: true`, `allow_delete: true`

`SERV-Table` is used by PROC for all **system config** operations (e.g. `PGC_WorkflowRun`, `PGC_Prompt`).
User domain data operations go through `SERV-Entity` instead.

### 5.3 SERV-Entity (complete)
User-facing domain data layer. Callers use entity names (`Recipe`, `Stock`) — never table names.
`PGC_EntitySchema` defines the `root_table`, `joins`, `aggregations`, `upsert_key`, and default `filters` for each entity.
Used by PROC when executing workflow steps that read or write user domain data.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/entity/getEntity` | POST | Fetch one entity by id — with configured joins and jsonb_agg aggregations |
| `/api/v1/serv/entity/listEntities` | POST | List entities — filters, orderBy, limit — entity default filters always applied |
| `/api/v1/serv/entity/createEntity` | POST | INSERT root row — system cols (id, created_at, updated_at) stripped automatically |
| `/api/v1/serv/entity/updateEntity` | POST | UPDATE root row — `patch` (default) or `replace` mode — children unaffected |
| `/api/v1/serv/entity/upsertEntity` | POST | INSERT ... ON CONFLICT DO UPDATE — requires `upsert_key` defined in PGC_EntitySchema |
| `/api/v1/serv/entity/deleteEntity` | POST | DELETE root row — CASCADE handles children via FK — gated by `allow_delete` |

**Design decisions:**
- Entity operations only touch the root table. Child rows (e.g. `RecipeIngredient`) are managed
  via their own `createEntity` / `deleteEntity` calls with the parent `id` provided explicitly.
- `updateEntity patch` — sets only provided fields, leaves all others unchanged.
- `updateEntity replace` — sets ALL non-system fields from provided data, resetting omitted fields to null.
  Use when replacing an entire entity (e.g. new recipe version) while preserving `id` and child FK relationships.
- `upsertEntity` uses `xmax = 0` to detect true INSERT vs UPDATE without a second DB round-trip.
  `wasInserted: true/false` returned in response.
- `upsert_key` must correspond to an existing `UNIQUE` constraint on the physical root table.
  `/create-domain` is responsible for setting both the DDL constraint and the `upsert_key` together.

**Tier separation:**
- `SERV/table` — system config operations on PGC tables. Used by PROC for workflow state, prompts, etc.
- `SERV/entity` — user domain data operations on PGD tables. Used by PROC for workflow step execution.

### 5.4 SERV services — not yet built
- **SERV-Query** — cross-entity parameterised SELECT with pagination (Backlog)

---

## 6. Process Layer — PROC

`ProcFunction` is the cognitive core of evolving-mind-ai. It owns all business
logic — intent classification, workflow execution, LLM orchestration, and domain
management. It has no knowledge of Slack, no direct database access, and no AWS
SDK imports in its endpoint modules. It receives normalised requests from the
Experience tier (via SQS WorkflowQueue or HTTP), executes against SERV via HTTP,
and routes results back to the UI via the SQS SlackResults queue (SQS path) or
to a future UI HTTP entry point — direct HTTP result delivery is not currently
allowed or implemented.

### The programming language analogy

The Step Processor and workflow system is deliberately designed to resemble a
simple programming language and the runtime that executes it.

| Programming concept | evolving-mind-ai equivalent |
|---|---|
| Program (source code) | `PGC_Workflow.steps` — a JSON array of step definitions |
| Program counter | `frame.current_step` — the string key of the next step to execute |
| Memory / data bag | `frame.local_state` — a plain JSON object on each frame |
| Call stack | `PGC_WorkflowRun.stack` — a JSON array of frames |
| Function call | PUSH a new workflow frame; POP when it returns |
| Loop | Iterator frame — advances `current_index` until all items processed |
| Blocking I/O | `human_gate` frame — suspends the stack until user responds |
| CPU / machine core | Step Processor (`run-workflow.mjs`) — a generic executor with no workflow-specific logic |
| Kernel | Intent Preprocessor (`classify-intent.mjs`) — routes user input to the right program |
| System calls | SERV HTTP calls — the only way the Step Processor reads or writes data |
| Instruction set | Step types — `llm_call`, `serv_query`, `human_gate`, `notify`, etc. |

A workflow author writes a program (a JSON step array) once. The Step Processor
executes it identically every time, across any number of concurrent runs, with no
knowledge of what the program does. This is the same relationship a CPU has with
machine code — the CPU executes instructions; the instructions encode the
programmer's intent.

### Section map

| Section | Topic |
|---|---|
| 6.1 | Process Layer API — HTTP routes and SQS message types |
| 6.2 | Process Layer config tables — PGC as the brain's system memory |
| 6.3 | Intent Preprocessor — two-pass, domain-workflow-aware pipeline |
| 6.4 | Generic CRUD Workflows
| 6.5 | Step Executor — WorkflowRun, execution loop, and all execution subsystems |
| 6.5.1 | Step types — the instruction set |
| 6.5.2 | Execution Stack — the program counter and call stack |
| 6.5.3 | `local_state` — the data bag / memory |
| 6.5.4 | Human-in-the-Loop — blocking I/O |
| 6.5.5 | Parallel execution hooks — deferred, Backlog |
| 6.5.6 | `simulate` step type — workflow path simulation and validation |
| 6.6 | Right-Brain Output Validation — correction loop |
| 6.7 | Workflow Safety — circuit breakers and emergency shutdown |
| 6.8 | create_domain Workflow — full annotated example |
| 6.9 | create_workflow Workflow — Phase 2 |
| 6.10 | Session Architecture — conversational memory (Backlog) |

---

### 6.1 Process Layer API

Every PROC endpoint module exports `handle(req)` and is wired to both an HTTP
route and an SQS message type in `proc/handler.mjs`. The HTTP path is available
for direct testing with curl. The SQS path is the production path.

#### HTTP routes

```
POST /proc/classify-intent     classify-intent.mjs — intent pipeline entry point
POST /proc/run-workflow        run-workflow.mjs    — execute_top | resume_gate | cancel
POST /proc/review-output       review-output.mjs   — right-brain validation (also intra-proc direct import)
POST /proc/create-domain       create-domain.mjs   — direct /create-domain command entry point
POST /proc/create-workflow     create-workflow.mjs — Phase 2
POST /proc/shutdown            shutdown.mjs        — emergency stop
```

#### SQS message types (WorkflowQueue)

```
CLASSIFY_INTENT    → classify-intent.mjs
WORKFLOW_STEP      → run-workflow.mjs       (actions: execute_top | resume_gate | cancel)
CREATE_DOMAIN      → create-domain.mjs
CREATE_WORKFLOW    → create-workflow.mjs
```

#### SQS message format (WORKFLOW_STEP)

```json
{
  "type":          "WORKFLOW_STEP",
  "workflowRunId": 42,
  "action":        "execute_top | resume_gate | cancel",
  "userResponse":  "confirm | cancel | remove_item | ...",
  "responseData":  { "tableName": "...", "inputValue": "..." },
  "traceId":       "uuid"
}
```

**One message per step.** Each `execute_top` message executes exactly one step,
then enqueues the next `execute_top`. This gives the stack one SQS hop per
instruction — analogous to a single CPU clock cycle.

#### Callback / notification abstraction

All results flow back to the UI via `callback: { provider, channel, threadId }`.
`routeCallback()` in `callback.mjs` dispatches on `provider`. Adding a new UI
(Teams, web) is one new `case` in that function. SERV never reads callback fields.

The callback abstraction handles two distinct message types flowing back to the UI:

- **WORKFLOW_NOTIFY / WORKFLOW_ERROR / WORKFLOW_CANCELLED** — completion and status
  messages posted as Slack thread replies. These are fire-and-forget.
- **WORKFLOW_GATE** — a human gate suspension event. The Step Processor builds a
  structured dialog payload and enqueues it via the same callback path. `callback.mjs`
  translates the UI-agnostic `WORKFLOW_GATE` message into Slack Block Kit blocks and
  posts the interactive message to the thread. The user's interaction with that message
  is what resumes the suspended stack. See Section 6.5.4 for the full gate lifecycle and message contract.

---

### 6.2 Process Layer config tables — PGC as system memory

The PGC database (`pgc`) is the brain's persistent system memory. The Step
Processor and Intent Preprocessor are stateless Lambda functions — they carry no
in-process memory between invocations. Everything they need to operate is loaded
from PGC at runtime.

#### Tables and their roles in the Step Processor

| Table | Role | Read by | Written by |
|---|---|---|---|
| `PGC_Workflow` | Program store — stores the step array for every workflow. `intent_keywords` is the authoritative verb vocabulary for Pass 2 domain-workflow lookup | Step Processor, Intent Preprocessor (Pass 2, pre-loaded) | `upsert-workflow.mjs` / create_workflow workflow |
| `PGC_WorkflowRun` | Process control block — stack, status, state, callback for each run | Step Processor | Step Processor |
| `PGC_WorkflowRunStep` | Audit log — one row per step execution, used for idempotency | Step Processor | Step Processor |
| `PGC_Prompt` | Prompt store — `prompt_text`, `output_schema`, `model`, `error_log` per intent | Step Processor (llm_call steps) | `upsert-prompt.mjs` / right-brain |
| `PGC_IntentMap` | Intent routing table — regex patterns → `intent_category` + `action_type`. Structurally independent from `PGC_Workflow` — no `workflow_id` FK. Routing uses `action_type` + `intent_category` name lookup | Intent Preprocessor | `create_domain` workflow (step 10) |
| `PGC_DomainHelp` | Domain registry — aliases, description, CRUD commands per domain | Intent Preprocessor | `create_domain` workflow (step 8) |
| `PGC_Schema` | Schema registry — column definitions per PGD table | SERV (column validation) | `create_domain` workflow (DDL iterator) |
| `PGC_TableMap` | Table routing — maps table names to their database target | SERV (insertRow gate) | `create_domain` workflow (DDL iterator) |
| `PGC_SystemContext` | System-wide config — thresholds, defaults, feature flags | Step Processor, Preprocessor | `init-brain.mjs` / admin |
| `PGC_StepType` | Step type registry — canonical list of valid step types | Right-brain (Backlog) | `init-brain.mjs` |
| `PGC_Capability` | Capability registry — available tools the brain can invoke | Right-brain (Backlog) | `init-brain.mjs` |
| `PGC_WorkflowStats` | Aggregate view — run counts, failure rates per workflow | Right-brain, monitoring | DB view (auto-maintained) |

#### How these tables are used together in a workflow run

When `create_domain` runs, the Step Processor:

1. Reads `PGC_Workflow` once to load the step array — this is the program
2. Reads `PGC_Prompt` at each `llm_call` step to get the prompt text and schema
3. Writes `PGC_WorkflowRun.stack` and `.state` after every step — persisting the program counter and data bag
4. Writes `PGC_WorkflowRunStep` after every step — idempotency audit log
5. Calls SERV which reads `PGC_Schema` and `PGC_TableMap` to validate and route inserts
6. At the end of the workflow, writes `PGC_DomainHelp`, `PGC_Workflow` (4 CRUD workflows), `PGC_IntentMap` (4 rows — pattern + intent_category + action_type, no workflow_id), and `PGC_EntitySchema` (entity join/aggregation definitions) — making the new domain available to the Intent Preprocessor and SERV-Entity

The PGC tables are not just config — they are the evolving state of the brain.
The Intent Preprocessor reads from PGC to route incoming intents. The Step
Processor writes to PGC as a side-effect of running workflows. The right-brain
reads PGC to understand what has happened and improve future behaviour.

---

### 6.3 Intent Preprocessor — the kernel

The Intent Preprocessor (`classify-intent.mjs`) is the kernel of the system. It
receives every free-form user input from the `/mind` Slack command and routes it
to the correct program (workflow) or handler. It never executes the workflow
itself — it only classifies and dispatches, exactly as a kernel routes a system
call to the correct handler without executing the application code.

The preprocessor is triggered only by `/mind`. The `/create-domain`, `/help`, and
`/shutdown` commands bypass it entirely and route directly to their handlers.

#### Two-pass, domain-workflow-aware classification pipeline

**Root cause addressed by this design:** The previous three-pass design had Pass 1b
and Pass 1c operating on a different knowledge base than Pass 1a. Pass 1c was
domain-aware but workflow-blind — it built ad-hoc CRUD steps against a table
without knowing that a richer registered workflow existed for that domain. This
caused inputs like `"get my recipes sweet potato"` to execute an ad-hoc
`serv_query` instead of the `get_recipes` workflow. The redesign collapses Pass 1b
and Pass 1c into a single **domain-workflow-aware Pass 2** that checks registered
workflows before falling back to CRUD verb detection.

**Session 17 — generic CRUD workflows:** `create_domain` no longer generates
domain-specific workflows (`add_recipes`, `list_recipes`, etc.). It produces five
`PGC_IntentMap` rows per domain using `*_entity` intent categories that route to
five universal generic workflows (`add_entity`, `list_entity`, `get_entity`,
`update_entity`, `delete_entity`) with `domain: null` in `PGC_Workflow`. This
eliminated schema drift and made child-row insertion generically possible.

**Session 18 — Phase B pre-pass:** A new pre-pass runs before Pass 1 and detects
`PGC_*/PGD_*` table-name prefixes in user input. This is the **sole trigger** for
direct table-level CRUD (`serv/table/*`). Inputs containing `field=value` pairs or
`id=N` without a table prefix never route to the direct CRUD path — they route to
the domain workflow. The pre-pass short-circuits the entire Pass 1/Pass 2/Tier 2
chain with zero DB reads beyond the already-preloaded rows.

**Data-driven verb vocabulary:** Rather than hardcoding verb lists in code, Pass 2
reads `PGC_Workflow.intent_keywords` — already generated by the LLM at domain
creation time. When a new verb is added to a workflow's `intent_keywords`, Pass 2
automatically supports it with no code change.

**Pre-load (parallel, one DB round-trip):**

```js
const [intentMapResp, domainHelpResp, workflowResp] = await Promise.all([
  getRows('PGC_IntentMap'),
  getRows('PGC_DomainHelp'),
  getRows('PGC_Workflow'),   // added — used by Pass 2 and handoff(); net savings: removes the
]);                          // getRows('PGC_Workflow') call previously inside handoff()
```

**Classification pipeline:**

```
User input — arrives via /mind Slack command
  │
  ▼
PRE-PASS — PGC_*/PGD_* table-prefix detection (zero LLM, zero extra DB reads)
  Scan input for a PGC_ or PGD_ prefixed token.
  │
  ├── Token found
  │     Extract table name. Detect CRUD verb via CRUD_PATTERNS.
  │     │
  │     ├── No verb → crud_ambiguous: "please include a verb"
  │     │
  │     ├── Verb found, required inputs missing (insert: no fields;
  │     │   update: no id or no fields; delete: no id)
  │     │     → crud_ambiguous with instructive error
  │     │
  │     └── Verb + required inputs present
  │           SHORT-CIRCUIT → executeCrudStep() directly against serv/table/*
  │           confidence: 'exact'
  │           e.g. "list PGD_Recipes"                → serv_query, no filters
  │           e.g. "list PGD_Recipes name=Pasta"     → serv_query, filter name=Pasta
  │           e.g. "add PGD_Recipes name=Pasta"      → serv_insert
  │           e.g. "update PGD_Recipes id=42 name=X" → serv_update
  │           e.g. "delete PGD_Recipes id=42"        → serv_delete
  │           e.g. "list PGC_Workflow"               → serv_query (admin path)
  │
  └── No token → PASS 1
  │
  ▼
PASS 1 — Intent Map Match (zero LLM)
  Lowercase input. Test against every PGC_IntentMap.pattern (regex).
  Sort: workflow > heavy_lift > crud; lower id wins within tier.
  │
  ├── Match found, action_type = 'workflow' or 'heavy_lift'
  │     For *_entity categories: resolve domain via matchDomainAlias().
  │     For retrieval workflows: extract search_term via extractSearchTerm().
  │     SHORT-CIRCUIT → handoff() immediately
  │     confidence: 'exact'
  │     e.g. "add recipes carbonara" → add_entity workflow, domain: recipes
  │     e.g. "build a domain"       → heavy_lift → CREATE_DOMAIN
  │
  ├── Match found, action_type = 'crud'
  │     Fall through to Pass 2 — domain workflows take priority over
  │     table-level crud rows in PGC_IntentMap (which are legacy/unused
  │     now that all domain operations route through *_entity workflows).
  │
  └── No match → PASS 2
  │
  ▼
PASS 2 — Domain-Workflow Lookup (zero LLM)
  Tokenise input. Scan PGC_DomainHelp.aliases — resolve domain name.
  │
  ├── No domain resolved
  │     hasCrudVerb() check — CRUD verb present but no domain matched?
  │       YES → crud_ambiguous: list registered domains (saves Tier 2 LLM call)
  │       NO  → Tier 2 (no hint)
  │     Backlog — check PGC_SessionEntry for active domain in session context
  │       Found → continue with resolved domain below (confidence: 'session_context')
  │
  └── Domain resolved → WORKFLOW KEYWORD SCAN
        Filter pre-loaded PGC_Workflow rows by domain OR domain: null.
        domain: null rows (generic *_entity workflows) are universal candidates —
        available to every domain's keyword scan. This is the UC 1.1 fix.
        Test lowercased input for token presence against each workflow's intent_keywords.
        Disambiguation: get_entity wins over list_entity when input contains terms
          beyond the verb and domain name (indicating a search term).
        Extract search_term / record_id when matched workflow is a retrieval type.
        │
        ├── Keyword match found → route to matched workflow
        │     confidence: 'keyword_match'
        │     e.g. "show all my recipes"          → list_entity
        │     e.g. "get my sweet potato recipe"   → get_entity, search_term: "sweet potato"
        │     e.g. "add pasta to my recipes"      → add_entity
        │
        └── No keyword match → Tier 2 with domain hint
  │
  ▼ (no Pre-pass, Pass 1, or Pass 2 match)
TIER 2 — Cheap LLM classification (perplexity/sonar)
  Only invoked when coded logic cannot classify.
  Domain hint injected if Pass 2 resolved one.
  Session context injected (Backlog) — enables ambiguous short-form resolution.
  Returns { intent_category, workflow_name, action_type }
  ├── workflow_name found in PGC_Workflow → enqueue WORKFLOW_STEP execute_top
  └── action_type = 'heavy_lift'         → Tier 3
  │
  ▼
TIER 3 — Heavy lift handoff (no additional LLM call)
  ├── intent_category = 'create_domain'   → enqueue CREATE_DOMAIN
  ├── intent_category = 'create_workflow' → enqueue CREATE_WORKFLOW
  └── unknown heavy_lift                  → WORKFLOW_NOTIFY: "I understood this
                                            but have no workflow for it yet."
```

#### Backlog — pgvector semantic search (supersedes Pass 2 keyword scan)

Pass 2's token-based `intent_keywords` scan is the Phase 2 implementation.
In Backlog, once `pgvector` is enabled and `PGC_Workflow.intent_embedding` columns
are populated, Pass 2 is extended with a semantic similarity step:

```
PASS 2 Backlog extension — after domain resolution, before Tier 2:
  Embed user input using text-embedding-3-small (OpenAI, 1536 dimensions)
  Query PGC_Workflow WHERE domain = resolved_domain
    ORDER BY intent_embedding <-> query_embedding LIMIT 1
  If cosine similarity > threshold (e.g. 0.82) → route to that workflow
    confidence: 'semantic_match'
  Else → fall through to Tier 2
```

This eliminates Tier 2 LLM calls for domain workflows entirely — novel phrasings
that miss keyword matching are caught by vector similarity before sonar is invoked.
The `intent_embedding` column already exists on `PGC_Workflow` (no schema change).
Enable when `CREATE EXTENSION IF NOT EXISTS vector` is run on RDS. See Section 10.

#### Three coexisting operation paths

A deliberate architectural boundary separates direct table operations, domain
workflow operations, and heavy-lift system commands:

| Path | Trigger | Scope | Cost |
|---|---|---|---|
| **Pre-pass direct** | `PGC_*/PGD_*` table-name prefix in input | Root table only — single-row INSERT / SELECT / UPDATE / DELETE via `serv/table/*` | Zero LLM, zero WorkflowRun |
| **Workflow** | Pass 1 or Pass 2 `*_entity` keyword match | Full domain entity — root + child tables, LLM parsing, confirmation gates | WorkflowRun lifecycle |
| **Heavy lift** | Pass 1 exact or Tier 2 LLM | System command — `CREATE_DOMAIN`, `CREATE_WORKFLOW`, or unknown | Tier 3 enqueue; may trigger LLM |

The pre-pass direct path is the only path where `field=value` pairs and `id=N` trigger
table operations. When these appear in domain input (no `PGC_/PGD_` prefix), they route
to the workflow path — `handoff()` parses them from `userInput` and passes them as
`input.updates` and `input.id` for the workflow steps to consume.

**Generic `*_entity` workflows (Session 17):** `create_domain` registers five
`PGC_IntentMap` rows per domain with `*_entity` intent categories pointing to five
universal `PGC_Workflow` rows (`domain: null`). These replace domain-specific
workflows (`add_recipes`, `list_recipes`, etc.), which are no longer generated.
The generic workflows consume `PGC_EntitySchema` at runtime — column definitions
are never hardcoded into workflow steps.

**`toEntityName()` convention:** `handoff()` derives the `entity_name` field passed
to generic workflows from the resolved domain name. Each underscore-separated word
is title-cased; a trailing `s` is stripped from the last word to produce the
singular form matching `PGC_EntitySchema.entity_name`:
- `recipes` → `Recipe`
- `stock_portfolio` → `StockPortfolio`
- `golf_scores` → `GolfScore`

**`entity_name` injection:** `handoff()` injects `entity_name` into `workflowInput`
for all domain workflow routes so generic workflow steps can call SERV-Entity by
name without knowing which domain they are operating on.

**`record_id` instructive error path:** When `get_entity`, `delete_entity`, or
`update_entity` is routed and the classified result contains `record_id` (i.e. the
user typed `id=N` with a retrieval intent), `handoff()` posts an instructive error
immediately without creating a `PGC_WorkflowRun`. The generic `get_entity` workflow
uses a name LIKE filter or routes to id-based lookup via a `condition` step (implemented Session 19).

#### Classification result shape

```json
{
  "intent_category": "add_recipes",
  "action_type":     "crud",
  "confidence":      "exact",
  "workflow_name":   null,
  "domain":          "recipes",
  "ad_hoc_step":     { "type": "serv_insert", "input": { "tableName": "PGD_Recipes", "row": { "name": "Pasta" } } },
  "search_term":     null
}
```

```json
{
  "intent_category": "get_recipes",
  "action_type":     "workflow",
  "confidence":      "keyword_match",
  "workflow_name":   "get_recipes",
  "domain":          null,
  "ad_hoc_step":     null,
  "search_term":     "sweet potato"
}
```

```json
{
  "intent_category": "list_recipes",
  "action_type":     "workflow",
  "confidence":      "exact",
  "workflow_name":   "list_recipes",
  "domain":          null,
  "ad_hoc_step":     null,
  "search_term":     null
}
```

`confidence` values and their sources:

| Value | Source |
|---|---|
| `exact` | Pass 1 regex match against `PGC_IntentMap.pattern` |
| `keyword_match` | Pass 2 token match against `PGC_Workflow.intent_keywords` |
| `semantic_match` | Pass 2 Backlog — pgvector cosine similarity match |
| `session_context` | Pass 2 Backlog — domain resolved from `PGC_SessionEntry` |
| `crud` | Pass 2 CRUD fallback — `field=value` pairs present, no workflow keyword match |
| `llm_classified` | Tier 2 sonar classification |
| `heavy_lift` | Tier 3 routing |

`search_term` is set by Pass 2 when the matched workflow is a retrieval type (`get_<domain>`)
and the input contains terms beyond the verb and domain name. `handoff()` passes it as
`input.search` without per-workflow special-casing.

`confidence` is the tier and pass that produced the result — useful for right-brain
analysis of where classification is weak.

#### handoff() routing contract

`handoff()` in `classify-intent.mjs` routes the classification result downstream.
The routing rules are final — do not add per-workflow special cases here:

| `action_type` | `workflow_name` | Route |
|---|---|---|
| `workflow` | set | Look up `PGC_Workflow` by `workflow_name` from pre-loaded rows, create `PGC_WorkflowRun`, enqueue `WORKFLOW_STEP execute_top`. If `result.search_term` is set, pass as `input.search` — no per-workflow special cases |
| `heavy_lift` | — | `resolveTier3Route()` → enqueue `CREATE_DOMAIN` / `CREATE_WORKFLOW` / `WORKFLOW_NOTIFY` |
| `crud` | — | `executeCrudStep()` — executes `ad_hoc_step` directly, posts result as `WORKFLOW_NOTIFY` |
| `crud_ambiguous` | — | Post instructive error to user (missing id, missing fields, unknown domain) |

**`search_term` handling is generic.** When `result.search_term` is set, `handoff()` passes
`input: { userInput, search: result.search_term }` regardless of which workflow was matched.
No per-workflow cases. The extraction logic that sets `search_term` lives in
`matchWorkflowByKeywords()` in `classify-intent-tiers.mjs`, where the workflow type is known.

**Word-boundary matching (Session 20):** The keyword scan uses a Unicode-aware word-boundary
regex instead of `String.includes()`. This prevents false positives where a keyword appears as
a substring inside a longer word — e.g. `"list"` matching inside the Spanish word `"simplista"`.
Accented characters (U+00C0–U+024F) count as word characters so boundaries do not form inside
accented Spanish words. Tiebreaker changed from lowest DB id to earliest keyword position in input
(verb-first semantics), with DB id as secondary.

**`PGC_IntentMap` has no `workflow_id` column.** This was removed as a structural
error — there is no genuine FK relationship between the intent map and workflow
table. `handoff()` looks up the workflow by name from pre-loaded rows. `action_type`
alone is the routing signal.

#### matchIntentMap sort order — FINAL

`matchIntentMap()` in `classify-intent-tiers.mjs` sorts all pre-loaded `PGC_IntentMap`
rows before iterating. Sort order:

1. `action_type = 'workflow'` — score 0 (highest priority)
2. `action_type = 'heavy_lift'` — score 1
3. `action_type = 'crud'` and all others — score 2 (lowest priority)
4. Within each tier: lower `id` wins (first-seeded row is canonical)

This ensures that if a duplicate stale `crud` row somehow matches the same
pattern as a `workflow` row, the workflow row always wins. This is the defensive
guard against `PGC_IntentMap` data quality issues.

#### LLM model selection

| Task | Model | Reason |
|---|---|---|
| Intent classification (Tier 2) | `perplexity/sonar` via `LLM_CHAT_URL` | Fast, cheap, structured JSON |
| Workflow / schema generation | `anthropic/claude-sonnet-4-5` | Reliable structured JSON output |

Model selection is per-prompt row in `PGC_Prompt.model`.

#### Design principles

- Coded logic always runs first — cheap, fast, zero LLM cost
- LLM invoked only when coded logic cannot classify
- Every classified intent resolves to a `PGC_Workflow` row or a known entry point
- The preprocessor has no `PGC_WorkflowRun` row of its own — it is a routing
  function, not a workflow. It never touches the execution stack.
- `PGC_IntentMap` and `PGC_Workflow` are structurally independent — no FK between them

---

#### I/O contracts and invariants

This section documents the input/output contracts between the Intent Preprocessor
passes and tiers. Future work must preserve these contracts — they are the
interfaces that allow passes to compose correctly and that `handoff()` relies on.

##### Classification result object — canonical shape

Every return path in `classify()` produces this shape:

```js
{
  intent_category: string,      // e.g. "get_recipes", "create_domain", "unknown_domain_crud"
  action_type:     string,      // 'workflow' | 'heavy_lift' | 'crud' | 'crud_ambiguous'
  confidence:      string,      // 'exact' | 'keyword_match' | 'semantic_match' | 'session_context' | 'crud' | 'llm_classified' | 'heavy_lift'
  workflow_name:   string|null, // set when action_type === 'workflow', null otherwise
  domain:          string|null, // set when domain was resolved (Pass 1 crud, Pass 2, Tier 2)
  ad_hoc_step:     object|null, // set when action_type === 'crud' and verb resolved
  search_term:     string|null, // set by Pass 2 for retrieval workflows — passed as input.search by handoff()
  // Optional — present on crud_ambiguous paths only:
  known_domains:   string[],
  table_columns:   string[],
  root_table:      string,
  ambiguous_reason: string,     // 'no_id' | 'no_fields'
}
```

**Invariants:**
- `workflow_name` is set if and only if `action_type === 'workflow'`
- `ad_hoc_step` is set if and only if `action_type === 'crud'` AND the verb was unambiguous
- `action_type === 'crud_ambiguous'` means the intent was identified but cannot execute — post instructive error
- `domain` is always set when `action_type === 'crud'` or `'crud_ambiguous'`
- `domain` is null when `action_type === 'workflow'` or `'heavy_lift'` — handoff does not need it
- `search_term` is set only when `action_type === 'workflow'` and the matched workflow is a retrieval type

##### Pass I/O boundaries

| Pass | Input | Output contract |
|---|---|---|
| Pass 1 — workflow/heavy_lift | PGC_IntentMap row with `action_type !== 'crud'` | Short-circuits: returns result with `workflow_name` set, `domain: null`, `ad_hoc_step: null`, `search_term: null` |
| Pass 1 — crud + field=value | PGC_IntentMap row with `action_type === 'crud'`, field=value pairs present | Short-circuits: returns full result including `ad_hoc_step`, `domain` set |
| Pass 1 — crud, no field=value | PGC_IntentMap row with `action_type === 'crud'`, no pairs | Checks pre-loaded PGC_Workflow rows for domain → routes to workflow or falls to Tier 2 |
| Pass 2 — keyword match | PGC_DomainHelp alias resolved + PGC_Workflow.intent_keywords scan | Returns result with `workflow_name` set, `confidence: 'keyword_match'`, `search_term` populated if retrieval workflow |
| Pass 2 — CRUD fallback | Domain resolved, no keyword match, field=value pairs present | Returns `ad_hoc_step`, `confidence: 'crud'` |
| Pass 2 — Backlog semantic | After keyword scan miss, pgvector similarity > threshold | Returns `workflow_name`, `confidence: 'semantic_match'` |
| Tier 2 (sonar) | Raw user input + optional domain hint | Returns `{ intent_category, workflow_name, action_type }` — no `ad_hoc_step`, no `domain` resolution. `handoff()` looks up workflow from pre-loaded rows |
| Tier 3 | `intent_category` string | Routes to `CREATE_DOMAIN` / `CREATE_WORKFLOW` / `WORKFLOW_NOTIFY` — no further classification |

##### handoff() routing — FINAL, do not add per-workflow cases

```
action_type === 'workflow' AND workflow_name set
  → find workflow in pre-loaded PGC_Workflow rows by name
  → insertRow('PGC_WorkflowRun', { input: { userInput, ...(search_term && { search: search_term }) }, ... })
  → enqueueWorkflow(WORKFLOW_STEP execute_top)

action_type === 'heavy_lift'
  → resolveTier3Route(intent_category)
  → enqueue CREATE_DOMAIN | CREATE_WORKFLOW | WORKFLOW_NOTIFY

action_type === 'crud' AND ad_hoc_step set
  → executeCrudStep() — runs step directly, posts WORKFLOW_NOTIFY

action_type === 'crud_ambiguous'
  → enqueueCallback(WORKFLOW_NOTIFY, instructive error message)

action_type === 'crud' AND no ad_hoc_step (Tier 2 crud path — no root table resolved)
  → enqueueCallback(WORKFLOW_NOTIFY, "could not determine which table to use")
```

##### PGC_IntentMap schema — FINAL

```
id              serial primary key
pattern         text not null        — regex pattern, tested case-insensitive
intent_category text not null        — e.g. "add_recipes", "help", "create_domain"
action_type     text not null        — CHECK: 'crud' | 'workflow' | 'heavy_lift'
created_at      timestamptz
updated_at      timestamptz
```

**No `workflow_id` column.** Removed permanently — there is no structural
relationship between `PGC_IntentMap` and `PGC_Workflow`. Do not add it back.


6.4 Generic CRUD Workflows

Five universal `PGC_Workflow` rows replace domain-specific CRUD workflows.
All five have `domain: null` — they are not bound to any domain.

| Workflow | Intent keywords | Role |
|---|---|---|
| `get_entity` | get, show, find, fetch, look up, search | Retrieve one entity by name LIKE filter or id (Backlog) |
| `list_entity` | list, show all, get all, find all, all | List all entities with optional filter |
| `add_entity` | add, create, new, insert | LLM-parse-first multi-table insert |
| `update_entity` | update, edit, modify, change | Confirmation-gate update on root table |
| `delete_entity` | delete, remove | Confirmation-gate delete with CASCADE |

**Why generic workflows replaced domain-specific ones:** Domain-specific workflows
generated by `create_domain` caused schema drift — column names were baked into
step definitions at creation time and diverged from the live schema when tables were
altered. Child-row insertion via iterator was impossible to generate generically
because child table names and FK columns varied per domain. Generic workflows read
`PGC_EntitySchema` at runtime, making them schema-agnostic.

**`add_entity` child inserts:** Step 5 of `add_entity` uses a `js_transform` expression
(replacing the former `buildChildInserts` built-in) to read `local_state.full_entity_schema`,
`local_state.parsed_entity`, and `local_state.new_record` and build the flat child insert array.
This is the single source of truth — the LLM receives actual column names and never
guesses. New columns added to any table are immediately visible without recreating
the domain.

**`buildChildInserts` js_transform built-in:** Assembles the flat
`{ tableName, row }` array for all child tables from `parsed_entity.children`,
injecting the FK value from `new_record.id`. Reads `full_entity_schema.children[].fk_column`
and `children[].output_key` — no hardcoded column names.

**`execution_mode: sequential` inline iterator:** `run-workflow.mjs` processes all
iterator items in a single Lambda invocation when `execution_mode` is `sequential`
or absent. This eliminates the Lambda recursive loop detection emails that occurred
with 19 rapid proc→SQS→proc cycles during multi-child inserts. Operational ceiling:
approximately 120 child rows at 60s Lambda timeout / ~400ms per SERV insert.

**`create_domain` step 9 (Session 17):** No longer inserts domain-specific
workflows. Now inserts five `PGC_IntentMap` rows using `*_entity` intent categories
and LLM-generated patterns. `intentMapRows.intent_category` is constrained by Ajv
to the enum `[list_entity, get_entity, add_entity, update_entity, delete_entity]` —
the LLM cannot drift back to domain-specific categories.

**`parseFieldValues` SYSTEM_COLS exclusion:** The `id`, `created_at`, and
`updated_at` columns are excluded case-insensitively. If a user types `ID=5` or
`Created_At=...`, these are silently dropped before field values reach SERV.

6.5 Step-executor,  WorkflowRun and the execution loop

When the Intent Preprocessor (or a direct command handler) decides a workflow
should run, it creates a `PGC_WorkflowRun` row and enqueues a `WORKFLOW_STEP
execute_top` SQS message. From that point, `run-workflow.mjs` takes over.

#### PGC_WorkflowRun — the process control block

Every workflow execution has exactly one `PGC_WorkflowRun` row. This row is the
complete runtime state of the execution — nothing is held in Lambda memory between
SQS invocations.

```
PGC_WorkflowRun
  id            integer        — run identifier surfaced to the user for /shutdown
  workflow_id   integer        — FK to PGC_Workflow (which program to run)
  workflow_name text           — denormalised name for fast loading
  status        text           — running | awaiting_human_gate | completed | failed | cancelled
  stack         jsonb          — execution stack (see 6.5.2)
  state         jsonb          — { local_state: { ... } } — the data bag (see 6.5.3)
  input         jsonb          — original input passed to the run (available as input.* in local_state)
  callback      jsonb          — { provider, channel, threadId } — where to send results
  error         jsonb          — structured error if failed; also used for stuck-step detection
  step_count    integer        — total steps executed — velocity guard uses this
  completed_at  timestamptz
```

#### The execution loop

The Step Processor is a simple loop driven by SQS messages. Each message is one
iteration:

```
SQS delivers WORKFLOW_STEP execute_top
  │
  ▼
Load PGC_WorkflowRun by workflowRunId
  Check status — if cancelled: discard (shutdown contract)
  │
  ▼
Inspect top of stack
  workflow frame  → execute current_step of the workflow
  iterator frame  → execute current item, advance index
  (human_gate frame never reaches execute_top — it is suspended)
  │
  ▼
Load PGC_Workflow.steps
Find step where step.step === frame.current_step
  │
  ▼
Check PGC_WorkflowRunStep for (run_id, frame_id, step_key)
  Found → idempotency hit (SQS redelivery)
         → increment stuck_count in run.error
         → if stuck_count >= 3: fail run, notify user (Guard 1)
         → else: re-enqueue execute_top, return
  Not found → proceed
  │
  ▼
Execute step (see 6.5.1 — step types)
  │
  ├── on error: write PGC_WorkflowRunStep (failed), mark run failed,
  │             enqueue WORKFLOW_ERROR to callback, rethrow
  │
  └── on success: write PGC_WorkflowRunStep (completed)
                  clear run.error.stuck_step if present
                  store result at local_state[step.output_key]
                  persist stack + state to PGC_WorkflowRun
                  │
                  ├── result.nextAction = 'suspend' (human_gate)
                  │     push human_gate frame
                  │     set status = awaiting_human_gate
                  │     enqueue WORKFLOW_GATE to callback
                  │     STOP — next SQS message comes from user interaction
                  │
                  ├── result.nextAction = 'iterator'
                  │     push iterator frame
                  │     enqueue execute_top
                  │
                  ├── result.nextAction = 'end'
                  │     set status = completed
                  │     STOP
                  │
                  └── result.nextAction = 'next' | 'step:N'
                        resolve next step key
                        update frame.current_step
                        enqueue execute_top
```

One SQS message per step. One step per Lambda invocation. The stack is the only
shared state between invocations — always persisted to `PGC_WorkflowRun` before
the Lambda returns.

---

### 6.5.1 Step types — the instruction set

Every step in a workflow is one instruction from this set. The Step Processor has
one handler per type. No workflow-specific code lives in the Step Processor.

#### Step definition schema

Every step follows this shape:

```json
{
  "step":             "1",
  "type":             "<step_type>",
  "description":      "Human-readable description for workflow authors and right-brain",
  "input":            {},
  "output_key":       "key_in_local_state",
  "on_success":       "next | end | step:3a",
  "on_failure":       "human_feedback | cancel"
}
```

**Step keys are always strings.** `"1"`, `"3"`, `"3a"`, `"3b"`, `"3d"` are all
valid step keys. `on_success: "step:3a"` is a forward or backward jump. The Step
Processor resolves step keys by string equality — `parseInt` is never used.

#### Step type reference

```
╔══════════════╦══════════════════════════════════════════════════════╦══════════════════╗
║ Type         ║ What it does                                         ║ Status           ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ llm_call     ║ Load prompt from PGC_Prompt, call LLM, run           ║ ✅ Implemented   ║
║              ║ review-output validation (2-attempt correction loop) ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ js_transform ║ Run a named built-in transform on local_state data   ║ ✅ Implemented   ║
║              ║ (depricated), or evaluate a sandboxed JS expression  ║                  ║
║              ║ via acorn AST gate + vm.runInNewContext. Built-ins:  ║                  ║
║              ║ columnSummary,buildHelpOptions, resolveHelpContent,  ║                  ║
║              ║ formatRecordList, buildChildInserts.                 ║                  ║
║              ║ Generic expression field: Session 19.                ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ human_gate   ║ Suspend stack, present dialog to user, resume on     ║ ✅ Implemented   ║
║              ║ response. Gate types: confirm, edit_list, text_input,║                  ║
║              ║ review_object. (select_one, select_many Backlog)     ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_schema  ║ Create a PGD table via SERV createTable              ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_insert  ║ INSERT one row into a PGD table via SERV             ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_query   ║ SELECT rows from a PGD table via SERV                ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ LIST assembled entities via SERV-Entity listEntities ║ ✅ Implemented   ║
║ query        ║ — root columns + jsonb_agg child arrays. Use instead ║                  ║
║              ║ of serv_query for domains with child tables.         ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ FETCH one assembled entity by id via SERV-Entity     ║ ✅ Implemented   ║
║ get          ║ getEntity. Returns root columns + child arrays.      ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_update  ║ UPDATE rows in a PGD table via SERV                  ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_delete  ║ DELETE rows from a PGD table via SERV                ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ notify       ║ Resolve message_template from local_state, enqueue   ║ ✅ Implemented   ║
║              ║ WORKFLOW_NOTIFY to callback                          ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ iterator     ║ Loop over an array in local_state, execute item_step ║ ✅ Implemented   ║
║              ║ for each item sequentially                           ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ end          ║ Mark run completed, stop                             ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ Load full entity schema: reads PGC_EntitySchema for   ║ ✅ Implemented   ║
║ schema       ║ join topology + PGC_Schema for live column defs.     ║ Session 19       ║
║              ║ Collapses the serv_query + buildEntitySchema          ║                  ║
║              ║ two-step pattern into one step. See Section 6.5.1.    ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ sub_workflow ║ Push child workflow frame, inherit local_state        ║ ⬜ Backlog       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ condition    ║ Evaluate {{expression}} against local_state, route   ║ ✅ Implemented   ║
║              ║ to on_truthy / on_falsy step keys. No I/O.           ║ Session 19       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ capability_call ║ Call a registered capability from PGC_Capability  ║ ⬜ Backlog       ║
╠══════════════╣══════════════════════════════════════════════════════╣══════════════════╣
║ simulate       ║ Dry-run a workflow step array against named         ║ ✅ live          ║
║               ║ execution paths using injected mock outputs.         ║ v3.2-create-    ║
║               ║ Three validation levels: static analysis, path        ║ workflow-       ║
║               ║ execution, skip-path analysis. See Section 6.5.6.   ║ complete        ║
╚══════════════╩══════════════════════════════════════════════════════╩══════════════════╝
```

#### Step-specific schema fields by type

##### **`llm_call`**
```json
{
  "step": "1", "type": "llm_call",
  "input": {
    "prompt":    "create_domain",
    "userInput": "{{input.userInput}}"
  },
  "output_key": "proposed_scaffold",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```
`input.prompt` is the `intent_category` key into `PGC_Prompt`. All other `input`
fields are available to the prompt template via `{{variable}}` substitution.
Output is the parsed JSON object from the LLM, stored at `output_key` in `local_state`.

##### `js_transform`

Every `js_transform` step requires an `expression` field — a pure synchronous JavaScript
value expression executed in a sandboxed `vm.runInNewContext` context. Two bindings are
available in the sandbox:

- **`items`** — the resolved value of `input_key` from `local_state`
- **`local_state`** — the full local_state object, enabling cross-key reads

The `expression` must evaluate to a value (no `return` keyword, no semicolons at top level).
Wrap multi-statement logic in an IIFE: `(function() { ... })()`

```json
{
  "step": "2", "type": "js_transform",
  "description": "Enrich table list with columnSummary and domain field.",
  "input_key": "proposed_scaffold.tables",
  "output_key": "proposed_scaffold.tables",
  "expression": "(function() { var SYS = new Set(['id','created_at','updated_at']); function enrich(tables, domain) { return tables.map(function(t) { if (!t.columns) return t; var cols = t.columns.filter(function(c){ return !SYS.has(c.name); }).slice(0,4).map(function(c){ return c.name; }); return Object.assign({}, t, { columnSummary: cols.join(', '), domain: domain }); }); } return enrich(items, local_state.proposed_scaffold.domain); })()",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```

Reading cross-key values via `local_state` — used when the primary input is insufficient:

```json
{
  "step": "3c", "type": "js_transform",
  "input_key": "proposed_scaffold.tables",
  "output_key": "proposed_scaffold.tables",
  "expression": "(function() { var newTable = local_state.new_table; var merged = newTable ? items.concat([newTable]) : items; return merged; })()"
}
```

**Sandbox constraints:** pure synchronous transforms only — no `require`, no `import`, no
async, no network, no filesystem. Timeout: 200ms. Safe globals available: `JSON`, `Math`,
`Array`, `Object`, `String`, `Number`, `Boolean`, `Date`.

**`transform_type` built-ins removed (Session 20).** All five named built-ins
(`columnSummary`, `buildHelpOptions`, `resolveHelpContent`, `formatRecordList`,
`buildChildInserts`) have been replaced by self-contained `expression` steps in the seed
workflows. Any step using `transform_type` now throws a hard error at runtime — no silent
fallback.

The constraint boundary: `js_transform` is restricted to **pure synchronous data transformation** —
##### `human_gate`
```json
{
  "step": "3", "type": "human_gate",
  "gate_type":        "edit_list",
  "message_template": "Here's my plan for domain {{proposed_scaffold.domain}}.",
  "context_key":      "proposed_scaffold.tables",
  "item_primary_key": "tableName",
  "item_secondary_key": "columnSummary",
  "options": [
    { "label": "Looks good",  "action": "confirm",   "on_select": "step:3d" },
    { "label": "Add a table", "action": "add_table", "on_select": "step:3a" },
    { "label": "Cancel",      "action": "cancel",    "on_select": "cancel"  }
  ],
  "on_success": "next",
  "on_failure": "cancel"
}
```
###### Context key 
`context_key` is a dot-path into `local_state` — the data bound to the dialog.
`options[].on_select` drives routing after the gate resolves — `"step:3d"` is a
jump; `"next"` advances to the sequentially next step; `"cancel"` cancels the run.

###### Template syntax

Templates appear in `message_template`, `input` values, and `context_key`. The
template resolver (`template-resolver.mjs`) supports:

```
{{key}}              → local_state["key"]
{{key.field}}        → local_state["key"]["field"]
{{key.0.field}}      → local_state["key"][0]["field"]
{{item}}             → current iterator item (inside item_step only)
{{item.field}}       → field on current iterator item
{{input.field}}      → run.input["field"] — original input to the workflow
```

Unresolved templates (key not found in local_state) resolve to the empty string
`""` — they do not throw. This means a workflow author must ensure that every
template reference has a corresponding `output_key` written by a prior step.

##### `iterator`
```json
{
  "step": "5", "type": "iterator",
  "items_key":   "proposed_scaffold.tables",
  "item_step":   { "type": "serv_schema", "input": { "table": "{{item}}" } },
  "output_key":  "created_tables",
  "on_complete": "next"
}
```
`items_key` is a dot-path to an array in `local_state`. `item_step` is executed
once per item — the current item is available as `{{item}}` and `{{item.field}}`
inside `item_step.input`. Results are collected into an array at `output_key`.

**Human gate suspension inside iterators (Session 23).** When `item_step` is a
`human_gate`, the inline sequential iterator detects `nextAction === 'suspend'` after
the gate is built and breaks the loop. A gate frame is pushed onto the stack with
`step_ref.options` resolved to the live array (not the template string) — required
because `resume_gate` calls `options.find()` to match the user response. The
iterator frame remains on the stack at the current `current_index`. On `resume_gate`,
execution returns to the iterator at that index and advances to the next item.

##### `serv_query` / `serv_insert` / `serv_update` / `serv_delete`**
```json
{
  "step": "1", "type": "serv_query",
  "input": {
    "tableName": "PGD_Recipes",
    "filters":   [{ "column": "id", "op": "eq", "value": "{{input.id}}" }]
  },
  "output_key": "results",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```

##### `serv_entity_query` / `serv_entity_get`
```json
{
  "step": "1", "type": "serv_entity_query",
  "input": {
    "entityName": "Recipe",
    "filters":    [{ "column": "name", "op": "like", "value": "{{input.search}}" }],
    # orderBy removed — hardcoded "name" column is domain-specific assumption
    "limit":      20
  },
  "output_key": "results",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```
`entityName` is the PascalCase singular name from `PGC_EntitySchema.entity_name` — e.g. `Recipe`, not `Recipes`.
Returns assembled entities with root columns plus child arrays (`ingredients`, `steps`, etc.).
Use instead of `serv_query` for domains with child tables or when full entity display is needed.

`serv_entity_get` fetches a single entity by id:
```json
{
  "step": "1", "type": "serv_entity_get",
  "input": { "entityName": "Recipe", "id": "{{input.id}}" },
  "output_key": "result",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```

##### `notify`
```json
{
  "step": "11", "type": "notify",
  "message_template": "Domain {{proposed_scaffold.domain}} created. Try: {{generated.domainHelp.commands.0.syntax}}",
  "notify_type": "WORKFLOW_NOTIFY",
  "on_success": "next"
}
```

##### `end`
```json
{ "step": "12", "type": "end" }
```

##### `simulate`
```json
{
  "step":        "4",
  "type":        "simulate",
  "input": {
    "steps_key":        "draft_workflow.steps",
    "mock_outputs_key": "mock_outputs",
    "paths_key":        "simulation_paths"
  },
  "output_key":  "simulation_result",
  "on_success":  "next",
  "on_failure":  "step:3"
}
```
All three `input` fields are dot-paths into `local_state`. `mock_outputs_key`
and `paths_key` are optional — if absent, the `simulate` step runs Level 1
static analysis only. `on_failure` routes back to the step where the user can
review and correct the workflow definition before re-simulating.
Full schema, validation levels, and result structure: see **Section 6.5.6**.

##### `condition`
```json
{
  "step": "1",
  "type": "condition",
  "description": "Route to id lookup or name search depending on which input field is set.",
  "expression": "{{input.id}}",
  "on_truthy": "2",
  "on_falsy":  "3"
}
```
`expression` is resolved via `resolveTemplate` against `local_state`. Truthy: resolved value is
non-empty, not `"null"`, not `"undefined"`, not `"0"`, and does not contain `{{` (unresolved
template literals are treated as falsy — the key was not set). `on_truthy` and `on_falsy` are
bare step keys (e.g. `"2"`, `"3"`) — the executor prefixes them to `step:N` internally.
No output_key is written — condition steps produce no state output.

**Constraint:** `on_truthy` and `on_falsy` must reference step keys that exist in the workflow.
Level 1 static analysis validates both targets as `step:N` routing tokens.

##### `js_transform` — full detail

Only one mode: `expression`. The `transform_type` field is removed — all built-ins replaced
by self-contained expressions. Any step using `transform_type` throws immediately at runtime.

**Sandbox bindings (Session 20)**

| Binding | Source | Notes |
|---|---|---|
| `items` | `resolvePath(localState, step.input_key)` | Primary input — resolved value at `input_key` |
| `local_state` | Full `localState` object | Cross-key reads — required when input_key is insufficient |
| `JSON`, `Math`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Date` | Safe globals | No Node.js APIs |

`local_state` enables workflows generated by `create_workflow` to be fully self-contained —
an expression can read any key already written to the workflow state without needing a
dedicated step type for every combination.

**Constraint boundary.** `js_transform` is restricted to **pure synchronous data transformation** —
operate on data already in `local_state` and return a new value. It never fetches, never writes,
never calls external services.

- "Transform data I already have" → `js_transform` with `expression`
- "Fetch data I don't have" → `serv_*` step type or `capability_call` (Backlog)

**AST gate — rejection rules.** The acorn parser walks the AST before `vm.runInNewContext` is called.
Any of the following causes an immediate throw:

| Rejected AST node | What it blocks |
|---|---|
| `ImportDeclaration` | `import` statements |
| `CallExpression` where callee is Identifier `require` | `require()` calls |
| `MemberExpression` with object Identifier `process` or `global` | Node.js globals |
| `AwaitExpression` | Any `await` |
| `FunctionDeclaration` or `ArrowFunctionExpression` with `async: true` | Async functions |
| `NewExpression` where callee is Identifier `Function` | `new Function()` |
| `CallExpression` where callee resolves to `eval`, `fetch`, `XMLHttpRequest` | Network and eval |

`vm.runInNewContext({ timeout: 200 })` reliably kills synchronous infinite loops.

**Example expressions:**

| Use case | Expression |
|---|---|
| Enrich tables with columnSummary | `(function() { var SYS = new Set(['id','created_at','updated_at']); return items.map(function(t) { var cols = (t.columns||[]).filter(function(c){return !SYS.has(c.name);}).slice(0,4).map(function(c){return c.name;}); return Object.assign({},t,{columnSummary:cols.join(', ')}); }); })()` |
| Merge new_table from local_state | `(function() { var n = local_state.new_table; return n ? items.concat([n]) : items; })()` |
| Count passing results | `items.filter(r => r.score > 0).length` |
| Sum a numeric field | `items.reduce((acc, r) => acc + (r.score || 0), 0)` |
| Filter by field | `items.filter(r => r.status === 'active')` |
| Read cross-key value | `items.concat(local_state.extra_items || [])` |

**Former built-ins and their replacements (for migration reference)**

| Former `transform_type` | Replaced by | Workflow / step |
|---|---|---|
| `columnSummary` | Expression reading `local_state.proposed_scaffold.domain` | `create_domain` steps 2, 3c |
| `buildHelpOptions` | Expression over `items` (registered_domains) | `help` step 2 |
| `resolveHelpContent` | Expression reading `local_state.help_selection` + `local_state.help_options` | `help` step 4 |
| `formatRecordList` | Expression with root_only variant | `get_entity` step 4, `list_entity` step 2 |
| `buildChildInserts` | Expression reading `local_state.full_entity_schema`, `local_state.parsed_entity`, `local_state.new_record` | `add_entity` step 5 |

##### `serv_entity_schema`
```json
{
  "step": "1",
  "type": "serv_entity_schema",
  "input": { "entityName": "{{input.entity_name}}" },
  "output_key": "full_entity_schema",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```
Loads a full entity schema by combining `PGC_EntitySchema` (join topology) with `PGC_Schema`
(live column definitions for all tables in the entity). Replaces the two-step pattern
(`serv_query PGC_EntitySchema` → `js_transform buildEntitySchema`) with a single step.
I/O does not belong in `js_transform`.

`entityName` is the PascalCase singular name from `PGC_EntitySchema.entity_name` — e.g. `Recipe`.
Supports `{{template}}` substitution.

**Output shape written to `output_key`:**
```json
{
  "entity_name": "Recipe",
  "description": "A cooking recipe with ingredients and steps",
  "root": {
    "table":   "PGD_Recipes",
    "columns": [{ "name": "name", "type": "text" }]
  },
  "children": [
    {
      "table":      "PGD_RecipeIngredients",
      "alias":      "ingredients",
      "fk_column":  "recipe_id",
      "output_key": "ingredients",
      "columns":    [{ "name": "ingredient_name", "type": "text" }]
    }
  ]
}
```
System columns (`id`, `created_at`, `updated_at`) and FK columns are excluded from all column lists.
Column definitions are read from `PGC_Schema` at runtime — not cached — so new columns are
immediately visible without recreating the domain.

---

### 6.5.2 Execution Stack — program counter and call stack

`PGC_WorkflowRun.stack` is a JSON array of frames. The Step Processor always
operates on the **top frame** (last element). This is a standard call stack —
pushing a frame suspends the current context; popping a frame resumes it.

#### Frame schema

```json
{
  "frame_id":      "uuid",
  "type":          "workflow | iterator | human_gate",
  "status":        "running | awaiting | completed | failed",
  "workflow_name": "create_domain",
  "current_step":  "3d",
  "local_state":   { "proposed_scaffold": { ... }, "new_table": { ... } },
  "on_complete":   "end",
  "pushed_at":     "2026-03-25T10:08:38Z",

  "item_step":     { ... },
  "items_key":     "proposed_scaffold.tables",
  "items":         [ ... ],
  "current_index": 2,
  "results":       [ ... ],
  "parent_step":   "5",

  "gate_type":     "review_object",
  "step_ref":      { ... },
  "step_number":   "3d"
}
```

`current_step` is the string step key of the **next step to execute** — the
program counter. After every step completes, the Step Processor advances
`current_step` before persisting the frame and enqueuing the next SQS message.

#### Stack operations

| Operation | Triggered by | Effect |
|---|---|---|
| PUSH workflow frame | Start of run (root frame) or `sub_workflow` step | New frame on top; parent frame paused at its current_step |
| PUSH iterator frame | `iterator` step result | New iterator frame on top; workflow frame paused |
| PUSH human_gate frame | `human_gate` step result | New gate frame on top; run status → awaiting_human_gate |
| POP frame | Frame completes (iterator exhausted, gate resolved) | Top frame removed; parent frame resumes |
| POP on cancel | User clicks Cancel at any gate | Stack cleared; run status → cancelled |

#### Stack state examples

**Initial state — single workflow frame, step 1:**
```json
stack: [
  { "frame_id": "A", "type": "workflow", "current_step": "1", "local_state": {} }
]
```

**After step 3 (human_gate) suspends — gate frame on top:**
```json
stack: [
  { "frame_id": "A", "type": "workflow",    "current_step": "3",  "local_state": { "proposed_scaffold": {...} } },
  { "frame_id": "B", "type": "human_gate",  "status": "awaiting", "gate_type": "edit_list", "step_number": "3" }
]
```
The workflow frame is paused at step `"3"`. The gate frame is on top. No SQS
messages are in flight. The Lambda is idle, costing nothing.

**After user confirms — gate popped, workflow frame advanced to step 3d:**
```json
stack: [
  { "frame_id": "A", "type": "workflow", "current_step": "3d", "local_state": { "proposed_scaffold": {...} } }
]
```

**During step 5 iterator — iterator frame on top of workflow frame:**
```json
stack: [
  { "frame_id": "A", "type": "workflow",  "current_step": "5",  "local_state": { ... } },
  { "frame_id": "C", "type": "iterator",  "current_index": 1, "items": [...], "results": [...] }
]
```

#### Sequential iterator rule

**The iterator never enqueues all items simultaneously.** It executes one item,
waits for it to complete, then executes the next. At all times there is at most
one `execute_top` SQS message in flight per `workflowRunId`. This is enforced
by stack discipline — the iterator frame stays on top until all items are done
and the frame pops. No locking, no coordination.

#### Idempotency

Before executing any step, the Step Processor checks `PGC_WorkflowRunStep` for
a row with `(run_id, frame_id, step_key)` where `step_key` is the string step
key `"3a"`, `"3d"`, etc. If found, the step already ran (SQS at-least-once
redelivery). The Step Processor increments `run.error.stuck_count` for this
step. At count 3, it marks the run `failed` and posts a `WORKFLOW_ERROR` to
Slack with the run ID and step name (Guard 1 — lightweight stuck-step detector).

**Critical:** `step_key` is stored as `text` in `PGC_WorkflowRunStep`. Using the
integer `step_number` column for idempotency would collapse `"3a"`, `"3b"`, `"3c"`,
`"3d"` all to `3` via `parseInt`, creating false positive idempotency hits on
branching workflows. The `step_key` text column was added by `migrate-step-key.mjs`.

---

### 6.5.3 `local_state` — the data bag

`local_state` is a plain JSON object on each frame. It is the workflow's memory —
the working set of data available to every step in the current frame. It is the
equivalent of a function's local variables in a programming language.

#### How data flows through local_state

```
Step 1 — llm_call
  output_key: "proposed_scaffold"
  LLM returns: { domain: "stock_portfolio", tables: [...] }
  → local_state["proposed_scaffold"] = { domain: "stock_portfolio", tables: [...] }

Step 2 — js_transform
  input_key:  "proposed_scaffold.tables"   reads  local_state.proposed_scaffold.tables
  output_key: "proposed_scaffold.tables"   writes local_state.proposed_scaffold.tables
  → each table object now has a columnSummary field

Step 3 — human_gate (edit_list)
  context_key: "proposed_scaffold.tables"  binds  local_state.proposed_scaffold.tables
  message_template: "Plan for {{proposed_scaffold.domain}}"
                                           reads  local_state.proposed_scaffold.domain
  User removes PGD_Transactions
  → local_state.proposed_scaffold.tables now has 3 items instead of 4

Step 3d — human_gate (review_object)
  context_key: "proposed_scaffold.tables"  binds  local_state.proposed_scaffold.tables
  → user sees all 3 tables with their column details before DDL

Step 5 — iterator
  items_key: "proposed_scaffold.tables"    reads  local_state.proposed_scaffold.tables
  item_step: serv_schema input "{{item}}"  each item = one table object from the array
  output_key: "created_tables"
  → local_state["created_tables"] = [{ tableName: ..., status: 'created' }, ...]

Step 6 — llm_call
  input: { domain: "{{proposed_scaffold.domain}}", tables: "{{proposed_scaffold.tables}}" }
  output_key: "generated"
  → local_state["generated"] = { domainHelp: {...}, workflows: [...], intentMapRows: [...] }

Step 7 — human_gate (review_object)
  context_key: "generated.domainHelp"     binds  local_state.generated.domainHelp

Step 8 — serv_insert
  input.row: { domain: "{{generated.domainHelp.domain}}", ... }
  → inserts PGC_DomainHelp row

Step 9 — iterator (PGC_Workflow × 4)
  items_key: "generated.workflows"         reads  local_state.generated.workflows

Step 10 — iterator (PGC_IntentMap × 4)
  items_key: "generated.intentMapRows"     reads  local_state.generated.intentMapRows

Step 11 — notify
  message_template: "Domain {{proposed_scaffold.domain}} created."
                                           reads  local_state.proposed_scaffold.domain
```

#### local_state scope and persistence

`local_state` is scoped to a frame. When an iterator frame is pushed, it inherits
a copy of the parent frame's `local_state` at push time. When the iterator frame
pops, its `output_key` result is written back to the parent frame's `local_state`.

`local_state` is persisted to `PGC_WorkflowRun.state.local_state` after every
step. Lambda is stateless — `local_state` is always reloaded from the DB on the
next SQS invocation.

#### The run.input object

The workflow's original input (`run.input`) is always available as `{{input.*}}`
in templates. For `create_domain`, `run.input = { userInput: "stock portfolio" }`.
Step 1 reads `{{input.userInput}}` to pass the raw user description to the LLM.
`run.input` is never modified by any step — it is read-only origin data.

---

### 6.5.4 Human-in-the-Loop — blocking I/O

A `human_gate` step is the equivalent of blocking I/O in a program — the execution
stack suspends entirely, Lambda exits, and no compute is consumed until the user
responds. This is cost-free waiting.

#### Suspension and resumption lifecycle

```
Step Processor executes human_gate step
  │
  ├── Pushes human_gate frame onto stack
  ├── Sets PGC_WorkflowRun.status = 'awaiting_human_gate'
  ├── Builds WORKFLOW_GATE dialog from gate_type + context_key data
  ├── Enqueues WORKFLOW_GATE to SQS SlackResults
  └── Lambda returns — stack suspended, no timeout, zero cost while waiting

SlackResults → CallbackListener → Slack API → dialog rendered in thread

User interacts with dialog
  │
Slack sends interaction payload to /interactive on SlackbotFunction
  │
SlackbotFunction enqueues:
  { type: 'WORKFLOW_STEP', action: 'resume_gate',
    workflowRunId: N, userResponse: 'confirm', responseData: {...} }
  │
Step Processor receives resume_gate
  ├── Validates: top frame is human_gate, run status is awaiting_human_gate
  ├── Applies mutation (remove_item, text_input value write, etc.)
  ├── Pops gate frame
  ├── Resolves on_select → next step key
  ├── Advances parent frame.current_step
  ├── Sets status = 'running'
  └── Enqueues execute_top — execution resumes
```

#### Human Gate-type catalogue

| gate_type | User interaction | Data contract |
|---|---|---|
| `confirm` | Read a proposal, click Confirm or Cancel | `context_key` optional — context shown as text |
| `edit_list` | View a list, remove items, click Confirm | `context_key` → array; `item_primary_key`, `item_secondary_key` label each row |
| `text_input` | Type free text, click Submit | Value written to `local_state[output_key]` on resolve |
| `review_object` | View a structured summary, click Confirm | `context_key` → object or array; rendered as key-value pairs |
| `choice` | Read a question, view labelled options with descriptions, click A/B/C | Options carry `{ value, label, description, on_select }`. `value` written to `local_state[output_key]` on resolve. Mirrors HTML radio button semantics — `value` is submitted, `label` is the button text, `description` is the explanatory sentence shown above buttons |
| `select_one` | Pick one item from a list | Backlog — `buildDialog` stub exists but `context_key` only accepts flat entity lists. Use `choice` for options with descriptions |
| `select_many` | Pick zero or more items | Backlog |

#### Human gate-step schema reference

Full field reference for a `human_gate` step definition. This is the authoritative
schema for workflow authors and the right-brain when generating or validating
workflow definitions containing gate steps.

```json
{
  "step":             "3",
  "type":             "human_gate",
  "gate_type":        "confirm | edit_list | text_input | review_object | choice | select_one | select_many",
  "description":      "Human-readable — for workflow authors and right-brain only",

  "message_template": "Displayed to user. Supports {{template}} substitution from local_state.",

  "context_key":      "dot.path.into.local_state",
  "item_primary_key": "field name — used as row label in edit_list",
  "item_secondary_key": "field name — used as secondary text in edit_list",

  "item_action": {
    "condition":        "item.foreignKeys && item.foreignKeys.length > 0",
    "action":           "remove_item",
    "action_data_key":  "tableName",
    "confirm_template": "Remove {{item.tableName}} from this domain?"
  },

  "options": [
    { "label": "Looks good", "action": "confirm",   "on_select": "next"    },
    { "label": "Add a table","action": "add_table", "on_select": "step:3a" },
    { "label": "Cancel",     "action": "cancel",    "on_select": "cancel"  }
  ],

  "output_key": "key_written_to_local_state_on_resolve",

  "on_success": "next",
  "on_failure": "cancel"
}
```

**Field notes**

**`gate_type`** — determines how `callback.mjs` renders the dialog and what
`resume_gate` expects in `responseData`. See the gate type catalogue in 6.5.4.

**`message_template`** — resolved via `template-resolver.mjs` at suspension time,
not at step definition time. Template variables are read from `local_state` at the
moment the gate suspends.

**`context_key`** — dot-path into `local_state`. For `edit_list`, must resolve to
an array. For `review_object`, resolves to an object or array — arrays are rendered
as a table-name / column-list display. Optional for `confirm`.

**`item_action`** — `edit_list` only. Defines a per-row action button. `condition`
is evaluated against each item — items where the condition is falsy do not get the
button. Only `remove_item` is currently implemented; others are Backlog.

**`options`** — rendered as Block Kit buttons. Each `on_select` drives post-gate
routing: `"next"` advances sequentially, `"step:N"` jumps to step N, `"cancel"`
cancels the run. Must include at least one option with `action: "cancel"` (confirm/edit_list)
or `value: "cancel"` (choice).

Two option shapes — determined by `gate_type`:
- `confirm`, `edit_list`, `review_object` use `{ label, action, on_select }`
- `choice` uses `{ value, label, description, on_select }` — HTML radio button semantics:
  `value` is the machine identifier written to `output_key` and matched by `resume_gate`;
  `label` is the short button text (e.g. `"A"`, `"B"`);
  `description` is the explanatory sentence rendered above the buttons as a list.

**`output_key`** — written on gate resolution for two gate types:
- `text_input`: the typed value is written to `local_state[output_key]`
- `choice`: the selected `option.value` is written to `local_state[output_key]`

**`on_timeout` / `timeout_seconds`** — reserved fields, not yet implemented.
When implemented, a gate that receives no user response within `timeout_seconds`
will resolve via `on_timeout` routing (e.g. `"cancel"` or a specific step key).
Until then, gates wait indefinitely — cost-free while suspended.

**`on_success` / `on_failure`** — gate-level fallbacks. `on_success` is the
default routing when no `on_select` override applies. `on_failure` handles
gate execution errors (e.g. dialog build failure), not user cancellation.
User cancellation is always routed via the option with `action: "cancel"`.

---

#### UI Dialog Contract — WORKFLOW_GATE message

The Step Processor produces a UI-agnostic `WORKFLOW_GATE` message. `callback.mjs`
translates it to Slack Block Kit. Adding a new UI is one new renderer in
`callback.mjs` — the Step Processor and all workflows are unchanged.

```json
{
  "type":          "WORKFLOW_GATE",
  "workflowRunId": 23,
  "gate_type":     "edit_list",
  "dialog": {
    "message":  "Here's my plan for domain stock_portfolio.",
    "fields": [
      { "type": "list",   "items": [{ "primary": "PGD_Portfolios", "secondary": "name, currency, created_at" }] },
      { "type": "actions","items": [{ "label": "Looks good", "action": "confirm" }, ...] }
    ]
  },
  "callback": { "provider": "slack", "channel": "C0AEJ87JSKF", "threadId": "..." },
  "message_ts": "1711358400.123"
}
```

`message_ts` is present only on `remove_item` re-renders — signals `callback.mjs`
to use `chat.update` (in-place edit) instead of posting a new message.

#### WORKFLOW_ERROR message shape

```json
{
  "type":          "WORKFLOW_ERROR",
  "workflowRunId": 18,
  "step":          "3a",
  "message":       "Workflow stuck at step \"3a\" — possible routing error. Run id: 18",
  "traceId":       "uuid"
}
```

Posted to Slack when: Guard 1 fires, a step throws after exhausting retries, or
an iterator item fails. Always includes `workflowRunId` so the user can reference
it with `/shutdown` or for debugging.

**Slack rendering — human-readable summary only.** `callback.mjs` never posts the
raw `message` string into a Slack block — it may be thousands of characters (e.g.
a full AJV validation error array). Three summary cases are handled:
- LLM validation failure: `"LLM output validation failed after 2 attempts (N schema errors). The prompt has been logged for improvement."`
- LLM response failure (timeout, empty, invalid JSON): first 200 chars of the error message
- Structural step failure: first 500 chars of the error message
Full error detail is always in CloudWatch and, for prompt validation failures, in `PGC_Prompt.error_log`.

**TROUBLESHOOT_WORKFLOW discriminator.** `run-workflow.mjs` only enqueues
`TROUBLESHOOT_WORKFLOW` for structural errors — errors that indicate a problem
in the workflow definition itself. LLM response failures and schema validation
failures (`llm_call validation failed`) are prompt quality issues that
`TROUBLESHOOT_WORKFLOW` cannot fix — they are excluded from the repair chain.

#### Mutation during gate suspension

`edit_list` gates support `remove_item` — the user can remove items from the
list while the gate is still open. Each click sends `userResponse: 'remove_item'`
with `responseData.tableName`. The Step Processor:
1. Filters the item from `local_state[context_key]`
2. Persists the updated `local_state`
3. Re-renders the gate via `chat.update` (in-place edit of the Slack message)

The stack remains suspended throughout. The gate stays open until the user clicks
Confirm or Cancel.

#### Routing from gates — on_select

Each option in a `human_gate.options` array has an `on_select` that drives
post-gate routing:

```
"on_select": "next"      → advance to sequentially next step in the workflow
"on_select": "step:3d"   → jump to step "3d" (forward or backward)
"on_select": "cancel"    → cancel the run, clear stack
```

`on_select` is resolved by the Step Processor in `resolveOnSelect()` after the
gate frame is popped. The parent frame's `current_step` is set to the resolved
step key before the next `execute_top` is enqueued.

**Routing errors are fatal.** If `on_select` routes to a step that was already
recorded in `PGC_WorkflowRunStep` for the same `frame_id`, the idempotency check
fires on the next `execute_top`. Guard 1 detects this as a stuck step after 3
consecutive hits and fails the run with a Slack notification.

---

### 6.5.5 Parallel execution hooks — deferred, Backlog

The frame schema includes hooks for future parallel execution. These fields are
defined in the frame structure now so the schema is stable when fan-out/fan-in
is implemented. They are never populated in sequential mode.

```json
{
  "frame_id":        "uuid",
  "type":            "workflow | iterator | human_gate",
  "status":          "running | awaiting | completed | failed",

  "parallel_group":  null,
  "fan_out_keys":    null,
  "fan_in_barrier":  null
}
```

**`parallel_group`** — UUID shared by all frames executing in the same fan-out
group. Null in sequential mode. When set, the Step Processor knows these frames
are siblings and coordinates their completion via `fan_in_barrier`.

**`fan_out_keys`** — array of item keys this frame is responsible for processing.
In sequential mode the iterator frame processes all items itself. In parallel mode,
the iterator spawns one frame per item (or per batch), each carrying its subset in
`fan_out_keys`.

**`fan_in_barrier`** — the frame_id of the parent iterator frame waiting for all
fan-out siblings to complete before popping and continuing. When the last sibling
completes, it pops the barrier frame and re-enqueues `execute_top` on the parent.

**Why defined now:** The `PGC_WorkflowRunLock` table (Section 4.3.2) is already
reserved for the optimistic locking required by parallel execution. Defining the
frame hooks alongside it ensures the execution model is internally consistent before
Backlog lands. Sequential mode never reads these fields — they are null-safe.

**Backlog prerequisite:** Parallel execution requires the cycle detector (Guard 3)
to be implemented first. A fan-out that triggers another fan-out would create
unbounded concurrency without cycle detection at workflow registration time.

---

### 6.5.6 `simulate` step type — workflow path simulation and validation

The `simulate` step type is the right-brain’s earliest operational capability.
It dry-runs a generated workflow definition through the Step Processor’s own
execution logic using injected mock outputs and decision scripts, validates every
`local_state` transition, and surfaces structured failure reports before the
workflow is registered in `PGC_Workflow`. It is a prerequisite for `create_workflow`
being trustworthy and is classified as Phase 2 work, not Backlog.

#### Why simulation is not optional for `create_workflow`

Without simulation, the only way to discover a broken workflow is to deploy it
and run it. Given that `create_workflow` produces workflows that will themselves
execute against real data, an undetected broken step is a production incident.
The `confirmed_domain_help` class of bug — a template reference to a key that
was never written to `local_state` — is invisible to Ajv validation and only
manifests at execution time. Simulation catches it before registration.

#### Step definition schema

```json
{
  "step":        "4",
  "type":        "simulate",
  "description": "Dry-run the generated workflow definition against all declared paths",
  "input": {
    "steps_key":       "generated_workflow.steps",
    "mock_outputs_key":"generated_workflow.mock_outputs",
    "paths_key":       "generated_workflow.simulation_paths"
  },
  "output_key":  "simulation_result",
  "on_success":  "next",
  "on_failure":  "step:3"
}
```

`steps_key`, `mock_outputs_key`, and `paths_key` are dot-paths into `local_state`.
They reference keys written by the LLM generation steps that precede the simulate
step. `on_failure: "step:3"` routes back to the human gate where the user reviewed
the step array, with simulation failures injected into the gate context.
`mock_outputs_key` and `paths_key` are optional — when absent the simulate step
runs Level 1 static analysis only.

#### Inputs the LLM must generate

The LLM calls that precede simulate produce three structures, each in a separate
`llm_call` step. See Section 6.8 for why these are produced across multiple LLM
calls rather than one.

**`steps`** — the workflow step array. Step keys, types, routing values, templates.

**`mock_outputs`** — a plain object keyed by step number. Only steps that produce
output need mocks (`llm_call`, `serv_query`). Steps that are pure side-effects
(`serv_insert`, `notify`, `end`) do not.

```json
{
  "mock_outputs": {
    "1": { "domain": "recipes", "tables": [{ "tableName": "PGD_Recipes", "columns": [] }] },
    "6": { "domainHelp": { "domain": "recipes", "aliases": ["recipe", "recipes"] }, "workflows": [] }
  }
}
```

**`simulation_paths`** — an array of named execution paths. Each path is an ordered
list of decisions — one entry per branch point (gate step, failure point, iterator
outcome). Human gates are simulated by injecting `user_response` and `on_select`
as if the user clicked that option. LLM steps, SERV steps, and `js_transform` steps
are simulated using their mock output. The path terminates when it reaches `end`,
`cancel`, or `human_feedback`.

```json
{
  "simulation_paths": [
    {
      "path_name": "happy_path",
      "decisions": [
        { "step": "1",  "outcome": "success" },
        { "step": "3",  "outcome": "gate", "user_response": "confirm", "on_select": "step:3d" },
        { "step": "3d", "outcome": "gate", "user_response": "confirm", "on_select": "next" },
        { "step": "4",  "outcome": "gate", "user_response": "confirm", "on_select": "next" },
        { "step": "5",  "outcome": "success" }
      ],
      "expected_terminal": "end"
    },
    {
      "path_name": "user_cancels_at_review",
      "decisions": [
        { "step": "1",  "outcome": "success" },
        { "step": "3",  "outcome": "gate", "user_response": "cancel", "on_select": "cancel" }
      ],
      "expected_terminal": "cancelled"
    },
    {
      "path_name": "llm_step_fails",
      "decisions": [
        { "step": "1", "outcome": "failure", "error": "LLM returned invalid JSON" }
      ],
      "expected_terminal": "human_feedback"
    }
  ]
}
```

The LLM is expected to enumerate at minimum: the happy path, one cancel path per
gate step, and one failure path per `llm_call` or `serv_*` step. The `output_schema`
for the `generate_workflow_paths` prompt enforces this minimum coverage.

#### What the simulator validates

The simulator runs each path independently. For each path it:

1. Resets `local_state` to `{ input: run.input }` — a clean slate per path
2. Walks steps in execution order driven by the decision script
3. At each step, records the `local_state` transition: keys present before, keys
   added or mutated after, template variables resolved and to what values
4. Flags any step where a template variable could not be resolved (`{{key}}` not
   in `local_state` at that point)
5. Verifies the path’s terminal step matches `expected_terminal`
6. Detects backward-reference loops: a step key reached more times than there are
   gate decisions for it in the script is flagged as a potential infinite loop
   (safe if a `human_gate` step exists on the path from target back to source —
   the same rule as Guard 3)

**Three validation levels run in order. Later levels only run if earlier levels pass.**

**Level 1 — Static analysis (no execution, no mocks needed)**

Runs before any path simulation. Catches structural errors in the step array itself:

| Check | Failure class |
|---|---|
| Every `on_success`, `on_failure`, `on_select` value is a known routing token | Unknown routing value |
| Every `step:N` routing target exists in the step array | Dead routing target |
| Every `{{template}}` reference resolves to an `output_key` written by a prior step on that path | Unresolved template variable |
| Every `items_key` in an `iterator` resolves to an array written by a prior step | Iterator source not an array |
| Every `input.prompt` in an `llm_call` names an `intent_category` in `PGC_Prompt` | Unknown prompt reference |
| No `output_key` is set on a `review_object` or `confirm` gate | Gate type does not write output |
| Every `human_gate` has at least one option with `action: "cancel"` | Missing cancel path |

Level 1 failures are returned immediately — no path execution occurs.

**Level 2 — Path execution (uses mocks and decision scripts)**

Executes each path in `simulation_paths`. For each step, injects the mock output
or decision instead of calling the real service or LLM. Records the `local_state`
transition log. Fails the path if any template variable is unresolvable or if the
terminal step does not match `expected_terminal`.

**Level 3 — Skip-path analysis (failure recovery, advisory)**

For every step with `on_failure: "human_feedback"`, the simulator runs an additional
micro-path: what happens if the user chooses Skip at the recovery gate? If skipping
the step leaves a `null` at an `output_key` that a downstream step reads, the
simulator flags this as a latent data flow risk. This is advisory — it does not
fail the simulation — but it is included in the failure report and shown to the
user in the review gate.

#### Simulation result structure

Written to `local_state[output_key]` on completion:

```json
{
  "passed": true,
  "paths_run": 3,
  "paths_passed": 3,
  "paths_failed": 0,
  "static_analysis": { "passed": true, "issues": [] },
  "path_results": [
    {
      "path_name": "happy_path",
      "passed": true,
      "steps_executed": 11,
      "terminal": "end",
      "expected_terminal": "end",
      "local_state_transitions": [
        {
          "step": "1",
          "keys_before": ["input"],
          "keys_added": ["proposed_scaffold"],
          "template_vars_resolved": {},
          "template_vars_missing": []
        }
      ]
    }
  ],
  "skip_path_warnings": []
}
```

On failure, `passed: false` and `paths_failed > 0`. The first failed path’s
transition log is included in full, showing exactly which step failed and what
`local_state` contained at that point. This is presented to the user in the
`review_object` gate when `on_failure: "step:3"` routes back for correction.

#### Simulation mode flag on WorkflowRun

When `run-workflow.mjs` executes a `simulate` step, it sets
`PGC_WorkflowRun.state.simulation_mode = true` before the simulation begins and
clears it after. This flag is checked by every step handler in `step-executor.mjs`
— when true, the handler returns the mock output from the decision script instead
of calling the real service. No new Lambda, no new SQS queue — the same Step
Processor executes both live runs and simulations. The only difference is the
execution context.

#### HTTP endpoint

`POST /api/v1/proc/simulate-workflow` accepts the step array, mock outputs, and
simulation paths directly, without a `WorkflowRun`. This is the developer-facing
test surface for validating workflow definitions during development, before they
are registered in `PGC_Workflow`. See openapi.yaml for the full request/response
contract.

---

---

### 6.6 Right-Brain Output Validation — correction loop

Every `llm_call` step runs through a two-attempt validation loop before its output
is accepted and stored in `local_state`. This is implemented in `review-output.mjs`
and called directly (intra-proc import) from `step-executor.mjs`.

#### Validation passes

Three passes run in strict order. Later passes only execute if all earlier passes
have returned zero errors.

**Pass 1 — Ajv JSON Schema**
The `output_schema` field on the `PGC_Prompt` row is an Ajv-compatible JSON Schema.
The LLM output is validated against it. If it fails, the specific Ajv errors are
collected and passed to the correction attempt.

Every prompt must have an `output_schema`. A prompt without one skips Ajv
validation entirely — this is a known gap in any prompt row that lacks the field.

**Pass 2a — Schema semantic rules** (`runSemanticRules()`)
Runs only if Pass 1 passed, and only when the output contains a `tables` array
(i.e. `create_domain` and `design_table` prompts). Rules:

- Rule 1: Every table must have the `set_updated_at()` BEFORE UPDATE trigger
- Rule 2: Every `upsert_key` column must have a matching UNIQUE constraint
- Rule 3: Every FK parent table must exist in the same scaffold

These rules catch cross-reference errors that JSON Schema cannot express —
a FK pointing to a table not in the output, or a constraint on a nonexistent column.

**Pass 2b — Routing value rules** (`runRoutingValueRules()`)
Runs only if Pass 1 passed, and only when the output contains a `steps` array
(i.e. workflow generation prompts: `generate_workflow_steps` and any prompt whose
output shape includes a steps array). Does not run on `create_domain` output.

Rules enforced on every step in the array:

- Every `on_success`, `on_failure`, and `on_complete` value must be a known routing
  token: `next`, `end`, `cancel`, `human_feedback`, or `step:<key>`
- Every `step:N` target must exist as a step key in the same array — dead targets
  are caught here before the workflow is ever registered or simulated
- Every `human_gate` must have at least one option with `action: "cancel"`

Pass 2a and Pass 2b are mutually exclusive by output shape — an output with `tables`
never has `steps`, and vice versa. Both use the same error format
`{ type: "semantic", rule, message, step? }` so the correction loop handles them
identically.

#### Correction loop

```
Attempt 1:
  Call LLM → parse JSON → run validation (Pass 1 + Pass 2a or 2b)
  Valid → store at output_key, continue
  Invalid → collect errors, attempt 2

Attempt 2 (callLlmWithCorrection):
  Call LLM with original prompt + all collected errors injected
  Valid → store corrected output at output_key, continue
  Invalid → log errors to PGC_Prompt.error_log → step throws

Step throws → run-workflow.mjs catch block:
  on_failure === "human_feedback" → push recovery gate (Retry / Skip / Cancel)
  on_failure !== "human_feedback" → mark run failed → WORKFLOW_ERROR to Slack
```

The correction is a second LLM call with the same prompt plus the specific
validation errors. The LLM sees exactly what was wrong and why. This is not a
retry — it is a targeted correction.

When both attempts fail, the step throws. Whether the run is marked failed or
a recovery gate is shown to the user depends entirely on the step's `on_failure`
field — not on anything inside `review-output.mjs`. The validation module is
responsible only for determining validity and collecting errors; routing on
failure is the Step Processor's responsibility.

---

### 6.7 Workflow Safety — circuit breakers and Guard 1

#### Guard 1 — stuck-step detector (implemented)

A workflow routing error can cause the same step to be attempted repeatedly via
idempotency re-enqueue. Guard 1 detects this and fails the run before SQS retries
exhaust.

The stuck state is tracked in `PGC_WorkflowRun.error` jsonb — no schema change:

```json
{ "stuck_step": "3a", "stuck_count": 2 }
```

On each idempotency hit for the same step, `stuck_count` increments. At count 3,
the run is marked `failed` and `WORKFLOW_ERROR` is posted to Slack:

```
Workflow stuck at step "3a" — possible routing error in workflow definition. Run id: 18
```

The stuck state is cleared on any successful step execution — a single idempotency
hit on a healthy workflow (legitimate SQS redelivery on a new step) resets the counter.

#### Deferred safety mechanisms (Backlog)

| Guard | Purpose | Trigger |
|---|---|---|
| Velocity detector | Too many steps per time window | `steps_in_window` / `window_started_at` on run |
| Execution accumulator | Total cost / duration limit | `PGC_SystemContext` thresholds |
| Cycle detector | Circular workflow routing | Graph analysis at workflow registration time |
| `/shutdown` | Emergency stop any run | Sets status = cancelled; execute_top checks before executing |

When any guard fires and marks a run `failed`, it enqueues `TROUBLESHOOT_WORKFLOW`
for the failing workflow name before posting `WORKFLOW_ERROR` to Slack. This connects
the circuit breaker layer to the Tier 1 reactive repair path (Section 6.12) — the
system attempts self-diagnosis immediately after every detected structural failure,
whether the failure is a stuck step, a velocity limit, or a caught exception.

Untrapped failures — hangs, silent infinite loops, Lambda timeouts — are surfaced by
CloudWatch alarms and SQS DLQ notifications. These are not self-healing at runtime;
they require developer intervention. The `TROUBLESHOOT_WORKFLOW` curl path in
Section 6.12 is the manual entry point for these cases.

#### Emergency shutdown

`POST /proc/shutdown { workflowRunId }` sets `PGC_WorkflowRun.status = 'cancelled'`.
Every `execute_top` invocation checks status before executing any step. If
`cancelled`, the message is discarded. The shutdown contract is: no step will
execute after `/shutdown` is called, even if SQS messages are already in flight.

---

### 6.8 create_domain Workflow — full annotated example

`create_domain` is the primary demonstrator workflow. It uses every major Step
Processor capability: `llm_call`, `js_transform`, multi-step `human_gate`
sequences with branching, `iterator`, `serv_insert`, and `notify`.

Reading this workflow against sections 6.5.1–6.5.4 is the intended way to understand
how the Step Processor executes a real program.

#### Data flow summary

```
run.input.userInput = "stock portfolios"

Step 1  llm_call → proposed_scaffold = { domain, tables: [4 table objects with columns/FKs/constraints] }
Step 2  js_transform → proposed_scaffold.tables[*].columnSummary added
Step 3  human_gate edit_list → user reviews tables, may remove child tables or jump to add-table branch
        ├── confirm   → step:3d
        ├── add_table → step:3a (text_input)
        └── cancel    → cancelled

Step 3a human_gate text_input → new_table_description written to local_state
Step 3b llm_call → new_table designed, stored at local_state["new_table"]
Step 3c js_transform → merge new_table into proposed_scaffold.tables, loop back to step:3
Step 3d human_gate review_object → user reviews all table column details before DDL
        ├── confirm → next (step 4)
        └── cancel  → cancelled

Step 4  human_gate confirm → final DDL confirmation
        ├── confirm → next (step 5)
        └── cancel  → cancelled

Step 5  iterator over proposed_scaffold.tables
          item_step: serv_schema createTable(item)
          → created_tables = [{ tableName, status: 'created' }, ...]

Step 6  llm_call → generated = { domainHelp, workflows: [4 CRUD workflows], intentMapRows: [4 rows], entitySchemas: [1+ entity definitions] }
Step 7  human_gate review_object → user reviews domainHelp (aliases, description, commands)
        ├── confirm → next (step 8)
        └── cancel  → cancelled

Step 8   serv_insert PGC_DomainHelp ← generated.domainHelp
Step 9   iterator over generated.workflows
           item_step: serv_insert PGC_Workflow(item)
Step 10  iterator over generated.intentMapRows
           item_step: serv_insert PGC_IntentMap(item)
Step 10b iterator over generated.entitySchemas
           item_step: serv_insert PGC_EntitySchema(item)
Step 11  notify → "Domain {{proposed_scaffold.domain}} created."
Step 12  end
```

#### Why the add-table branch loops back

Step 3c uses `on_success: "step:3"` — a backward jump. This is the first
intentional backward reference in the system. After the new table is designed and
merged into `proposed_scaffold.tables`, the workflow returns to step 3 so the user
can review the updated list (now including their new table) and either confirm,
add another, or cancel. The loop continues until the user confirms at step 3.

The Step Processor handles this correctly because step keys are resolved by string
equality. `"step:3"` resolves to step `"3"` — there is no confusion with `"3a"`,
`"3b"`, `"3c"`, or `"3d"`. Each branching step has a distinct `frame_id` x
`step_key` pair in `PGC_WorkflowRunStep`, so idempotency works correctly
across loop iterations.

#### Prompt dependencies

| Step | Prompt `intent_category` | Output stored at |
|---|---|---|
| 1 | `create_domain` v3 | `proposed_scaffold` |
| 3b | `design_table` v1 | `new_table` |
| 6 | `generate_crud_workflows` v5 | `generated` |

All three prompts have `output_schema` defined. The correction loop runs on all
three if the LLM output is malformed.

---

#### Generated CRUD workflows — one subsection per verb

The `generate_crud_workflows` v5 prompt produces four workflow definitions written
to `PGC_Workflow` at step 9. All four have `action_type: workflow` in
`PGC_IntentMap`. Below is the canonical step structure for each.

##### list_\<domain\>

Zero-LLM formatted list. Runs `serv_query` on the root table and posts a count
and preview to Slack.

```
Step 1  serv_query PGD_<root_table>  (no filters — all rows)
          output_key: results
Step 2  notify → "Found {{results.length}} <domain> record(s)."
Step 3  end
```

##### add_\<domain\>

LLM-parse-first multi-table insert. Accepts natural language input of any length.
Uses `buildEntitySchema` to load live column definitions from `PGC_Schema` for
root and all child tables — single source of truth, immune to schema drift.

```
Step 1  serv_entity_schema  (input.entityName = <PascalCase>)
          output_key: full_entity_schema
          Reads PGC_EntitySchema for join topology + PGC_Schema for live column defs.
          Returns: {
            entity_name, description,
            root:     { table, columns: [non-system, non-FK col names] },
            children: [{ table, alias, fk_column, output_key, columns }]
          }

Step 2  llm_call parse_entity_input  v2
          input: { userInput: "{{input.userInput}}",
                   full_entity_schema: "{{full_entity_schema}}" }
          output_key: parsed_entity
          Returns: { root: { <field>: <value> },
                     children: { <output_key>: [rows] } }

Step 3  human_gate review_object
          context_key: parsed_entity
          "Here's what I parsed — does this look right?"
          ├── Looks good → next
          └── Cancel     → cancelled

Step 4  serv_insert <root_table>
          row: "{{parsed_entity.root}}"
          output_key: new_record

Step 5  js_transform buildChildInserts
          output_key: child_inserts

Step 6  iterator over child_inserts
          item_step: serv_insert <child_table>
            row: { <fk_column>: "{{new_record.id}}", <col>: "{{item.<col>}}" }

Step 7  notify → "Added <domain> record (id: {{new_record.id}})."
Step 8  end
```

**Key design decisions:**
- `serv_entity_schema` (step 1) fetches live column definitions from `PGC_Schema` at
  every run — not from `PGC_EntitySchema.aggregations.columns`, which is set at domain
  creation time and can drift. New columns added to any table are immediately visible
  to the LLM without recreating the domain.
- `parse_entity_input` v2 receives `full_entity_schema` — it uses
  `full_entity_schema.root.columns` as the authoritative field list for the root row
  and `full_entity_schema.children[].columns` for each child. Column name hallucination
  is eliminated because the LLM never guesses column names.
- Child iterators inject `new_record.id` as the FK column at insert time.
  FK columns are never included in `parsed_entity.children` output.

##### update_\<domain\>

Confirmation-gate update on the root table by id. Requires `id=N` and at least
one `field=value` pair (enforced by Pass 1 or Pass 2 classification before the
workflow is invoked). Only updates the root table — child row updates require a
dedicated workflow.

```
Step 1  human_gate confirm
          "Update <domain> id={{input.id}} with provided changes?"
          ├── Confirm → next
          └── Cancel  → cancelled

Step 2  serv_update <root_table>
          filters: [{ column: id, op: eq, value: "{{input.id}}" }]
          updates: "{{input.updates}}"
          output_key: updated_record

Step 3  notify → "Updated <domain> record (id: {{input.id}})."
Step 4  end
```

##### delete_\<domain\>

Confirmation-gate delete on the root table by id. Requires `id=N` (enforced by
Pass 1 or Pass 2). Child rows are cleaned up by the database `ON DELETE CASCADE`
constraint on the FK — no application-level child deletion needed.

```
Step 1  human_gate confirm
          "Delete <domain> id={{input.id}}? This cannot be undone."
          ├── Confirm delete → next
          └── Cancel         → cancelled

Step 2  serv_delete <root_table>
          filters: [{ column: id, op: eq, value: "{{input.id}}" }]

Step 3  notify → "Deleted <domain> record (id: {{input.id}})."
Step 4  end
```

#### Gap taxonomy retrospective — what create_domain handles implicitly

`create_domain` was built before the gap taxonomy (Section 6.11) was formalised.
Mapping its current steps against that taxonomy reveals what works, what is handled
post-hoc, and what would improve under a future L/R collaboration pass.

**Type 1 — Preference gaps (user decisions that affect schema structure)**

Not handled before the LLM call. The user types one line — "stock portfolios" —
and the LLM guesses at every structural choice: how many tables, whether to track
transactions or only holdings, whether multi-currency support is needed, whether
to model positions as a derived view or a materialised table. These are genuine
preference questions that produce structurally different schemas. The user sees the
result at step 3 and can remove tables or add one via the add-table branch — but
this is post-hoc correction, not pre-design guidance. The LLM already made all the
choices; the user is editing the output rather than directing the input.

The `temperature: 0.2` variance entry in the tech debt register is a direct symptom
of this: the LLM produces different schemas for the same description across runs
because no design constraints were provided before the call.

**Type 2 — Knowledge gaps (domain best practices the LLM does not reliably know)**

Not handled. There is no right-brain research pass. The `create_domain` LLM call
is general-purpose Sonnet receiving a one-line description with no domain context
injection. A stock portfolio schema designed without domain research will likely
miss: position-level cost basis tracking, the distinction between realised and
unrealised P&L, the need for a transaction log as an append-only audit trail, and
the convention of separating ticker metadata from position data. These are Type 2
knowledge gaps that a research pass would resolve before schema generation begins.

**Type 3 — Schema gaps (structural dependencies within the produced output)**

Partially handled — and handled correctly where it exists. The topological sort in
step 3c is the system's first Type 3 resolution: it detects FK ordering dependencies
between the LLM-produced tables and sorts them so parent tables are created before
child tables reference them. This was introduced in Session 20 after FK constraint
errors in DDL. The `existing_table_modifications` field in the `design_table` prompt
is also a Type 3 resolution — it allows the add-table branch to patch FK columns
into existing tables when a new parent concept is introduced mid-design.

**Type 4a / 4b — Missing prompts and step types**

Not applicable. `create_domain` does not generate prompts or require step types
beyond what already exists.

**Type 5 — Ambiguity (intent underspecified)**

Not handled. If the user types `/m create domain stock portfolio` and
`stock_portfolio` already exists, the workflow re-runs the LLM and overwrites the
existing schema. A `serv_query` pre-check step before step 1 would detect the
existing domain and surface the choice: update aliases only, recreate from scratch,
or cancel. This is a Type 5 gap and is the correct fix for the duplicate domain
detection entry in the tech debt register — a single `serv_query` step, not an
architectural change.

**What a future create_domain v9 would look like with L/R**

Applying the L/R architecture would follow the same pattern as `create_workflow` v3.
The change is entirely in the steps before the existing step 1 LLM call:

```
Pre-check  serv_query PGC_DomainHelp — does this domain already exist?
           If yes → human_gate: update aliases / recreate / cancel  (Type 5)

Step 1R    RIGHT BRAIN: research_domain_schema (Perplexity sonar)
           Input: userInput + inferred domain category
           Retrieves: data modelling best practices for this domain type,
             canonical table structures, normalisation patterns, common pitfalls
           Surfaces: Tier 1 preference questions where the answer changes
             schema structure (e.g. "Track individual transactions or
             current holdings only?", "Multi-currency support?")

Step 1a    js_transform: build preference gate descriptors from research output

Step 1b    condition: any preference questions?
           → iterator: Tier 1 preference gates — user answers structural choices

Step 1c    LEFT BRAIN: llm_call create_domain
           Now receives: userInput + research findings + confirmed preferences
           Produces a schema implementing known choices, not guesses
           → proposed_scaffold

Steps 2–12  unchanged from current implementation
```

The user review gate at step 3 (edit_list) remains — the user can still remove
tables or add one. But by step 3 the schema already reflects stated preferences
and domain best practice. The gate becomes refinement rather than correction.

**Why this is deferred**

The right-brain improvement loop (Backlog item 8) will address `create_domain`
variance by observing failed domains via `PGC_WorkflowStats` and improving the
prompt from evidence — a lower-cost path than a full L/R pass. The L/R pass
belongs in `create_domain` v9 once the improvement loop has been running long
enough to identify which preference questions produce the most variance. The
duplicate domain detection (Type 5) should be fixed sooner — it is a `serv_query`
pre-check step and does not require the L/R architecture.

---

### 6.9 create_workflow Workflow 

`create_workflow` is the workflow that makes the brain self-extending. When a user
says `/m create a workflow Spanish vocabulary quiz`, the brain researches the domain,
elicits design preferences, produces a complete design specification, generates a
validated step array, and registers the workflow — without any code changes. Every
new workflow becomes immediately available to the Intent Preprocessor.

---

#### Why create_workflow is harder than create_domain

`create_domain` asks an LLM to produce a PostgreSQL schema. The schema is
self-contained — every field in the output is a leaf value or a well-bounded
sub-object. The Ajv `output_schema` can enforce structural correctness fully.

`create_workflow` asks an LLM to produce a step array where every field
cross-references other fields — step keys, template variable names, routing
targets, prompt `intent_category` values, and `output_key` names must all be
internally consistent. A step array can pass Ajv validation and still be broken
because `output_key: "foo"` on step 3 is referenced as `{{bar}}` on step 6.
This is a referential integrity problem, not a structural one. Ajv cannot catch it.

Two mechanisms close this gap: **semantic validation rules** (static analysis on
the step array — see Section 6.5.6 Level 1) and **simulation** (execution-time
data flow validation — see Section 6.5.6 Levels 2 and 3). Both run before the
workflow is registered.

But there is a deeper problem than validation. A single LLM call asked to
simultaneously understand the domain, research best practices, resolve design
tradeoffs, map schema, design dialog boxes, and generate valid step arrays produces
inconsistent results for behaviourally complex workflows. The failure mode is not an
obviously wrong answer but a subtly inconsistent one that passes Ajv and only breaks
at simulation time. The correct solution is to decompose the cognitive work before
any step array is generated — which is what the L/R collaboration architecture does.

---

#### Decision: L/R collaboration architecture (v3)

`create_workflow` v3 applies the gap taxonomy (Section 6.11) as its primary design
principle. Every gap type is resolved by its correct owner at the correct point in
the pipeline — before the step generator receives its input.

The key insight is the role separation:

- **Right brain** retrieves world knowledge the system does not have: what are best
  practices for this type of workflow? What design options exist? Which have clear
  winners? Which require user preference to decide?
- **User** resolves genuine preference tradeoffs surfaced by the right brain —
  decisions the system cannot make because there is no objectively better answer,
  only the user's answer.
- **Left brain** designs the implementation given known preferences and research.
  It inspects the live domain schema, maps state requirements, designs every dialog
  box, identifies missing prompts (and writes them), and detects schema gaps. It
  produces a complete `design_spec` — a gap-free plain-language description of every
  step in the workflow.
- **Step generator** translates `design_spec` into a step array. It is a
  code-generation call, not a design call. All design decisions are already made.

This decomposition is what makes the architecture reliable. Each LLM call is narrow,
well-scoped, and independently correctable by the 2-attempt correction loop.

---

#### Decision: right brain first, user second, left brain third

The right brain runs before the left brain — not after — because the left brain
designs better when it starts with domain knowledge already in hand. This is not
how the system was first envisioned (left brain first pass → right brain fills gaps
→ left brain synthesises), but it is the correct order. The right brain's job is to
research the domain, not to respond to the left brain's gap list. A domain expert
does not wait to be asked what they know — they bring knowledge before analysis begins.

The right brain uses Perplexity sonar (`LLM_CHAT_URL`) because this is a retrieval
task: retrieve current, sourced best practices about the domain. Sonar is built for
this. Sonnet generates structured output from a complete specification — it is not
the right model for open-ended domain research.

User preference gates run between right brain and left brain. By the time the left
brain designs the workflow, all preference questions are answered. The left brain
receives a partially resolved specification and produces a fully resolved one.

---

#### Decision: PGC_SystemContext injection into executeLlmCall

`generate_workflow_steps` and `analyze_and_design_workflow` receive step type
contracts and routing rules from `PGC_SystemContext` — not from inline prompt text.
`executeLlmCall` in `step-executor.mjs` loads all `PGC_SystemContext` rows after
building `resolvedInput`, filters on `inject_always = true` OR
`inject_for.includes(intentCategory)`, and merges the matching rows into the
substitution map before `prompt_text` reduction.

Priority: `step.input` values (resolved from `local_state`) take precedence over
context rows. Context fills placeholders not supplied by step input.

When a new step type goes live, `PGC_StepType` is updated and `upsert-system-context.mjs`
re-derives `step_type_contracts`. The prompt does not change. This is the correct
locus of control for evolving the instruction set.

---

#### Decision: left brain writes missing prompts inline

When `analyze_and_design_workflow` identifies a required prompt that does not exist
in `PGC_Prompt` (Type 4a gap), it writes the full `prompt_text`, `output_shape`,
and `model` in the `prompts_needed` entry with `exists: false`. A `js_transform`
step filters these entries, then an iterator seeds them into `PGC_Prompt` before
`generate_workflow_steps` runs. The step generator can reference the new prompt
`intent_category` immediately.

This eliminates the previous requirement to manually seed prompts like
`evaluate_translation` before running `create_workflow`. The left brain writes them
as part of its design pass.

---

#### Decision: schema gap gate cancels cleanly with domain suggestion

When `analyze_and_design_workflow` detects a blocking schema gap (Type 3b), it
includes a `domain_suggestion` field in `schema_changes[]` — the suggested input
for `/m create domain` to create the missing table. The schema gap gate shows the
user what is missing, what they gain, and what they lose without it, with a concrete
command suggestion. The user chooses: create the table first, build without it, or
cancel. Sub-workflow dependency tracking (returning to `create_workflow` after
`create_domain` completes) is Backlog.

---

#### Five-phase step structure (v3)

```
PHASE 0 — DATA LOAD
Step 1   serv_query PGC_Schema (domain filter)
         → domain_schema

PHASE 1 — L/R COLLABORATION
Step 2   RIGHT BRAIN: llm_call research_workflow_domain (Perplexity sonar)
         Input:  { workflow_description: "{{input.userInput}}",
                   domain: "{{input.domain}}" }
         Output: right_brain_research
                 { findings: [...], preference_questions: [...], out_of_scope: [...] }
         on_failure: next  ← research failure is non-blocking; left brain
                              proceeds without enrichment

Step 3   js_transform — build Tier 1 preference gate descriptors
         Reads: right_brain_research.preference_questions
         Output: preference_gates (array of gate descriptors with options)

Step 4   condition — any preference questions?
         on_truthy: next (step 5 iterator)
         on_falsy: step:6 (skip directly to step type load)

Step 5   iterator — Tier 1 USER PREFERENCE GATES (sequential)
         One human_gate confirm per preference question.
         Each gate writes its selection to user_preferences array.
         Output: user_preferences [{ id, selected_value }, ...]

Step 6   serv_query PGC_StepType (status = 'live')
         → step_type_contracts

Step 7   LEFT BRAIN: llm_call analyze_and_design_workflow (Sonnet)
         Input:  { userInput, domain, domain_schema, right_brain_research,
                   user_preferences, step_type_contracts }
         Output: design_spec
         {
           process_design:   [plain-language step descriptions],
           state_map:        { key: { type, written_by, read_by } },
           dialog_designs:   [{ step_label, gate_type, message_template, options }],
           prompts_needed:   [{ intent_category, exists, prompt_text?, model? }],
           schema_changes:   [{ table, blocking, recommendation, domain_suggestion? }],
           deferred:         [{ what, why, how_to_add }],
           confidence:       "complete" | "needs_user_input" | "needs_schema" | "blocked",
           blocked_reason?:  string
         }

PHASE 2 — GAP RESOLUTION
Step 8   js_transform — evaluate routing flags from design_spec
         Output: routing_flags { skip_all_gates, needs_schema, is_blocked, has_nonblocking }

Step 9   condition — is_blocked?
         on_truthy: step:9a (hard stop — missing step type capability)
         on_falsy: next

Step 9a  notify — "Cannot build this workflow: {{design_spec.blocked_reason}}"
         → end  (Type 4b hard stop)

Step 10  condition — needs_schema?
         on_truthy: step:10a (schema gap gate)
         on_falsy: next

Step 10a js_transform — build schema gap message from design_spec.schema_changes
Step 10b human_gate confirm — show gap + domain suggestion + options:
         [Create table first → cancel with suggestion]
         [Build without it   → next]
         [Cancel             → cancel]

Step 11a js_transform — filter prompts_needed to exists=false entries
Step 11b condition — any missing prompts?
         on_truthy: step:11c
         on_falsy: step:12
Step 11c iterator — seed each missing prompt to PGC_Prompt (Type 4a resolution)

PHASE 3 — STEP GENERATION
Step 12  llm_call generate_workflow_steps v2 (Sonnet)
         Input:  { design_spec, user_preferences, domain_schema,
                   step_type_contracts [from PGC_SystemContext injection],
                   example [from PGC_SystemContext injection] }
         Output: draft_workflow { name, description, intent_keywords, steps }
         The LLM translates the complete design_spec into steps.
         It does not make design decisions — all decisions were made in Phase 1.

PHASE 4 — VALIDATION
Step 13  human_gate review_object — user reviews draft steps
         context_key: draft_workflow.steps
         Options: [Looks good → next] [Request changes → step:12] [Cancel → cancel]

Step 14  simulate Level 1 — static analysis
         on_failure: step:13  (route back with failures shown in gate context)

Step 15  llm_call generate_workflow_mocks — produce representative mock outputs
Step 16  llm_call generate_workflow_paths — produce named simulation paths
Step 17  simulate Level 2 + Level 3 — full path execution with mocks
         on_failure: step:13

PHASE 5 — REGISTRATION
Step 18  human_gate confirm — show simulation results, ask to register
Step 19  serv_insert PGC_Workflow
Step 20  serv_insert PGC_IntentMap
         row: { pattern: draft_workflow.name, intent_category: draft_workflow.name,
                action_type: workflow }
         NOTE: no workflow_id column — PGC_IntentMap and PGC_Workflow are structurally
         independent. Routing uses action_type + intent_category name lookup only.
Step 21  notify — "Workflow {{draft_workflow.name}} registered.
                   {{design_spec.deferred.length}} enhancements deferred."
Step 22  end
```

---

#### Gap taxonomy applied — per gap type

| Gap type | Who owns it | When resolved | How resolved in v3 |
|---|---|---|---|
| Type 1 — Preference | User | After right brain, before left brain | Tier 1 preference gate iterator (steps 3–5) |
| Type 2 — Knowledge | Right brain | Before left brain | `research_workflow_domain` sonar call (step 2) |
| Type 3a — Schema non-blocking | User | After left brain | Schema gap gate (steps 10–10b), user chooses to proceed |
| Type 3b — Schema blocking | User | After left brain | Schema gap gate cancels cleanly with domain creation suggestion |
| Type 4a — Missing prompt | Left brain | After left brain, before step generation | Inline prompt authoring in `design_spec.prompts_needed`, auto-seeded (steps 11a–11c) |
| Type 4b — Missing step type | Developer (hard stop) | After left brain | `confidence: "blocked"` → notify user → end (steps 9–9a) |
| Type 5 — Ambiguity | User | Pre-step (not yet implemented) | Future: clarification gate before step 1 when intent is underspecified |

---

#### Preference gate iterator contract

Tier 1 preference gates use the `human_gate choice` type with an iterator
driving sequential gates — one gate per `preference_questions` entry from
`right_brain_research`. The user cannot get more than one gate at a time. The
iterator collects all selections into `user_preferences` as an array of
`{ id, selected_value }` objects before the left brain runs.

Each gate shows: the question as a typography heading; a description list showing
`*A* — label: description` for each option; and lettered action buttons (`A`, `B`, `C`, `Cancel`).
This mirrors HTML radio button semantics — the button submits the `value` field,
not the display label. The selected `value` is written to `user_preferences` via `output_key`.

The right brain is instructed to surface preference questions **only when the answer
materially changes the step structure** of the generated workflow. If best practice
clearly recommends one approach, the right brain resolves it in `findings` and does
not surface a preference question. The number of preference gates in practice should
be 0–3 for most workflows.

---

#### design_spec as the interface between cognition and code generation

`design_spec` is the contract between the left brain and the step generator. It is
a plain-language, gap-free description of every step in the workflow — what it does,
what data it reads, what data it writes, what the user sees, and how routing works.
The step generator receives this specification and produces the step array.

The step generator (`generate_workflow_steps` v2) is a code-generation prompt, not
a design prompt. It does not need to understand the domain, research best practices,
or make tradeoff decisions. It only needs to translate a complete specification into
valid step definitions — a well-scoped task that produces consistent results.

This is the fundamental difference from v1/v2 where `generate_workflow_steps`
received a raw intent string and was expected to be simultaneously an architect,
a researcher, a UX designer, and a coder.

---

#### Prompt dependencies (v3)

| Step | Prompt `intent_category` | Model | Output stored at |
|---|---|---|---|
| 2 | `research_workflow_domain` v1 | `perplexity/sonar` | `right_brain_research` |
| 7 | `analyze_and_design_workflow` v1 | `anthropic/claude-sonnet-4-5` | `design_spec` |
| 12 | `generate_workflow_steps` v2 | `anthropic/claude-sonnet-4-5` | `draft_workflow` |
| 15 | `generate_workflow_mocks` v1 | `anthropic/claude-sonnet-4-5` | `mock_outputs` |
| 16 | `generate_workflow_paths` v1 | `anthropic/claude-sonnet-4-5` | `simulation_paths` |

PGC_SystemContext rows injected into steps 7 and 12 via `executeLlmCall`:
- `step_type_contracts` — full live step type catalogue (`inject_for: ["generate_workflow_steps", "analyze_and_design_workflow"]`)
- `routing_value_rules` — valid routing tokens and Guard 3 rule
- `create_domain_example` v4 — annotated create_domain + flat loop quiz example

---

#### Gate-bounded correction loops

Steps 13–14 and 13–17 form gate-bounded correction loops. The backward jump from
step 14 (or step 17) to step 13 is safe because every path from step 13 back to
step 14 or step 17 passes through the step 13 `human_gate`. This satisfies Guard 3's
cycle-safety rule.

The user is the circuit breaker for these loops. If simulation repeatedly fails and
the user cannot resolve the issues, they cancel at step 13. There is no automated
retry limit on human-gate-bounded loops.

---

#### Implementation notes

- `input.domain` comes from `resolveTier3Route()` in `classify-intent.mjs` via the
  heavy-lift SQS dispatch. Currently only `userInput` is passed — `domain` extraction
  from the userInput string is done inside `analyze_and_design_workflow` prompt.
- `execute_top` root frame initialises `current_step: '1'` — step numbering in v3
  starts at `'1'` (serv_query) not at a prior classification step.
- The `example` field in step 12's input is populated from `PGC_SystemContext`
  injection, not from `local_state`. The step definition passes `"example":
  "injected_from_pgc_system_context"` as a placeholder; `executeLlmCall` replaces
  it with the live `create_domain_example` content before the LLM call.

---


---

### 6.10 Session Architecture — Conversational Memory (Backlog)

The session layer gives the brain persistent memory across multiple `/mind`
messages in the same Slack thread. Without it, each `/mind` call is cold — the
Intent Preprocessor has no knowledge of what the user was just doing. With it,
the brain can resolve ambiguous short-form inputs, pre-seed workflow state with
entities the user was already working on, and accumulate a factual record of what
happened in each thread — feeding the right-brain improvement loop.

The session layer is Backlog. The Intent Preprocessor works without it. When it
lands, it does not change any workflow definitions or Step Processor contracts.
It is purely additive.

#### Session identity — UI-agnostic by design

A session is identified by a UUID (`session_id`) generated by `mind.mjs`, not by
`thread_ts`. `thread_ts` is stored inside `PGC_Session.callback.threadId` — the
same pattern as every other UI-specific routing field in the system.

**Session lookup flow in `mind.mjs`:**
```
thread_ts present (reply in existing thread)
  → getRows PGC_Session where callback->>'threadId' = thread_ts
      found     → retrieve session_id, include in CLASSIFY_INTENT message
      not found → generate UUID, PROC creates PGC_Session row on receipt

thread_ts absent (fresh /mind or HTTP test)
  → session_id omitted → PROC treats as sessionless
```

#### Session context injection into the Intent Preprocessor

When `classify-intent.mjs` receives a `session_id`, it reads the last 20
`PGC_SessionEntry` rows for that session (most recent first) and uses them in
two ways:

**Pass 2 domain fallback (Backlog):** If Pass 2 finds no alias token in the input text,
the preprocessor scans the session context for the most recently active domain.
"Add carbonara" resolves to `recipes` because the session shows the user was just
there. Zero LLM cost. Produces `confidence: 'session_context'`.

**Tier 2 prompt injection:** The context block is prepended to the sonar
classification prompt. "Make that a three-course meal plan" becomes classifiable
as `meal_planner` because sonar sees the user has been working with recipes.

#### Full example — recipes exploration → add → meal plan

```
Turn 1  /mind show me my pasta recipes
  Pass 2: alias 'pasta' → domain 'recipes'
  Pass 2 keyword scan: 'show' in list_recipes.intent_keywords → list_recipes workflow

Turn 2  /mind add carbonara with ingredients [...]   (same thread)
  Pass 2: no alias token → fallback to session context → domain 'recipes'
  Pass 2 keyword scan: 'add' in add_recipes.intent_keywords → add_recipes workflow

Turn 3  /mind make that a three-course meal plan using those recipes
  Pass 1: no match. Pass 2: no alias, no session domain resolved.
  Tier 2: sonar receives input + session context
  → workflow_name = 'meal_planner', referenced_entities = [Carbonara, ...]
  → execute_top, local_state.context pre-seeded with referenced_entities
```


### 6.11 Gap Taxonomy — Reusable Design Pattern

When a workflow is generated by the brain (via `create_workflow`) or built by a
developer, it may require information or capabilities that are not immediately
available. These deficiencies are **design gaps**. The gap taxonomy classifies every
type of gap by its nature, its owner, and its correct resolution path.

Applying the taxonomy is mandatory for any `create_*` workflow. It explains which
decisions belong to the user, which belong to the right brain, which belong to the
left brain, and which are hard blockers requiring system capability changes. Resolving
gaps through the wrong path — for example, asking the user a question the right brain
could answer, or asking the right brain a question only the user can answer — produces
either unnecessary user friction or incorrect defaults.

---

#### The five gap types

**Type 1 — Preference gap**

A design choice where multiple valid implementations exist and the correct choice
depends on what the user personally wants. The system cannot resolve these
analytically because there is no objectively better answer — only the user's answer.

Examples: LLM-graded quiz answers vs self-report; one pass through flashcards vs
repeat until a score threshold; track transaction history vs current holdings only;
multi-currency portfolio vs single-currency.

Owner: **User**. Presented as structured gate options — never as free text. The
user picks from options derived from right brain research, not from a blank field.

Timing: **After right brain, before left brain.** The left brain designs the
implementation of known preferences, not the preferences themselves. If preference
gates run after the left brain, the design must be partially redone.

Surface condition: Surface to the user only when the answer produces a structurally
different step array. If best practice clearly favours one option, the right brain
resolves it in `findings` and it never becomes a user question.

---

**Type 2 — Knowledge gap**

A question about the subject matter domain that the left brain cannot answer from
schema inspection or step type contracts. The gap is in the system's knowledge about
the world, not about the user's data.

Examples: What scoring rubric should `evaluate_translation` use for near-miss answers?
What session length is optimal for vocabulary retention? What normalisation conventions
apply to stock portfolio data? What is the canonical pattern for a recipe with
ingredients?

Owner: **Right brain**. Resolved by `research_workflow_domain` (Perplexity sonar)
before the left brain runs. Never surfaced to the user directly. If the right brain
cannot resolve a knowledge gap — "no clear best practice found" — the left brain uses
a reasonable default and notes it in `design_spec.deferred`. The workflow may be
suboptimal but it will function.

Timing: **First** — before any other cognitive work begins. The right brain researches
from the raw user input and domain name. It does not need the left brain's analysis
to know what to research.

Surface condition: Never surface to user. Always resolve internally. The right brain
should bring its full domain knowledge regardless of what the left brain later identifies.

---

**Type 3 — Schema gap**

The workflow would benefit from, or requires, a table or column that does not exist
in the current domain schema. Detected by the left brain during schema inspection.

Two subtypes with different resolution paths:

**Type 3a — Non-blocking:** The workflow can function without the missing structure,
at reduced capability. The user is informed what they gain and lose.

Examples: No `PGD_QuizResults` table — quiz runs fine, no history stored; no
`difficulty` column — no difficulty-weighted card selection.

Owner: **User**. Presented via schema gap gate after left brain inspection. Options:
create the missing table first (cancel workflow, run `create_domain`, return) or
build the simpler version now. The gate message includes a concrete domain creation
suggestion from `design_spec.schema_changes[].domain_suggestion`.

**Type 3b — Blocking:** The workflow cannot function at all without the missing
structure. There is no graceful degradation.

Examples: No `PGD_Flashcards` table in a flashcard quiz workflow; no `term` or
`definition` column on the cards table.

Owner: Hard stop. `design_spec.confidence = "needs_schema"`. Schema gap gate always
appears. There is no "build without it" option for blocking gaps.

Timing: **After left brain schema inspection.** Never ask about tables before knowing
whether they exist. Asking speculatively about tables that might exist is confusing.

---

**Type 4 — Capability gap**

The workflow requires something the system cannot currently provide.

**Type 4a — Missing prompt:** A required LLM prompt does not exist in `PGC_Prompt`.
Detected by the left brain as part of `design_spec.prompts_needed[]`.

Owner: **Left brain**. Resolved automatically — the left brain writes the full
`prompt_text` in `prompts_needed` with `exists: false`. A seed iterator inserts it
into `PGC_Prompt` before step generation runs. Never blocking. Never surfaced to user.

**Type 4b — Missing step type:** The workflow requires a capability with no `live`
entry in `PGC_StepType`. For example, `capability_call` for external API access, or
`sub_workflow` for nested execution.

Owner: **Developer** (system architect). Hard stop — `design_spec.confidence = "blocked"`.
The workflow cannot be generated. A `notify` step informs the user what capability is
missing and that it is noted for future implementation. No user decision is possible;
this is a system limitation.

Timing: Detected by left brain during step type mapping. Hard stop before any gate
is presented to the user.

---

**Type 5 — Ambiguity gap**

The user's intent is underspecified in a way that affects workflow or schema structure,
and the ambiguity cannot be resolved from context, research, or schema inspection.

Examples: "Create a quiz workflow" with no domain specified; "track my progress"
with no indication of what metric; "send me a weekly summary" with no indication
of what to summarise.

Owner: **User**. Resolved by a clarification gate before any other processing. The
gate asks a targeted question — not an open field — to collect the minimum information
needed to proceed.

Timing: **Before the right brain runs.** The right brain's research query may be
incorrect if the intent is ambiguous. The condition check runs on `input.userInput`
specificity before step 1. For most intents this condition passes immediately with no
gate shown.

---

#### Gap resolution sequence

Gaps must be resolved in this order. Resolving in the wrong order produces either
wasted LLM calls (running the right brain before ambiguity is resolved) or incorrect
designs (running the left brain before preferences are confirmed).

```
Type 5 — Ambiguity      Pre-step clarification gate (if needed)
                                │
Type 2 — Knowledge      Right brain research
                                │
Type 1 — Preference     User preference gates (derived from research)
                                │
Left brain analysis (schema inspection, state mapping, dialog design)
                                │
Type 4a — Missing prompt    Auto-seeded inline
Type 3a — Schema non-blocking   User decision gate
Type 3b — Schema blocking       Hard stop with suggestion
Type 4b — Missing step type     Hard stop with explanation
                                │
Step generation (implements the complete, gap-free design_spec)
```

---

#### Gap type ownership summary

| Type | Name | Owner | Surface to user? | Blocking? | When resolved |
|---|---|---|---|---|---|
| 1 | Preference | User | Yes — structured options | Structural (not fatal) | After right brain |
| 2 | Knowledge | Right brain | Never | Never | First — before everything |
| 3a | Schema non-blocking | User | Yes — schema gap gate | No | After left brain |
| 3b | Schema blocking | User | Yes — hard stop | Yes | After left brain |
| 4a | Missing prompt | Left brain | Never | Never | After left brain, auto-seeded |
| 4b | Missing step type | Developer | Yes — informational stop | Yes | After left brain |
| 5 | Ambiguity | User | Yes — clarification gate | Yes | Before right brain |

---

#### Design rules derived from the taxonomy

**Never surface to the user what the system can resolve internally.** Type 2 gaps
are knowledge gaps the right brain owns. Type 4a gaps are prompt gaps the left brain
owns. Showing these to the user adds friction with no benefit.

**Surface Type 1 questions before the left brain designs.** If the left brain runs
before preferences are confirmed, it must guess — reproducing the problem that the
taxonomy is designed to eliminate.

**Type 3a gives the user a genuine choice; Type 3b does not.** A non-blocking schema
gap is a real tradeoff the user decides. A blocking schema gap is not a tradeoff —
it is a prerequisite. Present it as "you must create this first" not as a question.

**Type 4b is informational, not correctable by the user.** The user is told what
capability is missing. Do not ask them whether to proceed — they cannot. Route
directly to `end` after the notify.

**Type 5 clarification gates must be narrow.** Ask the minimum question needed to
make the intent specific enough to research. Not "what exactly do you want?" but
"which domain should this workflow operate on?" or "what data should the summary
include?".

---

#### Applying the taxonomy to new create_* workflows

Any future `create_*` workflow — `create_report`, `create_alert`,
`create_schedule`, `create_integration` — starts by classifying its gaps against
this taxonomy. The questions to answer before writing a step definition:

1. Is the intent specific enough to proceed? (Type 5)
2. What does the world know about doing this well? (Type 2)
3. What structural choices require user input? (Type 1)
4. What tables or columns are needed — do they exist? (Type 3)
5. What prompts are needed — do they exist? (Type 4a)
6. What step types are needed — do they exist? (Type 4b)

The answers determine the pre-generation pipeline. For simple workflows (well-known
domain, no schema gaps, obvious implementation), the right brain may find no
preference questions, the left brain may find no gaps, and step generation runs with
a single pass — fast and cheap. For complex workflows, the full pipeline runs and the
user is only interrupted where their specific input is genuinely required.

---

### 6.12 Right-Brain Self-Repair — troubleshoot-workflow and fix-workflow

This section documents the right-brain self-repair loop: the system's ability to
detect structural errors in registered workflows and correct them autonomously,
with a human confirmation gate before any change is committed.

---

#### Three tiers of right-brain activity

**Tier 1 — Reactive repair** (implemented — Session 22)
Triggered by a workflow execution failure. `TROUBLESHOOT_WORKFLOW` fire-and-forget SQS
message loads the failing workflow from `PGC_Workflow`, runs Level 1 static analysis,
and if issues are found enqueues `FIX_WORKFLOW`. The fix LLM call produces corrected
steps, validates them, presents a human confirmation gate ("here's what I'm about to
change — confirm?"), and on confirmation writes the fix to `PGC_Workflow`, cancels
active broken runs, and posts a "fixed — try again" reply to Slack.

Both are PROC modules (`troubleshoot-workflow.mjs`, `fix-workflow.mjs`) — no
`PGC_WorkflowRun` lifecycle. There is one human gate in `fix-workflow` for the
confirmation step. This is intentional: the LLM produces a diagnosis and a proposed
change set, but a human approves the write before it goes to the database.

**Tier 2 — Proactive self-improvement** (medium-term)
After every successful `fix-workflow` repair, the module updates `PGC_SystemContext`
rows that are injected into the prompts that generated the broken steps. For example,
a condition routing violation fix updates the `workflow_constraints` or
`routing_value_rules` context row so that future calls to `generate_workflow_steps`
receive corrected contracts and do not repeat the same mistake.

`fix-workflow` does not modify `PGC_Prompt.prompt_text` directly. However, the
`fix_workflow_steps` LLM prompt is not prohibited from recommending a prompt text
change in its output. If the LLM returns a `prompt_text_change` recommendation,
the fix-workflow module logs it to `PGC_Prompt.error_log` for human review rather
than applying it automatically. If this path is reached frequently for the same
prompt, it signals that the prompt itself needs redesign — a Tier 3 concern.

**Tier 3 — Scheduled maintenance loop** (Backlog)
Triggered on a schedule or after every N workflow runs (configurable in
`PGC_SystemContext`). Reads `PGC_WorkflowStats` for soft failure patterns — high
human gate cancellation rates, high LLM correction attempt rates on specific prompts,
workflows that are never invoked after registration. This tier addresses usability
failures and prompt drift, not structural errors. The output is improvement
recommendations written to a `PGC_ImprovementQueue` table (Backlog) for human review
or automated application subject to confidence threshold.

---

#### Why troubleshoot and fix are PROC modules, not PGC_Workflow workflows

`create_domain` and `create_workflow` are workflows because they have multiple
human-in-the-loop gate steps where the user reviews LLM output and makes structural
decisions. The execution stack suspends between gates — the user is part of the
execution path.

`troubleshoot-workflow` has no human gates — it is pure diagnosis: load steps, run
Level 1, format report, post to Slack. One SQS message in, one `WORKFLOW_NOTIFY` out.

`fix-workflow` has exactly one human gate — the confirmation step before committing
the corrected steps. This gate is structurally simpler than the `create_*` gates:
it shows the `changesApplied` diff and asks confirm/cancel. No LLM output review
loop, no iterator, no schema design. Implementing this as a workflow would add
`PGC_WorkflowRun` overhead (DB row, stack frames, idempotency guard, execute_top
hops) to what is effectively a two-step operation: LLM call → human confirm → DB
write. The PROC module pattern with a single `enqueueWorkflow` for the gate is
the correct fit.

If `fix-workflow` eventually requires multiple gate steps (e.g. separate confirmation
for steps changes vs. context changes vs. prompt changes), that is the signal to
promote it to a workflow. The current single-gate design does not meet that bar.

---

#### PROC module contracts

**`troubleshoot-workflow.mjs`**

```
SQS type:   TROUBLESHOOT_WORKFLOW
HTTP route: POST /api/v1/proc/troubleshoot-workflow

Input:
  workflowName  string     — load steps from PGC_Workflow (required unless steps supplied)
  steps         array?     — raw step array; overrides DB lookup when present
  autoFix       boolean?   — when true and issues found, enqueue FIX_WORKFLOW (SQS only)
  callback      Callback

Behaviour:
  1. Load steps from PGC_Workflow by name, or use supplied steps array
  2. Run Level 1 static analysis (executeSimulate Level 1 in step-executor.mjs)
  3. Format TroubleshootWorkflowResponse with summary string
  4. If autoFix=true and issues found: enqueue TROUBLESHOOT_WORKFLOW → FIX_WORKFLOW
  5. enqueueCallback WORKFLOW_NOTIFY with summary

HTTP: return TroubleshootWorkflowResponse directly
SQS: post to Slack thread via callback
```

**`fix-workflow.mjs`**

```
SQS type:   FIX_WORKFLOW
HTTP route: POST /api/v1/proc/fix-workflow

Input (primary path — from TROUBLESHOOT_WORKFLOW output):
  troubleshootResult  TroubleshootWorkflowResponse  — full output of troubleshoot call
  stackTrace          string?                       — CloudWatch error string for LLM context
  callback            Callback

Input (direct path — no prior troubleshoot call):
  workflowName   string
  issues         StaticAnalysisIssue[]
  brokenSteps    array?   — if omitted, loaded from PGC_Workflow by name
  stackTrace     string?
  callback       Callback

Behaviour:
  1. Resolve workflowName, brokenSteps, issues from troubleshootResult or direct fields
  2. Call LLM fix_workflow_steps prompt:
       Input: workflowName, brokenSteps, issues, step_type_contracts (PGC_SystemContext),
              routing_value_rules (PGC_SystemContext), stackTrace (if present)
       Output: { diagnosis, changesApplied, correctedSteps, context_updates?, prompt_text_change? }
  3. Run Level 1 static analysis on correctedSteps
  4. If validation fails: log to PGC_Prompt.error_log, enqueueCallback with failure report, return
  5. Human confirmation gate:
       Show changesApplied diff + diagnosis
       Options: [Apply fix → confirm] [Cancel → cancel]
  6. On confirm:
       a. updateRows PGC_Workflow: steps=correctedSteps, version=version+1
       b. If context_updates present: updateRows PGC_SystemContext for each key
       c. If prompt_text_change present: log to PGC_Prompt.error_log (do NOT apply)
       d. Cancel all active/failed WorkflowRun rows for this workflowName
       e. For each cancelled run: enqueueCallback WORKFLOW_NOTIFY "Workflow repaired — try again"
       f. enqueueCallback WORKFLOW_NOTIFY with FixWorkflowResponse summary

HTTP: return FixWorkflowResponse directly (skips human gate — for developer testing)
SQS: post confirmation gate via callback, await resume_gate
```

---

#### fix_workflow_steps prompt — contract

| Field | Notes |
|---|---|
| Input: `workflow_name` | For context only — not in the output |
| Input: `broken_steps` | Full current step array |
| Input: `issues` | `StaticAnalysisIssue[]` array from Level 1 |
| Input: `step_type_contracts` | Injected from `PGC_SystemContext` |
| Input: `routing_value_rules` | Injected from `PGC_SystemContext` |
| Input: `stack_trace` | Optional runtime error string |
| Output: `diagnosis` | Plain-language explanation of root cause |
| Output: `changes_applied` | `[{ step, field, before, after, reason }]` |
| Output: `corrected_steps` | Complete fixed step array — not a diff |
| Output: `context_updates` | Optional `[{ key, updated_content }]` for `PGC_SystemContext` rows |
| Output: `prompt_text_change` | Optional `{ intent_category, recommendation }` — logged only, never applied |

The prompt instructs the LLM that `prompt_text` changes are out of scope for
automatic application. If the LLM believes a prompt change is the correct fix, it
should describe the recommendation in `prompt_text_change` and explain why it could
not fix the issue through step corrections or context updates alone. This is a
signal for human review, not an automated write.

---

#### SQS message types added

| Type | Category | Sent by | Handled by |
|---|---|---|---|
| `TROUBLESHOOT_WORKFLOW` | 1 — fire-and-forget | Guard 1 / developer curl / autoFix chain | `troubleshoot-workflow.mjs` |
| `FIX_WORKFLOW` | 1 — fire-and-forget (becomes Category 2 if human gate present) | `troubleshoot-workflow.mjs` (autoFix) / developer curl | `fix-workflow.mjs` |

`FIX_WORKFLOW` is unusual: it begins as a fire-and-forget (no `workflowRunId`) but
if the human confirmation gate is reached, `fix-workflow.mjs` inserts a
`PGC_WorkflowRun` row and transitions to a Category 2 `WORKFLOW_STEP execute_top`
message to drive the gate. This is the same pattern as any other fire-and-forget
that spawns a workflow run (e.g. `CLASSIFY_INTENT` → `WORKFLOW_STEP`).

---

#### Connection to circuit breakers (Section 6.7)

When Guard 1 (stuck-step detector) marks a run `failed`, `run-workflow.mjs` enqueues
`TROUBLESHOOT_WORKFLOW` for the failing workflow name before posting `WORKFLOW_ERROR`
to Slack. The same applies to other guards when they land: velocity detector,
execution accumulator. This wires the safety layer to the repair layer so that every
detected structural failure initiates a self-diagnosis attempt automatically.

Untrapped failures (Lambda timeouts, silent hangs, DLQ-delivered messages) are not
self-healing at runtime. Developer uses `troubleshoot-workflow` curl path for
manual diagnosis. CloudWatch alarms + SQS DLQ notification are the discovery
mechanism for these cases.

---



---

### 6.14 Prompt Performance Monitoring (Backlog)

#### Prompt Issues Log

A separate document `docs/prompt-issues.md` tracks observed LLM prompt quality problems
across sessions. Each issue records the failure pattern, root cause, actions taken, and
monitor thresholds. This doc feeds the Prompt Performance Monitor (Backlog item 8).

**Active issues as of Session 23:**

| Issue | Prompt | Pattern | Status |
|---|---|---|---|
| 1 | `research_workflow_domain` | Oversized output, occasional validation failures on sonar web search interruption | Mitigated — scope constraints + max_output_tokens added |
| 2 | `analyze_and_design_workflow` | Persistent schema mismatch — LLM produces wrong field names on every attempt | Active — prompt rewritten with explicit DO NOT use field list and concrete examples |
| 3 | `fix_workflow_steps` | Produces full 27-step array when only 4 steps needed | Mitigated — step 3 filter + step 4b merge added to fix_workflow |
| 4 | `research_workflow_domain` | Occasional invalid JSON from sonar web-search mid-response interruption | Open — investigate disabling web search via `tools: []` |

#### LLM API capabilities in use

All LLM calls route through the Perplexity Agent API (`/v1/agent`).

| Capability | Status | Notes |
|---|---|---|
| `response_format: { type: "json_schema" }` | ✅ Live (Session 23) | Enforces output schema at model level. Applied when `PGC_Prompt.output_schema` is present. `strict: false` — schema `additionalProperties: false` handles strictness at Ajv validation time |
| `max_output_tokens` | ✅ Live (Session 23) | Per-prompt ceiling from `PGC_Prompt.max_output_tokens`. Forwarded through `callLlm` and `callLlmWithCorrection` |
| `reasoning` (`effort: low|medium|high`) | ⬜ Backlog | For complex analytical prompts like `analyze_and_design_workflow`. Not yet configured per-prompt |

[DECISION] **`response_format` reduces field-name hallucination.** Before Session 23,
`analyze_and_design_workflow` consistently produced wrong field names (`step_id`,
`reads_from_state`, etc.) because the model had no structural constraint at generation
time. Adding `response_format: json_schema` enforces the schema at the model level,
eliminating the class of errors where the model invents its own output shape.

[DECISION] **Correction loop is not the primary validation path.** The two-attempt
correction loop in `review-output.mjs` exists as a fallback for transient issues.
When errors are systematic (same wrong field names on every attempt, correction errors
increase not decrease), the correct fix is the prompt + `response_format`, not more
correction attempts.

## 7. Tech Debt Register

| Item | Priority | Notes |
|---|---|---|
| Workflow safety guards (velocity detector, execution accumulator, cycle detector) | High | Required before Step Processor is production-ready — see Section 6.10. Right-brain can monitor `PGC_WorkflowStats` for anomalous run patterns and flag suspect workflows proactively |
| Semantic validation rules for create_domain scaffold | ~~High~~ | ✅ Implemented in `src/proc/review-output.mjs` — all three rules enforced in `runSemanticRules()` |
| `resume_gate` routes to HELP workflow only | ~~High~~ | ✅ Resolved — Step Processor dispatches generically via `run-workflow.mjs dispatchSqs()`. No per-workflow routing in handler |
| `create-domain.mjs` ignores scaffold from design-domain and calls LLM again | ~~High~~ | ✅ Resolved — Step Processor drives `create_domain` declaratively from `PGC_Workflow.steps` |
| Gate re-renders post new Slack messages instead of `chat.update` in-place | ~~Medium~~ | ✅ Resolved — `message_ts` threaded through SQS → `run-workflow.mjs` → `WORKFLOW_GATE` → `callback.mjs` `chat.update` |
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
| `v3.2-intent-preprocessor-complete` | Intent Preprocessor fully operational end-to-end. mind.mjs + classify-intent.mjs + classify-intent-tiers.mjs. Three-tier pipeline verified: Pass 1a (exact), Pass 1b+1c (alias+CRUD with PGC_Schema fallback), Tier 2 (sonar via LLM_CHAT_URL, prompt from PGC_Prompt). Tier 3 routes to CREATE_DOMAIN / CREATE_WORKFLOW / WORKFLOW_NOTIFY. /mind and /m verified in Slack. openapi.yaml v3.3.5. seed_PGC_Prompt.json: classify_intent_tier2 row added. callback.mjs: runId suppressed when absent. Architecture session 7: WorkflowQueue two-category framing, PGC_Session + PGC_SessionEntry design, intent tuning surface, session architecture Section 6.13 |
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
| | — Tier 3: enqueue CREATE_DOMAIN / CREATE_WORKFLOW, WORKFLOW_NOTIFY for unknowns | ✅ |
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

**Step types — implemented vs deferred:**

| Type | Status | Notes |
|---|---|---|
| `llm_call` | ✅ live | Loads prompt from `PGC_Prompt`, calls LLM, runs `review-output` validation |
| `js_transform` | ✅ live (built-ins + generic expression sandbox) | Built-ins: `columnSummary`, `buildHelpOptions`, `resolveHelpContent`, `formatRecordList`, `buildChildInserts`. Generic `expression` sandbox via acorn AST gate + `vm.runInNewContext`. See Section 6.5.1 |
| `human_gate` | ✅ live | `confirm` + `edit_list` proven end-to-end |
| `serv_schema` | ✅ live | `createTable` via SERV |
| `serv_insert` | ✅ live | `insertRow` via SERV |
| `notify` | ✅ live | Resolves `message_template`, enqueues `WORKFLOW_NOTIFY` |
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

Embedding model: `text-embedding-3-small` (OpenAI), 1536 dimensions
Used in: `PGC_Workflow`, `PGC_DomainHelp`, `PGC_Prompt`, `PGC_IntentMap`

**Backlog — no MVP feature is blocked by its absence.**

### Role in the Intent Preprocessor

pgvector is the Backlog evolution of Pass 2's token-based `intent_keywords` scan (Section 6.3).

**Phase 2 (current):** Pass 2 resolves a domain via `PGC_DomainHelp.aliases`, then scans
`PGC_Workflow.intent_keywords` for token presence. This handles common phrasings at zero
LLM cost. Tier 2 (sonar) covers novel phrasings that miss the keyword scan.

**Backlog (pgvector):** After a keyword-scan miss but before Tier 2, Pass 2 embeds the
user input and runs a cosine similarity query against `PGC_Workflow.intent_embedding` filtered
by the resolved domain. If similarity exceeds a configurable threshold (e.g. 0.82), the
workflow is matched with `confidence: 'semantic_match'` — no LLM invocation. This eliminates
almost all Tier 2 sonar calls for domain workflows.

The `intent_embedding` column already exists on `PGC_Workflow` (no schema change needed).
Embeddings are generated and stored when a domain is created or a workflow is updated.

### Primary use cases

- **Intent preprocessor** — semantic similarity match in Pass 2, superseding `intent_keywords` scan for novel phrasings
- **`/help` search** — find domain by natural language description via `PGC_DomainHelp` embeddings
- **Prompt deduplication** — avoid generating duplicate prompts via `PGC_Prompt` embeddings

### Activation checklist (Backlog)

1. Run `CREATE EXTENSION IF NOT EXISTS vector;` on RDS
2. Add `vector` to `ALLOWED_TYPES` in `schema.mjs`
3. Add embedding generation step to `create_domain` workflow — populate `PGC_Workflow.intent_embedding` for each CRUD workflow generated
4. Add `pgvector_match()` function to `classify-intent-tiers.mjs` — called by Pass 2 after keyword-scan miss
5. Set similarity threshold in `PGC_SystemContext.guardrail_defaults`
6. Embed existing `PGC_DomainHelp.description` rows for `/help` semantic search

### Why not sooner

The system works correctly without pgvector. Pass 1 regex covers all registered intents.
Pass 2 `intent_keywords` scan covers common domain phrasings at zero cost. Tier 2 sonar
handles the residual for a few cents per call. pgvector reduces that residual further but
is not the correct investment before the session layer (Backlog) and right-brain improvement
loop are stable — those produce the training signal that validates whether semantic matching
thresholds are set correctly.

Status: Designed, not yet implemented. `intent_embedding` column schema already in place.

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
| `POST /proc/classify-intent` | ⬜ Phase 2 item 4 — Intent Preprocessor |
| `POST /proc/run-workflow` | ✅ Live — Step Processor |
| `POST /proc/improve-prompt` | ⬜ Backlog — prompt evolution |

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
