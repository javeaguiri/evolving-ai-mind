# create_workflow Workflow Design
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture docs. Main overview: `docs/architecture.md` §6.9. See also: `docs/arch-step-types.md` (step type reference), `docs/arch-step-processor.md` (execution engine), `docs/arch-workflow-patterns.md` §6.9, `docs/arch-prompt-rules.md` (prompt rule placement guide).

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
the step array — Level 1) and **simulation** (execution-time data flow
validation — Levels 2a/2b/2c). Both run before the workflow is registered. See
`docs/arch-simulation-engine.md` for the full validation-level breakdown.

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
| 1 | `serv_query PGC_Schema` — Load domain schema rows for the target domain so the left brain has live column definitions. Filter: `domain = {{input.domain}}` OR `domain IS NULL` for cross-domain workflows. `output_key: domain_schema`. `on_else: cancel` | **`input.domain`** | `input.userInput`, `input.domain`<br>**`domain_schema`** ←Added |
| 2 | `human_gate choice` — User declares workflow mode before research begins; eliminates entire classes of irrelevant preference questions. Message: "What should this workflow do with your `{{input.domain}}` data?" Options: A=read, B=write, C=enrich, D=analyze; Other (modal: describe workflow) → step:3; Cancel → cancel. `output_key: workflow_mode` | **`input.domain`**, `input.userInput` | `input.userInput`, `input.domain`, `domain_schema`<br>**`workflow_mode`** ←Added |
| **PHASE 1 — L/R COLLABORATION** | | | |
| 3 | `llm_call research_workflow_domain` (Perplexity sonar) — RIGHT BRAIN: retrieve domain best practices; identify preference questions that materially affect workflow structure. Input: `{ workflow_description: "{{input.userInput}}", domain: "{{input.domain}}", domain_schema: "{{domain_schema}}", workflow_mode: "{{workflow_mode}}" }`. Output: `right_brain_research { findings[], preference_questions[], out_of_scope[] }`. `on_else: next` — research failure is non-blocking | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`workflow_mode`** | `input.userInput`, `input.domain`, `domain_schema`, `workflow_mode`<br>**`right_brain_research`** ←Added |
| 4 | `js_transform` — Build Tier 1 choice gate descriptors from `right_brain_research.preference_questions`. Maps each question to lettered options (A–E), appends N/A and Cancel. `output_key: preference_gates` | **`right_brain_research`** | `…`, `right_brain_research`<br>**`preference_gates`** ←Added |
| 5 | `js_transform` — Format right brain findings and autonomous decisions into a readable summary for the user gate. Reads `right_brain_research.findings` and `.preference_questions`. Output: `research_summary { summary, decision_note, question_note }` | **`right_brain_research`** | `…`, `preference_gates`<br>**`research_summary`** ←Added |
| 6 | `human_gate confirm` — Transparency gate: show user what the right brain researched and which decisions were resolved before preference questions appear. Message: findings summary + decision count + question count. Options: Continue → next; Cancel → cancel | **`input.userInput`**, **`research_summary`** | (no new keys) |
| 7 | `condition` — Skip Tier 1 preference gates if right brain found no preference questions. `expression: {{preference_gates.length}}`. `on_success: 8` (iterator). `on_else: 9` (skip to design notes gate) | **`preference_gates`** | (no new keys) |
| 8 | `iterator` (sequential) — Tier 1 USER PREFERENCE GATES. One `human_gate choice` per `preference_gates` entry; lettered buttons with descriptions. Each gate writes its selection to `user_preferences`. `on_complete: 9`. Output: `user_preferences [{ id, selected_value }, ...]` | **`preference_gates`** | `…`, `research_summary`<br>**`user_preferences`** ←Added |
| 9 | `human_gate text_input` — Optional free-text gate for design context not surfaced by preference questions. Message: "Anything else I should know about how this workflow should behave?" Options: Submit → next; Skip → next; Cancel → cancel. `output_key: user_design_notes` | (no `local_state` refs in message) | `…`, `user_preferences`<br>**`user_design_notes`** ←Added |
| 10 | `serv_query PGC_StepType` — Load live step type contracts for injection into left brain prompts. Filter: `status = 'live'`. `output_key: step_type_contracts` | (static filter — no `local_state` refs) | `…`, `user_design_notes`<br>**`step_type_contracts`** ←Added |
| 11 | `llm_call analyze_workflow_gaps` (Sonnet) — LEFT BRAIN PASS 1: classify all gaps; determine routing. No design work. Input: `{ userInput, domain, domain_schema, right_brain_research, user_preferences, user_design_notes, step_type_contracts }`. Output: `gap_analysis { confidence, blocked_reason, schema_changes[], prompts_needed[], deferred[] }`. Narrow, focused output — reliable Ajv validation. | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`right_brain_research`**, **`user_preferences`**, **`user_design_notes`**, **`step_type_contracts`** | `…`, `step_type_contracts`<br>**`gap_analysis`** ←Added |
| **PHASE 2 — GAP RESOLUTION** | | | |
| 12 | `js_transform` — Evaluate routing flags from `gap_analysis`. Output: `routing_flags { is_blocked, needs_schema, has_missing_prompts }` | **`gap_analysis`** | `…`, `gap_analysis`<br>**`routing_flags`** ←Added |
| 13 | `condition` — Hard stop if gap analysis detected a missing step type capability. `expression: {{routing_flags.is_blocked}}`. `on_success: 14`. `on_else: 15` | **`routing_flags.is_blocked`** | (no new keys) |
| 14 | `notify` — "Cannot build this workflow yet: {{gap_analysis.blocked_reason}}" → end. Type 4b hard stop — missing step type capability. | **`gap_analysis.blocked_reason`** | (workflow ends) |
| 15 | `condition` — Check for blocking schema gaps. `expression: {{routing_flags.needs_schema}}`. `on_success: 16`. `on_else: 18` | **`routing_flags.needs_schema`** | (no new keys) |
| 16 | `js_transform` — Build schema gap gate message from `gap_analysis.schema_changes`. Surfaces table name, recommendation, impact if skipped, and optional domain creation command. `output_key: schema_gap_message` | **`gap_analysis.schema_changes`** | `…`, `routing_flags`<br>**`schema_gap_message`** ←Added |
| 17 | `human_gate confirm` — Schema gap decision: show gap details + domain creation suggestion. Options: "Create the table first" → cancel (with suggestion); "Build without it" → next; Cancel → cancel | **`schema_gap_message`** | (no new keys) |
| 18 | `js_transform` — Filter `gap_analysis.prompts_needed` to entries requiring seeding (`exists=false` with `prompt_text`). Shapes each into a `PGC_Prompt` insert row. `output_key: missing_prompts` | **`gap_analysis.prompts_needed`** | `…`, `schema_gap_message`<br>**`missing_prompts`** ←Added |
| 19 | `condition` — Skip prompt seeding if there are no missing prompts. `expression: {{missing_prompts.length}}`. `on_success: 20`. `on_else: 21` | **`missing_prompts`** | (no new keys) |
| 20 | `iterator` (sequential) — Seed each missing prompt into `PGC_Prompt` (Type 4a resolution). One `serv_insert` per item. `output_key: seeded_prompts` | **`missing_prompts`** | `…`, `missing_prompts`<br>**`seeded_prompts`** ←Added |
| **PHASE 3 — WORKFLOW DESIGN** | | | |
| 21 | `llm_call design_workflow_process` (Sonnet) — LEFT BRAIN PASS 2: design step sequence and state map. No dialogs — those are designed separately. Input: `{ userInput, domain, domain_schema, gap_analysis, right_brain_research, user_preferences, user_design_notes, step_type_contracts }`. Output: `process_spec { process_design[], state_map }`. `process_design` items exactly: `{ step_label, step_type, description, inputs{}, outputs{}, routing? }`. `routing` carries explicit step_label targets for every routing field — never `"next"`. `state_map`: `{ key: { type, written_by, read_by[] } }` | **`input.userInput`**, **`input.domain`**, **`domain_schema`**, **`gap_analysis`**, **`right_brain_research`**, **`user_preferences`**, **`user_design_notes`**, **`step_type_contracts`** | `…`, `seeded_prompts`<br>**`process_spec`** ←Added<br>(exposes `process_spec.process_design`, `process_spec.state_map`) |
| **SKELETON VALIDATION (Sprint 4 — Track S)** | | | |
| 21a | `js_transform` — Build `routing_skeleton`: a minimal step array (one entry per `process_design` item) containing only `step_label` as the step key, `step_type`, `description`, and routing fields from `item.routing`. Appends a terminal `end` step. Any item without explicit routing defaults to `on_success: 'next'`. Output: `routing_skeleton []`. The skeleton uses step_labels as step keys — the same tokens the LLM used in routing targets. | **`process_spec.process_design`** | `…`, `process_spec`<br>**`routing_skeleton`** ←Added |
| 21b | `simulate` Level 1 BFS on `routing_skeleton` — validates that all routing targets name a real step_label (or "end"/"cancel"), no dead ends, no isolated steps. Runs before dialog design and step generation so a broken routing graph is caught before any content is generated. `on_success: step:22`. `on_else: step:21c` | **`routing_skeleton`** | `…`, `routing_skeleton`<br>**`skeleton_validation`** ←Added |
| 21c | `human_gate confirm` — skeleton L1 failed gate. Message: "Process design has routing issues — {{skeleton_validation.static_analysis.issues.length}} found. Fix the process design before content is generated." Options: "Redesign process" → step:21 (re-runs `design_workflow_process`); "Cancel" → cancel. On re-run, `process_spec` is overwritten by the new LLM output and steps 21a/21b re-validate the fresh skeleton. | **`skeleton_validation.static_analysis.issues.length`** | (no new keys; loops back to step:21) |
| 22 | `llm_call design_workflow_dialogs` (Sonnet) — LEFT BRAIN PASS 3: design Slack dialogs for every `human_gate` step. Joined to `process_spec` by `step_label`. Input: `{ process_design: "{{process_spec.process_design}}", domain_schema, user_preferences }`. Output: `dialog_spec { dialog_designs[] }`. Each item: `{ step_label, gate_type, message_template, options[], output_key?, context_key? }`. Options shape is gate_type-specific. | **`process_spec.process_design`**, **`domain_schema`**, **`user_preferences`** | `…`, `process_spec`<br>**`dialog_spec`** ←Added<br>(exposes `dialog_spec.dialog_designs`) |
| **PHASE 4 — STEP GENERATION** | | | |
| 23 | `llm_call generate_workflow_steps` (Sonnet) — Translation task only; all design decisions already made. The step generator joins `process_design` + `dialog_designs` by `step_label`. Input: `{ process_design, state_map, dialog_designs, domain_schema, user_feedback (←user_workflow_feedback), static_analysis (←static_analysis_result), previous_draft_steps (←draft_workflow.steps), simulation_error_summary (←simulation_error_summary) }`. Plus PGC_SystemContext injections: `step_type_contracts`, `routing_value_rules`, `flat_loop_example`. Output: `draft_workflow { name, description, intent_keywords, steps[] }`. Correction mode is **Phase 1 only**: apply static analysis fixes (content locked after fix, `level1_applied: true`). Phase 2 routing repair is handled exclusively by `fix_workflow_routing` (step 33a) — `generate_workflow_steps` does not receive `path_simulation` or `path_error_summary`. Correction state (`level1_applied`, `level1_issue`, `level2_applied`, `level2_issue`) is embedded on each step in `previous_draft_steps` by js_transform steps; the LLM reads these fields but must not include them in its output. | **`process_spec.process_design`**, **`process_spec.state_map`**, **`dialog_spec.dialog_designs`**, **`domain_schema`**; `user_workflow_feedback`, `static_analysis_result`, `draft_workflow.steps`, `simulation_error_summary` (all null on first run; populated on retry loops) | `…`, `dialog_spec`<br>**`draft_workflow`** ←Added<br>(or ←Updated on retry; exposes `draft_workflow.name`, `.description`, `.intent_keywords`, `.steps`) |
| **PHASE 4.5 — PROMPT REGISTRATION** | | | |
| 23a | `js_transform` — Count draft steps that carry a `prompt_draft` field (domain-specific llm_call steps emitted by `generate_workflow_steps`). `output_key: domain_prompt_count` (integer). `on_success: next`. | **`draft_workflow.steps`** | **`domain_prompt_count`** ←Added |
| 23b | `condition` — Skip Phase 4.5 entirely if `domain_prompt_count` is 0 (no domain-specific llm_call steps). `on_success: 23c`. `on_else: 24`. | **`domain_prompt_count`** | (no new keys) |
| 23c | `serv_query PGC_Prompt` — Load all existing prompt entries (columns: `intent_category`, `domain`) so the classifier can detect reuse candidates without hardcoding the list. `output_key: existing_prompt_categories`. `on_success: next`. `on_else: next`. | — | **`existing_prompt_categories`** ←Added |
| 23d | `llm_call design_workflow_prompts` (smart) — For each draft llm_call step with a `prompt_draft` field, classify as **reuse** (category already in `existing_prompt_categories`), **create** (new prompt needed), or **convert** (purely deterministic → rewrite as `js_transform`). Returns `capability_decisions.decisions[]` with `{ step_key, action, prompt_category, prompt_text?, prompt_model?, output_schema?, js_expression? }`. `on_success: next`. `on_else: 23h` (skip to apply with empty decisions). | **`draft_workflow.steps`**, **`existing_prompt_categories`**, `input.domain` | **`capability_decisions`** ←Added |
| 23e | `js_transform` — Filter `capability_decisions.decisions` to action=`create` entries only. `output_key: create_decisions`. `on_success: next`. `on_else: 23h`. | **`capability_decisions`** | **`create_decisions`** ←Added |
| 23f | `condition` — Skip iterator if `create_decisions.length` is 0. `on_success: 23g`. `on_else: 23h`. | **`create_decisions`** | (no new keys) |
| 23g | `iterator` over `create_decisions` — `serv_insert PGC_Prompt` for each create decision: `{ intent_category: item.prompt_category, prompt_text: item.prompt_text, model: item.prompt_model, domain: input.domain, output_schema: item.output_schema, version: 1 }`. Model alias stored verbatim — `llm-harness.mjs` resolves at call time via `llm_model_aliases`. `output_key: inserted_prompts`. `on_complete: 23h`. `on_else: 23h`. | **`create_decisions`** | **`inserted_prompts`** ←Added |
| 23h | `js_transform` — Apply all decisions to `draft_workflow.steps`: strip `prompt_draft / prompt_category / prompt_model / output_schema` from reuse/create steps; rewrite convert steps as `js_transform` using `d.js_expression`. `input_key: draft_workflow`. `output_key: draft_workflow`. `on_success: next`. | **`draft_workflow`**, **`capability_decisions`** | **`draft_workflow`** ←Updated (draft fields stripped; convert steps rewritten) |
| **PHASE 5 — VALIDATION** | | | |
| 24 | `human_gate review_object` — User reviews the proposed step array before simulation. `context_key: draft_workflow.steps`. `item_label_template: "Step {{step}} ({{type}}): {{description}}"`. Options: "Looks good" → step:25; "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:23; "Regenerate automatically" → step:23; Cancel → cancel. `on_success: step:25`. Placed before mocks/paths so a rejected draft avoids unnecessary LLM calls. | **`draft_workflow.steps`**, **`draft_workflow.name`** | `…`, `draft_workflow`<br>**`user_workflow_feedback`** ←Added (via modal; only written when feedback option is selected) |
| 25 | `simulate` Level 1 — Static analysis: routing integrity, dead step targets, missing template keys, gate structure. Input: `steps_key: draft_workflow.steps`. `on_success: step:25a`. `on_else: step:26`. Mocks and paths are not generated until Level 1 passes — saves 2 LLM calls per L1 failure cycle. | **`draft_workflow.steps`** | `…`, `user_workflow_feedback`<br>**`static_analysis_result`** ←Added |
| 25a | `js_transform` — **L1 success path.** Map over `draft_workflow.steps`; embed `level1_applied: true, level1_issue: ''` on every step. `output_key: draft_workflow`. `on_success: step:28` | **`draft_workflow.steps`** | **`draft_workflow`** ←Updated (steps carry correction state) |
| 26 | `js_transform` — Format Level 1 static analysis issues into a readable summary (max 6 issues) for the human gate message. Reads `static_analysis_result.static_analysis.issues[]`. `output_key: simulation_error_summary`. `on_success: step:26a` | **`static_analysis_result`** | `…`, `static_analysis_result`<br>**`simulation_error_summary`** ←Added |
| 26a | `js_transform` — **L1 failure path.** Map over `draft_workflow.steps`; embed `level1_applied: false, level1_issue: <detail>` for steps in `static_analysis.issues[]`; `level1_applied: true` for all others. `output_key: draft_workflow`. `on_success: step:27` | **`static_analysis_result`**, **`draft_workflow.steps`** | **`draft_workflow`** ←Updated (steps carry correction state) |
| 27 | `human_gate confirm` — Notify user that Level 1 simulation failed; offer to regenerate or cancel. Message: `{{simulation_error_summary}}`. Options: "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:23; "Regenerate automatically" → step:23; Cancel → cancel. `on_success: step:23`. Step 23 receives `static_analysis_result` and `previous_draft_steps` (with correction state embedded) for phased correction. | **`simulation_error_summary`** | `user_workflow_feedback` ←Updated (via modal) |
| 28 | `llm_call generate_workflow_mocks` (Sonnet) — Generate representative mock outputs for each step. Input: `{ steps: "{{draft_workflow.steps}}" }`. Output: `mock_outputs { mock_outputs: { [step_key]: value } }`. Only runs after Level 1 passes; regenerates on every correction loop iteration that clears Level 1. | **`draft_workflow.steps`** | `…`, `static_analysis_result`<br>**`mock_outputs`** ←Added (←Updated on retry) |
| 29 | `llm_call generate_workflow_paths` (Sonnet) — Generate named simulation paths (happy path, cancel path, failure path). Input: `{ steps: "{{draft_workflow.steps}}", mock_outputs: "{{mock_outputs}}" }`. Output: `simulation_paths { simulation_paths: [{ path_name, decisions[] }] }`. Paths are deduplicated by `path_name` in `runSimulation` before Level 2 execution. | **`draft_workflow.steps`**, **`mock_outputs`** | `…`, `mock_outputs`<br>**`simulation_paths`** ←Added (←Updated on retry) |
| 30 | `simulate` Level 2 + Level 3 — Full path execution with mocks; Level 3 skip-path analysis (advisory). Input: `steps_key: draft_workflow.steps`, `mock_outputs_key: mock_outputs.mock_outputs`, `paths_key: simulation_paths.simulation_paths`. `on_success: step:30a`. `on_else: step:31` | **`draft_workflow.steps`**, **`mock_outputs.mock_outputs`**, **`simulation_paths.simulation_paths`** | `…`, `simulation_paths`<br>**`simulation_result`** ←Added |
| 30a | `js_transform` — **L2 success path.** Map over `draft_workflow.steps`; embed `level2_applied: true, level2_issue: ''` on every step. `output_key: draft_workflow`. `on_success: step:34` | **`draft_workflow.steps`** | **`draft_workflow`** ←Updated (steps carry correction state) |
| 31 | `js_transform` — Format Level 2 path simulation failures into a readable summary (max 6 failed paths) for the human gate message. Reads `simulation_result.path_results[]` and `simulation_paths` (accessed directly in expression as `local_state.simulation_paths`). `output_key: path_error_summary`. `on_success: step:31a` | **`simulation_result`**, `simulation_paths` | `…`, `simulation_result`<br>**`path_error_summary`** ←Added |
| 31a | `js_transform` — **L2 failure path.** Map over `draft_workflow.steps`; embed `level2_applied: false, level2_issue: <reason>` for steps identified by `path_results[].failure_step`; `level2_applied: true` for all others. `output_key: draft_workflow`. `on_success: step:32` | **`simulation_result`**, **`draft_workflow.steps`** | **`draft_workflow`** ←Updated (steps carry correction state) |
| 32 | `js_transform` — Clear stale Level 1 analysis result before the Level 2 error gate so the step generator does not receive stale L1 context on the next iteration. `input_key: simulation_result` (content unused). `output_key: static_analysis_result`. Expression returns `''`. `on_success: step:33`. Runs unconditionally before step 33 regardless of which regenerate option the user picks. | `simulation_result` (input_key; content unused) | `static_analysis_result` ←Updated (reset to `''`) |
| 33 | `human_gate confirm` — Notify user that Level 2 path simulation failed; offer to repair or cancel. Message: `{{path_error_summary}}`. Options: "Regenerate with feedback" (modal, `output_key: user_workflow_feedback`) → step:33a; "Regenerate automatically" → step:33a; Cancel → cancel. `on_success: step:33a`. Routes to step 33a (`fix_workflow_routing`) — not to step 23. Routing-only repair is isolated from the full generation prompt. | **`path_error_summary`** | `user_workflow_feedback` ←Updated (via modal) |
| 33a | `llm_call fix_workflow_routing` (Sonnet) — Routing-only repair for Level 2 failures. Receives `draft_workflow.steps` plus workflow metadata (`name`, `description`, `intent_keywords` from `draft_workflow`) and simulation context (`path_error_summary`, `simulation_result`, `user_workflow_feedback`). Modifies ONLY routing fields (`on_success`, `on_else`, `on_success`, `on_else`, `on_cancel`, `on_select` inside options[]). Must not modify `message_template`, `expression`, `query`, `mutation`, `output_key`, or any other content field. Output: `draft_workflow { name, description, intent_keywords, steps[] }` — same schema as step 23. `on_success: step:24` — routes to the review gate so the full L1+L2 pipeline re-runs on the repaired draft. `on_else: cancel`. | **`draft_workflow.steps`**, **`draft_workflow.name`**, **`draft_workflow.description`**, **`draft_workflow.intent_keywords`**, **`path_error_summary`**, **`simulation_result`**; `user_workflow_feedback` | **`draft_workflow`** ←Updated (routing fields repaired; correction state fields stripped from output) |
| **PHASE 6 — REGISTRATION** | | | |
| 34 | `human_gate confirm` — Show simulation results; ask user to confirm registration. Message: "Simulation passed `{{simulation_result.paths_passed}}` of `{{simulation_result.paths_run}}` paths. Ready to register `{{draft_workflow.name}}`?" Options: Register → next; Cancel → cancel | **`simulation_result.paths_passed`**, **`simulation_result.paths_run`**, **`draft_workflow.name`** | (no new keys) |
| 34a | `js_transform` — Strip correction state fields (`level1_applied`, `level1_issue`, `level2_applied`, `level2_issue`) from `draft_workflow.steps` before registration. `input_key: draft_workflow`. `output_key: draft_workflow`. `on_success: next` | **`draft_workflow`** | **`draft_workflow`** ←Updated (steps cleaned) |
| 35 | `serv_insert PGC_Workflow` — Write the new workflow. Row: `{ name, domain, description, intent_keywords, steps, version: 1, state_strategy: "sequential_with_confirmation" }`. Routes to `step:35a` (phrasing gate) on success. | **`draft_workflow.name`**, **`input.domain`**, **`draft_workflow.description`**, **`draft_workflow.intent_keywords`**, **`draft_workflow.steps`** | `…`, `path_error_summary`<br>**`registered_workflow`** ←Added |
| **PHRASING GATE (Sprint 4 — Track I)** | | | |
| 35a | `human_gate text_input` — Ask the user for the phrases they will use to invoke this workflow from Slack. Message: "How will you invoke `{{draft_workflow.name}}` from Slack? Enter one or more phrases separated by commas." Options: Submit → next; Skip → next (fallback to workflow name); Cancel → cancel. `output_key: invocation_phrases`. The value is null when the user skips. | **`draft_workflow.name`** | `…`, `registered_workflow`<br>**`invocation_phrases`** ←Added |
| 35b | `js_transform` — Build `intent_pattern`: split `invocation_phrases` on commas, trim and lowercase each phrase, filter empty strings, append `draft_workflow.name` (lowercased) if not already included, join with `\|`. Fallback: if `invocation_phrases` is null/empty, result is just `draft_workflow.name`. The pattern is a `\|`-joined regex matched by Pass 1a in `classify-intent.mjs`. Output: `intent_pattern` (string). | **`invocation_phrases`**, **`draft_workflow.name`** | `…`, `invocation_phrases`<br>**`intent_pattern`** ←Added |
| 36 | `serv_insert PGC_IntentMap` — Write the routing row using the user-supplied pattern. Row: `{ pattern: intent_pattern, intent_category: draft_workflow.name, action_type: "workflow" }`. `pattern` is the `\|`-joined regex from step 35b — always includes `draft_workflow.name` as a fallback alternation so the exact name always matches Pass 1a. NOTE: no `workflow_id` column — `PGC_IntentMap` and `PGC_Workflow` are structurally independent. | **`intent_pattern`**, **`draft_workflow.name`** | `…`, `intent_pattern`<br>**`registered_intent_row`** ←Added |
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
It receives a complete, gap-free, four-part specification and produces a step array:

