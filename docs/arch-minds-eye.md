# Minds-Eye Agent Design
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
## evolving-mind-ai — Sprint 5+ Feature Spec
## (Display name "Novia" — configurable in PGC_SystemContext)

> Part of the evolving-mind-ai architecture docs. Main overview: `docs/architecture.md`. See also: `docs/arch-session.md` (PGC_Session/PGC_SessionEntry), `docs/arch-memory.md` (memory layer), `docs/arch-step-types.md` (step type reference).

---

## 1. Overview

### 1.0 Naming Architecture

The agent has two distinct names:

| Name | Where it lives | How to change it |
|---|---|---|
| **`minds-eye`** | System code: `minds-eye.mjs`, SQS types `MINDS_EYE` / `MINDS_EYE_RESUME`, `session_type = 'minds_eye'` | Code change required — this is a static system name |
| **"Novia"** (or any name the user prefers) | `PGC_SystemContext.minds_eye_preferences.name` | One `updateRows` curl — no code touch, no migration |

This follows the Static System vs Evolving Artifacts boundary. The system code is stable; the user's preferred name for the agent is a runtime preference. All user-facing messages read the display name from `PGC_SystemContext` at session start.

The `/novia` Slack slash command name is registered in the Slack app dashboard (not in system code). It can be changed by reconfiguring the Slack app — no Lambda deployment required.

### 1.1 Agent Overview

The minds-eye agent is the agentic layer of evolving-mind-ai. Where the existing system executes **pre-defined workflows** in response to classified intents, the agent reasons dynamically about the system's current state and decides its own action sequence. It is invoked conversationally via Slack and operates within explicit boundaries defined by fault domain triage.

### 1.1 How Novia Differs from Existing Mechanisms

| | Workflow execution | general_chat | Novia |
|---|---|---|---|
| **Reasoning** | Declarative, pre-defined | Single-pass LLM | Multi-step agentic loop |
| **Actions** | Step types (serv_query, llm_call, …) | None — chat only | Tools (query, write, invoke, fix, inspect) |
| **State** | PGC_WorkflowRun stack | PGC_SessionEntry | PGC_SessionEntry + tool call log |
| **Scope** | Single workflow | Conversational | Cross-system |
| **Data authority** | fix_workflow (human-triggered) | None | Full CRUD on PGD + PGC config + schema — all gated by human confirmation |

### 1.2 Primary Roles

1. **Extender** — extends and improves existing workflows and domain schemas; chains workflows together; handles cross-domain reasoning; performs tasks that currently require multiple human-triggered commands. This is the primary role.
2. **Improver** — modifies data (PGD), configuration (PGC), and schema across all fault domains (Contract, Instruction, Generation). Every write is gated by a human confirmation step. Instruction-domain fixes (prompt rewrites) are proposed and human-confirmed before write. Execution-domain failures (harness bugs) are identified and reported, but not fixed — those require code changes.
3. **Advisor** — surfaces relevant observations noticed in passing during any session: cost patterns, IntentMap coverage gaps, domain health signals, or design issues adjacent to the user's current task. Advisory content is always appended to the direct answer and clearly separated from it — never delivered as an unsolicited session. Novia does not initiate contact; it enriches responses when something worth flagging is visible from the data already read.

---

## 2. Architecture Position

The minds-eye agent lives entirely in the PROC tier. It follows all existing tier boundary rules.

```
Slack /novia → EXP slackbot → SQS WorkflowQueue (MINDS_EYE) → PROC minds-eye.mjs
                                                                       ↓
                                                            [agentic loop — n turns]
                                                                       ↓
                                                   SQS SlackResultsQueue → EXP reply
```

New SQS message types:
- **`MINDS_EYE`** — fire-and-forget entry (no workflowRunId); new session or thread continuation
- **`MINDS_EYE_RESUME`** — resume after a human gate (Continue/Pause/Cancel at turn limit, or action tool approval); routes to `minds-eye.mjs` separately from workflow `resume_gate`

Thread continuation works identically to `general_chat`: the callback handler matches `slack_thread_ts` → `PGC_Session` → resumes the agent session.

The agent creates its own `PGC_Session` row (`session_type = 'minds_eye'`) on first invocation and appends `PGC_SessionEntry` rows per turn, exactly as designed in `arch-session.md`.

---

## 3. Context Assembly

Before Novia reasons about a task, it assembles situational awareness from three sources. This assembly is performed at session start and cached on the session object.

### 3.1 System Context (Layer 1 — Static)

Injected from `PGC_SystemContext`. A new entry with key `minds_eye_system_prompt` describes the agent's role, fault domain authority, available tools, and the tables it may read and write. A second entry `minds_eye_context_index` is a structured JSON index of what to query for situational awareness. A third entry `minds_eye_preferences` holds all user-configurable settings — operational limits, model selection, display name, and tone preferences.

```json
{
  "name": "Novia",
  "model": "anthropic/claude-sonnet-4-6",
  "turn_limit": 8,
  "max_actions_per_session": 5,
  "tone": "concise",
  "advisory_level": "proactive",
  "response_format": "structured",
  "technical_level": "high"
}
```

All keys are read at session start and injected into the system prompt — changing any of them via `updateRows` on `PGC_SystemContext` takes effect from the next session, no deploy required. Tone preferences can also be updated conversationally mid-session via the `update_preferences` action tool (Phase 2).

```json
{
  "on_start": [
    { "table": "PGC_Capability",    "purpose": "what the system can do" },
    { "table": "PGC_WorkflowStats", "purpose": "workflow health — failure rates (registered view, use getRows)" },
    { "table": "PGC_Workflow",      "purpose": "available workflows", "columns": ["name", "domain", "version"] },
    { "table": "PGC_Prompt",        "purpose": "registered LLM prompts", "columns": ["intent_category", "domain", "version"] }
  ],
  "on_domain_task": [
    { "table": "PGC_Schema",        "purpose": "table definitions for the target domain" },
    { "table": "PGC_EntitySchema",  "purpose": "entity definitions for the target domain" }
  ],
  "on_correction_task": [
    { "table": "PGC_WorkflowRun",   "purpose": "recent run history for the target workflow", "limit": 5 },
    { "table": "PGC_WorkflowRunStep","purpose": "step audit log for the failed run — query only if W1 fix confirmed" }
  ],
  "join_paths": {
    "run_to_session_entries": "getRows PGC_WorkflowRun by id → extract session_id → getRows PGC_SessionEntry WHERE session_id = ?",
    "run_to_steps":           "getRows PGC_WorkflowRunStep WHERE run_id = ? ORDER BY id ASC  [W1-conditional]",
    "run_to_workflow":        "getRows PGC_Workflow WHERE id = PGC_WorkflowRun.workflow_id",
    "workflow_stats":         "getRows PGC_WorkflowStats — registered view, filter by workflow_id or unfiltered for full report"
  }
}
```

