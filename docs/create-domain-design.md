# create_domain Workflow — Design Reference

Extracted from `docs/architecture.md` §6.8. Full annotated step flow, generated CRUD
workflow definitions, and gap taxonomy retrospective for `create_domain`.

Cross-references: `docs/architecture.md` §6.5 (Step Processor), §6.11 (Gap Taxonomy).

---

## Data flow summary

`create_domain` is the primary demonstrator workflow. It uses every major Step
Processor capability: `llm_call`, `js_transform`, multi-step `human_gate`
sequences with branching, `iterator`, `serv_insert`, and `notify`.

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

---

## Why the add-table branch loops back

Step 3c uses `on_success: "step:3"` — a backward jump. After the new table is designed
and merged into `proposed_scaffold.tables`, the workflow returns to step 3 so the user
can review the updated list and either confirm, add another, or cancel.

The Step Processor handles this correctly because step keys are resolved by string
equality — `"step:3"` resolves to step `"3"` with no confusion with `"3a"`, `"3b"`,
`"3c"`, or `"3d"`. Each branching step has a distinct `frame_id` × `step_key` pair in
`PGC_WorkflowRunStep`, so idempotency works correctly across loop iterations.

---

## Prompt dependencies

| Step | Prompt `intent_category` | Output stored at |
|---|---|---|
| 1 | `create_domain` v3 | `proposed_scaffold` |
| 3b | `design_table` v1 | `new_table` |
| 6 | `generate_crud_workflows` v5 | `generated` |

All three prompts have `output_schema` defined. The correction loop runs on all three
if the LLM output is malformed.

---

## Generated CRUD workflows — one per verb

The `generate_crud_workflows` v5 prompt produces four workflow definitions written to
`PGC_Workflow` at step 9. All four have `action_type: workflow` in `PGC_IntentMap`.

### list_\<domain\>

Zero-LLM formatted list. Runs `serv_query` on the root table and posts count + preview.

```
Step 1  serv_query PGD_<root_table>  (no filters — all rows)
          output_key: results
Step 2  notify → "Found {{results.length}} <domain> record(s)."
Step 3  end
```

### add_\<domain\>

LLM-parse-first multi-table insert. Uses `serv_entity_schema` to load live column
definitions from `PGC_Schema` — immune to schema drift.

```
Step 1  serv_entity_schema  (input.entityName = <PascalCase>)
          output_key: full_entity_schema
Step 2  llm_call parse_entity_input  v2
          input: { userInput: "{{input.userInput}}", full_entity_schema: "{{full_entity_schema}}" }
          output_key: parsed_entity
Step 3  human_gate review_object  → "Here's what I parsed — does this look right?"
          ├── Looks good → next
          └── Cancel     → cancelled
Step 4  serv_insert <root_table>   row: "{{parsed_entity.root}}"   output_key: new_record
Step 5  js_transform buildChildInserts   output_key: child_inserts
Step 6  iterator over child_inserts
          item_step: serv_insert <child_table>
            row: { <fk_column>: "{{new_record.id}}", <col>: "{{item.<col>}}" }
Step 7  notify → "Added <domain> record (id: {{new_record.id}})."
Step 8  end
```

Key decisions: `serv_entity_schema` fetches live column defs at run time — not cached
`PGC_EntitySchema.aggregations.columns`. FK columns are never included in
`parsed_entity.children` output; they are injected at insert time from `new_record.id`.

### update_\<domain\>

Confirmation-gate update on root table by id. Only updates root table — child row
updates require a dedicated workflow.

```
Step 1  human_gate confirm  → "Update <domain> id={{input.id}} with provided changes?"
          ├── Confirm → next    └── Cancel → cancelled
Step 2  serv_update <root_table>
          filters: [{ column: id, op: eq, value: "{{input.id}}" }]
          updates: "{{input.updates}}"   output_key: updated_record
Step 3  notify → "Updated <domain> record (id: {{input.id}})."
Step 4  end
```

### delete_\<domain\>

Confirmation-gate delete by id. Child rows cleaned up by `ON DELETE CASCADE`.

```
Step 1  human_gate confirm  → "Delete <domain> id={{input.id}}? This cannot be undone."
          ├── Confirm delete → next    └── Cancel → cancelled
Step 2  serv_delete <root_table>
          filters: [{ column: id, op: eq, value: "{{input.id}}" }]
Step 3  notify → "Deleted <domain> record (id: {{input.id}})."
Step 4  end
```

---

## Gap taxonomy retrospective

`create_domain` was built before the gap taxonomy (`docs/architecture.md` §6.11) was
formalised. This maps current steps against the taxonomy.

### Type 1 — Preference gaps

**Not handled before the LLM call.** The user types one line and the LLM guesses every
structural choice. The user reviews at step 3 (edit_list) and can remove or add tables —
but this is post-hoc correction, not pre-design guidance. The `temperature: 0.2` variance
entry in the tech debt register is a direct symptom: the LLM produces different schemas
for the same input because no design constraints were provided before the call.

### Type 2 — Knowledge gaps

**Not handled.** No right-brain research pass. `create_domain` runs general-purpose Sonnet
with no domain context injection. A stock portfolio schema without domain research will
likely miss: cost basis tracking, realised vs unrealised P&L distinction, transaction log
as append-only audit trail, and separation of ticker metadata from position data.

### Type 3 — Schema gaps

**Partially handled and correctly where it exists.** The topological sort in step 3c
detects FK ordering dependencies and sorts tables so parents are created before child
references. The `existing_table_modifications` field in `design_table` allows the
add-table branch to patch FK columns into existing tables when a new parent concept is
introduced mid-design.

### Type 4a/4b — Missing prompts and step types

**Not applicable.** `create_domain` does not generate prompts and requires no step types
beyond what already exist.

### Type 5 — Ambiguity

**Not handled.** If `stock_portfolio` already exists, the workflow re-runs the LLM and
overwrites the schema. A `serv_query` pre-check step before step 1 would detect the
existing domain and surface the choice: update aliases only, recreate from scratch, or
cancel. This is a single `serv_query` step — not an architectural change.

---

## Target design — create_domain v9 with L/R collaboration

Applying the gap taxonomy (§6.11) produces the following pre-generation pipeline.
Steps 2–12 are unchanged from the current implementation.

```
Pre-check  serv_query PGC_DomainHelp — does this domain already exist?
           If yes → human_gate: update aliases / recreate / cancel  (Type 5)

Step 1R    RIGHT BRAIN: research_domain_schema (Perplexity sonar)
           Input: userInput + inferred domain category
           Retrieves: data modelling best practices, canonical table structures,
             normalisation patterns, common pitfalls
           Surfaces: Type 1 preference questions where the answer changes schema
             structure (e.g. "Track individual transactions or current holdings only?",
             "Multi-currency support?")

Step 1a    js_transform: build preference gate descriptors from research output

Step 1b    condition: any preference questions?
           → iterator: Tier 1 preference gates — user answers structural choices

Step 1c    LEFT BRAIN: llm_call create_domain
           Receives: userInput + research findings + confirmed preferences
           Produces schema implementing known choices, not guesses
           → proposed_scaffold

Steps 2–12  unchanged
```

The user review gate at step 3 (edit_list) remains — the user can still remove tables
or add one. By step 3 the schema already reflects stated preferences and domain best
practice. The gate becomes refinement rather than correction.

**Sprint 2 Track A implements this pattern.** See `docs/sprints/CURRENT.md`.
