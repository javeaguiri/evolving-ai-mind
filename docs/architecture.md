# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2  
Status: Active development — create_workflow next  
Last updated: 2026-03-23 (session 8)

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

`ProcFunction` is the cognitive core of the system. It owns all business logic — intent
classification, workflow execution, LLM orchestration, and domain management. It has no
knowledge of Slack, no direct database access, and no AWS SDK imports in its endpoint
modules. It receives normalised requests from the Experience tier (via SQS WorkflowQueue
or HTTP), executes against SERV via HTTP fetch, and returns results either directly
(HTTP path) or via the SQS SlackResults queue (SQS path).

The Process tier is designed around three principles. First, transport agnosticism —
every endpoint module receives the same normalised `req` object whether the request
arrived from Slack via SQS or from a developer via curl. Second, declarative execution —
workflows are stored as JSON step definitions in `PGC_Workflow` and driven generically
by the Step Processor; no workflow requires bespoke PROC code. Third, LLM cost discipline
— the LLM is called only for novel intents and novel workflow or schema generation.
Everything else runs from cached `PGC_Workflow` rows at zero LLM cost.

This section covers the major subsystems of PROC in the order a request encounters them:
the callback abstraction that routes results back to the UI (6.1), the Step Processor
that executes declarative workflows (6.2–6.3), the Intent Preprocessor that classifies
natural language input before any workflow is invoked (6.4), and the specific workflows
built on top of these foundations (6.8 onward).

### 6.1 Callback / Notification Abstraction — IMPLEMENTED

All SQS message payloads use `callback: { provider, channel, threadId }`.
`routeCallback()` in `callback.mjs` dispatches on `provider` — adding a new UI is one new `case`.
SERV is UI-agnostic — callback fields are never read in the SERV layer.

---

### 6.2 Step Definition Schema

Every workflow step in `PGC_Workflow.steps` follows this schema:

```json
{
  "step":         "1",
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

**Step keys are strings throughout.** All step keys are strings: `"1"`, `"2"`, `"3"`, `"3a"`, `"3b"`.
Mixed integer/string keys create lookup ambiguity in the Step Processor.
`on_success: "step:3a"` and backward references like `on_success: "step:3"` are valid routing
and supported by the existing Step Processor. The first backward step reference in the system
is in the `create_domain` workflow — see Section 6.8.

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
  "current_step":           "1",
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

#### Entry point — `/mind` Slack command

The Intent Preprocessor is triggered by the `/mind` Slack slash command. This is a
dedicated entry point separate from `/create-domain` and `/help` — those commands
retain their direct routing and are not affected by this change.

**Flow:**
1. User types `/mind <free-form natural language>` in Slack
2. `SlackbotFunction` (`src/ui/slackbot/mind.mjs`) validates the Slack signing secret,
   posts an ACK message to Slack (returns `ackTs` for threading), and enqueues a
   `CLASSIFY_INTENT` message to SQS WorkflowQueue with `callback: { provider, channel, threadId: ackTs }`
3. `ProcFunction` receives the `CLASSIFY_INTENT` message, routes to
   `src/proc/classify-intent.mjs`
4. `classify-intent.mjs` runs the three-tier classification pipeline and hands off
   to the appropriate downstream handler

`classify-intent.mjs` exports `handle(req)` and is wired as both an HTTP route
(`POST /proc/classify-intent`) and a `CLASSIFY_INTENT` SQS message type in
`proc/handler.mjs` — following the same pattern as `create-domain.mjs`. The HTTP
path is fully testable via curl with no Slack or SQS involvement.

Pure classification logic lives in `src/proc/classify-intent-tiers.mjs` — exported
functions with no I/O, directly unit-testable.

#### Design principles
- Coded logic always runs first — cheap, fast, no LLM cost
- LLM only invoked when coded logic cannot classify the intent
- Every classified intent resolves to a `PGC_Workflow` row and is handed to the Step Processor
- Novel intents that require new workflows or domains are `heavy_lift` — use existing workflow entry points
- The preprocessor has no `PGC_WorkflowRun` row of its own — it is a routing function, not a workflow

#### Three-tier classification pipeline

```
User input (natural language) — arrives via /mind Slack command
  │
  ▼
Tier 1 — Coded logic (zero LLM cost)
  │
  ├── Pass 1a: regex test against PGC_IntentMap.pattern rows
  │     Load all rows once. Test lowercased userInput against each pattern.
  │     First match returns intent_category + action_type + workflow_id.
  │     SHORT-CIRCUIT — PGC_DomainHelp never read if this matches.
  │     e.g. "build me a new domain" → create.domain pattern → heavy_lift
  │
  ├── Pass 1b: tokenise input, scan PGC_DomainHelp.aliases arrays
  │     Load all domain rows. Check if any alias token appears in userInput.
  │     Resolves a domain name. If matched, proceed to Pass 1c.
  │     e.g. "portfolio" → stock_portfolio domain resolved
  │
  ├── Pass 1c: CRUD verb detection against resolved domain
  │     Patterns: list, add, update, delete, show
  │     If verb matched → build ad_hoc_step, return confidence: crud
  │     If no verb → pass domain as hint to Tier 2 (not cold — domain already known)
  │     e.g. "list my recipes" → serv_query ad_hoc_step built
  │
  │     Session context — domain fallback (Phase 3):
  │     If no alias token found in input text, check recent PGC_SessionEntry rows
  │     for the most recently active domain. Allows "add carbonara" to resolve
  │     correctly when the user was just looking at recipes — zero LLM cost.
  │
  └── Pass 2b (DESIGNED — deferred to Phase 3):
        After Pass 1b resolves a domain, scan PGC_Workflow.intent_keywords
        for workflows whose domain column matches. If a keyword appears in
        userInput, route directly to that workflow. Zero LLM cost.
        Superseded by pgvector semantic search when Phase 3 lands.
        The intent_keywords column already exists on PGC_Workflow — no schema change needed.
  │
  ▼ (no Tier 1 match)
