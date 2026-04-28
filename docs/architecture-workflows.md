# evolving-mind-ai — Architecture: Workflows
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2
Status: Active development — Session 30 complete
Last updated: 2026-04-28 (session 30 — /ping unified command; ping_core integration test workflow;
modal button architecture: button click holds gate suspended, only modal submit resumes;
create_domain step 3 "Add a table" modal now resumes step 3 directly via handleViewSubmission;
step 3a text_input renders inline Slack input block — modal descriptor on edit_list button retained
for overlay UX but routing now handled correctly without intermediate resume_gate on click)

**Architecture document set:**
- `architecture-core.md` — system overview, stack, Lambda tiers, SQS queues, data architecture, SERV layer, dev scripts
- `architecture-step-processor.md` — Step Processor execution engine: step types, stack, local_state, human gates, simulation, right-brain validation, safety
- `architecture-workflows.md` — this file: Workflow definitions: create_domain, create_workflow, L/R brain collaboration, gap taxonomy, self-repair loop
- `architecture-reference.md` — pgvector, security, tech debt register, backlog, cost of ownership, refactoring history

---

### 6.8 create_domain Workflow — full annotated example

`create_domain` is the primary demonstrator workflow. It uses every major Step
Processor capability: `llm_call`, `js_transform`, multi-step `human_gate`
sequences with branching, `iterator`, `serv_insert`, and `notify`.

Reading this workflow against sections 6.5.1–6.5.4 is the intended way to understand
how the Step Processor executes a real program.

#### Data flow summary

```
run.input.userInput = "stock portfolios"

Step 1  llm_call → proposed_scaffold = { domain, tables: [4 table objects with columns/FKs/constraints] }
Step 2  js_transform → proposed_scaffold.tables[*].columnSummary added
Step 3  human_gate edit_list → user reviews tables, may remove child tables or jump to add-table branch
        ├── confirm   → step:3d
        ├── add_table → step:3a (text_input)
        └── cancel    → cancelled

Step 3a human_gate text_input → new_table_description written to local_state via inline Slack input block
        Note: "Add a table" button on step 3 carries a modal descriptor for overlay UX.
        Modal submission resumes step 3 (edit_list) directly — handleViewSubmission routes
        via original button action (add_table → on_select: step:3a). Step 3a is the
        intermediate text_input step that captures the description.
Step 3b llm_call → new_table designed, stored at local_state["new_table"]
Step 3c js_transform → merge new_table into proposed_scaffold.tables, loop back to step:3
Step 3d human_gate review_object → user reviews all table column details before DDL
        ├── confirm → next (step 4)
        └── cancel  → cancelled

Step 4  human_gate confirm → final DDL confirmation
        ├── confirm → next (step 5)
        └── cancel  → cancelled

Step 5  iterator over proposed_scaffold.tables
          item_step: serv_schema createTable(item)
          → created_tables = [{ tableName, status: 'created' }, ...]

Step 6  llm_call → generated = { domainHelp, workflows: [4 CRUD workflows], intentMapRows: [4 rows], entitySchemas: [1+ entity definitions] }
Step 7  human_gate review_object → user reviews domainHelp (aliases, description, commands)
        ├── confirm → next (step 8)
        └── cancel  → cancelled

Step 8   serv_insert PGC_DomainHelp ← generated.domainHelp
Step 9   iterator over generated.workflows
           item_step: serv_insert PGC_Workflow(item)
Step 10  iterator over generated.intentMapRows
           item_step: serv_insert PGC_IntentMap(item)
Step 10b iterator over generated.entitySchemas
           item_step: serv_insert PGC_EntitySchema(item)
Step 11  notify → "Domain {{proposed_scaffold.domain}} created."
Step 12  end
```

#### Why the add-table branch loops back

Step 3c uses `on_success: "step:3"` — a backward jump. This is the first
intentional backward reference in the system. After the new table is designed and
merged into `proposed_scaffold.tables`, the workflow returns to step 3 so the user
can review the updated list (now including their new table) and either confirm,
add another, or cancel. The loop continues until the user confirms at step 3.

The Step Processor handles this correctly because step keys are resolved by string
equality. `"step:3"` resolves to step `"3"` — there is no confusion with `"3a"`,
`"3b"`, `"3c"`, or `"3d"`. Each branching step has a distinct `frame_id` x
`step_key` pair in `PGC_WorkflowRunStep`, so idempotency works correctly
across loop iterations.

#### Prompt dependencies

