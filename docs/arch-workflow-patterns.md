# Workflow Patterns, Validation, and Memory
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture. Main doc: `docs/architecture.md`. See also: `docs/arch-step-types.md`, `docs/arch-step-processor.md`, `docs/arch-intent.md`.

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

Full annotated workflow design is in [`docs/arch-create-domain.md`](arch-create-domain.md).

**Sprint 4 additions:** Two-layer memory architecture — pre-confirmation episodic write (step 10 `save_to_memory`) captures initial design reasoning; `revise_domain_schema` (step 12b) and `design_table` (step 13) accumulate semantic schema_expectations memories on each iteration; post-confirmation structural snapshot (steps 16b/16c `write_memory`) writes the definitive semantic record of insert expectations and `initial_value_conventions`. All three design prompts now emit `initial_value_conventions` for application-level initial values not fully described by SQL DEFAULT.

### 6.9 create_workflow Workflow

Full design documentation — including L/R collaboration architecture decisions,
the six-phase step structure with `local_state` data flow, gap taxonomy application,
simulation correction loops, and implementation notes — is in
[`docs/arch-create-workflow.md`](arch-create-workflow.md).

**Sprint 4 additions:** Skeleton-first routing validation — `design_workflow_process` now emits `routing` fields (step_label references) per process_design item; steps 21a/21b/21c derive a routing skeleton, run L1 BFS on it, and gate on failure before dialog or step content is generated. IntentMap phrasing gate — steps 35a/35b ask for invocation phrases, build a `|`-joined regex, and use it as the IntentMap pattern (step 36) so Pass 1a matches user-chosen phrases directly.

**Session 13 decisions:**

*Skeleton mode for L1 (`input.skeleton: true` on simulate step):* The `serv_step_missing_required_input` L1 check is a **content completeness** check — it verifies that a fully-formed step declares `tableName`, `row`, `filters`, and `updates`. A routing skeleton is intentionally content-free; those fields are filled in by `generate_workflow_steps`. Running this check on a skeleton produces false positives on every serv_* step. Decision: add a `skeleton: boolean` flag to the `simulate` step input, threaded through `runSimulation` → `runLevel1StaticAnalysis`. When `skeleton=true`, `serv_step_missing_required_input` is skipped. All routing topology checks (dead targets, missing `on_cancel`, unresolved templates, condition keys) still run — these apply equally to skeletons. The skeleton validate step (21b) sets `input.skeleton: true`; the final pre-write simulate (step 25) does not. L1 and L2 level definitions are unchanged.

*`on_cancel` required on all human_gate steps:* The `PGC_StepType` human_gate contract marked `on_cancel` as `required: false`, which LLMs correctly read as optional. This caused persistent `missing_on_cancel` and `missing_cancel_option` L1 failures on skeleton and full steps. Decision: add `on_cancel` explicitly to the human_gate `input_contract` as `required: true`, with a description that makes the coupling to the cancel option explicit. Applied in `seed_PGC_StepType.json` + `upsert-step-type.mjs`; no system code change.


### 6.10 Session Architecture — Chat and Diagnostics

Session architecture — including `PGC_Session` and `PGC_SessionEntry` table design,
the `llm_call` diagnostic flow, `/chat` and `/explain` Slack commands, messages array
reconstruction, and the `diagnostics_config` `PGC_SystemContext` entry — is fully
specified in `docs/arch-session.md`.

Table DDL, column definitions, and `PGC_Schema` registration entries are in
`docs/arch-data.md` section 4.3.4.


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

Full design reference: [`docs/arch-memory.md`](arch-memory.md).

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

---

### 6.17 System Workflow Catalog

System workflows are rows in `PGC_Workflow` that ship with the system (seeded via `seed_PGC_Workflow.json`). They are never generated by `create_workflow`. User-created domain workflows (e.g. `add_recipe`, `quiz_flashcards`) are not listed here.

#### Quick reference

