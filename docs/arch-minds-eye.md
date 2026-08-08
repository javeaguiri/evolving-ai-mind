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
| Gated write | `register_workflow`, `propose_workflow_fix`, `propose_schema_fix`, `delete_data`, `drop_table`, `create_view`, `drop_view` | HUMAN_GATE before execution |
| Trigger | `run_workflow` | Dispatches a registered workflow to the step-executor engine |
| Housekeeping | `write_memory` | None — silent episodic write |

**`register_workflow`** (Sprint 9, AC4) — `{ name, domain?, description, steps, intentPhrases?,
intentKeywords? }`. Creates a workflow: one `PGC_Workflow` row at version 1, and one
`PGC_IntentMap` row per invocation phrase plus one for the workflow's own name (`source`
distinguishes `name` from `auto`). It is the write end of the path the convention bridge opens —
Novia designs a step array in conversation, simulates it, and registers it, with no
`create_workflow` involvement.

Two boundaries hold it in place:

- **It refuses to write a step array that does not validate.** The same L0+L1+L2 verdict is
  computed once and used twice — shown in the gate so the human is approving a known-good
  array, and re-checked at execution. The issues come back on refusal so the next turn can
  correct and re-propose. `dev_scripts/upsert-workflow.mjs` refuses to ship a seed that fails
  validation; a workflow arriving from a conversation gets the same gate.
- **It creates, it never updates.** A name that already exists is an error naming
  `propose_workflow_fix`, so neither tool can silently do the other's job.

A failed `PGC_IntentMap` write is reported rather than swallowed: the workflow exists but no
phrase reaches it, and that is a state the next turn has to know about.

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
  execute → append result to session → report the turn → loop (reason again)
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

**Per-turn progress reporting.** Between the opening request and the final reply the only
things a user sees are gates. Over a build that is a long silence, so every **successful**
turn posts a one-line `HUMAN_NOTIFICATION`: the turn number, the tool, and the `reasoning`
the decision already carried. No second model call — the field exists on every decision and
until now reached only CloudWatch.

Reported: read tools, housekeeping, inline writes, triggers. Not reported: `respond` and
gated writes, each of which already produces the message the user is meant to read.

A turn whose tool returned an error is **skipped** — `turnSucceeded()` treats an `error`
field or `success: false` as a failure. A malformed request the agent is about to correct
describes flailing rather than progress; the error still reaches the model through the tool
result, which is what has to act on it. An empty-but-valid result is reported: no rows found
is an answer.

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
| `turn_limit` | `12` | Human gate — Continue / Pause / Cancel |
| `max_actions_per_session` | `8` | Post summary and end session |

`turn_limit` is a **per-invocation** budget, not a per-session one: the Continue button
starts a fresh round with the transcript intact. Raising it does not remove the boundary,
it moves it — which is why the system prompt carries a pacing instruction telling Novia to
choose her own stopping points (something the user can accept or reject, with the state
that must survive written down first) rather than letting the round end wherever it lands.
The budget is the backstop; the pacing instruction is what makes the stop legible.

**Tone preferences** — injected into `minds_eye_system_prompt` at session start to shape all responses

| Preference key | Default | Options |
|---|---|---|
| `tone` | `"concise"` | `concise` (brief, direct) · `verbose` (full explanations) · `conversational` (natural, flowing) · `formal` (professional, structured) |
| `advisory_level` | `"proactive"` | `proactive` (always append advisory observations) · `minimal` (high-severity only) · `off` (suppress all advisory content) |
| `response_format` | `"structured"` | `structured` (bullets, tables, headers) · `prose` (flowing text, no markdown) |
| `technical_level` | `"high"` | `high` (technical terms, raw JSON/SQL shown) · `medium` (concepts explained in plain language) · `low` (jargon-free, outcome-focused) |

Any preference can be changed with one `updateRows` on `PGC_SystemContext WHERE key = 'minds_eye_preferences'` — no deploy required, takes effect from the next session. Can also be updated conversationally: "Novia, be more concise" → `update_preferences` action tool (Phase 2) proposes the change with a lightweight confirmation gate.

### 6.4 LLM Call Composition and Persistence (native tool calling, Sprint 10)

Before the first reasoning turn of any invocation, the user's raw input is written to `PGC_SessionEntry` as its own `role: 'user'` row — this happens once, in `handle()` for a new message or the `followup` branch of `handleGateResume()` for a follow-up question, **before `runReasoningLoop` is ever entered**. The loop itself never writes a `role: 'user'` row; it only ever produces `assistant`/`tool` rows, one per turn.

Each `callLlmWithTools` call sends four things — three constant for the whole round, and one that grows by appending:

| Component | Source | Rebuilt how often |
|---|---|---|
| `model` | `prefs.model` — `minds_eye_preferences.content.model` | Once per round |
| `instructions` | `minds_eye_system_prompt.content.text` + name/tone/format from `minds_eye_preferences`, then `layer1Context`, `layer2Context` and the standing instruction | Once per round, reused every turn |
| `tools` | `minds_eye_tool_schemas` in `PGC_SystemContext`, filtered to what the loop can dispatch | Once per round |
| `input` | `toInputItems(workingHistory)` once at round start, then **appended** each turn | Never rebuilt mid-round |

`input` is an array of canonical items, not a rendered string. Each turn pushes the gateway's own returned items — the `function_call` it emitted, carrying its server-assigned `call_id` — followed by a `function_call_output` holding the tool's result. Nothing earlier in the array is ever rewritten.

**Everything constant belongs in `instructions`, and nothing that varies per turn may go there.** `instructions` sits ahead of the whole transcript, so a change to it invalidates the round's entire cached prefix. The same is true of `tools`, which render ahead of `instructions`.

This shape is what makes a round affordable, and the reason is measured rather than assumed. Appending canonical items earns full incremental prompt-cache credit: `cache_read` on turn N equals turn N−1's entire input, and `cache_creation` stays flat at the per-turn increment no matter how long the transcript grows. Rendering the same transcript into one string instead earns credit for the `instructions` block alone and re-creates everything else every turn, which is quadratic in turn count. Over an eight-turn round the difference measured 172,279 created tokens against 36,138.

**One shape rule follows from the same measurements: never append a user message mid-round.** A single trailing user item forfeits the whole prefix credit for that turn. The only place the loop does it is the truncation notice, which follows a call that never completed and so has no `call_id` to attach to; that costs one turn's credit and re-asks are rare. Malformed tool arguments, by contrast, *do* have a call to answer, so they are returned as that call's `function_call_output` and cost nothing.

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
| Text reply with no tool call | `{role: 'assistant', content: {action:'respond', message, ...}}` | treated as a `respond` — the model answered in prose rather than calling the tool |
| Malformed tool arguments | none | the call is answered with an error `function_call_output` on the chain; no row until a real decision is reached |

`callLlmWithTools` returns `{ output, usage, text }`. `output` is the gateway's item array — normally a single `function_call` whose `name` is the tool and whose `arguments` carry that tool's parameters plus a required `reasoning` string. The loop reshapes that into the same `{ action, params, reasoning, message, advisory }` object the dispatch branches have always taken, so the six branches below it are unchanged.

Tool schemas are enforced by the gateway. The `ACTION_SCHEMA` constant this replaced never was: it was passed to `callLlm`, but `response_format` is gated to `sonar` models and Novia runs `anthropic/claude-sonnet-4-6`, so it was dropped at the seam on every call.

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

