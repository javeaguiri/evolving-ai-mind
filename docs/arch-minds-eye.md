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
| `read_workflow_run` | PROC — run row, its top frame, `PGC_WorkflowRunStep` | Status, version, test flag, error; the waiting gate's `gate_id`, `gate_type` and dialog from `buildDialog`; `outline` / `steps` projections, bounded like `read_workflow`. Reads the stack, never `PGC_WorkflowRun.state`, which is written only at completion. Any run (§4.4) |
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
| Inline write | `update_data`, `insert_data`, `upsert_data`, `manage_routing_aliases` | None — executes immediately |
| Gated write | `register_workflow`, `propose_workflow_fix`, `propose_schema_fix`, `delete_data`, `drop_table`, `create_view`, `drop_view` | HUMAN_GATE before execution |
| Trigger | `run_workflow` | Dispatches a registered workflow to the step-executor engine |
| Housekeeping | `write_memory` | None — silent episodic write |
| Test | `start_test`, `reset_test`, `end_test`, `answer_gate`; `sandbox: true` on the data tools and `propose_workflow_fix`; `test: true` on `run_workflow` | None — confined to the sandbox and to her own test runs (§4.4) |

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

**`propose_workflow_fix`** (Sprint 12, Track A) — `{ workflowName, patch, removeSteps?,
baseVersion, reasoning }`, or `{ workflowName, steps, reasoning }` for a full rewrite. Changes a
workflow that already exists.

**Granularity is the step, never the field.** A patch entry replaces the stored step of that
identifier outright; it is not merged field by field. That keeps every submitted step a valid,
simulatable unit, keeps L0/L1/L2 running against the merged array, and makes the gate diff exact
rather than inferred — under a patch only the steps she sent can differ, where a resubmitted full
array could show spurious differences wherever an untouched step came back reformatted.

Four properties, and the first is the reason the tool changed:

- **Only the steps being changed have to reach her intact.** The tool previously took the
  COMPLETE array, so repairing one step meant reading and resubmitting all of them. On a workflow
  past the transcript cap the submitted array was part-read and part-remembered, and that is the
  root of the whole 2026-08-27 defect class — `process_receipt` step 13 silently losing four
  fields. Sprint 11 made the full read survivable; the patch makes it unnecessary.
- **Absence means unchanged**, so deletion is explicit in `removeSteps`. The full-array form could
  always delete by leaving a step out; without an explicit list that capability would have
  disappeared silently.
- **The merged array is validated before the write, at both ends.** It was validated at *neither*
  before Sprint 12: `preGateRefusal` opened with a `register_workflow`-only guard, and the write
  body had no `runSimulation` at all — so a repair could leave a workflow in a state
  `register_workflow` would have refused outright, on an array that is already live.
  `simulateForRegistration` is shared with `register_workflow` rather than reimplemented.
  Every step of the merged array is validated, not only the patched ones, so a latent issue
  elsewhere refuses the patch too — and a validator defect does the same. She is told both: an
  empty-patch simulation shows what already fails, and a refusal that contradicts the
  `PGC_StepType` contract or a step that has run is reported to the user as a suspected Validation
  defect, never designed around. She triages the validator; she does not troubleshoot it.
- **`baseVersion` refuses a write onto a workflow that moved.** She reads at T0 and submits at T1;
  the full-array form overwrote anything that landed between with no trace, and could not have done
  otherwise. Refusing is affordable under a patch because recovery is re-reading the few steps
  being changed. The likeliest source of a mismatch is her own previous write, so the result
  returns `nextBaseVersion` to carry forward.

`mergeStepPatch` is pure and exported; `resolveProposedSteps` is shared by the pre-gate refusal,
the gate text and the write, so none of the three can form a different opinion about what is being
written. **The simulator never sees a patch** — it always receives a complete workflow. A patch
changes what crosses the model/engine boundary, not what the validator receives.

