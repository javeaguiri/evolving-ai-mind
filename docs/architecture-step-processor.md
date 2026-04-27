# evolving-mind-ai — Architecture: Step Processor
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 3.2
Status: Active development — Session 29 complete
Last updated: 2026-04-27 (session 29 — callback.mjs: HUMAN_GATE / HUMAN_NOTIFICATION consolidation;
special_buttons field on human_gate steps; interactive.mjs placeholder fix;
seed_PGC_Workflow.json step 1a migrated to special_buttons)

**Architecture document set:**
- `architecture-core.md` — system overview, stack, Lambda tiers, SQS queues, data architecture, SERV layer, dev scripts
- `architecture-step-processor.md` — this file: Step Processor execution engine: step types, stack, local_state, human gates, simulation, right-brain validation, safety
- `architecture-workflows.md` — Workflow definitions: create_domain, create_workflow, L/R brain collaboration, gap taxonomy, self-repair loop
- `architecture-reference.md` — pgvector, security, tech debt register, backlog, cost of ownership, refactoring history

---

## 6. Process Layer — PROC

`ProcFunction` is the cognitive core of evolving-mind-ai. It owns all business
logic — intent classification, workflow execution, LLM orchestration, and domain
management. It has no knowledge of Slack, no direct database access, and no AWS
SDK imports in its endpoint modules. It receives normalised requests from the
Experience tier (via SQS WorkflowQueue or HTTP), executes against SERV via HTTP,
and routes results back to the UI via the SQS SlackResults queue (SQS path) or
to a future UI HTTP entry point — direct HTTP result delivery is not currently
allowed or implemented.

### The programming language analogy

The Step Processor and workflow system is deliberately designed to resemble a
simple programming language and the runtime that executes it.

| Programming concept | evolving-mind-ai equivalent |
|---|---|
| Program (source code) | `PGC_Workflow.steps` — a JSON array of step definitions |
| Program counter | `frame.current_step` — the string key of the next step to execute |
| Memory / data bag | `frame.local_state` — a plain JSON object on each frame |
| Call stack | `PGC_WorkflowRun.stack` — a JSON array of frames |
| Function call | PUSH a new workflow frame; POP when it returns |
| Loop | Iterator frame — advances `current_index` until all items processed |
| Blocking I/O | `human_gate` frame — suspends the stack until user responds |
| CPU / machine core | Step Processor (`run-workflow.mjs`) — a generic executor with no workflow-specific logic |
| Kernel | Intent Preprocessor (`classify-intent.mjs`) — routes user input to the right program |
| System calls | SERV HTTP calls — the only way the Step Processor reads or writes data |
| Instruction set | Step types — `llm_call`, `serv_query`, `human_gate`, `notify`, etc. |

A workflow author writes a program (a JSON step array) once. The Step Processor
executes it identically every time, across any number of concurrent runs, with no
knowledge of what the program does. This is the same relationship a CPU has with
machine code — the CPU executes instructions; the instructions encode the
programmer's intent.

### Section map

| Section | Topic |
|---|---|
| 6.1 | Process Layer API — HTTP routes and SQS message types |
| 6.2 | Process Layer config tables — PGC as the brain's system memory |
| 6.3 | Intent Preprocessor — two-pass, domain-workflow-aware pipeline |
| 6.4 | Generic CRUD Workflows
| 6.5 | Step Executor — WorkflowRun, execution loop, and all execution subsystems |
| 6.5.1 | Step types — the instruction set |
| 6.5.2 | Execution Stack — the program counter and call stack |
| 6.5.3 | `local_state` — the data bag / memory |
| 6.5.4 | Human-in-the-Loop — blocking I/O |
| 6.5.5 | Parallel execution hooks — deferred, Backlog |
| 6.5.6 | `simulate` step type — workflow path simulation and validation |
| 6.6 | Right-Brain Output Validation — correction loop |
| 6.7 | Workflow Safety — circuit breakers and emergency shutdown |
| 6.8 | create_domain Workflow — full annotated example |
| 6.9 | create_workflow Workflow — Phase 2 |
| 6.10 | Session Architecture — conversational memory (Backlog) |

---

### 6.1 Process Layer API

Every PROC endpoint module exports `handle(req)` and is wired to both an HTTP
route and an SQS message type in `proc/handler.mjs`. The HTTP path is available
for direct testing with curl. The SQS path is the production path.

#### HTTP routes

```
POST /proc/classify-intent     classify-intent.mjs — intent pipeline entry point
POST /proc/run-workflow        run-workflow.mjs    — execute_top | resume_gate | cancel
POST /proc/review-output       review-output.mjs   — right-brain validation (also intra-proc direct import)
POST /proc/create-domain       create-domain.mjs   — direct /create-domain command entry point
POST /proc/create-workflow     create-workflow.mjs — Phase 2
POST /proc/shutdown            shutdown.mjs        — emergency stop
```

#### SQS message types (WorkflowQueue)

```
CLASSIFY_INTENT    → classify-intent.mjs
WORKFLOW_STEP      → run-workflow.mjs       (actions: execute_top | resume_gate | cancel)
CREATE_DOMAIN      → create-domain.mjs
CREATE_WORKFLOW    → create-workflow.mjs
```

#### SQS message format (WORKFLOW_STEP)

```json
{
  "type":          "WORKFLOW_STEP",
  "workflowRunId": 42,
  "action":        "execute_top | resume_gate | cancel",
  "userResponse":  "confirm | cancel | remove_item | ...",
  "responseData":  { "tableName": "...", "inputValue": "..." },
  "traceId":       "uuid"
}
```

**One message per step.** Each `execute_top` message executes exactly one step,
then enqueues the next `execute_top`. This gives the stack one SQS hop per
instruction — analogous to a single CPU clock cycle.

#### Callback / notification abstraction

All results flow back to the UI via `callback: { provider, channel, threadId }`.
`routeCallback()` in `callback.mjs` dispatches on `provider`. Adding a new UI
(Teams, web) is one new `case` in that function. SERV never reads callback fields.

The callback abstraction handles two distinct message types flowing back to the UI:

- **HUMAN_NOTIFICATION / WORKFLOW_ERROR / WORKFLOW_CANCELLED** — completion and status
  messages posted as Slack thread replies. These are fire-and-forget.
- **HUMAN_GATE** — a human gate suspension event. The Step Processor builds a
  structured dialog payload and enqueues it via the same callback path. `callback.mjs`
  translates the UI-agnostic `HUMAN_GATE` message into Slack Block Kit blocks and
  posts the interactive message to the thread. The user's interaction with that message
  is what resumes the suspended stack. See Section 6.5.4 for the full gate lifecycle and message contract.

---

### 6.2 Process Layer config tables — PGC as system memory

The PGC database (`pgc`) is the brain's persistent system memory. The Step
Processor and Intent Preprocessor are stateless Lambda functions — they carry no
in-process memory between invocations. Everything they need to operate is loaded
from PGC at runtime.

#### Tables and their roles in the Step Processor

| Table | Role | Read by | Written by |
|---|---|---|---|
| `PGC_Workflow` | Program store — stores the step array for every workflow. `intent_keywords` is the authoritative verb vocabulary for Pass 2 domain-workflow lookup | Step Processor, Intent Preprocessor (Pass 2, pre-loaded) | `upsert-workflow.mjs` / create_workflow workflow |
| `PGC_WorkflowRun` | Process control block — stack, status, state, callback for each run | Step Processor | Step Processor |
| `PGC_WorkflowRunStep` | Audit log — one row per step execution, used for idempotency | Step Processor | Step Processor |
| `PGC_Prompt` | Prompt store — `prompt_text`, `output_schema`, `model`, `error_log` per intent | Step Processor (llm_call steps) | `upsert-prompt.mjs` / right-brain |
| `PGC_IntentMap` | Intent routing table — regex patterns → `intent_category` + `action_type`. Structurally independent from `PGC_Workflow` — no `workflow_id` FK. Routing uses `action_type` + `intent_category` name lookup | Intent Preprocessor | `create_domain` workflow (step 10) |
| `PGC_DomainHelp` | Domain registry — aliases, description, CRUD commands per domain | Intent Preprocessor | `create_domain` workflow (step 8) |
| `PGC_Schema` | Schema registry — column definitions per PGD table | SERV (column validation) | `create_domain` workflow (DDL iterator) |
| `PGC_TableMap` | Table routing — maps table names to their database target | SERV (insertRow gate) | `create_domain` workflow (DDL iterator) |
| `PGC_SystemContext` | System-wide config — thresholds, defaults, feature flags | Step Processor, Preprocessor | `init-brain.mjs` / admin |
| `PGC_StepType` | Step type registry — canonical list of valid step types | Right-brain (Backlog) | `init-brain.mjs` |
| `PGC_Capability` | Capability registry — available tools the brain can invoke | Right-brain (Backlog) | `init-brain.mjs` |
| `PGC_WorkflowStats` | Aggregate view — run counts, failure rates per workflow | Right-brain, monitoring | DB view (auto-maintained) |

#### How these tables are used together in a workflow run

When `create_domain` runs, the Step Processor:

1. Reads `PGC_Workflow` once to load the step array — this is the program
2. Reads `PGC_Prompt` at each `llm_call` step to get the prompt text and schema
3. Writes `PGC_WorkflowRun.stack` and `.state` after every step — persisting the program counter and data bag
4. Writes `PGC_WorkflowRunStep` after every step — idempotency audit log
5. Calls SERV which reads `PGC_Schema` and `PGC_TableMap` to validate and route inserts
6. At the end of the workflow, writes `PGC_DomainHelp`, `PGC_Workflow` (4 CRUD workflows), `PGC_IntentMap` (4 rows — pattern + intent_category + action_type, no workflow_id), and `PGC_EntitySchema` (entity join/aggregation definitions) — making the new domain available to the Intent Preprocessor and SERV-Entity

The PGC tables are not just config — they are the evolving state of the brain.
The Intent Preprocessor reads from PGC to route incoming intents. The Step
Processor writes to PGC as a side-effect of running workflows. The right-brain
reads PGC to understand what has happened and improve future behaviour.

---

### 6.3 Intent Preprocessor — the kernel

The Intent Preprocessor (`classify-intent.mjs`) is the kernel of the system. It
receives every free-form user input from the `/mind` Slack command and routes it
to the correct program (workflow) or handler. It never executes the workflow
itself — it only classifies and dispatches, exactly as a kernel routes a system
call to the correct handler without executing the application code.

The preprocessor is triggered only by `/mind`. The `/create-domain`, `/help`, and
`/shutdown` commands bypass it entirely and route directly to their handlers.

#### Two-pass, domain-workflow-aware classification pipeline

