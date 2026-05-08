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

In v3, `analyze_and_design_workflow` combined all left-brain work in one step 7.
Gap routing (steps 8–11c) ran after this combined call. This wasted design tokens
on workflows that would immediately be gated by `blocked` or `needs_schema`.

In v4, `analyze_workflow_gaps` (step 7) runs in Phase 1 immediately after
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
> overwritten keys `←Updated`. `*` on a key in Data Used denotes the field name is referenced
> inside a `js_transform` expression via `local_state.*` rather than via the step's declared inputs.

The initial `local_state` before step 1 contains `input.userInput` and `input.domain`,
set by `create-workflow.mjs` at `PGC_WorkflowRun` creation via `matchDomainAlias()`.

| Step | Step Description | Data Used | Data Added |
|------|-----------------|-----------|-----------|
| **PHASE 0 — DATA LOAD** | | | |
| 1 | `serv_query PGC_Schema` — Load domain schema rows for the target domain so the left brain has live column definitions. Filter: `domain = {{input.domain}}` OR `domain IS NULL` for cross-domain workflows. `output_key: domain_schema`. `on_failure: cancel` | **`input.domain`** | `input.userInput`, `input.domain`<br>**`domain_schema`** ←Added |
| 1a | `human_gate choice` — User declares workflow mode before research begins; eliminates entire classes of irrelevant preference questions. Message: "What should this workflow do with your `{{input.domain}}` data?" Options: A=read, B=write, C=enrich, D=analyze; Other (modal: describe workflow) → next; Cancel → cancel. `output_key: workflow_mode` | **`input.domain`**, `input.userInput` | `input.userInput`, `input.domain`, `domain_schema`<br>**`workflow_mode`** ←Added |
| **PHASE 1 — L/R COLLABORATION** | | | |
| 2 | `llm_call research_workflow_domain` (Perplexity sonar) — RIGHT BRAIN: retrieve domain best practices; identify preference questions that materially affect workflow structure. Input: `{ workflow_description: "{{input.userInput}}", domain: "{{input.domain}}", domain_schema: "{{domain_schema}}", workflow_mode: "{{workflow_mode}}" }`. Output: `right_brain_research { findings[], preference_questions[], out_of_scope[] }`. `on_failure: next` — research failure is non-blocking | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`workflow_mode`** | `input.userInput`, `input.domain`, `domain_schema`, `workflow_mode`<br>**`right_brain_research`** ←Added |
| 3 | `js_transform` — Build Tier 1 choice gate descriptors from `right_brain_research.preference_questions`. Maps each question to lettered options (A–E), appends N/A and Cancel. `output_key: preference_gates` | **`right_brain_research`** | `…`, `right_brain_research`<br>**`preference_gates`** ←Added |
| 3a | `js_transform` — Format right brain findings and autonomous decisions into a readable summary for the user gate. Reads `right_brain_research.findings` and `.preference_questions`. Output: `research_summary { summary, decision_note, question_note }` | **`right_brain_research`** | `…`, `preference_gates`<br>**`research_summary`** ←Added |
| 3b | `human_gate confirm` — Transparency gate: show user what the right brain researched and which decisions were resolved before preference questions appear. Message: findings summary + decision count + question count. Options: Continue → next; Cancel → cancel | **`input.userInput`**, **`research_summary`** | (no new keys) |
| 4 | `condition` — Skip Tier 1 preference gates if right brain found no preference questions. `expression: {{preference_gates.length}}`. `on_truthy: step:5` (iterator). `on_falsy: step:5a` (skip to design notes gate) | **`preference_gates`** | (no new keys) |
| 5 | `iterator` (sequential) — Tier 1 USER PREFERENCE GATES. One `human_gate choice` per `preference_gates` entry; lettered buttons with descriptions. Each gate writes its selection to `user_preferences`. `on_complete: step:5a`. Output: `user_preferences [{ id, selected_value }, ...]` | **`preference_gates`** | `…`, `research_summary`<br>**`user_preferences`** ←Added |
| 5a | `human_gate text_input` — Optional free-text gate for design context not surfaced by preference questions. Message: "Anything else I should know about how this workflow should behave?" Options: Submit → next; Skip → next; Cancel → cancel. `output_key: user_design_notes` ⚠️ Added to `local_state` but not referenced in any downstream step's declared inputs — see Implementation Notes | (no `local_state` refs in message) | `…`, `user_preferences`<br>**`user_design_notes`** ←Added ⚠️ unreferenced downstream |
| 6 | `serv_query PGC_StepType` — Load live step type contracts for injection into left brain prompts. Filter: `status = 'live'`. `output_key: step_type_contracts` | (static filter — no `local_state` refs) | `…`, `user_design_notes`<br>**`step_type_contracts`** ←Added |
| 7 | `llm_call analyze_workflow_gaps` (Sonnet) — LEFT BRAIN PASS 1: classify all gaps; determine routing. No design work. Input: `{ userInput, domain, domain_schema, right_brain_research, user_preferences, step_type_contracts }`. Output: `gap_analysis { confidence, blocked_reason, schema_changes[], prompts_needed[], deferred[] }`. Narrow, focused output — reliable Ajv validation. | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`right_brain_research`**, **`user_preferences`**, **`step_type_contracts`** | `…`, `step_type_contracts`<br>**`gap_analysis`** ←Added |
| **PHASE 2 — GAP RESOLUTION** | | | |
| 8 | `js_transform` — Evaluate routing flags from `gap_analysis`. Output: `routing_flags { is_blocked, needs_schema, has_missing_prompts }` | **`gap_analysis`** | `…`, `gap_analysis`<br>**`routing_flags`** ←Added |
| 9 | `condition` — Hard stop if gap analysis detected a missing step type capability. `expression: {{routing_flags.is_blocked}}`. `on_truthy: step:9a`. `on_falsy: step:10` | **`routing_flags.is_blocked`** | (no new keys) |
| 9a | `notify` — "Cannot build this workflow yet: {{gap_analysis.blocked_reason}}" → end. Type 4b hard stop — missing step type capability. | **`gap_analysis.blocked_reason`** | (workflow ends) |
| 10 | `condition` — Check for blocking schema gaps. `expression: {{routing_flags.needs_schema}}`. `on_truthy: step:10a`. `on_falsy: step:11a` | **`routing_flags.needs_schema`** | (no new keys) |
| 10a | `js_transform` — Build schema gap gate message from `gap_analysis.schema_changes`. Surfaces table name, recommendation, impact if skipped, and optional domain creation command. `output_key: schema_gap_message` | **`gap_analysis.schema_changes`** | `…`, `routing_flags`<br>**`schema_gap_message`** ←Added |
| 10b | `human_gate confirm` — Schema gap decision: show gap details + domain creation suggestion. Options: "Create the table first" → cancel (with suggestion); "Build without it" → next; Cancel → cancel | **`schema_gap_message`** | (no new keys) |
| 11a | `js_transform` — Filter `gap_analysis.prompts_needed` to entries requiring seeding (`exists=false` with `prompt_text`). Shapes each into a `PGC_Prompt` insert row. `output_key: missing_prompts` | **`gap_analysis.prompts_needed`** | `…`, `schema_gap_message`<br>**`missing_prompts`** ←Added |
| 11b | `condition` — Skip prompt seeding if there are no missing prompts. `expression: {{missing_prompts.length}}`. `on_truthy: step:11c`. `on_falsy: step:12` | **`missing_prompts`** | (no new keys) |
| 11c | `iterator` (sequential) — Seed each missing prompt into `PGC_Prompt` (Type 4a resolution). One `serv_insert` per item. `output_key: seeded_prompts` | **`missing_prompts`** | `…`, `missing_prompts`<br>**`seeded_prompts`** ←Added |
| **PHASE 3 — WORKFLOW DESIGN** | | | |
| 12 | `llm_call design_workflow_process` (Sonnet) — LEFT BRAIN PASS 2: design step sequence and state map. No dialogs — those are designed separately. Input: `{ userInput, domain, domain_schema, gap_analysis, right_brain_research, user_preferences, step_type_contracts }`. Output: `process_spec { process_design[], state_map }`. `process_design` items exactly: `{ step_label, step_type, description, inputs{}, outputs{} }`. NO `dialog` field. `state_map`: `{ key: { type, written_by, read_by[] } }` | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`gap_analysis`**, **`right_brain_research`**, **`user_preferences`**, **`step_type_contracts`** | `…`, `seeded_prompts`<br>**`process_spec`** ←Added<br>(exposes `process_spec.process_design`, `process_spec.state_map`) |
| 13 | `llm_call design_workflow_dialogs` (Sonnet) — LEFT BRAIN PASS 3: design Slack dialogs for every `human_gate` step. Joined to `process_spec` by `step_label`. Input: `{ process_design: "{{process_spec.process_design}}", domain_schema, user_preferences }`. Output: `dialog_spec { dialog_designs[] }`. Each item: `{ step_label, gate_type, message_template, options[], output_key?, context_key? }`. Options shape is gate_type-specific. | **`process_spec.process_design`**, **`domain_schema`**, **`user_preferences`** | `…`, `process_spec`<br>**`dialog_spec`** ←Added<br>(exposes `dialog_spec.dialog_designs`) |
| **PHASE 4 — STEP GENERATION** | | | |
| 14 | `llm_call generate_workflow_steps` (Sonnet) — Translation task only; all design decisions already made. The step generator joins `process_design` + `dialog_designs` by `step_label`. Input: `{ process_design, state_map, dialog_designs, domain_schema, user_feedback (←user_workflow_feedback), simulation_errors (←simulation_error_summary), previous_draft_steps (←draft_workflow.steps), path_errors (←path_error_summary) }`. Plus PGC_SystemContext injections: `step_type_contracts`, `routing_value_rules`, `create_domain_example`. Output: `draft_workflow { name, description, intent_keywords, steps[] }` | **`process_spec.process_design`**, **`process_spec.state_map`**, **`dialog_spec.dialog_designs`**, **`domain_schema`**; `user_workflow_feedback`, `simulation_error_summary`, `draft_workflow.steps`, `path_error_summary` (all null on first run; populated on retry loops) | `…`, `dialog_spec`<br>**`draft_workflow`** ←Added<br>(or ←Updated on retry; exposes `draft_workflow.name`, `.description`, `.intent_keywords`, `.steps`) |
| **PHASE 5 — VALIDATION** | | | |
| 15 | `human_gate review_object` — User reviews the proposed step array before simulation. `context_key: draft_workflow.steps`. `item_label_template: "Step {{step}} ({{type}}): {{description}}"`. Options: "Looks good" → step:16; "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:14; "Regenerate automatically" → step:14; Cancel → cancel. `on_success: step:16` | **`draft_workflow.steps`**, **`draft_workflow.name`** | `…`, `draft_workflow`<br>**`user_workflow_feedback`** ←Added (via modal; only written when feedback option is selected) |
| 16 | `simulate` Level 1 — Static analysis: routing integrity, dead step targets, missing template keys, gate structure. Input: `steps_key: draft_workflow.steps`. `on_success: step:17`. `on_failure: step:16a` | **`draft_workflow.steps`** | `…`, `user_workflow_feedback`<br>**`static_analysis_result`** ←Added |
| 16a | `js_transform` — Format Level 1 static analysis issues into a readable summary (max 6 issues). Reads `static_analysis_result.static_analysis.issues[]`. `output_key: simulation_error_summary`. `on_success: step:16b` | **`static_analysis_result`** | `…`, `static_analysis_result`<br>**`simulation_error_summary`** ←Added |
| 16b | `human_gate confirm` — Notify user that Level 1 simulation failed; offer to regenerate or cancel. Message: `{{simulation_error_summary}}`. Options: "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:14; "Regenerate automatically" → step:14; Cancel → cancel. `on_success: step:14` | **`simulation_error_summary`** | `user_workflow_feedback` ←Updated (via modal) |
| 17 | `llm_call generate_workflow_mocks` (Sonnet) — Generate representative mock outputs for each step. Input: `{ steps: "{{draft_workflow.steps}}" }`. Output: `mock_outputs { mock_outputs: { [step_key]: value } }` | **`draft_workflow.steps`** | `…`, `simulation_error_summary`<br>**`mock_outputs`** ←Added |
| 18 | `llm_call generate_workflow_paths` (Sonnet) — Generate named simulation paths (happy path, cancel path, failure path). Input: `{ steps: "{{draft_workflow.steps}}", mock_outputs: "{{mock_outputs}}" }`. Output: `simulation_paths { simulation_paths: [{ path_name, decisions[] }] }` | **`draft_workflow.steps`**, **`mock_outputs`** | `…`, `mock_outputs`<br>**`simulation_paths`** ←Added |
| 19 | `simulate` Level 2 + Level 3 — Full path execution with mocks; Level 3 skip-path analysis (advisory). Input: `steps_key: draft_workflow.steps`, `mock_outputs_key: mock_outputs.mock_outputs`, `paths_key: simulation_paths.simulation_paths`. `on_success: next`. `on_failure: step:19a` | **`draft_workflow.steps`**, **`mock_outputs.mock_outputs`**, **`simulation_paths.simulation_paths`** | `…`, `simulation_paths`<br>**`simulation_result`** ←Added |
| 19a | `js_transform` — Format Level 2 path simulation failures into a readable summary (max 6 failed paths). Reads `simulation_result.path_results[]` and **`simulation_paths`**\* (accessed directly in expression as `local_state.simulation_paths` — not via declared `input_key`). `output_key: path_error_summary`. `on_success: step:19b` | **`simulation_result`**, **`simulation_paths`**\* | `…`, `simulation_result`<br>**`path_error_summary`** ←Added |
| 19b | `human_gate confirm` — Notify user that Level 2 path simulation failed; offer to regenerate or cancel. Message: `{{path_error_summary}}`. Options: "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:14; "Regenerate automatically" → step:19c; Cancel → cancel. `on_success: step:14` | **`path_error_summary`** | `user_workflow_feedback` ←Updated (via modal) |
| 19c | `js_transform` — Clear stale Level 1 error summary before Level 2 automatic regeneration so step 14 does not pass stale context to the LLM. `input_key: simulation_result` (content unused). `output_key: simulation_error_summary`. Expression returns `''`. `on_success: step:14` | `simulation_result` (input_key; content unused) | `simulation_error_summary` ←Updated (reset to `''`) |
| **PHASE 6 — REGISTRATION** | | | |
| 20 | `human_gate confirm` — Show simulation results; ask user to confirm registration. Message: "Simulation passed `{{simulation_result.paths_passed}}` of `{{simulation_result.paths_run}}` paths. Ready to register `{{draft_workflow.name}}`?" Options: Register → next; Cancel → cancel | **`simulation_result.paths_passed`**, **`simulation_result.paths_run`**, **`draft_workflow.name`** | (no new keys) |
| 21 | `serv_insert PGC_Workflow` — Write the new workflow. Row: `{ name, domain, description, intent_keywords, steps, version: 1, state_strategy: "sequential_with_confirmation" }` | **`draft_workflow.name`**, **`input.domain`**, **`draft_workflow.description`**, **`draft_workflow.intent_keywords`**, **`draft_workflow.steps`** | `…`, `path_error_summary`<br>**`registered_workflow`** ←Added |
| 22 | `serv_insert PGC_IntentMap` — Write the routing row. Row: `{ pattern: draft_workflow.name, intent_category: draft_workflow.name, action_type: "workflow" }`. NOTE: no `workflow_id` column — `PGC_IntentMap` and `PGC_Workflow` are structurally independent. Routing uses `action_type + intent_category` name lookup only. | **`draft_workflow.name`** | `…`, `registered_workflow`<br>**`registered_intent_row`** ←Added |
| 23 | `notify` — "Workflow `{{draft_workflow.name}}` is registered and ready. Deferred enhancements: `{{gap_analysis.deferred.length}}` item(s)." `on_success: end` | **`draft_workflow.name`**, **`draft_workflow.description`**, **`gap_analysis.deferred.length`** | (no new keys) |
| 24 | `end` | — | — |

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
| Type 1 — Preference | User | After right brain, before left brain | Tier 1 preference gate iterator (steps 3–5) |
| Type 2 — Knowledge | Right brain | Before left brain | `research_workflow_domain` sonar call (step 2) |
| Type 3a — Schema non-blocking | User | After gap analysis | Schema gap gate (steps 10–10b), user chooses to proceed |
| Type 3b — Schema blocking | User | After gap analysis | Schema gap gate cancels cleanly with domain creation suggestion |
| Type 4a — Missing prompt | Left brain | After gap analysis, before process design | Inline prompt authoring in `gap_analysis.prompts_needed`, auto-seeded (steps 11a–11c) |
| Type 4b — Missing step type | Developer (hard stop) | After gap analysis | `confidence: "blocked"` → notify → end (steps 9–9a) |
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

