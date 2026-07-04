# create_domain Workflow — Design Reference
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture docs. Main overview: `docs/architecture.md`. See also: `docs/arch-step-types.md` (step type reference), `docs/arch-step-processor.md` (execution engine), `docs/arch-workflow-patterns.md` §6.8, `docs/arch-prompt-rules.md` (prompt rule placement guide).

Current as of Sprint 7. Describes the live workflow definition (v52) running in prod.

---

## Overview

`create_domain` is the system's most complex workflow. It applies the full L/R brain
collaboration pattern, iterative user review with schema amendment, DDL execution, domain
registration, and post-confirmation memory writes. It exercises every major Step Processor
capability.

**Input:** `userInput` — free-text domain description from the user.

**Outputs produced:**
- Physical PGD tables in the domain database
- Optionally, one PGD view (proposed and confirmed at step 16i — see Phase 3)
- `PGC_DomainHelp` row (aliases, description, commands)
- 5 `PGC_IntentMap` rows (add/list/get/update/delete patterns)
- 1+ `PGC_EntitySchema` rows
- 3 `PGC_Memory` rows (see Memory layer below)

---

## Step flow

### Phase 1 — Pre-check and right-brain research (steps 1–9)

```
Step 1   js_transform  → candidate_domain (slug derived from userInput)
Step 2   serv_query PGC_DomainHelp  → existing_domain_check
Step 3   condition: existing_domain_check.length
           truthy → step 4 (domain exists gate)
           falsy  → step 5

Step 4   human_gate confirm — domain already exists; offer Recreate or Cancel
           Recreate → step 5   |   Cancel → cancelled

Step 5   llm_call research_domain_schema (RIGHT BRAIN — Perplexity sonar)
           Input: userInput
           Output: domain_research = { findings: [], preference_questions: [] }
           Finds: data-modelling best practices, normalisation patterns, common pitfalls.
           Resolves Type 1 structural choices that have a clear best-practice answer;
           surfaces genuine preference decisions for the user to answer.

Step 6   js_transform  → preference_gates (choice gate descriptors from domain_research)
Step 6a  js_transform  → design_assumptions_message (human-readable findings summary)
Step 6b  notify → posts design_assumptions_message to Slack before gates begin

Step 7   js_transform  → user_preferences = [] (initialise for downstream LLM)
Step 8   condition: preference_gates.length
           truthy → step 9 (present gates)
           falsy  → step 10 (skip to left brain)

Step 9   iterator over preference_gates
           item_step: human_gate choice
             Present each preference question. User selects one option.
             output_key: user_preferences (collected array)
           on_complete → step 10
```

### Phase 2 — Left-brain schema design and iterative review (steps 10–16)

```
Step 10  llm_call create_domain (LEFT BRAIN)
           Inputs: userInput, research_findings (from step 5), user_preferences (from step 9)
           Output: proposed_scaffold = { domain, tables: [...], initial_value_conventions: [...] }
           save_to_memory: EPISODIC — initial_design_reasoning tag (pre-confirmation)

Step 11  js_transform  → enriches proposed_scaffold.tables with columnSummary and domain fields
Step 11a js_transform  → schema_summary (Slack mrkdwn) + table_review_items (reveal content)

Step 12  human_gate choice — user reviews schema summary with per-table reveal panels
           Approve         → step 16
           Request changes → step 12b (revision modal)
           Add a table     → step 12c (text_input)
           Cancel          → cancelled

Step 12c human_gate text_input → new_table_description
           Design it → step 13   |   Back → step 12

Step 12b llm_call revise_domain_schema (LEFT BRAIN)
           Inputs: userInput, proposed_scaffold, user_preferences, research_findings, design_feedback
           Output: proposed_scaffold (full replacement)
           save_to_memory: SEMANTIC — schema_expectations tag (additive — each revision adds a row)
           on_success → step 11 (re-enrich, loop back to review)

Step 13  llm_call design_table (LEFT BRAIN)
           Inputs: domain, existing_tables, new_table_description
           Output: new_table (single table object with optional existing_table_modifications)
           save_to_memory: SEMANTIC — schema_expectations tag (additive — one row per new table)

Step 14  js_transform → merges new_table into proposed_scaffold.tables, topological-sorts,
           re-enriches, loops back to step 12

Step 16  human_gate confirm — final DDL confirmation
           Create it → next (step 16b)   |   Cancel → cancelled
```