| Step | Prompt `intent_category` | Output stored at |
|---|---|---|
| 1 | `create_domain` v3 | `proposed_scaffold` |
| 3b | `design_table` v1 | `new_table` |
| 6 | `generate_crud_workflows` v5 | `generated` |

All three prompts have `output_schema` defined. The correction loop runs on all
three if the LLM output is malformed.

---

#### Generated CRUD workflows — one subsection per verb

The `generate_crud_workflows` v5 prompt produces four workflow definitions written
to `PGC_Workflow` at step 9. All four have `action_type: workflow` in
`PGC_IntentMap`. Below is the canonical step structure for each.

##### list_\<domain\>

Zero-LLM formatted list. Runs `serv_query` on the root table and posts a count
and preview to Slack.

```
Step 1  serv_query PGD_<root_table>  (no filters — all rows)
          output_key: results
Step 2  notify → "Found {{results.length}} <domain> record(s)."
Step 3  end
```

##### add_\<domain\>

LLM-parse-first multi-table insert. Accepts natural language input of any length.
Uses `buildEntitySchema` to load live column definitions from `PGC_Schema` for
root and all child tables — single source of truth, immune to schema drift.

```
Step 1  serv_entity_schema  (input.entityName = <PascalCase>)
          output_key: full_entity_schema
          Reads PGC_EntitySchema for join topology + PGC_Schema for live column defs.
          Returns: {
            entity_name, description,
            root:     { table, columns: [non-system, non-FK col names] },
            children: [{ table, alias, fk_column, output_key, columns }]
          }

Step 2  llm_call parse_entity_input  v2
          input: { userInput: "{{input.userInput}}",
                   full_entity_schema: "{{full_entity_schema}}" }
          output_key: parsed_entity
          Returns: { root: { <field>: <value> },
                     children: { <output_key>: [rows] } }

Step 3  human_gate review_object
          context_key: parsed_entity
          "Here's what I parsed — does this look right?"
          ├── Looks good → next
          └── Cancel     → cancelled

Step 4  serv_insert <root_table>
          row: "{{parsed_entity.root}}"
          output_key: new_record

Step 5  js_transform buildChildInserts
          output_key: child_inserts

Step 6  iterator over child_inserts
          item_step: serv_insert <child_table>
            row: { <fk_column>: "{{new_record.id}}", <col>: "{{item.<col>}}" }

Step 7  notify → "Added <domain> record (id: {{new_record.id}})."
Step 8  end
```

**Key design decisions:**
- `serv_entity_schema` (step 1) fetches live column definitions from `PGC_Schema` at
  every run — not from `PGC_EntitySchema.aggregations.columns`, which is set at domain
  creation time and can drift. New columns added to any table are immediately visible
  to the LLM without recreating the domain.
- `parse_entity_input` v2 receives `full_entity_schema` — it uses
  `full_entity_schema.root.columns` as the authoritative field list for the root row
  and `full_entity_schema.children[].columns` for each child. Column name hallucination
  is eliminated because the LLM never guesses column names.
- Child iterators inject `new_record.id` as the FK column at insert time.
  FK columns are never included in `parsed_entity.children` output.

##### update_\<domain\>

Confirmation-gate update on the root table by id. Requires `id=N` and at least
one `field=value` pair (enforced by Pass 1 or Pass 2 classification before the
workflow is invoked). Only updates the root table — child row updates require a
dedicated workflow.

```
Step 1  human_gate confirm
          "Update <domain> id={{input.id}} with provided changes?"
          ├── Confirm → next
          └── Cancel  → cancelled

Step 2  serv_update <root_table>
          filters: [{ column: id, op: eq, value: "{{input.id}}" }]
          updates: "{{input.updates}}"
          output_key: updated_record

Step 3  notify → "Updated <domain> record (id: {{input.id}})."
Step 4  end
```

##### delete_\<domain\>

Confirmation-gate delete on the root table by id. Requires `id=N` (enforced by
Pass 1 or Pass 2). Child rows are cleaned up by the database `ON DELETE CASCADE`
constraint on the FK — no application-level child deletion needed.

```
Step 1  human_gate confirm
          "Delete <domain> id={{input.id}}? This cannot be undone."
          ├── Confirm delete → next
          └── Cancel         → cancelled

Step 2  serv_delete <root_table>
          filters: [{ column: id, op: eq, value: "{{input.id}}" }]

Step 3  notify → "Deleted <domain> record (id: {{input.id}})."
Step 4  end
```

#### Gap taxonomy retrospective — what create_domain handles implicitly

