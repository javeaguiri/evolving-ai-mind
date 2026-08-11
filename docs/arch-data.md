# Data Architecture — evolving-mind-ai
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture docs. Main overview: `docs/architecture.md`. See also: `docs/arch-step-types.md` (step type reference), `docs/arch-step-processor.md` (execution engine).

### 4.1 One PostgreSQL Instances, two login URLs

| Login URL | Purpose | Primary Use |
|---|---|---|
| PGC | Config / system tables | PGC_* tables — system metadata, workflow definitions, prompts |
| PGD | Domain / user data | PGD_* tables — user-created domain tables |

### 4.2 Naming Conventions and Bootstrap

**Naming:**
- System config tables: `PGC_*` (live in PGC database)
- User domain tables: `PGD_*` (live in PGD database)
- Table names are mixed case and MUST be quoted in SQL: `"PGC_Schema"`

**Bootstrap — `init-brain.mjs`**

`bootstrap()` is an **install-time HTTP handler**, not a cold-start routine.
It is called once during installation via `POST /api/v1/serv/bootstrap` and is
idempotent — safe to call again if needed. It is NOT called automatically on
Lambda cold start. Running bootstrap on cold start caused PostgreSQL
`tuple concurrently updated` errors when multiple Lambda containers initialised
simultaneously and raced to seed the same rows.

`serv/handler.mjs` routes `case 'bootstrap': return bootstrap(req)` — the
same one-line delegation pattern as all other SERV routes. `bootstrap(req)`
returns `ok()`/`err()` directly, following the established SERV handler pattern.

Bootstrap steps:
1. Install `set_updated_at()` trigger function on PGC and PGD
2. `CREATE TABLE IF NOT EXISTS` for all PGC system tables (from imported JSON templates)
3. Seed self-referential rows into `PGC_Schema` (`ON CONFLICT DO NOTHING`)
4. Seed gatekeeper rows into `PGC_TableMap` (`ON CONFLICT DO NOTHING`)
5. Seed `PGC_Workflow` rows for system workflows (`WHERE NOT EXISTS`)
6. Seed `PGC_IntentMap` rows (`WHERE NOT EXISTS ON intent_category`)
7. Seed `PGC_Prompt` rows for system workflows (`WHERE NOT EXISTS ON intent_category + version`)
8. Set `bootstrapComplete = true` — returns cached result on subsequent calls within same container

All seed operations use `WHERE NOT EXISTS` or `ON CONFLICT DO NOTHING` — never `DO UPDATE`.

Bootstrap template files live in `src/serv/templates/pgc/` and are imported as ES module
static imports — NOT read via `fs.readFile` at runtime.

### 4.3 PGC System Tables
#### 4.3.1 PGC Schema Registry Tables
##### PGC_Schema
Registry of ALL table definitions — both system (PGC) and user domain (PGD).
Every table in the system has a row here including the system tables themselves (self-referential).

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| table_name | text UNIQUE | Quoted in SQL |
| target | text | `pgc` or `pgd` |
| domain | text | ✦ Domain this table belongs to — e.g. `recipes`, `stock_portfolio`. NULL for system tables |
| description | text | |
| columns | jsonb | Array of ColumnDefinition |
| foreign_keys | jsonb | Array of ForeignKeyDefinition |
| constraints | jsonb | Array of ConstraintDefinition |
| triggers | jsonb | Array of TriggerDefinition |
| created_at | timestamptz | |
| updated_at | timestamptz | Auto-updated by trigger |

##### PGC_TableMap
SERV-Table security gatekeeper. SERV-Table rejects writes to any table not registered here.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| table_name | text UNIQUE | |
| target | text | `pgc` or `pgd` |
| domain | text | ✦ Mirrors `PGC_Schema.domain` — denormalised for gatekeeper queries without join |
| schema_id | integer FK | → PGC_Schema.id, ON DELETE RESTRICT |
| allow_insert | boolean | Default true |
| allow_update | boolean | Default true |
| allow_delete | boolean | Default false |
| views | jsonb | SQL view definitions |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_EntitySchema
Defines business entities that span multiple PGD tables.
SERV-Entity reads this to build `jsonb_agg` queries and execute entity-level DML.
Populated at runtime by `/create-domain`. Empty on fresh bootstrap.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| entity_name | text UNIQUE | e.g. "Recipe" |
| description | text | |
| root_table | text | Primary PGD table for the entity — e.g. `PGD_Recipes` |
| joins | jsonb | Array of EntityJoin — related tables to LEFT/INNER JOIN for read operations |
| aggregations | jsonb | Array of EntityAggregation — jsonb_agg columns to assemble in read results |
| filters | jsonb | Default row-level filters always applied to this entity |
| upsert_key | jsonb | ✦ Array of column names forming the natural unique key — e.g. `["ticker"]`. Empty array means upsert not supported. Must match an existing UNIQUE constraint on root_table |
| created_at | timestamptz | |
| updated_at | timestamptz | Auto-updated by trigger |

##### PGC_DomainHelp
User-facing command aliases and help text per domain.
Powers `/help {domain}` responses and Pass 2 domain alias matching in the Intent Preprocessor.
Populated at runtime by PROC when a domain is created. The `aliases` array is
human-reviewed and confirmed via a gate step in the `create_domain` workflow before
being written — aliases are not assumed from LLM output alone.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| domain | text UNIQUE | e.g. "recipes" |
| aliases | jsonb | e.g. ["recipe", "cooking"] — human-confirmed at domain creation |
| description | text | |
| commands | jsonb | Array of `{ syntax, description, workflow_id? }`. `workflow_id` (added Sprint 7 Track F3) is set on commands written by `create_workflow`'s registration step so `delete-workflow.mjs` can prune the matching entry when that workflow is deleted — falls back to matching on `description` for older entries with no `workflow_id`. The 5 generic CRUD command descriptions (`create_domain` step 18) append a multi-entity note listing real entity names whenever a domain has more than one root table (Track F2) — see `docs/arch-create-domain.md`. |
| embedding | vector | ✦ pplx-embed-v1-4b (2560-dim) of `domain + description + aliases`. Populated automatically by `insertRow` on domain creation — no backfill needed. Used by `semanticDomainMatch()` in `classify-intent-tiers.mjs`. PGD embedding columns use `vector(2560)`. **Changing the embedding model dimension requires updates in two places: `EMBEDDING_DIMENSION` in `embed-client.mjs` AND the `embedding_config` PGC_SystemContext row.** |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

#### 4.3.2 PGC Workflow Tables

These six tables support the PROC layer workflow execution engine.

##### PGC_Workflow
Stores reusable workflow definitions generated by LLM or created manually.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE | e.g. `deduct_inventory` |
| domain | text | Domain this workflow belongs to. NULL for system/cross-domain workflows |
| description | text | |
| intent_keywords | jsonb | Authoritative verb vocabulary for Pass 2 domain-workflow lookup — token-based scan in `matchWorkflowByKeywords()`. Data-driven: adding a verb here requires no code change. e.g. `["get","find","show","fetch","lookup"]` for `get_<domain>` workflows |
| intent_embedding | vector | For pgvector similarity matching (Backlog) |
| steps | jsonb | Array of StepDefinition (see Section 6.2) |
| state_strategy | text | `fire_and_forget`, `sequential`, `sequential_with_confirmation` |
| confirmation_required_at | jsonb | Step indices requiring human gate |
| js_extensions | jsonb | Optional sandboxed JS for complex steps (Option C) |
| model_used | text | Which LLM generated this workflow |
| quality_score | numeric | Human or auto-rated |
| max_execution_ms | integer | Guard 2 ceiling. NULL = use system default from PGC_SystemContext `guardrail_defaults` |
| max_steps_per_window | integer | Guard 1 threshold. NULL = use system default |
| window_seconds | integer | Guard 1 window duration. NULL = use system default |
| version | integer | |
| parent_workflow_id | integer FK | Self-referential — workflow evolution history |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_WorkflowRun
One row per workflow execution. Holds the execution stack, accumulated state,
callback routing, and runtime safety counters.

