# Novia — Agentic Process Design
## evolving-mind-ai — Sprint 5+ Feature Spec

---

## 1. Overview

Novia is the agentic layer of evolving-mind-ai. Where the existing system executes **pre-defined workflows** in response to classified intents, Novia reasons dynamically about the system's current state and decides its own action sequence. It is invoked conversationally via Slack and operates within explicit boundaries defined by fault domain triage.

### 1.1 How Novia Differs from Existing Mechanisms

| | Workflow execution | general_chat | Novia |
|---|---|---|---|
| **Reasoning** | Declarative, pre-defined | Single-pass LLM | Multi-step agentic loop |
| **Actions** | Step types (serv_query, llm_call, …) | None — chat only | Tools (query, invoke, fix, inspect) |
| **State** | PGC_WorkflowRun stack | PGC_SessionEntry | PGC_SessionEntry + tool call log |
| **Scope** | Single workflow | Conversational | Cross-system |
| **Correction authority** | fix_workflow (human-triggered) | None | Generation fault domain only |

### 1.2 Primary Roles

1. **Extender** — chains workflows together, handles cross-domain reasoning, performs tasks that currently require multiple human-triggered commands.
2. **Corrector (bounded)** — corrects artifact-level Generation decisions: subjective LLM choices that are observable at runtime and fixable without code changes. See Section 6.

Novia is **not** a substitute for fixing Instruction domain failures (those require prompt updates and human judgment) or Execution domain failures (those require code changes).

---

## 2. Architecture Position

Novia lives entirely in the PROC tier. It follows all existing tier boundary rules.

```
Slack /novia → EXP slackbot → SQS WorkflowQueue (NOVIA_MESSAGE) → PROC novia.mjs
                                                                         ↓
                                                              [agentic loop — n turns]
                                                                         ↓
                                                     SQS SlackResultsQueue → EXP reply
```

New SQS message type: **`NOVIA_MESSAGE`** (fire-and-forget, no workflowRunId).

Thread continuation works identically to `general_chat`: the callback handler matches `slack_thread_ts` → `PGC_Session` → resumes the Novia session.

Novia creates its own `PGC_Session` row (`session_type = 'novia'`) on first invocation and appends `PGC_SessionEntry` rows per turn, exactly as designed in `session-chat-design.md`.

---

## 3. Context Assembly

Before Novia reasons about a task, it assembles situational awareness from three sources. This assembly is performed at session start and cached on the session object.

### 3.1 System Context (Layer 1 — Static)

Injected from `PGC_SystemContext`. A new entry with key `novia_system_prompt` describes Novia's role, fault domain authority, available tools, and the tables it may read and write. A second entry `novia_context_index` is a structured JSON index of what to query for situational awareness:

```json
{
  "on_start": [
    { "table": "PGC_Capability",    "purpose": "what the system can do" },
    { "table": "PGC_WorkflowStats", "purpose": "workflow health — failure rates" },
    { "table": "PGC_Workflow",      "purpose": "available workflows", "columns": ["name", "domain", "version"] },
    { "table": "PGC_Prompt",        "purpose": "registered LLM prompts", "columns": ["intent_category", "domain", "version"] }
  ],
  "on_domain_task": [
    { "table": "PGC_Schema",        "purpose": "table definitions for the target domain" },
    { "table": "PGC_EntitySchema",  "purpose": "entity definitions for the target domain" }
  ],
  "on_correction_task": [
    { "table": "PGC_WorkflowRun",   "purpose": "recent run history for the target workflow", "limit": 5 },
    { "table": "PGC_WorkflowRunStep","purpose": "step audit log for the failed run" }
  ]
}
```

Novia queries these tables at the start of the relevant task type, not all at once. This keeps the context window focused.

### 3.2 Memory Context (Layer 2 — Episodic + Semantic)

Novia queries `PGC_Memory` for memories relevant to the task:
- Semantic memories about the target domain or workflow (what design decisions were made)
- Episodic memories about prior correction attempts (what Novia or fix_workflow tried before)
- Procedural memories about the system's known failure patterns

Memory budget: 800 tokens (larger than standard prompts — Novia needs more context than a single-step LLM call).

### 3.3 Diagnostic Context (Layer 3 — On Demand)

When a correction task references a specific run, Novia can retrieve:
- The failed `PGC_WorkflowRunStep` output snapshot
- The `PGC_SessionEntry` reasoning from the `llm_call` that produced the bad output (via `query_id`)
- Prior `/explain` session entries for the same run

