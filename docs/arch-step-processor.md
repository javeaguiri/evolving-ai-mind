# Step Processor — Execution Engine
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture. Main doc: `docs/architecture.md`. Step type catalog: `docs/arch-step-types.md`. See also: `docs/arch-intent.md`, `docs/arch-workflow-patterns.md`.

> Step type reference (llm_call fields, serv_query fields, iterator options, etc.) is in `docs/arch-step-types.md`.

### 6.5 Step-executor, WorkflowRun and the execution loop

When the Intent Preprocessor (or a direct command handler) decides a workflow
should run, it creates a `PGC_WorkflowRun` row and enqueues a `WORKFLOW_STEP
execute_top` SQS message. From that point, `run-workflow.mjs` takes over.

#### PGC_WorkflowRun — the process control block

Every workflow execution has exactly one `PGC_WorkflowRun` row. This row is the
complete runtime state of the execution — nothing is held in Lambda memory between
SQS invocations.

Full column definitions: `docs/arch-data.md` Section 4.3.

Key runtime fields:
- `stack` — execution stack (see 6.5.2)
- `state` — deprecated; use `stack[top].local_state` during execution
- `input` — original input passed to the run (available as `input.*` in local_state)
- `callback` — `{ provider, channel, threadId }` — where to send results
- `error` — structured error; also used for stuck-step detection
- `step_count` — total steps executed — velocity guard uses this

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
Execute step (see docs/arch-step-types.md — step types)
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
  { "frame_id": "B", "type": "human_gate",  "status": "awaiting", "gate_type": "list_selection", "step_number": "3" }
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
  ├── Applies mutation (text_input value write, list_selection row resolution, etc.)
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
| `review_object` | View a structured summary, click Confirm | `context_key` → object or array; rendered as key-value pairs. An array value whose items are plain records with no recognized single-field shape (no `syntax`/`verb`/`command`) renders as a markdown table with one data-driven column per distinct record key, labeled via the same `formatColumnHeader` logic `list_selection` uses — not an unlabeled positional join |
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
  "gate_type":        "confirm | list_selection | text_input | review_object | choice | followup_prompt",
  "description":      "Human-readable — for workflow authors and right-brain only",

  "message_template": "Displayed to user. Supports {{template}} substitution from local_state.",

  "context_key":      "dot.path.into.local_state",
  "item_primary_key": "field name — used as an item's value where a gate needs one",

  "item_action": {
    "condition":  "item.foreignKeys && item.foreignKeys.length > 0",
    "action":     "select_row",
    "label":      "Open",
    "on_select":  "step:40"
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

**`context_key`** — dot-path into `local_state`. For `list_selection`, must resolve to
an array. For `review_object`, resolves to an object or array — arrays are rendered
as a table-name / column-list display. Optional for `confirm`.

**`item_action`** — `list_selection` only. Defines what selecting a row does.
`condition` is evaluated against each item — items where the condition is falsy are
still listed but are not selectable. `on_select` is required and drives the routing;
see `docs/arch-step-types.md` for the full field reference.

**`options`** — rendered as Block Kit buttons. Each `on_select` drives post-gate
routing: `"next"` advances sequentially, `"step:N"` jumps to step N, `"cancel"`
cancels the run. Must include at least one option with `action: "cancel"`
(confirm/list_selection) or `value: "cancel"` (choice) — this may be in
`special_buttons` instead of `options`.

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
  "gate_type":     "list_selection",
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

`message_ts` is present when a gate re-renders while staying suspended (e.g. a
`list_selection` selection that resolved to no row) — signals `callback.mjs` to use
`chat.update` (in-place edit) instead of posting a new message.

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

#### Re-rendering while a gate stays suspended

A gate can be re-rendered without advancing. `list_selection` does this when a
submitted selection resolves to no selectable row: the Step Processor re-enqueues
the `HUMAN_GATE` payload with the original `message_ts` and an added error line, so
`callback.mjs` edits the existing Slack message in place (`chat.update`) rather than
posting a new one. The stack remains suspended throughout — the gate never advances
on an unresolved value.

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

The `simulate` step type is the right-brain's earliest operational capability.
It dry-runs a generated workflow definition through the Step Processor's own
execution logic using injected mock outputs and decision scripts, validates every
`local_state` transition, and surfaces structured failure reports before the
workflow is registered in `PGC_Workflow`. It is a prerequisite for `create_workflow`
being trustworthy and is classified as Phase 2 work, not Backlog.

**Full detail — inputs, validation levels, result structure, the standalone HTTP
endpoint, and every other consumer of the simulation engine — lives in
`docs/arch-simulation-engine.md`.** That module (`src/proc/simulation-engine.mjs`)
is consumer-agnostic: this `simulate` step type is one of four independent callers,
alongside Novia's `simulate_workflow` tool, `dev_scripts/upsert-workflow.mjs`'s
pre-write guard, and `troubleshoot-workflow.mjs`. This section covers only how a
workflow author embeds a `simulate` step in a step array.

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
`mock_outputs_key` and `paths_key` are optional — Level 1, 2a, and 2b always run
once Level 1 passes; only Level 2c (legacy path execution, informational-only) is
skipped when they are absent. See `docs/arch-simulation-engine.md` for what each
level validates and why `mock_outputs`/`simulation_paths` are structured the way
they are.

#### Simulation mode flag on WorkflowRun

When `run-workflow.mjs` executes a `simulate` step, it sets
`PGC_WorkflowRun.state.simulation_mode = true` before the simulation begins and
clears it after. This flag is checked by every step handler in `step-executor.mjs`
— when true, the handler returns the mock output from the decision script instead
of calling the real service. No new Lambda, no new SQS queue — the same Step
Processor executes both live runs and simulations. The only difference is the
execution context.
