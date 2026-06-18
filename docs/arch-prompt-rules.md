# Prompt Rules Catalog and Placement Guide

This document is the authoritative guide for where rules live in the system. Read it before adding any rule to a prompt or system context entry. It also serves as the inventory of rules that should migrate from `PGC_Prompt.prompt_text` into `PGC_SystemContext`.

---

## 1. Decision Framework — Where Does a New Rule Go?

**The reusability test first:** would having this rule in one place prevent it from drifting across two or more prompts? If no — it stays in the prompt (Category A). If yes — continue to identify which category.

Ask these questions in order:

**Q1: Does this rule describe the output shape or format of this specific prompt?**
Yes → **Category A** (prompt-local). Stop.

**Q2: Must this rule be consistent across the handoff boundary between a right-brain research prompt and its left-brain design counterpart?**
Yes → **Category G** (cross-brain contract). The rule governs data shapes that both sides of an R→L pair must agree on.

**Q3: Is this a meta-rule about brain type — what left vs right brain may do, or which model follows from that?**
Yes → **Category F** (L/R Brain). Model selection is a consequence of brain type, not a standalone rule.

**Q4: Does this rule govern PostgreSQL schema or table design — types, constraints, naming, required columns?**
Yes → **Category B** (schema design). Applies to left-brain schema-producing prompts.

**Q5: Does this rule govern workflow step structure, routing tokens, step type contracts, or template syntax?**
Yes → **Category C** (workflow step definition). Applies to left-brain step-generating and step-fixing prompts.

**Q6: Does this rule govern human_gate design — gate types, option shape, on_select routing, reveal behaviour?**
Yes → **Category D** (human dialog design). Applies to left-brain gate-designing prompts.

**Q7: Does this rule govern workflow analysis — gap taxonomy, mode logic, analysis heuristics?**
Yes → **Category E** (workflow analysis). Applies to left-brain analysis and diagnostic prompts.

**The failure mode to avoid:** adding a rule directly to `prompt_text` when it expresses a principle that other prompts also need. That rule becomes invisible to those prompts, cannot be updated centrally, and will drift — producing contradictions that are only discovered at generation time.

### Design vs Implementation overlap

Many rules appear in both a design-phase prompt and an implementation-phase prompt (e.g. gap taxonomy in `analyze_and_design_workflow` and `analyze_workflow_gaps`; dialog rules in `design_workflow_dialogs` and `generate_workflow_steps`). The shared vocabulary belongs in a context entry; the per-phase behavior stays in the prompt.

**Rule:** context entries must be written as **definitions or contracts**, never as **procedures**.

- A definition answers "what does Type 3b mean?" — usable by any prompt regardless of phase.
- A procedure answers "when you find Type 3b, set confidence=needs_schema" — only valid in one prompt's context.

**The prompt-neutrality test:** could you show this context entry to someone without telling them which prompt they are working in, and would it still be useful? If yes — it is a genuine shared rule and belongs in a context entry. If the reader would ask "but am I the designer or the implementer?" — it is Category A for each prompt separately.

**Ownership beats coverage:** when a rule could fit two categories, put it in the category where related violations co-occur. FK name format belongs in `pgd_fk_constraint_rules` (not `pgd_naming_conventions`) because FK name errors appear alongside FK structure errors, not alongside table name errors.

**Partial extraction is valid:** if a context block is only partially shared, extract the shared structural part and leave the per-phase procedural part in each prompt. Do not force the whole block into a context entry to avoid a two-location split — a clean split is better than a context entry that is implicitly prompt-specific.

---

## 2. Categories

### Category A — Prompt-Local (stay in `prompt_text`)

Criteria: describes this prompt's specific output structure, field list, forbidden fields, output-format obligations, or input-handling logic that does not apply to any other prompt.

Confirmed prompt-local rules are listed in §4.

### Category B — Schema Design (left-brain schema prompts)

