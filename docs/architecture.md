# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2  
Status: Active development — Phase 3 next  
Last updated: 2026-03-19 (session 3)

---

## 1. System Purpose

A self-evolving, low-cost cognitive automation brain that:
- Accepts natural language intent from users via Slack (or any UI)
- Uses LLM sparingly — only for novel intents, workflow generation, and schema creation
- Persists generated workflows in PostgreSQL and reuses them — LLM is not called twice for the same problem
- Evolves its own workflows and schemas over time
- Runs at approximately $8–$13/month at household scale — see Section 14 for full cost breakdown

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
│   │   ├── classify-intent.mjs       /proc/classify-intent
│   │   ├── run-workflow.mjs          /proc/run-workflow — Step Processor
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

```
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
```

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
  "gate_type":        "confirm | review_tables | review_fields | merge_tables | add_table | choose | error_recovery",
  "message_template": "Template string with {{variable}} substitution from local_state",
  "context_key":      "local_state key containing data to display",
  "options": [
    { "label": "✅ Confirm",  "action": "confirm",  "on_select": "next"      },
    { "label": "❌ Cancel",   "action": "cancel",   "on_select": "cancel"    },
    { "label": "🔀 Modify",   "action": "branch",   "on_select": "step:3"    }
  ],
  "on_timeout":       "cancel",
  "timeout_seconds":  3600
}
```

When a `human_gate` step is reached:
1. Step Processor pushes a `human_gate` frame onto the stack
2. Sets `PGC_WorkflowRun.status = 'awaiting_human_gate'`
3. Posts interactive Slack message via SQS CallbackResults
4. SQS message processing completes — stack suspended, no timeout on Lambda
5. User responds → Slack sends to `/interactive` endpoint on SlackbotFunction
6. SlackbotFunction enqueues `{ type: 'WORKFLOW_STEP', action: 'resume_gate', response: '...' }`
7. Step Processor resumes — pops gate frame, routes based on user response

### Gate type catalogue

| Gate type | When used | User sees |
|---|---|---|
| `confirm` | Destructive operations, final approval | Single confirmation message + [Confirm] [Cancel] |
| `review_tables` | After LLM proposes domain schema | Table list with relationships + action buttons |
| `review_fields` | Per-table field review | All fields for one table + modify/add/remove controls |
| `merge_tables` | User requests table merge | Picker for two tables + [Merge] [Cancel] |
| `add_table` | User requests new table | Text input for description → LLM designs fields |
| `choose` | Multi-path branching | Labelled options mapping to workflow branches |
| `error_recovery` | Step execution failed | Error details + [Fix schema] [Fix data] [Skip] [Cancel] |
| `execution_limit` | Execution accumulator tripped | Elapsed time + cost + [Continue] [Stop] [Disable timer] |
| `velocity_limit` | Velocity detector tripped | Step count + last step + [Show workflow] [Delete] [Dismiss] |

### Gate instances

**Destructive operation gate**
```
⚠️ You are about to drop table PGD_Recipes and all its data.
This cannot be undone.
[Confirm]  [Cancel]
```
Stack operation on Confirm: pop gate frame, continue.
Stack operation on Cancel: unwind stack to root, set status=cancelled.

**Error recovery gate**
```
⚠️ Step 3 of "deduct_inventory" failed.
Error: Column "quantity" not found in PGD_Inventory.