`simulate_workflow` accepts the same patch form and merges server-side, since a tool that demanded
the whole array in order to check a fix would defeat the patch it was checking. It skips the
version check because it writes nothing.

**A domain workflow must declare at least one invocation phrase.** `intent_keywords` is derived
from `intentPhrases` when the field is omitted, and a `domain`-carrying registration that supplies
neither is refused. The consequence of allowing it is misrouting rather than silence: the generic
CRUD workflows are `domain: null`, so they compete inside every domain, and `update_entity` claims
`update`, `edit`, `modify` and `change`. A workflow with no keywords cannot win a scan it is
nominally part of. A `domain: null` system workflow legitimately has none — `ping_core` carries
`[]` — so the rule is a domain-workflow rule, not a universal one.

**`manage_routing_aliases`** — `{ workflowName? | domain?, add?, remove? }`. Edits the words a
user types to reach something, after registration. One concept at the tool boundary, two surfaces
underneath: with `workflowName` it writes `PGC_IntentMap` rows (Pass 1, exact phrase) and keeps
`PGC_Workflow.intent_keywords` in step (Pass 2, word-boundary scan), applied as a delta so a
deliberately divergent keyword survives an edit; with `domain` it edits `PGC_DomainHelp.aliases`,
which is part of that row's `embed_source`, so the domain embedding is recomputed and the change
reaches `classify-intent` as well as `/help`.

Two refusals hold it in place. **A phrase already bound elsewhere is refused, not shadowed** —
Pass 1 matches an exact pattern and would otherwise take one of two claimants arbitrarily, which
is how `modify budget` came to start two different workflows. **A workflow's own name is never
removed** — `buildIntentMapRows` seeds it and `/help` falls back to it, so it is the route of
last resort.

It is an inline write rather than a gated one: the change is narrow, reversible by the inverse
call, and `update_data` already permits far more damage without a gate.

### 4.3 Out-of-Scope Actions (Novia must never perform)

- Modifying system code (`.mjs` files)
- Dropping or truncating tables
- Modifying `PGC_StepType` definitions
- Modifying `PGC_TableMap` permissions
- Fixing Execution domain failures (harness bugs) — these require code changes

### 4.4 Test tools — Novia tests her own work (Sprint 15)

A test runs a workflow end to end in the **sandbox** (`docs/arch-sandbox.md`), against a plan the
user approved. The procedure she follows is the `sop_test_cycle` row; the tools are below.

**The loop.** The call that sets a test run moving is the call that waits for it.
`run_workflow { test: true }` starts a run with `sandbox` set and
`callback: { provider: 'novia', sessionId, reply }`, and `answer_gate` answers its gate; each records
its open call as a `__pending__` entry **before** the run is dispatched or the answer sent, and
the round ends. For a `novia` run `enqueueCallback` sends nothing to Slack: every message the run
would have sent becomes a `MINDS_EYE_RESUME` with `resumeType: 'run_event'` for her session, and
`handleRunEvent` resolves the open call when the message ends the wait (`describeRunEvent`) — a
gate (with the dialog as sent, so a redrawn form carries its warning), an error, completion
(`WORKFLOW_COMPLETED`, which no person is sent), or any message once the run has stopped. A
notification on the way to the next gate does not; what a notify step said reaches her in the
event's `steps_since`. Because the wait is recorded first, nothing the run does can arrive before
she is waiting for it. The resolution closes the pending call as an approved action gate does, so
her transcript only appends and its cached prefix holds; `(session_id, sequence_number)` is unique,
so two racing events resolve it once. Events per session are bounded by
`minds_eye_preferences.max_test_events`.

