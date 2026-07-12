
# Memory Layer — Architecture and Design
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture docs. Main overview: `docs/architecture.md`. See also: `docs/arch-workflow-patterns.md` §6.13, `docs/arch-data.md` §4.3 (PGC_Memory columns).

Version: 2.0
Status: Implemented — Sprints 3 and 4
Last updated: 2026-06-02

---

## 1. The Core Gap

Every LLM call in evolving-mind-ai starts with a blank slate: static
`PGC_SystemContext` rows and the current workflow's `local_state` (ephemeral,
dies with the run). There is nowhere for knowledge to accumulate and be retrieved
across runs, domains, and workflows.

The memory layer addresses this. It is a persistent store of insights from past
interactions that future LLM calls can draw on. The model is still stateless — the
harness creates the illusion of accumulated understanding by feeding it progressively
richer context.

**Key architectural constraint:** Memory must pay for itself. At household scale the
system targets $8–13/month total. Every memory retrieval adds tokens. The design
is budget-aware at every step.

---

## 2. Three Memory Types

### 2.1 Episodic Memory — what happened

A distilled log of significant user activities. One record per meaningful event.
Each domain workflow run that completes writes an episodic summary via a
fire-and-forget `MEMORY_WRITE` SQS message.

**Primary consumer:** `/chat` companion awareness (deferred to Sprint 5). At present
episodic memories accumulate for future retrieval.

**Decay policy:** Episodic records expire after a configurable TTL (default: 90 days).

### 2.2 Semantic Memory — what was decided

Design decisions and schema facts produced by LLM interactions during workflow
generation and domain creation. Written at two points in `create_domain`:
- **Pre-confirmation**: LLM reasoning from the initial design (episodic-only — see §5.1)
- **Post-confirmation**: Structural schema facts and insert expectations (the authoritative semantic write)

**Primary consumers:**
- `create_workflow` — LLM calls receive domain semantic memories so workflow generation
  starts with the schema's insert expectations already understood
- `parse_entity_input` — classify-intent data loads (copy/paste bulk loads, single
  record adds) receive domain semantic memories so the LLM knows which columns to
  omit at creation and which initial values to apply

**Decay policy:** Semantic records are long-lived. Cleared by `delete_domain`.

### 2.3 Procedural Memory — why things work the way they do

Design intent and rationale behind existing workflows. Written when `create_workflow`
produces a workflow. Consumed by `fix_workflow` and `troubleshoot_workflow` so the
repair LLM understands what it is trying to preserve.

**Primary consumer:** `fix_workflow`, `troubleshoot_workflow`.

**Decay policy:** Procedural records follow their parent workflow. Cleared when
the workflow is deleted.

---

## 3. PGC_Memory Schema