This is the bridge between the diagnostic layer (`session-chat-design.md`) and the correction layer. Novia reads what the human saw in `/explain` before deciding how to fix it.

---

## 4. Tool Catalog

Novia's "tools" are structured action types it can invoke. Each maps to existing system infrastructure.

### 4.1 Read Tools (no confirmation required)

| Tool | Mechanism | Notes |
|---|---|---|
| `query_table` | SERV `getRows` | Any PGC or PGD table; domain-scoped by default |
| `query_entity` | SERV `serv_entity_query` | Returns assembled entity (e.g. full flashcard with reviews) |
| `read_memory` | `memory-client.mjs` | Semantic/episodic/procedural by scope |
| `read_workflow` | SERV `getRows` on PGC_Workflow | Returns steps JSON for inspection |
| `read_prompt` | SERV `getRows` on PGC_Prompt | Returns prompt text + output schema |
| `simulate_workflow` | `simulation-engine.mjs` L1/L2 | Validate steps before proposing a fix |
| `get_run_history` | SERV `getRows` on PGC_WorkflowRun + PGC_WorkflowRunStep | Diagnose a failed run |

### 4.2 Action Tools (human confirmation gate required)

| Tool | Mechanism | Fault domain | Confirmation trigger |
|---|---|---|---|
| `invoke_workflow` | `enqueueWorkflow` | n/a — extension | If non-read workflow (create, delete) |
| `fix_workflow_steps` | SERV `updateRows` on PGC_Workflow | Generation | Always — shows diff of proposed changes |
| `fix_prompt` | SERV `updateRows` on PGC_Prompt | Instruction | Always — Novia proposes, human confirms |
| `fix_schema` | SERV DDL `addColumn` / `modifyColumn` | Contract | Always — high-risk, explicit approval |
| `write_memory` | `memory-client.mjs` | n/a | Silent — episodic write of what Novia did |

**Confirmation gate pattern:** Before any action tool, Novia posts a `HUMAN_GATE` with a summary of what it intends to do, the fault domain it has identified, and a diff or description of the change. The user selects Approve or Cancel.

### 4.3 Out-of-Scope Actions (Novia must never perform)

- Modifying system code (`.mjs` files)
- Dropping or truncating tables
- Modifying `PGC_StepType` definitions
- Modifying `PGC_TableMap` permissions
- Fixing Execution domain failures (harness bugs) — these require code changes

---

## 5. Use Cases

### UC-1: Fix a workflow (Generation fault domain)
> "Novia, the quiz workflow is routing incorrectly after step 3"

1. Novia reads `PGC_Workflow` steps + run history for the target workflow
2. Runs `simulate_workflow` (L1) on current steps
3. Reads memory for prior fix attempts
4. Reasons about the routing issue and produces a corrected steps array
5. Posts confirmation gate: "I will change step 3's `on_success` from `step:5` to `step:4`. [Diff]. Approve?"
6. On approval: `fix_workflow_steps` → upserts to PGC_Workflow → re-runs L1
7. Writes episodic memory: what was wrong, what was changed, whether L1 passed

**Boundary:** If the issue is in a prompt the workflow calls (Instruction domain), Novia surfaces the diagnosis and defers to UC-2 rather than patching the workflow around the bad prompt output.

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

1. Novia queries `PGC_WorkflowStats` (failure_rate_pct, avg_execution_ms)
2. For high-failure workflows, retrieves recent failed run step outputs
3. Cross-references with PGC_Memory for known issues
4. Produces a ranked report: workflow name, failure rate, most common failure step, suspected fault domain
5. Does not attempt fixes — presents findings for human decision

### UC-7: Interact with diagnostics
> "Novia, explain run 458 — why did step 11 fail?"

1. Novia retrieves the `PGC_WorkflowRunStep` output for run 458 step 11
2. Looks up the `PGC_SessionEntry` reasoning from the `llm_call` that produced the failing output (via `query_id`)
3. Retrieves any prior `/explain` session entries for the same query
4. Synthesizes a diagnosis, identifies the fault domain, and recommends the correct fix layer
5. If correction is within Novia's scope (Generation domain), offers to proceed to UC-1

---

## 6. Agentic Loop Design

Novia's reasoning loop is **not** implemented as a `PGC_Workflow` row. Pre-defined workflows cannot decide their own next action. Novia's loop lives in `novia.mjs` as a new PROC endpoint.

### 6.1 Loop Structure

