# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.4
Status: Active development — Sprint 5 in progress
Last updated: 2026-06-13 (Sprint 5 — Component Quick Reference added; Section 1.5 index; architecture.md/CLAUDE.md documentation restructure)
Previously: session 32 — generate_workflow_steps context reduction: removed create_domain_example and step_usage_patterns from inject_for, moved Rules 4/5a/5b/5c into SystemContext homes; session 31 — create_domain modal routing verified; architecture-*.md files consolidated into this file

---

## 1. System Purpose

A self-evolving, low-cost cognitive automation brain that:
- Accepts natural language intent from users via Slack (or any UI)
- Uses LLM sparingly — only for novel intents, workflow generation, and schema creation
- Persists generated workflows in PostgreSQL and reuses them — LLM is not called twice for the same problem
- Evolves its own workflows and schemas over time
- Runs at approximately $8–$13/month at household scale — see Section 16 for full cost breakdown

---

## 1.5 Component Quick Reference

Fast-lookup index for requirement scoping, fault triage, and impact assessment.
For authoritative detail follow the section references in each row.

> **Requirement scoping rule:** Changes to user-visible behaviour belong in `PGC_Workflow` or `PGC_Prompt` (evolving artifacts). Changes to how the engine itself works belong in the system code files below. When in doubt, see "Static System vs Evolving Artifacts" in `CLAUDE.md`.

### Code Components

| File | Tier | Owns / Responsibility | Change impact |
|---|---|---|---|
| `src/ui/slackbot/handler.mjs` | EXP | Slack command parsing, Slack signing verification, HTTP dispatch to EXP endpoints | Breaks all Slack command entry if changed incorrectly |
| `src/ui/slackbot/mind.mjs` | EXP | `/mind` command → CLASSIFY_INTENT SQS enqueue | Changes here affect how all free-form user intents enter the system |
| `src/ui/slackbot/interactive.mjs` | EXP | Block Kit button clicks + modal submissions → `resume_gate` SQS enqueue | Changes here break all `human_gate` resume flows |
| `src/ui/slackbot/callback.mjs` | EXP (listener) | SQS SlackResultsQueue consumer — renders ALL Slack replies (HUMAN_GATE, HUMAN_NOTIFICATION, WORKFLOW_ERROR) | Changes affect every result message posted to Slack |
| `src/proc/handler.mjs` | PROC | HTTP + SQS dual dispatch; SQS batch failure reporting | Changes affect message routing for every PROC invocation |
| `src/proc/classify-intent.mjs` | PROC | 4-pass intent routing pipeline — Pre-pass, Pass 1, Pass 2, Tier 2/3. See Section 6.3 | Changes affect routing of all `/mind` user inputs |
| `src/proc/classify-intent-tiers.mjs` | PROC | Pure classification functions — matchIntentMap, matchDomainAlias, matchWorkflowByKeywords | 50+ unit tests cover these; changes must re-run `node --test tests/unit/*.test.mjs` |
| `src/proc/run-workflow.mjs` | PROC | Step Processor outer loop — loads run, checks idempotency, dispatches to step-executor, enqueues next SQS. See Section 6.5 | Changes affect execution of ALL workflows |
| `src/proc/step-executor.mjs` | PROC | Step type dispatch — one case per step type, zero workflow-specific logic. See Section 6.5.1 | Adding a case = new step type; changing a case = affects every workflow using that type |
| `src/proc/llm-harness.mjs` | PROC | LLM call assembly — memory retrieval, prompt injection, save_to_memory extraction. See Section 6.13 | Changes affect every `llm_call` step in the system |
| `src/proc/review-output.mjs` | PROC | Ajv schema + semantic + routing validation of all LLM output. See Section 6.6 | Changes affect validation of every LLM response system-wide |
| `src/proc/simulation-engine.mjs` | PROC | L1/L2 static analysis + path simulation — pure function, no I/O. See Section 6.5.6 | Changes affect the pre-write workflow validation gate used by create_workflow, fix_workflow, and upsert-workflow.mjs |
| `src/proc/template-resolver.mjs` | PROC | `{{key.path}}` token resolution against `local_state` | Changes affect template substitution in ALL steps, messages, and conditions |
| `src/shared/serv-client.mjs` | Shared | All PROC→SERV HTTP calls — `getRows`, `insertRow`, `updateRows`, `deleteRows`, `servPost` | Changes affect ALL data reads and writes from PROC |
| `src/shared/sqs-callback.mjs` | Shared | SQS enqueue — `enqueueCallback` (results → EXP), `enqueueWorkflow` (WorkflowQueue) | Only AWS SDK import in PROC — changes affect all async dispatch and result delivery |
| `src/shared/llm-client.mjs` | Shared | Perplexity gateway HTTP client — `callLlm`, `callLlmWithCorrection` | Changes affect all LLM calls; `isSonar` guard is the only model-specific branch |
| `src/serv/table.mjs` | SERV | SERV-Table DML — SELECT, INSERT, UPDATE, DELETE; gated by PGC_TableMap. See Section 5.2 | Changes affect all row-level DB operations |
| `src/serv/entity.mjs` | SERV | SERV-Entity — assembled entity reads/writes via PGC_EntitySchema joins. See Section 5.3 | Changes affect all domain entity operations |
| `src/serv/schema.mjs` | SERV | SERV-Schema — DDL execution + PGC_Schema + PGC_TableMap registration. See Section 5.1 | Changes affect table creation and schema registration |

### Data — PGC Table Groups

Full column definitions: `docs/data-architecture.md` Section 4.3. Curl cookbook: Section 5.5.

| Group | Tables | Written by | Read by | Change impact |
|---|---|---|---|---|
| **Schema registry** | PGC_Schema, PGC_TableMap, PGC_EntitySchema | `create_domain` workflow, `schema.mjs` DDL | `table.mjs` (gatekeeper), `entity.mjs` | Breaks table validation or entity assembly for affected domains |
| **Workflow engine** | PGC_Workflow, PGC_WorkflowRun, PGC_WorkflowRunStep | `upsert-workflow.mjs`, `run-workflow.mjs`, `step-executor.mjs` | `run-workflow.mjs`, `step-executor.mjs` | Schema changes break workflow execution |
| **LLM runtime context** | PGC_Prompt, PGC_SystemContext, PGC_StepType, PGC_Capability | `upsert-prompt/step-type/system-context` scripts | `step-executor.mjs` (`llm_call`), `review-output.mjs` | Changes affect what instructions the LLM receives per call |
| **Intent routing** | PGC_IntentMap, PGC_DomainHelp | `create_domain` workflow, bootstrap seed | `classify-intent.mjs` | Changes affect how user inputs are routed to workflows |
| **Memory layer** | PGC_Memory | `write_memory` step, `memory-writer.mjs`, `save_to_memory` hook | `llm-harness.mjs` (retrieval + injection) | Changes affect memory available to every LLM call |
| **Session layer** | PGC_Session, PGC_SessionEntry | `/chat`, `/explain`, `novia.mjs` (Sprint 5) | `/chat`, `/explain`, `novia.mjs` | Not yet live — changes affect conversation continuity |
| **Domain data** | PGD_* (user tables) | `create_domain` DDL, domain workflow steps | Domain workflow steps (`serv_query`, `serv_entity_*`) | Scoped to that domain's workflows only |

### Fault triage quick map

See CLAUDE.md "Fault Domain Triage" for the five fault domains. This table maps symptom → domain → fix location:

| Symptom | Fault domain | Fix location |
|---|---|---|
| LLM produces wrong structure (wrong types, missing fields) | Contract | Update prompt rule or example in `PGC_Prompt` (e.g. `design_table`) |
| LLM ignores a rule that exists in the prompt | Instruction | Strengthen the rule or add an example in `PGC_Prompt` |
| LLM output is structurally valid but wrong business decision | Generation | Novia correction — no code change required |
| L1/L2 simulation failed to catch a bug that reached prod | Validation | Extend `simulation-engine.mjs` checks |
| Harness rejects standard LLM output format (JSONPath, SQL ORDER BY) | Execution | Extend system code — see extend-not-prompt principle in `CLAUDE.md` |
| Wrong workflow triggered by user input | Intent routing | Fix `PGC_IntentMap` pattern or `PGC_DomainHelp` aliases |
| Step type handler not found at runtime | Execution | Add case to `step-executor.mjs` and register in `PGC_StepType` seed |
| Template `{{key}}` resolves empty unexpectedly | Contract/Generation | Check `output_key` of prior step — key may be missing or wrong path |

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
- **Seed file encoding — FINAL:** JSON seed files use `\uXXXX` escape sequences for all non-ASCII characters. `JSON.stringify` produces this natively — no round-trip drift. Markdown/YAML docs use UTF-8 rendered characters. `.gitattributes` and `.editorconfig` in repo root enforce LF line endings and UTF-8 encoding.

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
| `DELETE_DOMAIN` | — | 1 — fire-and-forget | SlackbotFunction / classify-intent.mjs | proc/delete-domain.mjs |
| `DELETE_WORKFLOW` | — | 1 — fire-and-forget | SlackbotFunction / classify-intent.mjs | proc/delete-workflow.mjs |
| `MEMORY_WRITE` | — | 1 — fire-and-forget | run-workflow.mjs (on qualifying domain workflow completion) | proc/memory-writer.mjs |
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

Two canonical types handle all live traffic. Ping types are dev/system diagnostics.

| type | Rendered by | Produced by |
|---|---|---|
| `HUMAN_GATE` | `postHumanGate()` → `dialogToBlocks()` — interactive dialog, Block Kit with action buttons | `step-executor.mjs` (human_gate steps), `design-domain.mjs` (legacy create_domain path) |
| `HUMAN_NOTIFICATION` | `postHumanNotification()` → `textToBlocks()` — plain text with 3000-char chunking | `run-workflow.mjs` (notify + cancel steps), `classify-intent.mjs` (CRUD results, errors), `create-domain.mjs` (error), `design-domain.mjs` (error, cancel) |
| `WORKFLOW_ERROR` | `postWorkflowError()` → `textToBlocks()` — error summary (EXP summarises raw PROC errors) | `run-workflow.mjs` (step failure, stuck-step guard, step-not-found) |
| `PING_SQS_RESULT` | `postPingSqsResult()` — hop timing context block | `proc/handler.mjs` (inline ping handler) |
| `PING_E2E_RESULT` | `postPingE2eResult()` — round-trip timing context block | `proc/handler.mjs` (inline ping handler) |


**Design decisions:**
- `BatchSize: 1` — one message per invocation keeps Slack post ordering clean
  and avoids hitting the Slack API rate limit under burst conditions.
- `callback.provider` routing — `routeCallback()` in `callback.mjs` switches on
  provider. Adding Teams or webhook support is one new `case` with no other changes.
- PROC never imports `@slack/web-api` — all Slack SDK code is isolated to
  `SlackCallbackListenerFunction` and `SlackbotFunction`.