Novia queries these tables at the start of the relevant task type, not all at once. This keeps the context window focused. The `join_paths` block is injected into the system prompt so Novia can construct multi-table chains without guessing FK relationships.

### 3.2 Memory Context (Layer 2 — Episodic + Semantic)

Novia queries `PGC_Memory` for memories relevant to the task:
- Semantic memories about the target domain or workflow (what design decisions were made)
- Episodic memories about prior correction attempts (what Novia or fix_workflow tried before)
- Procedural memories about the system's known failure patterns

Memory budget: 800 tokens (larger than standard prompts — Novia needs more context than a single-step LLM call).

### 3.3 Diagnostic Context (Layer 3 — On Demand)

When a correction task references a specific run, Novia assembles the diagnostic chain via three `getRows` calls using the `PGC_WorkflowRun.session_id` FK (X1):

```
getRows PGC_WorkflowRun  WHERE id = N         → run metadata + session_id
getRows PGC_WorkflowRunStep  WHERE run_id = N  → step-level outputs  [see W1 note below]
getRows PGC_SessionEntry  WHERE session_id = ? → LLM reasoning for every llm_call step in the run
```

The final call surfaces what the human saw in `/explain` — the LLM's prompt, reasoning, and output for the failing step — giving Novia the same diagnostic context a human reviewer would have before deciding how to fix it.

**Prerequisite: X1 (`PGC_WorkflowRun.session_id` column) must be applied before `get_run_history` is implemented.** Without it the run → session link requires parsing the `stack` JSONB to find embedded `query_id` values, which is brittle and not a reliable basis for the tool.

**W1 conditional — `PGC_WorkflowRunStep`:** The middle call depends on Sprint 5 Track W1's fix-or-remove decision.
- **If fixed:** `getRows PGC_WorkflowRunStep WHERE run_id = N` returns clean per-step rows with status, output snapshot, and retry count.
- **If removed:** step-level data is read from `PGC_WorkflowRun.stack` JSONB directly. The data is equivalent but requires Novia to parse the stack array rather than receiving flat rows. In this case `get_run_history` should document the stack structure so the LLM can navigate it reliably.

Do not implement Layer 3 until W1 is resolved.

---

## 4. Tool Catalog

Novia's "tools" are structured action types it can invoke. Each maps to existing system infrastructure.

### 4.1 Read Tools (no confirmation required)

All single-table lookups use `SERV getRows` directly — no new endpoints required. `PGC_WorkflowStats` is a registered view on `PGC_WorkflowRun` and is accessible via `getRows('PGC_WorkflowStats')`. Multi-table diagnostic chains are sequenced by Novia across multiple `getRows` calls; the key FK paths are documented in `minds_eye_context_index` so Novia can construct chains without guessing the schema.

| Tool | Mechanism | Notes |
|---|---|---|
| `query_table` | SERV `getRows` | Any PGC or PGD table; domain-scoped by default. `PGC_WorkflowStats` accessible as a registered view. |
| `query_entity` | SERV `serv_entity_query` | Returns assembled entity (e.g. full flashcard with reviews) |
| `read_memory` | SERV `getRows` on PGC_Memory | Semantic/episodic/procedural; filter by scope via `jsonb_contains` operator |
| `read_workflow` | SERV `getRows` on PGC_Workflow | Returns steps JSON for inspection |
| `read_prompt` | SERV `getRows` on PGC_Prompt | Returns prompt text + output schema; filter by intent_category + version DESC limit 1 |
| `simulate_workflow` | `POST /proc/simulate-workflow` | Existing PROC endpoint — takes steps array, returns L1/L2 results synchronously. No new endpoint needed. |
| `search_domain_help` | SERV `getRows` on PGC_DomainHelp | Alias and semantic domain resolution |
| `list_tables` | SERV `listTables` | Registered tables per PGC_TableMap |
| `list_physical_tables` | SERV `listPhysicalTables` | What the database actually holds — the registry may not assert it |
| `run_sql` | SERV | Direct read of live data — the tool that lets Novia see what a workflow will operate on |
| `get_run_history` | Three `getRows` calls chained via session_id FK | See §3.3. **Requires X1 applied.** Shape of step-level call depends on W1 decision. |

**FK join paths (documented in `minds_eye_context_index` seed):**

```
PGC_WorkflowRun.session_id  →  PGC_SessionEntry.session_id   (run → LLM reasoning)
PGC_WorkflowRun.id          →  PGC_WorkflowRunStep.run_id    (run → step outputs, W1-conditional)
PGC_WorkflowRun.workflow_id →  PGC_Workflow.id               (run → workflow definition)
```

**Phase 2 option:** If the three-call chain for `get_run_history` proves unreliable in practice (LLM misconstructs a filter or sequence becomes long in context), consolidate into `POST /serv/run/diagnostic` — a single server-side JOIN returning run + steps + session entries. Do not build this in advance of a demonstrated need.

### 4.2 Action Tools (human confirmation gate required)

**Gate policy:** Only destructive operations require a confirmation gate. Change / add / modify / update operations execute immediately — permission is implicit from the request.

As built, tools are partitioned into four sets in `minds-eye.mjs`. Housekeeping tools do not
count against `max_actions_per_session`.

| Set | Tools | Gate |
|---|---|---|
| Inline write | `update_data`, `insert_data`, `upsert_data` | None — executes immediately |
| Gated write | `propose_workflow_fix`, `propose_schema_fix`, `delete_data`, `drop_table`, `create_view`, `drop_view` | HUMAN_GATE before execution |
| Trigger | `run_workflow` | Dispatches a registered workflow to the step-executor engine |
| Housekeeping | `write_memory` | None — silent episodic write |

### 4.3 Out-of-Scope Actions (Novia must never perform)

- Modifying system code (`.mjs` files)
- Dropping or truncating tables
- Modifying `PGC_StepType` definitions
- Modifying `PGC_TableMap` permissions
- Fixing Execution domain failures (harness bugs) — these require code changes

---

## 5. Use Cases

### UC-0: Direct data modification
> "Change the name of Deck 2 to 'Test Deck' and set the description to 'June 1, 2024'"

1. Novia identifies the domain table (e.g. `PGD_flashcard_decks`) using `search_domain_help` + `list_tables`
2. Reads the current row with `query_table` to confirm identity and show current values
3. Posts confirmation gate: table name, row ID, old vs new field values
4. On approval: `update_data` → `updateRows` on the PGD table
5. Reads the row back to confirm the change applied