| Workflow | Steps | LLM calls | Purpose |
|---|---|---|---|
| `create_domain` | 37 | 5 | Design and register a new data domain (schema + PGC registration) |
| `create_workflow` | 63 | 9 | Design, simulate, and register a new domain workflow |
| `fix_workflow` | 21 | 1 | Repair a broken registered workflow |
| `diagnose_prompt_schema` | 17 | 0 | Detect and repair `PGC_Prompt.output_schema` API incompatibilities |
| `add_entity` | 22 | 3 | Insert a new domain entity from natural language input |
| `get_entity` | 11 | 1 | Fetch a single entity by id or name |
| `list_entity` | 9 | 1 | List all entities in a domain |
| `update_entity` | 5 | 0 | Update a single root-table field on an entity |
| `delete_entity` | 5 | 0 | Delete an entity and all child rows via FK CASCADE |
| `help` | 6 | 0 | Display registered domain help and commands |
| `ping_core` | 32 | 0 | Smoke-test all human gate types (development only) |

---

#### `create_domain`

Full annotated design: `docs/arch-create-domain.md`.

**Phase 1 — Pre-check and use case selection**
- `1` `js_transform` — derive candidate domain slug for duplicate pre-check
- `2` `serv_query` — check `PGC_DomainHelp` for existing domain
- `3` `condition` — route to exists gate or continue
- `4` `human_gate` (confirm) — domain already exists; offer recreate or cancel
- `3a` `human_gate` (choice) — user selects use case (personal / household / professional); shapes research depth
- `3d` `js_transform` — build `use_case_context` string for right brain

**Phase 2 — Right brain research and preference gates**
- `5` `llm_call` [`research_domain_schema`] — RIGHT BRAIN: domain data-modelling best practices; surfaces structural preference questions and autonomous design decisions
- `6` `js_transform` — build `preference_gates` array from research output
- `6a` `js_transform` — format auto-decision summary for user notification
- `6b` `notify` — show autonomous decisions before gates begin
- `7–9a` `condition` + `iterator` + `js_transform` — present each preference question as a choice gate; enrich answers with question text and option description into `user_preferences`

**Phase 3 — Left brain schema design**
- `10` `llm_call` [`create_domain`] — LEFT BRAIN: design full domain schema (tables, columns, constraints, triggers, FK relationships) from research findings and confirmed preferences
- `11–11a` `js_transform` — enrich tables with `columnSummary`; build `schema_summary` and per-table review items
- `12` `human_gate` (choice) — user reviews per-table schema; chooses approve / revise / add table
  - `12b` `llm_call` [`revise_domain_schema`] — LEFT BRAIN: revise schema based on user feedback
  - `12c` `human_gate` (text_input) — capture description for new table addition
  - `13` `llm_call` [`design_table`] — design a single new table from user description
  - `14` `js_transform` — merge new table, apply modifications, topological sort
- `16` `human_gate` (confirm) — final confirmation before DDL

**Phase 4 — DDL execution and registration**
- `16b` `js_transform` — build `domain_semantic_content` structural snapshot (insert expectations, nullable columns, initial values)
- `16c` `write_memory` — persist confirmed schema snapshot as semantic memory (retrieved by `create_workflow` and `parse_entity_input`)
- `16d` `js_transform` — topological sort tables by FK dependency for DDL order
- `17` `iterator` — create each `PGD_*` table via SERV `createTable`
- `17b` `llm_call` [`generate_domain_aliases`] — generate natural language aliases (singular/plural/synonyms)
- `17c` `human_gate` (text_input) — user adds custom aliases
- `18` `js_transform` — merge LLM and user aliases; derive CRUD command list
- `19` `human_gate` (review_object) — user reviews aliases and CRUD commands before write
- `20` `serv_insert` — write to `PGC_DomainHelp`
- `21` `iterator` — insert 5 `PGC_IntentMap` rows (add/list/get/update/delete)
- `22` `iterator` — register each entity schema in `PGC_EntitySchema`
- `22a–23` `js_transform` + `notify` — confirm domain creation with registered commands