- `process_design[]` — the ordered step sequence with types and data flow
- `state_map` — the complete data dictionary (key → type, written_by, read_by)
- `dialog_designs[]` — one entry per human_gate step, linked by `step_label`
- `routing_skeleton[]` — pre-validated routing topology (step_label keys, routing fields)

The step generator joins `process_design` and `dialog_designs` by `step_label` to
construct each `human_gate` step's complete definition.

**Locked routing (Sprint 4 — Track S):** When `routing_skeleton` is non-empty, routing
is locked — the generator must not invent routing. For each step, it finds the matching
skeleton entry by `step_label`, copies its routing fields, and translates step_label
targets to numeric step keys using its internally-assigned numbering. Condition steps
translate targets to bare numbers (e.g. `"5"`); all other routing fields translate to
`step:N` format (e.g. `"step:5"`). `"end"` and `"cancel"` pass through unchanged.

The routing skeleton was L1-validated by step 21b. Because the generator only fills
content against an already-valid routing graph, routing bugs caused by simultaneous
design + content generation are eliminated at source.

The step generator must not invent steps, modify the process sequence, or add
state keys not in `state_map`. It translates — it does not design.

---

## Gate-bounded correction loops

Steps 24–27 and 24–33 form gate-bounded correction loops. Every backward jump — from
step 26a→27→step:23 (L1), or step 31a→32→33→step:33a→step:24 (L2) — is safe because the
correction path always passes through a `human_gate` (27 or 33) before re-running
the step generator. This satisfies Guard 3's cycle-safety rule.

