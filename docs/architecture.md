# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2  
Status: Active development — create_workflow complete (Phase 2 item 4b); Phase 2 item 4c (`/mind edit aliases`) and Phase 3 features next  
Last updated: 2026-03-28 (session 11)

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
│   │   ├── classify-intent-tiers.mjs Pure functions for Tier 1/2/3 logic — no I/O
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

On every Lambda cold start, `bootstrap()` runs and is idempotent:
1. Install `set_updated_at()` trigger function on PGC
2. `CREATE TABLE IF NOT EXISTS` for all PGC system tables (from imported JSON templates)
3. Seed self-referential rows into `PGC_Schema` (`ON CONFLICT DO NOTHING`)
4. Seed gatekeeper rows into `PGC_TableMap` (`ON CONFLICT DO NOTHING`)
5. Seed `PGC_Prompt` rows for system workflows (`ON CONFLICT DO NOTHING` via `WHERE NOT EXISTS`)
6. Seed `PGC_Workflow` rows for system workflows (`ON CONFLICT DO NOTHING`)
7. Seed `PGC_IntentMap` rows (`ON CONFLICT DO NOTHING`)
8. Set `bootstrapComplete = true` — skipped on warm containers

All seed operations use `ON CONFLICT DO NOTHING` or `WHERE NOT EXISTS` — never `DO UPDATE`.
This ensures concurrent cold-start bootstraps are fully idempotent and cannot race on the same rows.

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
Powers `/help {domain}` responses and Tier 1b alias matching in the Intent Preprocessor.
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
| intent_keywords | jsonb | For coded intent matching — see Tier 1 sub-pass 2b (Section 6.4) |
| intent_embedding | vector | For pgvector similarity matching (Phase 3) |
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

These two tables answer different questions and are consulted in a strict order by the Intent Preprocessor (see Section 6.4 Tier 1).

`PGC_IntentMap` answers: "Is this a known system-level intent?" — create domain, create workflow, help, or any user-defined workflow. Its patterns are written by developers (bootstrap seed) or by the brain itself when a new workflow is stored. It has a direct FK to `PGC_Workflow` so a match immediately tells the preprocessor exactly which workflow to run. Pass 1a in Tier 1 — always runs first.

`PGC_DomainHelp` answers: "Does the user's input mention something in their personal data?" — stocks, recipes, meals, budget. It has no FK to `PGC_Workflow` and no awareness of workflows. It only knows that "stocks", "portfolio", and "holdings" all mean `stock_portfolio`. Pass 1b in Tier 1 — only consulted when no `PGC_IntentMap` pattern matched. Once a domain is resolved from `PGC_DomainHelp`, the preprocessor runs CRUD verb detection (Pass 1c) or passes the resolved domain as a hint to Tier 2.

The handoff is one-way and ordered: `PGC_IntentMap` always runs first. A match short-circuits — `PGC_DomainHelp` is never read.

**Intent Preprocessor tuning surface:**

When classification misbehaves, the fix depends on which pass failed:

| Symptom | Which pass | Fix |
|---|---|---|
| System-level intent misrouted or missed | Pass 1a | Update `PGC_IntentMap.pattern` regex |
| Domain not recognised from user input | Pass 1b | Update `PGC_DomainHelp.aliases` for that domain |
| CRUD verb not detected for a domain | Pass 1c | Coded logic in `classify-intent-tiers.mjs` (future: custom CRUD verbs per domain in PGC_DomainHelp) |
| User-defined workflow not found by natural phrasing | Tier 2 failure | Run `/create-workflow` — define the workflow with explicit `intent_keywords`; Tier 1a will then match reliably at zero LLM cost |
| Aliases outdated after domain changes | Pass 1b | Phase 2 item 4c — `/mind edit aliases for <domain>` management workflow |

The alias management workflow (`/mind edit aliases for recipes`) is a Phase 2 item. Until it exists, aliases can be updated directly in `PGC_DomainHelp` via the SERV table endpoint.

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

These tables are Phase 3. They are defined here so their design informs the
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
| 14 | PGC_Session | Phase 3 — session identity, UI-agnostic, UUID keyed |
| 15 | PGC_SessionEntry | Phase 3 — append-only conversational + activity log |
| — | PGC_WorkflowStats | SQL view — not a physical table |

**Total: 13 physical PGC tables (bootstrapped) + 2 session tables (Phase 3) + 1 view**


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
| 6.3 | Intent Preprocessor — the kernel that routes input to programs |
| 6.4 | Step Orchestrator — WorkflowRun, execution loop, and all execution subsystems |
| 6.4.1 | Step types — the instruction set |
| 6.4.2 | Execution Stack — the program counter and call stack |
| 6.4.3 | `local_state` — the data bag / memory |
| 6.4.4 | Human-in-the-Loop — blocking I/O |
| 6.4.5 | Parallel execution hooks — deferred, Phase 3 |
| 6.4.6 | `simulate` step type — workflow path simulation and validation |
| 6.5 | Right-Brain Output Validation — correction loop |
| 6.6 | Workflow Safety — circuit breakers and emergency shutdown |
| 6.7 | create_domain Workflow — full annotated example |
| 6.8 | create_workflow Workflow — Phase 2 |
| 6.9 | Session Architecture — conversational memory (Phase 3) |

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
  is what resumes the suspended stack. See Section 6.4.4 for the full gate lifecycle and message contract.

