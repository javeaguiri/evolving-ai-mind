# evolving-mind-ai — Architecture Decision Log
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.8
Status: Active development — Sprint 9 closed; Sprint 10 upcoming
Last updated: 2026-08-06 (Sprint 9 close — Novia builds workflows: step-type-registry.mjs added; L0 shape check as a `level` selector on runSimulation, replacing the `skeleton` flag; register_workflow gated write tool; option_source on the human_gate contract with static/dynamic render bounds in callback.mjs; L1 numeric-index check and a template walk that descends the whole step input)
Previously: 3.7 — 2026-07-25 — Sprint 8 close — LLM replay harness: fingerprint.mjs + replay-corpus.mjs + proc/replay.mjs + slackbot/replay.mjs; awaiting_llm_break run status; resume_llm/REPLAY/REPLAY_RESUME SQS; /proc/replay endpoints; L1 gate-size check; experience/procedure partition swept clean in callback.mjs via toSlackMrkdwn, zero Slack/mrkdwn references across prompts
Previously: 3.6 — 2026-06-29 — Sprint 6 close (Sprint 7 close did not bump this header); Track P; Expenses/Recipe domains; reveal/reveals; SHUTDOWN SQS; RecursiveLoop: Allow; listPhysicalTables + dropConstraint
Previously: 3.5 — 2026-06-18 — Sprint 5 close; Novia Phase 1; MINDS_EYE/MINDS_EYE_RESUME SQS types; minds-eye.mjs added; PGC_Session/PGC_SessionEntry live

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
| `src/ui/slackbot/callback.mjs` | EXP (listener) | SQS SlackResultsQueue consumer — renders ALL Slack replies (HUMAN_GATE, HUMAN_NOTIFICATION, WORKFLOW_ERROR). `buildInputElement` is the sole place a UI-agnostic form field type ('date') becomes a Slack element ('datepicker') | Changes affect every result message posted to Slack |
| `src/ui/slackbot/form-fields.mjs` | EXP | The `form` gate's block_id contract — `FORM_BLOCK_PREFIX`, `collectFormValues`, `extractFieldValue`. Shared by `callback.mjs` (writes the block_id) and `interactive.mjs` (parses it back into a field map) so the two cannot drift | Changes break form gate value collection |
| `src/proc/handler.mjs` | PROC | HTTP + SQS dual dispatch; SQS batch failure reporting | Changes affect message routing for every PROC invocation |
| `src/proc/classify-intent.mjs` | PROC | 4-pass intent routing pipeline — Pre-pass, Pass 1, Pass 2, Tier 2/3. See Section 6.3 | Changes affect routing of all `/mind` user inputs |
| `src/proc/classify-intent-tiers.mjs` | PROC | Pure classification functions — matchIntentMap, matchDomainAlias, matchWorkflowByKeywords | 50+ unit tests cover these; changes must re-run `node --test tests/unit/*.test.mjs` |
| `src/proc/run-workflow.mjs` | PROC | Step Processor outer loop — loads run, checks idempotency, dispatches to step-executor, enqueues next SQS. See Section 6.5 | Changes affect execution of ALL workflows |
| `src/proc/step-executor.mjs` | PROC | Step type dispatch — one case per step type, zero workflow-specific logic. See Section 6.5.1 | Adding a case = new step type; changing a case = affects every workflow using that type |
| `src/proc/llm-harness.mjs` | PROC | LLM call assembly — memory retrieval, prompt injection, save_to_memory extraction. `selectInjectedContext` is the single source of truth for which PGC_SystemContext rows a prompt injects (shared with the request fingerprint). See Section 6.13 | Changes affect every `llm_call` step in the system |
| `src/proc/fingerprint.mjs` | PROC | Pure request fingerprint for the LLM replay harness — per-`llm_call` component hashes (prompt/input/user_input/model/schema/memory/system_context) + composite, computed at the seam and written to PGC_Session. See `docs/arch-replay.md` §3 | Changes affect replay corpus keying — a fingerprint change invalidates prior recordings |
| `src/proc/replay-corpus.mjs` | PROC | Replay corpus read — looks up a recorded response by `fingerprint_hash` (source-run-first, then global) and classifies drift (hit/soft/hard/miss); `decideReplayAction` maps break policy × lookup status → call/serve/break. SERV reads only. Imported by `llm-harness` (the serve/break decision) and `replay.mjs` (break report). See `docs/arch-replay.md` §3-§8 | Changes affect which recordings a replay serves and when it breaks |
| `src/proc/replay.mjs` | PROC | Replay harness endpoints — `POST /proc/replay` (start/record, a fourth run-entry point), `GET /proc/replay/{runId}` (status + break report), `POST /proc/replay/{runId}/resume` (write resolution → `resume_llm`). Also the `REPLAY` (start/list) and `REPLAY_RESUME` (payload-free break resolution, A11) SQS handlers. HTTP-dispatched by proxy segments. See `docs/arch-replay.md` §9 | Changes affect how replays are started and resumed |
| `src/ui/slackbot/replay.mjs` | EXP | `/replay` Slack command → `REPLAY` SQS enqueue (list, replay, or record). Posts the thread the break notifications reply under | Changes affect the Slack entry to the replay harness |
| `src/proc/minds-eye.mjs` | PROC | Novia agentic loop — context assembly (Layer 1/2), reasoning loop with read+write tools, HUMAN_GATE action confirmation, turn and action limit gates. `register_workflow` (gated) writes `PGC_Workflow` + `PGC_IntentMap`, refusing any step array that fails simulation. Drives the round with **native function calling**: constant parts (system prompt, both context layers, standing instruction) in `instructions`, tool schemas from `PGC_SystemContext.minds_eye_tool_schemas`, and an append-only `input` item array rebuilt once per round by `toInputItems`. Handles MINDS_EYE + MINDS_EYE_RESUME SQS types | Changes affect all `/novia` sessions; gate logic shared with interactive.mjs |
| `src/proc/review-output.mjs` | PROC | Ajv schema + semantic + routing validation of all LLM output. See Section 6.6 | Changes affect validation of every LLM response system-wide |
| `src/proc/simulation-engine.mjs` | PROC | Workflow step array validation — pure function, no I/O. L0 shape (composed from `PGC_StepType.input_contract`, never hand-authored) / L1 static / L2 routing + data-flow, selected by `level`. Full detail: `docs/arch-simulation-engine.md` | Changes affect the pre-write workflow validation gate (`create_workflow`, `fix_workflow`, `upsert-workflow.mjs`), the standalone `POST /proc/simulate-workflow` endpoint (Novia's `simulate_workflow` tool, dev testing), and `troubleshoot-workflow.mjs` |
| `src/proc/step-type-registry.mjs` | PROC | `loadStepTypeContracts` — the single read of `PGC_StepType` on behalf of validation, for L0's four consumers. Deliberately not shared with `llm-harness.mjs`'s own read of the same table, which is column-scoped and ordered because the assembled request is fingerprinted for the replay corpus | Changes affect what L0 enforces everywhere at once; returns null (never `[]`) on a failed read so L0 reports not-run rather than rejecting every step type |
| `src/proc/state-utils.mjs` | PROC | `resolveOutputWrites` — pure interpretation of a step's `output_key` against the value the step produced. A comma list destructures an object return into one key each, skipping a key the object omits; a single `output_key` writes the whole value. A comma list over a value that cannot carry named keys (scalar, null, array) **throws** — there is no correct write, and the alternative is a `local_state` key literally named `"a,b"` with every downstream `{{a}}` rendering as its own literal token. Shared by `run-workflow.mjs` (which writes local_state, resolving inside the step's failure envelope) and `simulation-engine.mjs` (which models it and reports the throw as `output_key_destructure_mismatch`), so the simulator cannot disagree with the engine about what a step leaves behind | Changes affect what every step writes to `local_state` and what the data-flow trace believes it wrote |
| `src/proc/template-resolver.mjs` | PROC | `{{key.path}}` token resolution against `local_state`; expression/condition eval via `vm.runInNewContext` (200ms timeout) | Changes affect template substitution in ALL steps, messages, and conditions |
| `src/shared/serv-client.mjs` | Shared | All PROC→SERV HTTP calls — `getRows` (optional `columns` whitelist), `insertRow`, `updateRows`, `deleteRows`, `servPost` | Changes affect ALL data reads and writes from PROC |
| `src/shared/sqs-callback.mjs` | Shared | SQS enqueue — `enqueueCallback` (results → EXP), `enqueueWorkflow` (WorkflowQueue), `deleteReceivedBatch` (pre-delete on receipt) | One of two AWS SDK imports reachable from PROC — changes affect all async dispatch and result delivery |
| `src/shared/scheduler-client.mjs` | Shared | Amazon EventBridge Scheduler — `upsertSchedule`, `deleteSchedule`, `listSchedules`, plus the pure `validateScheduleName` / `validateScheduleExpression` / `buildScheduledRunMessage`. Isolated for the same reason `sqs-callback.mjs` is: PROC is cloud-agnostic and must not import an AWS SDK. A schedule's target is the **WorkflowQueue**, not a Lambda, because a schedule can only deliver a static payload while a run needs a `PGC_WorkflowRun` row that does not exist until it fires | Changes affect every unattended run; the `SCHEDULED_RUN` message it writes is read by `scheduled-run.mjs` months later |
| `src/proc/scheduled-run.mjs` | PROC | `SCHEDULED_RUN` handler — resolves the workflow by name, creates the run with `triggered_by: 'schedule'` and `callback: null`, enqueues `execute_top`. **No callback is the defining property**: an unattended run has no thread to reply into, so a `human_gate` in a scheduled workflow suspends with nobody to answer it. Reporting is a `notify` step's job | Changes affect all scheduled runs; nothing downstream distinguishes them from Slack-triggered ones |
| `src/shared/llm-client.mjs` | Shared | Perplexity gateway HTTP client — `callLlm` (parsed JSON), `callLlmWithTools` (native tool calling; returns the raw item array so callers can echo it forward for prompt-cache credit), `callLlmWithMessages`, `callLlmWithCorrection`; all POST through one `postToGateway` | Changes affect all LLM calls; `isSonar` guard is the only model-specific branch |
| `src/shared/schema-utils.mjs` | Shared | Pure interpretation of a `PGC_Schema.columns` array — `pickLabelColumn` (which column stands in for a row as its readable value; returns null when none does) | Used by `classify-intent.mjs` (display label for `/m list <table>`) and `step-executor.mjs` (natural key for reference-table FK resolution) — the two differ only in preference order |
| `src/serv/table.mjs` | SERV | SERV-Table DML — SELECT, INSERT, UPDATE, DELETE; gated by PGC_TableMap. See Section 5.2 | Changes affect all row-level DB operations |
| `src/serv/entity.mjs` | SERV | SERV-Entity — assembled entity reads/writes via PGC_EntitySchema joins. See Section 5.3 | Changes affect all domain entity operations |
| `src/serv/query-utils.mjs` | SERV | Pure interpretation of the SERV read wire format — `normalizeOrderBy` (object, SQL string, or array of either → a list of `{ column, direction }` terms) and `buildOrderClause`. Shared by `table.mjs` `getRows` and `entity.mjs` `listEntities` so the two cannot disagree about what a caller may send | Changes affect how every SERV read is sorted; callers must still validate each term's column against the registered schema before rendering |
| `src/serv/schema.mjs` | SERV | SERV-Schema — DDL execution + PGC_Schema + PGC_TableMap registration; `listPhysicalTables`; auto-infers `embed_source` for `X_embedding` vector columns. **The registry must never assert what the database does not**: `dropColumn` uses RESTRICT (never CASCADE — CASCADE silently *deletes dependent views*) and `pruneColumnRefs` clears every constraint and FK referencing the dropped column; `modifyConstraint` **upserts** into `PGC_Schema.constraints` (a CHECK the DB enforces but the registry omits is invisible to `domain_schema`, so the design prompts never see the enum). `target` is read from `PGC_Schema`, never from the caller. See Section 5.1 | Changes affect table creation and schema registration |

