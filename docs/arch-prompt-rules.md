# Prompt Rules Catalog and Placement Guide

This document is the authoritative guide for where rules live in the system. Read it before adding any rule to a prompt or system context entry. It also serves as the inventory of rules that should migrate from `PGC_Prompt.prompt_text` into `PGC_SystemContext`.

---

## 1. Decision Framework — Where Does a New Rule Go?

Ask three questions in order:

**Q1: Does this rule describe the output shape or format of this specific prompt?**
- Yes → stays in `prompt_text` (Category A)
- No → continue

**Q2: Does this rule apply to more than one prompt, or could it?**
- Yes → belongs in `PGC_SystemContext` with `inject_for` (Category B or C)
- No → it is prompt-specific business logic; stays in `prompt_text` unless Q3 applies

**Q3: Does this rule express a system-wide invariant (single-user, naming convention, type contract) that must never drift between prompts?**
- Yes → belongs in `PGC_SystemContext` (may use `inject_always` or broad `inject_for`)
- No → prompt-specific business logic; stays in `prompt_text`

**The failure mode to avoid:** adding a rule directly to `prompt_text` when it expresses a principle that other prompts also need. That rule is now invisible to those prompts, cannot be updated centrally, and will drift.

---

## 2. Categories

### Category A — Prompt-Local Rules (stay in `prompt_text`)

Criteria: describes this prompt's specific output structure, field list, forbidden fields, or output-format obligations.

Examples:
- "Return ONLY a valid JSON object — no markdown, no backticks" *(output format — every prompt has this; it does not need to be in system context because the JSON-only requirement is implicit in `output_schema` validation)*
- "`process_design` items: ONLY these fields: step_label, step_type, description ..." *(field whitelist for that specific output object)*
- "Forbidden fields: step_id, step, order, label ..." *(output format for that prompt)*
- "`corrected_steps`: complete array, not a diff" *(output contract for fix_workflow_steps)*
- Input-handling rules that describe how to interpret a specific variable in that prompt

### Category B — Schema Design Rules (→ `PGC_SystemContext`, inject into schema prompts)

Criteria: rules about PostgreSQL table and column design that appear across two or more of: `create_domain`, `design_table`, `revise_domain_schema`, `research_domain_schema`.

Target inject_for: `["create_domain", "design_table", "revise_domain_schema"]`

| Context Key (proposed) | Rule coverage |
|---|---|
| `pgd_naming_conventions` | Table: PGD_ + PascalCase, no underscores after prefix. Trigger: `trg_<tablename_lower>_updated_at`. FK: `fk_<childtable_lower>_<parenttable_lower>`. Constraint: `uq_<table>_<cols>`, `chk_<table>_<col>`. Domain: snake_case. Embedding column always named `embedding`. |
| `pgd_required_columns` | Every table requires id (serial, primaryKey), created_at (timestamptz, not null, default now()), updated_at (timestamptz, not null, default now()), and a BEFORE UPDATE trigger `set_updated_at()`. |
| `pgd_column_type_rules` | Allowed types enum (17 types). No length/precision specifiers by default (`varchar` not `varchar(255)`, `numeric` not `numeric(10,2)`) **except**: when a column carries a decimal boundary constraint (CHECK, >=, <= with decimal literals), use `numeric(p,s)` with precision matching the most precise constraint literal. Never use `real` or `float` for such columns. No type aliases (`integer` not `int`, `real` not `float4`). |
| `pgd_fk_constraint_rules` | FK `column` field required (must name the actual column in the child table). FK `references` always `{ "table": "PGD_...", "column": "id" }`. Constraint `type` always lowercase (`unique`/`check`, never `UNIQUE`/`CHECK`). Check constraint key is `expression` (never `definition`, `condition`, `check`). Constraint `columns` must name real columns on that table. `onDelete: SET NULL` (not CASCADE) when adding FK column to an existing table. |
| `pgd_default_value_format` | Column `default` must be a valid SQL expression string. String literals need inner SQL single-quotes: `"'active'"` not `"active"`. Numeric/boolean/function values need no inner quotes: `"0"`, `"true"`, `"now()"`. |
| `single_user_constraint` | *(already exists)* Extend `inject_for` to include `design_table` — currently missing. |