**`stack`/`input` can be large** (a workflow's full accumulated `local_state`,
including any bulk-pasted data). A single-row fetch by exact `id` is always
safe. A multi-row `getRows` call (`orderBy`, `limit`, an `in`/range filter)
with no `columns` list can return enough combined payload to exceed the 6MB
Lambda response limit or exhaust available memory — always pass an explicit
`columns` list for anything scanning more than one row of this table.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| workflow_id | integer FK | → PGC_Workflow.id |
| trace_id | text | Correlation ID carried end-to-end from Slack message through all hops. Replaces `workflowId` in SQS payloads |
| triggered_by | text | `slack`, `api`, `workflow`, `system` — who initiated this run |
| status | text | `pending`, `running`, `awaiting_confirmation`, `awaiting_human_gate`, `awaiting_llm_break`, `completed`, `failed`, `cancelled`. `awaiting_llm_break` = suspended for a developer at an `llm_call` seam (replay harness, `docs/arch-replay.md`) — distinct from `awaiting_human_gate` so a break for a developer is never mistaken for a gate for a user |
| input | jsonb | Original user intent + parameters |
| stack | jsonb | Execution stack — array of FrameDefinition (see Section 6.3). Controls frame flow only |
| state | jsonb | **Deprecated.** Previously mirrored `stack[top].local_state` on every write. Now written only at workflow completion (`{ local_state: finalState }`). Do not read or write `state.local_state` during execution — use `stack[top].local_state` directly |
| output | jsonb | Final workflow output — copied from `state` at completion |
| callback | jsonb | Provider-agnostic UI callback — `{ provider, channel, threadId }` |
| total_execution_ms | integer | Running sum of all step `duration_ms` values. Incremented in same UPDATE as stack write. Used by Guard 2 |
| step_count | integer | Total steps executed this run. Incremented in same UPDATE as stack write |
| steps_in_window | integer | Steps executed since last `human_gate` completion. Reset to 0 when a human_gate step completes. Used by Guard 1 |
| window_started_at | timestamptz | Timestamp when current velocity window started. Reset with `steps_in_window`. Used by Guard 1 |
| error | jsonb | Last error details |
| session_id | integer FK | ✦ → PGC_Session.id nullable — set when a Novia session triggers a sub-workflow run via `run_workflow` tool |
| replay_source_run_id | integer | Nullable, no FK — the run whose corpus + input this run replays (`docs/arch-replay.md` §7a). Not an FK: the source run is a corpus being read and may be deleted by replay cleanup |
| llm_break_policy | text | Nullable — `never` \| `on_miss` \| `always`; null ⇒ `never`. Read at the `llm_call` seam via `LOAD_RUN_COLUMNS`; drives replay/record break behaviour. Mutable at a break |
| started_at | timestamptz | |
| completed_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_WorkflowRunStep
Append-only audit log — one row per step execution attempt. Never updated after insert.
Used for idempotency checks on SQS redelivery and debugging.

**Same caution as `PGC_WorkflowRun`** — `input_snapshot`/`output_snapshot` hold
that step's resolved input/output and can be large for steps handling bulk
data. A multi-row scan without a `columns` list carries the same risk. The
idempotency check itself (`run-workflow.mjs:checkIdempotency`) only needs to
know whether a row exists — it passes `columns: ['id']`.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| run_id | integer FK | → PGC_WorkflowRun.id |
| frame_id | text | UUID of the frame that executed |
| step_number | integer | |
| step_type | text | |
| capability_key | text | → PGC_Capability.capability_key — which capability was exercised. NULL for built-in step types |
| status | text | `completed`, `failed`, `skipped` |
| retry_count | integer | Attempts before this final status. Default 0. Supports idempotency debugging |
| input_snapshot | jsonb | What was passed in |
| output_snapshot | jsonb | What came out |
| error | jsonb | Error details if failed |
| duration_ms | integer | |
| executed_at | timestamptz | |