Tier 2 — Cheap LLM classification (perplexity/sonar via LLM_CHAT_URL)
  Compact prompt: "Classify this intent. Return JSON: { intent_category, workflow_name, action_type, referenced_entities }"
  If Pass 1b resolved a domain, that domain is passed as a hint — sonar only classifies the action.
  If session context is available (Phase 3), recent PGC_SessionEntry rows are injected
  into the prompt — assembled from entry.content plain text fields, last 20 entries, most
  recent first. This makes ambiguous short-form inputs like "make that a three-course
  meal plan" classifiable by giving sonar the prior context that the user was working
  with recipes.
  ├── workflow_name found in PGC_Workflow → load workflow → enqueue WORKFLOW_STEP execute_top
  ├── action_type = 'crud'               → build ad_hoc_step → WORKFLOW_NOTIFY today (Phase 3 to execute)
  └── action_type = 'heavy_lift'         → Tier 3
  │
  ▼
Tier 3 — Heavy lift handoff (no additional LLM call — routes to existing entry points)
  ├── intent_category = 'create_domain'    → enqueue CREATE_DOMAIN → existing create-domain.mjs
  ├── intent_category = 'create_workflow'  → enqueue CREATE_WORKFLOW → create-workflow workflow (Phase 2)
  └── unknown heavy_lift                   → WORKFLOW_NOTIFY: "I understood this but have no workflow for it yet.
                                             Use /create-workflow to build one."
```

**CRUD ad_hoc_step execution status:** The preprocessor correctly classifies CRUD intents
and builds the right `ad_hoc_step` (e.g. `{ type: "serv_query", input: { tableName: "PGD_Recipes" } }`).
However, `serv_query`, `serv_update`, and `serv_delete` step types are not yet implemented
in `step-executor.mjs`. Today the response for unexecutable CRUD intents is a `WORKFLOW_NOTIFY`
acknowledging the intent. Execution is the same Phase 3 work as implementing those step types
for LLM-generated workflows — they are the same item viewed from two angles. When those three
Step Processor cases are built in Phase 3, both CRUD ad_hoc_steps and LLM-generated workflow
steps that use them will start working simultaneously.

#### PGC_IntentMap bootstrap rows (seeded at init-brain bootstrap)

| pattern | intent_category | workflow_id | action_type |
|---|---|---|---|
| `create.domain\|new.domain\|build.domain` | `create_domain` | → create_domain workflow | `heavy_lift` |
| `create.workflow\|new.workflow` | `create_workflow` | → create_workflow workflow | `heavy_lift` |
| `list.domains\|show.domains` | `list_domains` | → list_domains workflow | `crud` |
| `help` | `help` | → help workflow | `crud` |

#### CRUD pattern detection (coded logic — no LLM)

Patterns detected without any LLM call. Domain is resolved first via Pass 1b alias match.
```
list <domain>           → serv_query on root table of domain
add <domain> <name>     → serv_insert into root table
update <domain> <id>    → serv_update on root table
delete <domain> <id>    → serv_delete + human confirm gate
show <domain> <id>      → serv_query with filter
```

#### HTTP endpoint and response shape

```
POST /proc/classify-intent
Body: { userInput, traceId }
Response: {
  intent_category,
  action_type,        // 'crud' | 'workflow' | 'heavy_lift'
  confidence,         // 'exact' | 'alias' | 'crud' | 'llm_classified' | 'heavy_lift'
  workflow_name,      // PGC_Workflow.name if found
  domain,             // resolved domain name if Pass 1b matched
  ad_hoc_step,        // step definition if CRUD pattern matched — built but not yet executed
  referenced_entities, // Phase 3 — entities from session context relevant to this classification
  traceId
}
```

The HTTP path is fully testable via curl at every tier:
- Tier 1a: inputs matching `PGC_IntentMap` patterns return `confidence: exact` with no LLM call
- Tier 1b+1c: domain alias inputs return `confidence: alias` or `confidence: crud`
- Tier 2: unclassified inputs call sonar and return `confidence: llm_classified`
- Tier 3: heavy_lift intents enqueue the appropriate SQS message and return the routing decision

#### LLM model selection

| Task | Model | Reason |
|---|---|---|
| Intent classification (Tier 2) | `perplexity/sonar` via `LLM_CHAT_URL` | Fast, cheap, structured JSON — chat completions endpoint |
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

**Domain review gates** — see Section 6.8 for the full create_domain workflow.

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
`create_domain` is the primary declarative workflow stored in `PGC_Workflow`.
It demonstrates the full capability of the Step Processor — LLM calls, multi-step
human review gates with branching, iterators, and service calls — all driven by
the declarative step schema in Section 6.2.

#### Bootstrap seeds required (in `init-brain.mjs`)

**`PGC_Prompt` rows:**
- `intent_category: 'create_domain'` — schema design prompt (version 2 already seeded)
- `intent_category: 'design_table'` — designs a single new table when user adds one via the add-table branch. Input variables: `domain` (name), `existingTables` (array of current table names for FK context), `userDescription` (free text from the text_input gate). Returns a single table definition in identical shape to `create_domain` scaffold tables. Validated by the same Ajv schema as `create_domain` output, filtered to one table entry.
- `intent_category: 'merge_tables'` — redesigns a merged table from two inputs

**`PGC_Workflow` row:** `name: 'create_domain'`

**`PGC_IntentMap` row:** pattern `create.domain|new.domain|build.domain`, workflow_id → create_domain

#### Declarative step definitions

Note: all `step` keys are strings. All `message_template` and `option.label`
values are plain text — no emoji, no markup. The renderer adds all formatting.
`gate_type` values are primitive UI types from the catalogue in Section 6.6.

The `create_domain` workflow contains the first backward step reference in the
system: step 3c uses `on_success: "step:3"` to loop back to the `edit_list`
gate after adding a table. This is supported by the existing Step Processor's
`resolveNextStep` logic via the `step:N` routing syntax.

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
    "description": "User reviews proposed table list. Child tables (FK references > 0) may be removed. Primary table cannot be removed. User may also add a child table.",
    "message_template": "Here's my plan for domain {{proposed_scaffold.domain}}. You can remove child tables you don't need, or add one that's missing.",
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
      { "label": "Looks good",   "action": "confirm",    "on_select": "next"    },
      { "label": "Add a table",  "action": "add_table",  "on_select": "step:3a" },
      { "label": "Cancel",       "action": "cancel",     "on_select": "cancel"  }
    ],
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "3a",
    "type": "human_gate",
    "gate_type": "text_input",
    "description": "User describes the table they want to add.",
    "message_template": "Describe the table you want to add — what it stores and how it relates to the other tables.",
    "options": [
      { "label": "Cancel", "action": "cancel", "on_select": "cancel" }
    ],
    "output_key": "new_table_description",
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "3b",
    "type": "llm_call",
    "description": "LLM designs the new table based on user description. Uses design_table prompt which receives domain name, existing table list (for FK context), and user description.",
    "input": {
      "prompt": "design_table",
      "domain": "{{proposed_scaffold.domain}}",
      "existing_tables": "{{proposed_scaffold.tables}}",
      "user_input": "{{new_table_description}}"
    },
    "output_key": "new_table",
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "3c",
    "type": "js_transform",
    "description": "Merge new table into proposed_scaffold.tables and enrich with columnSummary. on_success loops back to step 3 so the user sees the updated list.",
    "input_key": "proposed_scaffold.tables",
    "output_key": "proposed_scaffold.tables",
    "on_success": "step:3",
    "on_failure": "human_feedback"
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
    "type": "human_gate",
    "gate_type": "review_object",
    "description": "User reviews and confirms the proposed domain aliases and description before they are written to PGC_DomainHelp. Aliases drive Tier 1b intent matching — they must be human-approved.",
    "message_template": "Almost done. Here are the aliases and description I'll use so you can find this domain later. Edit them if needed.",
    "context_key": "proposed_scaffold.domainHelp",
    "options": [
      { "label": "Looks good", "action": "confirm", "on_select": "next"   },
      { "label": "Cancel",     "action": "cancel",  "on_select": "cancel" }
    ],
    "output_key": "confirmed_domain_help",
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "7",
    "type": "serv_insert",
    "description": "Register confirmed domain aliases and help text in PGC_DomainHelp.",
    "input": { "tableName": "PGC_DomainHelp", "row": "{{confirmed_domain_help}}" },
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "8",
    "type": "notify",
    "description": "Confirm domain creation to user.",
    "message_template": "Domain {{proposed_scaffold.domain}} is ready. {{created_tables_summary}}",
    "on_success": "end"
  },
  {
    "step": "9",
    "type": "end"
  }
]
```

