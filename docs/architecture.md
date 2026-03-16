# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2  
Status: Active development — Phase 3 next  
Last updated: 2026-03-15

---

## 1. System Purpose

A self-evolving, low-cost cognitive automation brain that:
- Accepts natural language intent from users via Slack (or any UI)
- Uses LLM sparingly — only for novel intents, workflow generation, and schema creation
- Persists generated workflows in PostgreSQL and reuses them — LLM is not called twice for the same problem
- Evolves its own workflows and schemas over time
- Runs at ~$0.03–$0.05/month — 95% of operations are Lambda + PostgreSQL with zero LLM cost

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

### Three-tier architecture — Mulesoft model

The system follows a strict three-tier separation inspired by Mulesoft's API-led connectivity.
The system is designed for household-scale private deployment — PII is segmented per instance,
not shared across users of a multi-tenant service.

**Experience tier** (`SlackbotFunction`, `SlackCallbackListenerFunction`)
- Owned by UI concerns — Slack parsing, ACK messages, thread formatting
- Never contains business logic
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

**SQS listener** (`SlackCallbackListenerFunction`)
- AWS + Slack specific — contains ONLY AWS SDK + Slack SDK code
- Routes on `callback.provider` — adding a new UI is one new `case`
- Cloud portability: replacing AWS SQS with Azure Service Bus only touches this file

### Route dispatch pattern

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

### Directory structure and file partitioning rules

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

### File partitioning rules — where does new code go?

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

**When adding a new PROC endpoint:**
1. Create `src/proc/<endpoint-name>.mjs` — export `handle(req)`
2. Add `case '<endpoint-name>': return handle(req)` to HTTP switch in `handler.mjs`
3. Add `case '<SQS_MESSAGE_TYPE>': return handle(buildReq(message))` to SQS switch
4. Document in `openapi.yaml` spec-first
5. Never import AWS SDK in the endpoint module
```

### Transport-agnostic endpoint pattern — IMPORTANT

`ProcFunction` endpoint modules are called identically whether the request
arrived via HTTP (API Gateway) or SQS (WorkflowQueue). This is the core of
the Mulesoft process tier principle — business logic is transport-agnostic.

**How it works:**

`processSqsBatch` builds the same normalised `req` object that `parseEvent`
builds from HTTP events. The endpoint module receives identical input either way:

```js
// HTTP delivery
POST /api/v1/proc/create-domain  { userInput: 'stock portfolio' }
  → parseEvent(event)  → req = { route: 'create-domain', body: { userInput }, source: 'http', ... }
  → createDomain(req)