- `textToBlocks(text, contextText)` — shared utility in `callback.mjs` splits text on newlines
  into ≤2800-char section blocks (below Slack's 3000-char hard limit). All notification
  handlers call this — the char limit is enforced uniformly and cannot be missed by new handlers.
- `dialogToBlocks(dialog, workflowRunId)` — shared renderer for `HUMAN_GATE` messages.
  Both the Step Processor and `design-domain.mjs` (legacy path) produce the same UI-neutral
  dialog spec; `callback.mjs` renders it identically for all gate types. Adding a new gate type
  is one new `case` in `dialogToBlocks`.
- Error summarisation is an EXP responsibility — PROC emits raw technical error strings for
  `WORKFLOW_ERROR` to preserve full fidelity in CloudWatch. `callback.mjs` summarises before
  posting to Slack so users see a human-readable message, not AJV error arrays.


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
│   │       ├── handler.mjs           Lambda entry point — HTTP dispatch, Slack signing verification
│   │       ├── ping.mjs              GET /ui/slack/ping-api
│   │       ├── ping-sqs.mjs          POST /ui/slack/ping-sqs — enqueues PING_SQS to WorkflowQueue
│   │       ├── ping-llm.mjs          POST /ui/slack/ping-llm
│   │       ├── ping-e2e.mjs          POST /ui/slack/ping-e2e — enqueues PING_E2E to WorkflowQueue
│   │       ├── create-domain.mjs     POST /ui/slack/create-domain — ACK + CREATE_DOMAIN SQS enqueue
│   │       ├── create-workflow.mjs   POST /ui/slack/create-workflow — ACK + CREATE_WORKFLOW SQS enqueue
│   │       ├── mind.mjs              POST /ui/slack/mind — ACK + CLASSIFY_INTENT SQS enqueue (/mind, /m)
│   │       ├── help.mjs              POST /ui/slack/help — ACK + HELP SQS enqueue
│   │       ├── interactive.mjs       POST /ui/slack/interactive — Block Kit button clicks, modal submissions;
│   │       │                         routes resume_gate + view_submission via enqueueCallback
│   │       ├── shutdown.mjs          POST /ui/slack/shutdown — ACK + cancel active WorkflowRuns
│   │       └── callback.mjs          SQS SlackResultsQueue consumer — routes on callback.provider,
│   │                                 posts threaded Slack replies via @slack/web-api
│   │
│   ├── proc/                         Process tier — business logic only, NO AWS SDK
│   │   ├── handler.mjs               Lambda entry — HTTP + SQS dual dispatch
│   │   │                             Detects event.Records vs event.httpMethod; NO AWS SDK imports
│   │   ├── ping-llm.mjs              POST /proc/ping-llm
│   │   ├── create-domain.mjs         POST /proc/create-domain — Step Processor entry for CREATE_DOMAIN
│   │   ├── create-workflow.mjs       POST /proc/create-workflow — Step Processor entry for CREATE_WORKFLOW;
│   │   │                             initiates create_workflow PGC_WorkflowRun
│   │   ├── design-domain.mjs         POST /proc/design-domain — standalone LLM call + Ajv validation,
│   │   │                             no DB writes; used directly from curl / integration tests
│   │   ├── diagnose-prompt-schema.mjs POST /proc/diagnose-prompt-schema — Tier 1b self-repair;
│   │   │                             deterministic R1–R7 compatibility rules; no LLM; human gate confirm
│   │   ├── fix-workflow.mjs          POST /proc/fix-workflow — Tier 1 reactive repair; LLM corrects steps,
│   │   │                             human gate confirms before PGC_Workflow write; SQS FIX_WORKFLOW type
│   │   ├── help.mjs                  POST /proc/help — HELP SQS handler; drives help workflow execution
│   │   ├── llm.test.mjs              Developer integration test harness — calls live LLM endpoints directly;
│   │   │                             not a unit test runner; run manually with node
│   │   ├── run-workflow.mjs          POST /proc/run-workflow — Step Processor; executes one stack frame per
│   │   │                             SQS message (execute_top, resume_gate, cancel)
│   │   ├── simulate-workflow.mjs     POST /proc/simulate-workflow — standalone workflow simulation HTTP adapter;
│   │   │                             validates request shape, delegates to simulation-engine.mjs, returns result
│   │   ├── simulation-engine.mjs     Pure simulation module — no I/O, no AWS SDK, no Slack SDK.
│   │   │                             Exports runSimulation (Level 1 + Level 2) and runLevel1StaticAnalysis.
│   │   │                             Consumed by: simulate-workflow.mjs (HTTP), step-executor.mjs (simulate
│   │   │                             step type), and dev_scripts/upsert-workflow.mjs (pre-write L1 guard).
│   │   ├── step-executor.mjs         Step type dispatch — llm_call, js_transform, human_gate, serv_schema,
│   │   │                             serv_insert, serv_query, serv_update, serv_delete, serv_entity_query,
│   │   │                             serv_entity_get, serv_entity_schema, iterator, condition, simulate,
│   │   │                             write_memory, notify, end
│   │   ├── template-resolver.mjs     Resolves {{key.path}} tokens against local_state; pure function, no I/O
│   │   ├── classify-intent.mjs       POST /proc/classify-intent — Intent Preprocessor entry; three-tier pipeline;
│   │   │                             executes ad_hoc CRUD steps for Pass 1a/1c matches
│   │   ├── classify-intent-tiers.mjs Pure functions — matchIntentMap, matchDomainAlias, matchWorkflowByKeywords,
│   │   │                             extractSearchTerm, matchCrudVerb, hasCrudVerb — no I/O, unit-testable
│   │   ├── delete-domain.mjs         POST /proc/delete-domain — drops PGD tables; cleans PGC_Schema,
│   │   │                             PGC_TableMap, PGC_EntitySchema, PGC_DomainHelp, PGC_Workflow, PGC_IntentMap
│   │   ├── shutdown.mjs              POST /proc/shutdown — cancels all active PGC_WorkflowRun rows
│   │   ├── review-output.mjs         Internal module — Ajv validation + semantic rules + routing value rules;
│   │   │                             called by step-executor llm_call; not an HTTP endpoint
│   │   ├── troubleshoot-workflow.mjs POST /proc/troubleshoot-workflow — Tier 1 static analysis on
│   │   │                             PGC_Workflow.steps; SQS TROUBLESHOOT_WORKFLOW; optionally enqueues FIX_WORKFLOW
│   │   ├── llm-harness.mjs           Central LLM call assembly — retrieves memories, appends memory block to
│   │   │                             system instructions, handles save_to_memory extract+write; called by
│   │   │                             step-executor for all llm_call steps
│   │   ├── memory-client.mjs         retrieveMemories(), expandScope(), formatMemoryBlock() — scope expansion,
│   │   │                             budget-aware selection, and prompt block formatting for PGC_Memory rows
│   │   ├── memory-writer.mjs         Handles MEMORY_WRITE SQS messages — fire-and-forget episodic writes on
│   │   │                             qualifying domain workflow completion; zero LLM cost
│   │   ├── migrations/               One-time DB migration scripts — run manually via node
│   │   │   └── seed-*.mjs
│   │   └── scaffolds/                Phase 2b static scaffolds — superseded by LLM output
│   │       └── recipes.json
│   │
│   ├── serv/                         Service tier — DB access only; pg client allowed here
│   │   ├── handler.mjs               Lambda entry — HTTP dispatch only
│   │   ├── ping-db.mjs               GET /serv/ping-db
│   │   ├── schema.mjs                POST /serv/schema/createTable — DDL + PGC_Schema + PGC_TableMap write
│   │   │                             POST /serv/schema/updateTable — metadata update (ALTER TABLE not yet live)
│   │   │                             POST /serv/schema/addColumn — physical DDL + PGC_Schema sync;
│   │   │                               schemaOnly: true mode for metadata-only sync without DDL
│   │   ├── table.mjs                 POST /serv/table/getRows — parameterised SELECT with filters + orderBy
│   │   │                             POST /serv/table/insertRow — single row INSERT; gated by PGC_TableMap
│   │   │                             POST /serv/table/updateRows — filtered UPDATE; enforces non-empty filters
│   │   │                             POST /serv/table/deleteRows — filtered DELETE; enforces non-empty filters
│   │   ├── entity.mjs                POST /serv/entity/listEntities — assembled entity + child arrays via
│   │   │                               jsonb_agg joins defined in PGC_EntitySchema
│   │   │                             POST /serv/entity/getEntity — single assembled entity by id
│   │   │                             POST /serv/entity/insertEntity — root + child inserts in sequence
│   │   │                             POST /serv/entity/upsertEntity — upsert on PGC_EntitySchema.upsert_key
│   │   │                             POST /serv/entity/updateEntity — root row update by id
│   │   │                             POST /serv/entity/deleteEntity — root row delete by id
│   │   ├── init-brain.mjs            POST /serv/bootstrap — install-time only; idempotent PGC table creation
│   │   │                             + seeding; never called on cold start
│   │   └── templates/
│   │       └── pgc/                  JSON table definitions — static ES module imports (not fs.readFile)
│   │           ├── PGC_Schema.json
│   │           ├── PGC_TableMap.json
│   │           ├── PGC_EntitySchema.json
│   │           ├── PGC_DomainHelp.json
│   │           ├── PGC_Workflow.json
│   │           ├── PGC_WorkflowRun.json
│   │           ├── PGC_WorkflowRunStep.json
│   │           ├── PGC_IntentMap.json
│   │           ├── PGC_Prompt.json
│   │           ├── PGC_StepType.json
│   │           ├── PGC_SystemContext.json
│   │           ├── PGC_Capability.json
│   │           ├── PGC_Memory.json
│   │           └── seeds/            Seed JSON consumed by dev_scripts/upsert-*.mjs
│   │               ├── seed_PGC_Workflow.json
│   │               ├── seed_PGC_Prompt.json
│   │               ├── seed_PGC_IntentMap.json
│   │               ├── seed_PGC_StepType.json
│   │               └── seed_PGC_SystemContext.json
│   │
│   └── shared/                       Cross-cutting utilities — no business logic, no tier-specific imports
│       ├── lambda-utils.mjs          parseEvent, ok, err, buildReqFromSqs — used by all Lambda handlers
│       ├── sqs-callback.mjs          enqueueCallback(), enqueueWorkflow() — ONLY place @aws-sdk/client-sqs
│       │                             lives in ProcFunction
│       ├── llm-client.mjs            callLlm(), callLlmWithCorrection() — shared LLM caller;
│       │                             isSonar guard (response_format only on sonar); fence extraction regex
│       ├── serv-client.mjs           servPost(), getRows(), insertRow(), updateRows(), deleteRows()
│       │                             — shared SERV HTTP client; proc→serv cross-tier only
│       └── embed-client.mjs          embedText(text) → float[1536] — OpenAI text-embedding-3-small;
│                                     reads OPENAI_API_KEY_PARAM from SSM SecureString at call time
│                                     ⬜ Session 26 — not yet implemented
│
├── docs/
│   ├── architecture.md               Primary architectural decision log (this file)
│   ├── code-review-checklist.md      Per-session code review checklist — patterns, anti-patterns, rules
│   ├── github-file-index.md          Raw GitHub URL index for all source files — used for direct session-start fetches
│   ├── Javear-use-cases.md           User-facing use case definitions — source of truth for scope decisions
│   ├── openapi.yaml                  OpenAPI 3.0 spec — all PROC and SERV HTTP endpoints; spec-first rule
│   ├── perplexityapi.yaml            Perplexity Agent API reference — response_format, model names, constraints
│   ├── perplexity-embeddings.yaml    Perplexity embedding API reference
│   ├── perplexityLLMS.md             Perplexity model catalogue and constraints
│   ├── slack-block-kit.md            Slack Block Kit element reference with JSON snippets — used for callback.mjs review
│   ├── slack-messaging.md            Slack messaging API reference
│   ├── prompt-issues.md              LLM prompt quality log — failure patterns, root causes, mitigations
│   ├── session-handoff.md            Session-to-session continuity doc — last known state + next steps
│   ├── unit-test-setup.md            node:test runner setup guide — ESM fixtures, test structure
│   ├── user-intent-use-cases.md      UC 1.x intent pipeline use case specs
│   └── evolving_mind_use_cases.html  Visual use case map — rendered HTML for stakeholder review
│
├── dev_scripts/                      Developer tooling — run manually, never imported by Lambda code
│   ├── upsert-workflow.mjs           Upserts one or more PGC_Workflow rows from seed_PGC_Workflow.json
│   │                                 Usage: node dev_scripts/upsert-workflow.mjs <workflow_name>
│   ├── upsert-prompt.mjs             Upserts PGC_Prompt rows; idempotent via SHA-256 fingerprint;
│   │                                 Usage: node dev_scripts/upsert-prompt.mjs <intent_category>
│   ├── pull-prompt.mjs               Pulls highest-version DB row per intent_category; writes directly
│   │                                 to seed_PGC_Prompt.json in place; removes old-version cluster entries
│   │                                 Usage: node dev_scripts/pull-prompt.mjs <intent_category>
│   ├── extract-run-data.mjs          CLI: extract all values at a relative dot-path from a JSON file;
│   │                                 fans through arrays; --raw flag for piping
│   │                                 Usage: node dev_scripts/extract-run-data.mjs <file> <dot.path>
│   ├── backfill-embeddings.mjs       One-shot — embeds all PGC_DomainHelp rows where embedding IS NULL
│   │                                 ⬜ Session 26 — not yet implemented
│   ├── seed_PGC_StepType.mjs         Seeds PGC_StepType rows with routing contracts; safe to re-run
│   └── seed_PGC_SystemContext.mjs    Reads PGC_StepType; writes step_type_contracts to PGC_SystemContext
│
├── tests/
│   ├── unit/
│   │   └── classify-intent-tiers.test.mjs   50 tests — matchIntentMap, matchDomainAlias,
│   │                                          matchWorkflowByKeywords, extractSearchTerm, parseFieldValues
│   └── integration/
│       └── llm-prompt-schema.test.mjs        One it() per prompt; probe_input substitution mirrors
│                                              step-executor; HTTP 400 always hard fail
│
├── template.yaml                     SAM/CloudFormation — infrastructure, Lambda env vars, SQS triggers
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
- `llm-client.mjs` — `callLlm()`, `callLlmWithCorrection()` — shared LLM caller;
  `isSonar` guard gates `response_format` to sonar models only; fence extraction
  regex strips leading/trailing prose around fenced JSON
- `serv-client.mjs` — `servPost()`, `getRows()`, `insertRow()`, `updateRows()`, `deleteRows()` — shared SERV HTTP client
- `embed-client.mjs` — `embedText(text) → float[1536]` — OpenAI `text-embedding-3-small`;
  reads API key name from `process.env.OPENAI_API_KEY_PARAM`, retrieves SSM SecureString at call time.
  **⬜ Session 26 — not yet implemented.**

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

  // SQS — hand off to downstream workflow or enqueue HUMAN_NOTIFICATION
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

> Full data architecture details have been extracted to `docs/data-architecture.md`. That document covers: PostgreSQL instance overview, naming conventions and bootstrap, all 15 PGC table definitions (columns, indexes, constraints), SERV API endpoints (SERV-Schema, SERV-Table, SERV-Entity), and dev scripts for PGC data management.

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
| 6.9 | create_workflow Workflow (see `docs/create-workflow-design.md`) |
| 6.10 | Session Architecture — chat and diagnostics (see `docs/session-chat-design.md`) |
| 6.16 | Workflow State Flow Analysis — design decision and backlog |

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

- **HUMAN_NOTIFICATION / WORKFLOW_ERROR / WORKFLOW_CANCELLED** — completion and status
  messages posted as Slack thread replies. These are fire-and-forget.
- **HUMAN_GATE** — a human gate suspension event. The Step Processor builds a
  structured dialog payload and enqueues it via the same callback path. `callback.mjs`
  translates the UI-agnostic `HUMAN_GATE` message into Slack Block Kit blocks and
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
6. At the end of the workflow, writes `PGC_DomainHelp`, `PGC_IntentMap` (5 rows — one per `*_entity` intent category, pointing to the 5 pre-existing generic `*_entity` workflows with `domain: null`), and `PGC_EntitySchema` (entity join/aggregation definitions) — making the new domain available to the Intent Preprocessor and SERV-Entity. **`create_domain` does not create any `PGC_Workflow` rows for the domain.** Domain-specific workflows are created separately via `create_workflow`.

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
  └── unknown heavy_lift                  → HUMAN_NOTIFICATION: "I understood this
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
| `heavy_lift` | — | `resolveTier3Route()` → enqueue `CREATE_DOMAIN` / `CREATE_WORKFLOW` / `HUMAN_NOTIFICATION` |
| `crud` | — | `executeCrudStep()` — executes `ad_hoc_step` directly, posts result as `HUMAN_NOTIFICATION` |
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
| Tier 3 | `intent_category` string | Routes to `CREATE_DOMAIN` / `CREATE_WORKFLOW` / `HUMAN_NOTIFICATION` — no further classification |

##### handoff() routing — FINAL, do not add per-workflow cases

```
action_type === 'workflow' AND workflow_name set
  → find workflow in pre-loaded PGC_Workflow rows by name
  → insertRow('PGC_WorkflowRun', { input: { userInput, ...(search_term && { search: search_term }) }, ... })
  → enqueueWorkflow(WORKFLOW_STEP execute_top)

action_type === 'heavy_lift'
  → resolveTier3Route(intent_category)
  → enqueue CREATE_DOMAIN | CREATE_WORKFLOW | HUMAN_NOTIFICATION

action_type === 'crud' AND ad_hoc_step set
  → executeCrudStep() — runs step directly, posts HUMAN_NOTIFICATION

action_type === 'crud_ambiguous'
  → enqueueCallback(HUMAN_NOTIFICATION, instructive error message)

action_type === 'crud' AND no ad_hoc_step (Tier 2 crud path — no root table resolved)
  → enqueueCallback(HUMAN_NOTIFICATION, "could not determine which table to use")
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
                  │     enqueue HUMAN_GATE to callback
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
  "on_else":       "cancel | step:<key>"
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
║              ║ HUMAN_NOTIFICATION to callback                          ║                  ║
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
║              ║ to on_success / on_else step keys. No I/O.           ║ Session 19       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ capability_call ║ Call a registered capability from PGC_Capability  ║ ⬜ Backlog       ║
╠══════════════╣══════════════════════════════════════════════════════╣══════════════════╣
║ simulate       ║ Dry-run a workflow step array against named         ║ ✅ live          ║
║               ║ execution paths using injected mock outputs.         ║ v3.2-create-    ║
║               ║ Three validation levels: static analysis, path        ║ workflow-       ║
║               ║ execution, skip-path analysis. See Section 6.5.6.   ║ complete        ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ write_memory  ║ Persist a PGC_Memory row. Reads content string from  ║ ✅ Sprint 3      ║
║               ║ local_state[content_key]. Never fails the run —      ║                  ║
║               ║ errors logged only. See Section 6.13.                ║                  ║
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
  "on_else": "cancel"
}
```
`input.prompt` is the `intent_category` key into `PGC_Prompt`. All other `input`
fields are available to the prompt template via `{{variable}}` substitution.
Output is the parsed JSON object from the LLM, stored at `output_key` in `local_state`.

**Right-brain hooks in `llm_call`.** Every `llm_call` step has two right-brain
mechanisms wired into it by the Step Processor — no workflow definition changes needed:

1. **Validation and correction loop** (Section 6.6): After the LLM responds, `review-output.mjs`
   runs Ajv + semantic validation. On failure, a correction prompt is sent automatically.
   If both attempts fail, the structured errors are written to `PGC_Prompt.error_log`.

2. **Truncation-aware resumption** (Section 6.6): If the response is cut off mid-JSON because
   `max_output_tokens` was reached (`output_tokens === ceiling`), a resumption prompt
   regenerates from scratch at double the token budget, rather than sending the broken
   partial output to the correction loop. If resumption also fails, `token_truncation` is
   logged to `PGC_Prompt.error_log`.

3. **Prompt quality monitor** (Section 6.6): After any 2-attempt failure is written to
   `error_log`, `monitor-prompt-quality.mjs` fires asynchronously. It classifies the
   failure pattern and, for `token_truncation` with 2+ consecutive occurrences, inserts
   a new `PGC_Prompt` version with a raised ceiling automatically. No human intervention
   required. Schema errors are logged as advisory for the Phase 3 right-brain loop.

4. **Memory write** (Section 6.13): When `save_to_memory` is set on the step definition,
   `llm-harness.mjs` appends a `reasoning` instruction to the prompt, extracts and strips
   the `reasoning` field from the LLM output before schema validation, and writes it to
   `PGC_Memory`. Zero additional LLM calls — the reasoning content is part of the existing
   call. `save_to_memory` fields: `memory_type`, `scope` (supports `{{template}}` tokens),
   `tags`, `priority`.

5. **Memory retrieval** (Section 6.13): When `PGC_Prompt.memory_config.memory_budget_tokens > 0`,
   `llm-harness.mjs` calls `memory-client.mjs` to retrieve scope-matching `PGC_Memory` rows
   within the token budget, then appends the formatted memory block to the system instructions.

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
  "on_else": "cancel"
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
  "on_else": "cancel"
}
```
###### Context key 
`context_key` is a dot-path into `local_state` — the data bound to the dialog.
`options[].on_select` drives routing after the gate resolves — `"step:3d"` is a
jump; `"next"` advances to the sequentially next step; `"cancel"` cancels the run.

###### `reveal` (optional, all gate types)

Renders an inline `task_card` block above the gate buttons. The definition is always
visible — no click required. The gate remains suspended; the card is read-only.

```json
"reveal": {
  "button_label": "Show Definition",
  "content": "{{some.template}}"
}
```

`content` is resolved via `resolveTemplate` before the HUMAN_GATE SQS message is
built. `button_label` becomes the `task_card` title. Both fields are required and
must be non-empty strings — L1 validation rejects steps where either is missing.
`callback.mjs` renders the block using `randomUUID()` for `task_id` and
`status: "complete"` — posted directly in the gate message, not as a thread reply.

###### `iterator` on options (choice gate only)

Any option in a `choice` gate may carry `iterator: '<local_state_key>'`. At runtime
`buildDialog` expands that option into **one button per item** in
`localState[iterator]`, resolving `label`, `value`, and `description` tokens against
`{...localState, ...item}` for each element. Only one option object per gate should
carry `iterator`. A Cancel option without `iterator` must always appear as a separate
entry. The `iterator` field is stripped from the rendered buttons.

```json
{
  "step": "3", "type": "human_gate", "gate_type": "choice",
  "message_template": "Select a deck to quiz:\n{{decks_list}}",
  "output_key": "selected_deck_id",
  "options": [
    { "value": "{{id}}", "label": "{{name}}", "description": "{{card_count}} cards",
      "on_select": "next", "iterator": "decks" },
    { "value": "cancel", "label": "Cancel", "description": "Stop", "on_select": "cancel" }
  ],
  "on_success": "next", "on_else": "cancel"
}
```

Use `iterator` instead of a preceding `js_transform` step when gate options come
from a variable-length array. L1 validation skips the unresolved-key check for
options that carry `iterator` (tokens resolve at runtime against each item).

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
  "items_key":      "proposed_scaffold.tables",
  "item_step":      { "type": "serv_schema", "input": { "table": "{{item}}" } },
  "output_key":     "created_tables",
  "execution_mode": "sequential",
  "on_complete":    "next"
}
```
`items_key` is a dot-path to an array in `local_state`. `item_step` is executed
once per item — the current item is available as `{{item}}` and `{{item.field}}`
inside `item_step.input`. Results are collected into an array at `output_key`.
`execution_mode: "sequential"` is **always required** — omitting it is a workflow defect.