### Category C — Workflow Design Rules (→ `PGC_SystemContext`, inject into workflow prompts)

Criteria: rules about workflow step structure, routing, or LLM selection that appear across two or more of the workflow design prompts.

Most of these are already in system context. Remaining gaps:

| Context Key (proposed) | Rule coverage | Currently in |
|---|---|---|
| `workflow_gap_taxonomy` | Type 1 (preference), Type 2 (knowledge), Type 3a/b (schema blocking), Type 4a (missing prompts), Type 4b (missing step types) — resolution rule per type | Duplicated verbatim in `analyze_and_design_workflow` and `analyze_workflow_gaps` |
| `llm_model_selection_rules` | `prompts_needed.model` must be `anthropic/claude-sonnet-4-5` (analytical) or `perplexity/sonar` (live search) — never gpt-4, gpt-4o-mini, or any other model | Duplicated in `analyze_and_design_workflow` and `analyze_workflow_gaps` |

Already in system context (correctly placed):
- `routing_value_rules` — routing tokens, valid values per step type
- `workflow_routing_rules` — 9 routing invariants
- `step_type_contracts` — full step type reference
- `step_usage_patterns` — correct/incorrect examples per step type
- `runtime_bindings` — input.*, output_key lifecycle, iterator scope
- `template_syntax` — `{{key.path}}` forms, no Handlebars block syntax
- `workflow_constraints` — structural constraints (end step, Guard 1, Guard 3)
- `flat_loop_example` — flat loop pattern with annotated quiz example
- `serv_db_step_shapes` — canonical serv_* step shapes and filter rules
- `create_domain_example` — worked example injected into workflow design prompts

### Category D — System-Wide Constraints (→ `inject_always` or broad `inject_for`)

Rules that express invariants the entire system must honour regardless of context.

| Context Key | Rule | Status |
|---|---|---|
| `single_user_constraint` | No user_id, tenant_id, owner_id, created_by, sharing tables, permission tables | Exists; `inject_for` missing `design_table` |
| `llm_model_aliases` | Model alias map: smart, cheap, fast | Exists; injected at harness level, not via inject_for |

---

## 3. Migration Backlog — Rules to Move

Rules currently embedded in `prompt_text` that should migrate to system context. Ordered by impact (number of affected prompts).

### 3.1 Naming conventions — duplicated in 3 prompts

**Appears in:** `create_domain`, `design_table`, `revise_domain_schema`
**Move to:** new `pgd_naming_conventions` context row
**Action:** add `{{pgd_naming_conventions}}` placeholder in all three prompts; remove embedded text

### 3.2 Required columns — duplicated in 3 prompts

**Appears in:** `create_domain`, `design_table`, `revise_domain_schema`
**Move to:** new `pgd_required_columns` context row
**Action:** add `{{pgd_required_columns}}` placeholder in all three prompts

### 3.3 Column type rules — duplicated in 3 prompts, with a contradiction

**Appears in:** `create_domain`, `design_table`, `revise_domain_schema`
**Contradiction:** `create_domain` and `revise_domain_schema` say no precision specifiers (`numeric` not `numeric(10,2)`); `design_table` v7 now allows `numeric(p,s)` for decimal-constrained columns. The W2 fix (2026-06-14) introduced this divergence. The unified rule in `pgd_column_type_rules` above resolves it: `numeric(p,s)` is allowed (and required) when the column carries a decimal boundary constraint.
**Move to:** new `pgd_column_type_rules` context row
**Action:** add `{{pgd_column_type_rules}}` in all three prompts; remove embedded text; revert the W2 inline rule from `design_table` prompt_text

### 3.4 FK and constraint rules — duplicated in 3 prompts

**Appears in:** `create_domain`, `design_table`, `revise_domain_schema`
**Move to:** new `pgd_fk_constraint_rules` context row
**Action:** add `{{pgd_fk_constraint_rules}}` in all three prompts

### 3.5 Column default value format — in 1 prompt, broadly applicable