##### PGC_Prompt
Stores LLM prompts with versioning and quality tracking for self-improvement.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| intent_category | text | e.g. `create_domain`, `design_table`, `create_workflow` |
| prompt_text | text | Actual prompt sent to LLM |
| input_variables | jsonb | Variables this prompt expects — `[{ name, description, required }]`. Documents contract for prompt improvement |
| output_schema | jsonb | Expected JSON shape of the LLM response. Used to validate output and guard downstream steps |
| output_sample | jsonb | Representative successful output stored on first clean run. Used for regression checking when prompt is evolved |
| probe_input | jsonb | ✦ Minimal substitution map for integration testing — mirrors the `input_variables` contract. Used by `llm-prompt-schema.test.mjs` to substitute template vars before firing the live LLM call |
| domain | text nullable | Domain this prompt belongs to (e.g. `flashcards`, `pantry`). NULL for system-level prompts shared across all domains. Set by `design_workflow_prompts` (P3). Deleted by `delete_domain` / `delete_workflow` via `deleteRows WHERE domain = ?` |
| model | text | Which LLM was used |
| max_output_tokens | integer | ✦ Per-prompt output token ceiling forwarded to `callLlm`. NULL = use LLM default |
| memory_config | jsonb | ✦ Controls memory retrieval for this prompt. `{ memory_budget_tokens, memory_types, scope_additions }`. NULL = no memory injection. `memory_budget_tokens: 0` disables memory. See §4.3.4 |
| version | integer | |
| parent_prompt_id | integer FK | Self-referential — prompt evolution history |
| was_successful | boolean | |
| quality_score | numeric | |
| error_log | jsonb | Structured: `{ attempts: [{ at, error_type, error_message, llm_raw_output, recovery_action }] }` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_IntentMap
Maps user input patterns to workflows or action types for the Intent Preprocessor.
Rows are seeded at bootstrap for system-level intents (still one joined-regex row per
intent_category, managed by `seed_PGC_IntentMap.json` + `upsert-intent-map.mjs`), and
written at runtime by `create_workflow` completion for user-defined workflows — **one
row per invocation phrase**, not a joined regex, so each phrase is individually
updatable/deletable (e.g. by Novia via `update_data`/`delete_data`) without reconstructing
a combined pattern string. `matchIntentMap` is agnostic to which model produced a row —
it iterates every row and regex-tests each `pattern` independently, so a joined-pattern
row and several single-phrase rows behave identically at match time.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| pattern | text | Regex or keyword pattern — single phrase for workflow-linked rows (e.g. `modify budget`); may still be a joined regex (e.g. `create.domain\|new.domain\|build.domain`) for system-seeded rows |
| intent_category | text | |
| workflow_id | integer FK | → PGC_Workflow.id (nullable — some intents are ad-hoc) |
| action_type | text | `crud`, `workflow`, `heavy_lift` |
| source | text | ✦ nullable — `user` (typed at the `create_workflow` invocation-phrases gate), `auto` (from `intent_keywords` or the truncated-userInput alias), `name` (the workflow's own name), or `NULL` (system-seeded / pre-migration rows, provenance not tracked) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**How PGC_IntentMap and PGC_DomainHelp divide the work:**

These two tables answer different questions and are consulted in a strict order by the Intent Preprocessor (see Section 6.3).

`PGC_IntentMap` answers: "Is this a known system-level or registered workflow intent?" — create domain, create workflow, help, or any user-defined workflow. Its patterns are written by developers (bootstrap seed) or by the brain itself when a new domain is created. `workflow_id` FK to `PGC_Workflow` is used for cleanup (e.g. `delete_domain`) — routing uses `action_type` + `intent_category` name lookup in `handoff()`. Pass 1 in the pipeline — always runs first.

`PGC_DomainHelp` answers: "Does the user's input mention something in their personal data?" — stocks, recipes, meals, budget. It has no FK to `PGC_Workflow` and no awareness of workflows. It only knows that "stocks", "portfolio", and "holdings" all mean `stock_portfolio`. Pass 2 in the pipeline — only consulted when no `PGC_IntentMap` pattern matched. Once a domain is resolved from `PGC_DomainHelp`, the preprocessor runs a workflow keyword scan against `PGC_Workflow.intent_keywords` for that domain, then falls back to CRUD detection or Tier 2.

The handoff is one-way and ordered: `PGC_IntentMap` always runs first. A match short-circuits — `PGC_DomainHelp` is never read.

**Intent Preprocessor tuning surface:**

When classification misbehaves, most fixes are now data changes — no code deploys required:

| Symptom | Which pass | Fix |
|---|---|---|
| System-level intent misrouted or missed | Pass 1 | Update `PGC_IntentMap.pattern` regex |
| Domain not recognised from user input | Pass 2 | Update `PGC_DomainHelp.aliases` for that domain |
| Domain workflow not triggered by natural phrasing | Pass 2 | Add verb to `PGC_Workflow.intent_keywords` for that workflow — no code change |
| Novel verb not recognised for any domain workflow | Pass 2 | Add verb to `PGC_Workflow.intent_keywords` — no code change |
| Structured `field=value` CRUD not detected | Pass 2 CRUD fallback | Update `matchCrudVerb()` in `classify-intent-tiers.mjs` |
| Domain resolved but correct workflow not matched | Pass 2 | Enrich `intent_keywords` across that domain's workflows |
| Novel phrasing reaches Tier 2 too often | Pass 2 (Backlog) | Populate `PGC_Workflow.intent_embedding` via pgvector — semantic match supersedes keyword scan |
| Aliases outdated after domain changes | Pass 2 | Phase 2 item 4c — `/mind edit aliases for <domain>` management workflow |

The alias management workflow (`/mind edit aliases for recipes`) is a Phase 2 item.
Until it exists, aliases can be updated directly in `PGC_DomainHelp` via the SERV table endpoint.

##### PGC_WorkflowRunLock
Reserved for future parallel execution — optimistic locking. NOT used in sequential mode.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| run_id | integer FK UNIQUE | → PGC_WorkflowRun.id, CASCADE |
| locked_by | text | Lambda request ID |
| locked_at | timestamptz | |
| version | integer | Incremented on every stack update |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

#### 4.3.3 PGC Intelligence Tables — LLM Runtime Context

These three tables exist solely to make the LLM effective at runtime.
They are injected into heavy-lift prompts by PROC before calling the LLM.
None of them affect workflow execution — they are read-only from the execution
engine's perspective.

##### PGC_SystemContext
Named context blocks injected into heavy-lift LLM prompts by `executeLlmCall` in
`step-executor.mjs`. Each matching row's `key` becomes a `{{key}}` substitution
variable in the prompt text. Managed via `dev_scripts/upsert-system-context.mjs`.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| key | text UNIQUE | Substitution variable name in prompt text — e.g. `routing_value_rules`, `step_type_contracts` |
| section | text | Groups related keys — `rules`, `examples`, `schema` |
| content | jsonb | Structured context object — see Content JSON Schema below |
| inject_always | boolean | If true, injected into every heavy-lift prompt regardless of intent. Default false |
| inject_for | jsonb | Array of `intent_category` values this row is injected for |
| version | integer | Incremented on every content update |
| created_at | timestamptz | |
| updated_at | timestamptz | |

> **Pending DDL:** `content` column is currently `text`. Migration to `jsonb` and drop of
> the `format` column are pending seed file rewrite. See DDL statement below.

**Live seed rows** (from `seed_PGC_SystemContext.json`):

| key | section | inject_for |
|---|---|---|
| `step_type_contracts` | `rules` | create_workflow, generate_workflow_steps, analyze_and_design_workflow, fix_workflow_steps |
| `routing_value_rules` | `rules` | create_workflow, generate_workflow_steps, generate_workflow_paths, fix_workflow_steps |
| `create_domain_example` | `examples` | create_workflow, analyze_and_design_workflow |
| `step_usage_patterns` | `rules` | analyze_and_design_workflow, fix_workflow_steps |
| `runtime_bindings` | `rules` | generate_workflow_steps, analyze_and_design_workflow |
| `template_syntax` | `rules` | generate_workflow_steps, analyze_and_design_workflow |
| `workflow_constraints` | `rules` | generate_workflow_steps, analyze_and_design_workflow, fix_workflow_steps |

**Content JSON Schema:**

Every `content` value must conform to this structure. The injection code serializes it
with `JSON.stringify` before substituting into prompt text — LLMs read structured JSON
natively, and this form is more concise than formatted prose.

```
{
  "title": "<optional top-level heading>",
  "sections": [
    {
      "id":        "<machine key — unique within this entry>",
      "heading":   "<display label>",
      "tags":      ["<step-type or context tag>"],
      "rules":     ["<rule or constraint string>"],
      "mistakes":  [{ "wrong": "<bad form>", "right": "<correct form>" }],
      "reference": [{ "key": "<term>", "value": "<definition>", "example": "<opt>" }],
      "data":      <free-form JSON — contracts array, taxonomy object, example>
    }
  ]
}
```

| Field | Required | Purpose |
|---|---|---|
| `sections` | yes | Array of addressable content sections |
| `sections[].id` | yes | Machine key — unique within the entry |
| `sections[].heading` | no | Human-readable label |
| `sections[].tags` | no | Inject-filter tags. Absent or empty = always inject |
| `sections[].rules` | no | Ordered list of rule/constraint strings |
| `sections[].mistakes` | no | Common error / correct-form pairs |
| `sections[].reference` | no | Key-value lookup table — tokens, bindings, syntax forms |
| `sections[].data` | no | Free-form structured data — contracts, taxonomy, examples |

A section may use any combination of the four body fields. At least one must be present.

**Section injection tags (Phase 2 design):**

Each section carries an optional `tags` array whose values are workflow step type names
or other context identifiers. When the injection code is updated to support tag-based
filtering, only sections whose `tags` overlap with the current prompt's `step_types_used`
will be included. Sections with absent or empty `tags` are always included.

- **Phase 1 (current):** all sections of every injected row are included regardless of tags.
- **Phase 2:** `step-executor.mjs executeLlmCall` receives `step_types_used` from the
  design step output and filters sections before serializing for prompt substitution.

Example — `workflow_constraints` with granular tags:

| Section id | tags | Included for serv_query+notify workflow |
|---|---|---|
| `step_array_structure` | (always) | ✓ |
| `notify` | `["notify"]` | ✓ |
| `condition` | `["condition"]` | — |
| `end` | (always) | ✓ |
| `human_gate` | `["human_gate"]` | — |
| `iterator` | `["iterator"]` | — |
| `serv_mutations` | `["serv_delete","serv_update"]` | — |
| `guard_3` | (always) | ✓ |
| `guard_1` | (always) | ✓ |

A simple `serv_query → notify → end` workflow receives 5 of 9 sections.
A complex workflow using all step types receives all 9.

**DDL migration — execute after all seed files are rewritten to JSONB format:**

```sql
-- 0. Verify every content value is valid JSON before running steps 1-2.
--    Any row returning 'invalid' must be fixed in the seed file and re-pushed first.
SELECT key,
       pg_typeof(content) AS current_type,
       CASE WHEN content::jsonb IS NOT NULL THEN 'valid' ELSE 'invalid' END AS json_check
FROM "PGC_SystemContext";

-- 1. Change content column from text to jsonb.
ALTER TABLE "PGC_SystemContext"
  ALTER COLUMN content TYPE jsonb USING content::jsonb;

-- 2. Drop the format column — no longer needed; content structure is self-describing.
--    Run after step 1 succeeds.
ALTER TABLE "PGC_SystemContext"
  DROP COLUMN format;

-- 3. Drop the check constraint that enforced format values (may already be gone with the column).
--    Run only if the constraint still exists after step 2.
ALTER TABLE "PGC_SystemContext"
  DROP CONSTRAINT IF EXISTS chk_format;
```

**Files to update before running the DDL:**

| File | Change |
|---|---|
| `src/serv/templates/pgc/PGC_SystemContext.json` | Change content type to jsonb, remove format column and chk_format constraint |
| `src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json` | Rewrite all 7 content fields as JSONB objects per the schema above |
| `dev_scripts/upsert-system-context.mjs` | Remove format from upsert payload and log output |

##### PGC_StepType
Canonical catalogue of all valid workflow step types with their input/output contracts.
Seeded on bootstrap. Injected into workflow generation and improvement prompts so the
LLM produces valid step definitions.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| step_type | text UNIQUE | e.g. `serv_query`, `llm_call`, `human_gate`, `js_transform`, `notify`, `end` |
| description | text | Human and LLM readable explanation of what this step does |
| input_contract | jsonb | Required and optional fields — `[{ field, type, required, description }]` |
| output_contract | jsonb | Fields produced — `[{ field, type, description }]`. NULL for steps with no output (e.g. `notify`) |
| on_success_options | jsonb | Valid values for `on_success` — e.g. `["next", "end", "step:N"]` |
| on_failure_options | jsonb | Valid values for `on_else` |
| requires_capability | text | → PGC_Capability.capability_key — NULL if always available |
| status | text | `live`, `planned`, `deprecated` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

##### PGC_Capability
Registry of what this system can do, including capabilities reached over the network.
Internal categories are injected into heavy-lift prompts so the LLM proposes only feasible
workflows and gives honest answers when asked for something not yet supported. Category
`external` describes a third-party service the system can invoke — **one row per operation**,
so a device or provider offering several operations is several rows.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| capability_key | text UNIQUE | e.g. `serv_table_insert`, `slack_notify`, `llm_agent_call`, `human_gate`, `js_transform` |
| category | text | `serv`, `notify`, `llm`, `ui`, `execution`, `external` |
| description | text | What this capability does — LLM readable |
| status | text | `live`, `planned`, `not_supported` |
| available_in | jsonb | Which Lambda functions expose this — e.g. `["proc", "serv"]` |
| notes | text | Constraints, limits, or caveats — e.g. `"js_transform requires security gate approval"` |
| endpoint | text | `external` only — absolute URL the operation is reached at |
| method | text | `external` only — `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| auth_ref | text | `external` only — **the SSM parameter NAME holding the credential, never the credential.** This table is readable by anything that can read PGC |
| input_schema | jsonb | `external` only — JSON Schema for the request body |
| output_schema | jsonb | `external` only — JSON Schema for the response |
| created_at | timestamptz | |
| updated_at | timestamptz | |

> **The five `external` columns exist in the template and in this registry, not in the running
> database.** Nothing writes them while `register_capability` and `call_capability` are stubbed.
> `createTableFromTemplate` uses `CREATE TABLE IF NOT EXISTS` and so cannot add a column to an
> existing table, while `seedPGCSchema` upserts — so **running bootstrap would make the registry
> assert columns the database lacks.** Add the columns physically at the same time as unstubbing
> invocation, and not before.

---

#### 4.3.4 PGC Memory Layer Table

##### PGC_Memory
Persistent memory store. Holds episodic, semantic, and procedural memories scoped by domain,
workflow, topic, or global. Written by `write_memory` workflow steps, the `save_to_memory`
hook on `llm_call` steps, and `MEMORY_WRITE` SQS fire-and-forget messages.
Retrieved and injected into LLM prompts by `llm-harness.mjs` based on scope and token budget.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| memory_type | varchar(20) NOT NULL | CHECK: `episodic` \| `semantic` \| `procedural` |
| scope | jsonb NOT NULL | Scope object — e.g. `{"domain":"flashcards"}` or `{"workflow":"quiz_flashcards"}`. Default `{}` = global |
| content | text NOT NULL | Memory content string. Token estimate pre-computed for budget-aware selection |
| tags | jsonb NOT NULL | Array of string tags — e.g. `["schema_snapshot","insert_expectations"]`. Default `[]` |
| priority | integer NOT NULL | Selection priority (lower = higher priority). Default 5. Range 1–10 |
| token_estimate | integer NOT NULL | `Math.ceil(content.length / 4)` — computed at write time. Default 0 |
| source_run_id | integer FK | → PGC_WorkflowRun.id, ON DELETE SET NULL. NULL for harness-driven writes |
| source_workflow | varchar(100) | Name of the workflow that produced this memory |
| source_step | varchar(50) | Step key that wrote this memory (NULL for MEMORY_WRITE path) |
| expires_at | timestamptz | NULL = never expires. Set for ephemeral episodic memories |
| embedding | real[] | Reserved for future vector search — not yet populated |
| created_at | timestamptz | |
| updated_at | timestamptz | Auto-updated by trigger |

**Indexes:** GIN on `scope` and `tags` (containment queries), btree on `memory_type` and `expires_at` (filtered).

**Three memory types:**

| Type | Content | Written by | Retrieved by |
|---|---|---|---|
| episodic | What happened — distilled activity log per domain workflow completion | `MEMORY_WRITE` SQS path (`memory-writer.mjs`); `save_to_memory` on `create_domain` step 10 | `/chat` companion (Sprint 5) |
| semantic | What was decided — design facts, schema expectations, initial-value conventions | `create_domain` step 16c (`write_memory`); `save_to_memory` on steps 12b, 13, 17b | `create_workflow` LLM calls, `parse_entity_input` (400-token budget) |
| procedural | Why a workflow works the way it does — design intent at generation time | `save_to_memory` on `generate_workflow_steps` step 23 | `fix_workflow`, `troubleshoot_workflow` |

**`PGC_Prompt.memory_config` controls retrieval per prompt:**
```json
{ "memory_budget_tokens": 600, "memory_types": ["semantic"], "scope_additions": { "domain": "{{input.domain}}" } }
```
`memory_budget_tokens: 0` or NULL `memory_config` disables memory injection for that prompt.
Scope additions support `{{template}}` tokens resolved against `run.input` at call time.

See `docs/arch-memory.md` for full design reference and `docs/architecture.md` §6.13.

---

#### 4.3.5 PGC Session Tables

Two tables supporting persistent LLM session context for general chat and LLM
call diagnostics. Full design, DDL, messages array reconstruction, and Slack command
flows are specified in `docs/arch-session.md`.

##### PGC_Session
One row per session, regardless of session type. Created at the start of any `/novia`, `/chat`,
or `/explain` command, or by the `llm_call` step handler when diagnostics are enabled
for the current workflow.

```sql
CREATE TABLE "PGC_Session" (
  id                    SERIAL PRIMARY KEY,
  session_type          VARCHAR(30)   NOT NULL,   -- 'minds_eye' | 'general_chat' | 'llm_call_diagnostic'
  query_id              UUID          NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  slack_thread_ts       VARCHAR(50)   NULL,        -- session lookup key (Slack thread_ts)
  workflow_name         VARCHAR(100)  NULL,        -- llm_call_diagnostic: PGC_Workflow.name
  run_id                UUID          NULL,        -- llm_call_diagnostic
  trace_id              VARCHAR(100)  NULL,        -- llm_call_diagnostic; matches Slack trace
  step_id               VARCHAR(50)   NULL,        -- llm_call_diagnostic: workflow step ID
  intent_category       VARCHAR(100)  NULL,        -- llm_call_diagnostic
  minds_eye_turn_count  INTEGER       NOT NULL DEFAULT 0,  -- turns consumed in this Novia session
  minds_eye_action_count INTEGER      NOT NULL DEFAULT 0,  -- write-tool actions consumed
  request_fingerprint   JSONB         NULL,        -- replay harness: component hashes of the assembled request
  fingerprint_hash      TEXT          NULL,        -- replay harness: composite lookup key (indexed)
  response_source       TEXT          NULL,        -- replay harness: 'live' | 'replayed' | 'recorded'
  replayed_from_session_id INTEGER    NULL,        -- replay harness: which recording was served (provenance)
  created_at            TIMESTAMP     NOT NULL DEFAULT NOW()
);
```

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| session_type | varchar(30) NOT NULL | `minds_eye` \| `general_chat` \| `llm_call_diagnostic` |
| query_id | uuid UNIQUE NOT NULL | User-facing reference; appears in Slack diagnostic notifications and is the `/explain` argument |
| slack_thread_ts | varchar(50) NULL | Session follow-up lookup key (Slack thread_ts); used by Novia thread continuation and /chat |
| workflow_name | varchar(100) NULL | `llm_call_diagnostic` only: `PGC_Workflow.name` — stored without ID join for readability |
| run_id | uuid NULL | `llm_call_diagnostic` only |
| trace_id | varchar(100) NULL | `llm_call_diagnostic` only; consistent with trace shown in Slack replies |
| step_id | varchar(50) NULL | `llm_call_diagnostic` only |
| intent_category | varchar(100) NULL | `llm_call_diagnostic` only |
| minds_eye_turn_count | integer NOT NULL DEFAULT 0 | ✦ `minds_eye` sessions only — reasoning turns consumed; compared against `minds_eye_preferences.turn_limit` |
| minds_eye_action_count | integer NOT NULL DEFAULT 0 | ✦ `minds_eye` sessions only — write-tool actions consumed; compared against `minds_eye_preferences.max_actions_per_session` |
| request_fingerprint | jsonb NULL | Replay harness (`docs/arch-replay.md` §3) — the seven per-component request hashes (`prompt`, `input`, `user_input`, `model`, `schema`, `memory`, `system_context`), plus two diagnostic per-key size+hash maps used only for the drift report: `input_keys` (A6) and `local_state_keys` (A6 local_state diff). Both are excluded from the composite (`fingerprint_hash`), so recordings predating them keep matching. `llm_call_diagnostic` sessions |
| fingerprint_hash | text NULL | Composite of the component hashes — the corpus lookup key. Indexed |
| response_source | text NULL | `live` \| `replayed` \| `recorded` — where this call's response came from |
| replayed_from_session_id | integer NULL | Provenance — the `PGC_Session.id` whose recording was served on a replayed call |
| created_at | timestamp | |

Indexes: `(slack_thread_ts)`, `(query_id)`, `(run_id)`, `(fingerprint_hash)`

**`chk_pgc_session_type` constraint:** `session_type IN ('minds_eye', 'general_chat', 'llm_call_diagnostic')`
**`chk_pgc_session_response_source` constraint:** `response_source IS NULL OR response_source IN ('live', 'replayed', 'recorded')`

**Field rules:** `minds_eye_turn_count` and `minds_eye_action_count` are only meaningful for `minds_eye` sessions. `llm_call_diagnostic` fields are NULL for other session types.

##### PGC_SessionEntry
One row per turn in the conversation. Reconstructs the LLM messages array by ordering
on `sequence_number`. Append-only — never updated after insert.

```sql
CREATE TABLE "PGC_SessionEntry" (
  id              SERIAL PRIMARY KEY,
  session_id      INTEGER       NOT NULL REFERENCES "PGC_Session"(id),
  sequence_number INTEGER       NOT NULL,          -- 1-based; preserves messages array order
  role            VARCHAR(15)   NOT NULL,          -- 'system' | 'user' | 'assistant' | 'tool'
  content         TEXT          NOT NULL,          -- raw message content sent/received
  reasoning       TEXT          NULL,              -- populated on 'assistant' rows only for diagnostic sessions
  compressed      BOOLEAN       NOT NULL DEFAULT FALSE,  -- true when this entry has been summarised for context compression
  created_at      TIMESTAMP     NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence_number)
);
```

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| session_id | integer FK NOT NULL | → PGC_Session.id |
| sequence_number | integer NOT NULL | 1-based; UNIQUE per session; drives messages array order |
| role | varchar(15) NOT NULL | `system` \| `user` \| `assistant` \| `tool` — `tool` rows store Novia tool call results in the reasoning transcript |
| content | text NOT NULL | Raw message content sent to or received from the LLM |
| reasoning | text NULL | Diagnostic metadata — populated on `assistant` rows; **never** included in the reconstructed messages array |
| compressed | boolean NOT NULL DEFAULT FALSE | ✦ When `true`, this entry's content has been summarised into a later compression entry and is excluded from the active context window |
| created_at | timestamp | |

**`chk_pgc_sessionentry_role` constraint:** `role IN ('system', 'user', 'assistant', 'tool')`

**Messages array reconstruction:**
```sql
SELECT role, content
FROM "PGC_SessionEntry"
WHERE session_id = $1
ORDER BY sequence_number ASC;
```
`reasoning` is excluded — it is diagnostic metadata, not conversation context.

**Sequence conventions:**
- `general_chat`: seq 1 = `system` (system prompt from `PGC_SystemContext.general_chat_system_prompt`), seq 2 = first `user` turn, seq 3 = `assistant` reply; subsequent turns append
- `llm_call_diagnostic`: seq 1 = `user` (filled-in prompt), seq 2 = `assistant` (raw LLM response); follow-up `/explain` turns append from seq 3

---

#### 4.3.6 PGC_WorkflowStats — SQL View

Not a physical table. Queried by PROC only when building LLM prompts for workflow
evaluation or improvement. Not on the execution hot path — guards operate on
`PGC_WorkflowRun` columns updated in-transaction with the stack write.
Registered in `PGC_TableMap.views` on the `PGC_WorkflowRun` row.
```sql
CREATE OR REPLACE VIEW "PGC_WorkflowStats" AS
SELECT
  workflow_id,
  COUNT(*)                                             AS run_count,
  COUNT(*) FILTER (WHERE status = 'failed')            AS failure_count,
  COUNT(*) FILTER (WHERE status = 'completed')         AS success_count,
  COUNT(*) FILTER (WHERE status = 'cancelled')         AS cancelled_count,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'failed')::numeric
    / NULLIF(COUNT(*), 0) * 100, 1
  )                                                    AS failure_rate_pct,
  MAX(created_at)                                      AS last_run_at,
  (ARRAY_AGG(status ORDER BY created_at DESC))[1]      AS last_status,
  AVG(total_execution_ms)
    FILTER (WHERE status = 'completed')                AS avg_execution_ms
