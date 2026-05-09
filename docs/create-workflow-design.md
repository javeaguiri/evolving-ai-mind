# create_workflow Workflow Design

> Extracted from `docs/architecture.md` §6.9. This is the authoritative design reference for the `create_workflow` system workflow.

`create_workflow` is the workflow that makes the brain self-extending. When a user
says `/m create a workflow Spanish vocabulary quiz`, the brain researches the domain,
elicits design preferences, produces a complete design specification, generates a
validated step array, and registers the workflow — without any code changes. Every
new workflow becomes immediately available to the Intent Preprocessor.

---

## Why create_workflow is harder than create_domain

`create_domain` asks an LLM to produce a PostgreSQL schema. The schema is
self-contained — every field in the output is a leaf value or a well-bounded
sub-object. The Ajv `output_schema` can enforce structural correctness fully.

`create_workflow` asks an LLM to produce a step array where every field
cross-references other fields — step keys, template variable names, routing
targets, prompt `intent_category` values, and `output_key` names must all be
internally consistent. A step array can pass Ajv validation and still be broken
because `output_key: "foo"` on step 3 is referenced as `{{bar}}` on step 6.
This is a referential integrity problem, not a structural one. Ajv cannot catch it.

Two mechanisms close this gap: **semantic validation rules** (static analysis on
the step array — see Section 6.5.6 Level 1) and **simulation** (execution-time
data flow validation — see Section 6.5.6 Levels 2 and 3). Both run before the
workflow is registered.

But there is a deeper problem than validation. A single LLM call asked to
simultaneously understand the domain, research best practices, resolve design
tradeoffs, map schema, design dialog boxes, and generate valid step arrays produces
inconsistent results for behaviourally complex workflows. The failure mode is not an
obviously wrong answer but a subtly inconsistent one that passes Ajv and only breaks
at simulation time. The correct solution is to decompose the cognitive work — which
is what the L/R collaboration architecture does.

---

## Decision: L/R collaboration architecture (v4)

`create_workflow` v4 applies the gap taxonomy (Section 6.11) as its primary design
principle. Every gap type is resolved by its correct owner at the correct point in
the pipeline — before the step generator receives its input.

**Three distinct left-brain responsibilities, three distinct calls:**

| Call | Intent | Output | Phase |
|---|---|---|---|
| `analyze_workflow_gaps` | Classify all gaps; determine routing | `gap_analysis` | Phase 1 |
| `design_workflow_process` | Design step sequence and state flow | `process_design`, `state_map` | Phase 3 |
| `design_workflow_dialogs` | Design every human gate dialog | `dialog_designs` | Phase 3 |

**Why three calls, not one:**

Combining gap classification, process design, and dialog design in a single prompt
produces compounding failures. Gap analysis drives routing decisions — if a workflow
is `blocked` or `needs_schema`, no design work should run at all. Separating
classification from design enables early exit through Phase 2 gates before any
expensive design tokens are spent.

Process design and dialog design are orthogonal concerns. Process design maps
the data flow, step sequence, and state keys. Dialog design maps the user-facing
interaction for gate steps. Neither depends on the other's internal details —
they share only `step_label` as the join key. Combining them forces the model to
hold two incompatible output schemas simultaneously, producing schema violations.

Each call produces ~800–1,200 tokens and is independently correctable by the
2-attempt correction loop. A failure in dialog design does not re-run process design.

**The role separation:**

- **Right brain** retrieves world knowledge the system does not have: what are best
  practices for this type of workflow? What design options exist? Which have clear
  winners? Which require user preference to decide?
- **User** resolves genuine preference tradeoffs surfaced by the right brain —
  decisions the system cannot make because there is no objectively better answer,
  only the user's answer.
- **Left brain — gap analysis** classifies all gaps against the taxonomy. Drives
  Phase 2 routing. Does not design steps or dialogs.
- **Left brain — process design** designs the workflow step sequence given known
  preferences, research, and a resolved schema/prompt context. Produces a
  plain-language step-by-step specification and state map.
- **Left brain — dialog design** designs every human gate dialog based on the
  finalised process design. Uses gate_type-specific option shapes.
- **Step generator** translates the three-part specification into a step array.
  All design decisions are already made. It is a translation task, not a design task.

---

## Decision: gap analysis first, gate early, design only on a clear path

The critical ordering change from v3: gap analysis runs in Phase 1 and drives
Phase 2 routing before any Phase 3 design work begins.

