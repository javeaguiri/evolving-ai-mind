# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run unit tests (Node.js native test runner — no Jest/Mocha)
node --test tests/unit/*.test.mjs

# Run a single unit test file
node --test tests/unit/step-executor.test.mjs

# Run integration tests (requires env vars from .env.test.template)
node --test tests/integration/*.test.mjs

# Deploy (esbuild bundling happens inside SAM at deploy time)
sam build && sam deploy
```

No linter or formatter is configured. Code review is done against `docs/code-review-checklist.md`.

### Dev scripts (run manually)

| Script | Purpose |
|--------|---------|
| `node dev_scripts/upsert-workflow.mjs` | Push workflow definitions to PGC_Workflow |
| `node dev_scripts/upsert-prompt.mjs` | Push prompts to PGC_Prompt |
| `node dev_scripts/upsert-step-type.mjs` | Push step type definitions |
| `node dev_scripts/upsert-system-context.mjs` | Push system context |
| `node dev_scripts/pull-prompt.mjs` | Pull prompts from DB to seed file |
| `node dev_scripts/backfill-embeddings.mjs` | Embed PGC_DomainHelp rows |

Bootstrap (install-time only, NOT on Lambda cold start): `POST /api/v1/serv/bootstrap`

### Monitoring (tail all Lambda logs live)

```bash
# Start tailing — prefixes each line with function name, writes to /tmp/lambda-logs.txt
nohup bash -c '
aws logs tail /aws/lambda/evolving-mind-ai-slackbot --follow --format short 2>&1 | sed "s/^/[slackbot] /" &
aws logs tail /aws/lambda/evolving-mind-ai-proc --follow --format short 2>&1 | sed "s/^/[proc] /" &
aws logs tail /aws/lambda/evolving-mind-ai-serv --follow --format short 2>&1 | sed "s/^/[serv] /" &
aws logs tail /aws/lambda/evolving-mind-ai-slack-callback-listener --follow --format short 2>&1 | sed "s/^/[callback] /" &
wait
' > /tmp/lambda-logs.txt 2>&1 &

# Read latest output
tail -f /tmp/lambda-logs.txt
```

---

## Architecture

**evolving-ai-mind** is a self-evolving cognitive automation brain. Users submit natural language intents via Slack; the system classifies them, executes (or generates) reusable declarative workflows, and stores them permanently. LLMs are invoked only for genuinely novel problems.

### Three-Tier Structure

```
src/ui/slackbot/   ← Experience tier (EXP): Slack I/O, ACK, SQS enqueue
src/proc/          ← Process tier (PROC): all business logic, workflow orchestration
src/serv/          ← Service tier (SERV): PostgreSQL access only
src/shared/        ← Pure utilities (cross-tier)
```

Four AWS Lambda functions, each bundled separately by esbuild:
- **SlackbotFunction** — API Gateway, handles Slack commands and interactive callbacks
- **ProcFunction** — API Gateway + SQS WorkflowQueue, all business logic
- **ServFunction** — API Gateway, DB CRUD and DDL
- **SlackCallbackListenerFunction** — SQS SlackResultsQueue, posts Slack replies

### Transport-Agnostic Pattern (critical)

Every PROC endpoint module receives identical input whether delivered via HTTP or SQS:

```js
req.source    // 'http' | 'sqs' — check ONLY to determine response path
req.callback  // { provider, channel, threadId } — top-level on SQS delivery
req.body      // actual request data
```

Always read callback as: `const callback = req.callback ?? req.body?.callback ?? null`

Never branch business logic on `req.source`.

### SQS Queues

- **WorkflowQueue** — async workflow execution. Two categories:
  1. Fire-and-forget (no workflowRunId): `PING_SQS`, `CLASSIFY_INTENT`, `CREATE_DOMAIN`, `HELP`, `CREATE_WORKFLOW`, `DELETE_DOMAIN`, `TROUBLESHOOT_WORKFLOW`, `FIX_WORKFLOW`
  2. Workflow execution (always has workflowRunId): `WORKFLOW_STEP` (actions: `execute_top`, `resume_gate`, `cancel`)
- **SlackResultsQueue** — results back to EXP. Types: `HUMAN_GATE`, `HUMAN_NOTIFICATION`, `WORKFLOW_ERROR`, `PING_SQS_RESULT`, `PING_E2E_RESULT`

### Step Processor (Workflow Execution Engine)

`src/proc/run-workflow.mjs` + `src/proc/step-executor.mjs` — generic declarative executor for any workflow stored in `PGC_Workflow.steps`. Key properties:
- Stack-based execution: one SQS message per stack frame
- Idempotent: checks `PGC_WorkflowRunStep` before executing any step
- Step types: `llm_call`, `js_transform`, `human_gate`, `serv_schema`, `serv_insert`, `serv_query`, `serv_update`, `serv_delete`, `serv_entity_query`, `iterator`, `condition`, `notify`, `end`

Workflow business logic lives entirely in `PGC_Workflow.steps` JSON — no workflow-specific `if` branches in `step-executor.mjs`. New behaviours = updated workflow JSON. New step types = new case in `step-executor.mjs`.

### Intent Classification Pipeline

`src/proc/classify-intent.mjs` — 4-pass pipeline (cheapest first):
1. **Pass 1a** — exact text match against `PGC_IntentMap`
2. **Pass 1b** — simple CRUD detection (no LLM)
3. **Pass 1c** — alias match
4. **Pass 2** — cheap LLM classify
5. **Pass 3** — heavy-lift LLM workflow generation

### Data Layer

Two PostgreSQL databases:
- **PGC (Config):** 13 system tables (`PGC_Schema`, `PGC_Workflow`, `PGC_WorkflowRun`, `PGC_WorkflowRunStep`, `PGC_Prompt`, `PGC_IntentMap`, `PGC_StepType`, `PGC_TableMap`, `PGC_EntitySchema`, `PGC_DomainHelp`, `PGC_SystemContext`, `PGC_Capability`, `PGC_WorkflowRunLock`) + 1 view
- **PGD (Domain):** User-created tables generated at runtime

Table names are mixed-case and **must be quoted** in SQL: `"PGC_Schema"`, `"PGD_Recipes"`.

Auto-managed columns (never pass in inserts/updates): `id`, `created_at`, `updated_at`.

---

## Tier Boundary Rules (enforced)

| From → To | Allowed mechanism |
|-----------|------------------|
| EXP → PROC | HTTP API Gateway (fetch) |
| PROC → SERV | HTTP API Gateway via `serv-client.mjs` |
| SQS → PROC | `buildReqFromSqs()` in handler.mjs |
| PROC → EXP | **NEVER** — results only via SQS callback |
| SERV → PROC/EXP | **NEVER** |
| Any → shared | Direct import |
| Within same tier | Direct import |

**EXP tier:** `@aws-sdk/client-sqs` and `@slack/web-api` are the only non-shared SDKs allowed.

**PROC tier:** No `@aws-sdk/*` imports in endpoint modules. `@aws-sdk/client-sqs` lives only in `src/shared/sqs-callback.mjs`.

**SERV tier:** `pg` client is the only external dependency. No LLM, no SQS, no Slack.

---

## Shared Utilities

| File | Purpose |
|------|---------|
| `src/shared/lambda-utils.mjs` | `parseEvent`, `ok`, `err`, `buildReqFromSqs` |
| `src/shared/sqs-callback.mjs` | `enqueueCallback`, `enqueueWorkflow` — **sole** SQS SDK location in PROC |
| `src/shared/serv-client.mjs` | `getRows`, `insertRow`, `updateRows`, `servPost` — all SERV HTTP calls |
| `src/shared/llm-client.mjs` | `callLlm`, `callLlmWithCorrection` — all LLM calls |
| `src/proc/template-resolver.mjs` | `resolveTemplate` — resolves `{{key.path}}` tokens against `local_state` |
| `src/proc/review-output.mjs` | Ajv schema + semantic + routing validation pipeline for all LLM output |

LLM output must always pass through `review-output.mjs` before being written to `local_state` or used downstream. Raw LLM output must never go directly to DDL or SQS payloads.

---

## Key Conventions

- **Copyright header** required on every `.mjs` file (lines 1–3):
  ```js
  // Copyright (c) 2026 Javea Guiri. All rights reserved.
  // Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
  // See LICENSE file in the project root for full license terms.
  ```
- **Spec first:** Add entries to `openapi.yaml` before implementing new endpoints. Update `docs/architecture-core.md` for new SQS message types, step types, gate types, and PGC tables.
- **Seed files** use `\uXXXX` escape sequences (native `JSON.stringify` output). `.gitattributes` enforces LF line endings.
- **Template JSON files** in `src/serv/templates/pgc/*.json` are ES module static imports bundled by esbuild — not read via `fs` at runtime.
- **Environment:** All secrets are in AWS SSM Parameter Store. No `.env` files at runtime. Use `.env.test.template` for local test setup.
- **Human Gate flow:** Step Processor suspends → `HUMAN_GATE` SQS → SlackCallbackListenerFunction renders Block Kit → user clicks → `/interactive` → `resume_gate` SQS → Step Processor resumes.

---

## Key Reference Files

- `docs/architecture-core.md` — system overview, stack, tiers, SQS queues, data architecture, SERV layer
- `docs/architecture-step-processor.md` — Step Processor, step types, stack, local_state, human gates, simulation, right-brain validation
- `docs/architecture-workflows.md` — create_domain, create_workflow, L/R collaboration, gap taxonomy, self-repair
- `docs/architecture-reference.md` — pgvector, security, tech debt register, backlog, cost of ownership
- `docs/code-review-checklist.md` — enforced patterns and anti-patterns
- `openapi.yaml` — all HTTP endpoint specs
- `template.yaml` — SAM/CloudFormation infrastructure