---

#### `create_workflow`

Full annotated design: `docs/arch-create-workflow.md`.

**Phase 1 — Mode and right brain**
- `1` `serv_query` — load live domain schema rows
- `2` `human_gate` (choice) — user selects workflow mode (new / variant / scheduled)
- `3` `llm_call` [`research_workflow_domain`] — RIGHT BRAIN (Perplexity sonar): domain best practices; identifies preference questions affecting workflow structure
- `4–6` `js_transform` + `human_gate` (confirm) — build and display research findings; user sees autonomous decisions before preference gates

**Phase 2 — Preference gates and user context**
- `7–8a` `condition` + `iterator` + `js_transform` — Tier 1 preference gates (choice); enrich answers with question text
- `9` `human_gate` (text_input) — optional free-text design context from user

**Phase 3 — Left brain gap analysis**
- `11` `llm_call` [`analyze_workflow_gaps`] — LEFT BRAIN pass 1: classify all gaps (schema gaps, missing prompts, blocked capabilities); emits `gap_analysis` with `confidence` flag
- `12` `js_transform` — evaluate routing flags from `gap_analysis`
- `13–14` `condition` + `notify` — hard stop if missing step type capability (Type 4b gap)
- `15–17` `condition` + `js_transform` + `human_gate` (confirm) — schema gap decision gate (Type 3a/3b)
- `18–20` `js_transform` + `condition` + `iterator` — seed missing prompts into `PGC_Prompt` (Type 4a auto-resolution)

**Phase 4 — Left brain design (process → dialogs → steps)**
- `20a` `js_transform` — initialise retry state keys
- `21` `llm_call` [`design_workflow_process`] — LEFT BRAIN pass 2: design step sequence, state map, routing skeleton; emits `routing` fields per process item
- `21a–21c` `js_transform` + `simulate` + `human_gate` — build routing skeleton; L1 BFS validates all targets; gate on failure before dialog or step content generated
- `22` `llm_call` [`design_workflow_dialogs`] — LEFT BRAIN pass 3: design Slack dialogs for every `human_gate` step
- `22a` `js_transform` — build step generation context; initialise or carry forward correction state
- `23` `llm_call` [`generate_workflow_steps`] — translate three-part design spec (process + dialogs + domain schema) into concrete step array; correction mode when `previous_draft_steps` or `path_errors` are non-empty

**Phase 4b — Domain prompt design (conditional)**
- `23a–23b` `js_transform` + `condition` — count `llm_call` steps with `prompt_draft`; skip prompt design if none
- `23c` `serv_query` — load existing `PGC_Prompt` entries for reuse check
- `23d` `llm_call` [`design_workflow_prompts`] — classify each domain-specific `llm_call` step as reuse / create / convert; draft prompt text, output schema, and model for `create` decisions
- `23e–23h` `js_transform` + `condition` + `iterator` + `js_transform` — extract create decisions; insert new prompts; apply decisions to `draft_workflow.steps`

**Phase 5 — Simulation and correction**
- `24` `human_gate` (review_object) — user reviews proposed step array before simulation
- `25–26a` `simulate` + `js_transform` — Level 1 static analysis; format issues; mark steps by pass/fail
- `27` `human_gate` (confirm) — L1 failure gate; offer regenerate or cancel (loops back to `22a`)
- `28` `llm_call` [`generate_workflow_mocks`] — generate representative mock outputs for each step
- `29` `llm_call` [`generate_workflow_paths`] — generate named simulation paths (happy / cancel / failure)
- `30–31a` `simulate` + `js_transform` — Level 2 + Level 3 path simulation; format failures; mark steps
- `32` `js_transform` — clear stale L1 result before L2 error gate
- `33` `human_gate` (confirm) — L2 failure gate; offer regenerate automatically / with feedback / cancel
- `33a` `llm_call` [`fix_workflow_routing`] — fix routing defects identified by Level 2 (targeted correction, not full regeneration)