`create_domain` was built before the gap taxonomy (Section 6.11) was formalised.
Mapping its current steps against that taxonomy reveals what works, what is handled
post-hoc, and what would improve under a future L/R collaboration pass.

**Type 1 — Preference gaps (user decisions that affect schema structure)**

Not handled before the LLM call. The user types one line — "stock portfolios" —
and the LLM guesses at every structural choice: how many tables, whether to track
transactions or only holdings, whether multi-currency support is needed, whether
to model positions as a derived view or a materialised table. These are genuine
preference questions that produce structurally different schemas. The user sees the
result at step 3 and can remove tables or add one via the add-table branch — but
this is post-hoc correction, not pre-design guidance. The LLM already made all the
choices; the user is editing the output rather than directing the input.

The `temperature: 0.2` variance entry in the tech debt register is a direct symptom
of this: the LLM produces different schemas for the same description across runs
because no design constraints were provided before the call.

**Type 2 — Knowledge gaps (domain best practices the LLM does not reliably know)**

Not handled. There is no right-brain research pass. The `create_domain` LLM call
is general-purpose Sonnet receiving a one-line description with no domain context
injection. A stock portfolio schema designed without domain research will likely
miss: position-level cost basis tracking, the distinction between realised and
unrealised P&L, the need for a transaction log as an append-only audit trail, and
the convention of separating ticker metadata from position data. These are Type 2
knowledge gaps that a research pass would resolve before schema generation begins.

**Type 3 — Schema gaps (structural dependencies within the produced output)**

Partially handled — and handled correctly where it exists. The topological sort in
step 3c is the system's first Type 3 resolution: it detects FK ordering dependencies
between the LLM-produced tables and sorts them so parent tables are created before
child tables reference them. This was introduced in Session 20 after FK constraint
errors in DDL. The `existing_table_modifications` field in the `design_table` prompt
is also a Type 3 resolution — it allows the add-table branch to patch FK columns
into existing tables when a new parent concept is introduced mid-design.

**Type 4a / 4b — Missing prompts and step types**

Not applicable. `create_domain` does not generate prompts or require step types
beyond what already exists.

**Type 5 — Ambiguity (intent underspecified)**

Not handled. If the user types `/m create domain stock portfolio` and
`stock_portfolio` already exists, the workflow re-runs the LLM and overwrites the
existing schema. A `serv_query` pre-check step before step 1 would detect the
existing domain and surface the choice: update aliases only, recreate from scratch,
or cancel. This is a Type 5 gap and is the correct fix for the duplicate domain
detection entry in the tech debt register — a single `serv_query` step, not an
architectural change.

**What a future create_domain v9 would look like with L/R**

Applying the L/R architecture would follow the same pattern as `create_workflow` v3.
The change is entirely in the steps before the existing step 1 LLM call:

```
Pre-check  serv_query PGC_DomainHelp — does this domain already exist?
           If yes → human_gate: update aliases / recreate / cancel  (Type 5)

Step 1R    RIGHT BRAIN: research_domain_schema (Perplexity sonar)
           Input: userInput + inferred domain category
           Retrieves: data modelling best practices for this domain type,
             canonical table structures, normalisation patterns, common pitfalls
           Surfaces: Tier 1 preference questions where the answer changes
             schema structure (e.g. "Track individual transactions or
             current holdings only?", "Multi-currency support?")

Step 1a    js_transform: build preference gate descriptors from research output

Step 1b    condition: any preference questions?
           → iterator: Tier 1 preference gates — user answers structural choices

Step 1c    LEFT BRAIN: llm_call create_domain
           Now receives: userInput + research findings + confirmed preferences
           Produces a schema implementing known choices, not guesses
           → proposed_scaffold

Steps 2–12  unchanged from current implementation
```

The user review gate at step 3 (edit_list) remains — the user can still remove
tables or add one. But by step 3 the schema already reflects stated preferences
and domain best practice. The gate becomes refinement rather than correction.

**Why this is deferred**

The right-brain improvement loop (Backlog item 8) will address `create_domain`
variance by observing failed domains via `PGC_WorkflowStats` and improving the
prompt from evidence — a lower-cost path than a full L/R pass. The L/R pass
belongs in `create_domain` v9 once the improvement loop has been running long
enough to identify which preference questions produce the most variance. The
duplicate domain detection (Type 5) should be fixed sooner — it is a `serv_query`
pre-check step and does not require the L/R architecture.

---

### 6.9 create_workflow Workflow 

