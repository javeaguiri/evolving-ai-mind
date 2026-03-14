# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2  
Status: Active development — Phase 2 in progress  
Last updated: 2026-03-12

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

---

## 3. Lambda Architecture — Five Functions

| Function | Name | Trigger | Owns |
|---|---|---|---|
| SlackbotFunction | `evolving-mind-ai-slackbot` | API Gateway | `/api/v1/ui/slack/{proxy+}` |
| ProcFunction | `evolving-mind-ai-proc` | API Gateway | `/api/v1/proc/{proxy+}` |
| ServFunction | `evolving-mind-ai-serv` | API Gateway | `/api/v1/serv/{proxy+}` |
| SlackCallbackListenerFunction | `evolving-mind-ai-slack-callback-listener` | SQS SlackResultsQueue | Posts threaded Slack replies |
| ProcStepOrchestrator | `SYSLMBOrchestrator` | SQS WorkflowQueue | Workflow step execution |

### Route dispatch pattern — same in every Lambda

```
handler.mjs (entry point)
  → parseEvent() → normalised req object
  → segments = path.split('/').filter(Boolean)
  → req.subRoute = segments.pop()      // last segment
  → req.route    = segments.pop()      // second-to-last, falls back to subRoute
  → switch(req.route) → delegate to handler module
```

Handler modules receive the normalised `req` object and return API Gateway response objects directly.

---

## 4. Database Architecture

### Two separate PostgreSQL instances

| Instance | Purpose | Contains |
|---|---|---|
| PGC | Config / system tables | PGC_* tables — system metadata, workflow definitions, prompts |
| PGD | Domain / user data | PGD_* tables — user-created domain tables |

### Naming conventions

- System config tables: `PGC_*` (live in PGC database)
- User domain tables: `PGD_*` (live in PGD database)
- Table names are mixed case and MUST be quoted in SQL: `"PGC_Schema"`

### Bootstrap — `init-brain.mjs`

On every Lambda cold start, `bootstrap()` runs and is idempotent:
1. Install `set_updated_at()` trigger function on PGC
2. `CREATE TABLE IF NOT EXISTS` for all four PGC system tables (from imported JSON templates)
3. Seed self-referential rows into `PGC_Schema` (`ON CONFLICT DO NOTHING`)
4. Seed gatekeeper rows into `PGC_TableMap` (`ON CONFLICT DO NOTHING`)
5. Set `bootstrapComplete = true` — skipped on warm containers

Bootstrap template files live in `src/serv/templates/pgc/` and are imported as ES module static imports — NOT read via fs at runtime.

---

## 5. PGC System Tables — Current State (Bootstrapped)

### PGC_Schema
Registry of ALL table definitions — both system (PGC) and user domain (PGD).
Every table in the system has a row here including the system tables themselves (self-referential).

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

### PGC_TableMap
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

### PGC_EntitySchema
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

### PGC_DomainHelp
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

## 6. PGC Workflow Tables — Current State (Bootstrapped)

These four tables support the PROC layer workflow execution engine.

### PGC_Workflow
Stores reusable workflow definitions generated by LLM or created manually.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE | e.g. "deduct_inventory" |
| description | text | |
| intent_keywords | jsonb | For coded intent matching |
| intent_embedding | vector | For pgvector similarity matching (future) |
| steps | jsonb | Array of StepDefinition (see Section 9) |
| state_strategy | text | `fire_and_forget`, `sequential`, `sequential_with_confirmation` |
| confirmation_required_at | jsonb | Step indices requiring human gate |
| js_extensions | jsonb | Optional sandboxed JS for complex steps (Option C) |
| model_used | text | Which LLM generated this workflow |
| quality_score | numeric | Human or auto-rated |
| version | integer | |
| parent_workflow_id | integer FK | Self-referential — workflow evolution history |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### PGC_WorkflowRun
One row per workflow execution. Holds the execution stack and accumulated state.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| workflow_id | integer FK | → PGC_Workflow.id |
| status | text | `pending`, `running`, `awaiting_confirmation`, `awaiting_human_gate`, `completed`, `failed`, `cancelled` |
| input | jsonb | Original user intent + parameters |
| stack | jsonb | Execution stack — array of FrameDefinition (see Section 10) |
| output | jsonb | Final workflow output |
| callback | jsonb | Provider-agnostic UI callback — `{ provider, channel, threadId }` |
| error | jsonb | Last error details |
| started_at | timestamptz | |
| completed_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### PGC_WorkflowRunStep
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

