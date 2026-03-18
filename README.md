# evolving-mind-ai

> A self-evolving, low-cost cognitive automation brain — v3.2

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![AWS SAM](https://img.shields.io/badge/infra-AWS%20SAM-orange)](https://docs.aws.amazon.com/serverless-application-model/)
[![Node.js 22](https://img.shields.io/badge/runtime-Node.js%2022%20ESM-green)](https://nodejs.org/)

---

## What Is evolving-mind?

evolving-mind is a serverless cognitive automation system that accepts natural language intent from users — via Slack today, and any UI tomorrow — and turns that intent into persistent, reusable, self-improving workflows.

The design philosophy is strict: **LLMs are used sparingly.** Once a workflow is generated, it is stored in PostgreSQL and reused forever. The system costs approximately **$0.03–$0.05 per month** in AWS infrastructure because 95% of all operations are Lambda + PostgreSQL with zero LLM calls. LLMs are only invoked for genuinely novel problems.

Over time the brain becomes smarter. It generates new schemas, new workflows, new prompts — and records the quality of its own outputs so it can improve them. This is what makes it self-evolving.

---

## The Left Brain and the Right Brain

The system is designed around two complementary modes of reasoning that must work together. Neither is sufficient alone.

### Left Brain — Structured, Logical, Language-Driven
The left brain is what we are currently building:

- Natural language → intent → workflow → data
- Self-generating database schemas and table definitions
- Persistent workflow definitions with step-by-step execution
- Human-in-the-loop gates for confirmation and error recovery
- LLM-assisted prompt evolution and quality scoring

The left brain is deterministic by design. It stores everything in PostgreSQL. It reuses what it knows. It costs almost nothing per operation.

### Right Brain — Creative, Associative, Self-Correcting
The right brain is designed but not yet built. It is not simply "more features" — it is the feedback and reasoning layer that makes the left brain reliable:

- **Output validation** — reviews LLM-generated schemas, workflows, and prompts before they are stored or executed. Catches structural errors, ambiguity, and drift from the system's own rules.
- **Self-correction** — when the left brain produces malformed output (wrong FK shape, invalid column types, schema contradictions), the right brain reasons about the error and corrects it — not with a regex, but with genuine understanding.
- **Pattern recognition** — identifies when a new user intent is semantically similar to an existing workflow even when the wording is completely different.
- **Prompt evolution** — analyses `PGC_Prompt.error_log` and `output_sample` to suggest prompt improvements. The left brain stores what happened; the right brain understands why and what to change.
- **Analogy and ideation** — when asked to design a new domain, the right brain draws on knowledge of existing domains to propose better schema structures than a left-brain-only LLM call would produce.

**The critical insight:** Many "code problems" we encounter today — FK normalisation, JSON schema enforcement, defensive validation — are symptoms of the left brain working without the right brain. The correct fix is not more defensive code. It is building the feedback loop between the two sides so the system can reason about and correct its own outputs.

The scaffolding for this feedback loop is already in the schema:
- `PGC_Prompt.input_variables` — documents what the prompt expects
- `PGC_Prompt.output_schema` — the expected JSON shape of a correct LLM response
- `PGC_Prompt.output_sample` — a representative successful output for regression checking
- `PGC_Prompt.error_log` — structured error history: `{ attempts: [{ at, error_type, error_message, llm_raw_output, recovery_action }] }`
- `PGC_WorkflowRunStep` — append-only audit log of every step execution

These fields exist precisely so the right brain has the data it needs to reason about quality and improvement.

---

## What Can evolving-mind Create?

When a user types a natural language command into Slack, the evolving mind can:

- **Create new user domains on demand** — e.g., `/create-domain recipes` causes the brain to design a full relational schema, generate the tables in PostgreSQL, register all metadata, and immediately make the domain available for data entry and query — with zero manual coding.

- **Built-in domain examples:**
  - 🍳 **Recipes** — ingredients, instructions, nutritional data, tags
  - 📦 **Inventory** — items, quantities, locations, reorder levels
  - 📈 **Stock Portfolios** — holdings, lots, prices, performance tracking
  - 🎓 **Teaching Tools** — flashcard decks, practice drills, quiz scoring, spaced repetition
  - 🏆 **Sports & Entertainment** — standings, schedules, player stats, watchlists
  - 🎯 Any domain the user can describe in plain language

- **Self-aware domain management** — the brain knows which domains it has already built (via `PGC_Schema` and `PGC_DomainHelp`), can answer `/help recipes`, list available commands, and evolve the schema when needs change.

---

## How the Brain Thinks — Intent Pipeline

```
User (Slack): "add 3 cans of tomatoes to my pantry"
       │
       ▼
Tier 1 — Intent Preprocessor (coded logic, no LLM cost)
       │
       ├── Exact match in PGC_IntentMap?     → load cached workflow → run
       ├── Simple CRUD pattern?              → build ad-hoc step   → run
       ├── Alias match in PGC_DomainHelp?    → load workflow       → run
       └── Novel / ambiguous intent          → cheap LLM classify
             └── Known workflow suggested?   → load workflow       → run
             └── Genuinely new problem?      → Heavy-Lift LLM
                   └── Generate domain/workflow → store → run
       │
       ▼
Step Processor  (SQS-driven, one Lambda invocation per stack frame)
       │
       ├── serv_* steps    → SERV layer (database operations)
       ├── llm_call steps  → LLM provider (model chosen by task category)
       ├── sub_workflow    → push child frame onto execution stack
       ├── human_gate      → Slack interactive message, stack suspends
       ├── js_transform    → sandboxed JS with AST security gate
       └── notify          → post reply to Slack thread
```

The execution stack lives in `PGC_WorkflowRun.stack`. A sequential iterator **never** fans out — it pushes one item frame, waits for it to complete, then pushes the next. At any moment there is exactly one SQS message in flight per workflow run.

---

## Architecture Summary

### AWS Stack

| Component | Choice |
|---|---|
| Runtime | Node.js 22.x ESM, arm64 Graviton2 |
| Bundler | esbuild (ESM-native, CJS shim banner) |
| Infrastructure | AWS SAM + CloudFormation |
| Compute | AWS Lambda (4 functions) |
| Queuing | AWS SQS (WorkflowQueue + SlackResultsQueue) |
| Database | PostgreSQL 16.6 on RDS (PGC + PGD databases) |
| Primary UI | Slack Bot |
| LLM | Pluggable — currently Perplexity; model selection is coded logic |
| Region | us-east-2 |

### Four Lambda Functions

| Function | Trigger | Tier | Purpose |
|---|---|---|---|
| `evolving-mind-ai-slackbot` | API Gateway | Experience | Receives Slack slash commands, enqueues to WorkflowQueue |
| `evolving-mind-ai-proc` | API Gateway + SQS WorkflowQueue | Process | Intent pipeline, domain creation, workflow orchestration |
| `evolving-mind-ai-serv` | API Gateway | Service | DDL executor, table CRUD, PGC bootstrap |
| `evolving-mind-ai-slack-callback-listener` | SQS SlackResultsQueue | Experience | Posts threaded Slack replies |

`evolving-mind-ai-proc` has a dual trigger — HTTP for direct API calls and SQS for async workflow execution. The same endpoint modules handle both transports identically. `req.source` (`'http'` or `'sqs'`) determines the response path only.

### Two PostgreSQL Databases

| Database | Tables | Purpose |
|---|---|---|
| **PGC** | `PGC_*` | System config — workflow definitions, prompts, schemas, intent maps |
| **PGD** | `PGD_*` | User domain data — everything the brain creates at runtime |

### PGC System Tables (13 bootstrapped)

| Table | Role |
|---|---|
| `PGC_Schema` | Registry of every table in the system, including itself (self-referential) |
| `PGC_TableMap` | Security gatekeeper — SERV-Table rejects writes to any unregistered table |
| `PGC_EntitySchema` | Multi-table business entity definitions for `jsonb_agg` queries |
| `PGC_DomainHelp` | User-facing command aliases and help text per domain |
| `PGC_Workflow` | Reusable workflow definitions, versioned, with quality scores and guardrail thresholds |
| `PGC_WorkflowRun` | One row per execution — holds live execution stack, state, and safety counters |
| `PGC_WorkflowRunStep` | Append-only audit log — idempotency + debugging |
| `PGC_WorkflowRunLock` | Reserved for future parallel execution (optimistic locking) |
| `PGC_Prompt` | LLM prompts with version history, output schema, samples, and error log |
| `PGC_IntentMap` | Pattern-to-workflow mappings for coded intent matching |
| `PGC_SystemContext` | Runtime self-description injected into heavy-lift LLM prompts |
| `PGC_StepType` | Catalogue of valid step types with input/output contracts |
| `PGC_Capability` | Registry of what the system can currently do — injected into LLM prompts |

A SQL view `PGC_WorkflowStats` is also installed on bootstrap — not a physical table. Used by PROC when building LLM prompts for workflow evaluation.

### Shared Utilities

| File | Purpose |
|---|---|
| `src/shared/lambda-utils.mjs` | `parseEvent()`, `buildReqFromSqs()`, `ok()`, `err()` — used by all Lambda handlers |
| `src/shared/sqs-callback.mjs` | `enqueueCallback()` — the only place `@aws-sdk/client-sqs` lives in ProcFunction |

### Semantic Search — pgvector (Designed, Not Yet Enabled)

When enabled, `text-embedding-3-small` (OpenAI, 1536 dimensions) will power:
- **Intent matching** — find the right workflow by semantic similarity, not just keywords
- **`/help` search** — find a domain from a natural language description
- **Prompt deduplication** — prevent generating duplicate prompts

Enable with: `CREATE EXTENSION IF NOT EXISTS vector;` on RDS PostgreSQL 15+.

---

## Directory Structure

```
evolving-mind-ai/
├── template.yaml                     # SAM / CloudFormation — all infrastructure
├── openapi.yaml                      # API Gateway OpenAPI definition
├── architecture.md                   # Architectural decision log — read first
├── package.json
├── .samignore
│
├── src/
│   ├── shared/                       # Cross-cutting utilities — no business logic
│   │   ├── lambda-utils.mjs          # parseEvent, buildReqFromSqs, ok, err
│   │   └── sqs-callback.mjs          # enqueueCallback — sole SQS client in ProcFunction
│   │
│   ├── ui/
│   │   └── slackbot/                 # Experience tier — Slack only
│   │       ├── handler.mjs           # Route dispatcher — HTTP only
│   │       ├── ping.mjs              # /ping-api
│   │       ├── ping-sqs.mjs          # /ping-sqs — enqueues PING_SQS to WorkflowQueue
│   │       ├── ping-llm.mjs          # /ping-llm — direct LLM connectivity check
│   │       ├── ping-e2e.mjs          # /ping-e2e — full round trip via SQS
│   │       ├── create-domain.mjs     # /create-domain — ACK + SQS enqueue only
│   │       └── callback.mjs          # SQS SlackResultsQueue consumer — routes on callback.provider
│   │
│   ├── proc/                         # Process tier — all business logic
│   │   ├── handler.mjs               # Dual HTTP + SQS dispatch — no AWS SDK
│   │   ├── ping-llm.mjs              # /proc/ping-llm
│   │   └── create-domain.mjs         # /proc/create-domain — transport-agnostic
│   │
│   └── serv/                         # Service tier — DB access only
│       ├── handler.mjs               # Route dispatcher
│       ├── ping-db.mjs               # /serv/ping-db
│       ├── schema.mjs                # SERV-Schema — DDL + PGC_Schema registry
│       ├── table.mjs                 # SERV-Table — DML gated by PGC_TableMap
│       ├── init-brain.mjs            # Bootstrap — PGC table creation + seeding
│       └── templates/
│           └── pgc/                  # PGC table definition JSON (static ES imports)
│               ├── PGC_Schema.json
│               ├── PGC_TableMap.json
│               ├── PGC_EntitySchema.json
│               ├── PGC_DomainHelp.json
│               ├── PGC_Workflow.json
│               ├── PGC_WorkflowRun.json
│               ├── PGC_WorkflowRunStep.json
│               ├── PGC_WorkflowRunLock.json
│               ├── PGC_Prompt.json
│               ├── PGC_IntentMap.json
│               ├── PGC_SystemContext.json
│               ├── PGC_StepType.json
│               ├── PGC_Capability.json
│               └── seeds/
│                   ├── seed_PGC_Schema.json
│                   ├── seed_PGC_TableMap.json
│                   ├── seed_PGC_Workflow.json
│                   ├── seed_PGC_IntentMap.json
│                   └── seed_PGC_Prompt.json
```

---

## Current State — What Works and What Doesn't

### What Works

| Capability | Status | Notes |
|---|---|---|
| All 4 Slack pings | ✅ Passing | ping-api, ping-sqs, ping-llm, ping-e2e |
| curl ping-db | ✅ Passing | Direct SERV endpoint |
| SERV-Schema CRUD | ✅ Complete | createTable, listTables, getTable, updateTable, deleteTable |
| SERV-Table getRows | ✅ Complete | 10 filter operators, PGC_TableMap gated |
| SERV-Table insertRow | ✅ Complete | PGC_TableMap gated, unique constraint → 409 |
| PGC bootstrap | ✅ Complete | 13 tables + 1 view, idempotent cold-start seeding |
| `/create-domain` | ✅ Working | End-to-end: Slack → SQS → LLM → PGD tables → Slack reply |
| Three-tier architecture | ✅ Enforced | PROC calls SERV via fetch(), no Lambda invoke |
| Callback abstraction | ✅ Complete | `callback: { provider, channel, threadId }` throughout |
| traceId | ✅ Complete | Renamed from workflowId across all SQS payloads |

### Known Limitations and Honest Behaviour

**`/create-domain` — SQS retry behaviour**

The most important thing to understand about how `/create-domain` currently works:

When the LLM occasionally returns a malformed column (missing `name` field), `createTable` fails with a PostgreSQL error. SQS retries the message up to 3 times (`maxReceiveCount: 3`). On retry, the LLM is called **again** — and because LLM output is non-deterministic, the second call may return a different (valid) scaffold. Tables created in the first partial attempt are skipped gracefully (409 → `already_existed`). The workflow completes on the second or third attempt.

This was observed in testing — a first attempt created 3 of 4 tables before failing on `PGD_RecipeRatings` (malformed column). The retry produced a different scaffold without `PGD_RecipeRatings`, found the 3 existing tables, created the new 4th table `PGD_RecipeTags`, and succeeded.

**This works but is not correct by design.** Recovery happened by accident — non-deterministic LLM retry producing a different result, not idempotent re-execution of the same intent. The correct fix requires the right brain (see below) — not more defensive code in `create-domain.mjs`.

**Other known limitations:**
- `updateTable` in SERV-Schema updates metadata only — does not execute `ALTER TABLE`
- `PGC_Prompt` has no unique constraint on `(intent_category, version)` — seeding uses `WHERE NOT EXISTS`
- FK normalisation code in `create-domain.mjs` is a temporary workaround — belongs in right-brain output validation
- `PGC_WorkflowRun` lifecycle is not yet implemented — `/create-domain` does not write run records
- No human gate on domain creation — LLM schema goes straight to DDL without user review
- `workflowId: undefined` appeared in early Slack context blocks — fixed in R12 (traceId rename)

---

## Installation

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22.x | Required for ESM and Lambda runtime match |
| AWS CLI | v2 | `aws --version` |
| AWS SAM CLI | latest | `sam --version` |
| Git | any | |

You will also need:
- An **AWS account** with permissions to create Lambda, API Gateway, RDS, SQS, SSM, IAM, and CloudFormation resources
- A **Slack app** with a bot token and signing secret
- An **LLM API key** (Perplexity by default)

---

### Step 1 — Clone and Install Dependencies

```bash
git clone https://github.com/your-org/evolving-mind-ai.git
cd evolving-mind-ai
npm install
```

---

### Step 2 — Configure AWS CLI

```bash
aws configure
# Region: us-east-2 | Output: json
aws sts get-caller-identity  # verify
```

---

### Step 3 — Load Secrets into AWS SSM Parameter Store

evolving-mind does **not** use `.env` files at runtime. All secrets are stored in SSM and resolved by CloudFormation at deploy time.

```powershell
# Slack
aws ssm put-parameter --name "/evolving-mind-ai/slack-bot-token" --value "xoxb-..." --type SecureString --region us-east-2
aws ssm put-parameter --name "/evolving-mind-ai/slack-signing-secret" --value "..." --type SecureString --region us-east-2

# LLM
aws ssm put-parameter --name "/evolving-mind-ai/llm-api-key" --value "..." --type SecureString --region us-east-2

# Database connection strings
aws ssm put-parameter --name "/evolving-mind-ai/pgc-database-url" --value "postgresql://..." --type SecureString --region us-east-2
aws ssm put-parameter --name "/evolving-mind-ai/pgd-database-url" --value "postgresql://..." --type SecureString --region us-east-2
```

> **Windows note:** Use `cmd.exe` for AWS CLI commands, not PowerShell. For local scripts use `set VAR=value && node script.mjs` — `--env-file` has CRLF issues on Windows.

---

### Step 4 — Build and Deploy

```bash
sam build && sam deploy
```

On first deploy SAM will prompt for stack parameters:
- **Stack name** → `evomind-infrastructure`
- **Region** → `us-east-2`
- **DBPassword** → your RDS master password

---

### Step 5 — Verify Pings Pass

```bash
# curl ping-db directly
curl https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/serv/ping-db

# Slack pings (from Slack)
/ping-api
/ping-sqs
/ping-llm
/ping-e2e
```

Log tailing:
```bash
aws logs tail /aws/lambda/evolving-mind-ai-serv --follow --region us-east-2
aws logs tail /aws/lambda/evolving-mind-ai-proc --follow --region us-east-2
aws logs tail /aws/lambda/evolving-mind-ai-slackbot --follow --region us-east-2
aws logs tail /aws/lambda/evolving-mind-ai-slack-callback-listener --follow --region us-east-2
```

---

### Step 6 — Configure Slack App

In the [Slack API dashboard](https://api.slack.com/apps):

1. **Slash Commands** → each pointing to:
   ```
   https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/ui/slack/command
   ```
   Commands: `/ping-api`, `/ping-sqs`, `/ping-llm`, `/ping-e2e`, `/create-domain`

2. **Interactivity** → Request URL (required for human gates — Phase 2):
   ```
   https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/ui/slack/interactive
   ```

3. **OAuth Scopes** → `chat:write`, `commands`, `app_mentions:read`, `im:history`

---

## Current Status

| Milestone | Tag | Status |
|---|---|---|
| All 5 pings pass | `v3.2-scaffolding-complete` | ✅ Done |
| SQS threading, ping-e2e round trip | `v3.2-ping-complete` | ✅ Done |
| SERV-Schema CRUD, PGC tables live | `v3.2-pgc-workflow-tables-complete` | ✅ Done |
| Callback abstraction | `v3.2-callback-abstraction-complete` | ✅ Done |
| SERV-Table getRows + insertRow | `v3.2-serv-table-partial` | ✅ Done |
| `/create-domain` scaffold | `v3.2-create-domain-scaffold` | ✅ Done |
| `/create-domain` live LLM | `v3.2-create-domain-live-llm` | ✅ Done |
| PGC schema v2 — 13 tables + seeds | `v3.2-pgc-schema-v2-complete` | ✅ Done |
| Phase 1 refactoring complete | `v3.2-refactor-complete` | ✅ Done |

---

## Collaboration Wanted — UI Development

The evolving mind is designed so the **UI layer is fully abstracted**. Slack is the first interface, but the architecture explicitly supports adding any UI: a web app, a mobile app, Microsoft Teams, a REST client, or a voice interface. The callback object `{ provider, channel, threadId }` routes replies to wherever the user is — no SERV or PROC changes required.

We are actively looking for collaborators on:

- **Web UI** — a browser-based chat interface and domain management dashboard
- **Domain visualisation** — displaying generated schemas, active workflow runs, and execution history
- **Workflow builder** — a drag-and-drop or conversational interface for designing workflows
- **Mobile interface** — push notifications and native chat UI
- **Voice input** — transcription feeds directly into the intent pipeline

If you are interested in contributing, please open an issue or reach out directly. The full API contract is documented in `openapi.yaml`.

---

## License

Copyright (c) 2026 Javea Guiri. All rights reserved.  
Licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