> **Status (2026-07-29).** Direction set — `create_workflow` is dissolved into Novia, gated on
> evaluating her capability first (§12.7). **Sprint 9 is scoped and branched against this
> section**: `docs/sprints/CURRENT.md`, branch `sprint/09-novia-builds-workflows`.
>
> Measurements throughout are point-in-time findings against the live database and seed files,
> not configuration. Each carries the date it was taken.
>
> **The governing constraint, and the reason most of this section is not being built:** Novia can
> already write code. What she lacks is *this system's conventions*. So what gets written for her
> states **what the engine accepts** and **what each tier owns** — never a fill-in-the-blank
> structure, a required ordering, or a syntax she must emit. Sprint 9 writes a convention bridge
> on that basis and lets archetypes follow from what real builds turn out to need.
>
> | Subsection | Status |
> |---|---|
> | 12.1–12.2 the measured problem | Evidence, 2026-07-26 |
> | 12.3 the two registries | **Settled** — procedures and dialog strategies are two tables |
> | 12.4 phases become guidelines | Direction; not built |
> | 12.5–12.6 removals, dependencies | Direction |
> | 12.7 open questions | Three remain; OQ2 closed 2026-07-29 |
> | 12.8 defects | Register. **Do not run `create_workflow` while these stand** |
> | 12.9 table schemas | Templates committed, **not bootstrapped**; no consumer reads them |
> | 12.10 distillation | **Settled** — four procedures + one fragment, three interaction points |
> | 12.11–12.12 worked specimens | Findings stand; **notation parked** — see the banner in §12.11 |
> | 12.13 the cut list | Register, Sprint 9 A4. The `overstep` rows are the Sprint 10 archetype evidence |

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

#### Procedures and dialog strategies are two tables

The table above, and the six rows seeded from it, mix **procedures** with **presentation
strategies**. The seed's own text gives it away: `bulk_row_form.design_rules` states that when
the field product exceeds the gate ceiling *"this archetype does not apply: design a
list_selection gate to pick ONE row followed by a small form to edit that row"* — which is
`scoped_row_editor`. One archetype degrading into another on a row count is not two archetypes.
It is one procedure with two presentations, selected by a computable condition.

| Kind | Definition | Present in the seeded six as |
|---|---|---|
| **Procedure** | What the workflow does. Has a verb, a topology, and slots | edit tabular data; iterate and capture per item; ingest, parse, resolve references, insert; query, aggregate, report |
| **Dialog strategy** | How the user interacts at one interaction point | one-row selector; per-row bulk form; hierarchy as reveals-per-parent with options-per-leaf; one gate with reveal versus two gates; `list_selection` with `item_action`; `choice` with a per-option iterator |

`hierarchical_selector` has no verb — it is a way of presenting a selection that plugs into any
procedure needing the user to pick a row. `reveal_and_rate` carries a presentation choice in its
name while its own rules state when two gates should replace the reveal.

An archetype must describe the shape of *editing a table of data*, not of editing one particular
kind of record. The domain belongs in the slot bindings, never in the archetype.

**Composition:** a procedure declares that an interaction happens at a point in its topology; a
dialog strategy fills that point. The relationship is compositional rather than taxonomic, so
they are two tables — `PGC_Archetype` holds procedures, `PGC_DialogStrategy` holds strategies —
rather than one table with a `kind` discriminator. A discriminator column can record that a row
is one kind or the other, but it cannot express that a procedure *has* interaction points and a
strategy *fills one*: the composition would live nowhere. Their columns differ accordingly — a
procedure carries `topology` and `slots`, a strategy carries the gate shape it emits and
computable applicability bounds.

`flashcard_quiz_session` v3 is the specimen that makes the composition concrete. It is **one**
procedure — iterate over items, present a stimulus, capture a response per item, write it — with
**two different strategies at two different interaction points**:

| Point | Step | Strategy | Emitted gate |
|---|---|---|---|
| Select the scope to iterate over | 3 | hierarchy as reveals-per-parent with options-per-leaf | `choice` + `reveals`, options from an `iterator` |
| Capture the response for one item | 12 | fixed ordered scale, all values visible | `choice`, six authored options |

Neither strategy is derivable from the procedure, and the same two plug into unrelated
procedures: the step 3 strategy is the same one `edit_budget` uses to pick a period, inside a
procedure that edits tabular data rather than iterating. One workflow, one procedure, two
strategies is not representable in one table without the composition becoming implicit.

**Consequence for the preference conversation.** Which dialog strategies are *available* is
computable from the data — a row count against the gate field ceiling, an option count against
the threshold past which `choice` renders as a dropdown. Which of the feasible ones is *wanted*
is genuine user preference: all values as buttons or a dropdown, detail revealed on demand or
shown inline, one row at a time or the whole table. This is where the preference questions in
step 2 of the build procedure come from — the applicable templates given the live data — rather
than from domain research. Model selection for any generated `llm_call` step (`cheap` versus
`smart`) is the same kind of user-visible preference and should be surfaced, not decided
silently.

Of the seeded six, `scoped_row_editor`, `paste_parse_resolve_insert` and `aggregate_report` are
procedures; `hierarchical_selector` and `bulk_row_form` are dialog strategies; `reveal_and_rate`
is a procedure (iterate and capture per item) fused with the strategy its name carries. The
rows are `status: draft` and no consumer reads them, so the restructure is a seed rewrite with
no migration.

#### What a dialog strategy declares — show, ask, draw

An interaction point resolves three separate questions, which `gate_type` currently answers with
one enum value:

| | Question | Owner |
|---|---|---|
| **Show** | What does the user read in order to decide? | Procedure layer — markdown, tables, `reveal`/`reveals`, key-value pairs. No `output_key`, no routing |
| **Ask** | What is collected, and what does it route to? | Procedure layer — carries `output_key` and/or `on_select` |
| **Draw** | Which widget carries it? | Experience layer |

Decomposed this way the six gate types stop being types. Three of them exist mostly to describe
**show**, and the enum is five frozen (show, ask) pairings:

| `gate_type` | Show | Ask |
|---|---|---|
| `confirm` | — | acknowledge |
| `review_object` | key-value pairs | acknowledge |
| `list_selection` | markdown table | one row from a set |
| `choice` (+ `reveals`) | reveal panels | one value from a set |
| `form` | — | n typed values |

**Draw stays in the experience layer** — that half of the partition rule is correct. What is
missing is its input. `human_gate` gives a workflow no way to characterise an option set beyond
how many options it holds, so `callback.mjs` renders from a count, and a count cannot separate a
six-point rating scale from a twelve-month picker (§12.8). The distinguishing property is
whether the option set is **authored** at design time or **derived** from data at runtime: a
derived set may hold three entries or three hundred, so collapsing it past a handful is a fair
trade; an authored ordered scale has a count that is a property of the design, and the
simultaneous visibility of every value *is* the interaction.

So a strategy declares the properties its emitted gate carries — `option_source`,
`ordered`, and the bounds below — and the renderer applies mechanics to them: *derived and
numerous → collapse to a single control; authored and ordered → always inline*. No domain
vocabulary crosses the boundary; the renderer never learns what a flashcard is. This is the same
correction Sprint 7 already applied one level down, where a `form` field's `type` names what is
collected and never a widget — applied there to `form.fields[]` and not to `choice.options[]`.

