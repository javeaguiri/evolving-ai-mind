# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**CRITICAL:** Read `docs/architecture.md` at the start of every session. It contains every architectural decision, their rationale, and decisions explicitly marked final. Never suggest alternatives to decisions marked as final.

---

## Project Identity

**evolving-mind-ai** is a standalone secondary brain for individuals and households with a low cost of ownership. It builds memory structures through a `create_domain` workflow and stores them in PostgreSQL tables with a `PGD_` prefix. Complex processing is handled by user-defined workflows that are then reused with minimal or no AI.

### L/R Brain

LLM prompts are divided into Left-brain (analytical, structured reasoning) and Right-brain (environmental awareness, surfacing general subject matter content) activities. Maintain this division in new prompts.

### Static System vs Evolving Artifacts

**This boundary is the most important architectural constraint in the codebase.**

| Category | Examples |
|----------|---------|
| **Static system** (code) | `run-workflow.mjs`, `step-executor.mjs`, `classify-intent.mjs`, all Lambda handlers, shared utilities |
| **Evolving artifacts** (data) | `PGC_Workflow` rows, `PGC_Prompt` rows, `PGC_SystemContext` rows, `PGC_DomainHelp` rows, `PGC_IntentMap` rows, all `PGD_*` tables |

Rules:
- Never hard-code evolving artifact content inside system code.
- New system behaviours = new step types in `step-executor.mjs`. New business logic = updated workflow JSON in `PGC_Workflow`.
- **When unclear whether something belongs in system code or an artifact: ask, or default to treating it as an evolving artifact.**
- **User domain data must never appear in system artifacts.** Labels, placeholders, examples, and descriptions in system-level workflows (`create_workflow`, `create_domain`, `ping_core`), prompts, and seed files must be generic. References to specific user domains, table names, entity types, or workflow subjects (e.g. "Spanish flashcard", "Holdings", "Recipes") belong only in `PGD_*` tables and user-created `PGC_Workflow` rows — never in the system's own seed data or code.

### Bug Fix Philosophy

Unless the change is in **system code** (a genuine engine defect), bug fixes must be made **indirectly** — by enhancing the system's self-correction and improvement capabilities (L/R brain prompts, workflow updates, system context updates). Never patch evolving artifact behaviour by adding `if` branches to system code.

---

## Final Decisions (non-negotiable)

Never suggest changing:
- ESM module format (`.mjs`)
- esbuild bundler
- Shared `LambdaExecutionRole`
- Lambda-outside-VPC architecture
- SSM `String` parameters (not `SecureString`)

---

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
| `node dev_scripts/upsert-workflow.mjs` | Push all workflow definitions to PGC_Workflow |
| `node dev_scripts/upsert-workflow.mjs ping_core` | Push one named workflow (any `name` from seed file) |
| `node dev_scripts/upsert-prompt.mjs` | Push prompts to PGC_Prompt |
| `node dev_scripts/upsert-step-type.mjs` | Push step type definitions |
| `node dev_scripts/upsert-system-context.mjs` | Push system context |
| `node dev_scripts/pull-prompt.mjs` | Pull prompts from DB to seed file |
| `node dev_scripts/backfill-embeddings.mjs` | Embed PGC_DomainHelp rows |

Bootstrap (install-time only, NOT on Lambda cold start): `POST /api/v1/serv/bootstrap`

### Monitoring (tail all Lambda logs live)

Run as a **single command** (all four tails in one Bash call — avoids multiple permission prompts):