**Phase 6 — Registration**
- `34–34a` `human_gate` (confirm) + `js_transform` — user confirms registration; strip correction state fields
- `35` `serv_insert` — write workflow to `PGC_Workflow`
- `35a–35b` `human_gate` (text_input) + `js_transform` — collect invocation phrases; build `|`-joined regex pattern
- `36` `serv_insert` — write `PGC_IntentMap` row
- `36a–36d` `condition` + `serv_query` + `js_transform` + `serv_update` — merge new command into `PGC_DomainHelp` if domain-associated
- `37` `notify` — confirm workflow registered and ready

---

#### `fix_workflow`

Triggered via `FIX_WORKFLOW` SQS or `POST /proc/fix-workflow`. Design rationale in §6.12.

- `1–2` `condition` + `serv_query` — use supplied `brokenSteps` or load live steps from `PGC_Workflow`
- `3` `js_transform` — assemble `fix_context` (normalise input from troubleshoot output or direct fields)
- `4` `llm_call` [`fix_workflow_steps`] — RIGHT BRAIN repair: diagnose root cause; produce corrected step array; optional `context_updates` for `PGC_SystemContext` and `prompt_text_change` recommendation
- `4b` `js_transform` — merge corrected steps back into full step array (LLM returns only changed steps)
- `5` `simulate` — Level 1 static analysis on merged array
- `6` `human_gate` (review_object) — show diagnosis, proposed changes, and any remaining validation issues; options: Apply fix / Cancel
- `7–8` `js_transform` + `serv_update` — compute `version + 1`; write corrected steps to `PGC_Workflow`
- `8b–8d` `simulate` + `serv_update` + `notify` — post-write L1 verification; revert and notify if it fails
- `9–10` `condition` + `iterator` — apply each `PGC_SystemContext` update produced by the LLM (Tier 2 improvement)
- `11–13` `serv_query` × 2 + `js_transform` — load and filter active/failed runs for the repaired workflow
- `14–15` `condition` + `iterator` — cancel each active run; notify its callback channel
- `16` `notify` — confirm fix applied; report version bump and context rows updated

---

#### `diagnose_prompt_schema`

Triggered via `DIAGNOSE_PROMPT_SCHEMA` SQS when an `llm_call` step returns `Agent API error 400`. No LLM calls — all repair logic is deterministic. Design rationale in §6.12.

**Rules applied (steps 1–7, each a `js_transform` on `repair_state`):**

| Step | Rule | Fix applied |
|---|---|---|
| `1` | R1 — array union types | `type: ["object","null"]` → `anyOf: [{type:"object",...},{type:"null"}]` |
| `2` | R2 — typed `additionalProperties` | `{type:...}` or `true` → `false` |
| `3` | R3 — missing `additionalProperties` | add `additionalProperties: false` to all object types |
| `4` | R4 — missing `properties` | add `properties: {}` to all object types |
| `5` | R5 — missing `required` entries | all defined properties added to `required` array |
| `6` | R6 — `anyOf`/`oneOf`/`allOf` members | apply R3+R4 to each object member |
| `7` | R7 — unsupported model name | replace with supported model from approved list |

- `7a` `js_transform` — aggregate violations; build gate message
- `8` `condition` — any violations found?
- `9` `human_gate` (confirm) — show violations and proposed repair; options: Apply / Cancel
- `10` `serv_update` — write repaired schema to `PGC_Prompt`; bump version; clear `error_log`
- `11–11b` `condition` + `serv_update` + `notify` — cancel the failed `WorkflowRun` that triggered diagnosis; notify its callback
- `12` `notify` — no violations found path
- `13` `notify` — gate cancelled path

---

#### `add_entity`