### Data — PGC Table Groups

Full column definitions: `docs/arch-data.md` Section 4.3. Curl cookbook: Section 5.5.

| Group | Tables | Written by | Read by | Change impact |
|---|---|---|---|---|
| **Schema registry** | PGC_Schema, PGC_TableMap, PGC_EntitySchema | `create_domain` workflow, `schema.mjs` DDL | `table.mjs` (gatekeeper), `entity.mjs` | Breaks table validation or entity assembly for affected domains |
| **Workflow engine** | PGC_Workflow, PGC_WorkflowRun, PGC_WorkflowRunStep | `upsert-workflow.mjs`, `run-workflow.mjs`, `step-executor.mjs` | `run-workflow.mjs`, `step-executor.mjs` | Schema changes break workflow execution |
| **LLM runtime context** | PGC_Prompt, PGC_SystemContext, PGC_StepType, PGC_Capability | `upsert-prompt/step-type/system-context` scripts | `step-executor.mjs` (`llm_call`), `review-output.mjs` | Changes affect what instructions the LLM receives per call |
| **Intent routing** | PGC_IntentMap, PGC_DomainHelp | `create_domain` workflow, bootstrap seed | `classify-intent.mjs` | Changes affect how user inputs are routed to workflows |
| **Memory layer** | PGC_Memory | `write_memory` step, `memory-writer.mjs`, `save_to_memory` hook | `llm-harness.mjs` (retrieval + injection) | Changes affect memory available to every LLM call |
| **Session layer** | PGC_Session, PGC_SessionEntry | `/chat`, `/explain`, `/novia` (minds-eye.mjs) | `/chat`, `/explain`, `minds-eye.mjs` | Live — Sprint 5; changes affect Novia session continuity and /chat /explain diagnostic threads |
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