**Root cause addressed by this design:** The previous three-pass design had Pass 1b
and Pass 1c operating on a different knowledge base than Pass 1a. Pass 1c was
domain-aware but workflow-blind — it built ad-hoc CRUD steps against a table
without knowing that a richer registered workflow existed for that domain. This
caused inputs like `"get my recipes sweet potato"` to execute an ad-hoc
`serv_query` instead of the `get_recipes` workflow. The redesign collapses Pass 1b
and Pass 1c into a single **domain-workflow-aware Pass 2** that checks registered
workflows before falling back to CRUD verb detection.

**Session 17 — generic CRUD workflows:** `create_domain` no longer generates
domain-specific workflows (`add_recipes`, `list_recipes`, etc.). It produces five
`PGC_IntentMap` rows per domain using `*_entity` intent categories that route to
five universal generic workflows (`add_entity`, `list_entity`, `get_entity`,
`update_entity`, `delete_entity`) with `domain: null` in `PGC_Workflow`. This
eliminated schema drift and made child-row insertion generically possible.

**Session 18 — Phase B pre-pass:** A new pre-pass runs before Pass 1 and detects
`PGC_*/PGD_*` table-name prefixes in user input. This is the **sole trigger** for
direct table-level CRUD (`serv/table/*`). Inputs containing `field=value` pairs or
`id=N` without a table prefix never route to the direct CRUD path — they route to
the domain workflow. The pre-pass short-circuits the entire Pass 1/Pass 2/Tier 2
chain with zero DB reads beyond the already-preloaded rows.

**Data-driven verb vocabulary:** Rather than hardcoding verb lists in code, Pass 2
reads `PGC_Workflow.intent_keywords` — already generated by the LLM at domain
creation time. When a new verb is added to a workflow's `intent_keywords`, Pass 2
automatically supports it with no code change.

**Pre-load (parallel, one DB round-trip):**

```js
const [intentMapResp, domainHelpResp, workflowResp] = await Promise.all([
  getRows('PGC_IntentMap'),
  getRows('PGC_DomainHelp'),
  getRows('PGC_Workflow'),   // added — used by Pass 2 and handoff(); net savings: removes the
]);                          // getRows('PGC_Workflow') call previously inside handoff()
```

**Classification pipeline:**

```
User input — arrives via /mind Slack command
  │
  ▼
PRE-PASS — PGC_*/PGD_* table-prefix detection (zero LLM, zero extra DB reads)
  Scan input for a PGC_ or PGD_ prefixed token.
  │
  ├── Token found
  │     Extract table name. Detect CRUD verb via CRUD_PATTERNS.
  │     │
  │     ├── No verb → crud_ambiguous: "please include a verb"
  │     │
  │     ├── Verb found, required inputs missing (insert: no fields;
  │     │   update: no id or no fields; delete: no id)
  │     │     → crud_ambiguous with instructive error
  │     │
  │     └── Verb + required inputs present
  │           SHORT-CIRCUIT → executeCrudStep() directly against serv/table/*
  │           confidence: 'exact'
  │           e.g. "list PGD_Recipes"                → serv_query, no filters
  │           e.g. "list PGD_Recipes name=Pasta"     → serv_query, filter name=Pasta
  │           e.g. "add PGD_Recipes name=Pasta"      → serv_insert
  │           e.g. "update PGD_Recipes id=42 name=X" → serv_update
  │           e.g. "delete PGD_Recipes id=42"        → serv_delete
  │           e.g. "list PGC_Workflow"               → serv_query (admin path)
  │
  └── No token → PASS 1
  │
  ▼
PASS 1 — Intent Map Match (zero LLM)
  Lowercase input. Test against every PGC_IntentMap.pattern (regex).
  Sort: workflow > heavy_lift > crud; lower id wins within tier.
  │
  ├── Match found, action_type = 'workflow' or 'heavy_lift'
  │     For *_entity categories: resolve domain via matchDomainAlias().
  │     For retrieval workflows: extract search_term via extractSearchTerm().
  │     SHORT-CIRCUIT → handoff() immediately
  │     confidence: 'exact'
  │     e.g. "add recipes carbonara" → add_entity workflow, domain: recipes
  │     e.g. "build a domain"       → heavy_lift → CREATE_DOMAIN
  │
  ├── Match found, action_type = 'crud'
  │     Fall through to Pass 2 — domain workflows take priority over
  │     table-level crud rows in PGC_IntentMap (which are legacy/unused
  │     now that all domain operations route through *_entity workflows).
  │
  └── No match → PASS 2
  │
  ▼
PASS 2 — Domain-Workflow Lookup (zero LLM)
  Tokenise input. Scan PGC_DomainHelp.aliases — resolve domain name.
  │
  ├── No domain resolved
  │     hasCrudVerb() check — CRUD verb present but no domain matched?
  │       YES → crud_ambiguous: list registered domains (saves Tier 2 LLM call)
  │       NO  → Tier 2 (no hint)
  │     Backlog — check PGC_SessionEntry for active domain in session context
  │       Found → continue with resolved domain below (confidence: 'session_context')
  │
  └── Domain resolved → WORKFLOW KEYWORD SCAN
        Filter pre-loaded PGC_Workflow rows by domain OR domain: null.
        domain: null rows (generic *_entity workflows) are universal candidates —
        available to every domain's keyword scan. This is the UC 1.1 fix.
        Test lowercased input for token presence against each workflow's intent_keywords.
        Disambiguation: get_entity wins over list_entity when input contains terms
          beyond the verb and domain name (indicating a search term).
        Extract search_term / record_id when matched workflow is a retrieval type.
        │
        ├── Keyword match found → route to matched workflow
        │     confidence: 'keyword_match'
        │     e.g. "show all my recipes"          → list_entity
        │     e.g. "get my sweet potato recipe"   → get_entity, search_term: "sweet potato"
        │     e.g. "add pasta to my recipes"      → add_entity
        │
        └── No keyword match → Tier 2 with domain hint
  │
  ▼ (no Pre-pass, Pass 1, or Pass 2 match)
TIER 2 — Cheap LLM classification (perplexity/sonar)
  Only invoked when coded logic cannot classify.
  Domain hint injected if Pass 2 resolved one.
  Session context injected (Backlog) — enables ambiguous short-form resolution.
  Returns { intent_category, workflow_name, action_type }
  ├── workflow_name found in PGC_Workflow → enqueue WORKFLOW_STEP execute_top
  └── action_type = 'heavy_lift'         → Tier 3
  │
  ▼
TIER 3 — Heavy lift handoff (no additional LLM call)
  ├── intent_category = 'create_domain'   → enqueue CREATE_DOMAIN
  ├── intent_category = 'create_workflow' → enqueue CREATE_WORKFLOW
  └── unknown heavy_lift                  → HUMAN_NOTIFICATION: "I understood this
                                            but have no workflow for it yet."
```

#### Backlog — pgvector semantic search (supersedes Pass 2 keyword scan)

Pass 2's token-based `intent_keywords` scan is the Phase 2 implementation.
In Backlog, once `pgvector` is enabled and `PGC_Workflow.intent_embedding` columns
are populated, Pass 2 is extended with a semantic similarity step:

```
PASS 2 Backlog extension — after domain resolution, before Tier 2:
  Embed user input using text-embedding-3-small (OpenAI, 1536 dimensions)
  Query PGC_Workflow WHERE domain = resolved_domain
    ORDER BY intent_embedding <-> query_embedding LIMIT 1
  If cosine similarity > threshold (e.g. 0.82) → route to that workflow
    confidence: 'semantic_match'
  Else → fall through to Tier 2
```

This eliminates Tier 2 LLM calls for domain workflows entirely — novel phrasings
that miss keyword matching are caught by vector similarity before sonar is invoked.
The `intent_embedding` column already exists on `PGC_Workflow` (no schema change).
Enable when `CREATE EXTENSION IF NOT EXISTS vector` is run on RDS. See Section 10.

#### Three coexisting operation paths

A deliberate architectural boundary separates direct table operations, domain
workflow operations, and heavy-lift system commands:

| Path | Trigger | Scope | Cost |
|---|---|---|---|
| **Pre-pass direct** | `PGC_*/PGD_*` table-name prefix in input | Root table only — single-row INSERT / SELECT / UPDATE / DELETE via `serv/table/*` | Zero LLM, zero WorkflowRun |
| **Workflow** | Pass 1 or Pass 2 `*_entity` keyword match | Full domain entity — root + child tables, LLM parsing, confirmation gates | WorkflowRun lifecycle |
| **Heavy lift** | Pass 1 exact or Tier 2 LLM | System command — `CREATE_DOMAIN`, `CREATE_WORKFLOW`, or unknown | Tier 3 enqueue; may trigger LLM |

The pre-pass direct path is the only path where `field=value` pairs and `id=N` trigger
table operations. When these appear in domain input (no `PGC_/PGD_` prefix), they route
to the workflow path — `handoff()` parses them from `userInput` and passes them as
`input.updates` and `input.id` for the workflow steps to consume.

**Generic `*_entity` workflows (Session 17):** `create_domain` registers five
`PGC_IntentMap` rows per domain with `*_entity` intent categories pointing to five
universal `PGC_Workflow` rows (`domain: null`). These replace domain-specific
workflows (`add_recipes`, `list_recipes`, etc.), which are no longer generated.
The generic workflows consume `PGC_EntitySchema` at runtime — column definitions
are never hardcoded into workflow steps.

**`toEntityName()` convention:** `handoff()` derives the `entity_name` field passed
to generic workflows from the resolved domain name. Each underscore-separated word
is title-cased; a trailing `s` is stripped from the last word to produce the
singular form matching `PGC_EntitySchema.entity_name`:
- `recipes` → `Recipe`
- `stock_portfolio` → `StockPortfolio`
- `golf_scores` → `GolfScore`

**`entity_name` injection:** `handoff()` injects `entity_name` into `workflowInput`
for all domain workflow routes so generic workflow steps can call SERV-Entity by
name without knowing which domain they are operating on.

**`record_id` instructive error path:** When `get_entity`, `delete_entity`, or
`update_entity` is routed and the classified result contains `record_id` (i.e. the
user typed `id=N` with a retrieval intent), `handoff()` posts an instructive error
immediately without creating a `PGC_WorkflowRun`. The generic `get_entity` workflow
uses a name LIKE filter or routes to id-based lookup via a `condition` step (implemented Session 19).

#### Classification result shape

```json
{
  "intent_category": "add_recipes",
  "action_type":     "crud",
  "confidence":      "exact",
  "workflow_name":   null,
  "domain":          "recipes",
  "ad_hoc_step":     { "type": "serv_insert", "input": { "tableName": "PGD_Recipes", "row": { "name": "Pasta" } } },
  "search_term":     null
}
```