---

### 6.2 Process Layer config tables — PGC as system memory

The PGC database (`pgc`) is the brain's persistent system memory. The Step
Processor and Intent Preprocessor are stateless Lambda functions — they carry no
in-process memory between invocations. Everything they need to operate is loaded
from PGC at runtime.

#### Tables and their roles in the Step Processor

| Table | Role | Read by | Written by |
|---|---|---|---|
| `PGC_Workflow` | Program store — stores the step array for every workflow | Step Processor | `upsert-workflow.mjs` / create_workflow workflow |
| `PGC_WorkflowRun` | Process control block — stack, status, state, callback for each run | Step Processor | Step Processor |
| `PGC_WorkflowRunStep` | Audit log — one row per step execution, used for idempotency | Step Processor | Step Processor |
| `PGC_Prompt` | Prompt store — `prompt_text`, `output_schema`, `model`, `error_log` per intent | Step Processor (llm_call steps) | `upsert-prompt.mjs` / right-brain |
| `PGC_IntentMap` | Intent routing table — regex patterns → `intent_category` + `workflow_id` | Intent Preprocessor | `create_domain` workflow (step 10) |
| `PGC_DomainHelp` | Domain registry — aliases, description, CRUD commands per domain | Intent Preprocessor | `create_domain` workflow (step 8) |
| `PGC_Schema` | Schema registry — column definitions per PGD table | SERV (column validation) | `create_domain` workflow (DDL iterator) |
| `PGC_TableMap` | Table routing — maps table names to their database target | SERV (insertRow gate) | `create_domain` workflow (DDL iterator) |
| `PGC_SystemContext` | System-wide config — thresholds, defaults, feature flags | Step Processor, Preprocessor | `init-brain.mjs` / admin |
| `PGC_StepType` | Step type registry — canonical list of valid step types | Right-brain (Phase 3) | `init-brain.mjs` |
| `PGC_Capability` | Capability registry — available tools the brain can invoke | Right-brain (Phase 3) | `init-brain.mjs` |
| `PGC_WorkflowStats` | Aggregate view — run counts, failure rates per workflow | Right-brain, monitoring | DB view (auto-maintained) |

#### How these tables are used together in a workflow run

When `create_domain` runs, the Step Processor:

1. Reads `PGC_Workflow` once to load the step array — this is the program
2. Reads `PGC_Prompt` at each `llm_call` step to get the prompt text and schema
3. Writes `PGC_WorkflowRun.stack` and `.state` after every step — persisting the program counter and data bag
4. Writes `PGC_WorkflowRunStep` after every step — idempotency audit log
5. Calls SERV which reads `PGC_Schema` and `PGC_TableMap` to validate and route inserts
6. At the end of the workflow, writes `PGC_DomainHelp`, `PGC_Workflow` (4 CRUD workflows), and `PGC_IntentMap` (4 rows) — making the new domain available to the Intent Preprocessor

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

#### Three-tier classification pipeline

```
User input — arrives via /mind Slack command
  │
  ▼
Tier 1 — Coded logic (zero LLM cost)
  │
  ├── Pass 1a: regex test against PGC_IntentMap.pattern rows
  │     Load all rows. Test lowercased input against each pattern.
  │     First match → intent_category + action_type + workflow_id.
  │     SHORT-CIRCUIT — no further passes if matched.
  │     e.g. "build me a new domain" → create.domain → heavy_lift
  │
  ├── Pass 1b: tokenise input, scan PGC_DomainHelp.aliases arrays
  │     Load all domain rows. Check if any alias token appears in input.
  │     Resolves a domain name — passes domain as hint to Pass 1c or Tier 2.
  │     e.g. "portfolio" → domain: stock_portfolio resolved
  │
  ├── Pass 1c: CRUD verb detection against resolved domain
  │     Patterns: list, add, update, delete, show
  │     Verb matched → build ad_hoc_step, return confidence: crud
  │     No verb → pass domain as hint to Tier 2 (warm — domain already known)
  │     e.g. "list my stock_portfolio" → serv_query ad_hoc_step built
  │
  └── Phase 3 — Pass 1b domain fallback from session context
        If no alias token in input, check recent PGC_SessionEntry for active domain.
        "add carbonara" resolves to recipes because user was just there. Zero LLM cost.
  │
  ▼ (no Tier 1 match)
Tier 2 — Cheap LLM classification (perplexity/sonar)
  Compact prompt: classify intent → { intent_category, workflow_name, action_type }
  Domain hint from Pass 1b injected if available — sonar classifies action only.
  Session context injected (Phase 3) — enables ambiguous short-form resolution.
  ├── workflow_name found in PGC_Workflow → enqueue WORKFLOW_STEP execute_top
  ├── action_type = 'crud'               → build ad_hoc_step → execute
  └── action_type = 'heavy_lift'         → Tier 3
  │
  ▼
Tier 3 — Heavy lift handoff (no additional LLM call)
  ├── intent_category = 'create_domain'   → enqueue CREATE_DOMAIN
  ├── intent_category = 'create_workflow' → enqueue CREATE_WORKFLOW
  └── unknown heavy_lift                  → WORKFLOW_NOTIFY: "I understood this
                                            but have no workflow for it yet."
```