// SQS delivery
{ type: 'CREATE_DOMAIN', userInput: 'stock portfolio', callback: {...}, traceId: '...' }
  → buildReqFromSqs(record) → req = { route: 'create-domain', body: { userInput }, source: 'sqs', callback, traceId, ... }
  → createDomain(req)
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
  return { batchItemFailures: [] };          // SQS success — no retry
}
```

This pattern means every PROC endpoint is:
- **Directly testable via curl** — no SQS, no Slack required
- **Callable from Slack** — via SQS async path
- **Cloud-agnostic** — no AWS SDK in the endpoint module itself
- **Single source of truth** — one function, two transports, identical business logic

---

## 4. Data Architecture

### 4.1 Two PostgreSQL Instances

| Instance | Purpose | Contains |
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

#### PGC_Schema
Registry of ALL table definitions — both system (PGC) and user domain (PGD).
Every table in the system has a row here including the system tables themselves.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| table_name | text UNIQUE | Quoted in SQL |
| target | text | `pgc` or `pgd` |
| description | text | |
| columns | jsonb | Array of ColumnDefinition |
| foreign_keys | jsonb | Array of ForeignKeyDefinition |
| constraints | jsonb | Array of ConstraintDefinition |
| triggers | jsonb | Array of TriggerDefinition |
| created_at | timestamptz | |
| updated_at | timestamptz | Auto-updated by trigger |

#### PGC_TableMap
SERV-Table security gatekeeper. SERV-Table rejects writes to any table not registered here.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| table_name | text UNIQUE | |
| target | text | `pgc` or `pgd` |
| schema_id | integer FK | → PGC_Schema.id, ON DELETE RESTRICT |
| allow_insert | boolean | Default true |
| allow_update | boolean | Default true |
| allow_delete | boolean | Default false |
| views | jsonb | SQL view definitions |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### PGC_EntitySchema
Defines business entities that span multiple PGD tables.
SERV-Entity reads this to build `jsonb_agg` queries.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| entity_name | text UNIQUE | e.g. "Recipe" |
| description | text | |
| root_table | text | Primary table for the entity |
| joins | jsonb | Array of join definitions |
| aggregations | jsonb | Array of jsonb_agg definitions |
| filters | jsonb | Available filter parameters |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### PGC_DomainHelp
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

### 4.4 PGC Workflow Tables

These tables support the PROC layer workflow execution engine.

#### PGC_Workflow
Stores reusable workflow definitions generated by LLM or created manually.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE | e.g. "create_domain", "deduct_inventory" |
| description | text | |
| intent_keywords | jsonb | For coded intent matching |
| intent_embedding | vector | For pgvector similarity matching (future) |
| steps | jsonb | Array of StepDefinition |
| state_strategy | text | `fire_and_forget`, `sequential`, `sequential_with_confirmation` |
| confirmation_required_at | jsonb | Step indices requiring human gate |
| js_extensions | jsonb | Optional sandboxed JS for complex steps |
| model_used | text | Which LLM generated this workflow |
| quality_score | numeric | Human or auto-rated |
| version | integer | |
| parent_workflow_id | integer FK | Self-referential — workflow evolution history |
| max_execution_ms | integer | Execution accumulator ceiling. NULL = no limit |
| max_steps_per_window | integer | Velocity detector threshold. Default 20 |
| window_seconds | integer | Velocity detector window in seconds. Default 10 |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### PGC_WorkflowRun
One row per workflow execution. Holds the execution stack and accumulated state.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| workflow_id | integer FK | → PGC_Workflow.id |
| status | text | `pending`, `running`, `awaiting_confirmation`, `awaiting_human_gate`, `completed`, `failed`, `cancelled` |
| input | jsonb | Original user intent + parameters |
| stack | jsonb | Execution stack — array of FrameDefinition |
| output | jsonb | Final workflow output |
| callback | jsonb | Provider-agnostic UI callback — `{ provider, channel, threadId }` |
| error | jsonb | Last error details |
| total_execution_ms | integer | Running sum of all step duration_ms — feeds execution accumulator |
| step_count | integer | Total steps executed this run — incremented on every step |
| steps_in_window | integer | Steps since last human_gate — reset on human_gate — feeds velocity detector |
| window_started_at | timestamptz | When current velocity window started |
| started_at | timestamptz | |
| completed_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### PGC_WorkflowRunStep
Append-only audit log — one row per step execution. Never updated after insert.
Used for idempotency checks on SQS redelivery and debugging.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| run_id | integer FK | → PGC_WorkflowRun.id |
| frame_id | text | UUID of the frame that executed |
| step_number | integer | |
| step_type | text | |
| status | text | `completed`, `failed`, `skipped` |
| input_snapshot | jsonb | What was passed in |
| output_snapshot | jsonb | What came out |
| error | jsonb | Error details if failed |
| duration_ms | integer | |
| executed_at | timestamptz | |

#### PGC_Prompt
Stores LLM prompts with versioning and quality tracking for self-improvement.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| intent_category | text | e.g. "create_domain", "deduct_inventory" |
| prompt_text | text | Actual prompt sent to LLM |
| model | text | Which LLM was used |
| version | integer | |
| parent_prompt_id | integer FK | Self-referential — prompt evolution history |
| was_successful | boolean | |
| quality_score | numeric | |
| error_log | jsonb | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

#### PGC_IntentMap
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

#### PGC_WorkflowRunLock
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

### 5.2 SERV-Table (partial — getRows + insertRow complete)
DML executor gated by PGC_TableMap.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/table/getRows` | POST | Parameterised SELECT — filters, orderBy, limit — gated by PGC_TableMap |
| `/api/v1/serv/table/insertRow` | POST | Single INSERT RETURNING * — gated by allow_insert |

Security gate on all operations:
- Table must be registered in PGC_TableMap
- Column names validated against PGC_Schema columns for that table
- Filter operators validated against whitelist (eq, neq, gt, gte, lt, lte, like, in, is_null, not_null)
- `insertRow` additionally checks `allow_insert = true`