#### Step numbering note

The current deployed `seed_PGC_Workflow.json` has 8 steps (steps 1–8). The revised
definition above has 9 main-path steps plus the 3-step add-table branch (3a, 3b, 3c).
After deploying the updated seed file, run `upsert-workflow.mjs create_domain` to
update the stored workflow. All existing WorkflowRun rows from before this change
reference step keys by string — they will continue to execute correctly against the
old step list until they complete.

#### Local state shape during execution

```json
{
  "input": { "userInput": "stock portfolio with price history" },
  "proposed_scaffold": {
    "domain": "stock_portfolio",
    "tables": [...],
    "domainHelp": { "domain": "stock_portfolio", "aliases": ["stocks", "portfolio", "holdings"], "description": "..." }
  },
  "new_table_description": "a table to track analyst ratings for each stock",
  "new_table": { "tableName": "PGD_AnalystRatings", ... },
  "created_tables": [...],
  "created_tables_summary": "PGD_Portfolios — created, PGD_Holdings — created ...",
  "confirmed_domain_help": { "domain": "stock_portfolio", "aliases": ["stocks", "portfolio"], "description": "..." }
}
```

### 6.9 create_workflow Workflow — Full Definition (Phase 2)

#### Overview

`create_workflow` allows a user to describe a workflow in natural language, review
and edit the proposed steps and intent keywords, and have the workflow stored in
`PGC_Workflow` and registered in `PGC_IntentMap` — making it immediately invocable
via `/mind` after creation.

The keyword review gate (step 3) is critical: it ensures the `intent_keywords` array
that drives Tier 1 sub-pass 2b (and immediately the `PGC_IntentMap` pattern row)
reflects what the user actually wants to say to invoke the workflow, not just what
the LLM guessed.

#### Bootstrap seeds required

**`PGC_Prompt` row:** `intent_category: 'create_workflow'` — LLM designs a full
workflow step array and proposes `intent_keywords`. Input variables: `userDescription`
(free text), `availableStepTypes` (injected from `PGC_StepType`). Returns
`{ workflowName, description, steps, intent_keywords }`. Validated by
`review-output.mjs` using the `workflow_steps` Ajv schema.

#### Declarative step definitions