#### Classification response shape

```json
{
  "intent_category": "list_stock_portfolio",
  "action_type":     "workflow",
  "confidence":      "exact | alias | crud | llm_classified | heavy_lift",
  "workflow_name":   "list_stock_portfolio",
  "workflow_id":     12,
  "domain":          "stock_portfolio",
  "ad_hoc_step":     null,
  "traceId":         "uuid"
}
```

`confidence` is the tier and pass that produced the result — useful for
right-brain analysis of where classification is weak.

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

---

### 6.4 Step Orchestrator — WorkflowRun and the execution loop

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
  stack         jsonb          — execution stack (see 6.4.2)
  state         jsonb          — { local_state: { ... } } — the data bag (see 6.4.3)
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
Execute step (see 6.4.1 — step types)
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

### 6.4.1 Step types — the instruction set

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
║ js_transform ║ Run a named built-in transform on local_state data.  ║ ✅ Implemented   ║
║              ║ Only built-in: columnSummary. Generic AST sandbox    ║ (columnSummary   ║
║              ║ deferred to Phase 3.                                 ║ only)            ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ human_gate   ║ Suspend stack, present dialog to user, resume on     ║ ✅ Implemented   ║
║              ║ response. Gate types: confirm, edit_list, text_input,║                  ║
║              ║ review_object. (select_one, select_many Phase 3)     ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_schema  ║ Create a PGD table via SERV createTable              ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_insert  ║ INSERT one row into a PGD table via SERV             ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_query   ║ SELECT rows from a PGD table via SERV                ║ ✅ Implemented   ║
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
║ sub_workflow ║ Push child workflow frame, inherit local_state        ║ ⬜ Phase 3       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ condition    ║ Evaluate expression, branch on if_true / if_false    ║ ⬜ Phase 3       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ capability_call ║ Call a registered capability from PGC_Capability  ║ ⬜ Phase 3       ║
╠══════════════╣══════════════════════════════════════════════════════╣══════════════════╣
║ simulate       ║ Dry-run a workflow step array against named         ║ ✅ live          ║
║               ║ execution paths using injected mock outputs.         ║ v3.2-create-    ║
║               ║ Three validation levels: static analysis, path        ║ workflow-       ║
║               ║ execution, skip-path analysis. See Section 6.4.6.   ║ complete        ║
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
```json
{
  "step": "2", "type": "js_transform",
  "transform_type": "columnSummary",
  "input_key":  "proposed_scaffold.tables",
  "output_key": "proposed_scaffold.tables",
  "on_success": "next"
}
```
`transform_type` is required — there is no fallback. Unknown types throw.
`columnSummary` enriches each table object with a `columnSummary` string
listing the first four non-system column names — used as secondary text in
`edit_list` gates.

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
Full schema, validation levels, and result structure: see **Section 6.4.6**.

---

### 6.4.2 Execution Stack — program counter and call stack

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

### 6.4.3 `local_state` — the data bag

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

### 6.4.4 Human-in-the-Loop — blocking I/O

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
| `select_one` | Pick one item from a list | Phase 3 |
| `select_many` | Pick zero or more items | Phase 3 |

#### Human gate-step schema reference

Full field reference for a `human_gate` step definition. This is the authoritative
schema for workflow authors and the right-brain when generating or validating
workflow definitions containing gate steps.