A `PGC_DialogStrategy` row therefore holds:

| Column | Purpose |
|---|---|
| `name`, `description`, `aliases` | Identity and retrieval, as for a procedure |
| `applicability` | Computable bounds deciding whether this strategy is *feasible* on the live data — option count, field product against the gate ceiling, hierarchy depth |
| `emits` | The gate shape produced: `gate_type`, and the declared properties the renderer reads |
| `design_rules` | The strategy-scoped prose extracted from `design_workflow_dialogs`, loaded only on selection |

Feasibility is computed; which feasible strategy is *wanted* is the preference question above.

**Storage.** Both tables carry a vector column with `embed_source`, which gains semantic
search with no code change (`architecture.md` §10) and is reachable through the existing
`vectorSearch` descriptor on `getRows`. Both are data, so Novia adding a row is an insert, not a
deploy — consistent with the Static System vs Evolving Artifacts boundary and with her Extender
role (§1.2).

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
4. **Settle the shape, and test its assumptions against the data.** Where the topology comes
   from depends on step 3:
   - **Archetype matched** — there is no skeleton to build. `topology` is retrieved and was
     validated when the archetype was authored. Bind slots and move to content.
   - **No match** — sketch the flow and run L0 and L1 on the sketch immediately. Both are
     deterministic, need no LLM, and cost nothing to repeat. Then **describe the shape to the
     user in plain language before investing in content.** A workflow whose save button routes
     forward instead of back is a perfectly well-formed graph — reachable, terminating, no dead
     ends — so L1 and L2 both pass it. Validity is not correctness, and the sketch is the last
     point at which a non-expert can referee the flow.
   - **Short and linear** — the distinction is noise. Iterate whole.

   In every case, the assumptions the shape rests on are checkable against rows that already
   exist, before content is generated: that a list fits within one gate, that a value the user
   picks can be decomposed before the step that queries on it, that a query without a limit
   returns what the report needs.
5. **Fill, simulate, register.** `simulate_workflow` gates the step array; `register_workflow`
   writes it.

Testing assumptions against live data is the point of the whole design. The defects that
motivated it — a row limit smaller than the data, a composite gate value consumed before it was
decomposed — are invisible to a single-shot designer that receives the schema as text, and
obvious to one that can count the rows first.

A skeleton-first phase is deliberately **not** mandated. Its justification in the current
pipeline is that content generation is one expensive call discarded whole when routing proves
wrong, and that a single call cannot design routing and content at once; neither holds for an
agent that edits in place and reasons one turn at a time. What survives is a preference for
settling topology before content where topology errors are expensive — branches and loops,
where a wrong shape invalidates the content written against it — and that is a judgment call,
not a stage. Mandating it would reintroduce a fixed pipeline through the back door, and would
be a rule generalised from the workflows that happened to have loops.

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

**Settled — procedures and dialog strategies are two tables**, `PGC_Archetype` and
`PGC_DialogStrategy` (§12.3). They compose rather than classify, and a `kind` discriminator on
one table cannot express the composition.

Remaining open:

1. ✅ **ANSWERED — Sprint 9, AC9 — and the answer does not yet favour the Novia path.**
   **$2.73** to build and register `edit_budget` (session 1121, 26 calls) against the
   `create_workflow` baseline of **≈$1.42** per paid build (run 729) — roughly **2×** — plus
   **$3.40** for the repair session (1122) that followed without completing the repair.
   Three qualifications, all material to how this number should be read:
   **(a)** ~$0.39 of the build went on harness defects since fixed (six of them, §Sprint 9
   Session 6), so a clean rebuild is cheaper than the measured figure.
   **(b)** The dominant cost is structural and diagnosed, not mysterious: Novia's transcript is
   re-sent whole every turn and re-cached at *creation* price because our own input assembly
   breaks the cache prefix. The fix is three changes in `minds-eye.mjs`, and the expected effect
   is roughly a **12× cut** on that component. It is deferred to Sprint 10 only because it needs
   a live round to validate.
   **(c)** The baseline is not like-for-like in the Novia path's favour: $1.42 buys a
   `create_workflow` build that also needed repair, and the 2026-07-26 evaluation put that
   pipeline at 4 surviving workflows from 98 runs — so cost per *delivered working* workflow, the
   quantity OQ1 actually names, is not $1.42 for the baseline either.
   **The dissolution decision should not be taken on this number as it stands.** Re-measure after
   the prefix-cache fix, on a build that does not pay for defects since closed.
2. Whether `reconcile_missing_rows` earns its place as a shared fragment. Its two instances
   share a topology but differ in gap computation, target count and whether the inserted ids are
   needed, so its `gap` slot is an expression rather than a table or column binding (§12.12).
   Revisit once a third instance exists.
3. Whether a generated gate names the strategy that produced it or declares the properties that
   strategy implies (§12.3). Naming it couples step JSON to the registry and makes the
   experience layer a consumer of the registry; declaring properties keeps the registry a
   design-time artifact the renderer never needs to know exists.
4. Whether producing the final step array stays a tool. It is bulk mechanical output, which suits
   a focused single-shot call and keeps a large JSON artifact out of the transcript — but on a
   matched archetype it may be a deterministic fill needing no LLM call at all. The only phase
   whose side of the tool/guidance line is undecided.
5. ◐ **Partly answered — Sprint 9 raised all three budgets and none was the one that binds.**
   `turn_limit` 8 → 12, `max_actions_per_session` 5 → 8, `max_output_tokens` 8192 → 10240 (which
   was absent from `minds_eye_preferences` entirely and falling through to a default). But the
   round runs its turns inside **one 240s Lambda invocation**, so a round dies at turn 3–4 and
   `turn_limit: 12` is unreachable. `roundBudgetExhausted` now stops before a turn there is no
   room to finish. **Session compression at the turn-limit gate remains unexercised**, because a
   round still cannot reach that gate — it carries to Sprint 10 behind the transcript fix, which
   is what makes turns cheap enough for a round to get there.
6. ✅ **CLOSED — Sprint 9, B1. A `level` selector, not a new tool.** L0 is `level: 0` on
   `runSimulation` and on the existing `/proc/simulate-workflow` endpoint, so "validate, then
   simulate" is `simulate_workflow { steps, level: 0 }` with no new surface for Novia to learn.
   The `skeleton: true` flag it replaces is gone from the engine and accepted only as a retired
   spelling in `step-executor`.

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
- **`step_type_contracts` is a hand-maintained copy of the `PGC_StepType` rows** — same field
  names (`step_type`, `description`, `input_contract`, `output_contract`, `on_success_options`,
  `on_failure_options`), transcribed rather than referenced, and measurably stale. It carries
  **17 of the 19** step types, so `serv_entity_insert` and `write_memory` are invisible to every
  prompt that reads it. Its `human_gate` entry omits three fields the live row declares —
  `fields` (which `form` gates require, and `form` is the only gate that collects input),
  `action_key`, and `on_cancel` (**required**). This is §12.2's registry-as-prose category
  measured rather than argued, and the strongest single case for the bridge querying
  `PGC_StepType` instead of restating it.

Found 2026-07-29, in the gate contract rather than the design prompts:

- **A `choice` gate's options collapse to a dropdown on a count alone.**
  `CHOICE_DROPDOWN_THRESHOLD` in `callback.mjs` turns lettered buttons into a `static_select`
  past five real options. It was introduced for `edit_budget` step 3, whose single
  `iterator: period_options` option expands to twelve month buttons, where collapsing is right.
  It also catches `flashcard_quiz_session` step 12, six authored rating options on an SM-2
  scale, where it is wrong: grading a card goes from one click to three interactions, in the
  workflow whose value is the speed of repetition. **Contract fault domain** — `callback.mjs`
  behaves reasonably on what it is given, and the `human_gate` contract has no field in which a
  workflow could say the set is authored and ordered. Raising the threshold to six would be a
  rule generalised from one specimen and fails at the next one. The discriminating property is
  already present in the step JSON by accident: the gates that should collapse carry an
  `iterator` on their options and the one that should not does not (§12.3).

### 12.9 `PGC_Archetype` and `PGC_DialogStrategy` — implementation outline

A seventeenth and eighteenth PGC table. System config, so `PGC_` prefixed, `target: pgc`, and
subject to the same bootstrap-and-seed treatment as the existing sixteen. `PGC_Archetype` holds
procedures, `PGC_DialogStrategy` holds the strategies that fill their interaction points
(§12.3).

#### `PGC_Archetype` shape

Modelled on `PGC_DomainHelp`, which is the existing table that combines a registry with
semantic retrieval.

| Column | Type | Purpose |
|---|---|---|
| `id` | serial PK | |
| `name` | text, not null, unique | Stable identifier, snake_case |
| `description` | text | One line — what shape of workflow this is |
| `aliases` | jsonb, default `'[]'` | Retrieval vocabulary. **This is what the embedding is built from** |
| `preconditions` | jsonb, default `'{}'` | Machine-checkable applicability, so matching is not purely semantic — e.g. the source table carries a self-referential FK, or the request names an existing populated table |
| `slots` | jsonb, not null, default `'[]'` | Declared **data** bindings the archetype needs — table, columns, labels, ceilings. One entry per slot: name, type, how it is resolved |
| `interaction_points` | jsonb, not null, default `'[]'` | The named holes in `topology` where the user interacts. One entry per point: name, what is being decided, which slot supplies its data. A `PGC_DialogStrategy` row fills one |
| `topology` | jsonb, not null, default `'[]'` | The step skeleton — step_labels, step types, routing fields, slot tokens, and interaction points as holes rather than specified gates. Same shape as the `routing_skeleton` the current pipeline builds at step 21a |
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

#### `PGC_DialogStrategy` shape

Identical in its registry and retrieval columns — `id`, `name`, `description`, `aliases`,
`design_rules`, `source_workflow`, `status`, `version`, `created_by`, `embedding`, timestamps —
so the same `embed_source: ["aliases"]` rule applies. It differs where the two kinds of thing
differ (§12.3): no `topology`, no `slots`, no `interaction_points`, and instead —

| Column | Type | Purpose |
|---|---|---|
| `applicability` | jsonb, not null, default `'{}'` | Machine-checkable bounds deciding whether this strategy is *feasible* against the live data — option count, field product against the gate ceiling, hierarchy depth. Evaluated after the row counts of step 1 of the build procedure, so feasibility is computed rather than guessed |
| `emits` | jsonb, not null, default `'{}'` | The gate shape produced: `gate_type`, and the declared properties the experience layer reads to choose a widget (`option_source`, `ordered`) |

`applicability` and `preconditions` on `PGC_Archetype` are the same kind of column serving
different questions: `preconditions` asks whether a procedure *fits the request*, `applicability`
asks whether a strategy *fits the data at one point*. A procedure is matched once per build; a
strategy is matched once per interaction point.

#### Creation path — one path, not two

`createTableFromTemplate` issues `CREATE TABLE IF NOT EXISTS`, so bootstrap is idempotent and
re-running it on the live instance creates only the tables that are missing. There is no need
for a separate `schema/createTable` call, and none should be made — both tables are created the
same way the other sixteen were:

1. `src/serv/templates/pgc/PGC_Archetype.json` and `PGC_DialogStrategy.json` — static ES module
   imports in `init-brain.mjs`, appended to `PGC_TEMPLATES`. Bundled by esbuild, never read
   via `fs`.
2. Registration rows appended to `seed_PGC_Schema.json` and `seed_PGC_TableMap.json`, one pair
   per table. `PGC_TableMap` is not optional: `table.mjs` gates all row access on it, and
   `seedPGCTableMap` skips any table with no `PGC_Schema` row, so both are required.
3. `POST /api/v1/serv/bootstrap` after deploy. Existing tables report as already present.

#### Seeding and maintenance

- `seed_PGC_Archetype.json` (procedures) and `seed_PGC_DialogStrategy.json` (strategies) in
  `src/serv/templates/pgc/seeds/`, seeded by `seedPGCArchetype` and `seedPGCDialogStrategy` as
  bootstrap steps 12 and 13.
- `ON CONFLICT (name) DO UPDATE` on the seeded columns. `created_by` is deliberately excluded
  so a row Novia authored keeps its provenance if it is later moved into the seed file.
  Rows Novia writes are not in the seed file and are never touched by bootstrap.
- `dev_scripts/upsert-archetype.mjs` and `dev_scripts/upsert-dialog-strategy.mjs`, following
  the `upsert-step-type.mjs` pattern — content-fingerprint comparison, then `updateRows` or
  `insertRow`. Seeded rows are never edited by direct `updateRows`.
- The script never writes `embedding`. SERV computes it from `embed_source` on insert, and on
  any update whose payload touches `aliases`. Rows inserted before the column was populated
  need `dev_scripts/backfill-embeddings.mjs`, which currently targets `PGC_DomainHelp` only and
  would need extending.

#### Access

- **Read** — no new endpoint. `getRows` on either table with a `vectorSearch` descriptor against
  `embedding`. Vector columns are stripped from `getRows` responses, so the payload stays small.
  Surfaced to Novia as two read tools, `search_archetypes` and `search_dialog_strategies`,
  alongside the existing `query_table` / `run_sql`. They are separate tools because they are
  called at different moments — a procedure once per build, a strategy once per interaction
  point — and a single tool would have to be told which it was searching for.
- **Write** — `insertRow` / `updateRows`. Novia adding a row to either table is a system-config
  change, so it belongs in `GATED_WRITE_TOOLS` (§4.2) rather than executing inline.
- **Threshold** — `PGC_DomainHelp` uses 0.40 for `pplx-embed-v1-4b`, calibrated against domain
  aliases. Both tables' aliases describe workflow shapes and interaction shapes rather than
  domain nouns, so each needs its own calibration against real requests and neither should be
  assumed to carry over.

#### Documentation required at implementation

- `docs/arch-data.md` — both PGC table definitions and any curl additions to §5.5.
- `docs/architecture.md` — §1.5 PGC table groups; §3.4 directory listing for the two dev scripts.
- `openapi.yaml` — no change expected; both tables are reached through the generic `getRows` /
  `insertRow` routes.

### 12.10 Distillation of the four surviving workflows (OQ3)

Read 2026-07-29 from the live `PGC_Workflow` rows: `edit_budget` v1 (12 steps),
`flashcard_quiz_session` v3 (21), `import_budget_spreadsheet` v1 (16),
`budget_vs_expense_report` v5 (15). These four are the entire surviving output of 98
`create_workflow` runs, so they are the whole evidence base for what `topology`, `slots` and
`interaction_points` hold.