### Phase 3 — Post-confirmation memory write and optional view proposal (steps 16b–16k)

These steps run immediately after user confirmation, before any DDL. Steps 16b/16c
write the semantic memory that `create_workflow` and `parse_entity_input` will
retrieve. Steps 16d–16k are new in Sprint 7 (Track E) — they topologically sort the
confirmed tables, then give the LLM one chance to propose an optional view before
DDL executes. The proposal is entirely optional and every failure/skip path degrades
gracefully to creating just the tables — it never blocks domain creation.

```
Step 16b js_transform → domain_semantic_content
           Reads proposed_scaffold (the confirmed schema). Builds a structural prose
           summary for each table, categorising non-system columns into three groups:
             - required at insert (NOT NULL, no default)
             - SQL defaults, db sets (NOT NULL with default — value auto-applied)
             - null at creation, omit from insert (nullable — populated by a later workflow)
           Appends initial_value_conventions lines when present.

Step 16c write_memory SEMANTIC
           Scope: { domain }
           Content: domain_semantic_content
           Tags: schema_snapshot, insert_expectations
           Priority: 2
           This is the definitive post-confirmation structural snapshot. Retrieved by
           both create_workflow and parse_entity_input (classify-intent data loads).

Step 16d js_transform → sorted_tables, ddl_items (comma-separated output_key)
           Topologically sorts proposed_scaffold.tables by FK dependency so parent
           tables are created before child tables. ddl_items starts as an identical
           copy of sorted_tables. The DDL iterator (step 17) always reads from
           ddl_items — never sorted_tables directly — so a confirmed view can be
           appended onto it later (step 16k) without disturbing sorted_tables, which
           this same run still references by that name (steps 16g/16k below).

Step 16e serv_query PGC_SystemContext WHERE key = 'minds_eye_preferences'
           → minds_eye_context_rows
           Loads the assistant's configured name so step 16i's "do later" option
           never hardcodes an assistant name in workflow text — the name is
           evolving-artifact data (PGC_SystemContext), not system code.

Step 16f js_transform → minds_eye_name, view_proposals, view_feedback
           Extracts content.name from minds_eye_context_rows[0] (generic fallback
           "the assistant" if the row is missing). Also seeds view_proposals/
           view_feedback to []/'' — but only takes effect the first time through:
           on a later loop-back visit (16i "Request changes" → 16g directly, see
           below) this step is not re-executed, so the real accumulated values
           from the prior 16g call and 16i's modal are left untouched.

Step 16g llm_call propose_domain_view (LEFT BRAIN)
           Inputs: domain, tables (= sorted_tables), previous_proposal, view_feedback
             (both template references — [] and '' on the first visit via 16f's
             seed, real accumulated values on a revision loop-back)
           Output: view_proposals — an array of 0 or 1 candidate view objects:
             { tableName, description, rationale, selectSql }
           A view is proposed only when it provides clear, obvious value for this
           domain (e.g. a monthly rollup by category) — an empty array is a common
           and correct answer, not a failure.
           on_success → step 16h always (both the first call and every revision
             pass route through the same condition check — see below)
           on_else → step 16h (an LLM failure here is treated the same as "no view
             warranted" — never block domain creation over an optional suggestion)
           Reused directly for revision passes: step 16i's "Request changes" option
           routes back to 16g itself rather than a separate revision step, so there
           is only one llm_call to maintain. A failed revision leaves view_proposals
           holding the last successful proposal (16g's output_key is only
           overwritten on a successful call), so 16h/16i naturally re-present the
           last known-good proposal rather than losing it.

Step 16h condition: view_proposals.length
           truthy → step 16i (present the gate)
           falsy  → step 17  (skip straight to DDL — no gate shown when nothing
                              was proposed; this is the common case)

Step 16i human_gate choice — presents the proposed view (selectSql behind a reveal
           button, never shown as raw message text)
           Create it        → step 16k (merge the view into ddl_items)
           Request changes  → step 16g (modal-captured feedback → view_feedback,
                               then re-run the same llm_call as a revision pass —
                               safe backward reference per Guard 3: the loop always
                               passes back through this same human_gate, so it
                               always suspends waiting for input)
           Do later         → step 17  (skip — ddl_items is already just the tables)
           Cancel           → cancelled
           See `arch-workflow-patterns.md` §6.7 "Choice gate cancel sentinel" —
           "Do later" deliberately uses value: "later", not "cancel": a choice
           option with value: "cancel" always terminates the whole workflow before
           its on_select is ever consulted, regardless of what on_select says.

Step 16k js_transform → ddl_items
           Appends the confirmed view onto sorted_tables — views are always last,
           since a view's selectSql may reference any of the domain's tables and
           none of them exist yet until step 17 runs. Only reached from step 16i's
           "Create it" option.
```