```sql
CREATE TABLE "PGC_Memory" (
  id               SERIAL PRIMARY KEY,
  memory_type      VARCHAR(20)   NOT NULL CHECK (memory_type IN ('episodic','semantic','procedural')),
  scope            JSONB         NOT NULL DEFAULT '{}',
  content          TEXT          NOT NULL,
  tags             JSONB         NOT NULL DEFAULT '[]',
  priority         INTEGER       NOT NULL DEFAULT 5,
  token_estimate   INTEGER       NOT NULL DEFAULT 0,
  source_run_id    INTEGER       NULL REFERENCES "PGC_WorkflowRun"(id) ON DELETE SET NULL,
  source_workflow  VARCHAR(100)  NULL,
  source_step      VARCHAR(50)   NULL,
  expires_at       TIMESTAMPTZ   NULL,
  embedding        FLOAT[]       NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Why `scope` is jsonb:** supports GIN-indexed containment queries across arbitrary
scope dimensions without schema changes. `{"domain":"flashcards"}` matches any call
scope that contains that key-value pair, regardless of additional dimensions.

---

## 4. Memory Scope and Retrieval

### 4.1 Scope patterns

| Scope JSONB | When to use | Example content |
|---|---|---|
| `{}` | Global | "User prefers concise Slack replies" |
| `{"domain":"flashcards"}` | Domain-scoped | Schema insert expectations for the flashcards domain |
| `{"workflow":"create_workflow"}` | Workflow-scoped | "Preserve human_gate at step 3 — user confirmed" |
| `{"domain":"flashcards","workflow":"quiz_flashcards"}` | Compound | Design intent for a specific domain workflow |
| `{"topic":"conventions"}` | Cross-cutting | "User always uses plural table names" |
| `{"topic":"persona"}` | Companion persona | "User's name is Javier. Companion is Novia." |

### 4.2 Retrieval scope expansion

`memory-client.mjs` `expandScope()` expands a call scope to all parent levels.
For scope `{"domain":"flashcards","workflow":"add_entity"}`:

```
1. {"domain":"flashcards","workflow":"add_entity"}  — most specific
2. {"domain":"flashcards"}                           — domain-level (catches create_domain writes)
3. {"topic":"conventions"}                           — cross-cutting
4. {}                                                — global
```

All memories with scope that is a subset of any expanded level are candidates for
retrieval. A memory written with `{"domain":"flashcards"}` is reachable from any
call scoped to that domain, regardless of workflow.

### 4.3 Tag vocabulary

Tags are supplemental filters on top of scope. Tags answer "what is it about?"

| Tag | Meaning | Types |
|---|---|---|
| `domain_design` | Initial schema design reasoning | episodic (pre-confirmation LLM reasoning) |
| `initial_design_reasoning` | Pre-confirmation schema design (paired with domain_design) | episodic |
| `schema_expectations` | Per-table/revision insert expectations from design LLMs | semantic |
| `schema_snapshot` | Post-confirmation structural snapshot | semantic |
| `insert_expectations` | Which columns are required/defaulted/null-at-creation | semantic |
| `aliases` | Domain alias vocabulary | semantic |
| `vocabulary` | Related words and synonyms for a domain | semantic |
| `workflow_design` | Why a workflow is structured the way it is | procedural |
| `run_complete` | Activity record for a completed domain workflow run | episodic |
| `user_preference` | Explicit user preferences | semantic, global |
| `persona` | Companion and user name/style (Sprint 5) | semantic |

### 4.4 Priority and ordering

When multiple memories match, the harness orders by:

```
1. priority column (1–10, lower = higher priority):
   schema_snapshot/schema_expectations → 2–3
   aliases → 4
   workflow_design → 3
   run_complete → 8

2. memory_type: procedural > semantic > episodic  (generation calls)
               episodic > semantic > procedural   (/chat companion calls)