#### Interaction points are real and separable

Eight human gates across the four workflows reduce to **three** interaction points, filled by
**five** different strategies:

| Interaction point | Instances | Strategies observed |
|---|---|---|
| **select_scope** — narrow the data to operate on | `edit_budget` 3, `budget_vs_expense_report` 1, `flashcard_quiz_session` 3 | `choice` with an option `iterator` over twelve periods; `text_input` free prose; `choice` with `iterator` + `reveals` as hierarchy |
| **approve_writes** — confirm rows before they are written | `import_budget_spreadsheet` 8 and 12, `budget_vs_expense_report` 8 | `confirm` in all three |
| **capture_values** — collect the user's input for the current scope or item | `edit_budget` 7, `flashcard_quiz_session` 12 | `form`, one field pair per row; `choice`, fixed ordered scale |

One point filled three different ways in three unrelated procedures is the composition model
working. It also exposes a defect that only becomes visible once the point is named: **the same
decision is made well in one workflow and badly in another.** `edit_budget` step 3 selects a
year-month period with a deterministic picker built from rows that already exist.
`budget_vs_expense_report` step 1 collects the same kind of value as free prose, and step 2
exists solely to parse it back apart.

That is the derive-before-consume defect in its resolved form, and it shows the defect class is
**structural rather than instructional**. A composite value only needs decomposing because a
strategy collected it composite. Bind `select_scope` to a typed picker and step 2 has nothing to
do — the whole class disappears without a prompt rule, a validator, or the bounded-drift
relaxation that was Sprint 9's candidate lead item.

#### Procedures nest

One sub-shape appears inside two unrelated procedures, in the same order both times:

| | `import_budget_spreadsheet` | `budget_vs_expense_report` |
|---|---|---|
| load existing reference rows | 5 | 3, 4, 5 |
| compute the gap | 6 | 6 |
| gate on whether there is one | 7 | 7 |
| confirm the additions | 8 | 8 |
| insert them | 9 | 9, 9a |
| reload and bind ids | 10, 11 | — |

This is the FK-dependency block §12.3 identified as already being a parameterised template,
confirmed live. It has a verb, a topology and slots, so it satisfies the definition of a
procedure — it simply is not a whole workflow. **A procedure's `topology` may therefore reference
another procedure.** Composition stays within `PGC_Archetype`; no third table is needed. Written
out in §12.12 the reference resolves to a build-time `include` rather than a call, and the
fragment is named `reconcile_missing_rows` — the second instance has no foreign key in it, so the
FK framing inherited from `design_workflow_process` is too narrow.

#### How many procedures there are

Four top-level, one nested — against six seeded rows:

| Procedure | Specimen |
|---|---|
| `scoped_row_editor` — select a scope, list its rows, edit, save, return to the refreshed list | `edit_budget` |
| `iterate_and_capture` — select a scope, walk its items, capture a response per item, write it | `flashcard_quiz_session` |
| `ingest_and_insert` — accept pasted data, parse it, resolve references, bulk insert | `import_budget_spreadsheet` |
| `aggregate_report` — query, aggregate, format deterministically, present | `budget_vs_expense_report` |
| `reconcile_missing_rows` — nested; inlined by the two above that need it | `import_budget_spreadsheet` 5–11 |

`hierarchical_selector` and `bulk_row_form` move to `PGC_DialogStrategy` whole.
`reveal_and_rate` splits: its procedure half becomes `iterate_and_capture`, its presentation half
becomes a strategy on `capture_values`.

#### Slots

Recurring data bindings, from what the four actually bind:

| Slot | Appears as |
|---|---|
| `source_table` + `rows` | Every workflow's opening `serv_query` |
| `scope_columns` | `year` + `month`; `deck_id` |
| `label_column` | The column standing in for a row in a picker or table |
| `grouping_column` | `type` in both budget workflows — drives both display grouping and subtotals |
| `write_target` + `natural_key` | `serv_upsert` matched on `(year, month, category_id)` |
| `reference_table` + `reference_key` | `reconcile_missing_rows` callers only — the table whose rows may be missing, and the column matched on |

`grouping_column` is the one that carries into presentation as well as data: it groups the
`edit_budget` form, the report's subtotals, and the quiz's parent/child reveal panels. Whether it
is one slot read by two consumers or two slots is unsettled.

#### Variance that is not procedural

Terminal and label conventions differ across all four — `budget_vs_expense_report` labels a step
`"end"`, `import_budget_spreadsheet` carries two `end` steps (one for the cancel path, one for
success), `edit_budget` one; step labels include `"9a"`. Routing field usage is consistent:
`condition` steps route on `on_success` / `on_else` in all four, never `on_true` / `on_false`.
None of this belongs in `topology` — it is translation-stage noise, and normalising it is L0's
job (§12.4).

### 12.11 `scoped_row_editor` written out

> **The notation below is parked (2026-07-29).** `{{slot:name}}`, and `include` / `for_each` in
> §12.12, are an invented mini-language — the violation pattern `CLAUDE.md` names: inventing a
> custom syntax and then needing rules to make an LLM emit it. Novia can already write code; what
> she lacks is this system's conventions, so Sprint 9 writes a convention bridge instead and lets
> archetypes follow from what real builds turn out to need. The **findings** in §12.11 and §12.12
> stand as evidence — a strategy expands an interaction point, nesting is inlining, the shared
> fragment is not about foreign keys, and the specimen defects are live. The notation does not.

The worked specimen that settles the `topology` notation, derived from `edit_budget` v1. Written
from the shape the procedure should have, not transcribed from the specimen — three defects in
`edit_budget` are recorded at the end and are not carried in.

#### Not every step in a workflow is a procedure step

Mapping `edit_budget`'s twelve steps against the procedure reveals a third category. Four of
them exist only to build or decode the payload of an adjacent gate:

| Step | Belongs to | Why |
|---|---|---|
| 1 `serv_query` summaries | Procedure | The procedure needs the set of scopes to choose from |
| 2 `js_transform` → `period_options`, `period_summaries_table` | **Strategy** | Builds the option array and the markdown table one particular picker renders |
| 3 `human_gate` choice | Interaction point | `select_scope` |
| 4 `serv_query` categories | Procedure | The reference rows that become the editable line items |
| 5 `serv_query` existing budgets | Procedure | The current values in scope — the loop return target |
| 6 `js_transform` → `form_fields` | **Strategy** | Emits one `amount_<id>` / `notes_<id>` field pair per reference row |
| 7 `human_gate` form | Interaction point | `capture_values` |
| 8 `js_transform` → `upsert_rows` | **Strategy** | Decodes the same invented field names back into rows |
| 9 `serv_upsert` | Procedure | The write |
| 10 `condition` on `action_key` | Procedure | Save-and-continue loop |
| 11 `notify`, 12 `end` | Procedure | Terminal |

Steps 6 and 8 are a matched pair: the field-name convention `amount_<id>` is invented by 6 and
understood only by 8. Neither is meaningful without the other, and both are meaningless to a
procedure that binds a different strategy to the same point. **A strategy expands an interaction
point into prep steps, a gate, and decode steps** — so a procedure's `topology` is materially
shorter than the workflow built from it. `scoped_row_editor` is nine entries; `edit_budget` is
twelve.