This is the baseline Novia data interaction — no fault domain analysis required. Any PGD table row can be updated, inserted, or deleted through this pattern.

### UC-1: Improve a workflow (Generation fault domain)
> "Novia, the quiz workflow is routing incorrectly after step 3"

1. Agent reads `PGC_Workflow` steps + run history for the target workflow
2. Runs `simulate_workflow` (L1) on current steps to establish the baseline
3. Reads memory for prior improvement attempts
4. Reasons about the routing issue, produces an improved steps array, runs L1 on the proposed steps. If issues remain, reasons again with L1 failures as additional context. Repeats until L1 passes or the turn budget is exhausted.
5. Posts confirmation gate with the diff:
   - L1 clean: **Approve / Cancel**
   - L1 still has unresolved issues: **Approve anyway / Cancel** with the remaining issues listed
6. On approval: `fix_workflow_steps` → `updateRows PGC_Workflow` (`steps` + `version + 1`) → re-runs L1 as post-write verification
7. Writes episodic memory: what was diagnosed, what was changed, whether verification L1 passed

**Boundary:** If the issue is in a prompt the workflow calls (Instruction domain), the agent surfaces the diagnosis and defers to UC-2 rather than patching the workflow around the bad prompt output.

### UC-2: Fix a prompt (Instruction fault domain)
> "Novia, design_table keeps generating `real` for columns with decimal constraints"

1. Novia reads the `design_table` prompt text
2. Reads episodic memory of prior runs where this failed
3. Diagnoses the fault domain as Instruction (rule missing or ambiguous)
4. **Proposes a prompt rule revision and presents it for human review** — Novia cannot determine the correct instruction without human judgment in this domain
5. Human reviews, edits if needed, approves
6. On approval: `fix_prompt` → updates PGC_Prompt → version bumped
7. Writes episodic memory with the change rationale

**Note:** Novia does not write Instruction fixes unilaterally. The human must confirm the proposed rule is correct before it goes into the prompt. This is a collaborative tool, not autonomous.

### UC-3: Fix or alter a schema (Contract fault domain)
> "Novia, the ease_factor column needs to be numeric(4,2) not real"

1. Novia reads `PGC_Schema` for the target table
2. Identifies the column type mismatch (Contract fault domain)
3. Posts confirmation gate: "I will run `modifyColumn` on PGD_Flashcard.difficulty_level: real → numeric(4,2). This is a DDL change. Approve?"
4. On approval: `fix_schema` → SERV DDL call
5. Writes episodic memory

**Note:** Schema changes are high-risk. Novia must explain the downstream impact (any rows that violate the new constraint) before the gate.

### UC-4: Chain workflows around a decision (Extension)
> "Novia, show me where I overspent last month and adjust this month for it"

1. Novia runs the reporting workflow with `run_workflow` and waits for the run to reach a terminal state
2. Reads the run's output, identifies which categories exceeded plan, and presents them
3. Asks the user what to carry into the current period — the decision neither workflow can make alone
4. Runs the editing workflow with that decision as its input
5. Reads back what was written to confirm the result

The value is step 3. Either workflow alone leaves the user carrying the finding between them by
hand; a chain is worth building only where an observation or a decision sits between the links.
On failure at any link, Novia surfaces it and asks how to proceed rather than attempting an
autonomous fix.

**Boundary:** `run_workflow` dispatches registered `PGC_Workflow` rows to the step-executor.
Operations implemented as PROC endpoints rather than workflows — `delete_domain`, `create_domain`
— are not reachable through it and are not chainable this way.

### UC-5: Inspect and return structured data
> "Novia, show me all my flashcard decks with their card counts"

1. Novia identifies the domain and queries `PGC_EntitySchema` for the entity shape
2. Issues `query_entity` for the flashcards domain
3. Formats and returns structured output in Slack (table or card list)

This is read-only. No confirmation gate.

### UC-6: System optimization
> "Novia, find workflows with high failure rates and tell me what's wrong"
> "Novia, are we making too many LLM calls?"

1. Novia queries `PGC_WorkflowStats` (failure_rate_pct, avg_execution_ms)
2. For high-failure workflows, retrieves recent failed run step outputs
3. Cross-references with PGC_Memory for known issues
4. Produces a ranked report: workflow name, failure rate, most common failure step, suspected fault domain
5. Does not attempt fixes — presents findings for human decision

**Cost pattern variant:** Novia queries `PGC_WorkflowRun` to identify frequently-invoked workflows with no matching `PGC_IntentMap` Pass 1 entry — these pay a Tier 2 LLM inference on every call. For each gap it proposes specific patterns to add. On approval: `update_intent_map` (Phase 2). Advisory output also includes exact Slack slash command strings the user can pin as channel bookmarks to bypass the classification pipeline entirely for high-frequency actions.

### UC-7: Interact with diagnostics
> "Novia, explain run 458 — why did step 11 fail?"

1. Novia retrieves the `PGC_WorkflowRunStep` output for run 458 step 11
2. Looks up the `PGC_SessionEntry` reasoning from the `llm_call` that produced the failing output (via `query_id`)
3. Retrieves any prior `/explain` session entries for the same query
4. Synthesizes a diagnosis, identifies the fault domain, and recommends the correct fix layer
5. If correction is within Novia's scope (Generation domain), offers to proceed to UC-1

### UC-8: User help and cost guidance
> "Novia, how do I add a flashcard?"
> "Novia, what can I do with the flashcards domain?"
> "Novia, how can I reduce my LLM costs?"

1. Novia reads `PGC_DomainHelp` for the relevant domain and `PGC_IntentMap` for registered invocation patterns
2. Reads `PGC_Workflow` names, descriptions, and intent keywords to surface what commands are available and how to invoke them
3. Synthesizes a help response: available commands, exact invocation phrases, and any Slack slash command strings the user can pin as channel bookmarks for one-tap access to frequent actions
4. If the user asks about cost: triggers the cost pattern variant of UC-6 (identify high-frequency workflows lacking Pass 1 coverage)
5. If gaps in `PGC_DomainHelp` or `PGC_IntentMap` are identified during the session, Novia offers to improve them — proposes updated content or new patterns and posts a confirmation gate (Phase 2: `update_domain_help`, `update_intent_map`)

**Boundary:** Slack bookmark/shortcut suggestions are advisory text in Novia's response — the user adds them to Slack manually. No system write is performed for this part of the response.