`generate_workflow_steps` (step 14) is a translation prompt, not a design prompt.
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

Steps 15–16 and 15–19 form gate-bounded correction loops. The backward jump from
step 16a → 16b → step 14, or step 19a → 19b → step 14, is safe because the
correction path always passes through a `human_gate` (16b or 19b) before re-running
the step generator. This satisfies Guard 3's cycle-safety rule.

If simulation repeatedly fails, the user cancels at 16b or 19b. There is no automated
retry limit on human-gate-bounded loops.

If the user requests changes at step 15, or if simulation fails at 16 or 19, the
backward reference to step 14 re-runs the step generator only — not the design phases.
The three-part specification (`process_design`, `state_map`, `dialog_designs`) persists
in `local_state` and is reused. The user's change request is captured via modal on
the `review_object` or failure gate and written to `user_workflow_feedback` before
step 14 runs.

---

## Prompt dependencies (v4)

| Step | Prompt `intent_category` | Model | Output key |
|---|---|---|---|
| 2  | `research_workflow_domain` | `perplexity/sonar` | `right_brain_research` |
| 7  | `analyze_workflow_gaps` | `anthropic/claude-sonnet-4-5` | `gap_analysis` |
| 12 | `design_workflow_process` | `anthropic/claude-sonnet-4-5` | `process_spec` |
| 13 | `design_workflow_dialogs` | `anthropic/claude-sonnet-4-5` | `dialog_spec` |
| 14 | `generate_workflow_steps` | `anthropic/claude-sonnet-4-5` | `draft_workflow` |
| 17 | `generate_workflow_mocks` | `anthropic/claude-sonnet-4-5` | `mock_outputs` |
| 18 | `generate_workflow_paths` | `anthropic/claude-sonnet-4-5` | `simulation_paths` |