Generic workflow bound to any domain at runtime via `PGC_EntitySchema`. Invoked by intent classification when user says "add [domain entity]". All three entity query workflows (`add_entity`, `get_entity`, `list_entity`) share the same entity resolution preamble (steps 1–1d/1e) that identifies which `PGC_EntitySchema` to use when a domain has more than one registered entity type.

**Entity resolution preamble (steps 1–1e):**
- `1` `serv_query` — load all entity schemas registered for this domain from `PGC_EntitySchema`
- `1a` `js_transform` — resolve entity name directly if exactly one schema exists; build options list if multiple
- `1b` `condition` — single schema (already resolved) → `1d`; multiple schemas → `1c` (LLM selection)
- `1c` `llm_call` [`select_entity_schema`] — Haiku: pick the correct entity schema from user input semantics (e.g. "budgetary" → "Budget")
- `1d` `js_transform` — write `resolved_entity_name` to local state
- `1e` `serv_entity_schema` — load full entity schema with parent-child hierarchy and column metadata (including `allowed_values` from CHECK IN constraints)

**Parse and route:**
- `2` `llm_call` [`parse_entity_input`] — parse user natural language into a structured entity object (single record) or flat array (bulk); uses domain semantic memories (400-token budget)
- `2g` `condition` — `Array.isArray(parsed_entity)` → bulk path (`2h`); else → single-record ref FK path (`2a`)

**Bulk insert path (2h–2k):**
- `2h` `js_transform` — build preview: count, entity name, first 3 rows as sample
- `2i` `human_gate` (review_object) — user confirms before bulk write
- `2j` `serv_insert` — insert all rows in one call; `ref_fk_columns` field triggers FK string→id resolution per row
- `2k` `notify` → `6` `end`

**Single-record ref FK enrichment path (2a–2f):**
- `2a` `js_transform` — collect ref FK string values from `parsed_entity`, grouped by ref table
- `2b` `condition` — no ref FK values → `3` (skip enrichment); else → `2c`
- `2c` `llm_call` [`enrich_ref_records`] — produce complete, accurate records for each ref table value (correct abbreviations, canonical names, unit types)
- `2d` `human_gate` (review_object) — user confirms reference records to add or re-use before entity insert
- `2e` `js_transform` — flatten `proposed_ref_records` to row-per-item array for iterator
- `2f` `iterator` — insert each confirmed reference record; skip rows that already exist (`check_exists_by` exact match)

**Single-record insert:**
- `3` `human_gate` (review_object) — user reviews parsed entity before any DB write
- `4` `serv_entity_insert` — insert root row and all child rows in topological FK order with FK threading
- `5` `notify` → `6` `end`

##### Data structures handled by `add_entity`

| Pattern | Entities | Parsed structure after step 2 | Workflow path |
|---|---|---|---|
| **Single NL record** | One root row; optional ref FK resolved to an existing parent | `{ root: { front: "¿Dónde está…?", back: "Where is…?", deck_id: "Spanish Vocabulary" } }` | 1–1e → 2 → 2a–2f (ref FK enrichment: deck name → id; find-or-create Deck row) → 3 (review) → 4 (insert Card) |
| **OCR / receipt-style** | One root row extracted from spatial or scraped content; ref FK to a category or lookup table | `{ root: { date: "2026-06-28", title: "PROTOPIC 1MG/G", amount: 46.74, currency: "EUR", category_id: "Pharmacy" } }` | 1–1e → 2 (receipt rules: spatial layout, European number format, summary-line skip, translation) → 2a–2f (ref FK: category name → SpendingCategories id) → 3 → 4 |
| **Structured bulk — same entity** | Multiple root rows of a single entity type from a paste or CSV; all rows share the same schema | `[ { year: 2026, month: 6, category_id: "Dining Out", planned_amount: 120, type: "discretionary" }, { …, category_id: "Subscriptions", planned_amount: 50 } ]` | 1–1e → 2 (returns flat array) → 2g (Array.isArray branch) → 2h preview → 2i confirm → 2j `serv_insert` with `ref_fk_columns` (resolves category string → id per row) → 2k notify. |
| **Cross-entity bulk** | Two or more entity schemas from one paste (e.g. budget planner: SpendingCategories rows + Budgets rows derived from section headers) | N/A — `parse_entity_input` returns mixed output that cannot be routed to a single EntitySchema | **Use a custom workflow.** `add_entity` is bound to one EntitySchema per run. Cross-entity bulk requires a sequenced workflow: parse full input → insert missing ref rows → resolve FKs → bulk-insert transactional rows. |