```json
{
  "step":             "3",
  "type":             "human_gate",
  "gate_type":        "confirm | edit_list | text_input | review_object | select_one | select_many",
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
`resume_gate` expects in `responseData`. See the gate type catalogue in 6.4.4.

**`message_template`** — resolved via `template-resolver.mjs` at suspension time,
not at step definition time. Template variables are read from `local_state` at the
moment the gate suspends.

**`context_key`** — dot-path into `local_state`. For `edit_list`, must resolve to
an array. For `review_object`, resolves to an object or array — arrays are rendered
as a table-name / column-list display. Optional for `confirm`.

**`item_action`** — `edit_list` only. Defines a per-row action button. `condition`
is evaluated against each item — items where the condition is falsy do not get the
button. Only `remove_item` is currently implemented; others are Phase 3.

**`options`** — rendered as Block Kit buttons. Each `on_select` drives post-gate
routing: `"next"` advances sequentially, `"step:N"` jumps to step N, `"cancel"`
cancels the run. Must include at least one option with `action: "cancel"`.

**`output_key`** — `text_input` only. The typed value is written to
`local_state[output_key]` when the gate resolves. Not used by other gate types.

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

### 6.4.5 Parallel execution hooks — deferred, Phase 3

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
Phase 3 lands. Sequential mode never reads these fields — they are null-safe.

**Phase 3 prerequisite:** Parallel execution requires the cycle detector (Guard 3)
to be implemented first. A fan-out that triggers another fan-out would create
unbounded concurrency without cycle detection at workflow registration time.

---

### 6.4.6 `simulate` step type — workflow path simulation and validation

The `simulate` step type is the right-brain’s earliest operational capability.
It dry-runs a generated workflow definition through the Step Processor’s own
execution logic using injected mock outputs and decision scripts, validates every
`local_state` transition, and surfaces structured failure reports before the
workflow is registered in `PGC_Workflow`. It is a prerequisite for `create_workflow`
being trustworthy and is classified as Phase 2 work, not Phase 3.

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

### 6.5 Right-Brain Output Validation — correction loop

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

### 6.6 Workflow Safety — circuit breakers and Guard 1

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

#### Deferred safety mechanisms (Phase 3)

| Guard | Purpose | Trigger |
|---|---|---|
| Velocity detector | Too many steps per time window | `steps_in_window` / `window_started_at` on run |
| Execution accumulator | Total cost / duration limit | `PGC_SystemContext` thresholds |
| Cycle detector | Circular workflow routing | Graph analysis at workflow registration time |
| `/shutdown` | Emergency stop any run | Sets status = cancelled; execute_top checks before executing |

#### Emergency shutdown

`POST /proc/shutdown { workflowRunId }` sets `PGC_WorkflowRun.status = 'cancelled'`.
Every `execute_top` invocation checks status before executing any step. If
`cancelled`, the message is discarded. The shutdown contract is: no step will
execute after `/shutdown` is called, even if SQS messages are already in flight.

---

### 6.7 create_domain Workflow — full annotated example

`create_domain` is the primary demonstrator workflow. It uses every major Step
Processor capability: `llm_call`, `js_transform`, multi-step `human_gate`
sequences with branching, `iterator`, `serv_insert`, and `notify`.

Reading this workflow against sections 6.4.1–6.4.4 is the intended way to understand
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

Step 6  llm_call → generated = { domainHelp, workflows: [4 CRUD workflows], intentMapRows: [4 rows] }
Step 7  human_gate review_object → user reviews domainHelp (aliases, description, commands)
        ├── confirm → next (step 8)
        └── cancel  → cancelled

Step 8  serv_insert PGC_DomainHelp ← generated.domainHelp
Step 9  iterator over generated.workflows
          item_step: serv_insert PGC_Workflow(item)
Step 10 iterator over generated.intentMapRows
          item_step: serv_insert PGC_IntentMap(item)
Step 11 notify → "Domain {{proposed_scaffold.domain}} created."
Step 12 end
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
| 6 | `generate_crud_workflows` v2 | `generated` |

All three prompts have `output_schema` defined. The correction loop runs on all
three if the LLM output is malformed.

---

### 6.8 create_workflow Workflow — Phase 2

`create_workflow` is the workflow that makes the brain self-extending. When a user
says `/mind create a workflow that sends me a weekly portfolio summary`, the brain
designs the step array, validates it, simulates it, and registers it — without
any code changes. Every new workflow becomes immediately available to the Intent
Preprocessor.

---

#### Why `create_workflow` is harder than `create_domain`

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
the step array — see Section 6.4.6 Level 1) and **simulation** (execution-time
data flow validation — see Section 6.4.6 Levels 2 and 3). Both run before the
workflow is registered.

---

#### Decision: decomposed LLM generation

A single LLM call producing steps + mock_outputs + output_schema + simulation_paths
simultaneously is unreliable. The four structures are interdependent — mock shapes
must match `output_key` fields, simulation paths must reference step keys, the
output_schema must describe mock shapes — and LLMs are increasingly unreliable at
global referential integrity as the number of cross-references grows. The failure
mode is not an obviously wrong answer but a subtly inconsistent one that passes
Ajv and only breaks at simulation time.

The solution is **dependency-ordered generation**: each structure is produced in
a separate `llm_call` step, using the confirmed output of the prior step as input.
Each call is narrow, well-scoped, and independently correctable by the 2-attempt
correction loop.

| Step | LLM call | Input | Output |
|---|---|---|---|
| 2 | `generate_workflow_steps` v1 | User intent + domain schema + `PGC_StepType` contracts (live only) + `create_domain` as worked example | `draft_workflow` — name, description, steps array only |
| 5 | `generate_workflow_mocks` v1 | Confirmed `draft_workflow.steps` | `mock_outputs` keyed by step number |
| 6 | `generate_workflow_paths` v1 | Confirmed `draft_workflow.steps` + `mock_outputs` | `simulation_paths` decision scripts |

This means three LLM calls instead of one. The cost is justified: each call is
cheaper individually (narrower context), independently correctable (the correction
loop targets only the failing call), and the simulation that follows is the primary
quality gate.

**`output_schema` is not generated by the LLM.** `llm_call` steps in generated
workflows reference existing prompts in `PGC_Prompt` — those prompts already have
`output_schema` defined. If a workflow requires a new prompt, that is a separate
`create_prompt` workflow (Phase 3), not part of `create_workflow`.

---

#### Decision: PGC_SystemContext injection, not inline rules

The `generate_workflow_steps` prompt is deliberately short. It does not embed step
type contracts as inline text. Instead it injects at runtime:

- `PGC_StepType` rows where `status = 'live'` — input/output contracts per type, valid routing values
- `PGC_SystemContext` rows where `inject_for` includes `create_workflow` — naming
  conventions, routing value enumeration, template syntax rules
- `create_domain` annotated example from Section 6.7 — the worked example that
  makes the instruction set concrete

When a new step type goes live, `PGC_StepType` is updated. The prompt does not
change. This is the correct locus of control for evolving the instruction set.

---

#### Decision: routing values formally enumerated in PGC_StepType

`on_success`, `on_failure`, and `on_select` currently accept any string, with
unknown values silently falling through to `"next"` in `resolveNextAction()`.
This is a known gap (see tech debt register). For `create_workflow` to produce
correct routing values, the valid set must be formally enumerated.

`PGC_StepType.on_success_options` and `on_failure_options` jsonb columns are
seeded with the valid values per step type before `create_workflow` is implemented.
The `generate_workflow_steps` prompt receives these from the injected `PGC_StepType`
context. Level 1 static analysis in the `simulate` step validates every routing
value against the seeded enum before simulation begins.

---

#### Decision: `human_feedback` implemented before `create_workflow` ships

`human_feedback` appears on every `on_failure` in every workflow definition but is
currently unimplemented — it silently falls through to `"next"`, and the run is
marked `failed` by the catch block before routing logic is ever consulted. This is
acceptable in `create_domain` where a step failure is a terminal event. It is not
acceptable in user-generated workflows where the user expects recovery options.

`human_feedback` must be implemented in `run-workflow.mjs` before `create_workflow`
is deployed. The behaviour: when a step throws and `on_failure === "human_feedback"`,
the Step Processor pushes a recovery `human_gate` with three options (Retry, Skip,
Cancel) instead of immediately marking the run failed. The existing `human_gate`
machinery handles the gate — no new step type, no schema change, no new SQS queue.
The only new code is in the failure catch blocks of `executeTop` and
`executeIteratorItem`.

---

#### Step definition

```
Step 1   llm_call (classify_workflow_intent v1)
           input:  { userIntent: "{{input.userIntent}}", domain: "{{input.domain}}" }
           output: workflow_intent = { domain, operation_type, target_tables, description }