In v3, `analyze_and_design_workflow` combined all left-brain work in one step.
Gap routing (steps 12–20) ran after this combined call. This wasted design tokens
on workflows that would immediately be gated by `blocked` or `needs_schema`.

In v4, `analyze_workflow_gaps` (step 11) runs in Phase 1 immediately after
preference collection. Phase 2 gates consume its output. `design_workflow_process`
and `design_workflow_dialogs` only run in Phase 3 — after all gaps are resolved,
all schema issues are decided, and all missing prompts are seeded.

---

## Decision: right brain first, user second, left brain third

The right brain runs before the left brain because the left brain
designs better when it starts with domain knowledge already in hand. The right brain
uses Perplexity sonar (`LLM_CHAT_URL`) because this is a retrieval task: retrieve
current, sourced best practices about the domain. Sonnet generates structured output
from a complete specification — it is not the right model for open-ended domain research.

User preference gates run between right brain and left brain. By the time the left
brain runs gap analysis, all preference questions are answered. By the time the left
brain designs the process, preferences are resolved.

---

## Decision: PGC_SystemContext injection into executeLlmCall

`design_workflow_process`, `design_workflow_dialogs`, and `generate_workflow_steps`
receive step type contracts and routing rules from `PGC_SystemContext` — not from
inline prompt text. `executeLlmCall` in `step-executor.mjs` loads all
`PGC_SystemContext` rows, filters on `inject_always = true` OR
`inject_for.includes(intentCategory)`, and merges matching rows into the
substitution map before `prompt_text` reduction.

Priority: `step.input` values (resolved from `local_state`) take precedence over
context rows. Context fills placeholders not supplied by step input.

When a new step type goes live, `PGC_StepType` is updated and `upsert-system-context.mjs`
re-derives `step_type_contracts`. The prompts do not change. This is the correct
locus of control for evolving the instruction set.

---

## Decision: left brain writes missing prompts inline (gap analysis phase)

When `analyze_workflow_gaps` identifies a required prompt that does not exist
in `PGC_Prompt` (Type 4a gap), it writes the full `prompt_text`, `output_shape`,
and `model` in the `prompts_needed` entry with `exists: false`. A `js_transform`
step filters these entries, then an iterator seeds them into `PGC_Prompt` in Phase 2
before `design_workflow_process` runs. The process designer and step generator can
reference the new prompt `intent_category` immediately.

---

## Decision: schema gap gate cancels cleanly with domain suggestion

When `analyze_workflow_gaps` detects a blocking schema gap (Type 3b), it
includes a `domain_suggestion` field in `schema_changes[]`. The schema gap gate
shows the user what is missing, what they gain, and what they lose without it, with
a concrete command suggestion. Sub-workflow dependency tracking is Backlog.

---

## Decision: process_design carries no dialog references

In v3, `process_design` items had an optional `dialog` field referencing a
`dialog_designs` entry by step_label. This created a structural contradiction: the
schema had to be `anyOf: [empty_object | null]` (because the reference is just a
pointer, not inline data), but the LLM interpreted `dialog` as a place to put full
dialog data, causing `additionalProperties` violations on every run.

In v4, the `dialog` field does not exist on `process_design` items. The join between
a process step and its dialog is made by `step_label` — the step generator receives
`process_design` and `dialog_designs` as separate arrays and associates them by
`step_label` match. This is cleaner and removes the schema contradiction entirely.

---

## Decision: dialog options schema is gate_type-specific

The v3 `dialog_designs` options array required `action` on all options because
`confirm` gates use `action` for routing. `choice` gates use `value` for writing to
`local_state` and `on_select` for routing — `action` is meaningless on them. The LLM
correctly omitted `action` from choice options, causing `required` violations.

In v4, `design_workflow_dialogs` prompt specifies options shape per gate_type:
- `confirm` / `edit_list` / `review_object` gates: `{ label, action, on_select }`
- `choice` gates: `{ label, value, description, on_select }`
- `text_input` gates: no options array required

The output schema mirrors this distinction. The LLM receives an unambiguous
specification and the schema validates the correct shape for each gate type.

---

## Six-phase step structure (v4)

> **Columns:** `Data Used` lists `local_state` keys this step reads (**bold** = actively used).
> `Data Added` shows the cumulative `local_state` at end of step; new keys are marked `←Added`,
> overwritten keys `←Updated`. `js_transform` steps may also read `local_state` keys directly
> inside their expressions without declaring them as inputs — this is by design.