`create_workflow` is the workflow that makes the brain self-extending. When a user
says `/m create a workflow Spanish vocabulary quiz`, the brain researches the domain,
elicits design preferences, produces a complete design specification, generates a
validated step array, and registers the workflow — without any code changes. Every
new workflow becomes immediately available to the Intent Preprocessor.

---

#### Why create_workflow is harder than create_domain

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

#### Decision: L/R collaboration architecture (v4)

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

#### Decision: gap analysis first, gate early, design only on a clear path

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

#### Decision: right brain first, user second, left brain third

The right brain runs before the left brain because the left brain
designs better when it starts with domain knowledge already in hand. The right brain
uses Perplexity sonar (`LLM_CHAT_URL`) because this is a retrieval task: retrieve
current, sourced best practices about the domain. Sonnet generates structured output
from a complete specification — it is not the right model for open-ended domain research.

User preference gates run between right brain and left brain. By the time the left
brain runs gap analysis, all preference questions are answered. By the time the left
brain designs the process, preferences are resolved.

---

#### Decision: PGC_SystemContext injection into executeLlmCall

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

#### Decision: left brain writes missing prompts inline (gap analysis phase)

When `analyze_workflow_gaps` identifies a required prompt that does not exist
in `PGC_Prompt` (Type 4a gap), it writes the full `prompt_text`, `output_shape`,
and `model` in the `prompts_needed` entry with `exists: false`. A `js_transform`
step filters these entries, then an iterator seeds them into `PGC_Prompt` in Phase 2
before `design_workflow_process` runs. The process designer and step generator can
reference the new prompt `intent_category` immediately.

---

#### Decision: schema gap gate cancels cleanly with domain suggestion

When `analyze_workflow_gaps` detects a blocking schema gap (Type 3b), it
includes a `domain_suggestion` field in `schema_changes[]`. The schema gap gate
shows the user what is missing, what they gain, and what they lose without it, with
a concrete command suggestion. Sub-workflow dependency tracking is Backlog.

---

#### Decision: process_design carries no dialog references

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

#### Decision: dialog options schema is gate_type-specific

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

#### Six-phase step structure (v4)