#### Iterator taxonomy — non-suspending vs suspending

Two categories of iterator exist based on whether the `item_step` suspends execution.

**Non-suspending iterator** — `item_step` is a service step (`serv_schema`, `serv_insert`,
`serv_update`, `serv_delete`, `serv_query`, `llm_call`, `js_transform`). All items execute
inline within a single Lambda invocation in `executeIteratorInline`. No SQS hop per item.
This is the common case — `create_domain` step 5 (DDL), step 9, step 10b are all
non-suspending iterators.

**Suspending iterator** — `item_step` is `human_gate`. Each item requires one full
suspend/resume cycle: the iterator breaks after building the gate, a gate frame is pushed,
the run suspends. When the user responds, `resume_gate` pops the gate frame and the iterator
frame becomes the top frame. `resumeGate` detects `parentFrame.type === 'iterator'` and:
1. Strips the `item` binding from `localState` before merging state back onto the iterator frame
   (prevents `item` from leaking into the frame-level state).
2. Increments `parentFrame.current_index` — advancing to the next item.
3. Does **not** set `current_step` — iterator frames use `current_index`, not `current_step`.

The next `execute_top` re-enters `executeIteratorInline` at the incremented index.

`step_ref.options` is resolved from the template string (e.g. `"{{item.options}}"`) to a live
array before the gate frame is persisted — required because `resume_gate` calls
`options.find()` to match the user's response value.