3. created_at DESC — most recent first within same priority and type
```

---

## 5. Memory Writing

### 5.1 Two-layer domain memory architecture

`create_domain` writes three categories of memory with distinct provenance:

| Layer | Step | Type | Tags | When written | Content |
|---|---|---|---|---|---|
| Pre-confirmation episodic | 10 (`create_domain` LLM) | episodic | domain_design, initial_design_reasoning | After LLM responds, before user sees schema | LLM reasoning from initial schema design (`reasoning` field extracted by harness) |
| Pre-confirmation semantic (revisions) | 12b (`revise_domain_schema` LLM) | semantic | schema_expectations | Each time user requests changes | LLM reasoning about revised design expectations — additive, one row per revision |
| Pre-confirmation semantic (new tables) | 13 (`design_table` LLM) | semantic | schema_expectations | Each time user adds a table | LLM reasoning about the new table's insert expectations — additive, one row per table |
| Post-confirmation structural | 16c (`write_memory` step) | semantic | schema_snapshot, insert_expectations | After user clicks "Create it", before DDL runs | Prose structural snapshot: required/SQL-defaulted/null-at-creation columns, initial_value_conventions |

**Why the split:**
- Pre-confirmation reasoning is episodic because it may not reflect the final confirmed schema — the user can revise
- Post-confirmation (step 16c) is the authoritative semantic record — it reflects exactly what the user confirmed
- Revision and table-addition memories are additive; retrieval serves the latest first (`created_at DESC`)

**Step 16b structural snapshot format (example for flashcards domain):**
```
Schema snapshot for flashcards (confirmed): PGD_Decks: required at insert: name. PGD_Cards: required at insert: deck_id. SQL defaults, db sets: ease_factor(2.5), interval_days(0), total_reviews(0), correct_streak(0). null at creation, omit from insert: next_review_date, last_reviewed_at. Application initial-value conventions (apply when field not in user input): PGD_Cards.interval_days: first review interval is 1, not SQL default 0.
```

This content is retrieved by both `create_workflow` and `parse_entity_input` (classify-intent data loads).

### 5.2 Trigger table

| Trigger | Type | Scope | Writer |
|---|---|---|---|
| `create_domain` step 10 (initial design) | episodic | `{"domain":"<name>"}` | `save_to_memory` on llm_call step |
| `create_domain` step 12b (schema revision) | semantic | `{"domain":"<name>"}` | `save_to_memory` on llm_call step (additive) |
| `create_domain` step 13 (add table) | semantic | `{"domain":"<name>"}` | `save_to_memory` on llm_call step (additive) |
| `create_domain` step 16c (post-confirmation snapshot) | semantic | `{"domain":"<name>"}` | `write_memory` step |
| `create_domain` step 17b (alias generation) | semantic | `{"domain":"<name>"}` | `save_to_memory` on llm_call step |
| Any domain workflow run completes | episodic | `{"domain":"<name>"}` | `MEMORY_WRITE` SQS → `memory-writer.mjs` |
| `create_workflow` step 23 (step generation) | procedural | `{"workflow":"<name>"}` | `save_to_memory` on llm_call step |
| `delete_domain` | — | — | DELETE WHERE scope @> `{"domain":"<name>"}` |
| `delete_workflow` | — | — | DELETE WHERE scope @> `{"workflow":"<name>"}` |

### 5.3 `save_to_memory` flag on llm_call steps

When `save_to_memory` is set on a workflow's `llm_call` step, `llm-harness.mjs`:
1. Appends a `reasoning` instruction to the system prompt
2. Extracts and strips the `reasoning` field from the LLM output before schema validation
3. Writes the extracted reasoning to `PGC_Memory` with the configured type, scope, and tags

This costs zero additional LLM calls — the reasoning content is generated as part of the existing call.

```json
{
  "step": "10",
  "type": "llm_call",
  "input": { "prompt": "create_domain", ... },
  "output_key": "proposed_scaffold",
  "save_to_memory": {
    "memory_type": "episodic",
    "scope": { "domain": "{{proposed_scaffold.domain}}" },
    "tags": ["domain_design", "initial_design_reasoning"],
    "priority": 3
  }
}
```

The `scope` values support `{{template}}` substitution resolved against `local_state`
at write time. Note: `proposed_scaffold.domain` is the LLM's output key — the scope
is resolved after the LLM responds and `proposed_scaffold` is in `local_state`.

### 5.4 `write_memory` step type

Explicit workflow step for structured memory writes (used for post-confirmation
snapshot where content is derived by `js_transform`, not from LLM reasoning):

```json
{
  "step": "16c",
  "type": "write_memory",
  "description": "Persist confirmed schema snapshot as semantic memory.",
  "input": {
    "memory_type": "semantic",
    "scope": { "domain": "{{proposed_scaffold.domain}}" },
    "content_key": "domain_semantic_content",
    "tags": ["schema_snapshot", "insert_expectations"],
    "priority": 2
  },
  "on_success": "next",
  "on_else": "next"
}
```

`content_key` names a `local_state` key whose string value becomes the memory content.
`write_memory` never fails the run — errors are logged only (`on_else: "next"`).
No `output_key` — the step returns `outputValue: null`.

### 5.5 Fire-and-forget episodic writes (memory-writer.mjs)

Domain workflow completions produce episodic memories via a `MEMORY_WRITE` SQS
message enqueued by `run-workflow.mjs` on qualifying run completion:

```js
// run-workflow.mjs
if (shouldWriteEpisodicMemory(run)) {
  await enqueueWorkflow({
    type: 'MEMORY_WRITE', runId: run.id,
    workflowName: run.workflow_name,
    domain: run.input?.domain ?? null,
    traceId,
  });
}
```

`shouldWriteEpisodicMemory()` returns true when:
- `run.input.domain` is non-null (it is a domain workflow, not a system workflow)
- `run.workflow_name` is not in the system workflow exclusion set (`create_domain`,
  `create_workflow`, `fix_workflow`, `diagnose_prompt_schema`, `ping_core`,
  `troubleshoot_workflow`)

`memory-writer.mjs` handles `MEMORY_WRITE` messages. Current content is deterministic
distillation (zero LLM cost): `"Completed workflow '<name>' for domain '<domain>'"`.

---

## 6. Memory Retrieval

### 6.1 Retrieval algorithm (`memory-client.mjs`)

`retrieveMemories()` issues one targeted `PGC_Memory` query per expanded scope
level rather than a single unscoped fetch. `memory_type` and scope containment
are filtered server-side via SERV's `in` and `jsonb_contained_by` filter
operators, so rows outside the current call's scope — other domains, other
memory types — never compete for a shared row limit.

```js
async function retrieveMemories({ scope, tags, budgetTokens, memoryTypes, callContext }) {
  const expandedScopes = expandScope(scope);
  // e.g. {"domain":"flashcards","workflow":"add_entity"}
  // → [{"domain":"flashcards","workflow":"add_entity"}, {"domain":"flashcards"},
  //    {"topic":"conventions"}, {}]

  // One query per expanded scope level. `scope <@ candidate` ("contained by")
  // finds rows whose own scope is a subset of this one candidate — the
  // inverse relationship of jsonb_contains (@>), used elsewhere for exact
  // scope matches (e.g. write_memory's expire_prior).
  const byId = new Map();
  for (const candidateScope of expandedScopes) {
    const resp = await getRows('PGC_Memory', [
      { column: 'memory_type', op: 'in',                value: memoryTypes },
      { column: 'scope',       op: 'jsonb_contained_by', value: candidateScope },
    ], { column: 'priority', direction: 'asc' }, 500);
    for (const row of resp.rows ?? []) byId.set(row.id, row);
  }

  // Client-side safety net on the now-small merged set: expiry and tags have
  // no server-side filter here, and scopeIsReachable re-verifies the same
  // containment relationship the SQL layer already enforced.
  const candidates = [...byId.values()].filter(row =>
    typeSet.has(row.memory_type) &&
    !isExpired(row) &&
    scopeIsReachable(row.scope, expandedScopes) &&
    tagsMatch(row.tags, tags)
  );

  // Sort: priority ASC, type order, created_at DESC
  candidates.sort(byPriorityTypeThenDate);

  // Greedy budget selection — skip (not stop at) any memory that doesn't fit,
  // so a single oversized high-priority memory can't block smaller,
  // lower-priority ones behind it.
  const selected = [];
  let usedTokens = 0;
  for (const row of candidates) {
    if (usedTokens + row.token_estimate > budgetTokens) continue;
    selected.push(row);
    usedTokens += row.token_estimate;
  }
  return selected;
}
```

A memory row is only ever returned by a candidate query whose scope contains
it — a row scoped to `{"domain":"flashcards"}` comes back from the
`{"domain":"flashcards"}` and `{"domain":"flashcards","workflow":"add_entity"}`
candidates, never from `{"topic":"conventions"}` or `{}`. A globally-scoped
row (`{}`) is contained by every candidate, so it is returned by all of them —
`byId` deduplicates by `id` before the client-side filters run.

`scopeIsReachable(memScope, expandedScopes)` returns true when `memScope` is a
subset of any scope in `expandedScopes` — the same relationship
`jsonb_contained_by` checks in SQL, kept here as a second, cheap verification
pass over the already-narrowed candidate set. An empty `memScope` (`{}`) is
always reachable.

#### Worked example: 4 candidate queries for one retrieval call

For `retrieveMemories({ scope: { domain: "flashcards", workflow: "add_entity" }, memoryTypes: ["semantic"], budgetTokens: 400 })`:

| # | Candidate scope | SERV `getRows` filters | Matches |
|---|---|---|---|
| 1 | `{"domain":"flashcards","workflow":"add_entity"}` | `memory_type IN ["semantic"]`, `scope <@ {"domain":"flashcards","workflow":"add_entity"}` | rows scoped exactly to this workflow |
| 2 | `{"domain":"flashcards"}` | `memory_type IN ["semantic"]`, `scope <@ {"domain":"flashcards"}` | the `schema_snapshot`/`insert_expectations` row written by `create_domain` |
| 3 | `{"topic":"conventions"}` | `memory_type IN ["semantic"]`, `scope <@ {"topic":"conventions"}` | cross-cutting conventions, if any |
| 4 | `{}` | `memory_type IN ["semantic"]`, `scope <@ {}` | globally-scoped memories only |

Four small, filtered queries, each scoped to exactly the rows that can
possibly matter. None of them ever fetch the `episodic` `run_complete` rows
written by unrelated workflow runs — `memory_type IN ["semantic"]` excludes
those at the SQL level before scope containment is even evaluated, regardless
of how large `PGC_Memory` grows.

### 6.2 Memory injection format

Retrieved memories are appended to the assembled system instructions after all
`PGC_SystemContext` substitutions:

```
--- MEMORY ---