FROM "PGC_WorkflowRun"
GROUP BY workflow_id;
```

---

#### 4.3.7 PGC Design Registry Tables

Two tables holding workflow design knowledge as retrievable rows rather than as prose inside
design prompts, so a pattern is loaded only when it is selected. Design reference:
`docs/arch-minds-eye.md` §12.3 and §12.9.

They compose rather than classify: an **archetype** is a procedure — what a workflow does, with
a verb, a topology, and slots — and declares named interaction points in that topology. A
**dialog strategy** is how the user interacts at one such point. One archetype's points may be
filled by several different strategies, and one strategy plugs into unrelated archetypes, which
is why they are two tables and not one table with a `kind` discriminator.

> **Not yet bootstrapped.** Both templates and seeds are committed on `design/archetype-registry`
> and wired into `init-brain.mjs`, but no live instance has run `POST /api/v1/serv/bootstrap`
> since. Seed rows are `status: 'draft'` and no consumer reads them.

##### PGC_Archetype

Procedures. Retrieved by semantic match on `aliases`, then filtered by `preconditions`.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE NOT NULL | Stable snake_case identifier |
| description | text | One line — the shape of workflow this describes |
| aliases | jsonb NOT NULL `'[]'` | Retrieval vocabulary — the only column reaching the embedding |
| preconditions | jsonb NOT NULL `'{}'` | Machine-checkable applicability, so matching is not purely semantic — e.g. the source table carries a self-referential FK |
| slots | jsonb NOT NULL `'[]'` | Declared **data** bindings: `[{ name, type, resolved_from, required }]` — table, columns, labels, ceilings |
| interaction_points | jsonb NOT NULL `'[]'` | The named holes in `topology` where the user interacts. One entry per point: name, what is being decided, which slot supplies its data. A `PGC_DialogStrategy` row fills one |
| topology | jsonb NOT NULL `'[]'` | Step skeleton — `step_label`, `step_type`, routing fields, slot tokens, interaction points as holes rather than specified gates. Same shape as the `routing_skeleton` built during workflow generation |
| design_rules | text | Archetype-scoped guidance, injected **only** when this archetype is selected |
| source_workflow | text | Provenance — the specimen it was derived from |
| status | text NOT NULL `'draft'` | CHECK `draft` / `live` / `retired` |
| version | integer NOT NULL `1` | |
| created_by | text NOT NULL `'seed'` | `seed` or `novia` |
| embedding | vector | ✦ `embed_source: ["aliases"]`. `resolveEmbedding` uses array-type source fields only, so `aliases` must carry the retrieval terms — listing `name` or `description` would be inert |
| created_at / updated_at | timestamptz | `set_updated_at()` trigger |

##### PGC_DialogStrategy

Dialog strategies. Same registry and retrieval columns; differs where the two kinds of thing
differ — no `topology`, `slots` or `interaction_points`.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE NOT NULL | Stable snake_case identifier |
| description | text | One line — how the user interacts at one point |
| aliases | jsonb NOT NULL `'[]'` | Retrieval vocabulary — the only column reaching the embedding |
| applicability | jsonb NOT NULL `'{}'` | Machine-checkable bounds deciding whether this strategy is *feasible* against the live data — option count, field product against the gate field ceiling, hierarchy depth. Evaluated after row counts, so feasibility is computed rather than guessed |
| emits | jsonb NOT NULL `'{}'` | The gate shape produced: `gate_type`, plus the declared properties the experience layer reads to choose a widget (`option_source`, `ordered`) |
| design_rules | text | Strategy-scoped guidance, injected **only** when this strategy is selected |
| source_workflow | text | Provenance |
| status | text NOT NULL `'draft'` | CHECK `draft` / `live` / `retired` |
| version | integer NOT NULL `1` | |
| created_by | text NOT NULL `'seed'` | `seed` or `novia` |
| embedding | vector | ✦ `embed_source: ["aliases"]` |
| created_at / updated_at | timestamptz | `set_updated_at()` trigger |

`preconditions` and `applicability` are the same kind of column answering different questions:
`preconditions` asks whether a procedure fits the *request* and is evaluated once per build;
`applicability` asks whether a strategy fits the *data at one point* and is evaluated once per
interaction point.

**Similarity threshold.** `PGC_DomainHelp` uses 0.40 for `pplx-embed-v1-4b`, calibrated against
domain nouns. Both tables' aliases describe workflow and interaction shapes instead, so each
needs its own calibration and neither should be assumed to carry over.

**Access.** No new endpoints — `getRows` with a `vectorSearch` descriptor against `embedding`
(vector columns are stripped from responses), and `insertRow` / `updateRows` for writes. Seeded
rows are maintained through `dev_scripts/upsert-archetype.mjs` and
`dev_scripts/upsert-dialog-strategy.mjs`, never by direct `updateRows`. Neither script writes
`embedding`: SERV computes it from `embed_source` on insert and on any update touching
`aliases`. Rows inserted before the column was populated need
`dev_scripts/backfill-embeddings.mjs`, which currently targets `PGC_DomainHelp` only.

---

#### 4.3.8 Updated PGC Table Count

| # | Table | Status |
|---|---|---|
| 1 | PGC_Schema | `domain` column added |
| 2 | PGC_TableMap | `domain` column added |
| 3 | PGC_EntitySchema | `upsert_key` column added |
| 4 | PGC_DomainHelp | aliases human-confirmed at domain creation (see Section 6.8) |
| 5 | PGC_Workflow | `domain`, `max_execution_ms`, `max_steps_per_window`, `window_seconds` added |
| 6 | PGC_WorkflowRun | `trace_id`, `triggered_by`, `state`, `total_execution_ms`, `step_count`, `steps_in_window`, `window_started_at` added; `session_id` nullable integer added Sprint 4; `replay_source_run_id`, `llm_break_policy` + `awaiting_llm_break` status added Sprint 8 (replay harness) |
| 7 | PGC_WorkflowRunStep | `capability_key`, `retry_count` added |
| 8 | PGC_Prompt | `input_variables`, `output_schema`, `output_sample`, `error_log`, `memory_config` added |
| 9 | PGC_IntentMap | written at runtime by create_workflow completion |
| 10 | PGC_WorkflowRunLock | unchanged |
| 11 | PGC_SystemContext | new |
| 12 | PGC_StepType | new |
| 13 | PGC_Capability | new |
| 14 | PGC_Memory | Sprint 3 — episodic/semantic/procedural memory store; GIN indexes on scope + tags; see §4.3.4 |
| 15 | PGC_Session | v3.2 — `general_chat` and `llm_call_diagnostic` sessions; see `docs/arch-session.md`. Sprint 8 — `request_fingerprint`, `fingerprint_hash` (indexed), `response_source`, `replayed_from_session_id` added (replay corpus, `docs/arch-replay.md`) |
| 16 | PGC_SessionEntry | v3.2 — per-turn messages array rows; `reasoning` column for diagnostic metadata |
| 17 | PGC_Archetype | Design registry — workflow procedures; see §4.3.7. **Committed, not yet bootstrapped** |
| 18 | PGC_DialogStrategy | Design registry — dialog strategies; see §4.3.7. **Committed, not yet bootstrapped** |
| — | PGC_WorkflowStats | SQL view — not a physical table |

**Total: 18 physical PGC tables (14 bootstrapped + 2 session added in v3.2 + 2 design registry
awaiting bootstrap) + 1 view**


---

#### 4.3.9 Dev Scripts — PGC Data Management

These scripts in `dev_scripts/` manage the authoritative data that drives the brain's
intelligence at runtime. They are not part of the Lambda deployment — they run locally
against the live PGC database to push, update, or export seed data.

All upsert scripts communicate via the SERV API — no direct DB connection required.
Set `SERV_API_URL` before running:

```cmd
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/<script>.mjs
```

All upsert scripts accept an optional name argument to target a single row:

```cmd
node dev_scripts/upsert-prompt.mjs generate_workflow_steps
node dev_scripts/upsert-workflow.mjs create_workflow
node dev_scripts/upsert-step-type.mjs js_transform
node dev_scripts/upsert-system-context.mjs create_domain_example
```

---

##### `upsert-prompt.mjs`

Pushes prompt definitions from `src/serv/templates/pgc/seeds/seed_PGC_Prompt.json`
into `PGC_Prompt`.

**When to run:** After any change to `seed_PGC_Prompt.json` — new prompts, version
bumps, output schema changes. Must be run before the new prompt version is active at
runtime, since the Step Processor loads prompts from the DB at execution time
(`ORDER BY version DESC LIMIT 1` per `intent_category`).

**Idempotency:** Computes a SHA-256 content fingerprint over `prompt_text`, `model`,
`output_schema`, and `input_variables` before every write. If the fingerprint matches
the highest-version DB row — no-op, prints "already current". If the DB version is
ahead of the seed version and content differs — skips the update and prints a pull
instruction; never overwrites a newer DB row with older seed content. Only the
highest-version seed entry per `intent_category` is deployed; older version entries
in the seed file are skipped with a warning to clean them up.

**When DB is ahead of seed:** run `pull-prompt.mjs <intent_category>` to pull the DB
content into the seed file, then verify with `git diff` before committing.

**Key behaviour:**
- Writes `prompt_text`, `output_schema`, `input_variables`, `model`, `version`
- `error_log` and `output_sample` are never written by this script — those are
  populated by the right-brain improvement loop (Backlog)

**Argument:** `intent_category` name — e.g. `upsert-prompt.mjs generate_workflow_steps`.
Omit to push all prompts in the seed file.

---

##### `upsert-workflow.mjs`

Pushes workflow definitions from `src/serv/templates/pgc/seeds/seed_PGC_Workflow.json`
into `PGC_Workflow`.

**When to run:** After any change to `seed_PGC_Workflow.json` — new workflows, step
changes, version bumps. Required on every fresh brain instance after `bootstrap` since
`init-brain.mjs` seeds with `ON CONFLICT DO NOTHING` and will not overwrite step
arrays that were already seeded.

**Argument:** A workflow `name` argument is **required** when targeting a specific
workflow — e.g. `upsert-workflow.mjs create_workflow`. Without an argument the script
upserts all workflows in the seed file. Prefer the targeted form on live systems to
avoid touching workflows that have active runs.

**Idempotency:** Computes a SHA-256 content fingerprint over `steps`, `description`,
and `model_used` before every write. If the fingerprint matches the current DB row —
no-op, prints "already current". Version is only incremented when a real content diff
is detected. Safe to re-run indefinitely without spurious version bumps.

**Key behaviour:**
- Writes `name`, `domain`, `description`, `intent_keywords`, `steps`, `state_strategy`,
  `model_used`, `version`
- Domain-generated workflows are written at runtime by `create_domain` — this script
  only manages system workflows (`create_domain`, `help`, `create_workflow`, and the
  five generic `*_entity` workflows)

---

##### `upsert-step-type.mjs`

Pushes step type definitions from `src/serv/templates/pgc/seeds/seed_PGC_StepType.json`
into `PGC_StepType`.

**When to run:** When a step type's contract changes — new input fields, corrected
description, status change from `planned` to `live`. Run before `upsert-system-context.mjs`
when adding a new step type, so the injected `step_type_contracts` context is current.

**Idempotency:** Update if exists, insert if not. Matches on `step_type`. Unlike prompts,
step type contracts are authoritative in the seed file and always overwrite live rows —
there is no right-brain improvement loop for step type contracts.

**What it seeds:** 16 live step types, each with `description`, `input_contract`,
`output_contract`, `on_success_options`, `on_failure_options`, and `status`. These
contracts are injected by `executeLlmCall` into `generate_workflow_steps` and
`analyze_and_design_workflow` so the LLM knows exactly what each step type accepts
and produces.

**Argument:** `step_type` name — e.g. `upsert-step-type.mjs js_transform`.
Omit to push all step types in the seed file.

---

##### `upsert-system-context.mjs`

Pushes key-value context rows from `src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json`
into `PGC_SystemContext`. These rows are injected by `executeLlmCall` into LLM prompts
at runtime based on the `inject_for` array on each row.

**When to run:** After any change to `seed_PGC_SystemContext.json` — updated worked
examples, new usage pattern rows, routing rule changes. Also run after adding a new
step type so `step_type_contracts` is regenerated.

**Idempotency:** `WHERE NOT EXISTS ON key` at bootstrap; update if exists at upsert time.
`init-brain.mjs` preserves live rows on fresh installs to protect right-brain improvements.
`upsert-system-context.mjs` always overwrites — use it to force content updates.

**Rows it manages:**

| Key | inject_for | Purpose |
|---|---|---|
| `step_type_contracts` | `generate_workflow_steps`, `analyze_and_design_workflow`, `create_workflow`, `fix_workflow_steps` | Full step type catalogue — injected so LLM knows the instruction set |
| `routing_value_rules` | `generate_workflow_steps`, `analyze_and_design_workflow`, `generate_workflow_paths`, `create_workflow`, `fix_workflow_steps` | Valid routing tokens and Guard 3 backward reference rule |
| `create_domain_example` | `generate_workflow_steps`, `analyze_and_design_workflow`, `create_workflow` | Annotated `create_domain` + flat loop quiz example — reference for correct step structure |
| `step_usage_patterns` | `generate_workflow_steps`, `analyze_and_design_workflow`, `fix_workflow_steps` | Concrete correct step definitions per type with common mistake notes |
| `runtime_bindings` | `generate_workflow_steps`, `analyze_and_design_workflow` | What the Step Processor injects automatically: `input.*`, `item`, `output_key` lifecycle per gate type, `local_state` in expressions |
| `template_syntax` | `generate_workflow_steps`, `analyze_and_design_workflow` | `{{key}}`, `{{key.field}}`, `{{key.0.field}}`, `{{input.field}}` — resolution rules and silent-empty-on-miss behaviour |
| `workflow_constraints` | `generate_workflow_steps`, `analyze_and_design_workflow`, `fix_workflow_steps` | Structural rules: `end` required, `notify` no on_else, Guard 3, Guard 1 stuck-step detection |

**Argument:** `key` name — e.g. `upsert-system-context.mjs create_domain_example`.
Omit to push all rows in the seed file.

**Run order when adding a new step type:**
```cmd
node dev_scripts/upsert-step-type.mjs <new_step_type>
node dev_scripts/upsert-system-context.mjs step_type_contracts
```

---

##### `pull-prompt.mjs`

Pulls the highest-version `PGC_Prompt` row for one or more `intent_category` values
from the DB and writes the result directly into `seed_PGC_Prompt.json`, replacing all
existing entries for that category with the single authoritative DB row.

**When to run:** When the DB is ahead of the seed file — after a prompt is improved
by the self-healing pipeline or manually patched in the DB without updating the seed.
This is the reverse of `upsert-prompt.mjs` — it syncs DB → seed.

**Workflow:**
```cmd
node dev_scripts/pull-prompt.mjs <intent_category>
git diff src/serv/templates/pgc/seeds/seed_PGC_Prompt.json
node dev_scripts/upsert-prompt.mjs <intent_category>
git commit
```

**Encoding:** `JSON.stringify` produces `\uXXXX` for all non-ASCII characters.
This is the project-standard encoding for seed JSON files — git-stable, immune to
round-trip drift, no Slack display difference (decoded identically at render time).

**Argument:** `intent_category` name. Omit to pull all categories found in the seed file.

---

##### `extract-run-data.mjs`

CLI tool for inspecting JSON data files — particularly `PGC_WorkflowRun` state
snapshots saved from curl responses or the run analysis workflow.

**Usage:**
```cmd
node dev_scripts/extract-run-data.mjs <file> <dot.path> [--raw]
node dev_scripts/extract-run-data.mjs run-245.json right_brain_research
node dev_scripts/extract-run-data.mjs run-245.json preference_questions.question
node dev_scripts/extract-run-data.mjs run-245.json confidence --raw
```

Path matching is **relative and depth-first** — the document is searched recursively
for every node where the path applies. Intermediate arrays are fanned out automatically;
`[]` bracket notation is accepted but not required. Multiple matches return as a JSON
array; a single match returns unwrapped. `--raw` suppresses formatting for pipe use.

Save analysis files to `dev_scripts/data/` (gitignored). Primary use: inspect Phase 1
research outputs to evaluate `research_workflow_domain` question quality across runs.

--- â€” SERV

### 5.1 SERV-Schema (complete)
DDL executor and PGC metadata registry.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/schema/createTable` | POST | Execute DDL + register in PGC_Schema + PGC_TableMap |
| `/api/v1/serv/schema/listTables` | POST | List entries from PGC_Schema, optional target filter |
| `/api/v1/serv/schema/listPhysicalTables` | POST | Query `information_schema.tables` for physical PGD tables; cross-references PGC_Schema to flag unregistered tables (`registered: bool`) |
| `/api/v1/serv/schema/getTable` | POST | Get one entry by tableName |
| `/api/v1/serv/schema/updateTable` | POST | Update metadata in PGC_Schema (NOT ALTER TABLE) |
| `/api/v1/serv/schema/deleteTable` | POST | DROP TABLE + remove from PGC_Schema + PGC_TableMap |
| `/api/v1/serv/schema/dropColumn` | POST | ALTER TABLE ... DROP COLUMN (**RESTRICT, never CASCADE**) + `pruneColumnRefs` clears every `constraints` / `foreign_keys` entry referencing the column. **Refuses with 409 when a view depends on the column** — CASCADE would delete the view silently and leave `PGC_Schema` advertising it (this happened: Sprint 7 session 18). Rewrite dependent views first. |
| `/api/v1/serv/schema/modifyConstraint` | POST | Add a named CHECK, or replace its expression if one of that name exists. **Upserts** `PGC_Schema.constraints` — appends when new. A CHECK the DB enforces but the registry omits is invisible to `domain_schema`, so `design_workflow_process`/`design_workflow_prompts` never see the enum and generated workflows keep emitting values the DB rejects. |
| `/api/v1/serv/schema/dropConstraint` | POST | Drop a named constraint from a PGD table (DDL + PGC_Schema sync). Accepts any constraint type. Wired into Novia `propose_schema_fix` tool. |