This is also what the Sprint 9 candidate lead item was fighting. Translation "adding steps" past
a locked skeleton is a strategy expanding a hole, and the step-count drift that triggered
rejection is the expansion becoming visible at the wrong stage.

#### Slots

```json
[
  { "name": "source_table",      "type": "table",   "resolved_from": "request",        "required": true },
  { "name": "scope_source",      "type": "table",   "resolved_from": "schema",         "required": true,
    "note": "Where scope candidates are read from — often a view aggregating source_table" },
  { "name": "scope_columns",     "type": "columns", "resolved_from": "schema",         "required": true },
  { "name": "scope_order",       "type": "orderBy", "resolved_from": "schema",         "required": false },
  { "name": "reference_table",   "type": "table",   "resolved_from": "schema",         "required": true,
    "note": "One editable line item per row of this table" },
  { "name": "reference_label",   "type": "column",  "resolved_from": "pickLabelColumn","required": true },
  { "name": "reference_group",   "type": "column",  "resolved_from": "schema",         "required": false,
    "note": "Groups the line items for display and any subtotals" },
  { "name": "editable_columns",  "type": "columns", "resolved_from": "request",        "required": true },
  { "name": "natural_key",       "type": "columns", "resolved_from": "schema",         "required": true },
  { "name": "soft_delete_column","type": "column",  "resolved_from": "schema",         "required": false }
]
```

`reference_group` is the `grouping_column` §12.10 left unsettled. Written out, it is one slot
read by two consumers — the procedure never uses it, both the display strategy and any subtotal
formatting do — which is consistent with it staying a data slot rather than splitting.

#### Interaction points

```json
[
  {
    "name": "select_scope",
    "decides": "which scope the edit applies to",
    "data_from": ["scope_candidates"],
    "produces": [
      { "key": "selected_scope", "shape": "one value per scope_columns entry" }
    ],
    "constraint": "Must yield one value per scope_columns entry. A strategy that returns a single composite value does not satisfy this point."
  },
  {
    "name": "capture_values",
    "decides": "new values for editable_columns across every reference row in scope",
    "data_from": ["reference_rows", "scope_rows"],
    "produces": [
      { "key": "write_payload", "shape": "array of rows keyed by natural_key" },
      { "key": "edit_action",   "shape": "which control the user used" }
    ]
  }
]
```

`produces` is the contract between a strategy and the procedure: the procedure writes
`{{write_payload}}` without knowing which strategy built it. `constraint` on `select_scope` is
derive-before-consume made structural — a picker binding one value per scope column satisfies it,
free prose returning `"YYYY-MM"` does not, and nothing downstream needs a decomposition step
either way.

#### Topology

```json
[
  { "step_label": "load_scope_candidates", "step_type": "serv_query",
    "input":   { "tableName": "{{slot:scope_source}}", "orderBy": "{{slot:scope_order}}" },
    "output_key": "scope_candidates",
    "on_success": "select_scope", "on_else": "cancel" },

  { "interaction_point": "select_scope",
    "on_success": "load_reference_rows", "on_cancel": "cancel" },

  { "step_label": "load_reference_rows", "step_type": "serv_query",
    "input":   { "tableName": "{{slot:reference_table}}" },
    "output_key": "reference_rows",
    "on_success": "load_scope_rows", "on_else": "cancel" },

  { "step_label": "load_scope_rows", "step_type": "serv_query",
    "input":   { "tableName": "{{slot:source_table}}", "filters": "{{scope_filters}}" },
    "output_key": "scope_rows",
    "on_success": "capture_values", "on_else": "cancel" },

  { "interaction_point": "capture_values",
    "on_success": "write_rows", "on_cancel": "cancel" },

  { "step_label": "write_rows", "step_type": "serv_upsert",
    "input":   { "tableName": "{{slot:source_table}}", "rows": "{{write_payload}}",
                 "matchColumns": "{{slot:natural_key}}" },
    "output_key": "write_result",
    "on_success": "continue_or_finish", "on_else": "cancel" },

  { "step_label": "continue_or_finish", "step_type": "condition",
    "expression": "{{edit_action}} === 'save'",
    "on_success": "load_scope_rows", "on_else": "notify_saved" },

  { "step_label": "notify_saved", "step_type": "notify", "on_success": "end" },

  { "step_label": "end", "step_type": "end" }
]
```

What the notation has to carry, established by writing it:

- **`step_label` is a name, never an ordinal.** The loop target is `load_scope_rows`, not `5`.
  Ordinals are why `budget_vs_expense_report` has a step called `9a`.
- **Two token namespaces.** `{{slot:name}}` is filled once at build time from `slots` and never
  reaches the runtime resolver; `{{name}}` is ordinary `local_state`. The colon cannot occur in a
  `local_state` path, so the two cannot collide.
- **An interaction point is an entry, not a step.** It carries routing and nothing else — no
  `gate_type`, no `output_key`, no `message_template`. All of that arrives with the strategy.
- **The loop returns to a procedure step, not to a point.** `continue_or_finish` routes to
  `load_scope_rows` so the re-read happens before the point is re-entered. Scope is chosen once.
- **No nested procedure reference is exercised here.** `scoped_row_editor` needs none; the
  notation for one is still open (§12.7).

#### Defects in the specimen, not carried into the topology

Found while writing this out. Artifact repairs to `edit_budget`, not backlog items, except where
noted.

- **Step 5 queries a scope that cannot match.** `selected_period` is the string `"2026-07"`, and
  step 5 filters on `{{selected_period.0}}` and `{{selected_period.1}}`. `resolvePath` in
  `template-resolver.mjs` applies a numeric key to a non-array by falling through to `cur[key]`,
  so these resolve to `"2"` and `"0"` — the query asks for year 2, month 0 and returns nothing on
  every run. The form at step 7 is therefore always built from an empty `existing_budgets`, so
  saved values never reappear on a loop iteration. Steps 6 and 8 split the same value correctly
  with `.split('-')`. This confirms the proposed L1 check for `{{key.N}}` indexing on non-arrays
  as a live defect rather than a hypothetical one, and it is a third instance of the
  `select_scope` composite-value root cause.
- **Step 1's filter excludes two thirds of the year.** `year lte 2026 AND month lte 7` matches no
  month after July in any year, and `limit: 13` caps what survives. Both values were frozen at
  generation time, as is `var currentPeriod = '2026-07'` hard-coded in step 2, so the workflow
  degrades silently as soon as the date moves. The row-limit half is the query row-limit
  discipline item already carried from Sprint 8.
- **Step 3 emits no `action` on its iterated option**, so `action_key` could not be added to that
  gate without ambiguity. Not currently reached, since scope is chosen once.

### 12.12 `ingest_and_insert` written out

Derived from `import_budget_spreadsheet` v1, the specimen that exercises the shared sub-shape
§12.10 identified. Writing it out refines that finding in two ways.

#### The shared sub-shape is not about foreign keys

§12.10 named it `resolve_missing_references`, inherited from the FK-dependency framing in
`design_workflow_process`. The second instance does not involve a foreign key at all:
`budget_vs_expense_report` steps 3–9a materialise budget and expense rows from recurring
templates into the data tables the report then reads. Nothing is being resolved for an FK; rows
are being made to exist before something depends on them.