**Appears in:** `create_domain` only
**Move to:** new `pgd_default_value_format` context row
**Action:** add `{{pgd_default_value_format}}` in `create_domain`; add to `design_table` and `revise_domain_schema` as well (they have the same need, currently unaddressed)

### 3.6 single_user_constraint missing from design_table

**Currently:** injected into `create_domain`, `research_domain_schema`, `revise_domain_schema`
**Gap:** `design_table` is missing; a user could add user_id via design_table without the constraint firing
**Action:** add `"design_table"` to `single_user_constraint.inject_for`

### 3.7 Workflow gap taxonomy — duplicated in 2 prompts

**Appears in:** `analyze_and_design_workflow`, `analyze_workflow_gaps`
**Move to:** new `workflow_gap_taxonomy` context row
**Action:** add `{{workflow_gap_taxonomy}}` placeholder in both prompts

### 3.8 LLM model selection — duplicated in 2 prompts

**Appears in:** `analyze_and_design_workflow`, `analyze_workflow_gaps`
**Move to:** new `llm_model_selection_rules` context row
**Action:** add `{{llm_model_selection_rules}}` placeholder in both prompts

---

## 4. Rules That Stay in Prompts (confirmed prompt-local)

These were reviewed and confirmed as Category A — they describe that specific prompt's output contract and have no cross-prompt applicability:

- `create_domain`: 2–4 table generation rule, embed_source requirement on embedding columns, initial_value_conventions coverage requirements, apply research_findings/user_preferences instruction
- `design_table`: FK direction rule (grouping parent vs child), existing_table_modifications omit-if-empty
- `classify_intent_tier2`: action_type classification logic, workflow_name null rule
- `generate_crud_workflows`: exactly 5 intent map rows, fixed intent_category values, entity_name PascalCase, root_table detection, joins/aggregations structure
- `classify_workflow_intent`: operation_type enum, description verb-start rule
- `generate_workflow_mocks`: which step types to include/exclude, shape per step type
- `generate_workflow_paths`: path coverage requirements (happy/cancel/failure), per-outcome field rules
- `parse_entity_input`: root/children field sourcing, FK column exclusion, hierarchy length matching, self-referential parent field
- `research_workflow_domain`: mode-specific question constraints (read/write/enrich/analyze), 4-test filter
- `analyze_and_design_workflow`: mode A/B/C logic, forbidden output fields, `process_design` field whitelist
- `fix_workflow_steps`: complete array not diff, context_updates vs prompt_text_change decision rule
- `analyze_workflow_gaps`: `blocked_reason` apostrophe rule, `deferred` what/why/how_to_add structure
- `design_workflow_process`: revision mode handling, routing target validity
- `design_workflow_dialogs`: one entry per human_gate, reveal vs options distinction, action vs on_select distinction
- `generate_workflow_steps`: locked routing skeleton, correction mode (level1_applied), js_transform IIFE restrictions, Guard 1/Guard 3 (already in system context but repeated for clarity)
- `fix_workflow_routing`: fix routing fields only, smoke_test failure handling
- `research_domain_schema`: findings vs preference_questions mutual exclusion, validation gate
- `revise_domain_schema`: preserve unaffected tables, initial_value_conventions delta-only
- `generate_domain_aliases`: alias count, format rules, irregular plurals

---

## 5. Recommended Migration Order

Ordered by combined impact (rules fixed × prompts affected × risk of drift):

1. `pgd_column_type_rules` — resolves the active contradiction from W2 (3 prompts)
2. `pgd_naming_conventions` — highest duplication, clearest rule set (3 prompts)
3. `pgd_required_columns` — simple invariant, zero ambiguity (3 prompts)
4. `pgd_fk_constraint_rules` — frequently the source of generation errors (3 prompts)
5. `single_user_constraint` — extend inject_for to include `design_table` (1-line change)
6. `workflow_gap_taxonomy` — resolves duplication in workflow prompts (2 prompts)
7. `llm_model_selection_rules` — prevents model hallucination across workflow prompts (2 prompts)
8. `pgd_default_value_format` — lower duplication but high bug potential (1 prompt now, 3 eventually)