### PGC_Prompt
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

### PGC_IntentMap
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

### PGC_WorkflowRunLock
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

## 7. SERV Layer — Implemented

### SERV-Schema (complete)
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

### SERV services — not yet built
- **SERV-Table** — INSERT/UPDATE/DELETE validated via PGC_TableMap
- **SERV-Query** — parameterised SELECT with filters, pagination
- **SERV-Entity** — multi-table jsonb_agg queries driven by PGC_EntitySchema

---

## 8. Callback / Notification Abstraction — DECISION PENDING IMPLEMENTATION

**Current state:** `slackChannel` and `slackThreadTs` are fields in SERV request bodies. This is a known tech debt.

**Agreed design (not yet implemented):**
- Remove `slackChannel` / `slackThreadTs` from all SERV request bodies
- Replace with generic `callback` object: `{ provider, channel, threadId }`
- `SlackCallbackListenerFunction` routes on `provider` field — today only `slack`, extensible to `teams`, `webhook`, etc.
- SERV passes `callback` through to SQS without interpreting it
- PROC owns callback routing — SERV is UI-agnostic

**Action required:** Implement before SERV-Table is built.

---

## 9. Step Definition Schema

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

## 10. Execution Stack — Frame Schema

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
  "correlationId": "uuid"
}
```

### Idempotency
Before executing any step, the Step Processor checks `PGC_WorkflowRunStep` for a row with the same `run_id`, `frame_id`, and `step_number`. If found, the step already ran (SQS redelivery) — skip execution, enqueue next message based on existing stack state.

---

## 11. PROC Layer — Intent Pipeline (Not Yet Built)

### Three-tier intent processing

```
User input
  │
  ▼
Tier 1 — Intent Preprocessor (coded logic first, cheap LLM second)
  │
  ├── Exact match in PGC_IntentMap         → load workflow → Step Processor
  ├── Simple CRUD pattern (coded logic)    → build ad-hoc step → Step Processor
  ├── Alias match in PGC_DomainHelp        → load workflow → Step Processor
  └── Novel / ambiguous intent             → cheap LLM classification
        └── suggestedWorkflow exists       → load workflow → Step Processor
        └── requiresHeavyLift: true        → Heavy Lift LLM
              └── create domain/workflow   → SERV-Schema → Step Processor
  │
  ▼
Step Processor (SQS-driven, one Lambda invocation per stack frame operation)
  │
  ├── serv_* steps     → ServFunction direct invoke
  ├── llm_call steps   → LLM provider (model from PGC_Prompt)
  ├── sub_workflow     → push frame, enqueue execute_top
  ├── human_gate       → Slack interactive, suspend
  ├── js_transform     → sandboxed JS (security gate required)
  └── notify           → SQS SlackResults