> **`target` is never supplied by the caller** on `dropColumn` / `modifyColumn` / `modifyConstraint` / `dropConstraint` — it is read from `PGC_Schema`. A correctness requirement only a technical caller would know is a bug, not a contract.

Security gate on `createTable`:
- Column types validated against whitelist (serial, text, integer, jsonb, timestamptz, etc.)
- Table names must match `^(PGC|PGD)_[A-Za-z][A-Za-z0-9_]*$`
- Protected system tables (`PGC_Schema`, `PGC_TableMap`, `PGC_EntitySchema`, `PGC_DomainHelp`) cannot be dropped

### 5.2 SERV-Table (complete)
DML executor gated by `PGC_TableMap`. All four operations live.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/table/getRows` | POST | Parameterised SELECT — filters, orderBy, limit |
| `/api/v1/serv/table/insertRow` | POST | Single INSERT RETURNING * — gated by `allow_insert` |
| `/api/v1/serv/table/updateRows` | POST | Parameterised UPDATE RETURNING * — gated by `allow_update` |
| `/api/v1/serv/table/deleteRows` | POST | Parameterised DELETE — gated by `allow_delete` |

Security gate on all operations:
- Table must be registered in `PGC_TableMap`
- Column names validated against `PGC_Schema.columns` for that table
- Filter operators validated against whitelist (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `is_null`, `not_null`, `jsonb_contains` — PostgreSQL `@>` containment, `jsonb_contained_by` — PostgreSQL `<@` containment; both require value to be a JSON object or array)
- `updateRows` and `deleteRows` require non-empty `filters` — unfiltered mass writes rejected at 400
- `allow_insert`, `allow_update`, `allow_delete` checked per-table from `PGC_TableMap`

**PGC_TableMap defaults:**
- PGC system tables: `allow_insert` varies, `allow_update: true`, `allow_delete: false`
- PGD domain tables: `allow_insert: true`, `allow_update: true`, `allow_delete: true`

`SERV-Table` is used by PROC for all **system config** operations (e.g. `PGC_WorkflowRun`, `PGC_Prompt`).
User domain data operations go through `SERV-Entity` instead.

### 5.3 SERV-Entity (complete)
User-facing domain data layer. Callers use entity names (`Recipe`, `Stock`) — never table names.
`PGC_EntitySchema` defines the `root_table`, `joins`, `aggregations`, `upsert_key`, and default `filters` for each entity.
Used by PROC when executing workflow steps that read or write user domain data.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/serv/entity/getEntity` | POST | Fetch one entity by id — with configured joins and jsonb_agg aggregations |
| `/api/v1/serv/entity/listEntities` | POST | List entities — filters, orderBy, limit — entity default filters always applied |
| `/api/v1/serv/entity/createEntity` | POST | INSERT root row — system cols (id, created_at, updated_at) stripped automatically |
| `/api/v1/serv/entity/updateEntity` | POST | UPDATE root row — `patch` (default) or `replace` mode — children unaffected |
| `/api/v1/serv/entity/upsertEntity` | POST | INSERT ... ON CONFLICT DO UPDATE — requires `upsert_key` defined in PGC_EntitySchema |
| `/api/v1/serv/entity/deleteEntity` | POST | DELETE root row — CASCADE handles children via FK — gated by `allow_delete` |