> `SCHEDULED_RUN` is a Category 1 message with one difference worth noting: it is enqueued by
> **Amazon EventBridge Scheduler**, not by any part of this system. A schedule can only deliver a
> static payload, so it cannot create the run itself — `scheduled-run.mjs` does that on receipt.
> This is why scheduling needed no new execution path: the Step Processor never learns that a
> schedule started the run. Schedules live in the `${AWS::StackName}-schedules` group and fire via
> `SchedulerInvokeRole`, whose only permission is `sqs:SendMessage` on WorkflowQueue.

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
| `MINDS_EYE` | — | 1 — fire-and-forget | SlackbotFunction (minds-eye.mjs `/novia`), interactive.mjs (Continue/Follow-up modal) | proc/minds-eye.mjs |
| `MINDS_EYE_RESUME` | — | 1 — fire-and-forget | interactive.mjs (gate approval or turn-limit Continue) | proc/minds-eye.mjs |
| `SHUTDOWN` | — | 1 — fire-and-forget | SlackbotFunction (`/shutdown`) | proc/shutdown.mjs — cancels all running/awaiting runs; notifies via HUMAN_NOTIFICATION |
| `REPLAY` | — | 1 — fire-and-forget | SlackbotFunction (`/replay`) | proc/replay.mjs — starts a replay run (`sourceRunId`) or lists recent runs (none) |
| `REPLAY_RESUME` | — | 1 — fire-and-forget | interactive.mjs (break-resolution button) | proc/replay.mjs — resumes a broken replay with a payload-free resolution (`abort`/`call_live`/`use_recorded`); routes to the same resume core as the HTTP endpoint. `supplied` carries a response body and stays HTTP-only (A11, `docs/arch-replay.md` §5/§9) |
| `WORKFLOW_STEP` | `execute_top` | 2 — workflow execution | ProcFunction | proc/run-workflow.mjs |
| `WORKFLOW_STEP` | `resume_gate` | 2 — workflow execution | interactive.mjs | proc/run-workflow.mjs |
| `WORKFLOW_STEP` | `resume_llm` | 2 — workflow execution | proc/replay.mjs resume (HTTP endpoint A5, or `REPLAY_RESUME` button A11) | proc/run-workflow.mjs — resumes a suspended replay break (`docs/arch-replay.md` §5) |
| `WORKFLOW_STEP` | `cancel` | 2 — workflow execution | ProcFunction /shutdown | proc/run-workflow.mjs |