```

### LLM model selection — coded logic

| Task | Model | Reason |
|---|---|---|
| Intent classification | Claude Haiku / GPT-4o-mini | Fast, cheap, structured JSON output |
| Simple workflow generation | Claude Sonnet | Good reasoning, moderate cost |
| Complex schema / domain generation | Claude Opus / GPT-4o | Best reasoning for novel domains |
| Prompt improvement | Claude Sonnet | Good at meta-reasoning |
| Error analysis | Claude Sonnet | Good at debugging |

Model selection is coded logic based on task category, stored in `PGC_Prompt.model` per prompt record.

---

## 12. Workflow as Code — Option C (Hybrid)

Decision: Declarative JSON steps for common operations, sandboxed JS only for complex transformations.

- 95% of workflows: declarative step types (`serv_query`, `serv_update`, `notify`, etc.)
- Complex transformations: `js_transform` step with security gate before `new Function()` execution
- Security gate for `js_transform`: static analysis, AST inspection, whitelist of allowed operations
- All JS workflows stored in `PGC_Workflow.js_extensions` — never executed without gate check

---

## 13. Human-in-the-Loop — Two Gates

### Confirmation gate (destructive operations)
```
⚠️ You are about to drop table PGD_Recipes and all its data.
This cannot be undone.
[Confirm] [Cancel]
```
Implemented as Slack interactive message. Stack pauses at `human_gate` frame with `status: awaiting_human_gate`. Requires `/interactive` endpoint on SlackbotFunction (not yet built).

### Error recovery gate
```
⚠️ Step 3 of "deduct_inventory" failed.
Error: Column "quantity" not found in PGD_Inventory.

I can:
[A] Fix the schema    [B] Fix the data    [C] Skip step    [D] Cancel
```
Each response maps to a stack operation:
- A → push `fix_schema` sub-workflow frame
- B → push `fix_data` sub-workflow frame
- C → pop failed frame, advance
- D → clear stack, set status=cancelled

---

## 14. Parallel Execution — Deferred, Hooks Only

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

---

## 15. Tech Debt Register

| Item | Priority | Notes |
|---|---|---|
| Callback abstraction | High | Remove `slackChannel`/`slackThreadTs` from SERV bodies, replace with `{ provider, channel, threadId }` |
| Unit tests | Medium | Test pure functions first: `buildCreateTableSQL`, `validateCreatePayload`, `parseEvent`. Use `node:test` built-in |
| Integration tests | Low | Defer until PROC/Schema complete — use `testcontainers` + PostgreSQL |
| `updateTable` ALTER TABLE | Medium | Currently metadata only — does not execute ALTER TABLE |
| pgvector for intent matching | Low | Add to RDS when similarity search is needed |
| Slack `/interactive` endpoint | High | Required for human gates — needed before Step Processor is complete |
| CI/CD GitHub Actions | Low | Deliberately deferred until template.yaml stabilises |
| Dependency injection for DB clients | Medium | Needed for unit testability — clients currently instantiated at module level |

---

## 16. Completed Milestones

| Tag | What was completed |
|---|---|
| `v3.2-scaffolding-complete` | All 5 pings pass (ping-api, ping-llm, ping-sqs, ping-db, ping-e2e) |
| `v3.2-ping-complete` | ping-sqs threading fixed, ping-e2e full round trip with RDS version string |
| `v3.2-serv-schema-complete` | SERV-Schema all CRUD endpoints, init-brain bootstrap, 4 PGC system tables |

---

## 17. Build Order — Remaining Work


1. Callback abstraction              implement provider-agnostic callback in SERV
2. PGC workflow table templates      JSON templates + bootstrap for 6 new PGC tables
3. PROC — Intent Preprocessor        coded logic + cheap LLM classification
4. PROC — /create-domain             Slack → LLM → SERV-Schema → domain tables
5. Slack /interactive endpoint        human gates (confirmation + error recovery)
6. PROC — Step Processor             SQS-driven stack execution engine
7. SERV-Table                        INSERT/UPDATE/DELETE validated via PGC_TableMap
8. SERV-Query                        parameterised SELECT with filters, pagination
9. SERV-Entity                       multi-table jsonb_agg via PGC_EntitySchema
10. Parallel execution               fan-out/fan-in, optimistic locking (future)
11. Unit + integration tests         node:test for pure functions, testcontainers for DB
12. CI/CD GitHub Actions             after template.yaml stabilises

## 18. pgvector — Semantic Search

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