**Read-only in Phase 1.** The help and advisory capabilities are available immediately via N2 read tools. The `update_domain_help` and `update_intent_map` action tools that close the loop (steps 5) are Phase 2.

---

## 6. Agentic Loop Design

The agent's reasoning loop is **not** implemented as a `PGC_Workflow` row. Pre-defined workflows cannot decide their own next action. The loop lives in `minds-eye.mjs` as a new PROC endpoint.

### 6.1 Loop Structure

```
receive MINDS_EYE (new session or thread continuation)
  ↓
load minds_eye_preferences from PGC_SystemContext
  (name, turn_limit, model, max_actions_per_session)
  ↓
assemble context (Layer 1 + 2; Layer 3 if improvement task)
  ↓
[reason turn — increment turn_count]
  LLM call: given context + conversation history, decide next action
  Output: { action: "tool_name", params: {...}, reasoning: "..." }
        | { action: "respond", message: "...", advisory: "..." }
  advisory is optional — included when Novia notices something worth flagging
  from data already read (cost patterns, coverage gaps, health signals).
  Rendered as a clearly separated section after the direct answer.
  ↓
if action == "respond":
  post to Slack → end turn (await thread reply)
if action is read tool:
  execute → append result to session → loop (reason again)
if action is action tool:
  post HUMAN_GATE (confirm/cancel) → enqueue MINDS_EYE_RESUME
    on approve: execute → append result → loop (reason again)
    on cancel: post cancellation message → end turn
if turn_count >= turn_limit:
  post HUMAN_GATE (choice: Continue / Pause / Cancel)
    Continue → compress session → reset turn_count → loop (reason again)
    Pause    → compress session → post "Session paused. Resume with /novia continue." → end
    Cancel   → close session → end
```

**Session compression (triggered at turn_limit gate on Continue or Pause):**
The full `PGC_SessionEntry` history is replayed to the LLM on every turn. As sessions grow long this expands the context window and increases inference cost. At the turn-limit gate, before continuing or pausing, Novia runs a compression step:
1. Write an episodic memory summarising the session so far — what was diagnosed, what was changed, what remains open (scope: `{ workflow: name }` or `{ domain: name }`)
2. Mark earlier `PGC_SessionEntry` rows for this session as `compressed = true` (requires a boolean column on `PGC_SessionEntry`)
3. On subsequent turns, replay only the compressed summary memory (from PGC_Memory) + the uncompressed tail of the session, not the full entry history

This keeps the context window bounded across long sessions without losing continuity. The summary memory serves as the episodic anchor if the session is resumed later.

**Prerequisite:** `PGC_SessionEntry.compressed` boolean column (nullable, default false). Add via `addColumn` at bootstrap time alongside the other Session/SessionEntry columns.

### 6.2 Session Continuity

Each Novia turn appends to `PGC_SessionEntry`:
- Tool calls are recorded as `role = 'tool'` entries (content = JSON of tool name + params + result)
- On each turn, the LLM receives: any compressed session summary (from PGC_Memory) + all uncompressed `PGC_SessionEntry` rows for this session, ordered by sequence_number. Compressed rows are excluded from replay.

### 6.3 Preferences

All preferences are read from `PGC_SystemContext.minds_eye_preferences` at session start — not hardcoded.

**Operational limits**

| Preference key | Default | Behaviour at limit |
|---|---|---|
| `turn_limit` | `8` | Human gate — Continue / Pause / Cancel |
| `max_actions_per_session` | `5` | Post summary and end session |

**Tone preferences** — injected into `minds_eye_system_prompt` at session start to shape all responses

| Preference key | Default | Options |
|---|---|---|
| `tone` | `"concise"` | `concise` (brief, direct) · `verbose` (full explanations) · `conversational` (natural, flowing) · `formal` (professional, structured) |
| `advisory_level` | `"proactive"` | `proactive` (always append advisory observations) · `minimal` (high-severity only) · `off` (suppress all advisory content) |
| `response_format` | `"structured"` | `structured` (bullets, tables, headers) · `prose` (flowing text, no markdown) |
| `technical_level` | `"high"` | `high` (technical terms, raw JSON/SQL shown) · `medium` (concepts explained in plain language) · `low` (jargon-free, outcome-focused) |

Any preference can be changed with one `updateRows` on `PGC_SystemContext WHERE key = 'minds_eye_preferences'` — no deploy required, takes effect from the next session. Can also be updated conversationally: "Novia, be more concise" → `update_preferences` action tool (Phase 2) proposes the change with a lightweight confirmation gate.

### 6.4 LLM Call Composition and Persistence (current implementation, Sprint 7)

Before the first reasoning turn of any invocation, the user's raw input is written to `PGC_SessionEntry` as its own `role: 'user'` row — this happens once, in `handle()` for a new message or the `followup` branch of `handleGateResume()` for a follow-up question, **before `runReasoningLoop` is ever entered**. The loop itself never writes a `role: 'user'` row; it only ever produces `assistant`/`tool` rows, one per turn.

Each `callLlm` call sends four things — two fixed for the whole invocation, one fixed forever, and one rebuilt on every single turn:

| Component | Source | Rebuilt how often |
|---|---|---|
| `model` | `prefs.model` — `minds_eye_preferences.content.model` | Once per invocation |
| `instructions` (system prompt) | `minds_eye_system_prompt.content.text` + a name/tone/format line appended from `minds_eye_preferences` | Once per invocation, reused every turn |
| `outputSchema` | Fixed `ACTION_SCHEMA` constant in code | Never changes |
| `input` (user message) | `buildUserMessage(layer1Context, layer2Context, workingHistory, prefs)` | Every turn, fresh |

`input` itself concatenates four blocks (`\n\n---\n\n`-joined): `layer1Context` (registered workflows, fetched once per invocation via `assembleContext()`), `layer2Context` (top 5 recent memories by priority, same), the full conversation transcript (every `PGC_SessionEntry` row for this session rendered as `User: ...` / `Assistant: ...` / `Tool (name): ...` lines — grows every turn), and a one-line trailing instruction pointing back to the system prompt's tool catalog and output format.