```json
{
  "intent_category": "get_recipes",
  "action_type":     "workflow",
  "confidence":      "keyword_match",
  "workflow_name":   "get_recipes",
  "domain":          null,
  "ad_hoc_step":     null,
  "search_term":     "sweet potato"
}
```

```json
{
  "intent_category": "list_recipes",
  "action_type":     "workflow",
  "confidence":      "exact",
  "workflow_name":   "list_recipes",
  "domain":          null,
  "ad_hoc_step":     null,
  "search_term":     null
}
```

`confidence` values and their sources:

| Value | Source |
|---|---|
| `exact` | Pass 1 regex match against `PGC_IntentMap.pattern` |
| `keyword_match` | Pass 2 token match against `PGC_Workflow.intent_keywords` |
| `semantic_match` | Pass 2 Backlog — pgvector cosine similarity match |
| `session_context` | Pass 2 Backlog — domain resolved from `PGC_SessionEntry` |
| `crud` | Pass 2 CRUD fallback — `field=value` pairs present, no workflow keyword match |
| `llm_classified` | Tier 2 sonar classification |
| `heavy_lift` | Tier 3 routing |

`search_term` is set by Pass 2 when the matched workflow is a retrieval type (`get_<domain>`)
and the input contains terms beyond the verb and domain name. `handoff()` passes it as
`input.search` without per-workflow special-casing.

`confidence` is the tier and pass that produced the result — useful for right-brain
analysis of where classification is weak.

#### handoff() routing contract

`handoff()` in `classify-intent.mjs` routes the classification result downstream.
The routing rules are final — do not add per-workflow special cases here:

| `action_type` | `workflow_name` | Route |
|---|---|---|
| `workflow` | set | Look up `PGC_Workflow` by `workflow_name` from pre-loaded rows, create `PGC_WorkflowRun`, enqueue `WORKFLOW_STEP execute_top`. If `result.search_term` is set, pass as `input.search` — no per-workflow special cases |
| `heavy_lift` | — | `resolveTier3Route()` → enqueue `CREATE_DOMAIN` / `CREATE_WORKFLOW` / `HUMAN_NOTIFICATION` |
| `crud` | — | `executeCrudStep()` — executes `ad_hoc_step` directly, posts result as `HUMAN_NOTIFICATION` |
| `crud_ambiguous` | — | Post instructive error to user (missing id, missing fields, unknown domain) |

**`search_term` handling is generic.** When `result.search_term` is set, `handoff()` passes
`input: { userInput, search: result.search_term }` regardless of which workflow was matched.
No per-workflow cases. The extraction logic that sets `search_term` lives in
`matchWorkflowByKeywords()` in `classify-intent-tiers.mjs`, where the workflow type is known.

**Word-boundary matching (Session 20):** The keyword scan uses a Unicode-aware word-boundary
regex instead of `String.includes()`. This prevents false positives where a keyword appears as
a substring inside a longer word — e.g. `"list"` matching inside the Spanish word `"simplista"`.
Accented characters (U+00C0–U+024F) count as word characters so boundaries do not form inside
accented Spanish words. Tiebreaker changed from lowest DB id to earliest keyword position in input
(verb-first semantics), with DB id as secondary.

**`PGC_IntentMap` has no `workflow_id` column.** This was removed as a structural
error — there is no genuine FK relationship between the intent map and workflow
table. `handoff()` looks up the workflow by name from pre-loaded rows. `action_type`
alone is the routing signal.

#### matchIntentMap sort order — FINAL

`matchIntentMap()` in `classify-intent-tiers.mjs` sorts all pre-loaded `PGC_IntentMap`
rows before iterating. Sort order:

1. `action_type = 'workflow'` — score 0 (highest priority)
2. `action_type = 'heavy_lift'` — score 1
3. `action_type = 'crud'` and all others — score 2 (lowest priority)
4. Within each tier: lower `id` wins (first-seeded row is canonical)

This ensures that if a duplicate stale `crud` row somehow matches the same
pattern as a `workflow` row, the workflow row always wins. This is the defensive
guard against `PGC_IntentMap` data quality issues.

#### LLM model selection

| Task | Model | Reason |
|---|---|---|
| Intent classification (Tier 2) | `perplexity/sonar` via `LLM_CHAT_URL` | Fast, cheap, structured JSON |
| Workflow / schema generation | `anthropic/claude-sonnet-4-5` | Reliable structured JSON output |

Model selection is per-prompt row in `PGC_Prompt.model`.

#### Design principles

- Coded logic always runs first — cheap, fast, zero LLM cost
- LLM invoked only when coded logic cannot classify
- Every classified intent resolves to a `PGC_Workflow` row or a known entry point
- The preprocessor has no `PGC_WorkflowRun` row of its own — it is a routing
  function, not a workflow. It never touches the execution stack.
- `PGC_IntentMap` and `PGC_Workflow` are structurally independent — no FK between them

---

#### I/O contracts and invariants

This section documents the input/output contracts between the Intent Preprocessor
passes and tiers. Future work must preserve these contracts — they are the
interfaces that allow passes to compose correctly and that `handoff()` relies on.

##### Classification result object — canonical shape

Every return path in `classify()` produces this shape:

```js
{
  intent_category: string,      // e.g. "get_recipes", "create_domain", "unknown_domain_crud"
  action_type:     string,      // 'workflow' | 'heavy_lift' | 'crud' | 'crud_ambiguous'
  confidence:      string,      // 'exact' | 'keyword_match' | 'semantic_match' | 'session_context' | 'crud' | 'llm_classified' | 'heavy_lift'
  workflow_name:   string|null, // set when action_type === 'workflow', null otherwise
  domain:          string|null, // set when domain was resolved (Pass 1 crud, Pass 2, Tier 2)
  ad_hoc_step:     object|null, // set when action_type === 'crud' and verb resolved
  search_term:     string|null, // set by Pass 2 for retrieval workflows — passed as input.search by handoff()
  // Optional — present on crud_ambiguous paths only:
  known_domains:   string[],
  table_columns:   string[],
  root_table:      string,
  ambiguous_reason: string,     // 'no_id' | 'no_fields'
}
```

**Invariants:**
- `workflow_name` is set if and only if `action_type === 'workflow'`
- `ad_hoc_step` is set if and only if `action_type === 'crud'` AND the verb was unambiguous
- `action_type === 'crud_ambiguous'` means the intent was identified but cannot execute — post instructive error
- `domain` is always set when `action_type === 'crud'` or `'crud_ambiguous'`
- `domain` is null when `action_type === 'workflow'` or `'heavy_lift'` — handoff does not need it
- `search_term` is set only when `action_type === 'workflow'` and the matched workflow is a retrieval type

##### Pass I/O boundaries

| Pass | Input | Output contract |
|---|---|---|
| Pass 1 — workflow/heavy_lift | PGC_IntentMap row with `action_type !== 'crud'` | Short-circuits: returns result with `workflow_name` set, `domain: null`, `ad_hoc_step: null`, `search_term: null` |
| Pass 1 — crud + field=value | PGC_IntentMap row with `action_type === 'crud'`, field=value pairs present | Short-circuits: returns full result including `ad_hoc_step`, `domain` set |
| Pass 1 — crud, no field=value | PGC_IntentMap row with `action_type === 'crud'`, no pairs | Checks pre-loaded PGC_Workflow rows for domain → routes to workflow or falls to Tier 2 |
| Pass 2 — keyword match | PGC_DomainHelp alias resolved + PGC_Workflow.intent_keywords scan | Returns result with `workflow_name` set, `confidence: 'keyword_match'`, `search_term` populated if retrieval workflow |
| Pass 2 — CRUD fallback | Domain resolved, no keyword match, field=value pairs present | Returns `ad_hoc_step`, `confidence: 'crud'` |
| Pass 2 — Backlog semantic | After keyword scan miss, pgvector similarity > threshold | Returns `workflow_name`, `confidence: 'semantic_match'` |
| Tier 2 (sonar) | Raw user input + optional domain hint | Returns `{ intent_category, workflow_name, action_type }` — no `ad_hoc_step`, no `domain` resolution. `handoff()` looks up workflow from pre-loaded rows |
| Tier 3 | `intent_category` string | Routes to `CREATE_DOMAIN` / `CREATE_WORKFLOW` / `HUMAN_NOTIFICATION` — no further classification |

##### handoff() routing — FINAL, do not add per-workflow cases

```
action_type === 'workflow' AND workflow_name set
  → find workflow in pre-loaded PGC_Workflow rows by name
  → insertRow('PGC_WorkflowRun', { input: { userInput, ...(search_term && { search: search_term }) }, ... })
  → enqueueWorkflow(WORKFLOW_STEP execute_top)

action_type === 'heavy_lift'
  → resolveTier3Route(intent_category)
  → enqueue CREATE_DOMAIN | CREATE_WORKFLOW | HUMAN_NOTIFICATION

action_type === 'crud' AND ad_hoc_step set
  → executeCrudStep() — runs step directly, posts HUMAN_NOTIFICATION

action_type === 'crud_ambiguous'
  → enqueueCallback(HUMAN_NOTIFICATION, instructive error message)

action_type === 'crud' AND no ad_hoc_step (Tier 2 crud path — no root table resolved)
  → enqueueCallback(HUMAN_NOTIFICATION, "could not determine which table to use")
```

##### PGC_IntentMap schema — FINAL

```
id              serial primary key
pattern         text not null        — regex pattern, tested case-insensitive
intent_category text not null        — e.g. "add_recipes", "help", "create_domain"
action_type     text not null        — CHECK: 'crud' | 'workflow' | 'heavy_lift'
created_at      timestamptz
updated_at      timestamptz
```

**No `workflow_id` column.** Removed permanently — there is no structural
relationship between `PGC_IntentMap` and `PGC_Workflow`. Do not add it back.


6.4 Generic CRUD Workflows

Five universal `PGC_Workflow` rows replace domain-specific CRUD workflows.
All five have `domain: null` — they are not bound to any domain.

| Workflow | Intent keywords | Role |
|---|---|---|
| `get_entity` | get, show, find, fetch, look up, search | Retrieve one entity by name LIKE filter or id (Backlog) |
| `list_entity` | list, show all, get all, find all, all | List all entities with optional filter |
| `add_entity` | add, create, new, insert | LLM-parse-first multi-table insert |
| `update_entity` | update, edit, modify, change | Confirmation-gate update on root table |
| `delete_entity` | delete, remove | Confirmation-gate delete with CASCADE |