```json
[
  {
    "step": "1",
    "type": "llm_call",
    "description": "LLM designs full workflow step array and proposes intent keywords.",
    "input": { "prompt": "create_workflow", "user_input": "{{input.userInput}}" },
    "output_key": "proposed_workflow",
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "2",
    "type": "human_gate",
    "gate_type": "edit_list",
    "description": "User reviews proposed workflow steps. Steps may be removed.",
    "message_template": "Here are the steps I propose for this workflow. Remove any that don't fit.",
    "context_key": "proposed_workflow.steps",
    "item_primary_key": "type",
    "item_secondary_key": "description",
    "item_action": {
      "condition": "true",
      "action": "remove_item",
      "action_data_key": "step",
      "confirm_template": "Remove step {{item.step}} ({{item.type}}) from this workflow?"
    },
    "options": [
      { "label": "Looks good", "action": "confirm", "on_select": "next"   },
      { "label": "Cancel",     "action": "cancel",  "on_select": "cancel" }
    ],
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "3",
    "type": "human_gate",
    "gate_type": "edit_list",
    "description": "User reviews proposed intent_keywords. These are the phrases that will trigger this workflow via /mind. User adds or removes keywords to match how they will naturally ask for this workflow.",
    "message_template": "These are the phrases that will invoke this workflow when you use /mind. Add or remove them so they match how you'll actually ask.",
    "context_key": "proposed_workflow.intent_keywords",
    "item_primary_key": "keyword",
    "item_action": {
      "condition": "true",
      "action": "remove_item",
      "action_data_key": "keyword",
      "confirm_template": "Remove keyword {{item.keyword}}?"
    },
    "options": [
      { "label": "Looks good", "action": "confirm", "on_select": "next"   },
      { "label": "Cancel",     "action": "cancel",  "on_select": "cancel" }
    ],
    "output_key": "confirmed_keywords",
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "4",
    "type": "human_gate",
    "gate_type": "confirm",
    "description": "Final confirmation before writing to PGC_Workflow and PGC_IntentMap.",
    "message_template": "Ready to save workflow {{proposed_workflow.workflowName}} with {{proposed_workflow.steps.length}} steps. Once saved, you can invoke it via /mind using the keywords you confirmed.",
    "options": [
      { "label": "Save it", "action": "confirm", "on_select": "next"   },
      { "label": "Cancel",  "action": "cancel",  "on_select": "cancel" }
    ],
    "on_success": "next",
    "on_failure": "cancel"
  },
  {
    "step": "5",
    "type": "serv_insert",
    "description": "Write confirmed workflow definition to PGC_Workflow.",
    "input": {
      "tableName": "PGC_Workflow",
      "row": {
        "name": "{{proposed_workflow.workflowName}}",
        "description": "{{proposed_workflow.description}}",
        "steps": "{{proposed_workflow.steps}}",
        "intent_keywords": "{{confirmed_keywords}}",
        "state_strategy": "sequential_with_confirmation"
      }
    },
    "output_key": "stored_workflow",
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "6",
    "type": "serv_insert",
    "description": "Write PGC_IntentMap row so Tier 1a pattern matching finds this workflow immediately.",
    "input": {
      "tableName": "PGC_IntentMap",
      "row": {
        "pattern": "{{proposed_workflow.intentPattern}}",
        "intent_category": "{{proposed_workflow.workflowName}}",
        "workflow_id": "{{stored_workflow.id}}",
        "action_type": "workflow"
      }
    },
    "on_success": "next",
    "on_failure": "human_feedback"
  },
  {
    "step": "7",
    "type": "notify",
    "description": "Tell user the workflow is live and which phrases will invoke it.",
    "message_template": "Workflow {{proposed_workflow.workflowName}} is live. Invoke it via /mind using phrases like: {{confirmed_keywords}}",
    "on_success": "end"
  },
  {
    "step": "8",
    "type": "end"
  }
]
```

---

### 6.10 Workflow Safety — Circuit Breakers and Emergency Shutdown

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
Workflow {{workflow_name}} was stopped — possible infinite loop detected.
{{steps_in_window}} steps executed in {{elapsed}}s with no human interaction.
Last step: {{last_step_description}}
[Show workflow definition]  [Delete this workflow]  [Dismiss]
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
Workflow {{workflow_name}} has been running for {{elapsed_minutes}} minutes.
Steps completed: {{step_count}} | Estimated cost: ~${{estimated_cost}}

Still going?
[Continue for another {{extension_minutes}} min]  [Stop now]  [Disable timer for this run]
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

**Note on intentional backward references:** The `create_domain` workflow uses
`on_success: "step:3"` on step 3c as a deliberate loop for the add-table flow.
The cycle detector must distinguish between intentional loops that pass through
a `human_gate` (safe — Guard 1 resets on every gate completion) and tight
computational loops with no gate. The rule: a backward reference is acceptable
if the path from the target step back to the backward reference contains at least
one `human_gate` step.

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
6. SlackbotFunction posts immediate confirmation to Slack

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

### 6.11 Right-Brain Output Validation — Repeat-Until-Correct Loop

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

Used for all `llm_call` steps that return structured JSON (e.g. `create_domain`, `design_table`).

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

**Rule 2 — upsert_key columns must have a matching UNIQUE constraint**

If the LLM populates `upsert_key` in `PGC_EntitySchema` with a column name, the same
column must appear in a `UNIQUE` constraint in the corresponding table's `constraints[]`.

**Rule 3 — Foreign key parent tables must exist in the same scaffold**

If a table references another table via a foreign key, the referenced table must either
exist in the current scaffold or already be registered in `PGC_Schema`. Cross-domain
foreign keys are not permitted — all tables in a domain are created together.

These rules apply equally to tables returned by the `design_table` prompt in the
add-table branch. The `review-output.mjs` semantic pass runs after every `llm_call`
step that produces table definitions, regardless of which prompt generated them.

**Enforcement model:**

These three rules fire as a named validation pass after Ajv, before any SERV call.
Failures use the same 2-attempt correction loop — errors are injected into the
correction prompt and logged to `PGC_Prompt.error_log` with
`"error_type": "semantic_validation"`.