### 5.3 SERV services — not yet built
- **SERV-Table** updateRow, deleteRow — deferred, not needed until Phase 3
- **SERV-Query** — parameterised SELECT with joins, pagination
- **SERV-Entity** — multi-table jsonb_agg queries driven by PGC_EntitySchema

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
```

### Step types

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

---

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

**Action:** Kill immediately. Set `PGC_WorkflowRun.status = 'failed'`. Post to Slack:

```
⚠️ Workflow *{{workflow_name}}* was stopped — possible infinite loop detected.

{{step_count}} steps executed in {{window_seconds}}s with no human interaction.
Last step: {{last_step_description}}

[🔍 Show workflow definition]  [🗑️ Delete this workflow]  [❌ Dismiss]
```

**Defaults:** `max_steps_per_window: 20`, `window_seconds: 10`
Configurable per workflow in `PGC_Workflow.max_steps_per_window`.

#### Guard 2 — Execution accumulator (runtime, pauses run)

Monitors total Lambda execution time across all steps of a run.
Designed to handle legitimately long workflows — pauses rather than kills.

**Trigger:** `PGC_WorkflowRun.total_execution_ms` exceeds `PGC_Workflow.max_execution_ms`.

**How it works:** Every step writes a `PGC_WorkflowRunStep` row with `duration_ms`.
The Step Processor adds that value to `PGC_WorkflowRun.total_execution_ms` in the
same UPDATE — no extra DB round-trip. Check runs before enqueuing the next step.

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

**Defaults:** `max_execution_ms: 300000` (5 minutes), `extension_minutes: 5`
Configurable per workflow in `PGC_Workflow.max_execution_ms`.
Cost estimate uses the usage data already returned by the Perplexity Agent API response.

#### Guard 3 — Cycle detector (static, rejects workflow at store time)

Validates the step graph for structural cycles before a workflow is stored in `PGC_Workflow`.
Runs once at creation — zero runtime cost.

**How it works:** Traverse all `on_success`, `on_failure`, `on_select` routing values.
Build a directed graph of step → step edges. Run DFS cycle detection.
If a cycle is found, reject the `INSERT` into `PGC_Workflow` with a descriptive error.

**Limitation:** Cannot catch dynamic routing loops (where routing depends on runtime
local_state values). Those are caught by Guard 1 at runtime.

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

Any in-flight steps will be discarded on next execution.
```

If no active workflows exist:
```
✅ No active workflows to cancel.
```

**Step Processor cancellation check:**
Before executing any step, the Step Processor reads `PGC_WorkflowRun.status`.
If `cancelled` → discard SQS message (return success to avoid retry), do not execute.
This check already exists for idempotency — cancellation reuses the same path.

#### Schema additions required

**`PGC_WorkflowRun` — new columns:**

| Column | Type | Notes |
|---|---|---|
| `total_execution_ms` | integer | Running sum of all step `duration_ms` values |
| `step_count` | integer | Total steps executed — incremented on every step |
| `steps_in_window` | integer | Steps since last human gate — reset on human_gate step |
| `window_started_at` | timestamptz | Timestamp when current velocity window started |

**`PGC_Workflow` — new columns:**

| Column | Type | Notes |
|---|---|---|
| `max_execution_ms` | integer | Execution accumulator ceiling. NULL = no limit |
| `max_steps_per_window` | integer | Velocity detector threshold. Default 20 |
| `window_seconds` | integer | Velocity detector window. Default 10 |

---

## 7. Tech Debt Register