The initial `local_state` before step 1 contains `input.userInput` and `input.domain`,
set by `create-workflow.mjs` at `PGC_WorkflowRun` creation via `matchDomainAlias()`.

| Step | Step Description | Data Used | Data Added |
|------|-----------------|-----------|-----------|
| **PHASE 0 — DATA LOAD** | | | |
| 1 | `serv_query PGC_Schema` — Load domain schema rows for the target domain so the left brain has live column definitions. Filter: `domain = {{input.domain}}` OR `domain IS NULL` for cross-domain workflows. `output_key: domain_schema`. `on_failure: cancel` | **`input.domain`** | `input.userInput`, `input.domain`<br>**`domain_schema`** ←Added |
| 2 | `human_gate choice` — User declares workflow mode before research begins; eliminates entire classes of irrelevant preference questions. Message: "What should this workflow do with your `{{input.domain}}` data?" Options: A=read, B=write, C=enrich, D=analyze; Other (modal: describe workflow) → step:3; Cancel → cancel. `output_key: workflow_mode` | **`input.domain`**, `input.userInput` | `input.userInput`, `input.domain`, `domain_schema`<br>**`workflow_mode`** ←Added |
| **PHASE 1 — L/R COLLABORATION** | | | |
| 3 | `llm_call research_workflow_domain` (Perplexity sonar) — RIGHT BRAIN: retrieve domain best practices; identify preference questions that materially affect workflow structure. Input: `{ workflow_description: "{{input.userInput}}", domain: "{{input.domain}}", domain_schema: "{{domain_schema}}", workflow_mode: "{{workflow_mode}}" }`. Output: `right_brain_research { findings[], preference_questions[], out_of_scope[] }`. `on_failure: next` — research failure is non-blocking | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`workflow_mode`** | `input.userInput`, `input.domain`, `domain_schema`, `workflow_mode`<br>**`right_brain_research`** ←Added |
| 4 | `js_transform` — Build Tier 1 choice gate descriptors from `right_brain_research.preference_questions`. Maps each question to lettered options (A–E), appends N/A and Cancel. `output_key: preference_gates` | **`right_brain_research`** | `…`, `right_brain_research`<br>**`preference_gates`** ←Added |
| 5 | `js_transform` — Format right brain findings and autonomous decisions into a readable summary for the user gate. Reads `right_brain_research.findings` and `.preference_questions`. Output: `research_summary { summary, decision_note, question_note }` | **`right_brain_research`** | `…`, `preference_gates`<br>**`research_summary`** ←Added |
| 6 | `human_gate confirm` — Transparency gate: show user what the right brain researched and which decisions were resolved before preference questions appear. Message: findings summary + decision count + question count. Options: Continue → next; Cancel → cancel | **`input.userInput`**, **`research_summary`** | (no new keys) |
| 7 | `condition` — Skip Tier 1 preference gates if right brain found no preference questions. `expression: {{preference_gates.length}}`. `on_truthy: 8` (iterator). `on_falsy: 9` (skip to design notes gate) | **`preference_gates`** | (no new keys) |
| 8 | `iterator` (sequential) — Tier 1 USER PREFERENCE GATES. One `human_gate choice` per `preference_gates` entry; lettered buttons with descriptions. Each gate writes its selection to `user_preferences`. `on_complete: 9`. Output: `user_preferences [{ id, selected_value }, ...]` | **`preference_gates`** | `…`, `research_summary`<br>**`user_preferences`** ←Added |
| 9 | `human_gate text_input` — Optional free-text gate for design context not surfaced by preference questions. Message: "Anything else I should know about how this workflow should behave?" Options: Submit → next; Skip → next; Cancel → cancel. `output_key: user_design_notes` | (no `local_state` refs in message) | `…`, `user_preferences`<br>**`user_design_notes`** ←Added |
| 10 | `serv_query PGC_StepType` — Load live step type contracts for injection into left brain prompts. Filter: `status = 'live'`. `output_key: step_type_contracts` | (static filter — no `local_state` refs) | `…`, `user_design_notes`<br>**`step_type_contracts`** ←Added |
| 11 | `llm_call analyze_workflow_gaps` (Sonnet) — LEFT BRAIN PASS 1: classify all gaps; determine routing. No design work. Input: `{ userInput, domain, domain_schema, right_brain_research, user_preferences, user_design_notes, step_type_contracts }`. Output: `gap_analysis { confidence, blocked_reason, schema_changes[], prompts_needed[], deferred[] }`. Narrow, focused output — reliable Ajv validation. | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`right_brain_research`**, **`user_preferences`**, **`user_design_notes`**, **`step_type_contracts`** | `…`, `step_type_contracts`<br>**`gap_analysis`** ←Added |
| **PHASE 2 — GAP RESOLUTION** | | | |
| 12 | `js_transform` — Evaluate routing flags from `gap_analysis`. Output: `routing_flags { is_blocked, needs_schema, has_missing_prompts }` | **`gap_analysis`** | `…`, `gap_analysis`<br>**`routing_flags`** ←Added |
| 13 | `condition` — Hard stop if gap analysis detected a missing step type capability. `expression: {{routing_flags.is_blocked}}`. `on_truthy: 14`. `on_falsy: 15` | **`routing_flags.is_blocked`** | (no new keys) |
| 14 | `notify` — "Cannot build this workflow yet: {{gap_analysis.blocked_reason}}" → end. Type 4b hard stop — missing step type capability. | **`gap_analysis.blocked_reason`** | (workflow ends) |
| 15 | `condition` — Check for blocking schema gaps. `expression: {{routing_flags.needs_schema}}`. `on_truthy: 16`. `on_falsy: 18` | **`routing_flags.needs_schema`** | (no new keys) |
| 16 | `js_transform` — Build schema gap gate message from `gap_analysis.schema_changes`. Surfaces table name, recommendation, impact if skipped, and optional domain creation command. `output_key: schema_gap_message` | **`gap_analysis.schema_changes`** | `…`, `routing_flags`<br>**`schema_gap_message`** ←Added |
| 17 | `human_gate confirm` — Schema gap decision: show gap details + domain creation suggestion. Options: "Create the table first" → cancel (with suggestion); "Build without it" → next; Cancel → cancel | **`schema_gap_message`** | (no new keys) |
| 18 | `js_transform` — Filter `gap_analysis.prompts_needed` to entries requiring seeding (`exists=false` with `prompt_text`). Shapes each into a `PGC_Prompt` insert row. `output_key: missing_prompts` | **`gap_analysis.prompts_needed`** | `…`, `schema_gap_message`<br>**`missing_prompts`** ←Added |
| 19 | `condition` — Skip prompt seeding if there are no missing prompts. `expression: {{missing_prompts.length}}`. `on_truthy: 20`. `on_falsy: 21` | **`missing_prompts`** | (no new keys) |
| 20 | `iterator` (sequential) — Seed each missing prompt into `PGC_Prompt` (Type 4a resolution). One `serv_insert` per item. `output_key: seeded_prompts` | **`missing_prompts`** | `…`, `missing_prompts`<br>**`seeded_prompts`** ←Added |
| **PHASE 3 — WORKFLOW DESIGN** | | | |
| 21 | `llm_call design_workflow_process` (Sonnet) — LEFT BRAIN PASS 2: design step sequence and state map. No dialogs — those are designed separately. Input: `{ userInput, domain, domain_schema, gap_analysis, right_brain_research, user_preferences, user_design_notes, step_type_contracts }`. Output: `process_spec { process_design[], state_map }`. `process_design` items exactly: `{ step_label, step_type, description, inputs{}, outputs{} }`. NO `dialog` field. `state_map`: `{ key: { type, written_by, read_by[] } }` | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`gap_analysis`**, **`right_brain_research`**, **`user_preferences`**, **`user_design_notes`**, **`step_type_contracts`** | `…`, `seeded_prompts`<br>**`process_spec`** ←Added<br>(exposes `process_spec.process_design`, `process_spec.state_map`) |
| 22 | `llm_call design_workflow_dialogs` (Sonnet) — LEFT BRAIN PASS 3: design Slack dialogs for every `human_gate` step. Joined to `process_spec` by `step_label`. Input: `{ process_design: "{{process_spec.process_design}}", domain_schema, user_preferences }`. Output: `dialog_spec { dialog_designs[] }`. Each item: `{ step_label, gate_type, message_template, options[], output_key?, context_key? }`. Options shape is gate_type-specific. | **`process_spec.process_design`**, **`domain_schema`**, **`user_preferences`** | `…`, `process_spec`<br>**`dialog_spec`** ←Added<br>(exposes `dialog_spec.dialog_designs`) |
| **PHASE 4 — STEP GENERATION** | | | |
| 23 | `llm_call generate_workflow_steps` (Sonnet) — Translation task only; all design decisions already made. The step generator joins `process_design` + `dialog_designs` by `step_label`. Input: `{ process_design, state_map, dialog_designs, domain_schema, user_feedback (←user_workflow_feedback), static_analysis (←static_analysis_result), previous_draft_steps (←draft_workflow.steps), path_simulation (←simulation_result) }`. Plus PGC_SystemContext injections: `step_type_contracts`, `routing_value_rules`, `create_domain_example`. Output: `draft_workflow { name, description, intent_keywords, steps[] }`. Correction mode: active when `static_analysis.passed === false` (fix L1 issues[]) or `path_simulation.paths_failed > 0` (fix failing path_results[]). | **`process_spec.process_design`**, **`process_spec.state_map`**, **`dialog_spec.dialog_designs`**, **`domain_schema`**; `user_workflow_feedback`, `static_analysis_result`, `draft_workflow.steps`, `simulation_result` (all null on first run; populated on retry loops) | `…`, `dialog_spec`<br>**`draft_workflow`** ←Added<br>(or ←Updated on retry; exposes `draft_workflow.name`, `.description`, `.intent_keywords`, `.steps`) |
| **PHASE 5 — VALIDATION** | | | |
| 24 | `human_gate review_object` — User reviews the proposed step array before mocks and simulation are generated. `context_key: draft_workflow.steps`. `item_label_template: "Step {{step}} ({{type}}): {{description}}"`. Options: "Looks good" → step:25; "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:23; "Regenerate automatically" → step:23; Cancel → cancel. `on_success: step:25`. Placed before mocks/paths so a rejected draft avoids 2 unnecessary LLM calls per rejection cycle. | **`draft_workflow.steps`**, **`draft_workflow.name`** | `…`, `draft_workflow`<br>**`user_workflow_feedback`** ←Added (via modal; only written when feedback option is selected) |
| 25 | `llm_call generate_workflow_mocks` (Sonnet) — Generate representative mock outputs for each step. Input: `{ steps: "{{draft_workflow.steps}}" }`. Output: `mock_outputs { mock_outputs: { [step_key]: value } }`. Only runs after user confirms draft at step 24; regenerates on every correction loop that returns through step 23. | **`draft_workflow.steps`** | `…`, `user_workflow_feedback`<br>**`mock_outputs`** ←Added (←Updated on retry) |
| 26 | `llm_call generate_workflow_paths` (Sonnet) — Generate named simulation paths (happy path, cancel path, failure path). Input: `{ steps: "{{draft_workflow.steps}}", mock_outputs: "{{mock_outputs}}" }`. Output: `simulation_paths { simulation_paths: [{ path_name, decisions[] }] }`. Paths are deduplicated by `path_name` in `runSimulation` before Level 2 execution. | **`draft_workflow.steps`**, **`mock_outputs`** | `…`, `mock_outputs`<br>**`simulation_paths`** ←Added (←Updated on retry) |
| 27 | `simulate` Level 1 — Static analysis: routing integrity, dead step targets, missing template keys, gate structure. Input: `steps_key: draft_workflow.steps`. `on_success: step:30`. `on_failure: step:28` | **`draft_workflow.steps`** | `…`, `simulation_paths`<br>**`static_analysis_result`** ←Added |
| 28 | `js_transform` — Format Level 1 static analysis issues into a readable summary (max 6 issues) for the human gate message. Reads `static_analysis_result.static_analysis.issues[]`. `output_key: simulation_error_summary`. `on_success: step:29` | **`static_analysis_result`** | `…`, `static_analysis_result`<br>**`simulation_error_summary`** ←Added |
| 29 | `human_gate confirm` — Notify user that Level 1 simulation failed; offer to regenerate or cancel. Message: `{{simulation_error_summary}}`. Options: "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:23; "Regenerate automatically" → step:23; Cancel → cancel. `on_success: step:23`. Step 23 receives the full `static_analysis_result` object for correction — not the truncated summary. | **`simulation_error_summary`** | `user_workflow_feedback` ←Updated (via modal) |
| 30 | `simulate` Level 2 + Level 3 — Full path execution with mocks; Level 3 skip-path analysis (advisory). Input: `steps_key: draft_workflow.steps`, `mock_outputs_key: mock_outputs.mock_outputs`, `paths_key: simulation_paths.simulation_paths`. `on_success: step:34`. `on_failure: step:31` | **`draft_workflow.steps`**, **`mock_outputs.mock_outputs`**, **`simulation_paths.simulation_paths`** | `…`, `simulation_paths`<br>**`simulation_result`** ←Added |
| 31 | `js_transform` — Format Level 2 path simulation failures into a readable summary (max 6 failed paths) for the human gate message. Reads `simulation_result.path_results[]` and `simulation_paths` (accessed directly in expression as `local_state.simulation_paths`). `output_key: path_error_summary`. `on_success: step:32` | **`simulation_result`**, `simulation_paths` | `…`, `simulation_result`<br>**`path_error_summary`** ←Added |
| 32 | `js_transform` — Clear stale Level 1 analysis result before the Level 2 error gate so the step generator does not receive stale L1 context on the next iteration. `input_key: simulation_result` (content unused). `output_key: static_analysis_result`. Expression returns `''`. `on_success: step:33`. Runs unconditionally before step 33 regardless of which regenerate option the user picks. | `simulation_result` (input_key; content unused) | `static_analysis_result` ←Updated (reset to `''`) |
| 33 | `human_gate confirm` — Notify user that Level 2 path simulation failed; offer to regenerate or cancel. Message: `{{path_error_summary}}`. Options: "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:23; "Regenerate automatically" → step:23; Cancel → cancel. `on_success: step:23`. Step 23 receives the full `simulation_result` object for correction — not the truncated summary. | **`path_error_summary`** | `user_workflow_feedback` ←Updated (via modal) |
| **PHASE 6 — REGISTRATION** | | | |
| 34 | `human_gate confirm` — Show simulation results; ask user to confirm registration. Message: "Simulation passed `{{simulation_result.paths_passed}}` of `{{simulation_result.paths_run}}` paths. Ready to register `{{draft_workflow.name}}`?" Options: Register → next; Cancel → cancel | **`simulation_result.paths_passed`**, **`simulation_result.paths_run`**, **`draft_workflow.name`** | (no new keys) |
| 35 | `serv_insert PGC_Workflow` — Write the new workflow. Row: `{ name, domain, description, intent_keywords, steps, version: 1, state_strategy: "sequential_with_confirmation" }` | **`draft_workflow.name`**, **`input.domain`**, **`draft_workflow.description`**, **`draft_workflow.intent_keywords`**, **`draft_workflow.steps`** | `…`, `path_error_summary`<br>**`registered_workflow`** ←Added |
| 36 | `serv_insert PGC_IntentMap` — Write the routing row. Row: `{ pattern: draft_workflow.name, intent_category: draft_workflow.name, action_type: "workflow" }`. NOTE: no `workflow_id` column — `PGC_IntentMap` and `PGC_Workflow` are structurally independent. Routing uses `action_type + intent_category` name lookup only. | **`draft_workflow.name`** | `…`, `registered_workflow`<br>**`registered_intent_row`** ←Added |
| 37 | `notify` — "Workflow `{{draft_workflow.name}}` is registered and ready. Deferred enhancements: `{{gap_analysis.deferred.length}}` item(s)." `on_success: end` | **`draft_workflow.name`**, **`draft_workflow.description`**, **`gap_analysis.deferred.length`** | (no new keys) |
| 38 | `end` | — | — |