### Phase 4 — DDL execution and domain registration (steps 17–24)

```
Step 17  iterator over ddl_items (the confirmed tables, plus a confirmed view if
           one was proposed and accepted — see Phase 3)
           item_step: serv_schema — branches on shape: a table object (columns
             present) calls SERV-Schema createTable; a view object (selectSql
             present, no columns) calls createView, which introspects the
             resulting columns rather than trusting caller-declared metadata.
           → created_tables

Step 17b llm_call generate_domain_aliases (Perplexity sonar)
           Generates natural-language aliases for the domain (singular/plural, synonyms)
           save_to_memory: SEMANTIC — aliases, vocabulary tags

Step 17c human_gate text_input — user may add custom aliases
           Optional. User types comma-separated names (e.g. "groceries, food, shopping")
           or leaves blank and presses Done. Output key: user_aliases_raw.
           Cancel → cancelled.

Step 18  js_transform → generated = { domainHelp, intentMapRows: [5], entitySchemas: [1+] }
           Derives domain registration from confirmed scaffold + LLM aliases + user aliases.
           user_aliases_raw (if set) is split on commas, trimmed, and merged into the
           aliases Set alongside the LLM-generated ones.
           Also computes entity name (TitleCase singular), join/aggregation structure,
           and 5 IntentMap patterns (add/list/get/update/delete).

Step 19  human_gate review_object — user reviews aliases and CRUD commands
           Looks good → next   |   Cancel → cancelled

Step 20  serv_insert PGC_DomainHelp ← generated.domainHelp
Step 21  iterator → serv_insert 5 PGC_IntentMap rows
Step 22  iterator → serv_insert PGC_EntitySchema rows
Step 22a js_transform → domain_ready_message
           Builds the notify text from the registered commands so the confirmation
           includes the bulk-add command, not just a generic "domain ready" line.
Step 23  notify → domain_ready_message
Step 24  end
```

---

## Memory layer

`create_domain` writes three types of memory entries. They accumulate additively —
old rows are never overwritten (each write creates a new `PGC_Memory` row).

| When | Step | Type | Tags | Content | Consumer |
|------|------|------|------|---------|----------|
| Pre-confirmation | 10 | episodic | domain_design, initial_design_reasoning | LLM reasoning from initial schema design (via `save_to_memory` / `reasoning` field) | Episodic history only |
| Pre-confirmation (on each revision) | 12b | semantic | schema_expectations | LLM reasoning about revised design expectations (additive — one row per revision) | create_workflow, parse_entity_input |
| Pre-confirmation (on each add-table) | 13 | semantic | schema_expectations | LLM reasoning about new table's insert expectations | create_workflow, parse_entity_input |
| Post-confirmation | 16c | semantic | schema_snapshot, insert_expectations | Structural fact snapshot: required/defaulted/null-at-creation columns + initial_value_conventions | create_workflow, parse_entity_input |
| Post-workflow-completion | MEMORY_WRITE SQS | episodic | run_complete | "Completed workflow 'create_domain' for domain 'X'" — written by memory-writer.mjs | Episodic history |

**Why two-layer?** Pre-confirmation reasoning (step 10) is episodic — it reflects the
LLM's initial thinking, which the user may revise. Post-confirmation (step 16c) is
semantic fact — it reflects the schema as the user actually confirmed it. `create_workflow`
and `parse_entity_input` should rely on the confirmed facts, not the initial draft.

**Memory retrieval scope:** All semantic entries are written with `scope: { domain }`.
When `create_workflow` runs for a domain workflow (scope `{ domain, workflow: create_workflow }`),
`expandScope` includes `{ domain }` as a parent level — all domain semantic memories
are retrieved. Same for `parse_entity_input` running inside `add_entity` (scope
`{ domain, workflow: add_entity }`).

---

## initial_value_conventions

The `create_domain`, `design_table`, and `revise_domain_schema` prompts all emit an
optional `initial_value_conventions` array in their output. Each entry is:

```json
{ "table": "PGD_Cards", "column": "interval_days", "convention": "first review interval is 1, not SQL default 0" }
```