Criteria: PostgreSQL table and column design rules that must be consistent across all prompts that produce or modify PGD_ table definitions.

Target `inject_for`: `["create_domain", "design_table", "revise_domain_schema"]`

| Context Key | Status | Rule coverage |
|---|---|---|
| `pgd_naming_conventions` | **to create** | Table: PGD_ + PascalCase, no underscores after prefix. Trigger: `trg_<tablename_lower>_updated_at`. FK: `fk_<childtable_lower>_<parenttable_lower>`. Constraint: `uq_<table>_<cols>`, `chk_<table>_<col>`. Domain: snake_case. Embedding column always named `embedding`. |
| `pgd_required_columns` | **to create** | Every table: id (serial, primaryKey), created_at (timestamptz, not null, default now()), updated_at (timestamptz, not null, default now()), BEFORE UPDATE trigger `set_updated_at()`. |
| `pgd_column_type_rules` | **to create** | Allowed types enum (17 types). No length/precision specifiers by default (`varchar` not `varchar(255)`) **except**: columns with decimal boundary constraints (CHECK, >=, <= with decimal literals) must use `numeric(p,s)` — never `real` or `float`. No type aliases (`integer` not `int`). |
| `pgd_fk_constraint_rules` | **to create** | FK `column` field required. FK `references` always `{ "table": "PGD_...", "column": "id" }`. Constraint `type` lowercase (`unique`/`check`). Check key is `expression`. `onDelete: SET NULL` (not CASCADE) when adding FK to an existing table. |
| `pgd_default_value_format` | **to create** | Column `default` must be a valid SQL expression string. String literals need inner SQL single-quotes (`"'active'"` not `"active"`). Numeric/boolean/function values need no inner quotes (`"0"`, `"true"`, `"now()"`). |
| `single_user_constraint` | **exists** — extend `inject_for` to add `"design_table"` | No user_id, tenant_id, owner_id, created_by, sharing tables, permission tables, tenant_id, account_id. |

### Category C — Workflow Step Definition (left-brain step prompts)

Criteria: rules about step type contracts, routing tokens, template syntax, and structural constraints that apply to any prompt that generates, repairs, or analyses workflow steps.

Target `inject_for`: `["generate_workflow_steps", "fix_workflow_steps", "fix_workflow_routing", "analyze_and_design_workflow", "design_workflow_process"]`

All currently in system context (correctly placed):

| Context Key | Coverage |
|---|---|
| `step_type_contracts` | Full step type reference — input/output contracts and routing options for all 15 step types |
| `routing_value_rules` | Valid routing tokens per step type; condition step bare-key rule |
| `workflow_routing_rules` | 9 routing invariants: service failure → on_else cancel, condition bare keys, filter shape, etc. |
| `step_usage_patterns` | Correct/incorrect examples per step type |
| `runtime_bindings` | input.*, output_key lifecycle, iterator scope, local_state in js_transform |
| `template_syntax` | `{{key.path}}` forms, JSONPath wildcard, no Handlebars block syntax, single-pass only |
| `workflow_constraints` | Structural: end step last, Guard 1 (stuck-step), Guard 3 (backward reference safety) |
| `flat_loop_example` | Annotated quiz example; comma-separated output_key pattern |
| `serv_db_step_shapes` | Canonical serv_* step shapes and filter rules |
| `create_domain_example` | Worked example for workflow design prompts |

### Category D — Human Dialog Design (left-brain gate prompts)

Criteria: rules about human_gate structure, option shape, routing tokens specific to gates, and reveal behaviour. Apply to any prompt that designs or repairs human_gate steps.

Target `inject_for`: `["design_workflow_dialogs", "generate_workflow_steps", "fix_workflow_steps"]`