[Workflow design intent]
- Preserve human_gate at step 3 — user confirmed ingredient review is critical.

[Domain design decisions and conventions]
- Schema snapshot for flashcards (confirmed): PGD_Cards: SQL defaults, db sets: ease_factor(2.5)...
  null at creation, omit from insert: next_review_date, last_reviewed_at.

[Recent activity]
- Completed workflow 'quiz_flashcards' for domain 'flashcards'.

--- END MEMORY ---
```

The block is omitted entirely when no memories are retrieved.

### 6.3 Token budgets per prompt (`PGC_Prompt.memory_config`)

```json
{
  "memory_budget_tokens": 600,
  "memory_types": ["semantic"],
  "scope_additions": { "domain": "{{input.domain}}" }
}
```

**Live configurations:**

| Prompt | Budget | Types | Notes |
|---|---|---|---|
| `research_workflow_domain` | 600 | semantic | Domain design decisions for research context |
| `generate_workflow_steps` | 800 | semantic, procedural | `scope_additions: { domain: "{{input.domain}}" }` |
| `fix_workflow_steps` | 800 | semantic, procedural | Retrieves workflow design intent for repair context |
| `parse_entity_input` | 800 | semantic | Domain insert expectations for data loads ← Sprint 4; raised from 400 in Sprint 7 (flashcards' own schema_snapshot alone is 664 tokens) |
| All other prompts | 0 | — | Memory disabled |

`memory_budget_tokens: 0` completely disables memory injection.

`scope_additions` merges extra keys into the derived call scope. For
`generate_workflow_steps`, adding `domain` ensures domain semantic memories
(written by `create_domain`) are retrieved even though the scope defaults to
`{ domain, workflow: create_workflow }` — which scope expansion already handles —
but `scope_additions` makes the domain explicit when it comes from `input.domain`
rather than `run.input.domain`.

---

## 7. initial_value_conventions

`initial_value_conventions` is an optional array emitted by `create_domain`,
`design_table`, and `revise_domain_schema` LLMs. It captures application-level
initial values that cannot be fully described by column type + nullable flag + SQL DEFAULT.

### 7.1 When to emit

Only for cases that add information beyond what the column definition already states:

| Case | Example | What to emit |
|---|---|---|
| Nullable column that must be null at creation because a later workflow sets it | `next_review_date` in PGD_Cards | `{ table: "PGD_Cards", column: "next_review_date", convention: "null at creation — quiz workflow sets on first review" }` |
| SQL DEFAULT that differs from the correct application starting value | `interval_days` has DEFAULT 0 but SM-2 first interval is 1 | `{ table: "PGD_Cards", column: "interval_days", convention: "first review interval is 1, not SQL default 0" }` |

Do NOT emit for columns whose type and SQL DEFAULT fully describe the intent
(e.g. `ease_factor NUMERIC DEFAULT 2.5` — the SQL DEFAULT is correct and complete).

### 7.2 How it flows

```
create_domain LLM (step 10/12b/13)
  → emits initial_value_conventions in proposed_scaffold
  → step 16b js_transform reads proposed_scaffold.initial_value_conventions
  → included in domain_semantic_content string
  → step 16c write_memory persists to PGC_Memory

