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
| `get_run_history` | Three `getRows` calls chained via session_id FK | See §3.3. **Requires X1 applied.** Shape of step-level call depends on W1 decision. |

**FK join paths (documented in `minds_eye_context_index` seed):**

```
PGC_WorkflowRun.session_id  →  PGC_SessionEntry.session_id   (run → LLM reasoning)
PGC_WorkflowRun.id          →  PGC_WorkflowRunStep.run_id    (run → step outputs, W1-conditional)
PGC_WorkflowRun.workflow_id →  PGC_Workflow.id               (run → workflow definition)
```

**Phase 2 option:** If the three-call chain for `get_run_history` proves unreliable in practice (LLM misconstructs a filter or sequence becomes long in context), consolidate into `POST /serv/run/diagnostic` — a single server-side JOIN returning run + steps + session entries. Do not build this in advance of a demonstrated need.

### 4.2 Action Tools (human confirmation gate required)

All write operations require a `HUMAN_GATE` before execution. The gate must show: (1) the table and row(s) affected, (2) the exact change — new field values, a steps diff, or a DDL statement — so the user can evaluate the change before approving. The user selects **Approve** or **Cancel**. Novia never writes without an explicit approval on that turn.

| Tool | Mechanism | Scope | Phase | Gate content |
|---|---|---|---|---|
| `update_data` | SERV `updateRows` on any PGD table | User data | 1 | Table name, filter that selects the row(s), old vs new field values |
| `insert_data` | SERV `insertRow` on any PGD table | User data | 1 | Table name, full row values to be inserted |
| `delete_data` | SERV `deleteRows` on any PGD table | User data | 1 | Table name, filter and count of rows that will be deleted |
| `invoke_workflow` | `enqueueWorkflow` | Extension | 1 | Workflow name + input params; only for non-read workflows |
| `fix_workflow_steps` | SERV `updateRows` on PGC_Workflow | PGC config | 1 | Diff of current vs proposed steps |
| `write_memory` | `memory-client.mjs` | Memory | 1 | Silent — episodic write of what Novia did; no gate required |
| `fix_prompt` | SERV `updateRows` on PGC_Prompt | PGC config | 2 | Full prompt text diff — Novia proposes, human confirms wording |
| `fix_schema` | SERV DDL `addColumn` / `modifyColumn` | Schema | 2 | DDL statement + downstream impact (constraint violations, affected rows) |
| `update_intent_map` | SERV `updateRows` / `insertRow` on PGC_IntentMap | PGC config | 2 | Proposed pattern(s) before write |
| `update_domain_help` | SERV `updateRows` on PGC_DomainHelp | PGC config | 2 | Content diff before write |
| `update_preferences` | SERV `updateRows` on PGC_SystemContext (`minds_eye_preferences`) | PGC config | 2 | Keys changing and new values; takes effect next session |

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

### UC-4: Start or chain workflows (Extension)
> "Novia, recreate the flashcard domain and run create_workflow for the quiz"

1. Novia sequences: `invoke_workflow delete_domain` → confirm → `invoke_workflow create_domain flashcards` → observe completion → `invoke_workflow create_workflow quiz_flashcards`
2. At each step, Novia observes the WorkflowRun result before proceeding
3. On failure at any step, Novia surfaces the failure and asks how to proceed rather than attempting an autonomous fix

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