[A] Fix the schema    [B] Fix the data    [C] Skip step    [D] Cancel
```
Stack operations: A/B → push sub-workflow frame. C → pop failed frame, advance. D → cancel.

**Domain review gates** — see Section 20 for full create-domain workflow.

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

```json
[
  {
    "step": 1,
    "type": "llm_call",
    "description": "LLM designs full domain schema from user description",
    "input": { "prompt": "create_domain", "user_input": "{{input.userInput}}" },
    "output_key": "proposed_scaffold",
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": 2,
    "type": "human_gate",
    "gate_type": "review_tables",
    "description": "User reviews proposed table list and high-level relationships",
    "context_key": "proposed_scaffold",
    "message_template": "🧠 Here's my plan for domain *{{proposed_scaffold.domain}}*:\n\n{{proposed_scaffold.table_summary}}\n\nDoes this look right?",
    "options": [
      { "label": "✅ Review fields",  "action": "confirm",  "on_select": "next"   },
      { "label": "🔀 Merge tables",   "action": "branch",   "on_select": "step:3" },
      { "label": "➕ Add a table",    "action": "branch",   "on_select": "step:4" },
      { "label": "🔄 Start over",     "action": "branch",   "on_select": "step:1" },
      { "label": "❌ Cancel",         "action": "cancel",   "on_select": "cancel" }
    ],
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": 3,
    "type": "human_gate",
    "gate_type": "merge_tables",
    "description": "User selects two tables to merge",
    "context_key": "proposed_scaffold.tables",
    "message_template": "Which two tables would you like to merge?",
    "options": "dynamic",
    "on_success": "step:3b",
    "on_failure": "step:2"
  },
  {
    "step": "3b",
    "type": "llm_call",
    "description": "LLM redesigns the merged table from the two inputs",
    "input": { "prompt": "merge_tables", "tables": "{{gate.selected_tables}}" },
    "output_key": "merged_table",
    "on_success": "step:3c",
    "on_failure": "step:2"
  },
  {
    "step": "3c",
    "type": "js_transform",
    "description": "Replace two source tables with merged table in proposed_scaffold",
    "on_success": "step:2",
    "on_failure": "step:2"
  },
  {
    "step": 4,
    "type": "human_gate",
    "gate_type": "add_table",
    "description": "User describes the new table they want",
    "message_template": "Describe the new table you'd like to add:",
    "options": "text_input",
    "on_success": "step:4b",
    "on_failure": "step:2"
  },
  {
    "step": "4b",
    "type": "llm_call",
    "description": "LLM designs fields for the new table",
    "input": { "prompt": "design_table", "description": "{{gate.text_input}}" },
    "output_key": "new_table",
    "on_success": "step:4c",
    "on_failure": "step:2"
  },
  {
    "step": "4c",
    "type": "human_gate",
    "gate_type": "review_fields",
    "description": "User reviews and modifies fields for the new table",
    "context_key": "new_table",
    "message_template": "Here are the proposed fields for *{{new_table.tableName}}*:",
    "options": "field_editor",
    "on_success": "step:4d",
    "on_failure": "step:2"
  },
  {
    "step": "4d",
    "type": "js_transform",
    "description": "Append confirmed new table to proposed_scaffold.tables",
    "on_success": "step:2",
    "on_failure": "step:2"
  },
  {
    "step": 5,
    "type": "iterator",
    "description": "For each table: review and modify fields",
    "items_key": "proposed_scaffold.tables",
    "item_workflow": "review_table_fields",
    "execution_mode": "sequential",
    "on_complete": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": 6,
    "type": "human_gate",
    "gate_type": "confirm",
    "description": "Final confirmation before DDL execution",
    "context_key": "proposed_scaffold",
    "message_template": "✅ Ready to create domain *{{proposed_scaffold.domain}}* with {{proposed_scaffold.tables.length}} tables. Proceed?",
    "options": [
      { "label": "✅ Create it", "action": "confirm", "on_select": "next"   },
      { "label": "❌ Cancel",    "action": "cancel",  "on_select": "cancel" }
    ],
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": 7,
    "type": "iterator",
    "description": "Create each confirmed PGD table via SERV-Schema",
    "items_key": "proposed_scaffold.tables",
    "item_step": {
      "type": "serv_schema",
      "input": "{{item}}",
      "on_failure": "human_feedback"
    },
    "on_complete": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": 8,
    "type": "serv_insert",
    "description": "Register domain in PGC_DomainHelp",
    "input": { "tableName": "PGC_DomainHelp", "row": "{{proposed_scaffold.domainHelp}}" },
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": 9,
    "type": "notify",
    "description": "Confirm domain creation to user",
    "message_template": "🧠 Domain *{{proposed_scaffold.domain}}* is ready!\n\n{{created_tables_summary}}",
    "on_success": "end"
  },
  {
    "step": 10,
    "type": "end"
  }
]
```

#### `review_table_fields` sub-workflow

Called by the iterator at step 5 — one invocation per table.

```json
[
  {
    "step": 1,
    "type": "human_gate",
    "gate_type": "review_fields",
    "description": "Show all fields for this table — user can modify, add, or remove",
    "context_key": "item",
    "message_template": "📋 *{{item.tableName}}* — review fields:",
    "options": "field_editor",
    "on_success": "end",
    "on_failure": "end"
  }
]
```

The `field_editor` option type renders a Slack Block Kit message with:
- Each field shown as a row: name, type, nullable indicator
- [✏️ Modify] button per field → opens modal with type/nullable/default inputs
- [❌ Remove] button per field (protected: `id`, `created_at`, `updated_at` cannot be removed)
- [➕ Add field] button → opens modal with name/type inputs
- [✅ Done] button → confirms and pops the sub-workflow frame

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

**Gate 1 — Static AST parse (acorn)**

Parse the generated JS using `acorn` before executing it. If the source is syntactically
invalid, it cannot be executed safely. Reject immediately, log, apply correction loop.
This is the security gate referenced in Section 6.5 — already planned for `js_transform`.

**Gate 2 — In-situ sandbox execution**

Run the generated function against a known test input using `vm.runInNewContext()` with a
hard timeout. Compare the output shape against `PGC_StepType.output_schema` for the
step type. If the function throws, times out, or returns the wrong shape — apply the
correction loop.

```js
import vm from 'node:vm';

const sandbox = vm.createContext({ input: testInput });
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

## 7. Tech Debt Register