Step 2   llm_call (generate_workflow_steps v1)
           input:  { workflow_intent: "{{workflow_intent}}",
                     domain_schema: "{{domain_schema}}",
                     steptypes: injected from PGC_StepType (live rows),
                     example: injected from PGC_SystemContext }
           output: draft_workflow = { name, description, intent_keywords, steps }

Step 3   human_gate (review_object)
           context_key:      "draft_workflow.steps"
           message_template: "Review the proposed steps for {{draft_workflow.name}}."
           options:
             Looks good      → next
             Request changes → step:2
             Cancel          → cancel

Step 4   simulate (Level 1 — static analysis only)
           input:  { steps_key: "draft_workflow.steps" }
           output: static_analysis_result
           on_success: next
           on_failure: step:3   (routes back with Level 1 failures shown in gate context)

Step 5   llm_call (generate_workflow_mocks v1)
           input:  { steps: "{{draft_workflow.steps}}" }
           output: mock_outputs = { "<step_key>": <representative output object> }

Step 6   llm_call (generate_workflow_paths v1)
           input:  { steps: "{{draft_workflow.steps}}", mock_outputs: "{{mock_outputs}}" }
           output: simulation_paths = [ { path_name, decisions, expected_terminal }, ... ]

Step 7   simulate (Level 2 + 3 — full path simulation)
           input:  { steps_key:        "draft_workflow.steps",
                     mock_outputs_key: "mock_outputs",
                     paths_key:        "simulation_paths" }
           output: simulation_result
           on_success: next
           on_failure: step:3   (routes back with path failure details in gate context)

Step 8   human_gate (confirm)
           message_template: "Simulation passed {{simulation_result.paths_passed}} of
                              {{simulation_result.paths_run}} paths. Ready to register
                              {{draft_workflow.name}}?"
           options:
             Register → next
             Cancel   → cancel

Step 9   serv_insert PGC_Workflow
           input:  { tableName: "PGC_Workflow",
                     row: { name:             "{{draft_workflow.name}}",
                            domain:           "{{workflow_intent.domain}}",
                            description:      "{{draft_workflow.description}}",
                            intent_keywords:  "{{draft_workflow.intent_keywords}}",
                            steps:            "{{draft_workflow.steps}}",
                            version:          1 } }
           output: registered_workflow

Step 10  iterator over generated_intent_map_rows
           item_step: serv_insert PGC_IntentMap
           output: registered_intent_rows

Step 11  notify
           message_template: "Workflow {{draft_workflow.name}} is registered and ready.
                              Try: /mind {{draft_workflow.description}}"
           on_success: end