What the two instances actually share is the topology — load what exists, compute the gap, gate
on whether there is one, confirm, insert — so it is renamed **`reconcile_missing_rows`**.

| | `import_budget_spreadsheet` | `budget_vs_expense_report` |
|---|---|---|
| Target of the insert | A reference table | The data tables read downstream |
| How the gap is computed | Set difference on a name column | Derivation from recurring templates for a period |
| Insert targets under one gate | 1 | 2 |
| Needs the inserted ids afterwards | Yes — steps 10, 11 reload and bind | No |

#### Nesting is inlining, not calling

Only the topology is genuinely shared. The gap computation differs materially between the two
instances, the target count differs, and one instance needs an id-binding tail the other does
not. A call-and-return contract — a `returns` binding, a resolved set handed back — is heavier
than that evidence supports, and it would put a runtime indirection in the way of what §12.4
wants to be a deterministic template fill.

So a nested procedure is **inlined at build time**. The fragment declares the `local_state` keys
it writes; the caller reads them directly, as it reads any other step's output. There is no
return value and no call frame.

```json
{ "include": "reconcile_missing_rows",
  "bind": {
    "existing_source": "{{slot:reference_table}}",
    "gap":             "{{slot:reference_gap}}",
    "targets":         ["{{slot:reference_table}}"]
  },
  "on_success": "bind_reference_ids", "on_cancel": "abort" }
```

Three consequences the exercise forces:

- **`targets` is a list, and the gate covers all of it.** `budget_vs_expense_report` has one
  confirm gate and two `serv_insert` steps. The fragment's insert entry expands once per bound
  target; its interaction point does not.
- **A fragment carries its own interaction point.** `approve_additions` belongs to
  `reconcile_missing_rows`, not to either caller, and surfaces to the build alongside the
  caller's own points so a strategy can be bound to it.
- **`gap` is a slot of type `expression`.** This is a weaker parameterisation than
  `scoped_row_editor`'s slots, which are all tables and columns. Whether two instances differing
  this much earn a shared fragment, or are better left as two whole topologies, is worth
  revisiting once a third instance exists.

#### `reconcile_missing_rows`

Slots: `existing_source` (table), `gap` (expression), `targets` (list of table).
Writes: `existing_rows`, `gap_rows`, `inserted_rows`, `resolved_rows`.

```json
[
  { "step_label": "load_existing", "step_type": "serv_query",
    "input": { "tableName": "{{slot:existing_source}}" },
    "output_key": "existing_rows",
    "on_success": "compute_gap", "on_else": "abort" },

  { "step_label": "compute_gap", "step_type": "js_transform",
    "expression": "{{slot:gap}}",
    "output_key": "gap_rows",
    "on_success": "has_gap" },

  { "step_label": "has_gap", "step_type": "condition",
    "expression": "{{gap_rows.length}} > 0",
    "on_success": "approve_additions", "on_else": "reload_resolved" },

  { "interaction_point": "approve_additions",
    "on_success": "insert_missing", "on_cancel": "abort" },

  { "step_label": "insert_missing", "step_type": "serv_insert",
    "for_each": "{{slot:targets}}",
    "input": { "tableName": "{{each}}", "rows": "{{gap_rows}}" },
    "output_key": "inserted_rows",
    "on_success": "reload_resolved", "on_else": "abort" },

  { "step_label": "reload_resolved", "step_type": "serv_query",
    "input": { "tableName": "{{slot:existing_source}}" },
    "output_key": "resolved_rows",
    "on_success": "return", "on_else": "abort" }
]
```

`reload_resolved` runs on both branches so `resolved_rows` is populated whether or not anything
was inserted — a caller that needs the ids gets them, and one that does not pays a single query.
`budget_vs_expense_report` omits this step; keeping it in the fragment is what makes the two
instances one shape.

#### `ingest_and_insert`

Slots: `target_table`, `natural_key`, `parse_prompt`, `reference_table`, `reference_key`,
`reference_gap`.

```json
[
  { "step_label": "derive_parse_defaults", "step_type": "js_transform",
    "expression": "runtime date decomposed into the units {{slot:parse_prompt}} declares",
    "output_key": "parse_defaults",
    "on_success": "parse_input" },

  { "step_label": "parse_input", "step_type": "llm_call",
    "input": { "prompt": "{{slot:parse_prompt}}", "user_input": "{{input.userInput}}",
               "defaults": "{{parse_defaults}}" },
    "output_key": "parsed",
    "on_success": "check_parse_errors", "on_else": "abort" },

  { "step_label": "check_parse_errors", "step_type": "condition",
    "expression": "{{parsed.validation_errors.length}} > 0",
    "on_success": "report_parse_errors", "on_else": "resolve_references" },

  { "step_label": "report_parse_errors", "step_type": "notify",
    "on_success": "abort" },

  { "include": "reconcile_missing_rows",
    "bind": { "existing_source": "{{slot:reference_table}}",
              "gap":             "{{slot:reference_gap}}",
              "targets":         ["{{slot:reference_table}}"] },
    "on_success": "bind_reference_ids", "on_cancel": "abort" },

  { "step_label": "bind_reference_ids", "step_type": "js_transform",
    "expression": "join {{parsed}} to {{resolved_rows}} on {{slot:reference_key}}",
    "output_key": "write_payload",
    "on_success": "approve_writes" },

  { "interaction_point": "approve_writes",
    "on_success": "write_rows", "on_cancel": "abort" },

  { "step_label": "write_rows", "step_type": "serv_upsert",
    "input": { "tableName": "{{slot:target_table}}", "rows": "{{write_payload}}",
               "matchColumns": "{{slot:natural_key}}" },
    "output_key": "write_result",
    "on_success": "notify_done", "on_else": "abort" },

  { "step_label": "notify_done", "step_type": "notify", "on_success": "end" },
  { "step_label": "end",   "step_type": "end" },
  { "step_label": "abort", "step_type": "end" }
]
```

Notation added beyond §12.11: `include` with `bind`; `for_each` over a list-valued slot with
`{{each}}` inside the entry; and two named terminals, `end` and `abort`, since `on_else` on every
step needs somewhere to land that is not the success path. `import_budget_spreadsheet` already
has both terminals (steps 15 and 16) — it just numbers them.

`approve_writes` is the same interaction point as in `budget_vs_expense_report` step 8, filled by
`confirm` in both, which is the third point from §12.10 appearing in a second procedure.

#### Defects in the specimen, not carried into the topology

- **Step 9 inserts strings where rows are required.** `missing_category_names` is an array of
  names from step 6, passed as `input.row` to a `serv_insert` on `PGD_SpendingCategories`. The
  column is `name`; an array of bare strings cannot populate it. The gap computation returns
  identifiers where the insert needs row objects — which is why `reconcile_missing_rows` above
  keeps `gap_rows` and the insert payload as the same shape.
- **The current date is frozen at generation time**, twice: step 1 computes defaults from
  `new Date('2026-07-02')` and step 2 passes the literal string `"Thursday, July 2, 2026"` to the
  parse prompt. Same class as `edit_budget` step 2 (§12.11) — a third instance, so it is a
  generation habit rather than a one-off.
- **Step 3 branches on a bare length.** `{{parsed_data.validation_errors.length}}` routes on
  truthiness rather than a comparison. It behaves correctly, but only because `0` is falsy.

### 12.13 The cut list (Sprint 9 A4)