**Why generic workflows replaced domain-specific ones:** Domain-specific workflows
generated by `create_domain` caused schema drift — column names were baked into
step definitions at creation time and diverged from the live schema when tables were
altered. Child-row insertion via iterator was impossible to generate generically
because child table names and FK columns varied per domain. Generic workflows read
`PGC_EntitySchema` at runtime, making them schema-agnostic.

**`add_entity` child inserts:** Step 5 of `add_entity` uses a `js_transform` expression
(replacing the former `buildChildInserts` built-in) to read `local_state.full_entity_schema`,
`local_state.parsed_entity`, and `local_state.new_record` and build the flat child insert array.
This is the single source of truth — the LLM receives actual column names and never
guesses. New columns added to any table are immediately visible without recreating
the domain.

**`buildChildInserts` js_transform built-in:** Assembles the flat
`{ tableName, row }` array for all child tables from `parsed_entity.children`,
injecting the FK value from `new_record.id`. Reads `full_entity_schema.children[].fk_column`
and `children[].output_key` — no hardcoded column names.

**`execution_mode: sequential` inline iterator:** `run-workflow.mjs` processes all
iterator items in a single Lambda invocation when `execution_mode` is `sequential`
or absent. This eliminates the Lambda recursive loop detection emails that occurred
with 19 rapid proc→SQS→proc cycles during multi-child inserts. Operational ceiling:
approximately 120 child rows at 60s Lambda timeout / ~400ms per SERV insert.

**`create_domain` step 9 (Session 17):** No longer inserts domain-specific
workflows. Now inserts five `PGC_IntentMap` rows using `*_entity` intent categories
and LLM-generated patterns. `intentMapRows.intent_category` is constrained by Ajv
to the enum `[list_entity, get_entity, add_entity, update_entity, delete_entity]` —
the LLM cannot drift back to domain-specific categories.

**`parseFieldValues` SYSTEM_COLS exclusion:** The `id`, `created_at`, and
`updated_at` columns are excluded case-insensitively. If a user types `ID=5` or
`Created_At=...`, these are silently dropped before field values reach SERV.

6.5 Step-executor,  WorkflowRun and the execution loop

When the Intent Preprocessor (or a direct command handler) decides a workflow
should run, it creates a `PGC_WorkflowRun` row and enqueues a `WORKFLOW_STEP
execute_top` SQS message. From that point, `run-workflow.mjs` takes over.

#### PGC_WorkflowRun — the process control block

Every workflow execution has exactly one `PGC_WorkflowRun` row. This row is the
complete runtime state of the execution — nothing is held in Lambda memory between
SQS invocations.

```
PGC_WorkflowRun
  id            integer        — run identifier surfaced to the user for /shutdown
  workflow_id   integer        — FK to PGC_Workflow (which program to run)
  workflow_name text           — denormalised name for fast loading
  status        text           — running | awaiting_human_gate | completed | failed | cancelled
  stack         jsonb          — execution stack (see 6.5.2)
  state         jsonb          — { local_state: { ... } } — the data bag (see 6.5.3)
  input         jsonb          — original input passed to the run (available as input.* in local_state)
  callback      jsonb          — { provider, channel, threadId } — where to send results
  error         jsonb          — structured error if failed; also used for stuck-step detection
  step_count    integer        — total steps executed — velocity guard uses this
  completed_at  timestamptz
```

#### The execution loop

The Step Processor is a simple loop driven by SQS messages. Each message is one
iteration:

```
SQS delivers WORKFLOW_STEP execute_top
  │
  ▼
Load PGC_WorkflowRun by workflowRunId
  Check status — if cancelled: discard (shutdown contract)
  │
  ▼
Inspect top of stack
  workflow frame  → execute current_step of the workflow
  iterator frame  → execute current item, advance index
  (human_gate frame never reaches execute_top — it is suspended)
  │
  ▼
Load PGC_Workflow.steps
Find step where step.step === frame.current_step
  │
  ▼
Check PGC_WorkflowRunStep for (run_id, frame_id, step_key)
  Found → idempotency hit (SQS redelivery)
         → increment stuck_count in run.error
         → if stuck_count >= 3: fail run, notify user (Guard 1)
         → else: re-enqueue execute_top, return
  Not found → proceed
  │
  ▼
Execute step (see 6.5.1 — step types)
  │
  ├── on error: write PGC_WorkflowRunStep (failed), mark run failed,
  │             enqueue WORKFLOW_ERROR to callback, rethrow
  │
  └── on success: write PGC_WorkflowRunStep (completed)
                  clear run.error.stuck_step if present
                  store result at local_state[step.output_key]
                  persist stack + state to PGC_WorkflowRun
                  │
                  ├── result.nextAction = 'suspend' (human_gate)
                  │     push human_gate frame
                  │     set status = awaiting_human_gate
                  │     enqueue HUMAN_GATE to callback
                  │     STOP — next SQS message comes from user interaction
                  │
                  ├── result.nextAction = 'iterator'
                  │     push iterator frame
                  │     enqueue execute_top
                  │
                  ├── result.nextAction = 'end'
                  │     set status = completed
                  │     STOP
                  │
                  └── result.nextAction = 'next' | 'step:N'
                        resolve next step key
                        update frame.current_step
                        enqueue execute_top
```

One SQS message per step. One step per Lambda invocation. The stack is the only
shared state between invocations — always persisted to `PGC_WorkflowRun` before
the Lambda returns.

---

### 6.5.1 Step types — the instruction set

Every step in a workflow is one instruction from this set. The Step Processor has
one handler per type. No workflow-specific code lives in the Step Processor.

#### Step definition schema

Every step follows this shape:

```json
{
  "step":             "1",
  "type":             "<step_type>",
  "description":      "Human-readable description for workflow authors and right-brain",
  "input":            {},
  "output_key":       "key_in_local_state",
  "on_success":       "next | end | step:3a",
  "on_failure":       "human_feedback | cancel"
}
```

**Step keys are always strings.** `"1"`, `"3"`, `"3a"`, `"3b"`, `"3d"` are all
valid step keys. `on_success: "step:3a"` is a forward or backward jump. The Step
Processor resolves step keys by string equality — `parseInt` is never used.

#### Step type reference

```
╔══════════════╦══════════════════════════════════════════════════════╦══════════════════╗
║ Type         ║ What it does                                         ║ Status           ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ llm_call     ║ Load prompt from PGC_Prompt, call LLM, run           ║ ✅ Implemented   ║
║              ║ review-output validation (2-attempt correction loop) ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ js_transform ║ Run a named built-in transform on local_state data   ║ ✅ Implemented   ║
║              ║ (depricated), or evaluate a sandboxed JS expression  ║                  ║
║              ║ via acorn AST gate + vm.runInNewContext. Built-ins:  ║                  ║
║              ║ columnSummary,buildHelpOptions, resolveHelpContent,  ║                  ║
║              ║ formatRecordList, buildChildInserts.                 ║                  ║
║              ║ Generic expression field: Session 19.                ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ human_gate   ║ Suspend stack, present dialog to user, resume on     ║ ✅ Implemented   ║
║              ║ response. Gate types: confirm, edit_list, text_input,║                  ║
║              ║ review_object. (select_one, select_many Backlog)     ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_schema  ║ Create a PGD table via SERV createTable              ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_insert  ║ INSERT one row into a PGD table via SERV             ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_query   ║ SELECT rows from a PGD table via SERV                ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ LIST assembled entities via SERV-Entity listEntities ║ ✅ Implemented   ║
║ query        ║ — root columns + jsonb_agg child arrays. Use instead ║                  ║
║              ║ of serv_query for domains with child tables.         ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ FETCH one assembled entity by id via SERV-Entity     ║ ✅ Implemented   ║
║ get          ║ getEntity. Returns root columns + child arrays.      ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_update  ║ UPDATE rows in a PGD table via SERV                  ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_delete  ║ DELETE rows from a PGD table via SERV                ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ notify       ║ Resolve message_template from local_state, enqueue   ║ ✅ Implemented   ║
║              ║ HUMAN_NOTIFICATION to callback                          ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ iterator     ║ Loop over an array in local_state, execute item_step ║ ✅ Implemented   ║
║              ║ for each item sequentially                           ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ end          ║ Mark run completed, stop                             ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ Load full entity schema: reads PGC_EntitySchema for   ║ ✅ Implemented   ║
║ schema       ║ join topology + PGC_Schema for live column defs.     ║ Session 19       ║
║              ║ Collapses the serv_query + buildEntitySchema          ║                  ║
║              ║ two-step pattern into one step. See Section 6.5.1.    ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ sub_workflow ║ Push child workflow frame, inherit local_state        ║ ⬜ Backlog       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ condition    ║ Evaluate {{expression}} against local_state, route   ║ ✅ Implemented   ║
║              ║ to on_truthy / on_falsy step keys. No I/O.           ║ Session 19       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ capability_call ║ Call a registered capability from PGC_Capability  ║ ⬜ Backlog       ║
╠══════════════╣══════════════════════════════════════════════════════╣══════════════════╣
║ simulate       ║ Dry-run a workflow step array against named         ║ ✅ live          ║
║               ║ execution paths using injected mock outputs.         ║ v3.2-create-    ║
║               ║ Three validation levels: static analysis, path        ║ workflow-       ║
║               ║ execution, skip-path analysis. See Section 6.5.6.   ║ complete        ║
╚══════════════╩══════════════════════════════════════════════════════╩══════════════════╝
```

#### Step-specific schema fields by type

##### **`llm_call`**
```json
{
  "step": "1", "type": "llm_call",
  "input": {
    "prompt":    "create_domain",
    "userInput": "{{input.userInput}}"
  },
  "output_key": "proposed_scaffold",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```
`input.prompt` is the `intent_category` key into `PGC_Prompt`. All other `input`
fields are available to the prompt template via `{{variable}}` substitution.
Output is the parsed JSON object from the LLM, stored at `output_key` in `local_state`.

**Right-brain hooks in `llm_call`.** Every `llm_call` step has two right-brain
mechanisms wired into it by the Step Processor — no workflow definition changes needed:

1. **Validation and correction loop** (Section 6.6): After the LLM responds, `review-output.mjs`
   runs Ajv + semantic validation. On failure, a correction prompt is sent automatically.
   If both attempts fail, the structured errors are written to `PGC_Prompt.error_log`.

2. **Truncation-aware resumption** (Section 6.6): If the response is cut off mid-JSON because
   `max_output_tokens` was reached (`output_tokens === ceiling`), a resumption prompt
   regenerates from scratch at double the token budget, rather than sending the broken
   partial output to the correction loop. If resumption also fails, `token_truncation` is
   logged to `PGC_Prompt.error_log`.