**Design decisions:**
- `BatchSize: 10` — cost optimisation. Up to 10 messages delivered per invocation.
  The one-SQS-message-per-`workflowRunId` rule (Category 2) means batching only ever
  handles *concurrent runs across different workflow runs* — never parallel steps within
  a single run. Category 1 messages have no run ID and are unaffected by this rule.
- `ReportBatchItemFailures` — only failed records return to queue. Successful records
  in the same batch are not reprocessed.
- `VisibilityTimeout: 60s` — messages are deleted at the start of the Lambda handler (`deleteReceivedBatch`) before any step processing. The visibility timeout only needs to cover the window between SQS delivery and delete completion (~1–2s warm, ~30s cold start). 60s gives comfortable headroom.
- `RecursiveLoop: Allow` — the workflow engine intentionally chains SQS hops: each `execute_top` step enqueues the next. AWS Lambda's 16-hop recursive loop detection fires on deep workflows. `RecursiveLoop: Allow` disables the detection for ProcFunction; the circuit breaker is the workflow's own step count and the stack guard in `run-workflow.mjs`.
- `DependsOn: BastionRole` on ProcFunction — prevents parallel CloudFormation update of ProcFunction and BastionRole, which caused `UPDATE_ROLLBACK_FAILED` during IAM propagation races.
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
| `EXPLAIN_STEP_SELECT` | `postExplainStepSelect()` — one button per llm_call step (button carries only `queryId`, no question), threaded under the `/explain` ACK placeholder | `proc/explain.mjs` (`/explain <run_id>` — always resolves, even for a single `PGC_Session` row) |
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