| Tool | Does | Boundary |
|---|---|---|
| `start_test { tables: [{ name, rows }] }` | Creates the sandbox; `rows` is `all`, `none` or a filters array | Replaces any earlier sandbox |
| `reset_test` | Back to the data `start_test` copied | — |
| `end_test` | Drops the sandbox | Run records stay |
| `run_workflow { ..., test: true }` | Starts a test run in the sandbox, then waits; its first event is the result | Refused with no sandbox; bounded per session |
| `answer_gate { runId, gateId, action, formValues?, inputValue?, listGroup?, selectedValue? }` | `answerGate` (`POST /gates/{runId}/responses`), then waits; the next event is the result | Her own test runs only — every other run's gates belong to the user. A `gateId` that is not the waiting gate is `409 gate_moved` |
| `sandbox: true` on `query_table`, `run_sql`, `update_data`, `insert_data`, `upsert_data`, `delete_data` | Reads or writes the sandbox | Ungated — `delete_data` included |
| `propose_workflow_fix { sandbox: true }` | Writes an uncommitted test copy into the sandbox's `PGC_Workflow` | Ungated, validated as any patch; gone at `end_test` |

**Apply and test.** `gateButtonConfig` gives the approval gate of `propose_workflow_fix` and
`register_workflow` a `testLabel` (*Apply and test*, *Register and test*); `callback.mjs` draws it
as a second approve button (`mindsEyeGateButtons`), and its click carries `test: true` through
`interactive.mjs` to `MINDS_EYE_RESUME`. When the change is applied, `withTestRequest` marks the
result `test_requested`: she plans the test under `sop_test_cycle` and responds with the plan for
approval. A refused change asks for nothing.

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
> on that basis. A new workflow takes its shape from a working one, read with `read_workflow`: the
> live workflows are the pattern library, and they cannot go stale against themselves.
>
> | Subsection | Status |
> |---|---|
> | 12.1–12.2 the measured problem | Evidence, 2026-07-26 |
> | 12.4 phases become guidelines | Direction; not built |
> | 12.5–12.6 removals, dependencies | Direction |
> | 12.7 open questions | One open — whether the final step array stays a tool |
> | 12.8 defects | Register. **Do not run `create_workflow` while these stand** |
> | 12.13 the cut list | Register, Sprint 9 A4 |

The proposal is to dissolve `create_workflow` — today a 73-step `PGC_Workflow` row at v85 —
into a set of tools Novia orchestrates, with workflow design patterns read from the live
workflows rather than held as prose inside prompts.

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
| **Shape knowledge** — how one kind of workflow is built | `RAW INPUT PARSING STEPS` (64 lines, pivot tables), `FLAT LOOP PATTERN`, the FK-dependency block, the options/reveals feed rules, the reveal-vs-two-gate boundary, all 16.6 KB of `step_usage_patterns` | Read from a working workflow of that shape |
| **Orchestration** | `CORRECTION MODE` (59 lines); the revision, consolidation and routing-repair passes in `design_workflow_process`; `PREPARATION-STEP RULE` | Deleted — the agentic loop is the orchestrator |
| **Registry transcribed as prose** | A hand-maintained list of 20 prompt names; `step_type_contracts` resident in three prompts; a literal CHECK-constraint enum | Queried at need |
| **Capability instruction** | `TRANSLATION RULES`, `DATA PROVENANCE CHECK`, `SCOPE`, `ECONOMY`, Guards 1 and 3 | Retained |

Corroboration: `analyze_workflow_gaps` is the shortest of the four (75 lines), carries almost
no shape knowledge, does one job, and is not a source of recurring defects.

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
3. **Read a working workflow of the same shape.** `read_workflow` on the closest existing
   workflow gives a topology that already runs; with none, design the sequence from the
   capability instruction.
4. **Settle the shape, and test its assumptions against the data.** Where the topology comes
   from depends on step 3:
   - **Shape taken from a working workflow** — its topology already runs. Adapt it to this
     domain's tables and move to content.
   - **No workflow of this shape** — sketch the flow and run L0 and L1 on the sketch immediately. Both are
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
- **How this shape of workflow behaves** — a working workflow of that shape, read with
  `read_workflow`.
- **What the engine will accept** — queried, not transcribed: `PGC_StepType`, `PGC_Prompt`,
  `PGC_Schema`.