3. **Prompt quality monitor** (Section 6.6): After any 2-attempt failure is written to
   `error_log`, `monitor-prompt-quality.mjs` fires asynchronously. It classifies the
   failure pattern and, for `token_truncation` with 2+ consecutive occurrences, inserts
   a new `PGC_Prompt` version with a raised ceiling automatically. No human intervention
   required. Schema errors are logged as advisory for the Phase 3 right-brain loop.

##### `js_transform`

Every `js_transform` step requires an `expression` field — a pure synchronous JavaScript
value expression executed in a sandboxed `vm.runInNewContext` context. Two bindings are
available in the sandbox:

- **`items`** — the resolved value of `input_key` from `local_state`
- **`local_state`** — the full local_state object, enabling cross-key reads

The `expression` must evaluate to a value (no `return` keyword, no semicolons at top level).
Wrap multi-statement logic in an IIFE: `(function() { ... })()`

```json
{
  "step": "2", "type": "js_transform",
  "description": "Enrich table list with columnSummary and domain field.",
  "input_key": "proposed_scaffold.tables",
  "output_key": "proposed_scaffold.tables",
  "expression": "(function() { var SYS = new Set(['id','created_at','updated_at']); function enrich(tables, domain) { return tables.map(function(t) { if (!t.columns) return t; var cols = t.columns.filter(function(c){ return !SYS.has(c.name); }).slice(0,4).map(function(c){ return c.name; }); return Object.assign({}, t, { columnSummary: cols.join(', '), domain: domain }); }); } return enrich(items, local_state.proposed_scaffold.domain); })()",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```

Reading cross-key values via `local_state` — used when the primary input is insufficient:

```json
{
  "step": "3c", "type": "js_transform",
  "input_key": "proposed_scaffold.tables",
  "output_key": "proposed_scaffold.tables",
  "expression": "(function() { var newTable = local_state.new_table; var merged = newTable ? items.concat([newTable]) : items; return merged; })()"
}
```

**Sandbox constraints:** pure synchronous transforms only — no `require`, no `import`, no
async, no network, no filesystem. Timeout: 200ms. Safe globals available: `JSON`, `Math`,
`Array`, `Object`, `String`, `Number`, `Boolean`, `Date`.

**`transform_type` built-ins removed (Session 20).** All five named built-ins
(`columnSummary`, `buildHelpOptions`, `resolveHelpContent`, `formatRecordList`,
`buildChildInserts`) have been replaced by self-contained `expression` steps in the seed
workflows. Any step using `transform_type` now throws a hard error at runtime — no silent
fallback.

The constraint boundary: `js_transform` is restricted to **pure synchronous data transformation** —
##### `human_gate`
```json
{
  "step": "3", "type": "human_gate",
  "gate_type":        "edit_list",
  "message_template": "Here's my plan for domain {{proposed_scaffold.domain}}.",
  "context_key":      "proposed_scaffold.tables",
  "item_primary_key": "tableName",
  "item_secondary_key": "columnSummary",
  "options": [
    { "label": "Looks good",  "action": "confirm",   "on_select": "step:3d" },
    { "label": "Add a table", "action": "add_table", "on_select": "step:3a" },
    { "label": "Cancel",      "action": "cancel",    "on_select": "cancel"  }
  ],
  "on_success": "next",
  "on_failure": "cancel"
}
```
###### Context key 
`context_key` is a dot-path into `local_state` — the data bound to the dialog.
`options[].on_select` drives routing after the gate resolves — `"step:3d"` is a
jump; `"next"` advances to the sequentially next step; `"cancel"` cancels the run.

###### Template syntax

Templates appear in `message_template`, `input` values, and `context_key`. The
template resolver (`template-resolver.mjs`) supports:

```
{{key}}              → local_state["key"]
{{key.field}}        → local_state["key"]["field"]
{{key.0.field}}      → local_state["key"][0]["field"]
{{item}}             → current iterator item (inside item_step only)
{{item.field}}       → field on current iterator item
{{input.field}}      → run.input["field"] — original input to the workflow
```

Unresolved templates (key not found in local_state) resolve to the empty string
`""` — they do not throw. This means a workflow author must ensure that every
template reference has a corresponding `output_key` written by a prior step.

##### `iterator`
```json
{
  "step": "5", "type": "iterator",
  "items_key":      "proposed_scaffold.tables",
  "item_step":      { "type": "serv_schema", "input": { "table": "{{item}}" } },
  "output_key":     "created_tables",
  "execution_mode": "sequential",
  "on_complete":    "next"
}
```
`items_key` is a dot-path to an array in `local_state`. `item_step` is executed
once per item — the current item is available as `{{item}}` and `{{item.field}}`
inside `item_step.input`. Results are collected into an array at `output_key`.
`execution_mode: "sequential"` is **always required** — omitting it is a workflow defect.

#### Iterator taxonomy — non-suspending vs suspending

Two categories of iterator exist based on whether the `item_step` suspends execution.

**Non-suspending iterator** — `item_step` is a service step (`serv_schema`, `serv_insert`,
`serv_update`, `serv_delete`, `serv_query`, `llm_call`, `js_transform`). All items execute
inline within a single Lambda invocation in `executeIteratorInline`. No SQS hop per item.
This is the common case — `create_domain` step 5 (DDL), step 9, step 10b are all
non-suspending iterators.

**Suspending iterator** — `item_step` is `human_gate`. Each item requires one full
suspend/resume cycle: the iterator breaks after building the gate, a gate frame is pushed,
the run suspends. When the user responds, `resume_gate` pops the gate frame and the iterator
frame becomes the top frame. `resumeGate` detects `parentFrame.type === 'iterator'` and:
1. Strips the `item` binding from `localState` before merging state back onto the iterator frame
   (prevents `item` from leaking into the frame-level state).
2. Increments `parentFrame.current_index` — advancing to the next item.
3. Does **not** set `current_step` — iterator frames use `current_index`, not `current_step`.

The next `execute_top` re-enters `executeIteratorInline` at the incremented index.

`step_ref.options` is resolved from the template string (e.g. `"{{item.options}}"`) to a live
array before the gate frame is persisted — required because `resume_gate` calls
`options.find()` to match the user's response value.

**When to use a suspending iterator vs the flat loop pattern:**

| | Suspending iterator | Flat loop (backward step reference) |
|---|---|---|
| Use when | Fixed list of independent questions, each needing one answer | Loop with inter-item state (score, accumulated data, conditional branching per item) |
| Output | Results array at `output_key` | State accumulated in `local_state` via `js_transform` |
| Loop control | Iterator exhausts automatically | Explicit index + condition step |
| Guard 3 safety | N/A — no backward reference | Requires `human_gate` on every loop path |

Prefer the flat loop pattern when each iteration needs to read results from previous
iterations, or when loop termination depends on accumulated state. See `create_domain_example`
in `PGC_SystemContext` for a complete flat loop example (Spanish vocabulary quiz).

##### `serv_query` / `serv_insert` / `serv_update` / `serv_delete`**
```json
{
  "step": "1", "type": "serv_query",
  "input": {
    "tableName": "PGD_Recipes",
    "filters":   [{ "column": "id", "op": "eq", "value": "{{input.id}}" }]
  },
  "output_key": "results",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```

##### `serv_entity_query` / `serv_entity_get`
```json
{
  "step": "1", "type": "serv_entity_query",
  "input": {
    "entityName": "Recipe",
    "filters":    [{ "column": "name", "op": "like", "value": "{{input.search}}" }],
    # orderBy removed — hardcoded "name" column is domain-specific assumption
    "limit":      20
  },
  "output_key": "results",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```
`entityName` is the PascalCase singular name from `PGC_EntitySchema.entity_name` — e.g. `Recipe`, not `Recipes`.
Returns assembled entities with root columns plus child arrays (`ingredients`, `steps`, etc.).
Use instead of `serv_query` for domains with child tables or when full entity display is needed.

`serv_entity_get` fetches a single entity by id:
```json
{
  "step": "1", "type": "serv_entity_get",
  "input": { "entityName": "Recipe", "id": "{{input.id}}" },
  "output_key": "result",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```

##### `notify`
```json
{
  "step": "11", "type": "notify",
  "message_template": "Domain {{proposed_scaffold.domain}} created. Try: {{generated.domainHelp.commands.0.syntax}}",
  "notify_type": "HUMAN_NOTIFICATION",
  "on_success": "next"
}
```

##### `end`
```json
{ "step": "12", "type": "end" }
```

##### `simulate`
```json
{
  "step":        "4",
  "type":        "simulate",
  "input": {
    "steps_key":        "draft_workflow.steps",
    "mock_outputs_key": "mock_outputs",
    "paths_key":        "simulation_paths"
  },
  "output_key":  "simulation_result",
  "on_success":  "next",
  "on_failure":  "step:3"
}
```
All three `input` fields are dot-paths into `local_state`. `mock_outputs_key`
and `paths_key` are optional — if absent, the `simulate` step runs Level 1
static analysis only. `on_failure` routes back to the step where the user can
review and correct the workflow definition before re-simulating.
Full schema, validation levels, and result structure: see **Section 6.5.6**.

##### `condition`
```json
{
  "step": "1",
  "type": "condition",
  "description": "Route to id lookup or name search depending on which input field is set.",
  "expression": "{{input.id}}",
  "on_truthy": "2",
  "on_falsy":  "3"
}
```
`expression` is resolved via `resolveTemplate` against `local_state`. Truthy: resolved value is
non-empty, not `"null"`, not `"undefined"`, not `"0"`, and does not contain `{{` (unresolved
template literals are treated as falsy — the key was not set). `on_truthy` and `on_falsy` are
bare step keys (e.g. `"2"`, `"3"`) — the executor prefixes them to `step:N` internally.
No output_key is written — condition steps produce no state output.

**Constraint:** `on_truthy` and `on_falsy` must reference step keys that exist in the workflow.
Level 1 static analysis validates both targets as `step:N` routing tokens.

##### `js_transform` — full detail

Only one mode: `expression`. The `transform_type` field is removed — all built-ins replaced
by self-contained expressions. Any step using `transform_type` throws immediately at runtime.

**Sandbox bindings (Session 20)**