---

## Domain mode — three execution contexts

`design_workflow_process` and `design_workflow_dialogs` behave differently
depending on what domain context was resolved and what `domain_schema` contains.
Both prompts receive explicit mode guidance:

**Mode A — existing domain data** (`domain` set, `domain_schema` non-empty):
Workflow operates on data already in the system. Only use table and column names
present in `domain_schema`. Never invent tables or columns. Steps read, update,
or transform existing domain data.

**Mode B — new domain population** (`domain` set, `domain_schema` empty):
Either the user wants a workflow that creates or populates domain data (design an
ingestion workflow), or required tables are missing (gap_analysis will have
detected this as Type 3b and the schema gate will have fired). `design_workflow_process`
uses `right_brain_research.findings` to distinguish between these cases.

**Mode C — standalone** (`domain` null, `domain_schema` empty):
Workflow has no domain dependency. May use PGC system tables or operate purely
on user input and LLM processing with no DB reads/writes required.

`create-workflow.mjs` resolves the domain from `PGC_DomainHelp` via
`matchDomainAlias()` before creating the `PGC_WorkflowRun` — so by the time
`input.domain` reaches step 1, the best available alias match has already been applied.

---

## Gap taxonomy applied — per gap type (v4)

| Gap type | Who owns it | When resolved | How resolved in v4 |
|---|---|---|---|
| Type 1 — Preference | User | After right brain, before left brain | Tier 1 preference gate iterator (steps 7–9) |
| Type 2 — Knowledge | Right brain | Before left brain | `research_workflow_domain` sonar call (step 3) |
| Type 3a — Schema non-blocking | User | After gap analysis | Schema gap gate (steps 15–17), user chooses to proceed |
| Type 3b — Schema blocking | User | After gap analysis | Schema gap gate cancels cleanly with domain creation suggestion |
| Type 4a — Missing prompt | Left brain | After gap analysis, before process design | Inline prompt authoring in `gap_analysis.prompts_needed`, auto-seeded (steps 18–20) |
| Type 4b — Missing step type | Developer (hard stop) | After gap analysis | `confidence: "blocked"` → notify → end (steps 13–14) |
| Type 5 — Ambiguity | User | Pre-step (not yet implemented) | Future: clarification gate before step 1 when intent is underspecified |