| Item | Priority | Notes |
|---|---|---|
| Workflow safety guards (velocity detector, execution accumulator, cycle detector) | High | Required before Step Processor is production-ready — see Section 6.9 |
| Semantic validation rules for create_domain scaffold | ~~High~~ | ✅ Implemented in `src/proc/review-output.mjs` — all three rules enforced in `runSemanticRules()` |
| `resume_gate` routes to HELP workflow only | High | `proc/handler.mjs` routes all `resume_gate` messages to `handleHelpResume`. Replace with `PGC_WorkflowRun` lookup when Step Processor is built |
| `createTable` DDL + PGC_Schema insert not in a transaction | Medium | Physical table can exist without registry row on partial failure |
| Orphan table cleanup tooling | Low | Failed partial runs leave orphan tables in PGC_Schema — only manual `deleteTable` today |
| AWS infrastructure cost — Bastion Host public IPv4 | Low | EC2 Bastion accrues ~$2.82/month in public IPv4 charges. Replace with AWS SSM Session Manager when promotional credits near exhaustion. No application code changes needed. |
| W3C `traceparent` format for `traceId` | Low | Adopt `{version}-{traceId}-{parentId}-{flags}` when observability tooling added |
| `updateTable` ALTER TABLE | Medium | Currently metadata only — does not execute ALTER TABLE |
| Unit tests | Medium | Test pure functions first: `buildCreateTableSQL`, `validateCreatePayload`, `parseEvent`. Use `node:test` built-in |
| Integration tests | Low | Defer until PROC/Schema complete — use `testcontainers` + PostgreSQL |
| CI/CD GitHub Actions | Low | Deliberately deferred until `template.yaml` stabilises |
| Dependency injection for DB clients | Medium | Needed for unit testability — clients currently instantiated at module level |
| PROC/SERV API Gateway resource policy | Medium | Restrict to AWS account-scoped requests before any public exposure — see Section 12.3 |
| Refactor `proc/create-domain.mjs` private `servFetch` + `callLlm` | Low | Extract to `src/shared/serv-client.mjs` and `src/shared/llm-client.mjs` — duplicates shared implementations added in v3.2-design-domain-foundation |
| `callback` routing pattern not enforced at compile time | Low | Every PROC endpoint reading callback from SQS must use `req.callback ?? req.body?.callback ?? null`. Currently convention only — caught at runtime. Add a lint rule or helper function when unit tests are added |

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
| 3b | proc/design-domain — Block Kit review message, in-place table remove, human gate pause | ⬜ next |
| 3c | proc/create-domain — wired to WorkflowRun state from design-domain, PGC_EntitySchema registration | ⬜ |
| 4 | PROC — Intent Preprocessor — coded logic + cheap LLM classification | ⬜ |
| 5 | PROC — Step Processor — SQS-driven stack execution, full PGC_WorkflowRun lifecycle | ⬜ |
|   | — include velocity detector, execution accumulator, cycle detector (Section 6.9) | |
|   | — Step Processor MUST check PGC_WorkflowRun.status before executing any step (shutdown contract) | |

### Phase 3 — Deferred

| # | Task |
|---|---|
| 1 | SERV-Query — cross-entity parameterised SELECT with pagination |
| 2 | Parallel execution — fan-out/fan-in, optimistic locking |
| 3 | Unit + integration tests — node:test, testcontainers |
| 4 | CI/CD GitHub Actions — after template.yaml stabilises |

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

## 14. Cost of Ownership

### 14.1 Actual March 2026 Charges (us-east-2, household-scale dev)

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

### 14.2 Cost Breakdown by Component

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

### 14.3 Database Size Scenarios

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

### 14.4 LLM Cost Estimates (Perplexity)

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

### 14.5 Total Cost of Ownership Summary

| Scenario | AWS Infrastructure | LLM | Total/Month |
|---|---|---|---|
| Small (recipes, golf, 2-3 domains) | ~$10 | $0.50 | ~$10–11/month |
| Medium (inventory, budgets, stock portfolio) | ~$10–11 | $0.75 | ~$11–12/month |
| Large (high-frequency time-series, 10+ domains) | ~$11–13 | $1.00 | ~$12–14/month |

Storage cost is nearly flat across all scenarios because structured relational data
is compact. The dominant cost driver at every scale is the always-on RDS instance
and Bastion host — not data volume.

### 14.6 Cost Reduction Opportunities

| Action | Monthly Saving | When to Apply |
|---|---|---|
| Replace Bastion with AWS SSM Session Manager | ~$1.78 + $0.94 IPv4 | When promotional credits near exhaustion |
| Switch RDS to Graviton2 Reserved Instance (1yr) | ~30% on compute (~$1.40) | After system stabilises |
| Stop RDS when not in use (dev only) | Up to $4.71 | Dev/test environments only — not production |
| Use RDS Aurora Serverless v2 | Variable — cheaper at low use | Phase 3 if usage patterns justify it |

**Highest impact action today:** Replacing the Bastion with SSM Session Manager
eliminates the EC2 instance ($1.78) and one public IPv4 address ($0.94) — saving
~$2.72/month with no loss of functionality. Tracked in tech debt register.