| Binding | Source | Notes |
|---|---|---|
| `items` | `resolvePath(localState, step.input_key)` | Primary input — resolved value at `input_key` |
| `local_state` | Full `localState` object | Cross-key reads — required when input_key is insufficient |
| `JSON`, `Math`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Date` | Safe globals | No Node.js APIs |

`local_state` enables workflows generated by `create_workflow` to be fully self-contained —
an expression can read any key already written to the workflow state without needing a
dedicated step type for every combination.

**Constraint boundary.** `js_transform` is restricted to **pure synchronous data transformation** —
operate on data already in `local_state` and return a new value. It never fetches, never writes,
never calls external services.

- "Transform data I already have" → `js_transform` with `expression`
- "Fetch data I don't have" → `serv_*` step type or `capability_call` (Backlog)

**AST gate — rejection rules.** The acorn parser walks the AST before `vm.runInNewContext` is called.
Any of the following causes an immediate throw:

| Rejected AST node | What it blocks |
|---|---|
| `ImportDeclaration` | `import` statements |
| `CallExpression` where callee is Identifier `require` | `require()` calls |
| `MemberExpression` with object Identifier `process` or `global` | Node.js globals |
| `AwaitExpression` | Any `await` |
| `FunctionDeclaration` or `ArrowFunctionExpression` with `async: true` | Async functions |
| `NewExpression` where callee is Identifier `Function` | `new Function()` |
| `CallExpression` where callee resolves to `eval`, `fetch`, `XMLHttpRequest` | Network and eval |

`vm.runInNewContext({ timeout: 200 })` reliably kills synchronous infinite loops.

**Example expressions:**

| Use case | Expression |
|---|---|
| Enrich tables with columnSummary | `(function() { var SYS = new Set(['id','created_at','updated_at']); return items.map(function(t) { var cols = (t.columns||[]).filter(function(c){return !SYS.has(c.name);}).slice(0,4).map(function(c){return c.name;}); return Object.assign({},t,{columnSummary:cols.join(', ')}); }); })()` |
| Merge new_table from local_state | `(function() { var n = local_state.new_table; return n ? items.concat([n]) : items; })()` |
| Count passing results | `items.filter(r => r.score > 0).length` |
| Sum a numeric field | `items.reduce((acc, r) => acc + (r.score || 0), 0)` |
| Filter by field | `items.filter(r => r.status === 'active')` |
| Read cross-key value | `items.concat(local_state.extra_items || [])` |

**Former built-ins and their replacements (for migration reference)**

| Former `transform_type` | Replaced by | Workflow / step |
|---|---|---|
| `columnSummary` | Expression reading `local_state.proposed_scaffold.domain` | `create_domain` steps 2, 3c |
| `buildHelpOptions` | Expression over `items` (registered_domains) | `help` step 2 |
| `resolveHelpContent` | Expression reading `local_state.help_selection` + `local_state.help_options` | `help` step 4 |
| `formatRecordList` | Expression with root_only variant | `get_entity` step 4, `list_entity` step 2 |
| `buildChildInserts` | Expression reading `local_state.full_entity_schema`, `local_state.parsed_entity`, `local_state.new_record` | `add_entity` step 5 |

##### `serv_entity_schema`
```json
{
  "step": "1",
  "type": "serv_entity_schema",
  "input": { "entityName": "{{input.entity_name}}" },
  "output_key": "full_entity_schema",
  "on_success": "next",
  "on_failure": "human_feedback"
}
```
Loads a full entity schema by combining `PGC_EntitySchema` (join topology) with `PGC_Schema`
(live column definitions for all tables in the entity). Replaces the two-step pattern
(`serv_query PGC_EntitySchema` → `js_transform buildEntitySchema`) with a single step.
I/O does not belong in `js_transform`.

`entityName` is the PascalCase singular name from `PGC_EntitySchema.entity_name` — e.g. `Recipe`.
Supports `{{template}}` substitution.

**Output shape written to `output_key`:**
```json
{
  "entity_name": "Recipe",
  "description": "A cooking recipe with ingredients and steps",
  "root": {
    "table":   "PGD_Recipes",
    "columns": [{ "name": "name", "type": "text" }]
  },
  "children": [
    {
      "table":      "PGD_RecipeIngredients",
      "alias":      "ingredients",
      "fk_column":  "recipe_id",
      "output_key": "ingredients",
      "columns":    [{ "name": "ingredient_name", "type": "text" }]
    }
  ]
}
```
System columns (`id`, `created_at`, `updated_at`) and FK columns are excluded from all column lists.
Column definitions are read from `PGC_Schema` at runtime — not cached — so new columns are
immediately visible without recreating the domain.

---

### 6.5.2 Execution Stack — program counter and call stack

`PGC_WorkflowRun.stack` is a JSON array of frames. The Step Processor always
operates on the **top frame** (last element). This is a standard call stack —
pushing a frame suspends the current context; popping a frame resumes it.

#### Frame schema

```json
{
  "frame_id":      "uuid",
  "type":          "workflow | iterator | human_gate",
  "status":        "running | awaiting | completed | failed",
  "workflow_name": "create_domain",
  "current_step":  "3d",
  "local_state":   { "proposed_scaffold": { ... }, "new_table": { ... } },
  "on_complete":   "end",
  "pushed_at":     "2026-03-25T10:08:38Z",

  "item_step":     { ... },
  "items_key":     "proposed_scaffold.tables",
  "items":         [ ... ],
  "current_index": 2,
  "results":       [ ... ],
  "parent_step":   "5",

  "gate_type":     "review_object",
  "step_ref":      { ... },
  "step_number":   "3d"
}
```

`current_step` is the string step key of the **next step to execute** — the
program counter. After every step completes, the Step Processor advances
`current_step` before persisting the frame and enqueuing the next SQS message.

#### Stack operations

| Operation | Triggered by | Effect |
|---|---|---|
| PUSH workflow frame | Start of run (root frame) or `sub_workflow` step | New frame on top; parent frame paused at its current_step |
| PUSH iterator frame | `iterator` step result | New iterator frame on top; workflow frame paused |
| PUSH human_gate frame | `human_gate` step result | New gate frame on top; run status → awaiting_human_gate |
| POP frame | Frame completes (iterator exhausted, gate resolved) | Top frame removed; parent frame resumes |
| POP on cancel | User clicks Cancel at any gate | Stack cleared; run status → cancelled |

#### Stack state examples

**Initial state — single workflow frame, step 1:**
```json
stack: [
  { "frame_id": "A", "type": "workflow", "current_step": "1", "local_state": {} }
]
```

**After step 3 (human_gate) suspends — gate frame on top:**
```json
stack: [
  { "frame_id": "A", "type": "workflow",    "current_step": "3",  "local_state": { "proposed_scaffold": {...} } },
  { "frame_id": "B", "type": "human_gate",  "status": "awaiting", "gate_type": "edit_list", "step_number": "3" }
]
```
The workflow frame is paused at step `"3"`. The gate frame is on top. No SQS
messages are in flight. The Lambda is idle, costing nothing.

**After user confirms — gate popped, workflow frame advanced to step 3d:**
```json
stack: [
  { "frame_id": "A", "type": "workflow", "current_step": "3d", "local_state": { "proposed_scaffold": {...} } }
]
```

**During step 5 iterator — iterator frame on top of workflow frame:**
```json
stack: [
  { "frame_id": "A", "type": "workflow",  "current_step": "5",  "local_state": { ... } },
  { "frame_id": "C", "type": "iterator",  "current_index": 1, "execution_mode": "sequential", "items": [...], "results": [...] }
]
```

**Suspending iterator — human_gate frame on top of iterator frame (mid-item):**
```json
stack: [
  { "frame_id": "A", "type": "workflow",  "current_step": "5",  "local_state": { ... } },
  { "frame_id": "C", "type": "iterator",  "current_index": 1, "execution_mode": "sequential", "items": [...], "results": [ result_0 ] },
  { "frame_id": "D", "type": "human_gate", "status": "awaiting", "gate_type": "choice", "step_number": "5" }
]
```
When the user responds, `resume_gate` pops frame D, detects `parentFrame.type === 'iterator'`,
increments `C.current_index` to 2, strips the `item` binding from `localState`, and
does **not** set `current_step` on frame C. `execute_top` re-enters `executeIteratorInline`
at index 2.

#### Sequential iterator rule

**The iterator never enqueues all items simultaneously.** It executes one item,
waits for it to complete, then executes the next. At all times there is at most
one `execute_top` SQS message in flight per `workflowRunId`. This is enforced
by stack discipline — the iterator frame stays on top until all items are done
and the frame pops. No locking, no coordination.

#### Idempotency

Before executing any step, the Step Processor checks `PGC_WorkflowRunStep` for
a row with `(run_id, frame_id, step_key)` where `step_key` is the string step
key `"3a"`, `"3d"`, etc. If found, the step already ran (SQS at-least-once
redelivery). The Step Processor increments `run.error.stuck_count` for this
step. At count 3, it marks the run `failed` and posts a `WORKFLOW_ERROR` to
Slack with the run ID and step name (Guard 1 — lightweight stuck-step detector).

**Critical:** `step_key` is stored as `text` in `PGC_WorkflowRunStep`. Using the
integer `step_number` column for idempotency would collapse `"3a"`, `"3b"`, `"3c"`,
`"3d"` all to `3` via `parseInt`, creating false positive idempotency hits on
branching workflows. The `step_key` text column was added by `migrate-step-key.mjs`.

---

### 6.5.3 `local_state` — the data bag

`local_state` is a plain JSON object on each frame. It is the workflow's memory —
the working set of data available to every step in the current frame. It is the
equivalent of a function's local variables in a programming language.

#### How data flows through local_state

```
Step 1 — llm_call
  output_key: "proposed_scaffold"
  LLM returns: { domain: "stock_portfolio", tables: [...] }
  → local_state["proposed_scaffold"] = { domain: "stock_portfolio", tables: [...] }

Step 2 — js_transform
  input_key:  "proposed_scaffold.tables"   reads  local_state.proposed_scaffold.tables
  output_key: "proposed_scaffold.tables"   writes local_state.proposed_scaffold.tables
  → each table object now has a columnSummary field

Step 3 — human_gate (edit_list)
  context_key: "proposed_scaffold.tables"  binds  local_state.proposed_scaffold.tables
  message_template: "Plan for {{proposed_scaffold.domain}}"
                                           reads  local_state.proposed_scaffold.domain
  User removes PGD_Transactions
  → local_state.proposed_scaffold.tables now has 3 items instead of 4

Step 3d — human_gate (review_object)
  context_key: "proposed_scaffold.tables"  binds  local_state.proposed_scaffold.tables
  → user sees all 3 tables with their column details before DDL

Step 5 — iterator
  items_key: "proposed_scaffold.tables"    reads  local_state.proposed_scaffold.tables
  item_step: serv_schema input "{{item}}"  each item = one table object from the array
  output_key: "created_tables"
  → local_state["created_tables"] = [{ tableName: ..., status: 'created' }, ...]