create_workflow LLM calls
  → memory_config retrieves domain semantic memories
  → memory block injected includes initial_value_conventions text
  → LLM designs workflow steps that handle initial state correctly

parse_entity_input (add_entity / classify-intent data loads)
  → memory_config retrieves domain semantic memories (400 tokens)
  → memory block injected includes schema_snapshot and initial_value_conventions
  → Prompt instruction: "apply initial-value conventions to fields not in user input"
  → LLM omits null-at-creation columns; applies stated initial values
```

The conventions flow through the memory layer — not as explicit input parameters.
This means any LLM call that retrieves domain memories automatically benefits without
workflow-specific changes.

---

## 8. LLM Harness (`llm-harness.mjs`)

### 8.1 What it does

`llm-harness.mjs` is the centralised assembly point for everything a LLM call needs.
Extracted from `step-executor.mjs` in Sprint 3. Not in `src/shared/` because it
requires SERV calls (memory retrieval, session writes).

**Responsibilities:**
1. Load `PGC_Prompt` row by `intent_category`
2. Load `PGC_SystemContext` rows
3. Resolve model alias (`smart`, `cheap` → concrete model ID)
4. Retrieve memories via `memory-client.mjs` when `memory_budget_tokens > 0`
5. Assemble system instructions (prompt_text + SystemContext + memory block)
6. Append `reasoning` instruction when `save_to_memory` is set
7. Call LLM (with truncation resumption and parse-error correction loop)
8. Extract and strip `reasoning` field before schema validation
9. Validate output via `review-output.mjs`
10. Write memory from `reasoning` if `save_to_memory` is set
11. Write diagnostics session (non-blocking, when enabled)

### 8.2 Context assembly order

```
instructions = resolveTemplate(promptRow.prompt_text, localState)
               + formatSystemContext(inject_always rows)
               + formatSystemContext(inject_for rows matching intentCategory)