**When to emit:** Only for cases where the SQL DEFAULT or nullable flag does not fully
describe the application-level intent. Examples:
- A nullable column that must be null at creation because a later workflow sets it (name WHICH workflow)
- A NOT NULL column with a SQL DEFAULT where the application applies a semantically different starting value

**How it flows:**
1. LLM emits it in `proposed_scaffold.initial_value_conventions`
2. Step 16b includes it in `domain_semantic_content` under "Application initial-value conventions"
3. Step 16c writes it to semantic memory
4. `parse_entity_input` reads it from memory and applies conventions to fields not supplied by the user
5. `create_workflow` reads it from memory and designs steps that handle initial state correctly

---

## Prompt dependencies

| Step | Prompt `intent_category` | Model | Output key |
|------|--------------------------|-------|------------|
| 5 | `research_domain_schema` | perplexity/sonar | `domain_research` |
| 10 | `create_domain` | smart | `proposed_scaffold` |
| 12b | `revise_domain_schema` | smart | `proposed_scaffold` |
| 13 | `design_table` | smart | `new_table` |
| 16g | `propose_domain_view` | anthropic/claude-sonnet-4-5 | `view_proposals` |
| 17b | `generate_domain_aliases` | perplexity/sonar | `domain_aliases` |

All six prompts have `output_schema` defined. The correction loop runs on all six
if LLM output is malformed. `propose_domain_view` is invoked from a single step key
(16g) for both the initial proposal and every revision pass — 16i's "Request changes"
routes back to 16g directly rather than to a separate revision step, so
`previous_proposal`/`view_feedback` are template references (real accumulated values
on a loop-back visit; empty defaults seeded once by step 16f on the first visit)
rather than two near-duplicate llm_call steps to maintain. `create_domain`,
`design_table`, and `revise_domain_schema` have `save_to_memory` wired in the workflow
step definition — the harness strips the `reasoning` field before schema validation
and writes it to `PGC_Memory`. `propose_domain_view` does not — a view suggestion is
not schema reasoning worth persisting the way table design is.

---

## Design patterns used

**L/R brain split:** Right brain (step 5, sonar) researches domain best practice and
surfaces preference questions. Left brain (step 10) designs the schema with all
decisions already resolved.

**Iterative review with back-edge routing:** Step 12b and step 14 both route back to
step 12 after updating `proposed_scaffold`. Back-edge routing with the Step Processor
is safe because idempotency is keyed on `(run_id, frame_id, step_key)` — each visit
to step 12 has a distinct `frame_id` pushed by the gate suspension.

**Schema amendment vs full redesign:** Step 12b replaces the full scaffold (full redesign
based on feedback). Step 13 + step 14 add a single table (additive merge). Both loop
back to step 12 for review.

**Topological sort in step 14 and step 16d:** FK dependencies are sorted so parent
tables precede child tables. Step 14 re-sorts inline whenever a table is added
during the review loop; step 16d does the final sort once the schema is confirmed,
feeding both `sorted_tables` (referenced by the view-proposal steps) and `ddl_items`
(what step 17 actually creates). Required because `createTable` in SERV will fail if
a referenced table does not yet exist — and, as of Sprint 7, `createView` has the
same requirement one level up: a view can't be created before *any* of its source
tables exist, which is why views are appended to `ddl_items` after the sort rather
than participating in it.

**Optional post-confirmation view proposal (steps 16e–16k):** Runs after the tables
are already confirmed and DDL-ready, and never blocks domain creation — every
failure or skip path (`llm_call` `on_else`, the `condition` at 16h, "Do later")
degrades gracefully to creating just the tables. This is a deliberate scope choice:
the proposal has no live-data sampling loop, since a brand-new domain has no rows
yet to sample — that verification belongs to Novia's `create_view` tool, once real
data exists (see `arch-workflow-patterns.md` §6.8).

**Choice gate cancel sentinel:** See `arch-workflow-patterns.md` §6.7 — a choice
option with `value: "cancel"` always terminates the workflow before its `on_select`
is consulted, regardless of what `on_select` says. Step 16i's "Do later" option uses
`value: "later"` for exactly this reason.

**Additive memory accumulation:** Steps 12b and 13 write semantic memory on every
iteration. Multiple design cycles accumulate rows — retrieval sorts by `created_at DESC`
so the most recent expectations appear first in the memory block.