Step 12  end
```

---

#### Gate-bounded correction loops

Steps 3–4 and steps 3–7 form gate-bounded correction loops. The backward jump
from step 4 (or step 7) to step 3 is safe because every path from step 3 back to
step 4 or step 7 passes through the step 3 `human_gate`. This satisfies Guard 3’s
cycle-safety rule: a backward reference is safe if there is at least one
`human_gate` on the path from the target step back to the source step.

The user is the circuit breaker for these loops. If simulation repeatedly fails
and the user cannot resolve the issues, they cancel at step 3. There is no
automated retry limit on human-gate-bounded loops.

---

#### Prompt dependencies

| Step | Prompt `intent_category` | Output stored at |
|---|---|---|
| 1 | `classify_workflow_intent` v1 | `workflow_intent` |
| 2 | `generate_workflow_steps` v1 | `draft_workflow` |
| 5 | `generate_workflow_mocks` v1 | `mock_outputs` |
| 6 | `generate_workflow_paths` v1 | `simulation_paths` |

All four prompts must have `output_schema` defined before `create_workflow` is
deployed. The correction loop in `review-output.mjs` runs on all four independently.

---

#### Prerequisites before implementation

All prerequisites are now complete as of `v3.2-create-workflow-complete`:

1. ✅ `simulate` step type implemented in `step-executor.mjs` (Section 6.4.6)
2. ✅ `on_failure: "human_feedback"` implemented in `run-workflow.mjs`
3. ✅ `PGC_StepType` rows seeded with live step types and routing value contracts
4. ✅ Routing value semantic validation rule in `review-output.mjs` (Pass 2b)
5. ✅ `PGC_SystemContext` rows seeded with `inject_for: ["create_workflow"]` context
6. ✅ Four new prompts in `seed_PGC_Prompt.json` and live in DB

---

### 6.9 Session Architecture — Conversational Memory (Phase 3)

The session layer gives the brain persistent memory across multiple `/mind`
messages in the same Slack thread. Without it, each `/mind` call is cold — the
Intent Preprocessor has no knowledge of what the user was just doing. With it,
the brain can resolve ambiguous short-form inputs, pre-seed workflow state with
entities the user was already working on, and accumulate a factual record of what
happened in each thread — feeding the right-brain improvement loop.

The session layer is Phase 3. The Intent Preprocessor works without it. When it
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

**Tier 1c domain fallback:** If Pass 1b finds no alias token in the input text,
the preprocessor scans the session context for the most recently active domain.
"Add carbonara" resolves to `recipes` because the session shows the user was just
there. Zero LLM cost.

**Tier 2 prompt injection:** The context block is prepended to the sonar
classification prompt. "Make that a three-course meal plan" becomes classifiable
as `meal_planner` because sonar sees the user has been working with recipes.

#### Full example — recipes exploration → add → meal plan

```
Turn 1  /mind show me my pasta recipes
  Pass 1b: alias 'pasta' → domain 'recipes'
  Pass 1c: verb 'show' → serv_query ad_hoc_step built

Turn 2  /mind add carbonara with ingredients [...]   (same thread)
  Pass 1b: no alias token → fallback to session context → domain 'recipes'
  Pass 1c: verb 'add' → serv_insert ad_hoc_step built

Turn 3  /mind make that a three-course meal plan using those recipes
  Pass 1a: no match. Pass 1b: no alias. No verb.
  Tier 2: sonar receives input + session context
  → workflow_name = 'meal_planner', referenced_entities = [Carbonara, ...]
  → execute_top, local_state.context pre-seeded with referenced_entities