This full resend on every turn is not a `buildUserMessage` inefficiency to optimize away — it is a hard constraint of the current model/gateway combination. `minds-eye.mjs` calls `callLlm` (flat `instructions` + `input`, no messages array), and the underlying Perplexity Agent gateway only honors native conversation history for `sonar` models; for `anthropic/*` models (Novia's default), that field is silently ignored, so the full context must be manually re-flattened into `input` on every call or the model loses everything from earlier turns. Avoiding this would require switching Novia to a `sonar` model and to `callLlmWithMessages` — a real model-capability tradeoff, not something to change incidentally.

Nothing is written to the DB before a call — the components above are pure reads (`PGC_Workflow`, `PGC_Memory`, `PGC_SessionEntry`, `PGC_SystemContext`). After a call, exactly one `PGC_SessionEntry` row is written, shape depending on the decision:

| Decision | Row written | Other side effects |
|---|---|---|
| `respond` | `{role: 'assistant', content: {action:'respond', message, reasoning, advisory}}` | `minds_eye_turn_count` (cumulative) + `slack_thread_ts` updated on `PGC_Session` |
| Read tool | `{role: 'tool', content: {tool, params, result}}` | none |
| `write_memory` | `{role: 'tool', content: {tool, params, result}}` | separately writes a row to `PGC_Memory` (not `SessionEntry`) |
| Inline write (`update_data`/`insert_data`/`upsert_data`) | `{role: 'tool', content: {tool, params, result}}` | `minds_eye_action_count` incremented |
| Gated write, proposed | `{role: 'tool', content: {tool: '__pending__', action, params}}` | `minds_eye_turn_count` persisted; loop suspends, waits for Slack |
| Gated write, approved (on resume) | `{role: 'tool', content: {tool, params, result}}` | `writeFactualMemory()` — a second, separate `PGC_Memory` write, for `propose_workflow_fix`/`propose_schema_fix` only; `minds_eye_action_count` reset then set to `1` |
| Gated write, rejected (on resume) | `{role: 'tool', content: {tool: '__cancelled__', action, params}}` | `minds_eye_action_count` reset to `0` |
| Unknown/malformed action | none | Slack notification only, loop ends |
| JSON-parse correction retry | none | purely internal — no row until a real decision is reached |

`callLlm` always returns exactly one JSON object matching `ACTION_SCHEMA`: `{ action: "respond", message, reasoning, advisory? }` or `{ action: "<tool_name>", params, reasoning }` — no separate "thinking" field, no multi-part response structure.

---

## 7. Memory Integration

### 7.1 What Novia reads

- **Semantic memory**: domain schema decisions, design rationale
- **Procedural memory**: known failure patterns, prior fix approaches for a workflow
- **Episodic memory**: what happened in previous Novia sessions on the same domain/workflow

### 7.2 What Novia writes

After each completed session:
- **Episodic memory**: what was diagnosed, what was changed, whether the fix worked
- Memory scope: `{ workflow: "target_workflow_name" }` for correction tasks; `{ domain: "target_domain" }` for schema tasks

Novia does **not** write semantic memory — semantic facts about the domain are established by `create_domain` and `create_workflow`, not by Novia correction passes.

---

## 8. New Slack Command

### `/novia <prompt>`

Triggers a Novia session. Examples:
- `/novia the quiz workflow is routing wrong after step 3`
- `/novia show me my flashcard decks`
- `/novia what workflows have the highest failure rate`

Thread replies continue the session (same as `/chat`). Novia posts a brief context acknowledgment at session start ("I'll look into the quiz workflow. Give me a moment.") before the first reasoning turn.

---

## 9. New PGC_Session Fields

The existing `PGC_Session` design (see `arch-session.md`) is extended with one additional session type and two new fields:

| Field | Type | Notes |
|---|---|---|
| `session_type` | varchar | Added value: `'minds_eye'` |
| `minds_eye_turn_count` | integer | Loop counter; triggers human gate at `turn_limit` |
| `minds_eye_action_count` | integer | Action tool counter; session ends at `max_actions_per_session` |

No new tables required. Tool call log entries use `role = 'tool'` in `PGC_SessionEntry`.

---

## 10. Open Design Questions

These require decisions before implementation begins:

1. **Prompt architecture for reasoning turn:** Should the reasoning LLM call use `model` from `minds_eye_preferences` (default `anthropic/claude-sonnet-4-6`) for all turns, or use a cheaper model for tool result summarization? Start with one model; optimize later.

2. **Tool call format:** The agent's LLM output for an action must be a structured JSON object. Use the existing `llm_call` + `review-output.mjs` pattern with a fixed output schema — this reuses tested infrastructure. Native function-calling API (if available via Perplexity) is a future optimization.

3. **Resume gate routing — DECIDED:** Use `MINDS_EYE_RESUME` as a new SQS type routing to `minds-eye.mjs`. This keeps the agent loop and workflow Step Processor completely independent — no `session_type` discriminator needed in `interactive.mjs`.

4. **Instruction domain fixes:** UC-2 — gate (agent drafts, human sees diff, approves or rejects) is simpler and sufficient for Phase 1. Full inline editing is Phase 2.

5. **Agent vs. fix_workflow boundary:** The agent wraps `invoke_workflow fix_workflow` for simple cases. For complex multi-step routing restructuring that `fix_workflow` can't handle, the agent proposes direct step changes via `fix_workflow_steps`. `fix_workflow` remains as a standalone user-triggered option — the agent does not replace it.

---

## 11. Implementation Sequence

Prerequisites (from open work list):
- `PGC_Session` / `PGC_SessionEntry` tables bootstrapped (arch-session.md §11)
- `/chat` and `/explain` commands implemented (arch-session.md §11)
- `PGC_Prompt.domain` column (Track P, X2) in place

Sprint 5 build order:
1. `PGC_SystemContext` seeds: `minds_eye_system_prompt`, `minds_eye_context_index`, `minds_eye_preferences`
2. `MINDS_EYE` and `MINDS_EYE_RESUME` SQS types registered in `handler.mjs` dispatcher
3. `minds-eye.mjs` PROC endpoint — context assembly + reasoning loop (read tools only first)
4. `/novia` Slack command — EXP routing + intent map entry
5. Human gate at turn limit (Continue / Pause / Cancel)
6. Action tools with confirmation gates (`fix_workflow_steps` first — lowest risk, highest value)
7. Memory read/write integration
8. UC-1 (improve workflow, Generation domain) validated end-to-end from Slack
9. UC-5 (inspect data) validated — highest-frequency use case
10. Remaining use cases in priority order

---

## 12. Proposal — workflow generation as a Novia toolkit

> **Status: PROPOSAL — under evaluation. Not scoped, not decided, no implementation.**
> Measurements in this section were taken 2026-07-26 against the live database and the
> `seed_PGC_Prompt` / `seed_PGC_SystemContext` seed files. They are point-in-time findings,
> not configuration.

The proposal is to dissolve `create_workflow` — today a 73-step `PGC_Workflow` row at v85 —
into a set of tools Novia orchestrates, with workflow design patterns held as searchable
entities rather than as prose inside prompts.

### 12.1 The measured problem

| Signal | Value |
|---|---|
| `create_workflow` runs, all time | 98 — 23 completed, 23 failed, 52 cancelled |
| Domain workflows surviving from those runs | 4 |
| `create_workflow` itself | v85, 73 steps, 44 KB of step JSON |
| `create_domain` (declarative output, for contrast) | 39 runs, 22 completed |

The 52 cancellations are the load-bearing number: they are runs abandoned mid-flight. A fixed
pipeline's only response to a mid-run correction is to re-enter the generator with a feedback
string; it cannot inspect, ask, and adjust.

Assembled static instruction per LLM call, before any run-specific input:

| Prompt | Own text | Injected context | Total |
|---|---|---|---|
| `analyze_workflow_gaps` v16 | 7.0 KB | 23.8 KB | 30.7 KB |
| `design_workflow_process` v25 | 18.6 KB | 24.7 KB | 43.3 KB |
| `design_workflow_dialogs` v19 | 14.6 KB | 3.1 KB | 17.7 KB |
| `generate_workflow_steps` v49 | 22.9 KB | 59.6 KB | 82.5 KB |

`step_type_contracts` (22 KB) is injected into three of the four. `generate_workflow_steps`
has gone from v11 to v49 since 2026-05-09 without the defect rate falling — the defect *class*
moved from structural (routing graphs, caught by the simulation engine) to semantic (a row
limit that drops data, a value derived after the step that consumes it), which no validator
reaches.

### 12.2 Four kinds of content are fused in each prompt

The prompts do not have a size problem; they have a partitioning problem. Measured by section
in `generate_workflow_steps`, 23% of the prompt performs the task the prompt is named for.

| Category | Present as | Belongs |
|---|---|---|
| **Archetype knowledge** | `RAW INPUT PARSING STEPS` (64 lines, pivot tables), `FLAT LOOP PATTERN`, the FK-dependency block, the options/reveals feed rules, the reveal-vs-two-gate boundary, all 16.6 KB of `step_usage_patterns` | Retrieved on relevance |
| **Orchestration** | `CORRECTION MODE` (59 lines); the revision, consolidation and routing-repair passes in `design_workflow_process`; `PREPARATION-STEP RULE` | Deleted — the agentic loop is the orchestrator |
| **Registry transcribed as prose** | A hand-maintained list of 20 prompt names; `step_type_contracts` resident in three prompts; a literal CHECK-constraint enum | Queried at need |
| **Capability instruction** | `TRANSLATION RULES`, `DATA PROVENANCE CHECK`, `SCOPE`, `ECONOMY`, Guards 1 and 3 | Retained |

Corroboration: `analyze_workflow_gaps` is the shortest of the four (75 lines), carries almost
no archetype content, does one job, and is not a source of recurring defects.

### 12.3 Archetype registry

Six archetypes are recoverable from the existing prompt text — they are already written there,
as prose, where they cannot be searched, versioned, or selectively retrieved. Four correspond
to workflows that survive in `PGC_Workflow` today.

| Archetype | Stated today in | Specimen |
|---|---|---|
| Select-scope → list → edit-one → save → re-list | `design_workflow_process` (save-and-continue rules), `design_workflow_dialogs` (`action_key`), `workflow_routing_rules` 6b | `edit_budget` |
| Per-row form, bounded by a gate field ceiling | `design_workflow_process` (data-driven form rule), `design_workflow_dialogs` (data-driven field lists) | `edit_budget` |
| Hierarchical select — self-referential FK, reveals per parent, options per leaf | `design_workflow_process` (hierarchical trigger), `design_workflow_dialogs` (accordion) | flashcard decks |
| Stimulus → reveal → rate, one gate | `design_workflow_process` (reveal vs two-gate), `design_workflow_dialogs` (summary-with-details) | `flashcard_quiz_session` |
| Paste → parse → FK-gap resolve → bulk insert | `design_workflow_process` FK-dependency block; `generate_workflow_steps` raw-input section | `import_budget_spreadsheet` |
| Query → aggregate → format → report | `analyze_workflow_gaps` (deterministic formatting test), `design_workflow_dialogs` (tabular reveal) | `budget_vs_expense_report` |

The FK-dependency block in `design_workflow_process` is already a parameterised template with
slots (`load_<ref>_records` → `check_missing_refs` → `has_missing_refs` → `confirm_new_refs` →
`insert_ref_records`). The system has independently arrived at archetypes and stored them in
the one place they cannot be used selectively — every generation pays for them, including
generations with no FK dependency.

**Storage.** An archetype table with a vector column carrying `embed_source` gains semantic
search with no code change (`architecture.md` §10) and is reachable through the existing
`vectorSearch` descriptor on `getRows`. Archetypes are data, so Novia adding one is a row
insert, not a deploy — consistent with the Static System vs Evolving Artifacts boundary and
with her Extender role (§1.2).

**Effect on the phases.** On a matched archetype, process design narrows to binding schema
columns to declared slots, and translation may reduce to a deterministic template fill with
no LLM call at all.

### 12.4 The phases become guidelines, not tools

`create_workflow` is not stepped through and not wrapped. The phase sequence is a sound
decomposition of the *work* and survives as **procedural guidance**; what does not survive is
each phase being a prompted single-shot call that emits a whole structured document.

The phase split was introduced because one LLM call asked to hold gap classification, process
design and dialog design at once had to satisfy incompatible output schemas simultaneously,
and produced schema violations on every run. That failure is a property of single-shot document
generation, not of the decomposition. A turn-based loop emits one `{action, params, reasoning}`
decision per turn and never holds two output schemas at once, so the constraint does not apply
and the phases can go back to being what they describe: an order of work.

**The dividing line: a tool is for something that acts. Guidance is for reasoning.**

| Remains a tool | Becomes guidance |
|---|---|
| `simulate_workflow` — L1/L2 over a candidate step array | research and option-framing |
| `query_table`, `run_sql` — read the data the workflow will operate on | gap analysis |
| `search_archetypes` — match a shape (new) | process design |
| `validate_workflow_shape` — L0 structural validation (new) | dialog design |
| `register_workflow` — write `PGC_Workflow` + `PGC_IntentMap` (new, gated) | |

Removed outright: the sonar research call (it re-derives what `PGC_Schema` already holds), the
preference-gate iterator, the review and registration gates, and the correction loops. All
become conversation in the thread.

#### The build procedure

Written as guidance, not as a routing graph. The order is a default a reasoning agent may
depart from with cause, not a topology:

1. **Ground in what exists.** Read the domain schema. Then read the *data* — row counts,
   distinct values on enum columns, the actual span of a date column. Schema says what may be
   there; only the data says what is.
2. **Propose and choose, with the user.** Surface the options that materially change the shape
   of the workflow, framed against what the data showed, and settle them in conversation. Only
   raise a question whose answer changes the design.
3. **Match an archetype.** On a match, its `design_rules` and `topology` load; on no match,
   design the sequence from the capability instruction.
4. **Skeleton first, and test its assumptions against the data as it is built.** Every
   assumption the shape depends on — that a list fits one gate, that a value the user picks can
   be decomposed before the step that queries on it, that a query without a limit returns what
   the report needs — is checkable against rows that already exist, before any content is
   generated.
5. **Fill, simulate, register.** `simulate_workflow` gates the step array; `register_workflow`
   writes it.

Step 4 is the point of the whole design. The defects that motivated it — a row limit smaller
than the data, a composite gate value consumed before it was decomposed — are invisible to a
single-shot designer that receives the schema as text, and obvious to one that can count the
rows first.

#### Where the guidance lives

- **How to build any workflow** — a `PGC_SystemContext` row injected into
  `minds_eye_system_prompt`. Always resident, so it must stay small.
- **How this shape of workflow behaves** — `PGC_Archetype.design_rules`, loaded only on a
  match (§12.9).
- **What the engine will accept** — queried, not transcribed: `PGC_StepType`, `PGC_Prompt`,
  `PGC_Schema`.

Dialog design is the clearest case, because the current prompt fuses all three:

| Knowledge | Source | Loaded |
|---|---|---|
| Gate types; `form` is the only type that collects input; `output_key` writes only on form, confirm-with-`context_key`, and choice; a field `type` names what is collected, never a widget; option-count caps; `list_selection` requires `item_action` | `PGC_StepType` `human_gate` contract | Queried |
| Reveal versus two gates; hierarchy as reveals-per-parent with options-per-leaf; per-option `iterator` for data-driven buttons; per-row form and its field ceiling | `PGC_Archetype.design_rules` | On match |
| The fields are the display — do not restate field values in the message body | `PGC_SystemContext` | Always |

Gate mechanics are currently asserted in three places — the `human_gate` contract in
`PGC_StepType`, `workflow_constraints`, and `design_workflow_dialogs` prose — and have already
drifted between them. Collapsing them to a single queried source removes a standing instance of
the two-consumers-of-one-truth failure (checklist rule 2e).

#### L0 — structural validation as a gate before simulation

Retiring the `llm_call` steps also retires their Ajv gate: `review-output.mjs` validates LLM
output against `PGC_Prompt.output_schema`, and in a conversational build there is no prompt row
to validate against. Structural checking is restored as a **level below L1 in the existing
simulation engine**, run twice — once on the skeleton, once on the filled array — before any
simulation:

| Level | Question |
|---|---|
| **L0** | Is this a well-formed step array? Required fields present, types correct, no unknown fields |
| L1 | Does the routing form a reachable, terminating graph with resolvable templates? |
| L2 | Does data flow correctly along the paths? |

Two constraints on the implementation:

- **The schema is composed from `PGC_StepType.input_contract`, never hand-authored.** A separate
  step-array schema would restate what the step type registry already asserts, and the two would
  drift — the same failure as the gate mechanics above. Composing it also keeps L0 correct
  automatically when a step type changes.
- **It extends `simulation-engine.mjs` rather than sitting beside it.** A parallel Ajv validator
  would overlap L1's existing `serv_step_missing_required_input` content-completeness check;
  that check is a shape assertion and belongs in L0. Two schemas — skeleton and filled — also
  replace the current `skeleton: true` flag threaded through `runSimulation` to suppress it.

L0 belongs to the Validation fault domain and is system code, consistent with the triage map.

### 12.5 What is removed rather than migrated

- The three correction passes in `design_workflow_process` and `CORRECTION MODE` in
  `generate_workflow_steps` — the loop is the orchestrator.
- The routing skeleton lock, and with it `PREPARATION-STEP RULE`, whose stated justification
  is that translation may not add a step. That constraint exists to make a rigid pipeline safe.
- The correction-state bookkeeping steps and the L1/L2 failure branches in the workflow itself.

### 12.6 Properties of Novia this proposal depends on

- `minds-eye.mjs` calls `callLlm` from `llm-client.mjs` directly. The replay fingerprint and
  corpus machinery lives in `llm-harness.mjs`, so Novia's reasoning turns are not fingerprinted
  and not replayable. Her full turn history is written to `PGC_SessionEntry` (tool, params,
  result per turn), so a session is readable after the fact but not re-executable.
- Phase tool calls carry the shape `computeFingerprint` expects — prompt category, resolved
  input, output schema, model — so they are candidates for fingerprinting independently of
  Novia's own turns.
- `turn_limit` and `max_actions_per_session` are `PGC_SystemContext` preferences, adjustable
  without a deploy (§6.3). Their current defaults are far below what a workflow build requires.

### 12.7 Open questions

**Direction set — `create_workflow` is dissolved outright**, rather than retained as a
deterministic path for archetype-matched requests. Gated on evaluating Novia's capability first:
the hybrid stays available as a fallback only if that evaluation fails, and is not designed for
in advance.

Remaining open:

1. Cost per *delivered working workflow* for a Novia-driven build, measured against the current
   baseline. Unmeasured today for either approach, and the evidence the dissolution decision is
   gated on.
2. Which of the six archetypes are genuinely distinct versus parameterisations of one another,
   and what `topology` and `slots` actually hold — both are empty in the seed pending distillation
   of the four surviving generated workflows.
3. Whether producing the final step array stays a tool. It is bulk mechanical output, which suits
   a focused single-shot call and keeps a large JSON artifact out of the transcript — but on a
   matched archetype it may be a deterministic fill needing no LLM call at all. The only phase
   whose side of the tool/guidance line is undecided.
4. Turn and action budgets. `turn_limit` and `max_actions_per_session` are far below what a build
   requires, so session compression at the turn-limit gate (§6.1) becomes load-bearing rather
   than incidental.
5. Whether L0 is a distinct `validate_workflow_shape` tool or a `level` selector on the existing
   `/proc/simulate-workflow` endpoint. A distinct tool makes "validate, then simulate" a legible
   two-step for a reasoning agent and yields sharper errors; a selector avoids a new endpoint.

### 12.8 Defects surfaced by the prompt sweep

Recorded as evidence for §12.2, not as a repair list. Under this proposal all four prompts are
partitioned and retired, so repairing them in place would be work on documents with no future —
and editing prompt text churns the replay fingerprint of every recording made against it. The
one operational consequence is that `create_workflow` should not be run while these stand.

Found 2026-07-26:

- **`design_workflow_dialogs` v19 is spliced and partly duplicated.** A JavaScript fragment is
  welded onto the sentence `Return ONLY a valid JSON object …` at line 68 of 138. Seventy lines
  of instruction — including every `form` gate rule — follow the prompt's own terminating
  instruction. Lines 126–136 duplicate 56–66 verbatim and re-inject `human_gate_dialog_rules`
  a second time. The severed fragment is the tail of a worked example, not of a rule: the
  `REVEAL CONTENT RULE` it illustrates survives intact at line 53 and is already carried into
  `reveal_and_rate.design_rules`, so extraction loses nothing.
- **Live user-domain data in system prompts**, against the rule in `CLAUDE.md`: a literal
  budget CHECK-constraint enum in `design_workflow_process`; budget-domain state keys and step
  labels in `design_workflow_dialogs`; recipe and pantry tokens in `generate_workflow_steps`;
  flashcard identifiers in `step_usage_patterns`.
- **The gate field ceiling is stated three times** across two prompts in three phrasings.
- **The list of 20 known prompt names in `generate_workflow_steps` is hand-maintained and
  stale** — it still names a prompt from the v3 design.

### 12.9 `PGC_Archetype` — implementation outline

A seventeenth PGC table. System config, so `PGC_` prefixed, `target: pgc`, and subject to the
same bootstrap-and-seed treatment as the existing sixteen.

#### Shape

Modelled on `PGC_DomainHelp`, which is the existing table that combines a registry with
semantic retrieval.

| Column | Type | Purpose |
|---|---|---|
| `id` | serial PK | |
| `name` | text, not null, unique | Stable identifier, snake_case |
| `description` | text | One line — what shape of workflow this is |
| `aliases` | jsonb, default `'[]'` | Retrieval vocabulary. **This is what the embedding is built from** |
| `preconditions` | jsonb, default `'{}'` | Machine-checkable applicability, so matching is not purely semantic — e.g. the source table carries a self-referential FK, or the request names an existing populated table |
| `slots` | jsonb, not null, default `'[]'` | Declared bindings the archetype needs — table, columns, labels, ceilings. One entry per slot: name, type, how it is resolved |
| `topology` | jsonb, not null, default `'[]'` | The step skeleton — step_labels, step types, routing fields, slot tokens. Same shape as the `routing_skeleton` the current pipeline builds at step 21a |
| `design_rules` | text | The archetype-scoped prose extracted from the four prompts. Injected **only** when this archetype is selected |
| `source_workflow` | text, nullable | Provenance — the specimen it was derived from |
| `status` | text, default `'live'` | `live` / `draft`, mirroring `PGC_StepType` |
| `version` | integer, default 1 | |
| `created_by` | text | `seed` or `novia` |
| `embedding` | vector, nullable | `embed_source: ["aliases"]` |
| `created_at` / `updated_at` | timestamptz, default `now()` | With the standard `set_updated_at()` trigger |

**`embed_source` must name array columns.** `resolveEmbedding` in `table.mjs` uses only
array-type source fields — scalar columns listed there contribute nothing, because generic
description text pulls the centroid away from user vocabulary (`architecture.md` §10). So
`aliases` has to carry the retrieval terms; listing `name` or `description` alongside it would
be inert.

**`design_rules` is the destination for the extracted category-1 content** in §12.2. Its value
is that it is *conditional*: the FK-dependency block is loaded when the FK archetype matches
and not otherwise, which is the whole difference from the prose-in-prompt arrangement.

#### Creation path — one path, not two

`createTableFromTemplate` issues `CREATE TABLE IF NOT EXISTS`, so bootstrap is idempotent and
re-running it on the live instance creates only the table that is missing. There is no need
for a separate `schema/createTable` call, and none should be made — the table is created the
same way the other sixteen were:

1. `src/serv/templates/pgc/PGC_Archetype.json` — a static ES module import in `init-brain.mjs`,
   appended to `PGC_TEMPLATES`. Bundled by esbuild, never read via `fs`.
2. Registration rows appended to `seed_PGC_Schema.json` and `seed_PGC_TableMap.json`.
   `PGC_TableMap` is not optional: `table.mjs` gates all row access on it, and `seedPGCTableMap`
   skips any table with no `PGC_Schema` row, so both are required.
3. `POST /api/v1/serv/bootstrap` after deploy. Existing tables report as already present.

#### Seeding and maintenance

- `src/serv/templates/pgc/seeds/seed_PGC_Archetype.json`, one row per archetype in §12.3,
  seeded by `seedPGCArchetype` as bootstrap step 12.
- `ON CONFLICT (name) DO UPDATE` on the seeded columns. `created_by` is deliberately excluded
  so an archetype Novia authored keeps its provenance if it is later moved into the seed file.
  Rows Novia writes are not in the seed file and are never touched by bootstrap.
- `dev_scripts/upsert-archetype.mjs`, following the `upsert-step-type.mjs` pattern —
  content-fingerprint comparison, then `updateRows` or `insertRow`. Seeded rows are never
  edited by direct `updateRows`.
- The script never writes `embedding`. SERV computes it from `embed_source` on insert, and on
  any update whose payload touches `aliases`. Rows inserted before the column was populated
  need `dev_scripts/backfill-embeddings.mjs`, which currently targets `PGC_DomainHelp` only and
  would need extending.

#### Access

- **Read** — no new endpoint. `getRows` on `PGC_Archetype` with a `vectorSearch` descriptor
  against `embedding`. Vector columns are stripped from `getRows` responses, so the payload
  stays small. Surfaced to Novia as a `search_archetypes` read tool, alongside the existing
  `query_table` / `run_sql`.
- **Write** — `insertRow` / `updateRows`. Novia adding an archetype is a system-config change,
  so it belongs in `GATED_WRITE_TOOLS` (§4.2) rather than executing inline.
- **Threshold** — `PGC_DomainHelp` uses 0.40 for `pplx-embed-v1-4b`, calibrated against domain
  aliases. Archetype aliases describe workflow shapes rather than domain nouns, so the
  threshold needs its own calibration against real requests and should not be assumed to carry
  over.

#### Documentation required at implementation

- `docs/arch-data.md` — new PGC table definition and any curl additions to §5.5.
- `docs/architecture.md` — §1.5 PGC table groups; §3.4 directory listing if a dev script is added.
- `openapi.yaml` — no change expected; the table is reached through the generic `getRows` /
  `insertRow` routes.