---

## Preference gate iterator contract

Tier 1 preference gates use the `human_gate choice` type with an iterator
driving sequential gates — one gate per `preference_questions` entry from
`right_brain_research`. The user cannot get more than one gate at a time. The
iterator collects all selections into `user_preferences` as an array of
`{ id, selected_value }` objects before any left-brain call runs.

Each gate shows: the question as a typography heading; a description list showing
`*A* — label: description` for each option; and lettered action buttons (`A`, `B`, `C`, `Cancel`).
This mirrors HTML radio button semantics — the button submits the `value` field,
not the display label. The selected `value` is written to `user_preferences` via `output_key`.

The right brain is instructed to surface preference questions **only when the answer
materially changes the step structure** of the generated workflow. If best practice
clearly recommends one approach, the right brain resolves it in `findings` and does
not surface a preference question. The number of preference gates in practice should
be 0–3 for most workflows.

---

## generate_workflow_steps — translation contract

`generate_workflow_steps` (step 23) is a translation prompt, not a design prompt.
It receives a complete, gap-free, three-part specification and produces a step array:

- `process_design[]` — the ordered step sequence with types and data flow
- `state_map` — the complete data dictionary (key → type, written_by, read_by)
- `dialog_designs[]` — one entry per human_gate step, linked by `step_label`