No dedicated context entries exist yet. Currently embedded in `design_workflow_dialogs` and `generate_workflow_steps` prompt_text:
- `gate_type` values and when to use each
- Every options array must end with a Cancel option
- `action` (UI label) vs `on_select` (routing token) are different fields
- `on_select` valid values: `"next"`, `"end"`, `"cancel"`, `"step:<label>"`
- `reveal`: UI display only — does not route; do not add a Show Answer button in options when reveal is used
- text_input gates: include `output_key` and `value` fields on the gate path

### Category E — Workflow Analysis (left-brain analysis prompts)

Criteria: rules about gap identification, mode logic, and analysis heuristics that apply to any prompt doing workflow feasibility or gap analysis.

Target `inject_for`: `["analyze_and_design_workflow", "analyze_workflow_gaps"]`

| Context Key | Status | Coverage |
|---|---|---|
| `workflow_gap_taxonomy` | **to create** | Type 1 (preference) → resolved by user_preferences, do not report. Type 2 (knowledge) → resolved by right-brain research, do not report. Type 3a (non-blocking schema gap) → schema_changes blocking=false. Type 3b (blocking schema gap) → schema_changes blocking=true + confidence=needs_schema. Type 4a (missing prompt) → prompts_needed exists=false + full prompt_text. Type 4b (missing step type) → confidence=blocked. |

### Category F — L/R Brain (meta-rule for all llm_call-producing prompts)

Criteria: rules about brain type classification and what follows from it. Model selection is a consequence of brain type, not a standalone rule. Category F governs what each brain type is permitted to do, which informs which other categories of context are appropriate to inject.

**Left-brain:** analytical, structured reasoning, deterministic output. Must follow schema contracts exactly. Produces structured JSON output. Model: `anthropic/claude-sonnet-4-5` (or `smart` alias). Appropriate categories to inject: B, C, D, E.

**Right-brain:** environmental awareness, research, surfacing content. May not make structural design decisions. Does not fabricate — surfaces real patterns, tradeoffs, and options. Model: `perplexity/sonar` (or `cheap`/`fast` alias). Appropriate categories to inject: G (the handoff contract only).

Right-brain prompts in the system: `research_domain_schema`, `research_workflow_domain`.
Left-brain prompts: all others.

| Context Key | Status | Coverage |
|---|---|---|
| `llm_model_aliases` | **exists** | Model alias map: smart → claude-sonnet-4-6, cheap/fast → perplexity/sonar. Resolved at harness level. |
| `llm_model_selection_rules` | **to create** (migrate from prompt_text) | `prompts_needed.model` in workflow design output must be `anthropic/claude-sonnet-4-5` (left-brain analytical step) or `perplexity/sonar` (right-brain research step) — never gpt-4, gpt-4o-mini, or any other model. Model choice expresses brain type assignment for that step. |

### Category G — Cross-Brain Contracts (R→L handoff pairs)

Criteria: data shape rules that must be consistent on both sides of a right-brain → left-brain handoff. Each entry targets exactly the research prompt and its consuming design prompt — not all schema prompts or all workflow prompts.

**The failure mode this prevents:** the right-brain prompt produces findings in one shape; the left-brain prompt expects a different shape. The mismatch is silent — the LLM adapts on consumption and the contract is never enforced.

`inject_for` is deliberately narrow — the two prompts in each R→L pair only.

| Context Key | Status | R prompt | L prompt(s) | Contract |
|---|---|---|---|---|
| `schema_research_contract` | **to create** | `research_domain_schema` | `create_domain`, `revise_domain_schema` | `findings[].{ label, description, tradeoffs }`. `preference_questions[].{ label, value, description }`. A topic in findings cannot also appear in preference_questions. |
| `workflow_research_contract` | **to create** | `research_workflow_domain` | `analyze_and_design_workflow` | `findings[].{ topic, recommendation, rationale }`. `preference_questions[].{ question, options[].{ label, value } }`. Research findings resolve Type 2 gaps — do not surface them to user. |

---

## 3. Migration Backlog — Rules to Move

Ordered by combined impact (prompts affected × risk of drift × active contradictions).