**When to use a suspending iterator vs the flat loop pattern:**

| | Suspending iterator | Flat loop (backward step reference) |
|---|---|---|
| Use when | Fixed list of independent questions, each needing one answer | Loop with inter-item state (score, accumulated data, conditional branching per item) |
| Output | Results array at `output_key` | State accumulated in `local_state` via `js_transform` |
| Loop control | Iterator exhausts automatically | Explicit index + condition step |
| Guard 3 safety | N/A — no backward reference | Requires `human_gate` on every loop path |

Prefer the flat loop pattern when each iteration needs to read results from previous
iterations, or when loop termination depends on accumulated state. See `create_domain_example`
in `PGC_SystemContext` for a complete flat loop example (Spanish vocabulary quiz).

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
  "on_else": "cancel"
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
  "on_else": "cancel"
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
  "on_else": "cancel"
}
```

##### `notify`
```json
{
  "step": "11", "type": "notify",
  "message_template": "Domain {{proposed_scaffold.domain}} created. Try: {{generated.domainHelp.commands.0.syntax}}",
  "notify_type": "HUMAN_NOTIFICATION",
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
  "on_else":  "step:3"
}
```
All three `input` fields are dot-paths into `local_state`. `mock_outputs_key`
and `paths_key` are optional — if absent, the `simulate` step runs Level 1
static analysis only. `on_else` routes back to the step where the user can
review and correct the workflow definition before re-simulating.
Full schema, validation levels, and result structure: see **Section 6.5.6**.

##### Post-write L1 validation

`create_workflow` and `fix_workflow` run `runLevel1StaticAnalysis` on the generated
steps array **before** calling SERV to persist the workflow. If issues are found the
write is blocked and a `422` response is returned with the structured issue list.
`upsert-workflow.mjs` surfaces L1 errors clearly in terminal output. This prevents
dead-routing or structurally invalid workflows from entering `PGC_Workflow` at all.

The check is performed in PROC (not SERV) because `runLevel1StaticAnalysis` lives in
`simulation-engine.mjs` which is a PROC-tier module — SERV has no access to it.

**Skeleton vs full L1:** `serv_step_missing_required_input` is a content completeness
check (verifies `tableName`, `row`, `filters`, `updates` are declared). It is skipped
when the simulate step sets `input.skeleton: true` (routing skeleton validation, step 21b)
because skeleton steps are intentionally input-free. All topology checks run in both modes.
The final pre-write simulate (step 25) always runs full L1 with `skeleton` unset.

##### `condition`
```json
{
  "step": "1",
  "type": "condition",
  "description": "Route to id lookup or name search depending on which input field is set.",
  "expression": "{{input.id}}",
  "on_success": "2",
  "on_else":  "3"
}
```
`expression` is resolved via `resolveTemplate` against `local_state`. Truthy: resolved value is
non-empty, not `"null"`, not `"undefined"`, not `"0"`, and does not contain `{{` (unresolved
template literals are treated as falsy — the key was not set). `on_success` and `on_else` are
bare step keys (e.g. `"2"`, `"3"`) — the executor prefixes them to `step:N` internally.
No output_key is written — condition steps produce no state output.

**Constraint:** `on_success` and `on_else` must reference step keys that exist in the workflow.
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
  "on_else": "cancel"
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

##### `write_memory`
```json
{
  "step": "16c", "type": "write_memory",
  "description": "Persist confirmed schema snapshot as semantic domain memory.",
  "input": {
    "memory_type": "semantic",
    "scope":       { "domain": "{{proposed_scaffold.domain}}" },
    "content_key": "domain_semantic_content",
    "tags":        ["schema_snapshot", "insert_expectations"],
    "priority":    2
  },
  "on_success": "next",
  "on_else": "next"
}
```
`content_key` names a `local_state` key whose string value becomes the memory content.
`token_estimate` is computed automatically: `Math.ceil(content.length / 4)`.
Scope values support `{{template}}` substitution resolved at write time.
No `output_key` — the step returns `outputValue: null`. Errors are logged but never fail the run.
See Section 6.13 for the full memory layer design.

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
  { "frame_id": "C", "type": "iterator",  "current_index": 1, "execution_mode": "sequential", "items": [...], "results": [...] }
]
```

**Suspending iterator — human_gate frame on top of iterator frame (mid-item):**
```json
stack: [
  { "frame_id": "A", "type": "workflow",  "current_step": "5",  "local_state": { ... } },
  { "frame_id": "C", "type": "iterator",  "current_index": 1, "execution_mode": "sequential", "items": [...], "results": [ result_0 ] },
  { "frame_id": "D", "type": "human_gate", "status": "awaiting", "gate_type": "choice", "step_number": "5" }
]
```
When the user responds, `resume_gate` pops frame D, detects `parentFrame.type === 'iterator'`,
increments `C.current_index` to 2, strips the `item` binding from `localState`, and
does **not** set `current_step` on frame C. `execute_top` re-enters `executeIteratorInline`
at index 2.

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
  ├── Builds HUMAN_GATE dialog from gate_type + context_key data
  ├── Enqueues HUMAN_GATE to SQS SlackResults
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
| `text_input` | Type free text in an inline Slack input block, click Submit | Value written to `local_state[output_key]` on submit. Set `multiline: true` on the step for a multi-line text area. |
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
    { "label": "Add a table","action": "add_table", "on_select": "step:3a",
      "modal": { "title": "Add a table", "input_label": "Describe the table",
                 "placeholder": "What it stores and how it relates.", "multiline": true } },
    { "label": "Cancel",     "action": "cancel",    "on_select": "cancel"  }
  ],

  "special_buttons": [
    { "value": "other", "label": "Other", "on_select": "next",
      "modal": { "title": "Other option", "input_label": "Describe your option",
                 "placeholder": "Describe your choice", "multiline": false } },
    { "value": "cancel", "label": "Cancel", "on_select": "cancel" }
  ],

  "input_label":  "Short label above the Slack input element (text_input gate only)",
  "output_key":   "key_written_to_local_state_on_resolve",

  "on_success": "next",
  "on_else": "cancel"
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
or `value: "cancel"` (choice) — this may be in `special_buttons` instead of `options`.

Two option shapes — determined by `gate_type`:
- `confirm`, `edit_list`, `review_object` use `{ label, action, on_select }`
- `choice` uses `{ value, label, description, on_select }` — HTML radio button semantics:
  `value` is the machine identifier written to `output_key` and matched by `resume_gate`;
  `label` is the short button text (e.g. `"A"`, `"B"`);
  `description` is the explanatory sentence rendered above the buttons as a list.

Any option or special_button may carry a **modal descriptor**:
`{ title, input_label, placeholder, multiline }`
Clicking the button opens a Slack overlay modal without advancing the workflow.
When the user submits the modal, `handleViewSubmission` enqueues `resume_gate`
with the original button action and `responseData.inputValue` (the typed text).
The button click itself does NOT enqueue `resume_gate` — only modal submission does.

**`special_buttons`** — optional array of buttons appended after `options` in the
actions block. Never appear in `description_list` or other content fields. Use for:
- Cancel buttons (so they don't pollute the described option list)
- "Other" buttons that open a modal for free-text input
- Any action button that should not be described alongside the main options.

**`input_label`** — `text_input` gate only. Short label shown above the Slack inline
input element. Defaults to `"Your input"`. The full instructions go in `message_template`.

**`output_key`** — written on gate resolution:
- `text_input`: the typed value is written to `local_state[output_key]`
- `choice`: the selected `option.value` is written — if the option carried a modal descriptor,
  the modal typed text (`inputValue`) is written instead of the button value
- `confirm` with `context_key`: the selected action is written to `local_state[output_key]`

**`on_timeout` / `timeout_seconds`** — reserved fields, not yet implemented.
When implemented, a gate that receives no user response within `timeout_seconds`
will resolve via `on_timeout` routing (e.g. `"cancel"` or a specific step key).
Until then, gates wait indefinitely — cost-free while suspended.

**`on_success` / `on_else`** — gate-level fallbacks. `on_success` is the
default routing when no `on_select` override applies. `on_else` handles
gate execution errors (e.g. dialog build failure), not user cancellation.
User cancellation is always routed via the option with `action: "cancel"`.

---

#### UI Dialog Contract — HUMAN_GATE message

The Step Processor produces a UI-agnostic `HUMAN_GATE` message. `callback.mjs`
translates it to Slack Block Kit. Adding a new UI is one new renderer in
`callback.mjs` — the Step Processor and all workflows are unchanged.

```json
{
  "type":          "HUMAN_GATE",
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
  "on_else":  "step:3"
}
```

`steps_key`, `mock_outputs_key`, and `paths_key` are dot-paths into `local_state`.
They reference keys written by the LLM generation steps that precede the simulate
step. `on_else: "step:3"` routes back to the human gate where the user reviewed
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
or `cancel`.

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
      "expected_terminal": "cancelled"
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
| Every `on_success`, `on_else`, `on_select` value is a known routing token | Unknown routing value |
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

**Level 3 — Skip-path analysis**

Removed. Previously flagged data flow risks for skipped failure-path steps.

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
}
```

On failure, `passed: false` and `paths_failed > 0`. The first failed path’s
transition log is included in full, showing exactly which step failed and what
`local_state` contained at that point. This is presented to the user in the
`review_object` gate when `on_else: "step:3"` routes back for correction.

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

### 6.6 Right-Brain Output Validation, Resumption, and Quality Monitor

Every `llm_call` step passes through a multi-stage right-brain pipeline before its
output is accepted and stored in `local_state`. This pipeline is implemented across
three modules — `review-output.mjs`, `llm-client.mjs`, and `monitor-prompt-quality.mjs`
— all called directly (intra-proc import) from `step-executor.mjs`. No workflow
definition changes are needed to get these capabilities; they apply to every `llm_call`
step in every workflow automatically.

#### Validation passes

Three passes run in strict order. Later passes only execute if all earlier passes
have returned zero errors.

**Pass 1 -- Ajv JSON Schema**
The `output_schema` field on the `PGC_Prompt` row is an Ajv-compatible JSON Schema.
The LLM output is validated against it. If it fails, the specific Ajv errors are
collected and passed to the correction attempt.

Every prompt must have an `output_schema`. A prompt without one skips Ajv
validation entirely -- this is a known gap in any prompt row that lacks the field.

**Pass 2a -- Schema semantic rules** (`runSemanticRules()`)
Runs only if Pass 1 passed, and only when the output contains a `tables` array
(i.e. `create_domain` and `design_table` prompts). Rules:

- Rule 1: Every table must have the `set_updated_at()` BEFORE UPDATE trigger
- Rule 2: Every `upsert_key` column must have a matching UNIQUE constraint
- Rule 3: Every FK parent table must exist in the same scaffold

These rules catch cross-reference errors that JSON Schema cannot express --
a FK pointing to a table not in the output, or a constraint on a nonexistent column.

**Pass 2b -- Routing value rules** (`runRoutingValueRules()`)
Runs only if Pass 1 passed, and only when the output contains a `steps` array
(i.e. workflow generation prompts: `generate_workflow_steps` and any prompt whose
output shape includes a steps array). Does not run on `create_domain` output.

Rules enforced on every step in the array:

- Every `on_success`, `on_else`, and `on_complete` value must be a known routing
  token: `next`, `end`, `cancel`, or `step:<key>`
- Every `step:N` target must exist as a step key in the same array -- dead targets
  are caught here before the workflow is ever registered or simulated
- Every `human_gate` must have at least one option with `action: "cancel"`

Pass 2a and Pass 2b are mutually exclusive by output shape -- an output with `tables`
never has `steps`, and vice versa. Both use the same error format
`{ type: "semantic", rule, message, step? }` so the correction loop handles them
identically.

#### Full pipeline -- parse, truncation detection, correction, resumption

The pipeline runs in this order on every `llm_call` step:

```
Step Processor calls callLlm():
  LLM responds
    |
    +-- JSON parses cleanly?
    |     Yes --> run validation (Pass 1 + Pass 2a or 2b)
    |             Valid   --> store at output_key, continue
    |             Invalid --> callLlmWithCorrection (Attempt 2 -- see below)
    |
    +-- JSON parse fails:
          |
          +-- output_tokens >= max_output_tokens? (truncation detected)
          |     Yes --> callLlmWithResumption
          |               Doubled token budget (max 8000)
          |               "Regenerate the complete response from scratch"
          |               Success --> run validation on resumed output
          |               Failure --> log token_truncation to PGC_Prompt.error_log
          |                          --> step throws
          |
          +-- Ordinary parse error (unescaped quote, malformed structure)
                callLlmWithCorrection with parse error as the correction input
                Success --> run validation
                Failure --> step throws

Attempt 2 (callLlmWithCorrection -- Ajv/semantic errors only):
  Call LLM with original prompt + all collected errors injected
  Valid  --> store corrected output at output_key, continue
  Invalid --> log errors to PGC_Prompt.error_log
              --> fire monitor-prompt-quality asynchronously
              --> step throws

Step throws --> run-workflow.mjs catch block:
  mark run failed --> WORKFLOW_ERROR to Slack
```

**Key distinction between correction and resumption:** The correction loop sends the
broken output back to the LLM with the specific errors. This works when the LLM
misunderstood a schema contract. It fails when the response was simply cut off --
there is nothing to correct in a truncated response, and the correction call hits the
same ceiling. Resumption bypasses this by requesting a clean regeneration at double
the budget.

**`priorErrorType` forwarding:** When resumption succeeds at parsing but AJV then
fails, `validate()` receives `priorErrorType: "token_truncation"` so the error_log
correctly records the root cause rather than the downstream schema error.

#### `PGC_Prompt.error_log` -- the right-brain accumulation surface

Every 2-attempt failure appends a structured entry to `PGC_Prompt.error_log`:

```json
{
  "attempts": [
    {
      "at": "2026-04-22T15:58:56Z",
      "error_type": "token_truncation",
      "error_message": "Truncated at 1500 tokens; resumption also failed: ...",
      "recovery_action": "halt"
    },
    {
      "at": "2026-04-22T16:10:12Z",
      "error_type": "schema_contract",
      "error_message": "Validation failed after 2 attempts -- 3 error(s)",
      "ajv_errors": [...],
      "recovery_action": "halt"
    }
  ]
}
```

`error_type` values and their meanings:

| Value | Cause | Auto-fixable |
|---|---|---|
| `token_truncation` | `output_tokens >= max_output_tokens` on any attempt | Yes -- monitor raises ceiling |
| `schema_contract` | Wrong array element shape (e.g. objects instead of strings) | No -- prompt example needed |
| `schema_violation` | Missing required field, wrong enum, type mismatch | No -- prompt clarification needed |
| `llm_correction_failed` | The correction LLM call itself threw (network, timeout) | No |
| `unknown` | None of the above patterns matched | No |

#### Prompt quality monitor -- `monitor-prompt-quality.mjs`

Fires asynchronously (fire-and-forget) from `review-output.mjs` after every
2-attempt failure is written to `error_log`. Does not block the workflow error
path. Available as both a direct intra-proc import and a POST HTTP endpoint for
manual triggering.

**Classification rule:** requires 2+ consecutive failures with the same `error_type`
in the last 5 attempts. A single occurrence is not a pattern. Consecutive occurrences
indicate a structural issue that will recur on every run.

**Autonomous action -- `token_truncation`:**
When 2+ consecutive `token_truncation` entries are detected, the monitor inserts a
new `PGC_Prompt` version (parent_prompt_id set to the failing version) with:
- `max_output_tokens` raised by 1.5x, capped at 8000
- `prompt_text`, `output_schema`, `model` copied unchanged
- `error_log` cleared (fresh slate for the new version)

The Step Processor always loads the latest version via `ORDER BY version DESC LIMIT 1`,
so the raised ceiling takes effect on the next run without any deployment or manual
intervention.

**Cooldown guard:** The monitor skips if a newer version was already inserted within
the last 24 hours, preventing runaway version inflation when a prompt is failing
persistently faster than the fix can be verified.

**Advisory only -- `schema_contract` / `schema_violation`:**
These require a right-brain prompt improvement loop (Phase 3). The monitor logs an
advisory to CloudWatch and does not modify the prompt. The `error_log` accumulates
the failure data that the Phase 3 loop will consume.

**Not in scope for the monitor:** Content errors -- outputs that are structurally
valid and pass AJV but are semantically wrong (e.g. `confidence: "blocked"` when
the workflow is buildable). These require `PGC_WorkflowStats` correlation to detect
and the full Phase 3 loop to fix.

#### HTTP endpoint

`POST /api/v1/proc/monitor-prompt-quality` -- accepts `{ intentCategory, promptId }`
for manual triggering. Returns the action taken: `auto_patched`, `advisory`,
`skipped`, or `error`. Useful for testing the monitor without triggering a live
workflow failure.

handler.mjs additions required to activate the HTTP and SQS paths:
```js
// HTTP
case 'monitor-prompt-quality': return monitorHandle(req)
// SQS
case 'MONITOR_PROMPT_QUALITY': return monitorHandle(buildReq(message))
// Import
import { handle as monitorHandle } from './monitor-prompt-quality.mjs'
```

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

### 6.8 create_domain Workflow

Full annotated workflow design is in [`docs/create-domain-design.md`](create-domain-design.md).

**Sprint 4 additions:** Two-layer memory architecture — pre-confirmation episodic write (step 10 `save_to_memory`) captures initial design reasoning; `revise_domain_schema` (step 12b) and `design_table` (step 13) accumulate semantic schema_expectations memories on each iteration; post-confirmation structural snapshot (steps 16b/16c `write_memory`) writes the definitive semantic record of insert expectations and `initial_value_conventions`. All three design prompts now emit `initial_value_conventions` for application-level initial values not fully described by SQL DEFAULT.

### 6.9 create_workflow Workflow

Full design documentation — including L/R collaboration architecture decisions,
the six-phase step structure with `local_state` data flow, gap taxonomy application,
simulation correction loops, and implementation notes — is in
[`docs/create-workflow-design.md`](create-workflow-design.md).

**Sprint 4 additions:** Skeleton-first routing validation — `design_workflow_process` now emits `routing` fields (step_label references) per process_design item; steps 21a/21b/21c derive a routing skeleton, run L1 BFS on it, and gate on failure before dialog or step content is generated. IntentMap phrasing gate — steps 35a/35b ask for invocation phrases, build a `|`-joined regex, and use it as the IntentMap pattern (step 36) so Pass 1a matches user-chosen phrases directly.

**Session 13 decisions:**

*Skeleton mode for L1 (`input.skeleton: true` on simulate step):* The `serv_step_missing_required_input` L1 check is a **content completeness** check — it verifies that a fully-formed step declares `tableName`, `row`, `filters`, and `updates`. A routing skeleton is intentionally content-free; those fields are filled in by `generate_workflow_steps`. Running this check on a skeleton produces false positives on every serv_* step. Decision: add a `skeleton: boolean` flag to the `simulate` step input, threaded through `runSimulation` → `runLevel1StaticAnalysis`. When `skeleton=true`, `serv_step_missing_required_input` is skipped. All routing topology checks (dead targets, missing `on_cancel`, unresolved templates, condition keys) still run — these apply equally to skeletons. The skeleton validate step (21b) sets `input.skeleton: true`; the final pre-write simulate (step 25) does not. L1 and L2 level definitions are unchanged.

*`on_cancel` required on all human_gate steps:* The `PGC_StepType` human_gate contract marked `on_cancel` as `required: false`, which LLMs correctly read as optional. This caused persistent `missing_on_cancel` and `missing_cancel_option` L1 failures on skeleton and full steps. Decision: add `on_cancel` explicitly to the human_gate `input_contract` as `required: true`, with a description that makes the coupling to the cancel option explicit. Applied in `seed_PGC_StepType.json` + `upsert-step-type.mjs`; no system code change.


### 6.10 Session Architecture — Chat and Diagnostics

Session architecture — including `PGC_Session` and `PGC_SessionEntry` table design,
the `llm_call` diagnostic flow, `/chat` and `/explain` Slack commands, messages array
reconstruction, and the `diagnostics_config` `PGC_SystemContext` entry — is fully
specified in `docs/session-chat-design.md`.

Table DDL, column definitions, and `PGC_Schema` registration entries are in
`docs/data-architecture.md` section 4.3.4.


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

**Tier 1b — Reactive prompt schema repair** (implemented — Sessions 23–25)
Triggered when an `llm_call` step receives `Agent API error 400` from the structured
output endpoint. This error class means `PGC_Prompt.output_schema` contains constructs
incompatible with the Perplexity/OpenAI structured output spec — not a workflow routing
defect. `TROUBLESHOOT_WORKFLOW` is not appropriate (it analyses `PGC_Workflow.steps`).

`diagnose-prompt-schema.mjs` is a PROC module that:
1. Loads the `PGC_Prompt` row for the failing `intent_category`
2. Runs a deterministic compatibility check against 7 known rules (R1–R7)
3. Produces a repaired schema — no LLM call required; all rules produce unambiguous fixes
4. Creates an ephemeral `PGC_WorkflowRun` (using the `diagnose_prompt_schema` system
   workflow) to host a single human confirmation gate
5. On confirm: writes the repaired schema to `PGC_Prompt.output_schema`, bumps version,
   clears `error_log`, cancels the failed `WorkflowRun`, notifies user to retry
6. On cancel: notifies user, leaves schema unchanged

The repair is deterministic because the API compatibility rules are fully enumerated.
Using an LLM for this repair would be unnecessary and slower.

`run-workflow.mjs` discriminates the 400 error from other LLM errors — `Agent API error 400`
on an `llm_call` step enqueues `DIAGNOSE_PROMPT_SCHEMA` instead of `TROUBLESHOOT_WORKFLOW`.

**API structured output compatibility rules (R1–R7):**

| Rule | Violation | Required form |
|---|---|---|
| R1 | `type: ["object","null"]` — array union | `anyOf: [{type:"object",...},{type:"null"}]` |
| R2 | `additionalProperties: {type:...}` or `true` | `additionalProperties: false` only |
| R3 | Object type missing `additionalProperties` key | Add `additionalProperties: false` |
| R4 | Object type missing `properties` key | Add `properties: {}` |
| R5 | Properties defined but absent from `required` when parent has `additionalProperties:false` | All defined properties must be in `required` |
| R6 | `anyOf` member objects violating R3/R4 | Apply R3+R4 to each `anyOf` member |
| R7 | `model` field contains an unsupported model name | Replace with a supported model name from the approved list |

**Note — R2 correction (Session 25):** boolean `true` is valid for `additionalProperties`.
R2 only flags typed-object forms (`{type:...}`) and `true` values — NOT `false`. The v3
seed corrected an over-broad v2 R2 rule that incorrectly flagged `true`.

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
Level 1, format report, post to Slack. One SQS message in, one `HUMAN_NOTIFICATION` out.

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
  5. enqueueCallback HUMAN_NOTIFICATION with summary

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
       e. For each cancelled run: enqueueCallback HUMAN_NOTIFICATION "Workflow repaired — try again"
       f. enqueueCallback HUMAN_NOTIFICATION with FixWorkflowResponse summary

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
| `DIAGNOSE_PROMPT_SCHEMA` | 1 — fire-and-forget (becomes Category 2 at human gate) | `run-workflow.mjs` on `Agent API error 400` from `llm_call` step | `diagnose-prompt-schema.mjs` |

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

### 6.13 Memory Layer

Full design reference: [`docs/memory-design.md`](memory-design.md).

The memory layer gives LLM calls persistent context across runs, domains, and workflows.
Implemented in Sprint 3; extended in Sprint 4.

#### Key files

| File | Role |
|---|---|
| `src/proc/llm-harness.mjs` | Centralised LLM call assembly — retrieves memories, appends memory block to instructions, handles `save_to_memory` extract+write |
| `src/proc/memory-client.mjs` | `retrieveMemories()`, `expandScope()`, `formatMemoryBlock()` — scope expansion and budget-aware selection |
| `src/proc/memory-writer.mjs` | Handles `MEMORY_WRITE` SQS messages — fire-and-forget episodic writes on domain workflow completion |

#### Three memory types

| Type | Content | Primary consumers |
|---|---|---|
| **episodic** | What happened — distilled activity log, one record per significant workflow completion | `/chat` companion (Sprint 5) |
| **semantic** | What was decided — design facts and schema expectations from `create_domain` and `create_workflow` | `create_workflow` LLM calls, `parse_entity_input` (classify-intent data loads) |
| **procedural** | Why a workflow works the way it does — design intent from `create_workflow` | `fix_workflow`, `troubleshoot_workflow` |

#### Two write paths

**`save_to_memory` on `llm_call` steps** (harness-driven, Sprint 3):
The `reasoning` field is appended to the prompt, extracted from LLM output before schema validation, and written to `PGC_Memory`. Used on `create_domain` (step 10 — episodic), `revise_domain_schema` (step 12b — semantic), `design_table` (step 13 — semantic), `generate_domain_aliases` (step 17b — semantic), `generate_workflow_steps` (step 23 — procedural). Multiple iterations accumulate rows — `insertRow` always creates a new row, never updates.

**`write_memory` step** (workflow-driven, Sprint 3):
Explicit step for writes where content is derived by a prior `js_transform`. Used in `create_domain` step 16c for the post-confirmation structural snapshot (the authoritative semantic record).

**`MEMORY_WRITE` SQS** (fire-and-forget, Sprint 3):
`run-workflow.mjs` enqueues after any qualifying domain workflow completes (domain non-null, not a system workflow). `memory-writer.mjs` writes a deterministic episodic summary at zero LLM cost.

#### Scope and retrieval

Scope is a JSONB object — e.g. `{"domain":"flashcards"}` or `{"workflow":"quiz_flashcards"}`. `expandScope()` derives all parent scopes so domain-level memories are reachable from any compound call scope that includes that domain. Retrieval is client-side (all `PGC_Memory` rows loaded and filtered) — household scale keeps this in the hundreds of rows.

`PGC_Prompt.memory_config` (nullable JSONB) controls retrieval per prompt:
```json
{ "memory_budget_tokens": 600, "memory_types": ["semantic"], "scope_additions": { "domain": "{{input.domain}}" } }
```
`memory_budget_tokens: 0` disables memory for that prompt.

#### Domain memory two-layer provenance (Sprint 4)

`create_domain` writes memories at two distinct points:
- **Pre-confirmation (episodic):** `save_to_memory` on LLM steps (10, 12b, 13) captures reasoning before the user confirms. Correctly labelled episodic — reflects thinking that the user may still revise.
- **Post-confirmation (semantic):** Step 16c `write_memory` fires after "Create it" click, before DDL. Writes a structural prose snapshot: which columns are required at insert, which the DB defaults manage, and which are null at creation. This is the authoritative record retrieved by `create_workflow` and `parse_entity_input`.

**Why this matters for data loads:** `parse_entity_input` (called by `add_entity` in the classify-intent path) now retrieves domain semantic memories (400-token budget, Sprint 4). When a user pastes a bulk spreadsheet of records, the LLM knows which columns to omit at creation (nullable-at-creation) and which initial values to apply — without explicit workflow parameters.

#### initial_value_conventions

`create_domain`, `design_table`, and `revise_domain_schema` prompts emit an optional `initial_value_conventions` array capturing application-level initial values that SQL DEFAULT alone does not express. Example: `interval_days` SQL DEFAULT is 0 but the SM-2 first interval should be 1. These conventions are included in the step 16c structural snapshot and flow through memory to both `create_workflow` and `parse_entity_input`.

---

### 6.14 Prompt Performance Monitoring (Backlog)

#### Prompt Issues Log

A separate document `docs/prompt-issues.md` tracks observed LLM prompt quality problems
across sessions. Each issue records the failure pattern, root cause, actions taken, and
monitor thresholds. This doc feeds the Prompt Performance Monitor (Backlog item 8).

**Active issues as of Session 25:**

| Issue | Prompt | Pattern | Status |
|---|---|---|---|
| 1 | `research_workflow_domain` | Oversized output, occasional validation failures on sonar web search interruption | Mitigated — scope constraints + max_output_tokens added |
| 2 | `analyze_and_design_workflow` | Persistent schema mismatch — LLM produces wrong field names on every attempt | Partially superseded by Issue 5. Re-evaluate after Issue 5 resolved |
| 3 | `fix_workflow_steps` | Produces full 27-step array when only 4 steps needed | Mitigated — step 3 filter + step 4b merge added to fix_workflow |
| 4 | `research_workflow_domain` | Occasional invalid JSON from sonar web-search mid-response interruption | Open — investigate disabling web search via `tools: []` |
| 5 | `analyze_and_design_workflow` (any prompt) | `output_schema` API incompatibility — 400 on every llm_call attempt | Resolved — `diagnose-prompt-schema.mjs` deployed; R1–R7 compatibility rules documented |
| 6 | any prompt with `model` field | Unsupported model name in `output_schema` or prompt output causes 400 | Resolved — R7 rule added; `model` added to `repair_state`; `analyze_and_design_workflow` v10 constrains `prompts_needed.model` to supported values |
| 7 | any LLM response | Model returns prose preamble or explanation wrapped around fenced JSON — Ajv fails on raw text | Resolved — fence extraction regex added to `llm-client.mjs`: strips leading/trailing prose before parse attempt |

#### LLM API capabilities in use

All LLM calls route through the Perplexity Agent API (`/v1/agent`).

| Capability | Status | Notes |
|---|---|---|
| `response_format: { type: "json_schema" }` | ✅ Live (Session 23) | Enforces output schema at model level. Applied when `PGC_Prompt.output_schema` is present. `strict: false` — schema `additionalProperties: false` handles strictness at Ajv validation time. **isSonar guard (Session 25):** only sent when model name contains `"sonar"` — non-sonar models return HTTP 400 with it present |
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

### 6.15 Simulation Error Correction — Retry Methodology (Session 32)

When `create_workflow` simulation fails (Level 1 static analysis at step 16, or Level 2 path execution at step 19), the system loops back to the `generate_workflow_steps` LLM call (step 14) with structured correction context. This section documents the design and the two failure classes fixed in Session 32.

#### Two recurring failure classes

**1. Unsupported Handlebars syntax in `message_template`**

The `design_workflow_dialogs` prompt (step 13) can generate Handlebars-style loop syntax
(`{{#each array}}...{{this.prop}}...{{/each}}`) in `message_template`. Step 14 copies
these templates faithfully. The template resolver only supports `{{key.path}}` dot-notation
— Handlebars control tokens are not valid.

Prior to Session 32, `extractTemplateRefs` extracted `#each available_sets`, `this.set_name`,
and `/each` as if they were ordinary variable references, producing misleading errors like
_"base key '#each available_sets' has not been written by any prior step"_. The correction
signal did not tell the LLM that the syntax itself was illegal, so each correction attempt
re-copied the same template from `dialog_designs` and produced the same errors.

**2. `condition` step `on_success`/`on_else` double `step:` prefix**

Translation Rule 4 in the prompt instructs the LLM to use `step:<key>` format for all
routing targets. The LLM applied this uniformly, including to `on_success`/`on_else` on
`condition` steps. The engine's `executeCondition` and the static analysis both expected
bare keys and unconditionally prepended `step:`, producing `step:step:8` — a dead routing
target that does not exist in the step array.

#### Engine fixes (step-executor.mjs)

| Fix | Location | Change |
|---|---|---|
| Handlebars detection | `runLevel1StaticAnalysis` | Refs starting with `#`, `/`, or equal to `this`/`this.*` emit `unsupported_handlebars_syntax` with an explicit "use indexed dot-notation" message instead of a misleading unresolved-variable error |
| `on_success`/`on_else` normalisation — static analysis | `runLevel1StaticAnalysis` | Strip existing `step:` prefix before wrapping, so both bare keys and `step:N` values produce correct dead-target checks |
| `on_success`/`on_else` normalisation — runtime | `executeCondition` | Strip existing `step:` prefix before constructing `nextAction`, so `"step:8"` and `"8"` are both valid values at execution time |

#### Prompt fixes (generate_workflow_steps v9)

Two rules added to TRANSLATION RULES:

- **Rule 5a** — `message_template` supports ONLY `{{key.path}}` dot-notation. Handlebars syntax is explicitly prohibited. When copying from `dialog_designs`, the LLM must transform any `{{#each array}}...{{this.prop}}...{{/each}}` blocks to indexed access: `{{array.0.prop}}`, `{{array.1.prop}}`, etc.
- **Rule 5b** — `on_success` and `on_else` on `condition` steps take **bare step keys** (e.g., `"8"`) — not `step:N` routing tokens. The engine adds the prefix at runtime.

#### Correction mode — `callLlmWithCorrection` analogue

`callLlmWithCorrection` (in `llm-client.mjs`) is effective because it provides the model
with its previous output alongside specific errors, instructing it to fix only flagged
issues rather than regenerating from scratch. The same principle is now applied to the
`generate_workflow_steps` correction loop:

- Step 14 receives `previous_draft_steps` (`{{draft_workflow.steps}}`) — its last output.
- Step 14 receives `path_errors` (`{{path_error_summary}}`) — Level 2 path failures (distinct from Level 1 `simulation_errors`).
- The prompt enters **CORRECTION MODE** when either error field is non-empty: fix only flagged steps; copy all others unchanged.

Without `previous_draft_steps`, the model regenerated the entire workflow from the design
spec on each retry and made the same transliteration errors. With it, the model has
structural context to make targeted fixes, mirroring the behaviour of `callLlmWithCorrection`.

#### Workflow changes (create_workflow v27)

| Step | Change |
|---|---|
| 14 | Added `previous_draft_steps` and `path_errors` inputs |
| 16a | Fixed `js_transform` expression: `i.message \|\| i.type` → `i.detail \|\| i.check` — user now sees actual error text in 16b instead of "validation issue" × N |
| 19 | `on_else` changed from `step:15` to `step:19a` |
| 19a (new) | `js_transform` — formats Level 2 `simulation_result.path_results` failures into `path_error_summary` |
| 19b (new) | `human_gate` (confirm) — displays `path_error_summary`, offers Regenerate with feedback → 15a, Regenerate automatically → 14, Cancel; mirrors the 16/16a/16b Level 1 retry pattern |

---

### 6.16 Workflow State Flow Analysis — Design Decision

#### Problem

Manual inspection of `create_workflow`'s step array revealed a silent data loss bug:
`user_design_notes` was being written to `local_state` at step 5a but never referenced
by any downstream step. The bug was only visible by reading the full workflow JSON and
tracing the data flow table step by step — it produced no runtime error, no simulation
failure, and no output anomaly. The same class of bug (key written, key never read)
can exist in any user-generated workflow registered by `create_workflow`.

This motivates a systematic approach: a programmatic analysis that reconstructs the
"Data Used / Data Added" table for any workflow automatically and surfaces silent bugs
before or after registration.

#### Evaluation: programmatic state flow analysis

**Option A — Extend Level 1 `simulate` to output a `state_flow` section.**

Level 1 static analysis in `step-executor.mjs` already walks every step and builds a
`known_keys` set tracking what has been written. Extending this pass to also track
`read_keys` and `written_keys` per step produces a complete state flow map at zero
additional LLM cost. The extension is non-breaking: `static_analysis_result` gains a
`state_flow` field that existing consumers ignore.

Detection rules that become trivially derivable:
- **Unreferenced write**: a key is in `written_keys` but never in any step's `read_keys`.
- **Overwrite chain**: a key appears in `written_keys` for more than one step.
- **Read-before-write**: a template variable is in `read_keys` before any step has written it
  (Level 1 already detects this as a hard error; state_flow makes it explicit in output).

This option requires only a `step-executor.mjs` change. It is available to every workflow
that runs a `simulate` step — not just `create_workflow`.

**Option B — Standalone `/proc` endpoint or new SQS message type.**

A `ANALYZE_WORKFLOW` message type would let any user or process request a state flow
table for any registered workflow on demand. The output would be a structured report
suitable for display in Slack or consumed by another workflow step.

**Decision: Option A is correct; Option B is unnecessary given Option A.**

A standalone endpoint would duplicate infrastructure (new SQS message type, new Lambda
handler code, new Slack command routing) and produce output only on explicit request.
Option A produces the same analysis automatically whenever simulation runs — which in
`create_workflow` is every time a workflow is validated, and in `troubleshoot_workflow`
could expose state flow issues for debugging. The `simulate` step type is already the
right locus for all static workflow validation.

**Option B becomes relevant only for analysing already-registered workflows that are
not being regenerated.** If that diagnostic use case is needed, a minimal implementation
is: a new `serv_query PGC_Workflow` step + a `js_transform` that calls the Level 1
analysis function on the stored `steps` array, piped through a notify or LLM_DIAGNOSTIC
message. This requires no new PROC handler and no new SQS type.

#### Integration with `create_workflow` gap detection

`analyze_workflow_gaps` (step 7) runs pre-generation and classifies capability gaps.
State flow analysis runs post-generation (step 16, Level 1) and classifies data flow
gaps in the *generated* step array. These are complementary, not competing:

| Phase | Tool | Question answered |
|---|---|---|
| Pre-generation (step 7) | `analyze_workflow_gaps` | Can this workflow be built? What is missing in schema, prompts, or capabilities? |
| Post-generation (step 16) | `simulate` Level 1 + state_flow | Is the generated step array internally consistent? Are any written keys never read? |
| Post-generation (step 19) | `simulate` Level 2 | Does every execution path reach a valid terminal state with correct data? |

Additionally, the designed `state_map` from `design_workflow_process` (step 12) is the
*declared* state flow. Cross-validating the generated workflow's *actual* state flow
against `state_map` — checking that `output_key` values match the declared `written_by`
keys — closes the loop between design intent and generated output.

#### Implementation — shipped

**Items 1 and 2 are complete** (`step-executor.mjs` — `runLevel1StaticAnalysis`):

- `runLevel1StaticAnalysis` now returns `{ issues, state_flow, unreferenced_writes }` instead of bare `issues[]`.
- `state_flow`: `{ [step_key]: { reads: string[], writes: string[] } }` — per-step map of all base keys read (from template refs, `input_key`, `items_key`, and `condition` expressions) and written (`output_key` at step and option level).
- `unreferenced_writes`: advisory array `[{ key, written_by, note }]` — keys written by any step but never referenced in any step's declared inputs. Does NOT affect `passed`.
- `condition` expression `{{}}` tokens are now validated by Level 1 (previously skipped).
- Option-level `output_key` (modal writes on `confirm`/`review_object` gates) are now tracked as writes in `state_flow`.
- All `runSimulation` return shapes (`Level 1 fail`, `Level 1 only`, `Level 2 complete`) now include `state_flow` and `unreferenced_writes`.
- 74 unit tests pass (26 step-executor + 48 troubleshoot-fix-workflow).

**Items 3 and 4 — Backlog** (surface warnings in workflow UI and retry loop):
- Step 16a `js_transform` could be extended to extract `unreferenced_writes` from `static_analysis_result` and include them as a warnings block alongside hard errors.
- The step generator (step 14) could receive `unreferenced_writes` as advisory context on retry, instructing it to either wire the orphaned key or remove the write.

## 7. Tech Debt Register

> Unresolved items moved to [docs/backlog.md](backlog.md).

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
| `@aws-sdk/client-ssm` | ^3 | ~5M | Apache-2.0 | SSM GetParameter — reads SecureString API keys (OpenAI, Slack signing, etc.) in `embed-client.mjs` | Session 26 |
| `@slack/web-api` | ^7 | ~1M | MIT | Slack API — chat.postMessage, chat.update, Block Kit | bootstrap |
| `ajv` | ^8 | ~100M | MIT | JSON Schema validation — right-brain output validation loop | v3.2-design-domain-foundation |
| `acorn` | ^8 | ~50M | MIT | AST parser for `js_transform` sandbox gate — see Section 6.5.1 | Session 19 |

### Candidates approved for future addition

| Package | Weekly DL | License | Purpose | When |
| `ajv-formats` | ~20M | MIT | Adds `date-time`, `uuid` format validators to Ajv | When output schemas use format keywords |

---

## 10. pgvector — Semantic Search

Extension: pgvector (available on RDS PostgreSQL 15+, no extra cost)
Enable: `CREATE EXTENSION IF NOT EXISTS vector;`

Embedding model: `pplx-embed-v1-4b` (Perplexity), 2560 dimensions, INT8 quantization
Cost: $0.03/million tokens — at household scale ~$0.01/month at heavy use
Used in: `PGC_DomainHelp` (domain resolution), `PGC_Workflow` (workflow routing — Backlog)

**Implemented — Session 26.**

The alias-based domain resolution in `matchDomainAlias` is a structural weakness confirmed
across multiple sessions. "Spanish flashcard quiz", "flashcard quiz", "quiz my Spanish" all
fail to resolve `spanish_flashcards` because the alias list cannot anticipate every user
phrasing. Every new domain will have the same problem. This is not a data maintenance problem
— it is a wrong architectural primitive. pgvector replaces it.

### Two problems pgvector solves

**Problem 1 — domain resolution (Pass 2 of Intent Preprocessor)**
`matchDomainAlias` does substring token matching against `PGC_DomainHelp.aliases`.
Any paraphrase not anticipated at domain-creation time silently returns `domain: null`,
causing `domain_schema: []` to be sent to the LLM which then invents tables that already exist.

Fix: `semanticDomainMatch()` in `classify-intent.mjs` — sends `queryText` to SERV
`getRows` with a `vectorSearch` descriptor. SERV embeds the query and ranks domains
by cosine similarity. Threshold 0.40 (calibrated for pplx-embed-v1-4b).
`matchDomainAlias` runs first as a zero-cost exact check; semantic match only fires
when alias lookup returns null.

**Problem 2 — workflow routing (Pass 2 keyword scan miss)**
Pass 2 uses `intent_keywords` on `PGC_Workflow` for token presence. Novel phrasings
fall through to Tier 2 sonar. After domain is resolved via semantic match, workflow
routing can also use vector similarity against `PGC_Workflow.intent_embedding` — Backlog.

---

### Architectural principle: embedding belongs in the Service tier

Embedding computation is a prerequisite for persistence — the same category of
concern as hashing before storing a password. It is not business logic. Therefore:

- `embed-client.mjs` lives in `src/shared/` but is imported **only by ServFunction**
- `table.mjs` (SERV) calls `embedText()` on `insertRow` and `updateRows` automatically
  when the column's PGC_Schema definition includes `embed_source`
- PROC never imports `embed-client.mjs`. `classify-intent.mjs` sends plain text to
  SERV via `getRows` with a `vectorSearch` descriptor — SERV handles the embedding

This means direct curl calls to SERV endpoints, the backfill script, and
workflow-driven inserts all get embeddings for free with no workflow step type change.

---

### embed_source in PGC_Schema.columns — the authoritative embedding spec

The specification of what text to embed for a vector column lives in
`PGC_Schema.columns` alongside the column's type definition:

```json
{
  "name": "embedding",
  "type": "vector",
  "nullable": true,
  "embed_source": ["domain", "description", "aliases"],
  "comment": "pgvector embedding — SERV auto-computes on insert/update"
}
```

`embed_source` is an array of sibling column names whose values are concatenated
(after normalization) and passed to `embedText()`. This is the single source of
truth — no workflow step, no endpoint, and no application code needs to know which
fields contribute to the embedding. SERV reads it from the schema at runtime.

**Why PGC_Schema is the right home:**

PGC_Schema already owns the column contract (type, nullable, default, constraints).
Embedding is a persistence-time computation that depends on column values — it
belongs in the schema definition, not in workflow step definitions. Any table in the
system (PGC or PGD) can gain semantic search capability by adding a vector column
with `embed_source` — no code changes, only a schema update.

**Normalization before embedding:**

`resolveEmbedding()` in `table.mjs` normalizes each source field value before
embedding. Array fields (e.g. `aliases: ["flashcard", "quiz"]`) contribute each
element as a separate space-delimited token. All values have underscores replaced
with spaces (`spanish_flashcards` → `spanish flashcards`) so snake_case identifiers
tokenize correctly. Only array-type embed_source fields are used — scalar fields
like `description` are excluded because generic management text ("Manage your data")
pulls the centroid away from the user-vocabulary terms in the aliases.

**updateRows read-before-write:**

When any `embed_source` field appears in the `updates` payload, `table.mjs` performs
a `SELECT` of the current row, merges it with `updates`, then recomputes the
embedding from the complete post-update state. This ensures partial updates (changing
only `aliases` without including `description`) produce a correct embedding.

---

### vectorSearch switch on getRows

`getRows` accepts an optional `vectorSearch` descriptor alongside standard `filters`:

```json
{
  "tableName": "PGC_DomainHelp",
  "vectorSearch": {
    "column": "embedding",
    "queryText": "spanish flashcard quiz",
    "threshold": 0.40,
    "limit": 1
  }
}
```

When `vectorSearch` is present:
1. SERV calls `embedText(queryText)` — the caller supplies plain text only
2. SQL uses pgvector `<=>` cosine distance operator to rank and filter rows
3. Each result row gains a `similarity` float field (0–1)
4. Standard `filters` can combine with `vectorSearch` to pre-qualify rows before ranking

**Vector columns are stripped from getRows responses.** The `embedding` field is
never returned to callers. Direct SQL via the bastion is the appropriate path for
inspection or debugging.

---

### embed-client.mjs

`src/shared/embed-client.mjs`:

- **`embedText(text, traceId) → number[]`** — single string, used for query-time
  vectorSearch in `getRows`. Calls the Perplexity embeddings API with one input.
- **`embedTexts(texts[], traceId) → number[]`** — batch embed multiple strings
  and return a component-wise averaged vector. Available for future batch use cases.
  (Currently `table.mjs` uses `embedText` with the pre-concatenated source text.)
- **`parseVector(pgVal) → number[]`** — parse PostgreSQL vector string
  (`"[1,2,3,...]"`) to `number[]`. pgvector returns vector columns as text because
  the `pg` library does not know the `vector` OID.

Credentials are injected into `ServFunction` via CloudFormation at deploy time:
```yaml
EMBEDDING_API_URL: 'https://api.perplexity.ai/v1/embeddings'
EMBEDDING_API_KEY: '{{resolve:ssm:/evolving-mind-ai/llm-api-key}}'
```
The same SSM key is reused for both the agent API (PROC) and the embeddings API (SERV).
No runtime SSM SDK call — CloudFormation resolves `{{resolve:ssm:...}}` at deploy time.

Response format: Perplexity returns base64-encoded signed INT8 per the `base64_int8`
encoding. `decodeBase64Int8()` decodes to `number[]`. pgvector stores as float4 and
normalises internally for cosine distance.

---

### Similarity threshold calibration

| Model | Threshold | Notes |
|---|---|---|
| `pplx-embed-v1-4b` | 0.40 | Calibrated from live data — exact alias matches score ~0.55–0.60; unrelated domains score ~0.08–0.12 |

The threshold is hardcoded in `classify-intent.mjs` as `DOMAIN_SIMILARITY_THRESHOLD`.
Threshold calibration per model should eventually be stored in `PGC_SystemContext.pgvector_config`
so it is adjustable without a code deploy. This is a low-priority Backlog item.

---

### How the Intent Preprocessor uses pgvector

```
PASS 2 — domain resolution (with pgvector, Session 26):
  1. matchDomainAlias() — zero-cost exact substring check against aliases array
  2. If no alias match: semanticDomainMatch() via SERV getRows vectorSearch
     - SERV embeds userInput, returns top-1 domain by cosine similarity
     - Threshold 0.40 — returns null if no domain exceeds it
  3. If domain resolved (either path): matchWorkflowByKeywords() keyword scan
  4. If no keyword match: fall to Tier 2 sonar

PASS 2 Backlog — workflow routing via intent_embedding:
  After keyword-scan miss, embed user input and query PGC_Workflow.intent_embedding
  filtered by resolved domain. Threshold 0.40 (to be calibrated when implemented).
```

Pass 2 domain resolution is also used in `create-workflow.mjs` before creating the
`PGC_WorkflowRun` — so `input.domain` is populated with the best available match
before step 1 (`serv_query PGC_Schema`) runs.

---

### create_domain workflow — automatic embedding on DomainHelp insert

`PGC_DomainHelp.embedding` is populated automatically by SERV on `insertRow` because
the column definition in `PGC_Schema` includes `embed_source: ["domain", "description", "aliases"]`.
No workflow step change is needed. The `serv_insert PGC_DomainHelp` step in
`create_domain` already triggers embedding computation transparently.

---

### Backfill script

`dev_scripts/backfill-embeddings.mjs`:
- Fetches ALL `PGC_DomainHelp` rows (not just null-embedding rows — backfill is
  unconditional so re-running after model or normalization changes recomputes everything)
- For each row: calls `updateRows` with `description` in the updates payload,
  triggering SERV's read-before-write embed path
- Run after: pgvector extension enabled, `embedding` column added, SAM deployed

---

### Status — Session 26

| Item | Status |
|---|---|
| pgvector extension enabled on RDS | ✅ Complete |
| `vector` added to `ALLOWED_TYPES` in `schema.mjs` | ✅ Complete |
| `embed_source` persisted in `addColumn` → PGC_Schema | ✅ Complete |
| `PGC_DomainHelp.embedding` column added via `addColumn` curl | ✅ Complete |
| `seed_PGC_Schema.json` PGC_DomainHelp entry updated with `embed_source` | ✅ Complete |
| `embed-client.mjs` — Perplexity pplx-embed-v1-4b, base64 INT8 decode | ✅ Complete |
| `table.mjs` — auto-embed on insertRow/updateRows; vectorSearch on getRows | ✅ Complete |
| `serv-client.mjs` — vectorSearch param added to getRows wrapper | ✅ Complete |
| `classify-intent.mjs` — semanticDomainMatch via SERV getRows vectorSearch | ✅ Complete |
| `create-workflow.mjs` — domain resolution before WorkflowRun creation | ✅ Complete |
| `backfill-embeddings.mjs` — unconditional backfill via updateRows | ✅ Complete |
| Threshold calibration — 0.40 for pplx-embed-v1-4b | ✅ Complete |
| `PGC_Workflow.intent_embedding` vector column — workflow routing | ⬜ Backlog |
| Threshold config in `PGC_SystemContext.pgvector_config` | ⬜ Backlog |

---

> Security architecture details have been extracted to `docs/security-architecture.md`.

## 15. Tangential Features

> Designs moved to [docs/backlog.md](backlog.md) §2.

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