PGC_SystemContext rows injected via `executeLlmCall`:
- `step_type_contracts` — injected into steps 7, 12, 13, 14
- `routing_value_rules` — injected into steps 12, 13, 14
- `create_domain_example` — injected into step 14

---

## Implementation notes

- `create-workflow.mjs` resolves the domain from `PGC_DomainHelp` via `matchDomainAlias()`
  before creating `PGC_WorkflowRun`. The resolved domain flows into `input.domain` so that
  step 1 (`serv_query PGC_Schema`) returns real schema rows rather than an empty array.
- `execute_top` root frame initialises `current_step: '1'` — step numbering in v4
  starts at `'1'` (serv_query) not at a prior classification step.
- Steps 3a and 3b (research summary format + confirm gate) are live in the workflow seed and
  present in every run. They are implementation steps within Phase 1 that give the user
  visibility into what the right brain found before preference gates appear.
- The `example` field in step 14's input is populated from `PGC_SystemContext`
  injection, not from `local_state`. The step definition passes `"example":
  "injected_from_pgc_system_context"` as a placeholder; `executeLlmCall` replaces
  it with the live `create_domain_example` content before the LLM call.
- Step 13 (`design_workflow_dialogs`) receives the full `process_spec.process_design`
  array. The prompt instructs it to design dialogs only for `human_gate` step_type entries.
  If no gate steps exist the output is an empty `dialog_designs: []` array. Conditional
  skipping when there are no gate steps is a future optimisation.