| # | Context key | Cat | Prompts affected | Notes |
|---|---|---|---|---|
| S1 | `pgd_column_type_rules` | B | create_domain, design_table, revise_domain_schema | Resolves active W2 contradiction. Revert inline rule added to design_table v7. |
| S2 | `pgd_naming_conventions` | B | create_domain, design_table, revise_domain_schema | Highest duplication, clearest rule set. |
| S3 | `pgd_required_columns` | B | create_domain, design_table, revise_domain_schema | Simple invariant, zero ambiguity. |
| S4 | `pgd_fk_constraint_rules` | B | create_domain, design_table, revise_domain_schema | Frequent source of generation errors. |
| S5 | `single_user_constraint` inject_for extension | B | design_table | One-line change to existing row. |
| S6 | `workflow_gap_taxonomy` | E | analyze_and_design_workflow, analyze_workflow_gaps | Duplicated verbatim. |
| S7 | `llm_model_selection_rules` | F | analyze_and_design_workflow, analyze_workflow_gaps | Reframe as brain type rule, not model name list. |
| S8 | `pgd_default_value_format` | B | create_domain → extend to design_table, revise_domain_schema | Lower duplication but high bug potential. |
| S9 | `schema_research_contract` | G | research_domain_schema, create_domain, revise_domain_schema | New — no current enforcement. |
| S10 | `workflow_research_contract` | G | research_workflow_domain, analyze_and_design_workflow | New — no current enforcement. |
| S11 | Category D dialog rules | D | design_workflow_dialogs, generate_workflow_steps, fix_workflow_steps | Extract gate design rules into dedicated context entry. |

---

## 4. Rules That Stay in Prompts (confirmed Category A)

Reviewed and confirmed prompt-local — output contract or input-handling logic with no cross-prompt applicability:

- `create_domain`: 2–4 table generation count, embed_source requirement on embedding columns, initial_value_conventions three-coverage rule, apply research_findings/user_preferences instruction
- `design_table`: FK direction rule (grouping parent vs child/detail), existing_table_modifications omit-if-empty
- `classify_intent_tier2`: action_type classification logic (crud/workflow/heavy_lift), workflow_name null rule — classification schemes differ from `classify_workflow_intent`, no shared rules
- `classify_workflow_intent`: operation_type enum (query/mutate/notify/mixed), description verb-start rule — prompt-local; intent classification prompts do not cross-pollinate
- `generate_crud_workflows`: exactly 5 intent map rows, fixed intent_category values (list_entity etc.), entity_name PascalCase, root_table detection, joins/aggregations structure
- `generate_workflow_mocks`: which step types to include/exclude, shape per step type
- `generate_workflow_paths`: path coverage requirements (happy/cancel/failure), per-outcome field rules
- `parse_entity_input`: root/children field sourcing, FK column exclusion, hierarchy length matching, self-referential parent_<match_key> field
- `research_workflow_domain`: mode-specific question constraints (read/write/enrich/analyze), 4-test filter for preference questions
- `analyze_and_design_workflow`: mode A/B/C logic, `process_design` field whitelist, forbidden output fields
- `fix_workflow_steps`: complete array not diff, context_updates vs prompt_text_change decision rule
- `analyze_workflow_gaps`: `blocked_reason` apostrophe rule, `deferred` what/why/how_to_add structure
- `design_workflow_process`: revision mode handling (apply feedback before generating output)
- `generate_workflow_steps`: locked routing skeleton, correction mode (level1_applied base), js_transform IIFE restrictions
- `fix_workflow_routing`: fix routing fields only — do not modify non-routing fields, smoke_test failure handling
- `research_domain_schema`: findings vs preference_questions mutual exclusion, per-output validation gate
- `revise_domain_schema`: preserve unaffected tables, initial_value_conventions delta-only rule
- `generate_domain_aliases`: alias count (6–12), format rules (1–3 words, lowercase), irregular plurals, no action verbs