```
PHASE 0 — DATA LOAD
Step 1   serv_query PGC_Schema (domain filter)
         Filter: domain = {{input.domain}} OR domain IS NULL for cross-domain workflows
         → domain_schema

PHASE 1 — L/R COLLABORATION
Step 2   RIGHT BRAIN: llm_call research_workflow_domain (Perplexity sonar)
         Input:  { workflow_description: "{{input.userInput}}",
                   domain: "{{input.domain}}", domain_schema: "{{domain_schema}}" }
         Output: right_brain_research
                 { findings: [...], preference_questions: [...], out_of_scope: [...] }
         on_failure: next  ← research failure is non-blocking

Step 3   js_transform — build Tier 1 preference gate descriptors
         Reads: right_brain_research.preference_questions
         Output: preference_gates[]

Step 3a  js_transform — format research summary for user gate
         Reads: right_brain_research.findings, right_brain_research.preference_questions
         Output: research_summary { summary, decision_note, question_note }

Step 3b  human_gate confirm — show user what the right brain found
         Message: research findings + autonomous decisions made + count of preference questions to follow
         Options: [Continue → next] [Cancel → cancel]
         Transparency gate — user sees what domain knowledge was retrieved and which decisions
         were already resolved before being asked any preference questions.

Step 4   condition — any preference questions?
         on_truthy: step:5 (iterator)
         on_falsy:  step:6 (skip to step type load)

Step 5   iterator — Tier 1 USER PREFERENCE GATES (sequential)
         One human_gate choice per preference question.
         Each gate writes its selection to user_preferences array.
         Output: user_preferences [{ id, selected_value }, ...]

Step 6   serv_query PGC_StepType (status = 'live')
         → step_type_contracts

Step 7   LEFT BRAIN PASS 1: llm_call analyze_workflow_gaps (Sonnet)
         Input:  { userInput, domain, domain_schema, right_brain_research,
                   user_preferences, step_type_contracts }
         Output: gap_analysis
         {
           confidence:     "complete" | "needs_user_input" | "needs_schema" | "blocked",
           blocked_reason: string | null,
           schema_changes: [{ table, blocking, recommendation,
                              domain_suggestion?, impact_if_skipped, columns? }],
           prompts_needed: [{ intent_category, exists, prompt_text?, model?,
                              inputs, output_shape }],
           deferred:       [{ what, why, how_to_add }]
         }
         Narrow, focused output — no design content. Reliable Ajv validation.

PHASE 2 — GAP RESOLUTION
Step 8   js_transform — evaluate routing flags from gap_analysis
         Output: routing_flags { is_blocked, needs_schema, has_missing_prompts }

Step 9   condition — is_blocked?
         on_truthy: step:9a
         on_falsy:  next

Step 9a  notify — "Cannot build this workflow: {{gap_analysis.blocked_reason}}"
         → end  (Type 4b hard stop — missing step type capability)

Step 10  condition — needs_schema?
         on_truthy: step:10a
         on_falsy:  next

Step 10a js_transform — build schema gap message from gap_analysis.schema_changes
Step 10b human_gate confirm — show gap details + domain creation suggestion
         Options: [Create table first → cancel with suggestion] [Build without it → next] [Cancel → cancel]

Step 11a js_transform — filter gap_analysis.prompts_needed where exists=false
Step 11b condition — any missing prompts?
         on_truthy: step:11c
         on_falsy:  step:12
Step 11c iterator — seed each missing prompt into PGC_Prompt (Type 4a resolution)

PHASE 3 — WORKFLOW DESIGN
Step 12  LEFT BRAIN PASS 2: llm_call design_workflow_process (Sonnet)
         Input:  { userInput, domain, domain_schema, right_brain_research,
                   user_preferences, step_type_contracts, gap_analysis }
         Output: { process_design[], state_map }
         process_design items — exactly: step_label, step_type, description,
                                         inputs{}, outputs{}
         NO dialog field — process design and dialog design are orthogonal.
         state_map — { key: { type, written_by, read_by[] } }

Step 13  LEFT BRAIN PASS 3: llm_call design_workflow_dialogs (Sonnet)
         Input:  { gate_steps (filtered from process_design where step_type=human_gate),
                   domain_schema, user_preferences }
         Output: dialog_designs[]
         Each item: step_label, gate_type, message_template, options[], output_key?, context_key?
         Options shape is gate_type-specific (see options schema decision above).
         step_label links each dialog_designs entry to its process_design counterpart.
         This step is skipped (condition gate) when process_design has no human_gate steps.

PHASE 4 — STEP GENERATION
Step 14  llm_call generate_workflow_steps (Sonnet)
         Input:  { process_design, state_map, dialog_designs, domain_schema,
                   step_type_contracts [PGC_SystemContext injection],
                   routing_value_rules  [PGC_SystemContext injection],
                   create_domain_example [PGC_SystemContext injection] }
         Output: draft_workflow { name, description, intent_keywords, steps[] }
         Translation task only — all design decisions already made.
         The step generator joins process_design + dialog_designs by step_label.

PHASE 5 — VALIDATION
Step 15  human_gate review_object — user reviews draft_workflow.steps
         Options: [Looks good → next] [Request changes → step:14] [Cancel → cancel]

Step 16  simulate Level 1 — static analysis
         on_failure: step:15  (route back with failures shown in gate context)

Step 17  llm_call generate_workflow_mocks — representative mock outputs per step
Step 18  llm_call generate_workflow_paths — named simulation paths (happy, cancel, failure)
Step 19  simulate Level 2 + Level 3 — full path execution with mocks
         on_failure: step:15

PHASE 6 — REGISTRATION
Step 20  human_gate confirm — show simulation results, ask to register
Step 21  serv_insert PGC_Workflow
Step 22  serv_insert PGC_IntentMap
         row: { pattern: draft_workflow.name, intent_category: draft_workflow.name,
                action_type: workflow }
         NOTE: no workflow_id column — PGC_IntentMap and PGC_Workflow are structurally
         independent. Routing uses action_type + intent_category name lookup only.
Step 23  notify — "Workflow {{draft_workflow.name}} registered.
                   {{gap_analysis.deferred.length}} enhancements deferred."
Step 24  end
```

---

#### Domain mode — three execution contexts

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

#### Gap taxonomy applied — per gap type (v4)

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

#### Preference gate iterator contract

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

#### generate_workflow_steps — translation contract

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

#### Gate-bounded correction loops

Steps 15–16 and 15–19 form gate-bounded correction loops. The backward jump from
step 16 (or step 19) to step 15 is safe because every path from step 15 back to
step 16 or step 19 passes through the step 15 `human_gate`. This satisfies Guard 3's
cycle-safety rule.

If simulation repeatedly fails, the user cancels at step 15. There is no automated
retry limit on human-gate-bounded loops.