The step generator joins `process_design` and `dialog_designs` by `step_label` to
construct each `human_gate` step's complete definition. This join is the only
"design" decision the step generator makes — and it is mechanical, not creative.

The step generator must not invent steps, modify the process sequence, or add
state keys not in `state_map`. It translates — it does not design.

---

## Gate-bounded correction loops

Steps 24–27 and 24–30 form gate-bounded correction loops. Every backward jump — from
step 28→29→step:23, or step 31→32→33→step:23 — is safe because the correction path
always passes through a `human_gate` (29 or 33) before re-running the step generator.
This satisfies Guard 3's cycle-safety rule.

If simulation repeatedly fails, the user cancels at step 29 or step 33. There is no
automated retry limit on human-gate-bounded loops.

**Review gate placement (step 24).** The review gate runs immediately after step 23
(generate steps), before mocks and paths are generated. This saves 2 LLM calls per
rejection cycle: if the user regenerates at step 24, the new draft is shown before
paying for mocks and paths. Mocks and paths only run after the user confirms the draft
looks structurally correct.

**Mocks and paths regenerate on every confirmed iteration.** When any correction path
returns to step 23 (generate steps), the user reviews the draft at step 24 before
steps 25 (mocks) and 26 (paths) run. This ensures `mock_outputs` and
`simulation_paths` are always current against the confirmed `draft_workflow.steps`.