If simulation repeatedly fails, the user cancels at step 27 (L1) or step 33 (L2). The L2 repair path (step 33a) does not loop back — if `fix_workflow_routing` fails (`on_else: cancel`), the run terminates without a human gate.
There is no automated retry limit on human-gate-bounded loops.

**Review gate placement (step 24).** The review gate runs immediately after step 23
(generate steps), before mocks and paths are generated. This saves 2 LLM calls per
rejection cycle: if the user regenerates at step 24, the new draft is shown before
paying for mocks and paths. Mocks and paths only run after the user confirms the draft
looks structurally correct.

**Mocks and paths regenerate on every confirmed iteration.** When any correction path
returns to step 23 (generate steps), the user reviews the draft at step 24 before
step 28 (mocks) and step 29 (paths) run. This ensures `mock_outputs` and
`simulation_paths` are always current against the confirmed `draft_workflow.steps`.

**L2 clearing step (step 32).** Step 32 clears `static_analysis_result` before
step 33 (the L2 human gate) runs. This ensures step 23 does not receive a stale
L1 failure result on the next iteration. Step 32 always runs — both the "Regenerate
with feedback" and "Regenerate automatically" options in step 33 flow through it
unconditionally.

**Step 23 correction inputs.** Step 23 receives `static_analysis_result` (full L1
result object) and `simulation_error_summary` directly. It also receives
`previous_draft_steps` with correction state embedded on each step. Step 23 does NOT
receive `simulation_result` or `path_error_summary` — those are L2 inputs routed
exclusively to step 33a (`fix_workflow_routing`).