#### Where this runs

Validation runs inside the Step Processor (`POST /proc/run-workflow`) immediately after
receiving LLM output, before writing to `local_state` or advancing the stack.
It is not a separate Lambda or endpoint — it is a synchronous in-process call
within the step execution loop.

#### Relationship to right-brain architecture

This section is the first concrete implementation of the right-brain feedback loop.
`PGC_Prompt.error_log` accumulates structured evidence of where each prompt fails.
A future `POST /proc/improve-prompt` endpoint reads this log and generates an improved
prompt version — the self-evolution loop.


---

### 6.12 UI Dialog Contract — WORKFLOW_GATE Message

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

**`style` hints are retained in the contract.**
`style: "primary" | "danger" | "default"` appears on buttons and per-row
actions. It is a semantic hint about visual weight and intent, not a Slack
colour instruction. Renderers are free to ignore it.

**`secondaryAction` is a single action per list item.**
One optional action per row. If multiple per-row actions are ever needed,
the renderer wraps them; the contract field becomes an array at that point
(Phase 3 decision).

**`confirm` is a plain string.**
A confirmation prompt before a destructive action. The renderer decides how
to present it.

**`step` keys in `PGC_Workflow.steps` are strings throughout.**
All step keys are strings: `"1"`, `"2"`, `"3"`, `"3a"`, `"3b"`, `"3c"`.
Stored as-is in the jsonb array; the Step Processor indexes by string key.

#### WORKFLOW_GATE SQS message

Enqueued by the Step Processor to `SYSSQSSlackResults` when a `human_gate`
step is reached. Consumed by `SlackCallbackListenerFunction` (`callback.mjs`).

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
```json
{ "type": "typography", "value": "Here's my plan for domain recipes." }
```

**`textbox`** — single-line free text input.
```json
{ "type": "textbox", "name": "table_description", "label": "Describe the new table", "placeholder": "e.g. stores daily stock prices", "required": true }
```

**`textarea`** — multi-line free text input.
```json
{ "type": "textarea", "name": "instructions", "label": "Cooking instructions", "required": false }
```