| Item | Priority | Notes |
|---|---|---|
| Workflow safety guards (velocity detector, execution accumulator, cycle detector) | High | Required before Step Processor is production-ready — see Section 6.9 |
| `/shutdown` Slack command | High | Emergency stop for all active workflow runs — see Section 6.9 |
| `PGC_WorkflowRun` missing safety columns | High | `total_execution_ms`, `step_count`, `steps_in_window`, `window_started_at` need adding to JSON template and bootstrap |
| `PGC_Workflow` missing safety limit columns | High | `max_execution_ms`, `max_steps_per_window`, `window_seconds` need adding to JSON template and bootstrap |
| Rename `workflowId` → `traceId` in all SQS payloads and UI messages | Medium | `workflowId` confused with PGC_WorkflowRun concepts — `traceId` is accurate today |
| W3C `traceparent` format for `traceId` | Low | Adopt `{version}-{traceId}-{parentId}-{flags}` when observability tooling added |
| Extract workflow logic to `shared/domain-workflows.mjs` | Medium | Enables PROC HTTP endpoints + removes future hop — see Section 19 |
| LLM URLs to env vars (`LLM_AGENT_URL`, `LLM_CHAT_URL`) | Medium | Before Phase 3 — avoids redeploy on provider change — see Section 19 |
| `createTable` DDL + PGC_Schema insert not in a transaction | Medium | Physical table can exist without registry row on partial failure |
| FK + constraint normalisation belongs in `schema.mjs` | Medium | Currently normalised in `step-orchestrator.mjs` — fragile, wrong layer |
| `response_format json_schema` removed from Agent API call | Medium | Stripped due to 400 error — revisit, schema enforcement is more reliable than prompt |
| `PGC_Prompt` seeds not in bootstrap | High | Manual migration scripts — stack rebuild loses prompts silently. Move to `init-brain.mjs` or add runbook |
| `.env.local` Windows `\r` line ending issue | Low | `--env-file` fails with CRLF on Windows — document workaround (`set VAR=...`) |
| Orphan table cleanup tooling | Low | Failed partial runs leave orphan tables in PGC_Schema — only manual `deleteTable` today |
| Domain creation review gate | High | LLM schema proposed but not confirmed before DDL — see Section 13 Gate 1 |
| Slack `/interactive` endpoint | High | Required for all human gates — needed before Step Processor and domain review |
| Remove `ProcStepOrchestrator` Lambda + add SQS trigger to `ProcFunction` | High | Eliminates hop, reduces cold start surface — see Section 11 |
| `step-orchestrator.mjs` business logic moves to `ProcFunction` HTTP endpoints | High | Currently handleCreateDomain + callLlm live in wrong layer — see Section 11 |
| `invokeServ` uses Lambda invoke not HTTP fetch | High | Should be HTTP fetch to API Gateway for cloud portability — see Section 11 |
| Unit tests | Medium | Test pure functions first: `buildCreateTableSQL`, `validateCreatePayload`, `parseEvent`. Use `node:test` built-in |
| Integration tests | Low | Defer until PROC/Schema complete — use `testcontainers` + PostgreSQL |
| `updateTable` ALTER TABLE | Medium | Currently metadata only — does not execute ALTER TABLE |
| pgvector for intent matching | Low | Add to RDS when similarity search is needed |
| CI/CD GitHub Actions | Low | Deliberately deferred until template.yaml stabilises |
| Dependency injection for DB clients | Medium | Needed for unit testability — clients currently instantiated at module level |

---

## 8. Completed Milestones

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

---

## 9. Build Order — Remaining Work

~~1. Callback abstraction~~              ✅ complete — v3.2-callback-abstraction-complete
~~2. PGC workflow table templates~~      ✅ complete — v3.2-pgc-workflow-tables-complete
~~3. PROC — /create-domain (Phase 2b)~~ ✅ complete — v3.2-create-domain-scaffold
~~4. PROC — /create-domain (Phase 2c)~~ ✅ complete — v3.2-create-domain-live-llm
~~7. SERV-Table (getRows + insertRow)~~  ✅ complete — v3.2-serv-table-partial

1. Refactoring (tech debt — do before anything else)
   - remove `ProcStepOrchestrator` (`SYSLMBOrchestrator`) from `template.yaml`
   - add SQS WorkflowQueue trigger to `ProcFunction` in `template.yaml`
   - move all logic from `step-orchestrator.mjs` into `ProcFunction` as HTTP endpoints
   - delete `step-orchestrator.mjs`
   - replace `invokeServ` Lambda invoke with HTTP fetch to API Gateway
   - rename `ping-utils.mjs` → `lambda-utils.mjs`
   - add `SERV_API_URL`, `LLM_AGENT_URL`, `LLM_CHAT_URL` to SSM + template.yaml env vars
   - move `PGC_Prompt`, `PGC_Workflow`, `PGC_IntentMap` seeds into `init-brain.mjs` bootstrap
   - move FK + constraint normalisation from proc layer into `schema.mjs`
   - rename `workflowId` → `traceId` in all SQS payloads and UI messages
   - add `response_format json_schema` back to Agent API call