**Step 33a correction inputs.** Step 33a receives `draft_workflow.steps` as
`previous_draft_steps`, plus `draft_workflow.name/description/intent_keywords`
(echoed unchanged in output), `path_error_summary`, `simulation_result` (full L2
result), and `user_workflow_feedback`. Modifies only routing fields; outputs the full
`draft_workflow` object. Routes to step:24 (review gate) on success so the full
L1+L2 pipeline re-runs on the repaired draft.

**Phased correction — split across two prompts.** Phase 1 (static analysis fixes)
is handled by `generate_workflow_steps` (step 23): only flagged steps are modified;
all other steps are copied verbatim from `previous_draft_steps`. Phase 2 (routing-only
fixes) is handled by `fix_workflow_routing` (step 33a): only routing fields
(`on_success`, `on_else`, `on_select`, `on_success`, `on_else`, `on_cancel`) may
change — `message_template`, `expression`, `query`, `mutation`, and all other content
fields are prohibited. Steps with `level1_applied: true` are permanently locked.

The split prevents conflicting correction contexts from overloading a single prompt.
`generate_workflow_steps` never receives `path_simulation` or `path_error_summary`.
`fix_workflow_routing` never receives `static_analysis` or performs content corrections.

**`previous_draft_steps` source.** Step 23's seed JSON passes
`"previous_draft_steps": "{{draft_workflow.steps}}"`. `draft_workflow` is step 23's
own `output_key`, so on the first run `draft_workflow` does not yet exist in
`local_state` and `previous_draft_steps` resolves to empty — correction mode does not
trigger. After step 23 completes, `draft_workflow.steps` is persisted in `local_state`.
On any loop-back to step 23 (from gates 24, 27, or 33 routing to `step:23`),
`draft_workflow.steps` is already present and `previous_draft_steps` is populated —
correction mode triggers automatically with no extra bookkeeping.