Step 6 — llm_call
  input: { domain: "{{proposed_scaffold.domain}}", tables: "{{proposed_scaffold.tables}}" }
  output_key: "generated"
  → local_state["generated"] = { domainHelp: {...}, workflows: [...], intentMapRows: [...] }

Step 7 — human_gate (review_object)
  context_key: "generated.domainHelp"     binds  local_state.generated.domainHelp

Step 8 — serv_insert
  input.row: { domain: "{{generated.domainHelp.domain}}", ... }
  → inserts PGC_DomainHelp row

Step 9 — iterator (PGC_Workflow × 4)
  items_key: "generated.workflows"         reads  local_state.generated.workflows

Step 10 — iterator (PGC_IntentMap × 4)
  items_key: "generated.intentMapRows"     reads  local_state.generated.intentMapRows

Step 11 — notify
  message_template: "Domain {{proposed_scaffold.domain}} created."
                                           reads  local_state.proposed_scaffold.domain
```

#### local_state scope and persistence

`local_state` is scoped to a frame. When an iterator frame is pushed, it inherits
a copy of the parent frame's `local_state` at push time. When the iterator frame
pops, its `output_key` result is written back to the parent frame's `local_state`.

`local_state` is persisted to `PGC_WorkflowRun.state.local_state` after every
step. Lambda is stateless — `local_state` is always reloaded from the DB on the
next SQS invocation.

#### The run.input object

The workflow's original input (`run.input`) is always available as `{{input.*}}`
in templates. For `create_domain`, `run.input = { userInput: "stock portfolio" }`.
Step 1 reads `{{input.userInput}}` to pass the raw user description to the LLM.
`run.input` is never modified by any step — it is read-only origin data.

---

### 6.5.4 Human-in-the-Loop — blocking I/O

A `human_gate` step is the equivalent of blocking I/O in a program — the execution
stack suspends entirely, Lambda exits, and no compute is consumed until the user
responds. This is cost-free waiting.

#### Suspension and resumption lifecycle

```
Step Processor executes human_gate step
  │
  ├── Pushes human_gate frame onto stack
  ├── Sets PGC_WorkflowRun.status = 'awaiting_human_gate'
  ├── Builds HUMAN_GATE dialog from gate_type + context_key data
  ├── Enqueues HUMAN_GATE to SQS SlackResults
  └── Lambda returns — stack suspended, no timeout, zero cost while waiting

SlackResults → CallbackListener → Slack API → dialog rendered in thread

User interacts with dialog
  │
Slack sends interaction payload to /interactive on SlackbotFunction
  │
SlackbotFunction enqueues:
  { type: 'WORKFLOW_STEP', action: 'resume_gate',
    workflowRunId: N, userResponse: 'confirm', responseData: {...} }
  │
Step Processor receives resume_gate
  ├── Validates: top frame is human_gate, run status is awaiting_human_gate
  ├── Applies mutation (remove_item, text_input value write, etc.)
  ├── Pops gate frame
  ├── Resolves on_select → next step key
  ├── Advances parent frame.current_step
  ├── Sets status = 'running'
  └── Enqueues execute_top — execution resumes