**Design decisions:**
- Entity operations only touch the root table. Child rows (e.g. `RecipeIngredient`) are managed
  via their own `createEntity` / `deleteEntity` calls with the parent `id` provided explicitly.
- `updateEntity patch` — sets only provided fields, leaves all others unchanged.
- `updateEntity replace` — sets ALL non-system fields from provided data, resetting omitted fields to null.
  Use when replacing an entire entity (e.g. new recipe version) while preserving `id` and child FK relationships.
- `upsertEntity` uses `xmax = 0` to detect true INSERT vs UPDATE without a second DB round-trip.
  `wasInserted: true/false` returned in response.
- `upsert_key` must correspond to an existing `UNIQUE` constraint on the physical root table.
  `/create-domain` is responsible for setting both the DDL constraint and the `upsert_key` together.

**Tier separation:**
- `SERV/table` — system config operations on PGC tables. Used by PROC for workflow state, prompts, etc.
- `SERV/entity` — user domain data operations on PGD tables. Used by PROC for workflow step execution.

### 5.4 SERV services — not yet built
- **SERV-Query** — cross-entity parameterised SELECT with pagination (Backlog)

---

### 5.5 Curl Cookbook

All examples use env vars exported in `.bashrc` — use them directly, never read any `.env` file:
- `$SERV_API_URL` — SERV base URL (`https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod`)
- `$INTERNAL_API_KEY` — API key for PROC/SERV endpoints