A register of every rule in the `create_workflow` instruction layer that was considered for the
convention bridge and not carried, with the reason it failed the overstepping test and a
disposition. The bridge itself is the record of what *was* carried, so carried lines are not
listed here.

Source material: the four design prompts and the `PGC_SystemContext` rows injected into them —
`step_type_contracts`, `step_usage_patterns`, `runtime_bindings`, `template_syntax`,
`workflow_constraints`, `workflow_routing_rules`, `serv_db_step_shapes`, `flat_loop_example`,
`human_gate_dialog_rules`.

The overstepping test is a per-line judgement, so without a register "we cut it" is
unfalsifiable. §12.3 claims six archetypes are recoverable from prompt prose; this is that claim
measured. A cut rule Novia turned out to need, and that no registry row supplied, is a candidate
`PGC_Archetype` / `PGC_DialogStrategy` row. A cut rule nothing ever asked for is prose that dies
with its prompt. **If the `overstep` rows are never missed, archetypes are not needed** — that is
the evidence AC1 produces and Sprint 10 reads.

| Disposition | Meaning |
|---|---|
| `registry` | Already a queryable row. The bridge points at the table instead of restating it. Not evidence of anything — this is AC2 working. |
| `overstep` | A design instruction: an ordering, a shape to fill, or a "when X, do Y". Not a statement of what the engine accepts. **The archetype candidates.** |
| `stale` | Measurably wrong against the code today. Recorded so it is not re-copied; dies with its prompt. |

#### `registry` — already a row, the bridge points instead

| Source | Rule | Where it already lives |
|---|---|---|
| `step_type_contracts` (whole row, 22 KB) | Per-type field lists transcribed from PGC_StepType | `PGC_StepType` — 19 rows. The copy carries 17, and its `human_gate` entry omits `fields`, `action_key` and the required `on_cancel` (§12.8) |
| `step_usage_patterns` | "REQUIRED fields" block for each of js_transform, condition, human_gate ×4 gate types, iterator, llm_call | `PGC_StepType.input_contract` per row |
| `human_gate_dialog_rules` (whole row) | action vs on_select; valid on_select tokens; cancel-option requirement; reveal does not route | The `human_gate` contract — moved there by A2 |
| `workflow_constraints` § human_gate | gate_type enum; form `fields`; `special_buttons`; which gate types write output_key | The `human_gate` contract |
| `workflow_constraints` § iterator | `execution_mode: "sequential"`; suspending vs non-suspending; choice-only item_step | The `iterator` contract |
| `workflow_constraints` § notify, § end | notify has no on_else; end has no routing fields and is last | The `notify` and `end` contracts |
| `serv_db_step_shapes` | Filter object shape; the ten valid ops; filters required on update/delete | The `serv_*` contracts |
| `workflow_routing_rules` 1, 3 | on_else on serv_* steps; filter shape restated a third time | `serv_*` contracts — and rule 1 is also `stale`, below |

#### `overstep` — design instruction, not engine acceptance

| Source | Rule | Why it is not a bridge line |
|---|---|---|
| `flat_loop_example` (whole row) | Guard at step 9, body 10–13, post-loop 14; last body step routes both fields back to the guard; cancel routes to a terminal | A worked skeleton with slots — the fill-in-the-blank shape the framing rule excludes. The engine fact under it, that a backward edge needs a gate on the path, is carried. |
| `workflow_routing_rules` 6a | A loop's exit option must name the first step after the loop body, never "next" | A correctness rule about one topology. The engine fact under it — "next" is positional — is carried; the rest is loop design. |
| `workflow_routing_rules` 6b | A save-and-continue back-edge lands on the re-query step, not the format step | The strongest archetype candidate here: it is `scoped_row_editor`'s defining hazard and a real finding (the saved value appears to revert). Belongs to a procedure, not to the engine. |
| `workflow_routing_rules` 5 | A condition's false branch must not reach a gate that branch should not encounter | Design rule; the simulator already checks the reachability form of it. |
| `workflow_routing_rules` 7 | How to interpret "Path X has no decision entry for human_gate step N" | Guidance on reading a simulator error. Belongs with the simulator's error text. |
| `step_usage_patterns` § iterator + human_gate | The preference-gate pattern: js_transform builds options → condition guards → iterator presents one choice gate per item | A dialog strategy (§12.3), written as a four-step fill-in. |
| `step_usage_patterns` § choice with option `iterator` | "Do NOT add a preceding js_transform to build the options array" | The engine fact — an option's `iterator` expands it per element — is on the human_gate contract. "Do not add a step" is a design instruction. |
| `step_usage_patterns` § form | "Never collect a date or an enumerable value as free text and then parse it with an llm_call" | A design judgement about cost and determinism. Correct, and not a statement of what the engine accepts. Already duplicated onto the human_gate contract by an earlier sprint — resolve when those prompts retire. |
| `workflow_constraints` § suspending iterator vs flat loop | Choose by whether iterations share state | A selection rule between two topologies — archetype territory. |
| `template_syntax` § message_template | Transform Handlebars into indexed dot-notation | An instruction to a translation stage that does not exist in Novia's path. The engine fact — only double braces are recognised, everything else passes through literally — is carried. |
| `runtime_bindings` § input.* | What `input` contains for create_workflow runs and for `*_entity` runs | Specimen-specific, not an engine fact. Read the workflow row. |

#### `stale` — wrong against the code today

| Source | Claim | Actual behaviour |
|---|---|---|
| `template_syntax` | "If the path does not exist in local_state, the template resolves to an empty string silently" | `resolveTemplate` returns the match unchanged (`template-resolver.mjs:95`) — the literal `{{key}}` is delivered to the model or the user. This is the root of the standing "prompts hand the LLM their own token text" defect. The bridge states the true behaviour. |
| `runtime_bindings` | A dot-notation output_key requires the parent object to already exist | `setPath` creates intermediate objects (`run-workflow.mjs:1732`). |
| `step_usage_patterns` | "only top-level keys are reliable write targets; for nested writes, return the full updated object" | Same as above, stated as a workaround for a limitation that is not there. |
| `workflow_constraints` § condition | "on_success and on_else use step:N format" | Contradicted by `step_usage_patterns` § condition ("Do NOT use step:N here") and by the engine, which normalises both (`run-workflow.mjs:1711`). Resolved in A2 by describing normalisation; both statements are cut. |
| `workflow_routing_rules` 1, `workflow_constraints` § step array | "Every step that calls an external service MUST set on_else: cancel" | Not a branch the engine takes. serv_* and llm_call steps signal failure by throwing, and a throw fails the run (`run-workflow.mjs:323`); an iterator item failure does the same (`run-workflow.mjs:1351`). Only `condition` and `simulate` read `on_else`. The convention is harmless, but its stated purpose is false and a design relying on it has no recovery path. |
| `workflow_constraints` § Guard 3 | "the loop exhausts Lambda execution time (~60 seconds)" | A volatile number inside an instruction; the mechanism is what matters, and the stuck-step guard fires first at three hits. |

#### Count

| Disposition | Rows |
|---|---|
| `registry` | 8 |
| `overstep` | 11 |
| `stale` | 6 |

The eleven `overstep` rows are the Sprint 10 evidence base. Five concern loop and
save-and-continue topology across four different rows — one procedure (`scoped_row_editor`)
stated five times in four places, which is §12.10's finding measured from the cut side.