If the user requests changes at step 15, the backward reference to step 14
re-runs the step generator only — not the design phases. The three-part specification
(`process_design`, `state_map`, `dialog_designs`) persists in `local_state` and is
reused. The user's change request should be captured as a `text_input` gate before
step 14 to inject the request into the step generator's input.

---

#### Prompt dependencies (v4)

| Step | Prompt `intent_category` | Model | Output key |
|---|---|---|---|
| 2  | `research_workflow_domain` | `perplexity/sonar` | `right_brain_research` |
| 7  | `analyze_workflow_gaps` | `anthropic/claude-sonnet-4-5` | `gap_analysis` |
| 12 | `design_workflow_process` | `anthropic/claude-sonnet-4-5` | `process_design`, `state_map` |
| 13 | `design_workflow_dialogs` | `anthropic/claude-sonnet-4-5` | `dialog_designs` |
| 14 | `generate_workflow_steps` | `anthropic/claude-sonnet-4-5` | `draft_workflow` |
| 17 | `generate_workflow_mocks` | `anthropic/claude-sonnet-4-5` | `mock_outputs` |
| 18 | `generate_workflow_paths` | `anthropic/claude-sonnet-4-5` | `simulation_paths` |

PGC_SystemContext rows injected via `executeLlmCall`:
- `step_type_contracts` — injected into steps 7, 12, 13, 14
- `routing_value_rules` — injected into steps 12, 13, 14
- `create_domain_example` — injected into step 14

---

#### Implementation notes

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
- Step 15 (`human_gate review_object`) backward route `"Request changes" → step:14`
  re-runs the step generator only. The three-part specification persists in `local_state`
  and is reused unchanged.

---


---

### 6.10 Session Architecture — Conversational Memory (Backlog)

The session layer gives the brain persistent memory across multiple `/mind`
messages in the same Slack thread. Without it, each `/mind` call is cold — the
Intent Preprocessor has no knowledge of what the user was just doing. With it,
the brain can resolve ambiguous short-form inputs, pre-seed workflow state with
entities the user was already working on, and accumulate a factual record of what
happened in each thread — feeding the right-brain improvement loop.

The session layer is Backlog. The Intent Preprocessor works without it. When it
lands, it does not change any workflow definitions or Step Processor contracts.
It is purely additive.

#### Session identity — UI-agnostic by design

A session is identified by a UUID (`session_id`) generated by `mind.mjs`, not by
`thread_ts`. `thread_ts` is stored inside `PGC_Session.callback.threadId` — the
same pattern as every other UI-specific routing field in the system.

**Session lookup flow in `mind.mjs`:**
```
thread_ts present (reply in existing thread)
  → getRows PGC_Session where callback->>'threadId' = thread_ts
      found     → retrieve session_id, include in CLASSIFY_INTENT message
      not found → generate UUID, PROC creates PGC_Session row on receipt

thread_ts absent (fresh /mind or HTTP test)
  → session_id omitted → PROC treats as sessionless
```

#### Session context injection into the Intent Preprocessor

When `classify-intent.mjs` receives a `session_id`, it reads the last 20
`PGC_SessionEntry` rows for that session (most recent first) and uses them in
two ways:

**Pass 2 domain fallback (Backlog):** If Pass 2 finds no alias token in the input text,
the preprocessor scans the session context for the most recently active domain.
"Add carbonara" resolves to `recipes` because the session shows the user was just
there. Zero LLM cost. Produces `confidence: 'session_context'`.

**Tier 2 prompt injection:** The context block is prepended to the sonar
classification prompt. "Make that a three-course meal plan" becomes classifiable
as `meal_planner` because sonar sees the user has been working with recipes.

#### Full example — recipes exploration → add → meal plan

```
Turn 1  /mind show me my pasta recipes
  Pass 2: alias 'pasta' → domain 'recipes'
  Pass 2 keyword scan: 'show' in list_recipes.intent_keywords → list_recipes workflow

Turn 2  /mind add carbonara with ingredients [...]   (same thread)
  Pass 2: no alias token → fallback to session context → domain 'recipes'
  Pass 2 keyword scan: 'add' in add_recipes.intent_keywords → add_recipes workflow

Turn 3  /mind make that a three-course meal plan using those recipes
  Pass 1: no match. Pass 2: no alias, no session domain resolved.
  Tier 2: sonar receives input + session context
  → workflow_name = 'meal_planner', referenced_entities = [Carbonara, ...]
  → execute_top, local_state.context pre-seeded with referenced_entities
```


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