**L2 clearing step (step 32).** Step 32 clears `static_analysis_result` before
step 33 (the L2 human gate) runs. This ensures step 23 does not receive a stale
L1 failure result on the next iteration. Step 32 always runs — both the "Regenerate
with feedback" and "Regenerate automatically" options in step 33 flow through it
unconditionally.

**Step 23 correction inputs.** Step 23 receives `static_analysis_result` (full L1
result object) and `simulation_result` (full L2 result object) directly — not the
truncated formatted summaries used in the human gate messages. This gives the LLM
the complete issue detail needed for accurate corrections.

---

## Prompt dependencies (v4)

| Step | Prompt `intent_category` | Model | Output key |
|---|---|---|---|
| 3  | `research_workflow_domain` | `perplexity/sonar` | `right_brain_research` |
| 11 | `analyze_workflow_gaps` | `anthropic/claude-sonnet-4-5` | `gap_analysis` |
| 21 | `design_workflow_process` | `anthropic/claude-sonnet-4-5` | `process_spec` |
| 22 | `design_workflow_dialogs` | `anthropic/claude-sonnet-4-5` | `dialog_spec` |
| 23 | `generate_workflow_steps` | `anthropic/claude-sonnet-4-5` | `draft_workflow` |
| 25 | `generate_workflow_mocks` | `anthropic/claude-sonnet-4-5` | `mock_outputs` |
| 26 | `generate_workflow_paths` | `anthropic/claude-sonnet-4-5` | `simulation_paths` |