// Memory retrieval
if (memoryBudget > 0) {
  memories = retrieveMemories({ scope, budgetTokens, memoryTypes })
  instructions += formatMemoryBlock(memories)  // appended after all context substitution
}

// Reasoning instruction appended last when save_to_memory is set
if (saveMemCfg) {
  instructions += '\n\nAlso include a "reasoning" field...'
}

userMessage = resolveTemplate(step.input.user_input, localState)
           ?? JSON.stringify(resolvedInput)
```

### 8.3 Model alias resolution

`PGC_SystemContext` row with `key: "llm_model_aliases"` stores:
```json
{ "smart": "anthropic/claude-sonnet-4-5", "cheap": "perplexity/sonar" }
```

`PGC_Prompt.model` stores either a literal model ID (pinned) or an alias.
The harness resolves at call time. When a new model ships, update one
SystemContext row — all aliased prompts upgrade automatically.

---

## 9. Token Budget Management

### 9.1 Cost structure

At Perplexity gateway pricing (~$3/M input, $15/M output for claude-sonnet-4-5):

| Component | Typical tokens | Cost per call |
|---|---|---|
| Base prompt (`generate_workflow_steps`) | ~1200 | $0.0036 |
| SystemContext inject_always | ~300 | $0.0009 |
| Memory block (800-token budget) | 0–800 | $0–$0.0024 |
| SystemContext inject_for | ~200 | $0.0006 |
| User message | ~100 | $0.0003 |
| LLM response (output) | ~1500 | $0.0225 |
| **Total (max budget used)** | **~4100** | **~$0.028** |

At 10 heavy-lift calls/day: $0.28/day → ~$8.5/month. Within the $8–13 envelope.

### 9.2 `token_estimate` accuracy

`Math.ceil(content.length / 4)` is a ~10% rough estimate (character count / 4).
Intentionally conservative — actual token count is usually lower.

---

## 10. Mode 4 — The Agentic Loop (Deferred — Sprint 5)

The SQS WorkflowQueue already implements a distributed Mode 4 loop. The additions
deferred to Sprint 5:

- **History threading within a workflow run**: `use_run_history` on `llm_call` steps
  enabling prior turns within the same run to be threaded into the messages array
  (`PGC_SessionEntry` rows, budget-aware reconstruction)
- **Novia /chat Mode 4**: Agentic while-loop with tool use (`PGC_Capability` rows),
  persona memory, write-tool confirmation gates

See `docs/arch-session.md` for the full session and history threading design.

---

## 11. LLM Model Management

### 11.1 Model aliases in PGC_SystemContext (live)

```json
{
  "key": "llm_model_aliases",
  "content": {
    "smart": "anthropic/claude-sonnet-4-5",
    "cheap": "perplexity/sonar"
  }
}
```

`PGC_Prompt.model` stores either a literal model ID (pinned) or an alias.
Alias update = one SystemContext row update via `upsert-system-context.mjs`.

Pinned prompts (literal IDs) require manual review before upgrading.

---

## 12. Practical Examples

### Example 1: create_domain → create_workflow memory bridge

```
create_domain runs for "flashcards"

  Step 10: create_domain LLM designs schema
    → save_to_memory: EPISODIC, tags: [domain_design, initial_design_reasoning]
    → Content: LLM reasoning about why next_review_date is nullable, why
      ease_factor starts at 2.5, etc.

  Step 16b: js_transform builds structural snapshot
    → "Schema snapshot for flashcards (confirmed): PGD_Cards: SQL defaults, db
       sets: ease_factor(2.5), interval_days(0)... null at creation, omit from
       insert: next_review_date, last_reviewed_at. Application initial-value
       conventions: PGD_Cards.interval_days: first review interval is 1..."

  Step 16c: write_memory — SEMANTIC, tags: [schema_snapshot, insert_expectations]
    → Priority 2 — highest-priority domain memory