**Correction state on steps (steps 25a / 26a / 30a / 31a).** Four `js_transform`
steps embed correction state directly onto each step object in `draft_workflow.steps`
after every simulate run — pass or fail:
- `level1_applied: true` when a step is clean at L1; `false` (with `level1_issue`) when flagged.
- `level2_applied: true` when a step is clean at L2; `false` (with `level2_issue`) when a path fails at that step.

The correction state travels with `draft_workflow.steps`, so when step 23 receives
`previous_draft_steps` on the next iteration, each step already carries its own
correction verdict — no separate structure to cross-reference. The LLM reads these
fields but must not include them in its output; step 34a strips them before
registration so `PGC_Workflow.steps` is clean.

---

## Prompt dependencies (v4)

| Step | Prompt `intent_category` | Model | Output key |
|---|---|---|---|
| 3  | `research_workflow_domain` | `perplexity/sonar` | `right_brain_research` |
| 11 | `analyze_workflow_gaps` | `anthropic/claude-sonnet-4-5` | `gap_analysis` |
| 21 | `design_workflow_process` | `anthropic/claude-sonnet-4-5` | `process_spec` |
| 22 | `design_workflow_dialogs` | `anthropic/claude-sonnet-4-5` | `dialog_spec` |
| 23 | `generate_workflow_steps` | `anthropic/claude-sonnet-4-5` | `draft_workflow` |
| 23d | `design_workflow_prompts` | `smart` alias (resolved at runtime) | `capability_decisions` |
| 28 | `generate_workflow_mocks` | `anthropic/claude-sonnet-4-5` | `mock_outputs` |
| 29 | `generate_workflow_paths` | `anthropic/claude-sonnet-4-5` | `simulation_paths` |
| 33a | `fix_workflow_routing` | `anthropic/claude-sonnet-4-5` | `draft_workflow` |