```
receive NOVIA_MESSAGE (or thread continuation)
  ↓
assemble context (Layer 1 + 2; Layer 3 if correction task)
  ↓
[reason turn]
  LLM call: given context + conversation history, decide next action
  Output: { action: "tool_name", params: {...}, reasoning: "..." } | { action: "respond", message: "..." }
  ↓
if action == "respond":
  post to Slack → end turn (await thread reply)
if action is read tool:
  execute → append result to session → loop (reason again)
if action is action tool:
  post HUMAN_GATE → await resume_gate
    on approve: execute → append result → loop (reason again)
    on cancel: post cancellation message → end turn
if loop_count > MAX_TURNS:
  post "I've reached my reasoning limit for this task. Here is what I found: [summary]" → end turn
```

### 6.2 Session Continuity

Each Novia turn appends to `PGC_SessionEntry`:
- Tool calls are recorded as `role = 'tool'` entries (content = JSON of tool name + params + result)
- The full conversation + tool log is replayed to the LLM on each turn, giving Novia continuity across the loop

### 6.3 Safety Limits

| Limit | Value | Reason |
|---|---|---|
| MAX_TURNS per NOVIA_MESSAGE | 8 | Prevent runaway loops |
| MAX_HUMAN_GATES per session | 3 | Prevent approval fatigue |
| MAX_ACTION_TOOLS total | 5 | Hard cap on system mutations per session |

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

The existing `PGC_Session` design (see `session-chat-design.md`) is extended with one additional session type and two new fields:

| Field | Type | Notes |
|---|---|---|
| `session_type` | varchar | Added value: `'novia'` |
| `novia_turn_count` | integer | Loop counter; stops at MAX_TURNS |
| `novia_action_count` | integer | Action tool counter; stops at MAX_ACTION_TOOLS |

No new tables required. Tool call log entries use `role = 'tool'` in `PGC_SessionEntry`.

---

## 10. Open Design Questions

These require decisions before implementation begins:

1. **Prompt architecture for Novia's reasoning turn:** Should the reasoning LLM call use `claude-sonnet-4-6` (full capability) or a fast/cheap model for simple tool decisions? The action selection step is the critical one — likely `smart` model. Tool result summarization could be `cheap`.

2. **Tool call format:** Novia's LLM output for an action must be a structured JSON object. Should it use the native LLM tool-use API (function calling), or the existing `llm_call` + `review-output.mjs` pattern with a fixed output schema? The native tool-use API is cleaner but requires confirming it's available via the Perplexity gateway.

3. **Resume gate routing:** When a human approves a Novia action gate, the resume SQS message currently routes to `run-workflow.mjs` (for workflow runs). Novia needs its own resume path to `novia.mjs`. Options: (a) new `NOVIA_RESUME` SQS action, (b) reuse `resume_gate` with a `session_type` discriminator.

4. **Instruction domain fixes:** UC-2 describes Novia proposing prompt changes for human approval. Should this be a full human-collaborative turn (Novia drafts, human edits inline, then approves) or a gate (Novia drafts, human sees the diff, approves or rejects)? The latter is simpler to implement first.

5. **Novia vs. fix_workflow boundary:** `fix_workflow` already exists as a user-triggered workflow. Does Novia replace it, wrap it, or run alongside it? Recommended: Novia wraps `invoke_workflow fix_workflow` for user-reported bugs but can also read and propose direct step fixes for cases `fix_workflow` can't handle (e.g. cross-step routing restructuring).

---

## 11. Implementation Sequence

Prerequisites (from open work list):
- `PGC_Session` / `PGC_SessionEntry` tables bootstrapped (session-chat-design.md §11)
- `/chat` and `/explain` commands implemented (session-chat-design.md §11)
- `PGC_Prompt.domain` column (X2) in place

Sprint 5 build order:
1. `PGC_SystemContext` seeds: `novia_system_prompt`, `novia_context_index`
2. `NOVIA_MESSAGE` SQS type registered in `handler.mjs` dispatcher
3. `novia.mjs` PROC endpoint — context assembly + reasoning loop (read tools only first)
4. `/novia` Slack command — EXP routing + intent map entry
5. Action tools with confirmation gates (fix_workflow_steps first — lowest risk)
6. Memory read/write integration
7. UC-1 (fix workflow) validated end-to-end from Slack
8. UC-5 (inspect data) validated — highest-frequency use case
9. Remaining use cases in priority order

> Full sprint scope to be confirmed at Sprint 5 scoping.