##### When to use a custom workflow instead

Use `add_entity` when: user input maps to **one entity schema**, regardless of how many rows or how complex the parsing (NL, receipt text, pasted CSV).

Use a custom workflow when any of the following apply:

- **Multiple entity schemas** must be populated in sequence from one user input (budget planner → categories then budget rows)
- **Business-level validation** beyond field constraints is required (e.g. "month already has a budget — overwrite or append?")
- **Derived inputs** drive the insert (e.g. "carry forward all non-discretionary rows from last month to next month")
- **Post-insert side effects** must fire in the same workflow run (recompute aggregate view, trigger a downstream notification workflow)

---

#### `get_entity`

Steps 1–1d: entity resolution preamble (see `add_entity` above — identical).

- `2` `condition` — `input.id` set → `3` (id lookup); else → `4` (name search)
- `3` `serv_entity_get` — fetch entity by exact id (root + child aggregations) → `step:5`
- `4` `serv_entity_query` — search by LIKE filter on `title` column
- `5` `js_transform` — format matched entity (root columns + child arrays) into Slack mrkdwn; vector columns stripped
- `6` `notify` → `7` `end`

---

#### `list_entity`

Steps 1–1d: entity resolution preamble (see `add_entity` above — identical).

- `2` `serv_entity_query` — list all entities with domain-scoped default filters; root columns only
- `3` `js_transform` — format list results; child arrays and vector columns suppressed
- `4` `notify` → `5` `end`

---

#### `update_entity`

- `1` `serv_query` — load entity schema to resolve root table name
- `2` `human_gate` (confirm) — confirm field changes before write
- `3` `serv_update` — apply update to root table row
- `4` `notify` + `5` `end`

---

#### `delete_entity`

- `1` `serv_query` — load entity schema to resolve root table name
- `2` `human_gate` (confirm) — confirm before delete
- `3` `serv_delete` — delete root row; FK CASCADE removes all child rows
- `4` `notify` + `5` `end`

---

#### `help`

- `1` `serv_query` — load all `PGC_DomainHelp` entries
- `2` `js_transform` — build per-domain button list and lookup map
- `3` `human_gate` (confirm) — Level 1: "What would you like help with?" — buttons per registered domain
- `4` `js_transform` — resolve selected help topic into formatted mrkdwn (commands, syntax, descriptions)
- `5` `human_gate` (confirm) — Level 2: display resolved help content
- `6` `end`

---

#### `ping_core`

Development-only smoke test. Exercises every human gate type supported by the Step Processor and Slack callback layer. No LLM calls.

| Steps | Gate type tested |
|---|---|
| `1`, `2`, `5`, `6r`, `8p` | `choice` — lettered button selection |
| `3`, `4`, `5b` | `text_input` — free-text modal; `5b` also tests `special_buttons` (Skip) |
| `2e`, `3e`, `4e`, `5e`, `6re`, `8y`, `8n` | `confirm` — approve/cancel |
| `7` | `review_object` — structured object display with confirm/cancel |
| `9f` | `followup_prompt` — inline follow-up after a prior gate |
| `8` | `condition` — runtime branch on boolean value |

Each gate collects a result into `local_state` and a subsequent `js_transform` validates it against an expected value. A final `human_gate` (review_object) at step 7 shows a pass/fail summary of all collected results before the condition routing test runs.