**`radio`** — mutually exclusive single selection from a fixed set.
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
`secondaryAction: null` means no action for this item — the renderer omits
the button entirely.

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
        "action": "remove_item",
        "label": "Remove",
        "style": "danger",
        "confirm": "Remove PGD_RecipeIngredients from this domain?"
      }
    }
  ]
}
```

**`actions`** — the form's submit/dismiss buttons. Always the last field in
`dialog.fields`.
```json
{
  "type": "actions",
  "buttons": [
    { "action": "confirm",   "label": "Looks good",  "style": "primary"  },
    { "action": "add_table", "label": "Add a table", "style": "default"  },
    { "action": "cancel",    "label": "Cancel",      "style": "default"  }
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

#### Primitive gate_type catalogue

Six primitive types cover all human interaction patterns:

| gate_type | Interaction | Dialog produced by Step Processor |
|---|---|---|
| `confirm` | Read a proposal, accept or reject | `typography` + `actions` |
| `select_one` | Pick exactly one item from a list | `typography` + `radio` or `select` + `actions` |
| `select_many` | Pick zero or more items | `typography` + `checkbox` + `actions` |
| `edit_list` | View a collection, optionally remove items, confirm, or branch | `typography` + `list` with per-row actions + `actions` |
| `text_input` | Provide free text | `typography` + `textbox` + `actions` |
| `review_object` | Review a structured summary, accept or reject | `typography` + structured summary + `actions` |

#### Data preparation pattern — js_transform before human_gate

`item_secondary_key` must be a real field on each item in the `context_key` array
at the time the gate executes. The Step Processor does a plain field lookup — no derivation.
Any `human_gate` that needs a derived display field must be preceded by a `js_transform`
that produces it.

#### Domain design constraint — primary table + child tables

When the LLM designs a new domain via `create_domain`, it must produce exactly
one primary (root) table with no foreign key references, and zero or more child
tables that reference the primary table via FK. Cross-domain foreign keys are
not permitted.

This constraint applies equally to tables added via the add-table branch. The
`design_table` prompt must produce a table that references the primary table via FK.
The semantic validation Rule 3 enforces this — a new table with no FK to any existing
scaffold table will fail validation.

#### Enforcement model — schema sources

All JSON Schema definitions used for LLM output validation are stored in
`PGC_Prompt.output_schema` alongside the prompt that produced them.

**Schema locations:**

| Schema | Lives in | Used by |
|---|---|---|
| `create_domain_scaffold` | `PGC_Prompt.output_schema` (intent: `create_domain`) | `review-output.mjs` after Step 1 `llm_call` |
| `design_table_scaffold` | `PGC_Prompt.output_schema` (intent: `design_table`) | `review-output.mjs` after Step 3b `llm_call` |
| `workflow_steps` | `PGC_Prompt.output_schema` (intent: `create_workflow`) | `review-output.mjs` after `create_workflow` LLM call |
| `merge_tables_scaffold` | `PGC_Prompt.output_schema` (intent: `merge_tables`) | `review-output.mjs` after merge LLM call |

---

### 6.13 Session Architecture — Conversational Memory (Phase 3)

#### Purpose

The session layer gives the brain persistent memory across multiple `/mind`
messages in the same Slack thread. Without it, each `/mind` call is cold —
the Intent Preprocessor has no knowledge of what the user was just doing.
With it, the brain can resolve ambiguous short-form inputs, pre-seed workflow
state with entities the user was already working on, and accumulate a factual
record of what happened in each thread — feeding the right-brain improvement loop.

The session layer is Phase 3. The Intent Preprocessor works without it. When it
lands, it does not change any workflow definitions or Step Processor contracts.
It is purely additive.

#### Session identity — UI-agnostic by design

A session is identified by a UUID (`session_id`) generated by `mind.mjs`, not
by `thread_ts`. `thread_ts` is stored inside `PGC_Session.callback.threadId` —
the same pattern as every other UI-specific routing field in the system. Adding
Teams or any other UI later requires zero schema changes.

**Session lookup flow in `mind.mjs`:**

```
thread_ts present in Slack event (reply in existing thread)?
  → getRows PGC_Session where callback->>'threadId' = thread_ts
      found   → retrieve session_id, include in CLASSIFY_INTENT SQS message
      not found → generate UUID, PROC creates PGC_Session row on receipt

thread_ts absent (fresh /mind, direct HTTP test call)
  → session_id omitted → PROC treats as sessionless
```

One `getRows` call to SERV — acceptable in the Experience tier within the Slack
3-second ACK window.

#### Session context injection into the Intent Preprocessor

When `classify-intent.mjs` receives a `CLASSIFY_INTENT` message that includes a
`session_id`, it performs one additional SERV read before running Tier 1c and Tier 2:

```
getRows PGC_SessionEntry
  filter: session_id = <id>
  orderBy: created_at DESC
  limit: 20  (configurable via PGC_SystemContext key 'chat_defaults')
```

The retrieved rows are assembled into a plain-text context block from their
`content` fields — most recent first. This block is used in two places:

**Tier 1c domain fallback:** If Pass 1b finds no alias token in the input text,
the preprocessor scans the session context for the most recently active domain.
"Add carbonara" resolves to `recipes` because the session shows the user was
just looking at recipes. Zero LLM cost.

**Tier 2 prompt injection:** The context block is prepended to the sonar
classification prompt. "Make that a three-course meal plan" becomes classifiable
as `meal_planner` because sonar sees the user has been working with recipes and
just added one. The domain hint from Pass 1b is also injected if available — sonar
only needs to classify the action, not re-identify the domain.

#### `referenced_entities` — pre-seeding workflow state

When Tier 2 classifies an intent in the context of a session, it returns an
optional `referenced_entities` field alongside the classification result —
e.g. `[{ entity: "Recipe", id: 42, name: "Carbonara" }]`. When the Step Processor
enqueues `WORKFLOW_STEP execute_top`, it pre-seeds `local_state.context` with
these entities. The workflow's first step has richer starting state without
requiring the user to re-specify what they were working on. Workflows that do not
use `local_state.context` are unaffected.

#### Step Processor — automatic session entry writes

The Step Processor writes `PGC_SessionEntry` rows automatically at two points.
No workflow definition changes are required. No new step types are added.

**At every `end` step (activity entry):**
The `notify` step that precedes `end` resolves a `message_template` into a plain
text string — the same string posted to the user in Slack. The Step Processor
reuses this resolved text as the `content` of a `PGC_SessionEntry` with
`entry_type: 'activity'`, `role: 'assistant'`, `workflow_run_id` populated. The
session gets a human-readable record of what the workflow accomplished at zero
extra LLM cost.

**At every `confirm` gate resolution (activity entry):**
When a `confirm` human gate resolves to `next`, the Step Processor writes an
activity entry: `"User confirmed: [resolved gate message]"`. This gives
subsequent LLM calls a factual record of what the user approved at each decision
point in any prior workflow.

**Conversational turns (`classify-intent.mjs`):**
One `message` entry for the user's input, one for the classification result or
workflow handoff summary. These are the conversational turns of the session —
distinct from activity entries written by the Step Processor.

#### Full example — recipes exploration → add → meal plan

```
Turn 1  /mind show me my pasta recipes
  Pass 1b: alias 'pasta' → domain 'recipes'
  Pass 1c: verb 'show' → serv_query ad_hoc_step built
  → WORKFLOW_NOTIFY (Phase 3 executes the query; returns Carbonara, Cacio e Pepe, Amatriciana)
  SessionEntry message/user:      "show me my pasta recipes"
  SessionEntry message/assistant: "Queried recipes — returned: Carbonara, Cacio e Pepe, Amatriciana"

Turn 2  /mind add carbonara with ingredients [...]   (reply in same thread)
  mind.mjs: finds session by thread_ts
  Pass 1b: no alias token in "add carbonara with ingredients" → fallback to session context
  Session context: most recent active domain = 'recipes' → domain resolved, zero LLM cost
  Pass 1c: verb 'add' → serv_insert ad_hoc_step built
  SessionEntry message/user:      "add carbonara with ingredients [...]"
  SessionEntry message/assistant: "Added recipe: Carbonara"

Turn 3  /mind make that a three-course meal plan using those recipes   (reply)
  mind.mjs: finds same session
  Pass 1a: no pattern match. Pass 1b: no alias. Pass 1c: no verb.
  Tier 2: sonar receives input + session context block (last 20 entries, plain text)
  sonar classifies: workflow_name = 'meal_planner'
                    referenced_entities = [{ entity:'Recipe', name:'Carbonara' }, ...]
  → enqueue WORKFLOW_STEP execute_top, local_state.context pre-seeded with referenced_entities
  meal_planner workflow runs with the recipes already in state — no re-specification needed
```

#### Session and the right-brain improvement loop

`PGC_SessionEntry` rows are structured evidence of where the brain succeeded and
failed. A future `POST /proc/improve-prompt` reads session history alongside
`PGC_Prompt.error_log` — looking for patterns such as: the user rephrased the
same intent three times before Tier 2 classified it correctly, or the domain was
resolved from session context 12 times this week rather than from explicit alias
tokens (a signal the alias list needs updating). The session layer is not just
memory for the user's benefit — it is training data for the brain's self-improvement.

**Connection to intent tuning surface (Section 4.3.3):**
When session evidence shows a domain is consistently resolved from context rather
than from Tier 1b alias matching, that is the signal to add missing aliases to
`PGC_DomainHelp`. The `/mind edit aliases for <domain>` management workflow
(Phase 2 item 4c) surfaces this directly: the user can inspect and update aliases
from within Slack without touching the database.

---

## 7. Tech Debt Register

| Item | Priority | Notes |
|---|---|---|
| Workflow safety guards (velocity detector, execution accumulator, cycle detector) | High | Required before Step Processor is production-ready — see Section 6.10. Right-brain can monitor `PGC_WorkflowStats` for anomalous run patterns and flag suspect workflows proactively |
| Semantic validation rules for create_domain scaffold | ~~High~~ | ✅ Implemented in `src/proc/review-output.mjs` — all three rules enforced in `runSemanticRules()` |
| `resume_gate` routes to HELP workflow only | ~~High~~ | ✅ Resolved — Step Processor dispatches generically via `run-workflow.mjs dispatchSqs()`. No per-workflow routing in handler |
| `create-domain.mjs` ignores scaffold from design-domain and calls LLM again | ~~High~~ | ✅ Resolved — Step Processor drives `create_domain` declaratively from `PGC_Workflow.steps` |
| Gate re-renders post new Slack messages instead of `chat.update` in-place | ~~Medium~~ | ✅ Resolved — `message_ts` threaded through SQS → `run-workflow.mjs` → `WORKFLOW_GATE` → `callback.mjs` `chat.update` |
| Duplicate domain detection — LLM runs every time | High | `/create-domain recipes` re-runs the LLM even if the domain already exists. Correct fix: add a `serv_query` pre-check step to `create_domain` workflow before the `llm_call` — blocked on `serv_query` step type (Phase 3) |
| `create_domain` prompt produces varying schemas across runs | Medium | LLM variance at `temperature: 0.2`. Correct fix: right-brain prompt evolution via `PGC_WorkflowStats` + `PGC_Prompt.error_log`. Do not invest in defensive patching before the feedback loop exists |
| `js_transform` built-in `columnSummary` only | Medium | Generic sandboxed JS (acorn AST gate + `vm.runInNewContext`) not implemented. All `js_transform` steps currently require a registered built-in. Blocked on Phase 3 JS sandbox |
| `PGC_WorkflowRunStep` idempotency uses `parseInt(stepNumber)` | Medium | String step keys like `"3b"` resolve to `0` — idempotency check will be incorrect when branch steps with string keys execute. Fix when `condition` step type is implemented or when the add-table branch is first tested |
| `created_tables_summary` hardcoded in iterator | Low | Iterator completion in `run-workflow.mjs` writes `created_tables_summary` via a domain-specific string. Should be generic — driven by step definition |
| `domain: null` on DDL-created tables | Medium | `PGC_Schema` and `PGC_TableMap` rows inserted by the DDL iterator have `domain: null`. Domain name needs to be threaded through `serv_schema` step input. Fix in next `create_domain` workflow version |
| `design-domain.mjs` dead code | Low | No longer receives traffic since Step Processor took over. Remove in next cleanup pass |
| `createTable` DDL + PGC_Schema insert not in a transaction | Medium | Physical table can exist without registry row on partial failure |
| Orphan table cleanup tooling | Low | Failed partial runs leave orphan tables in PGC_Schema — `delete-domain` covers full domains; per-table orphan cleanup is manual |
| AWS infrastructure cost — Bastion Host public IPv4 | Low | EC2 Bastion accrues ~$2.82/month in public IPv4 charges. Replace with AWS SSM Session Manager when promotional credits near exhaustion |
| W3C `traceparent` format for `traceId` | Low | Adopt `{version}-{traceId}-{parentId}-{flags}` when observability tooling added |
| `updateTable` ALTER TABLE | Medium | Currently metadata only — does not execute ALTER TABLE |
| Unit tests | Medium | Test pure functions first: `buildCreateTableSQL`, `validateCreatePayload`, `parseEvent`, `resolveTemplate`, `evalItemCondition`, `matchIntentMap`, `matchDomainAlias`, `matchCrudPattern`. Use `node:test` built-in |
| Integration tests | Low | Defer until intent pipeline complete — use `testcontainers` + PostgreSQL |
| CI/CD GitHub Actions | Low | Deliberately deferred until `template.yaml` stabilises |
| Dependency injection for DB clients | Medium | Needed for unit testability — clients currently instantiated at module level |
| PROC/SERV API Gateway resource policy | Medium | Restrict to AWS account-scoped requests before any public exposure — see Section 12.3 |
| Refactor `proc/create-domain.mjs` private `servFetch` + `callLlm` | ~~Low~~ | ✅ Resolved — extracted to `src/shared/serv-client.mjs` and `src/shared/llm-client.mjs` |
| `callback` routing pattern not enforced at compile time | Low | Every PROC endpoint reading callback from SQS must use `req.callback ?? req.body?.callback ?? null`. Currently convention only |
| Terraform state — legacy infrastructure | Low | Terraform config in `terraform-aws/` predates SAM migration. Check for orphaned AWS resources before decommissioning |
| Azure MSAL token utility (`src/lib/getAccessToken.js`) | Low | Vercel-era artifact. Assess for Teams Experience tier or decommission |
| `upsert-workflow.mjs` required on fresh deploys | Low | `init-brain` uses `ON CONFLICT DO NOTHING` — must run `upsert-workflow.mjs <name>` after any workflow step changes. Required after deploying the revised `create_domain` 9-step definition |
| `create_workflow` workflow steps empty | ~~Low~~ | Full step definition added in Section 6.9 — Phase 2 implementation item |
| Tier 1 sub-pass 2b — intent_keywords keyword scan | Low | After Pass 1b resolves a domain, scan `PGC_Workflow.intent_keywords` for workflows whose `domain` column matches. Zero LLM cost. Designed this session, deferred to Phase 3. Will be superseded by pgvector semantic search. `intent_keywords` column already exists on `PGC_Workflow` — no schema change needed |
| CRUD ad_hoc_step execution | Medium | `classify-intent.mjs` correctly classifies CRUD intents and builds `ad_hoc_step`. Execution requires `serv_query`, `serv_update`, `serv_delete` step types in `step-executor.mjs`. This is the same Phase 3 work as those step types — one combined item. When they land, both LLM-generated workflow steps and preprocessor ad_hoc_steps start working simultaneously |
| `design_table` prompt not yet seeded | High | Required by `create_domain` Step 3b (add-table branch). Must be added to `seed_PGC_Prompt.json` before the revised `create_domain` workflow is deployed. Blocked if missing |
| Guard 3 cycle detector — backward reference handling | Medium | Guard 3 must distinguish intentional gate-bounded loops (e.g. step 3c → step 3 in create_domain) from tight computational loops. Rule: a backward reference is safe if the path from target back to source contains at least one `human_gate` step |
| Session layer — PGC_Session + PGC_SessionEntry | Medium | Phase 3. Requires `PGC_WorkflowRun.session_id` FK column migration. `mind.mjs` session lookup via `getRows` on `callback.threadId`. Step Processor writes activity entries at `end` steps and `confirm` gate resolutions. `classify-intent.mjs` writes message entries. See Section 4.3.4 and 6.13 |
| `PGC_WorkflowRun.session_id` FK column | Medium | Phase 3 — add `session_id integer FK → PGC_Session.id nullable` to `PGC_WorkflowRun`. Required by session layer. Migration script needed — column did not exist at bootstrap |
| Alias management workflow `/mind edit aliases for <domain>` | Low | Phase 2 item 4c. Allows users to update `PGC_DomainHelp.aliases` from Slack without touching the DB. Until this exists, aliases must be updated via SERV table endpoint directly |
| Session context window size configurable | Low | `chat_defaults` key in `PGC_SystemContext` should define `session_context_limit` (default 20). Currently hardcoded in classify-intent.mjs spec — externalise when session layer is built |

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
| | — Tier 1: Pass 1a (PGC_IntentMap regex), Pass 1b (PGC_DomainHelp alias), Pass 1c (CRUD verb) | ✅ |
| | — Tier 2: perplexity/sonar via LLM_CHAT_URL, domain hint injection, prompt loaded from PGC_Prompt | ✅ |
| | — Tier 3: enqueue CREATE_DOMAIN / CREATE_WORKFLOW, WORKFLOW_NOTIFY for unknowns | ✅ |
| | — openapi.yaml v3.3.5: /ui/slack/mind and /proc/classify-intent | ✅ |
| | — Pass 1c PGC_Schema fallback when PGC_EntitySchema not populated | ✅ |
| | — /m alias wired to /mind in Slack app | ✅ |
| 4a | create_domain workflow revision | ⬜ |
| | — seed_PGC_Prompt.json: add design_table prompt | ⬜ |
| | — seed_PGC_Workflow.json: update create_domain to 9-step definition with add-table branch | ⬜ |
| | — step-executor.mjs: handle add_table action in edit_list resume_gate | ⬜ |
| | — step 6 review_object gate for aliases confirmation | ⬜ |
| | — run upsert-workflow.mjs create_domain after deploy | ⬜ |
| 4b | create_workflow workflow full implementation | ⬜ |
| | — seed_PGC_Prompt.json: add create_workflow prompt | ⬜ |
| | — seed_PGC_Workflow.json: update create_workflow from stub to 8-step definition (Section 6.9) | ⬜ |
| | — run upsert-workflow.mjs create_workflow after deploy | ⬜ |
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
| `serv_query` | ⬜ Phase 3 | Required for duplicate domain detection pre-check and CRUD ad_hoc_step execution |
| `serv_update` | ⬜ Phase 3 | |
| `serv_delete` | ⬜ Phase 3 | |
| `sub_workflow` | ⬜ Phase 3 | |
| `condition` | ⬜ Phase 3 | |
| `capability_call` | ⬜ Phase 3 | Not yet defined — see Section 15.1 |

**Gate types — implemented in `dialogToBlocks()` vs deferred:**

| Gate type | Status |
|---|---|
| `confirm` | ✅ live |
| `edit_list` | ✅ live — per-row Remove button, in-place `chat.update` re-render, Add table branch (Phase 2 item 4a) |
| `text_input` | ⬜ Phase 2 item 4a — needed for add-table branch step 3a |
| `review_object` | ⬜ Phase 2 item 4a — needed for aliases confirmation step 6 |
| `select_one` | ⬜ Phase 3 — `buildDialog()` stub exists |
| `select_many` | ⬜ Phase 3 — `buildDialog()` stub exists |

### Phase 3 — Deferred

| # | Task |
|---|---|
| 1 | SERV-Query — cross-entity parameterised SELECT with pagination |
| 2 | Generic `js_transform` sandbox — acorn AST gate + `vm.runInNewContext` |
| 3 | `serv_query`, `serv_update`, `serv_delete` step types — also enables CRUD ad_hoc_step execution from Intent Preprocessor |
| 4 | `sub_workflow` and `condition` step types |
| 5 | `capability_call` step type + External API Registry (Section 15.1) |
| 6 | Remaining gate types: `select_one`, `select_many` |
| 7 | pgvector semantic search — intent classification + prompt deduplication (Section 10) |
| 7a | Tier 1 sub-pass 2b — `PGC_Workflow.intent_keywords` keyword scan after domain alias match |
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