create_workflow runs for "quiz_flashcards" in flashcards domain

  Step 21 (design_workflow_process):
    memory_config: { budget: 600, types: [semantic] }
    → scope: { domain: flashcards, workflow: create_workflow }
    → expandScope: includes {"domain":"flashcards"}
    → Retrieves schema_snapshot row
    → Memory block injected: LLM now knows next_review_date is null at creation

  Step 23 (generate_workflow_steps):
    memory_config: { budget: 800, types: [semantic, procedural] }
    → Same retrieval path
    → Step generator designs quiz steps that correctly query by
      "next_review_date IS NULL OR next_review_date <= NOW()"
      rather than assuming it is always populated
```

### Example 2: classify-intent data load respects schema expectations

```
User: "/m add flashcard front=¿Cómo estás? back=How are you?"

classify-intent → add_entity workflow
  → parse_entity_input LLM call
    memory_config: { budget: 800, types: [semantic] }
    → scope: { domain: flashcards, workflow: add_entity }
    → expandScope: includes {"domain":"flashcards"}
    → Retrieves schema_snapshot row
    → Memory block includes:
      "null at creation, omit from insert: next_review_date, last_reviewed_at"
      "Application initial-value conventions: interval_days: first review interval is 1"

  → LLM output:
    { root: { front_text: "¿Cómo estás?", back_text: "How are you?",
              interval_days: 1 } }
    (next_review_date omitted — correctly left to the quiz workflow to set)

  → serv_entity_insert writes row with interval_days=1, next_review_date=null