```


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
| `js_transform` built-in `columnSummary` only | Medium | Generic sandboxed JS (acorn AST gate + `vm.runInNewContext`) not implemented. New built-ins `buildDomainHelp` and `buildCrudWorkflows` added for Phase 2 item 4a. Generic sandbox deferred to Phase 3 |
| `PGC_WorkflowRunStep` idempotency uses `parseInt(stepNumber)` | ~~Medium~~ | ✅ Resolved — `step_key text` column added to `PGC_WorkflowRunStep`. `checkIdempotency` queries on `(run_id, frame_id, step_key)` string comparison. `parseInt` never used in idempotency paths. `migrate-step-key.mjs` backfilled existing rows |
| `created_tables_summary` hardcoded in iterator | ~~Low~~ | ✅ Resolved — `notify` step message_template now uses `proposed_scaffold.domain` and explicit command examples instead of the hardcoded iterator summary |
| `domain: null` on DDL-created tables | ~~Medium~~ | ✅ Resolved in Phase 2 item 4a — `js_transform` at step 2 enriches each table object with `domain: proposed_scaffold.domain` before the DDL iterator runs. `serv_schema createTable` writes domain to both `PGC_Schema` and `PGC_TableMap` |
| `design-domain.mjs` dead code | Low | No longer receives traffic since Step Processor took over. Remove in next cleanup pass |
| `createTable` DDL + PGC_Schema insert not in a transaction | Medium | Physical table can exist without registry row on partial failure |
| Orphan table cleanup tooling | Low | Failed partial runs leave orphan tables in PGC_Schema — `delete-domain` covers full domains; per-table orphan cleanup is manual |
| AWS infrastructure cost — Bastion Host public IPv4 | Low | EC2 Bastion accrues ~$2.82/month in public IPv4 charges. Replace with AWS SSM Session Manager when promotional credits near exhaustion |
| W3C `traceparent` format for `traceId` | Low | Adopt `{version}-{traceId}-{parentId}-{flags}` when observability tooling added |
| `updateTable` ALTER TABLE | Medium | Currently metadata only — does not execute ALTER TABLE |
| Unit tests | Medium | Test pure functions first: `buildCreateTableSQL`, `validateCreatePayload`, `parseEvent`, `resolveTemplate`, `evalItemCondition`, `matchIntentMap`, `matchDomainAlias`, `matchCrudPattern`, `parseFieldValues`, `hasCrudVerb`. Use `node:test` built-in |
| Integration tests | Low | Defer until intent pipeline complete — use `testcontainers` + PostgreSQL |
| CI/CD GitHub Actions | Low | Deliberately deferred until `template.yaml` stabilises |
| Dependency injection for DB clients | Medium | Needed for unit testability — clients currently instantiated at module level |
| PROC/SERV API Gateway resource policy | Medium | Restrict to AWS account-scoped requests before any public exposure — see Section 12.3 |
| `callback` routing pattern not enforced at compile time | Low | Every PROC endpoint reading callback from SQS must use `req.callback ?? req.body?.callback ?? null`. Currently convention only |
| Terraform state — legacy infrastructure | Low | Terraform config in `terraform-aws/` predates SAM migration. Check for orphaned AWS resources before decommissioning |
| Azure MSAL token utility (`src/lib/getAccessToken.js`) | Low | Vercel-era artifact. Assess for Teams Experience tier or decommission |
| `upsert-workflow.mjs` required on fresh deploys | Low | `init-brain` uses `ON CONFLICT DO NOTHING` — must run `upsert-workflow.mjs <name>` after any workflow step changes. Required after deploying the revised `create_domain` 12-step definition |
| `create_workflow` workflow steps empty | ~~Low~~ | Full step definition added in Section 6.9 — Phase 2 implementation item |
| Tier 1 sub-pass 2b — intent_keywords keyword scan | Low | After Pass 1b resolves a domain, scan `PGC_Workflow.intent_keywords` for workflows whose `domain` column matches. Zero LLM cost. Deferred to Phase 3. Will be superseded by pgvector semantic search. `intent_keywords` column already exists on `PGC_Workflow` — no schema change needed |
| CRUD ad_hoc_step execution | ~~Medium~~ | ✅ Resolved — `serv_query`, `serv_update`, `serv_delete` step types live in `step-executor.mjs`. `executeCrudStep()` in `classify-intent.mjs` executes ad_hoc steps directly. All four verbs (list, add, update, delete) working. Structured input enforced: `id=<number>` for delete/update, `field=value` pairs for insert/update |
| `design_table` prompt not yet seeded | ~~High~~ | ✅ Resolved — `design_table` v1 in `seed_PGC_Prompt.json`. `create_domain` workflow v5 (13 steps) deployed and end-to-end complete |
| Guard 3 cycle detector — backward reference handling | Medium | Guard 3 must distinguish intentional gate-bounded loops (e.g. step 3c → step 3 in create_domain) from tight computational loops. Rule: a backward reference is safe if the path from target back to source contains at least one `human_gate` step |
| Session layer — PGC_Session + PGC_SessionEntry | Medium | Phase 3. Requires `PGC_WorkflowRun.session_id` FK column migration. `mind.mjs` session lookup via `getRows` on `callback.threadId`. Step Processor writes activity entries at `end` steps and `confirm` gate resolutions. `classify-intent.mjs` writes message entries. See Section 4.3.4 and 6.13 |
| `PGC_WorkflowRun.session_id` FK column | Medium | Phase 3 — add `session_id integer FK → PGC_Session.id nullable` to `PGC_WorkflowRun`. Required by session layer. Migration script needed — column did not exist at bootstrap |
| Alias management workflow `/mind edit aliases for <domain>` | Low | Phase 3. Allows users to view and update `PGC_DomainHelp.aliases` from Slack without touching the DB. Until this exists, aliases can be corrected directly via SERV table endpoint. Rule-based singular/plural derivation in Phase 2 item 4a covers the common case |
| Session context window size configurable | Low | `chat_defaults` key in `PGC_SystemContext` should define `session_context_limit` (default 20). Currently hardcoded in classify-intent.mjs spec — externalise when session layer is built |
| Live prompt export back to seed files | Medium | When the right-brain improves a prompt (via `PGC_Prompt.error_log` or manual correction), the improved version lives only in the DB. A fresh brain instance bootstrapped from `seed_PGC_Prompt.json` would revert to the original seed. Fix: `dev_scripts/export-prompts.mjs` reads live `PGC_Prompt` rows and overwrites `seed_PGC_Prompt.json`. Run before creating a new brain instance. Required before the right-brain improvement loop (Phase 3 item 8) is useful at scale |
| `PGC_SystemContext.step_type_contracts` can become stale | Low | The `step_type_contracts` content in `PGC_SystemContext` is derived from `PGC_StepType` rows at the time `seed_PGC_SystemContext.mjs` runs. When a new step type goes live, re-run `seed_PGC_StepType.mjs` then `seed_PGC_SystemContext.mjs` to update the injected context. This is intentional — the script is the locus of control, not the prompt text |
| Concurrent bootstrap race — `tuple concurrently updated` | ~~High~~ | ✅ Resolved — `seedPGCSchema` changed from `ON CONFLICT DO UPDATE` to `ON CONFLICT DO NOTHING`. All seed functions now use `DO NOTHING` or `WHERE NOT EXISTS`. Concurrent cold-start bootstraps are fully idempotent |
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

### Candidates approved for future addition

| Package | Weekly DL | License | Purpose | When |
|---|---|---|---|---|
| `acorn` | ~50M | MIT | AST parser for `js_transform` sandbox gate (Section 6.11) | Phase 2 item 3a JS validation |
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
| 4a | create_domain workflow revision | ✅ complete — v3.2-create-domain-with-crud |
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
| 5 | PROC — Step Processor — SQS-driven stack execution, full PGC_WorkflowRun lifecycle | ✅ complete — v3.2-step-processor-complete |
| | — `run-workflow.mjs`, `step-executor.mjs`, `template-resolver.mjs` | ✅ |
| | — velocity detector, execution accumulator, cycle detector (Section 6.10) | ⬜ deferred — see tech debt register |
| | — Step Processor checks PGC_WorkflowRun.status before executing (shutdown contract) | ✅ |

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
| `serv_query` | ✅ live | Resolves template vars in filters/orderBy/limit, writes rows array to output_key |
| `serv_update` | ✅ live | Generic filter + updates shape, full template resolution, enforces non-empty filters |
| `serv_delete` | ✅ live | Generic filter shape, full template resolution, enforces non-empty filters |
| `simulate` | ✅ live | Level 1 static analysis + Level 2 path execution + Level 3 skip-path analysis (advisory). Used by `create_workflow` steps 4 and 7 |
| `sub_workflow` | ⬜ Phase 3 | |
| `condition` | ⬜ Phase 3 | |
| `capability_call` | ⬜ Phase 3 | Not yet defined — see Section 15.1 |

**Gate types — implemented in `dialogToBlocks()` vs deferred:**

| Gate type | Status |
|---|---|
| `confirm` | ✅ live |
| `edit_list` | ✅ live — per-row Remove button, in-place `chat.update` re-render, Add table branch (Phase 2 item 4a) |
| `text_input` | ✅ live — add-table branch step 3a, value written to local_state[output_key] |
| `review_object` | ✅ live — domain help confirmation step 7, column detail review step 3d |
| `select_one` | ⬜ Phase 3 — `buildDialog()` stub exists |
| `select_many` | ⬜ Phase 3 — `buildDialog()` stub exists |

### Phase 3 — Deferred

| # | Task |
|---|---|
| 1 | SERV-Query — cross-entity parameterised SELECT with pagination |
| 2 | Generic `js_transform` sandbox — acorn AST gate + `vm.runInNewContext` |
| ~~3~~ | ~~`serv_query`, `serv_update`, `serv_delete` step types~~ ✅ live — v3.2-crud-adhoc-complete |
| 4 | `sub_workflow` and `condition` step types |
| 5 | `capability_call` step type + External API Registry (Section 15.1) |
| 6 | Remaining gate types: `select_one`, `select_many` |
| 7 | pgvector semantic search — intent classification + prompt deduplication (Section 10). Does not block any Phase 2 feature. Reduces Tier 2 LLM call frequency for domain workflows once CRUD workflows are registered in PGC_IntentMap by Phase 2 item 4a. Until Phase 3, Pass 1a regex + Tier 2 sonar handle novel phrasings correctly |
| 7a | Tier 1 sub-pass 2b — `PGC_Workflow.intent_keywords` keyword scan after domain alias match. Superseded by pgvector when Phase 3 lands |
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
Enable: CREATE EXTENSION IF NOT EXISTS vector;

Embedding model: text-embedding-3-small (OpenAI), 1536 dimensions
Used in: PGC_Workflow, PGC_DomainHelp, PGC_Prompt, PGC_IntentMap

Primary use cases:
- Intent preprocessor — find matching workflow by semantic similarity (supersedes Tier 1 sub-pass 2b)
- /help search — find domain by natural language description
- Prompt deduplication — avoid generating duplicate prompts

**Phase 3 — no Phase 2 feature is blocked by its absence.**

The system works correctly without pgvector. Phase 2 item 4a populates `PGC_IntentMap` with
domain CRUD patterns (e.g. `list.recipes|show.recipes`) so Pass 1a handles common phrasings
at zero LLM cost. Tier 2 (sonar) handles novel phrasings for a few cents per call. pgvector
would reduce Tier 2 call frequency further but is not the correct investment before the CRUD
workflow generation and session layer are stable.

Status: Designed, not yet implemented. Add `vector` to ALLOWED_TYPES in schema.mjs
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
  manipulate workflow execution. Covered by the right-brain validation loop (Section 6.11).

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
| API keys (external callers) | API Gateway usage plans | ⬜ Phase 3 |

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

#### The design

The system maintains a **capability registry** of approved external integrations.
Each registered capability defines what can be called, how to authenticate, and
what parameters are allowed. The LLM generates workflow steps that reference
capability keys — it never constructs URLs, never sees API keys, and cannot call
anything outside the registry.

**PGC_Capability schema extension** (Phase 3):

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

#### What needs to be built (Phase 3)

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
| Use RDS Aurora Serverless v2 | Variable — cheaper at low use | Phase 3 if usage patterns justify it |

**Highest impact action today:** Replacing the Bastion with SSM Session Manager
eliminates the EC2 instance ($1.78) and one public IPv4 address ($0.94) — saving
~$2.72/month with no loss of functionality. Tracked in tech debt register.