```

#### Human Gate-type catalogue

| gate_type | User interaction | Data contract |
|---|---|---|
| `confirm` | Read a proposal, click Confirm or Cancel | `context_key` optional — context shown as text |
| `edit_list` | View a list, remove items, click Confirm | `context_key` → array; `item_primary_key`, `item_secondary_key` label each row |
| `text_input` | Type free text, click Submit | Value written to `local_state[output_key]` on resolve |
| `review_object` | View a structured summary, click Confirm | `context_key` → object or array; rendered as key-value pairs |
| `choice` | Read a question, view labelled options with descriptions, click A/B/C | Options carry `{ value, label, description, on_select }`. `value` written to `local_state[output_key]` on resolve. Mirrors HTML radio button semantics — `value` is submitted, `label` is the button text, `description` is the explanatory sentence shown above buttons |
| `select_one` | Pick one item from a list | Backlog — `buildDialog` stub exists but `context_key` only accepts flat entity lists. Use `choice` for options with descriptions |
| `select_many` | Pick zero or more items | Backlog |

#### Human gate-step schema reference

Full field reference for a `human_gate` step definition. This is the authoritative
schema for workflow authors and the right-brain when generating or validating
workflow definitions containing gate steps.

```json
{
  "step":             "3",
  "type":             "human_gate",
  "gate_type":        "confirm | edit_list | text_input | review_object | choice | select_one | select_many",
  "description":      "Human-readable — for workflow authors and right-brain only",

  "message_template": "Displayed to user. Supports {{template}} substitution from local_state.",

  "context_key":      "dot.path.into.local_state",
  "item_primary_key": "field name — used as row label in edit_list",
  "item_secondary_key": "field name — used as secondary text in edit_list",

  "item_action": {
    "condition":        "item.foreignKeys && item.foreignKeys.length > 0",
    "action":           "remove_item",
    "action_data_key":  "tableName",
    "confirm_template": "Remove {{item.tableName}} from this domain?"
  },

  "options": [
    { "label": "Looks good", "action": "confirm",   "on_select": "next"    },
    { "label": "Add a table","action": "add_table", "on_select": "step:3a" },
    { "label": "Cancel",     "action": "cancel",    "on_select": "cancel"  }
  ],

  "output_key": "key_written_to_local_state_on_resolve",

  "on_success": "next",
  "on_failure": "cancel"
}
```

**Field notes**

**`gate_type`** — determines how `callback.mjs` renders the dialog and what
`resume_gate` expects in `responseData`. See the gate type catalogue in 6.5.4.

**`message_template`** — resolved via `template-resolver.mjs` at suspension time,
not at step definition time. Template variables are read from `local_state` at the
moment the gate suspends.

**`context_key`** — dot-path into `local_state`. For `edit_list`, must resolve to
an array. For `review_object`, resolves to an object or array — arrays are rendered
as a table-name / column-list display. Optional for `confirm`.

**`item_action`** — `edit_list` only. Defines a per-row action button. `condition`
is evaluated against each item — items where the condition is falsy do not get the
button. Only `remove_item` is currently implemented; others are Backlog.

**`options`** — rendered as Block Kit buttons. Each `on_select` drives post-gate
routing: `"next"` advances sequentially, `"step:N"` jumps to step N, `"cancel"`
cancels the run. Must include at least one option with `action: "cancel"` (confirm/edit_list)
or `value: "cancel"` (choice).

Two option shapes — determined by `gate_type`:
- `confirm`, `edit_list`, `review_object` use `{ label, action, on_select }`
- `choice` uses `{ value, label, description, on_select }` — HTML radio button semantics:
  `value` is the machine identifier written to `output_key` and matched by `resume_gate`;
  `label` is the short button text (e.g. `"A"`, `"B"`);
  `description` is the explanatory sentence rendered above the buttons as a list.

**`output_key`** — written on gate resolution for two gate types:
- `text_input`: the typed value is written to `local_state[output_key]`
- `choice`: the selected `option.value` is written to `local_state[output_key]`

**`on_timeout` / `timeout_seconds`** — reserved fields, not yet implemented.
When implemented, a gate that receives no user response within `timeout_seconds`
will resolve via `on_timeout` routing (e.g. `"cancel"` or a specific step key).
Until then, gates wait indefinitely — cost-free while suspended.

**`on_success` / `on_failure`** — gate-level fallbacks. `on_success` is the
default routing when no `on_select` override applies. `on_failure` handles
gate execution errors (e.g. dialog build failure), not user cancellation.
User cancellation is always routed via the option with `action: "cancel"`.

---

#### UI Dialog Contract — HUMAN_GATE message

The Step Processor produces a UI-agnostic `HUMAN_GATE` message. `callback.mjs`
translates it to Slack Block Kit. Adding a new UI is one new renderer in
`callback.mjs` — the Step Processor and all workflows are unchanged.

```json
{
  "type":          "HUMAN_GATE",
  "workflowRunId": 23,
  "gate_type":     "edit_list",
  "dialog": {
    "message":  "Here's my plan for domain stock_portfolio.",
    "fields": [
      { "type": "list",   "items": [{ "primary": "PGD_Portfolios", "secondary": "name, currency, created_at" }] },
      { "type": "actions","items": [{ "label": "Looks good", "action": "confirm" }, ...] }
    ]
  },
  "callback": { "provider": "slack", "channel": "C0AEJ87JSKF", "threadId": "..." },
  "message_ts": "1711358400.123"
}
```

`message_ts` is present only on `remove_item` re-renders — signals `callback.mjs`
to use `chat.update` (in-place edit) instead of posting a new message.

#### WORKFLOW_ERROR message shape

```json
{
  "type":          "WORKFLOW_ERROR",
  "workflowRunId": 18,
  "step":          "3a",
  "message":       "Workflow stuck at step \"3a\" — possible routing error. Run id: 18",
  "traceId":       "uuid"
}
```

Posted to Slack when: Guard 1 fires, a step throws after exhausting retries, or
an iterator item fails. Always includes `workflowRunId` so the user can reference
it with `/shutdown` or for debugging.

**Slack rendering — human-readable summary only.** `callback.mjs` never posts the
raw `message` string into a Slack block — it may be thousands of characters (e.g.
a full AJV validation error array). Three summary cases are handled:
- LLM validation failure: `"LLM output validation failed after 2 attempts (N schema errors). The prompt has been logged for improvement."`
- LLM response failure (timeout, empty, invalid JSON): first 200 chars of the error message
- Structural step failure: first 500 chars of the error message
Full error detail is always in CloudWatch and, for prompt validation failures, in `PGC_Prompt.error_log`.

**TROUBLESHOOT_WORKFLOW discriminator.** `run-workflow.mjs` only enqueues
`TROUBLESHOOT_WORKFLOW` for structural errors — errors that indicate a problem
in the workflow definition itself. LLM response failures and schema validation
failures (`llm_call validation failed`) are prompt quality issues that
`TROUBLESHOOT_WORKFLOW` cannot fix — they are excluded from the repair chain.

#### Mutation during gate suspension

`edit_list` gates support `remove_item` — the user can remove items from the
list while the gate is still open. Each click sends `userResponse: 'remove_item'`
with `responseData.tableName`. The Step Processor:
1. Filters the item from `local_state[context_key]`
2. Persists the updated `local_state`
3. Re-renders the gate via `chat.update` (in-place edit of the Slack message)

The stack remains suspended throughout. The gate stays open until the user clicks
Confirm or Cancel.

#### Routing from gates — on_select

Each option in a `human_gate.options` array has an `on_select` that drives
post-gate routing:

```
"on_select": "next"      → advance to sequentially next step in the workflow
"on_select": "step:3d"   → jump to step "3d" (forward or backward)
"on_select": "cancel"    → cancel the run, clear stack
```

`on_select` is resolved by the Step Processor in `resolveOnSelect()` after the
gate frame is popped. The parent frame's `current_step` is set to the resolved
step key before the next `execute_top` is enqueued.

**Routing errors are fatal.** If `on_select` routes to a step that was already
recorded in `PGC_WorkflowRunStep` for the same `frame_id`, the idempotency check
fires on the next `execute_top`. Guard 1 detects this as a stuck step after 3
consecutive hits and fails the run with a Slack notification.

---

### 6.5.5 Parallel execution hooks — deferred, Backlog

The frame schema includes hooks for future parallel execution. These fields are
defined in the frame structure now so the schema is stable when fan-out/fan-in
is implemented. They are never populated in sequential mode.

```json
{
  "frame_id":        "uuid",
  "type":            "workflow | iterator | human_gate",
  "status":          "running | awaiting | completed | failed",

  "parallel_group":  null,
  "fan_out_keys":    null,
  "fan_in_barrier":  null
}
```

**`parallel_group`** — UUID shared by all frames executing in the same fan-out
group. Null in sequential mode. When set, the Step Processor knows these frames
are siblings and coordinates their completion via `fan_in_barrier`.

**`fan_out_keys`** — array of item keys this frame is responsible for processing.
In sequential mode the iterator frame processes all items itself. In parallel mode,
the iterator spawns one frame per item (or per batch), each carrying its subset in
`fan_out_keys`.

**`fan_in_barrier`** — the frame_id of the parent iterator frame waiting for all
fan-out siblings to complete before popping and continuing. When the last sibling
completes, it pops the barrier frame and re-enqueues `execute_top` on the parent.

**Why defined now:** The `PGC_WorkflowRunLock` table (Section 4.3.2) is already
reserved for the optimistic locking required by parallel execution. Defining the
frame hooks alongside it ensures the execution model is internally consistent before
Backlog lands. Sequential mode never reads these fields — they are null-safe.

**Backlog prerequisite:** Parallel execution requires the cycle detector (Guard 3)
to be implemented first. A fan-out that triggers another fan-out would create
unbounded concurrency without cycle detection at workflow registration time.

---

### 6.5.6 `simulate` step type — workflow path simulation and validation

The `simulate` step type is the right-brain’s earliest operational capability.
It dry-runs a generated workflow definition through the Step Processor’s own
execution logic using injected mock outputs and decision scripts, validates every
`local_state` transition, and surfaces structured failure reports before the
workflow is registered in `PGC_Workflow`. It is a prerequisite for `create_workflow`
being trustworthy and is classified as Phase 2 work, not Backlog.

#### Why simulation is not optional for `create_workflow`

Without simulation, the only way to discover a broken workflow is to deploy it
and run it. Given that `create_workflow` produces workflows that will themselves
execute against real data, an undetected broken step is a production incident.
The `confirmed_domain_help` class of bug — a template reference to a key that
was never written to `local_state` — is invisible to Ajv validation and only
manifests at execution time. Simulation catches it before registration.

#### Step definition schema

```json
{
  "step":        "4",
  "type":        "simulate",
  "description": "Dry-run the generated workflow definition against all declared paths",
  "input": {
    "steps_key":       "generated_workflow.steps",
    "mock_outputs_key":"generated_workflow.mock_outputs",
    "paths_key":       "generated_workflow.simulation_paths"
  },
  "output_key":  "simulation_result",
  "on_success":  "next",
  "on_failure":  "step:3"
}
```

`steps_key`, `mock_outputs_key`, and `paths_key` are dot-paths into `local_state`.
They reference keys written by the LLM generation steps that precede the simulate
step. `on_failure: "step:3"` routes back to the human gate where the user reviewed
the step array, with simulation failures injected into the gate context.
`mock_outputs_key` and `paths_key` are optional — when absent the simulate step
runs Level 1 static analysis only.

#### Inputs the LLM must generate

The LLM calls that precede simulate produce three structures, each in a separate
`llm_call` step. See Section 6.8 for why these are produced across multiple LLM
calls rather than one.

**`steps`** — the workflow step array. Step keys, types, routing values, templates.

**`mock_outputs`** — a plain object keyed by step number. Only steps that produce
output need mocks (`llm_call`, `serv_query`). Steps that are pure side-effects
(`serv_insert`, `notify`, `end`) do not.

```json
{
  "mock_outputs": {
    "1": { "domain": "recipes", "tables": [{ "tableName": "PGD_Recipes", "columns": [] }] },
    "6": { "domainHelp": { "domain": "recipes", "aliases": ["recipe", "recipes"] }, "workflows": [] }
  }
}
```

**`simulation_paths`** — an array of named execution paths. Each path is an ordered
list of decisions — one entry per branch point (gate step, failure point, iterator
outcome). Human gates are simulated by injecting `user_response` and `on_select`
as if the user clicked that option. LLM steps, SERV steps, and `js_transform` steps
are simulated using their mock output. The path terminates when it reaches `end`,
`cancel`, or `human_feedback`.

```json
{
  "simulation_paths": [
    {
      "path_name": "happy_path",
      "decisions": [
        { "step": "1",  "outcome": "success" },
        { "step": "3",  "outcome": "gate", "user_response": "confirm", "on_select": "step:3d" },
        { "step": "3d", "outcome": "gate", "user_response": "confirm", "on_select": "next" },
        { "step": "4",  "outcome": "gate", "user_response": "confirm", "on_select": "next" },
        { "step": "5",  "outcome": "success" }
      ],
      "expected_terminal": "end"
    },
    {
      "path_name": "user_cancels_at_review",
      "decisions": [
        { "step": "1",  "outcome": "success" },
        { "step": "3",  "outcome": "gate", "user_response": "cancel", "on_select": "cancel" }
      ],
      "expected_terminal": "cancelled"
    },
    {
      "path_name": "llm_step_fails",
      "decisions": [
        { "step": "1", "outcome": "failure", "error": "LLM returned invalid JSON" }
      ],
      "expected_terminal": "human_feedback"
    }
  ]
}
```

The LLM is expected to enumerate at minimum: the happy path, one cancel path per
gate step, and one failure path per `llm_call` or `serv_*` step. The `output_schema`
for the `generate_workflow_paths` prompt enforces this minimum coverage.

#### What the simulator validates

The simulator runs each path independently. For each path it:

1. Resets `local_state` to `{ input: run.input }` — a clean slate per path
2. Walks steps in execution order driven by the decision script
3. At each step, records the `local_state` transition: keys present before, keys
   added or mutated after, template variables resolved and to what values
4. Flags any step where a template variable could not be resolved (`{{key}}` not
   in `local_state` at that point)
5. Verifies the path’s terminal step matches `expected_terminal`
6. Detects backward-reference loops: a step key reached more times than there are
   gate decisions for it in the script is flagged as a potential infinite loop
   (safe if a `human_gate` step exists on the path from target back to source —
   the same rule as Guard 3)

**Three validation levels run in order. Later levels only run if earlier levels pass.**

**Level 1 — Static analysis (no execution, no mocks needed)**

Runs before any path simulation. Catches structural errors in the step array itself:

| Check | Failure class |
|---|---|
| Every `on_success`, `on_failure`, `on_select` value is a known routing token | Unknown routing value |
| Every `step:N` routing target exists in the step array | Dead routing target |
| Every `{{template}}` reference resolves to an `output_key` written by a prior step on that path | Unresolved template variable |
| Every `items_key` in an `iterator` resolves to an array written by a prior step | Iterator source not an array |
| Every `input.prompt` in an `llm_call` names an `intent_category` in `PGC_Prompt` | Unknown prompt reference |
| No `output_key` is set on a `review_object` or `confirm` gate | Gate type does not write output |
| Every `human_gate` has at least one option with `action: "cancel"` | Missing cancel path |

Level 1 failures are returned immediately — no path execution occurs.

**Level 2 — Path execution (uses mocks and decision scripts)**

Executes each path in `simulation_paths`. For each step, injects the mock output
or decision instead of calling the real service or LLM. Records the `local_state`
transition log. Fails the path if any template variable is unresolvable or if the
terminal step does not match `expected_terminal`.

**Level 3 — Skip-path analysis (failure recovery, advisory)**

For every step with `on_failure: "human_feedback"`, the simulator runs an additional
micro-path: what happens if the user chooses Skip at the recovery gate? If skipping
the step leaves a `null` at an `output_key` that a downstream step reads, the
simulator flags this as a latent data flow risk. This is advisory — it does not
fail the simulation — but it is included in the failure report and shown to the
user in the review gate.

#### Simulation result structure

Written to `local_state[output_key]` on completion:

```json
{
  "passed": true,
  "paths_run": 3,
  "paths_passed": 3,
  "paths_failed": 0,
  "static_analysis": { "passed": true, "issues": [] },
  "path_results": [
    {
      "path_name": "happy_path",
      "passed": true,
      "steps_executed": 11,
      "terminal": "end",
      "expected_terminal": "end",
      "local_state_transitions": [
        {
          "step": "1",
          "keys_before": ["input"],
          "keys_added": ["proposed_scaffold"],
          "template_vars_resolved": {},
          "template_vars_missing": []
        }
      ]
    }
  ],
  "skip_path_warnings": []
}
```

On failure, `passed: false` and `paths_failed > 0`. The first failed path’s
transition log is included in full, showing exactly which step failed and what
`local_state` contained at that point. This is presented to the user in the
`review_object` gate when `on_failure: "step:3"` routes back for correction.

#### Simulation mode flag on WorkflowRun

When `run-workflow.mjs` executes a `simulate` step, it sets
`PGC_WorkflowRun.state.simulation_mode = true` before the simulation begins and
clears it after. This flag is checked by every step handler in `step-executor.mjs`
— when true, the handler returns the mock output from the decision script instead
of calling the real service. No new Lambda, no new SQS queue — the same Step
Processor executes both live runs and simulations. The only difference is the
execution context.

#### HTTP endpoint

`POST /api/v1/proc/simulate-workflow` accepts the step array, mock outputs, and
simulation paths directly, without a `WorkflowRun`. This is the developer-facing
test surface for validating workflow definitions during development, before they
are registered in `PGC_Workflow`. See openapi.yaml for the full request/response
contract.

---

---

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

- Every `on_success`, `on_failure`, and `on_complete` value must be a known routing
  token: `next`, `end`, `cancel`, `human_feedback`, or `step:<key>`
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
  on_failure === "human_feedback" --> push recovery gate (Retry / Skip / Cancel)
  on_failure !== "human_feedback" --> mark run failed --> WORKFLOW_ERROR to Slack
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