Dialog design is the clearest case, because the current prompt fuses all three:

| Knowledge | Source | Loaded |
|---|---|---|
| Gate types; `form` is the only type that collects input; `output_key` writes only on form, confirm-with-`context_key`, and choice; a field `type` names what is collected, never a widget; option-count caps; `list_selection` requires `item_action` | `PGC_StepType` `human_gate` contract | Queried |
| Reveal versus two gates; hierarchy as reveals-per-parent with options-per-leaf; per-option `iterator` for data-driven buttons; per-row form and its field ceiling | A working workflow of that shape | Read on demand |
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
deterministic path. Gated on evaluating Novia's capability first:
the hybrid stays available as a fallback only if that evaluation fails, and is not designed for
in advance.

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
2. Whether producing the final step array stays a tool. It is bulk mechanical output, which suits
   a focused single-shot call and keeps a large JSON artifact out of the transcript. The only
   phase whose side of the tool/guidance line is undecided.
3. ◐ **Partly answered — Sprint 9 raised all three budgets and none was the one that binds.**
   `turn_limit` 8 → 12, `max_actions_per_session` 5 → 8, `max_output_tokens` 8192 → 10240 (which
   was absent from `minds_eye_preferences` entirely and falling through to a default). But the
   round runs its turns inside **one 240s Lambda invocation**, so a round dies at turn 3–4 and
   `turn_limit: 12` is unreachable. `roundBudgetExhausted` now stops before a turn there is no
   room to finish. **Session compression at the turn-limit gate remains unexercised**, because a
   round still cannot reach that gate — it carries to Sprint 10 behind the transcript fix, which
   is what makes turns cheap enough for a round to get there.
4. ✅ **CLOSED — Sprint 9, B1. A `level` selector, not a new tool.** L0 is `level: 0` on
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
  `iterator` on their options and the one that should not does not.

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
unfalsifiable. A cut rule Novia turned out to need goes where she reads it — a step type
contract, or the convention bridge. A cut rule nothing ever asked for is prose that dies with its
prompt.

| Disposition | Meaning |
|---|---|
| `registry` | Already a queryable row. The bridge points at the table instead of restating it. Not evidence of anything — this is AC2 working. |
| `overstep` | A design instruction: an ordering, a shape to fill, or a "when X, do Y". Not a statement of what the engine accepts. |
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
| `workflow_routing_rules` 6b | A save-and-continue back-edge lands on the re-query step, not the format step | A real finding (the saved value appears to revert), but about one topology — it belongs to a workflow of that shape, not to the engine. |
| `workflow_routing_rules` 5 | A condition's false branch must not reach a gate that branch should not encounter | Design rule; the simulator already checks the reachability form of it. |
| `workflow_routing_rules` 7 | How to interpret "Path X has no decision entry for human_gate step N" | Guidance on reading a simulator error. Belongs with the simulator's error text. |
| `step_usage_patterns` § iterator + human_gate | The preference-gate pattern: js_transform builds options → condition guards → iterator presents one choice gate per item | A dialog pattern, written as a four-step fill-in. |
| `step_usage_patterns` § choice with option `iterator` | "Do NOT add a preceding js_transform to build the options array" | The engine fact — an option's `iterator` expands it per element — is on the human_gate contract. "Do not add a step" is a design instruction. |
| `step_usage_patterns` § form | "Never collect a date or an enumerable value as free text and then parse it with an llm_call" | A design judgement about cost and determinism. Correct, and not a statement of what the engine accepts. Already duplicated onto the human_gate contract by an earlier sprint — resolve when those prompts retire. |
| `workflow_constraints` § suspending iterator vs flat loop | Choose by whether iterations share state | A selection rule between two topologies — a design choice, not an engine fact. |
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

Five of the eleven `overstep` rows concern loop and save-and-continue topology across four
different rows — one shape stated five times in four places.