```

### Example 3: fix_workflow using procedural memory

```
fix_workflow runs on broken quiz_flashcards workflow

  → harness scope: { workflow: "quiz_flashcards" }
  → procedural memory retrieved:
    "Preserve the human_gate at step 3 — user confirmed the review confirmation
     gate is the core UX of the quiz loop"
  → Repair LLM does not remove the confirmation gate
```

### Example 4: Additive schema revision memories

```
create_domain for "recipes" — user iterates design three times:

  Step 10: episodic write (initial design reasoning)
  Step 12b (revision 1 — "add a cost column"): semantic write, schema_expectations
  Step 12b (revision 2 — "make serving size optional"): semantic write, schema_expectations
  Step 12b (revision 3 — "add a notes field"): semantic write, schema_expectations
  Step 16c (confirmed): semantic write, schema_snapshot (definitive)

create_workflow for recipes domain:
  → retrieveMemories retrieves all four semantic rows (within 600-token budget)
  → Most recent revision memory appears first (created_at DESC)
  → schema_snapshot (priority 2) appears before schema_expectations (priority 3)
  → LLM sees the confirmed final schema first, then the revision history
```

---

## 13. SQS Scheduling and Table Management (Backlog)

### 13.1 EventBridge Scheduler

For memory maintenance beyond SQS delay limits:
- **Nightly**: Delete expired PGC_Memory rows (`expires_at < NOW()`)
- **Weekly**: Consolidate accumulated semantic memories per domain (cheap sonar distillation)
- **User-requested**: One-time reminders, scheduled workflow runs

### 13.2 Table size management

| Table | Growth | Maintenance |
|---|---|---|
| PGC_Memory | 1 episodic/run + 3–5 semantic/domain creation | Episodic: TTL 90 days. Semantic/procedural: cleared by delete_domain/workflow. |
| PGC_WorkflowRun | 1/run | Archive to PGC_WorkflowRunArchive after 90 days |
| PGC_WorkflowRunStep | ~20/run | Cascade with PGC_WorkflowRun archival |

---

## 14. Implementation Status

| Item | Status | Sprint |
|---|---|---|
| `PGC_Memory` DDL, PGC_Schema/TableMap registration | ✅ Done | 3 |
| `write_memory` step type in step-executor.mjs | ✅ Done | 3 |
| `memory-client.mjs` — retrieveMemories, expandScope, formatMemoryBlock | ✅ Done | 3 |
| `llm-harness.mjs` — assembled from step-executor.mjs | ✅ Done | 3 |
| `memory_config` jsonb column on PGC_Prompt | ✅ Done | 3 |
| Model aliases in PGC_SystemContext | ✅ Done | 3 |
| `save_to_memory` on create_domain (step 10, 17b) and create_workflow (step 23) | ✅ Done | 3 |
| `MEMORY_WRITE` SQS type + `memory-writer.mjs` | ✅ Done | 3 |
| Two-layer domain memory (episodic pre-confirm, semantic post-confirm) | ✅ Done | 4 |
| `save_to_memory` on revise_domain_schema (step 12b) and design_table (step 13) | ✅ Done | 4 |
| `initial_value_conventions` in create_domain/design_table/revise_domain_schema prompts | ✅ Done | 4 |
| `parse_entity_input` memory_config (classify-intent data load path) | ✅ Done | 4 |
| `write_memory` schema in workflow-schema.json | ✅ Done | 4 |
| Targeted per-scope retrieval (`jsonb_contained_by` operator, no unscoped fetch) | ✅ Done | 7 |
| History threading within a workflow run | 🔲 Deferred | Sprint 5 |
| Novia /chat Mode 4 agentic loop | 🔲 Deferred | Sprint 5 |
| Memory consolidation (nightly sonar distillation) | 🔲 Deferred | Backlog |
| pgvector semantic retrieval | 🔲 Deferred | Backlog |
| EventBridge maintenance schedules | 🔲 Deferred | Backlog |