PGC_SystemContext rows injected via `executeLlmCall`:
- `step_type_contracts` — injected into steps 11, 21, 22, 23
- `routing_value_rules` — injected into steps 21, 22, 23
- `create_domain_example` — injected into step 23

---

## Implementation notes

- `create-workflow.mjs` resolves the domain from `PGC_DomainHelp` via `matchDomainAlias()`
  before creating `PGC_WorkflowRun`. The resolved domain flows into `input.domain` so that
  step 1 (`serv_query PGC_Schema`) returns real schema rows rather than an empty array.
- `execute_top` root frame initialises `current_step: '1'` — step numbering starts at
  `'1'` (serv_query) not at a prior classification step.
- Steps 5 and 6 (research summary format + confirm gate) are live in the workflow seed and
  present in every run. They are implementation steps within Phase 1 that give the user
  visibility into what the right brain found before preference gates appear.
- The `example` field in step 23's input is populated from `PGC_SystemContext`
  injection, not from `local_state`. The step definition passes `"example":
  "injected_from_pgc_system_context"` as a placeholder; `executeLlmCall` replaces
  it with the live `create_domain_example` content before the LLM call.
- Step 22 (`design_workflow_dialogs`) receives the full `process_spec.process_design`
  array. The prompt instructs it to design dialogs only for `human_gate` step_type entries.
  If no gate steps exist the output is an empty `dialog_designs: []` array. Conditional
  skipping when there are no gate steps is a future optimisation.
- `generate_workflow_steps` (step 23) input variables: `process_design`, `state_map`,
  `dialog_designs`, `domain_schema`, `user_feedback`, `static_analysis`, `path_simulation`,
  `previous_draft_steps`, plus `step_type_contracts`, `routing_value_rules`, and `example`
  injected from `PGC_SystemContext`. The step generator joins `process_design` and
  `dialog_designs` by `step_label`. Correction mode activates on `static_analysis.passed === false`
  or `path_simulation.paths_failed > 0` — the full result objects are passed, not truncated summaries.
- The `generate_workflow_steps` prompt is at v12. The `output_schema` is unchanged —
  `{ name, description, intent_keywords, steps[] }`.
- Step 24 (`human_gate review_object`) — placed before mocks/paths (steps 25–26) to avoid
  generating 2 LLM outputs for a draft the user will reject. "Regenerate with feedback" uses a modal
  with `output_key: user_workflow_feedback`. "Regenerate automatically" routes directly to step 23.
  Both options skip mocks/paths until the user confirms.
- Step 32 (`js_transform`) — clears `static_analysis_result` unconditionally before step 33 (L2
  failure gate). Both regenerate options in step 33 route to step 23 directly; no separate clearing
  branch needed.
- **`user_design_notes`** (step 9) is passed to step 11 (`analyze_workflow_gaps`) and
  step 21 (`design_workflow_process`) so the left brain can incorporate user intent that
  was not captured by preference questions. Both prompts accept it as an optional variable.
- **Structural fix (v20):** Steps 24 (`generate_workflow_mocks`) and 25
  (`generate_workflow_paths`) were moved from after Level 1 pass to immediately after
  step 23 (`generate_workflow_steps`). Previously they ran only once, making `mock_outputs`
  and `simulation_paths` stale on every correction loop retry. Now they regenerate on every
  iteration. Additionally, step 30 (`simulate` Level 2) `on_success` was corrected from
  `"next"` (which erroneously routed to the error formatter at step 31) to `"step:34"`
  (the registration gate).
- **Structural fix (v22+):** Review gate moved before mocks/paths (step 24 ← old step 26);
  mocks (step 25 ← old step 24) and paths (step 26 ← old step 25) only generate after user
  confirms draft. Clearing step moved before L2 gate (step 32 ← old step 33); L2 gate is
  now step 33 (← old step 32). Step 23 now receives `static_analysis_result` and
  `simulation_result` directly instead of truncated formatted summaries.