2. Slack `/interactive` endpoint        required for all human gates + domain review
3. `/shutdown` Slack command            emergency stop — ProcFunction + SlackbotFunction
4. Domain creation review gate          DESIGN_DOMAIN → Slack review → CREATE_DOMAIN (Section 6.6)
5. PROC — Intent Preprocessor           coded logic + cheap LLM classification
6. PROC — Step Processor                SQS-driven stack execution, full PGC_WorkflowRun lifecycle
   — include velocity detector, execution accumulator, cycle detector (Section 6.9)
7. SERV-Table updateRow/deleteRow       deferred until Phase 3 needs them
7. SERV-Query                           parameterised SELECT with joins, pagination
8. SERV-Entity                          multi-table jsonb_agg via PGC_EntitySchema
9. Parallel execution                   fan-out/fan-in, optimistic locking (future)
10. Unit + integration tests            node:test for pure functions, testcontainers for DB
11. CI/CD GitHub Actions                after template.yaml stabilises

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

## 11. Refactoring Decisions

### Target architecture — four Lambdas, dual-trigger ProcFunction

All items below are deferred to the refactoring commit (Build Order item 1).

**`ProcStepOrchestrator` eliminated**

`SYSLMBOrchestrator` is removed from `template.yaml` entirely.
`ProcFunction` gains a second SQS event trigger on `WorkflowQueue`.
`handler.mjs` in PROC detects event type and routes accordingly:
```js
if (event.Records)    → SQS path → processWorkflowMessage(record)
if (event.httpMethod) → HTTP path → switch(req.route)
```
All workflow logic currently in `step-orchestrator.mjs` moves into `ProcFunction`
as HTTP endpoints. `step-orchestrator.mjs` is deleted.

**`ProcFunction` — all business logic, cloud-agnostic**

All workflow logic moves from `step-orchestrator.mjs` into `ProcFunction` endpoints:

| Endpoint | Description |
|---|---|
| `POST /proc/design-domain` | Call LLM, return proposed scaffold — no DB writes |
| `POST /proc/create-domain` | Accept confirmed scaffold, create tables, insert DomainHelp |
| `POST /proc/classify-intent` | Intent Preprocessor — coded logic + cheap LLM |
| `POST /proc/run-workflow` | Step Processor — execute top frame of PGC_WorkflowRun stack |
| `POST /proc/improve-prompt` | Prompt evolution — update PGC_Prompt with new version |

No AWS SDK imports in the process tier. All external calls via HTTP fetch:
- SERV: `fetch(process.env.SERV_API_URL + '/serv/table/getRows', ...)`
- LLM: `fetch(process.env.LLM_AGENT_URL, ...)`

**`invokeServ` → HTTP fetch**

Current: `lambda.send(new InvokeCommand({ FunctionName: SERV_FUNCTION_NAME, ... }))`
Target: `fetch(process.env.SERV_API_URL + path, { method, body })`

Why API Gateway HTTP instead of direct Lambda invoke:
- **Contract enforcement** — PROC endpoints are versioned and documented in `openapi.yaml`
- **Cloud portability** — `fetch(apiGatewayUrl)` works on any cloud. Lambda invoke is AWS-only
- **Testability** — curl works against API Gateway without AWS credentials
- **Latency is not a concern** — traffic stays on AWS internal backbone within us-east-2

### Rename `shared/ping-utils.mjs` → `shared/lambda-utils.mjs`

Pure rename — no logic changes. Touches all files importing from `ping-utils.mjs`:
`ping-db.mjs`, `schema.mjs`, `table.mjs`, `ping.mjs`, `ping-sqs.mjs`, `ping-e2e.mjs`,
`ping-llm.mjs` (both PROC and slackbot), `create-domain.mjs`, and both `handler.mjs` files.

### Environment variables to add

```yaml
LLM_AGENT_URL:  'https://api.perplexity.ai/v1/agent'
LLM_CHAT_URL:   'https://api.perplexity.ai/chat/completions'
SERV_API_URL:   'https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod'
```