#### Base pattern

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_Workflow" }'
```

#### SERV-Table — getRows filter operators

All `filters` arrays are ANDed. Omit `filters` to return all rows.

| Operator | Meaning | Example filter object |
|---|---|---|
| `eq` | equals | `{ "column": "name", "op": "eq", "value": "create_domain" }` |
| `neq` | not equals | `{ "column": "status", "op": "neq", "value": "completed" }` |
| `like` | SQL LIKE (use `%` wildcard) | `{ "column": "name", "op": "like", "value": "%entity%" }` |
| `gt` / `gte` | greater than / ≥ | `{ "column": "id", "op": "gt", "value": "100" }` |
| `lt` / `lte` | less than / ≤ | `{ "column": "version", "op": "lte", "value": "3" }` |
| `in` | value in list | `{ "column": "status", "op": "in", "value": ["running", "awaiting_human_gate"] }` |
| `is_null` | IS NULL | `{ "column": "domain", "op": "is_null" }` |
| `not_null` | IS NOT NULL | `{ "column": "domain", "op": "not_null" }` |
| `jsonb_contains` | JSONB `@>` containment — row's column contains value | `{ "column": "scope", "op": "jsonb_contains", "value": { "domain": "flashcards" } }` |
| `jsonb_contained_by` | JSONB `<@` containment — row's column is contained by value (inverse of `jsonb_contains`) | `{ "column": "scope", "op": "jsonb_contained_by", "value": { "domain": "flashcards", "workflow": "add_entity" } }` |

Optional fields on any `getRows` call: `"orderBy"`, `"limit": N`, `"columns": ["col1", "col2"]` (projects the SELECT list instead of `*` — see the `PGC_WorkflowRun`/`PGC_WorkflowRunStep` caution above for when this is required, not just an optimization).

**`orderBy` — one sort term or several.** `listEntities` accepts the same forms.

| Form | Example |
|---|---|
| SQL string | `"orderBy": "priority DESC"` |
| Object | `"orderBy": { "column": "priority", "direction": "desc" }` |
| Composite, SQL string | `"orderBy": "priority DESC, id ASC"` |
| Composite, array | `"orderBy": [{ "column": "priority", "direction": "desc" }, { "column": "id", "direction": "asc" }]` |

Every column is validated against the table's registered schema, whichever form is used. `direction` defaults to `asc`.

**Add a trailing term on a unique column whenever the leading column can tie and `limit` is set.** Postgres guarantees no order within a tied group, so the `limit` cuts it at an arbitrary point and identical queries can return different rows. `PGC_Memory` ordered by `priority` is the live case — a large share of its rows carry the same priority, so a small `limit` draws an arbitrary subset of them.

#### Common PGC admin queries

**List all workflows (names and domains):**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_Workflow", "orderBy": "name ASC" }'
```