- `generate_workflow_steps` (step 14) input variables: `process_design`, `state_map`,
  `dialog_designs`, `domain_schema`, plus `step_type_contracts`, `routing_value_rules`,
  and `example` injected from `PGC_SystemContext`. The old `design_spec` monolith input
  is removed. The step generator joins `process_design` and `dialog_designs` by `step_label`.
- The `generate_workflow_steps` prompt is at v7 for the v4 input contract. The `output_schema`
  is unchanged — `{ name, description, intent_keywords, steps[] }`.
- Step 15 (`human_gate review_object`) — "Regenerate with feedback" uses a modal with
  `output_key: user_workflow_feedback` that writes directly to `local_state` and routes
  to step 14. There is no intermediate text_input gate. "Regenerate automatically" also
  routes to step 14 without capturing feedback.
- **`user_design_notes`** (step 5a) is written to `local_state` but is not referenced in
  any downstream step's `input` block. It should be added to the `input` of step 7
  (`analyze_workflow_gaps`) and/or step 12 (`design_workflow_process`) to make it useful.
  This is a known gap — tracked in `docs/backlog.md`.
- **Step 19a `simulation_paths` access**: the js_transform expression accesses
  `local_state.simulation_paths` directly (not via `input_key`) to resolve path definitions
  when formatting failure reasons. This is an in-expression `local_state.*` reference,
  marked with `*` in the table. Consider adding `simulation_paths` as a declared input
  to make the dependency explicit at the workflow level.