PGC_SystemContext rows injected via `executeLlmCall`:
- `step_type_contracts` — injected into steps 11, 21, 22, 23
- `routing_value_rules` — injected into steps 21, 22, 23
- `flat_loop_example` — injected into step 23

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
  `dialog_designs`, `domain_schema`, `user_feedback`, `static_analysis`,
  `previous_draft_steps` (resolved from `draft_workflow.steps` — step 23's own `output_key`;
  empty on first run, populated on retry loops with correction state embedded on each step),
  `simulation_error_summary`, plus `step_type_contracts`, `routing_value_rules`, and
  `flat_loop_example` injected from `PGC_SystemContext`. Does NOT receive `path_simulation`
  or `path_error_summary` — those are L2 inputs routed to step 33a only. The step generator
  joins `process_design` and `dialog_designs` by `step_label`. Correction is Phase 1 only:
  fixes content and locks steps via `level1_applied: true`. Correction state fields
  (`level1_applied`, `level1_issue`, `level2_applied`, `level2_issue`) are read-only —
  the LLM must not include them in output; step 34a strips them before registration.
- `fix_workflow_routing` (step 33a) input variables: `previous_draft_steps`
  (`draft_workflow.steps`), `workflow_name` (`draft_workflow.name`), `workflow_description`
  (`draft_workflow.description`), `workflow_keywords` (`draft_workflow.intent_keywords`),
  `path_error_summary`, `path_simulation` (`simulation_result`), `user_feedback`
  (`user_workflow_feedback`). Outputs `draft_workflow` (same schema as step 23). Modifies
  only routing fields; routes to step:24 on success
- The `generate_workflow_steps` prompt is at v11 (DB). The `fix_workflow_routing` prompt is at v1 (DB id 57). The `output_schema` is `{ name,
  description, intent_keywords, steps[] }` — correction state fields are not in the
  output schema; step 34a strips them from `draft_workflow.steps` before registration.
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