**Get one workflow by name:**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_Workflow", "filters": [{ "column": "name", "op": "eq", "value": "create_domain" }] }'
```

**Get recent runs (all statuses) — `columns` required, see caution above:**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_WorkflowRun", "orderBy": "id DESC", "limit": 10, "columns": ["id", "workflow_id", "status", "triggered_by", "created_at"] }'
```

**Get one run by id:**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_WorkflowRun", "filters": [{ "column": "id", "op": "eq", "value": "458" }] }'
```

**Get all active / stuck runs:**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_WorkflowRun", "filters": [{ "column": "status", "op": "in", "value": ["running", "awaiting_human_gate"] }], "orderBy": "id DESC" }'
```

**Get a prompt by intent_category (latest version):**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_Prompt", "filters": [{ "column": "intent_category", "op": "eq", "value": "design_table" }], "orderBy": "version DESC", "limit": 1 }'
```

**List all IntentMap rows:**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_IntentMap", "orderBy": "id ASC" }'
```

**Get DomainHelp for a domain:**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_DomainHelp", "filters": [{ "column": "domain", "op": "eq", "value": "flashcards" }] }'
```

**Get memory rows by scope (jsonb_contains):**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_Memory", "filters": [{ "column": "scope", "op": "jsonb_contains", "value": { "domain": "flashcards" } }], "orderBy": "priority ASC" }'
```

**List all registered table schemas:**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_Schema", "orderBy": "table_name ASC" }'
```

**Get steps for a run (audit log):**
```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/getRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_WorkflowRunStep", "filters": [{ "column": "run_id", "op": "eq", "value": "458" }], "orderBy": "id ASC" }'
```

#### SERV-Table — insertRow

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/insertRow" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_IntentMap", "row": { "pattern": "my pattern", "intent_category": "my_intent", "action_type": "workflow" } }'
```
Returns the inserted row. Never include `id`, `created_at`, or `updated_at` — they are auto-managed.

#### SERV-Table — updateRows

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/updateRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_WorkflowRun", "filters": [{ "column": "id", "op": "eq", "value": "458" }], "updates": { "status": "cancelled" } }'
```
`filters` is required — unfiltered updates are rejected at 400. Returns updated rows.

#### SERV-Table — deleteRows

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/table/deleteRows" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_IntentMap", "filters": [{ "column": "id", "op": "eq", "value": "42" }] }'
```
`filters` is required. `allow_delete` must be `true` for the table in `PGC_TableMap` (PGD tables: true by default; most PGC tables: false).

#### SERV-Entity — listEntities

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/entity/listEntities" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "entityName": "Recipe", "filters": [{ "column": "name", "op": "like", "value": "%potato%" }], "limit": 20 }'
```
`entityName` is the PascalCase singular name from `PGC_EntitySchema.entity_name` (e.g. `Recipe`, `FlashcardDeck`). Returns root row + child arrays defined in `PGC_EntitySchema.aggregations`.

#### SERV-Entity — getEntity

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/entity/getEntity" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "entityName": "Recipe", "id": 42 }'
```

#### SERV-Schema — addColumn

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/schema/addColumn" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGC_Prompt", "column": { "name": "domain", "type": "text", "nullable": true } }'
```
Runs `ALTER TABLE` + updates `PGC_Schema.columns`. Use `"schemaOnly": true` to update PGC_Schema metadata without running DDL (e.g. to backfill `embed_source` on an existing vector column). The `column` field is a **nested object** `{ name, type, nullable }` — not flat fields.

#### SERV-Schema — listTables

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/schema/listTables" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "target": "pgd" }'
```
`target` accepts `"pgc"` or `"pgd"`. Omit to list all registered tables.

#### SERV-Schema — listPhysicalTables

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/schema/listPhysicalTables" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{}'
```
Returns all physical tables in `information_schema.tables` (PGD schema) with `registered: true|false` indicating whether each has a PGC_Schema row. Used by Novia for domain recovery.

#### SERV-Schema — dropConstraint

```bash
curl -s -X POST "$SERV_API_URL/api/v1/serv/schema/dropConstraint" -H "Content-Type: application/json" -H "x-api-key: $INTERNAL_API_KEY" -d '{ "tableName": "PGD_Budgets", "constraintName": "chk_budgets_amount" }'
```
Drops a named constraint (any type: CHECK, UNIQUE, FK) via `ALTER TABLE … DROP CONSTRAINT` and removes it from `PGC_Schema.constraints`. Wired into Novia `propose_schema_fix`.

---