```bash
truncate -s 0 /tmp/lambda-logs.txt 2>/dev/null || touch /tmp/lambda-logs.txt; nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-slackbot --follow --format short 2>&1 | sed "s/^/[slackbot] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 & nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-proc --follow --format short 2>&1 | sed "s/^/[proc] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 & nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-serv --follow --format short 2>&1 | sed "s/^/[serv] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 & nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-slack-callback-listener --follow --format short 2>&1 | sed "s/^/[callback] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 &

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
  1. Fire-and-forget (no workflowRunId): `PING_SQS`, `CLASSIFY_INTENT`, `CREATE_DOMAIN`, `HELP`, `CREATE_WORKFLOW`, `DELETE_DOMAIN`, `TROUBLESHOOT_WORKFLOW`, `FIX_WORKFLOW`, `CHAT_MESSAGE`, `EXPLAIN_QUERY`
  2. Workflow execution (always has workflowRunId): `WORKFLOW_STEP` (actions: `execute_top`, `resume_gate`, `cancel`)
- **SlackResultsQueue** — results back to EXP. Types: `HUMAN_GATE`, `HUMAN_NOTIFICATION`, `WORKFLOW_ERROR`, `PING_SQS_RESULT`, `PING_E2E_RESULT`, `LLM_DIAGNOSTIC`

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

#### PGC Table Reference (13 physical tables + 1 view)

| Table | Purpose | Key columns |
|---|---|---|
| PGC_Schema | Registry of ALL table definitions (PGC + PGD) | table_name, target, domain, columns, foreign_keys, constraints, triggers |
| PGC_TableMap | SERV write gatekeeper — rejects writes to unregistered tables | table_name, target, domain, schema_id, allow_insert, allow_update, allow_delete |
| PGC_EntitySchema | Business entities spanning multiple PGD tables (jsonb_agg queries) | entity_name, root_table, joins, aggregations, upsert_key, domain |
| PGC_DomainHelp | User-facing aliases + help text per domain; Pass 2 alias matching | domain, aliases, description, commands, embedding |
| PGC_Workflow | Reusable workflow definitions | name, domain, steps, intent_keywords, state_strategy, model_used, version |
| PGC_WorkflowRun | One row per execution — stack, state, safety counters | workflow_id, trace_id, status, input, stack, state, output, callback, step_count |
| PGC_WorkflowRunStep | Append-only step audit log; idempotency on SQS redelivery | run_id, frame_id, step_number, step_type, status, input_snapshot, output_snapshot |
| PGC_Prompt | LLM prompts with versioning | intent_category, prompt_text, input_variables, output_schema, probe_input, model, version |
| PGC_IntentMap | Maps patterns → workflows for Pass 1 intent classification | pattern, intent_category, workflow_id, action_type |
| PGC_SystemContext | Runtime self-description injected into heavy-lift LLM prompts | key, section, content, format, inject_always, inject_for |
| PGC_StepType | Catalogue of all valid step types with input/output contracts | step_type, description, input_contract, output_contract, status |
| PGC_Capability | Registry of what the system can do — injected into generation prompts | capability_key, category, description, status, available_in |
| PGC_WorkflowRunLock | Optimistic locking for future parallel execution (not used yet) | run_id, locked_by, version |
| PGC_WorkflowStats | SQL view — workflow run stats (not a physical table) | workflow_id, run_count, failure_rate_pct, avg_execution_ms |

> Full column definitions: `docs/data-architecture.md` section 4.3

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
| `src/shared/llm-client.mjs` | `callLlm`, `callLlmWithCorrection`, `callLlmWithMessages` — all LLM calls |
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
- **Spec first:** Add entries to `openapi.yaml` before implementing new endpoints. Update `docs/architecture.md` for new SQS message types, step types, and gate types. Update `docs/data-architecture.md` for new or modified PGC tables.
- **Seed files** use `\uXXXX` escape sequences (native `JSON.stringify` output). `.gitattributes` enforces LF line endings.
- **Template JSON files** in `src/serv/templates/pgc/*.json` are ES module static imports bundled by esbuild — not read via `fs` at runtime.
- **Environment:** All secrets are in AWS SSM Parameter Store. No `.env` files at runtime. Use `.env.test.template` for local test setup.
- **Human Gate flow:** Step Processor suspends → `HUMAN_GATE` SQS → SlackCallbackListenerFunction renders Block Kit → user clicks → `/interactive` → `resume_gate` SQS → Step Processor resumes.
- **Seed file updates:** Never write directly to the database to update seeded values. Edit `seed_PGC_Workflow.json` or `seed_PGC_Prompt.json` then run the corresponding `dev_scripts/upsert-*.mjs` script.
- **DB connections:** All `pg` connections use `ssl: { rejectUnauthorized: false }` — never change this. The 13 PGC system tables are bootstrapped and seeded — do not recreate them.
- **Propose before implementing:** On complex tasks, propose the approach and wait for confirmation before writing code.
- **No whitespace drift:** Do not add whitespace to lines or comments not affected by a change. Keeps diffs and git logs clean.
- **No defensive code:** Do not add error handling, guards, or workarounds for problems that are symptoms of a missing architectural piece. Identify the root cause and the correct fix. Defer only usability/cosmetic items to the tech debt register.
- **No file content inference:** Always read the actual file before modifying it. Never reconstruct contents from memory or prior session context.
- **Reuse before adding:** Check existing patterns in the codebase before introducing new utilities or abstractions. Propose extracting common code when duplication is found.

---

## Current State

### Recently Completed

**Session 33 (2026-05-04):**
- `/chat` and `/explain` endpoints — `src/proc/chat.mjs`, `src/proc/explain.mjs`, `src/ui/slackbot/chat.mjs`, `src/ui/slackbot/explain.mjs`
- `PGC_Session` + `PGC_SessionEntry` tables bootstrapped and seeded via `POST /api/v1/serv/bootstrap`
- `callLlmWithMessages` added to `src/shared/llm-client.mjs` for multi-turn chat
- `LLM_DIAGNOSTIC` SQS result type: step-executor writes diagnostics non-blocking, run-workflow enqueues, callback.mjs posts to channel root (no thread)
- API key security: `INTERNAL_API_KEY` env var on ProcFunction + ServFunction; `ApiKeyRequired: true` on ProcProxy + ServProxy events; `InternalApiKey` + `InternalApiUsagePlan` in `template.yaml`; `x-api-key` header in `serv-client.mjs`
- `docs/security-architecture.md` extracted from architecture.md §12

**Session 32 (2026-05-01):**
- `generate_workflow_steps` context reduction (~55KB → ~41KB)
- `probe_input` fingerprint fix in `dev_scripts/upsert-prompt.mjs`
- `PGC_SystemContext.content` → JSONB schema designed — see `docs/architecture.md` §4.3.3

### Immediate Open Work

1. **End-to-end retest** `/m create workflow Spanish flashcard quiz` — `create_workflow` v22 is deployed (step 1b removed, Other → `step:2`). Verify no second text_input box on Other click. If step 2 LLM fails, check `workflow_mode` in `local_state`.
2. **PGC_SystemContext.content → JSONB** — design complete (§4.3.3); DDL not yet run. Steps: rewrite 7 seed entries → update `PGC_SystemContext.json` template → update `upsert-system-context.mjs` → run upsert script → execute 3 DDL statements.

### Medium Priority

- Review `PGC_Prompt.output_schema`: evaluate separate table, cross-prompt sharing, `review-output.mjs` validation integration
- `PGC_WorkflowRun.session_id` FK column (nullable integer FK → `PGC_Session.id`): migration script needed, column did not exist at bootstrap
- Active bug: `analyze_and_design_workflow` (prompt id 25) produces wrong field names — `response_format` + v10 deployed session 23, not yet validated

### Deferred

- `design-domain.mjs` Phase 4 — HUMAN_GATE refactor (deferred since session 29)
- Pass 2 keyword scan excludes `domain: null` workflows (causes unnecessary Tier 2 LLM calls)

> Full tech debt register and tangential feature designs: `docs/backlog.md`

---

## Key Reference Files

- `docs/architecture.md` — full architecture decision log: system overview, Step Processor, step types, human gates, workflows
- `docs/data-architecture.md` — PGC/PGD database schema, all 15 PGC table definitions, SERV API reference (SERV-Schema, SERV-Table, SERV-Entity), dev scripts
- `docs/session-chat-design.md` — session and diagnostic chat design: PGC_Session, PGC_SessionEntry, llm_call diagnostics, `/chat` and `/explain` commands, implementation sequence
- `docs/security-architecture.md` — threat model, Slack signing secret, PROC/SERV API key enforcement, implementation status
- `docs/backlog.md` — tech debt register (active + unresolved), tangential feature designs, build history
- `docs/code-review-checklist.md` — enforced patterns and anti-patterns
- `openapi.yaml` — all HTTP endpoint specs
- `template.yaml` — SAM/CloudFormation infrastructure

---

## AWS Environment

- **Stack:** `evomind-infrastructure`, region `us-east-2`
- **API base:** `https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod`
- **Lambda functions:** `evolving-mind-ai-slackbot`, `evolving-mind-ai-proc`, `evolving-mind-ai-serv`, `evolving-mind-ai-slack-callback-listener`