### 3.4 Directory structure

> Per-file responsibilities: Section 1.5 Component Quick Reference (this file). Dev script usage: CLAUDE.md Commands.

```
src/
  ui/slackbot/        Experience tier — Slack I/O, ACK, SQS enqueue. No business logic.
    minds-eye.mjs      /novia slash command — enqueues MINDS_EYE to WorkflowQueue
    chat.mjs           /chat slash command — enqueues CHAT_MESSAGE to WorkflowQueue
    explain.mjs        /explain slash command — enqueues EXPLAIN_QUERY to WorkflowQueue
    replay.mjs         /replay slash command — enqueues REPLAY to WorkflowQueue
  proc/               Process tier — all business logic. No AWS SDK in endpoint modules.
    handler.mjs        Dual dispatch: HTTP (httpMethod) vs SQS (Records)
    run-workflow.mjs   Step Processor outer loop
    step-executor.mjs  Step type dispatch (one case per type, no workflow-specific logic)
    classify-intent.mjs  Intent pipeline entry
    classify-intent-tiers.mjs  Pure classification functions — unit-testable, no I/O
    simulation-engine.mjs  Pure L0/L1/L2 simulator — no I/O, imported by step-executor + dev_scripts
    step-type-registry.mjs loadStepTypeContracts — the one PGC_StepType read that feeds L0
    llm-harness.mjs    LLM call assembly + memory injection
    fingerprint.mjs    Pure request fingerprint for the replay harness (arch-replay.md §3)
    replay-corpus.mjs  Replay corpus lookup + drift classification (arch-replay.md §3-§8)
    replay.mjs         Replay harness endpoints + REPLAY SQS handler (arch-replay.md §9)
    review-output.mjs  Ajv + semantic + routing validation of all LLM output
    minds-eye.mjs      Novia agentic loop — MINDS_EYE + MINDS_EYE_RESUME SQS handler
    shutdown.mjs       /shutdown — SHUTDOWN SQS handler; ack-and-notify pattern; cancels all active runs
    chat.mjs           /chat companion — CHAT_MESSAGE SQS handler
    explain.mjs        /explain diagnostic — EXPLAIN_QUERY SQS handler
  serv/               Service tier — pg client only. No LLM, no SQS.
    schema.mjs         DDL + PGC_Schema/TableMap registration
    table.mjs          Row-level DML gated by PGC_TableMap
    entity.mjs         Assembled entity reads/writes via PGC_EntitySchema
    query-utils.mjs    normalizeOrderBy + buildOrderClause — pure, shared by table.mjs and entity.mjs
    templates/pgc/     PGC_*.json table definitions — static ES module imports (NOT fs.readFile)
    templates/pgc/seeds/  seed_PGC_*.json — consumed by dev_scripts/upsert-*.mjs
  shared/             Pure utilities — no business logic, no tier-specific imports
    lambda-utils.mjs   parseEvent, ok, err, buildReqFromSqs
    sqs-callback.mjs   enqueueCallback, enqueueWorkflow — ONLY @aws-sdk/client-sqs location in PROC
    llm-client.mjs     callLlm, callLlmWithCorrection — Perplexity gateway
    serv-client.mjs    getRows, insertRow, updateRows, deleteRows — all PROC→SERV HTTP calls
    schema-utils.mjs   pickLabelColumn — reads a PGC_Schema columns array, no I/O
dev_scripts/          Manual tooling only — never imported by Lambda code
tests/unit/           node:test unit tests — run with `node --test tests/unit/*.test.mjs`
tests/integration/    Integration tests — require live env vars from .env.test.template
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
- `embed-client.mjs` — `embedText(text) → float[2560]` — Perplexity `pplx-embed-v1-4b` (2560-dim, INT8);
  reads key from `process.env.EMBEDDING_API_KEY`. Active.

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

> Full data architecture details have been extracted to `docs/arch-data.md`. That document covers: PostgreSQL instance overview, naming conventions and bootstrap, all 15 PGC table definitions (columns, indexes, constraints), SERV API endpoints (SERV-Schema, SERV-Table, SERV-Entity), and dev scripts for PGC data management.

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

| Section | Location | Topic |
|---|---|---|
| 6.1 | this file | Process Layer API — HTTP routes and SQS message types |
| 6.2 | this file | Process Layer config tables — PGC as the brain's system memory |
| 6.3 | `docs/arch-intent.md` | Intent Preprocessor — two-pass pipeline, I/O contracts, generic CRUD workflows (6.4) |
| 6.5 | `docs/arch-step-processor.md` | Step Processor execution engine — WorkflowRun, stack, local_state, human gates |
| 6.5.1 | `docs/arch-step-types.md` | Step type reference — all fields, schemas, examples |
| 6.5.6 | `docs/arch-simulation-engine.md` | Simulation engine — L1/L2a/L2b/L2c validation levels, result structure, standalone endpoint (consumer-agnostic — also used by Novia, dev tooling) |
| 6.6–6.16 | `docs/arch-workflow-patterns.md` | Output validation, workflow authoring, memory layer, self-repair, monitoring |

### Design documents

| Doc | Topic |
|---|---|
| `docs/arch-create-domain.md` | `create_domain` workflow — annotated step-by-step reference |
| `docs/arch-create-workflow.md` | `create_workflow` workflow — full design, LLM call chain, L1/L2 |
| `docs/arch-memory.md` | Memory layer — PGC_Memory write paths, retrieval, scope, provenance |
| `docs/arch-session.md` | Session and chat — PGC_Session/PGC_SessionEntry, `/chat`, `/explain` |
| `docs/arch-minds-eye.md` | Minds-eye agent (Sprint 5) — tool catalog, use cases, agentic loop |
| `docs/arch-prompt-rules.md` | Prompt rule placement guide — 7-category framework, migration backlog S1–S11, cross-brain contracts |

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
POST /proc/replay              replay.mjs          — start a replay/record run (LLM replay harness)
GET  /proc/replay/{runId}      replay.mjs          — replay status + break report
POST /proc/replay/{runId}/resume  replay.mjs       — supply a break resolution → resume_llm
```

#### SQS message types (WorkflowQueue)

```
CLASSIFY_INTENT    → classify-intent.mjs
WORKFLOW_STEP      → run-workflow.mjs       (actions: execute_top | resume_gate | resume_llm | cancel)
CREATE_DOMAIN      → create-domain.mjs
CREATE_WORKFLOW    → create-workflow.mjs
REPLAY             → replay.mjs             (start a replay run, or list recent runs)
```

#### SQS message format (WORKFLOW_STEP)

```json
{
  "type":          "WORKFLOW_STEP",
  "workflowRunId": 42,
  "action":        "execute_top | resume_gate | cancel",
  "userResponse":  "confirm | cancel | <item_action.action> | ...",
  "responseData":  { "selectedValue": "...", "inputValue": "..." },
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
| `PGC_IntentMap` | Intent routing table — regex patterns → `intent_category` + `action_type`, the routing signal. Full detail: `docs/arch-intent.md` | Intent Preprocessor | `create_domain` (step 18/21), `create_workflow` (step 35b/36) |
| `PGC_DomainHelp` | Domain registry — aliases, description, CRUD commands per domain | Intent Preprocessor | `create_domain` workflow (step 20) |
| `PGC_Schema` | Schema registry — column definitions per PGD table | SERV (column validation) | `create_domain` workflow (DDL iterator) |
| `PGC_TableMap` | Table routing — maps table names to their database target | SERV (insertRow gate) | `create_domain` workflow (DDL iterator) |
| `PGC_SystemContext` | System-wide config — thresholds, defaults, feature flags | Step Processor, Preprocessor | `init-brain.mjs` / admin |
| `PGC_StepType` | Step type registry — canonical list of valid step types | Right-brain (Backlog) | `init-brain.mjs` |
| `PGC_Capability` | Service registry — external capabilities the brain can reach (e.g. a stock-price service, a thermostat API), not the agent's own tool catalog. Empty today. Carries `endpoint`/`method`/`auth_ref`/`input_schema`/`output_schema` for `category: 'external'`, one row per operation; `auth_ref` is an SSM parameter name, never a credential. **Novia registers capabilities through the gated `register_capability` tool** — the earlier position, that this stays a developer action, was settled the other way in Sprint 10. The external columns are live in both the database and the registry, applied via `addColumn`/`modifyConstraint` — **never via bootstrap, which cannot add a column to an existing table yet upserts the registry anyway** | Sprint 10 (stubbed) | `init-brain.mjs`, `minds-eye.mjs` |
| `PGC_WorkflowStats` | Aggregate view — run counts, failure rates per workflow | Right-brain, monitoring | DB view (auto-maintained) |

#### How these tables are used together in a workflow run

When `create_domain` runs, the Step Processor:

1. Reads `PGC_Workflow` once to load the step array — this is the program
2. Reads `PGC_Prompt` at each `llm_call` step to get the prompt text and schema
3. Writes `PGC_WorkflowRun.stack` and `.state` after every step — persisting the program counter and data bag
4. Writes `PGC_WorkflowRunStep` after every step — idempotency audit log
5. Calls SERV which reads `PGC_Schema` and `PGC_TableMap` to validate and route inserts
6. At the end of the workflow, writes `PGC_DomainHelp`, `PGC_IntentMap` rows (routing the domain to the pre-existing generic `*_entity` workflows with `domain: null` — see `docs/arch-create-domain.md` for the current row shape), and `PGC_EntitySchema` (entity join/aggregation definitions) — making the new domain available to the Intent Preprocessor and SERV-Entity. **`create_domain` does not create any `PGC_Workflow` rows for the domain.** Domain-specific workflows are created separately via `create_workflow`.

The PGC tables are not just config — they are the evolving state of the brain.
The Intent Preprocessor reads from PGC to route incoming intents. The Step
Processor writes to PGC as a side-effect of running workflows. The right-brain
reads PGC to understand what has happened and improve future behaviour.

---

### 6.3 Intent Preprocessor — the kernel

> **Full detail extracted to `docs/arch-intent.md`** — two-pass pipeline, Pass 1a/1b/1c/2/3 logic, I/O contracts, `handoff()` routing contract, `matchIntentMap` sort order, LLM model selection, design principles, generic CRUD workflows (Section 6.4).

The Intent Preprocessor (`classify-intent.mjs`) is the kernel. It receives every free-form user input from `/mind` and routes it to the correct workflow or handler without executing the workflow itself. Direct commands (`/create-domain`, `/help`, `/shutdown`) bypass it entirely.


### 6.5 Step Processor — Execution Engine

> **Full detail extracted to three focused docs:**
> - `docs/arch-step-types.md` — step type reference catalog: `llm_call`, `js_transform`, `human_gate`, `iterator`, `serv_*`, `condition`, `simulate`, `write_memory`, `notify`, `end` — all fields, schemas, examples
> - `docs/arch-step-processor.md` — execution engine internals: PGC_WorkflowRun, execution loop, execution stack, `local_state`, Human-in-the-Loop (gate lifecycle + gate catalog + UI dialog contract)
> - `docs/arch-simulation-engine.md` — simulation engine: L1/L2a/L2b/L2c validation levels, result structure, standalone endpoint — consumer-agnostic, also used by Novia's `simulate_workflow` tool and dev tooling, not just the Step Processor

When the Intent Preprocessor decides a workflow should run, it creates a `PGC_WorkflowRun` row and enqueues `WORKFLOW_STEP execute_top`. The Step Processor (`run-workflow.mjs` + `step-executor.mjs`) takes over: one SQS message per stack frame, one step per invocation. Stack persisted to `PGC_WorkflowRun` before Lambda returns — no in-process state between invocations.


### 6.6–6.16 Workflow Patterns, Validation, and Memory

> **Full detail extracted to `docs/arch-workflow-patterns.md`** — covers:
> - **6.6** Right-brain output validation pipeline (Ajv → semantic → routing rules, correction loop, `PGC_Prompt.error_log`)
> - **6.7** Workflow safety — circuit breakers, Guard 1, `/shutdown`
> - **6.8** `create_domain` workflow (pointer to `docs/arch-create-domain.md`)
> - **6.9** `create_workflow` workflow (pointer to `docs/arch-create-workflow.md`)
> - **6.10** Session architecture — chat and diagnostics (pointer to `docs/arch-session.md`)
> - **6.11** Gap taxonomy — the five gap types and resolution sequence
> - **6.12** Right-brain self-repair — `troubleshoot-workflow`, `fix-workflow`, three tiers
> - **6.13** Memory layer — `PGC_Memory`, two write paths, scope/retrieval, domain two-layer provenance
> - **6.14** Prompt performance monitoring (backlog)
> - **6.15** Simulation error correction — retry methodology
> - **6.16** Workflow state flow analysis — design decision

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

> **Changing the embedding dimension requires updates in two places:** `EMBEDDING_DIMENSION` constant in `embed-client.mjs` AND the `embedding_config` row in `PGC_SystemContext` (seed: `seed_PGC_SystemContext.json`, upsert via `node dev_scripts/upsert-system-context.mjs embedding_config`).

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

> How the Intent Preprocessor uses pgvector (Pass 2 domain resolution) and `create_domain` automatic embedding are documented in `docs/arch-intent.md` — pgvector Integration section.

---

> Security architecture details have been extracted to `docs/arch-security.md`.

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
