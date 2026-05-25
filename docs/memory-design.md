
# Memory Layer — Architecture and Design

Version: 1.2  
Status: Design — pre-implementation  
Last updated: 2026-05-25

---

## 1. The Core Gap

Every LLM call in evolving-mind-ai currently starts with a blank slate: static
`PGC_SystemContext` rows and the current workflow's `local_state` (ephemeral,
dies with the run). There is nowhere for knowledge to accumulate and be retrieved
across runs, domains, and workflows.

The memory layer addresses this. It is a persistent store of insights from past
interactions that future LLM calls can draw on. The model is still stateless — the
harness is what creates the illusion of accumulated understanding by feeding it
progressively richer context.

**Key architectural constraint:** Memory must pay for itself. At household scale the
system targets $8–13/month total. Every memory retrieval adds tokens. The design
below is budget-aware at every step.

---

## 2. Three Memory Types

### 2.1 Episodic Memory — what happened

A distilled log of significant user activities. One record per meaningful event:
"User completed a Spanish flashcard session with 80% accuracy." "User reviewed
portfolio performance — down 3% this week." Each workflow run that touches user
data writes an episodic summary on completion.

**Primary consumer:** `/chat` companion awareness. When the user starts a chat
session, recent relevant episodes are injected so the LLM feels like it knows
the user's recent history without any explicit briefing.

**Decay policy:** Episodic records expire after a configurable TTL (default: 90
days). Old episodes are deleted by a nightly maintenance workflow (see backlog).

### 2.2 Semantic Memory — what was learned

Insights and design decisions produced by LLM interactions during workflow
generation and domain creation. When `create_domain` designs a schema, the
reasoning behind key structural decisions is stored scoped to that domain. When
`create_workflow` later runs for the same domain, those semantic memories are
injected — the second LLM inherits the first LLM's understanding.

**Primary consumer:** Workflow and domain generation. Eliminates the need to
re-explain domain context every time the user adds a workflow to an existing domain.

**Decay policy:** Semantic records are long-lived — they represent design decisions
that persist until the domain is deleted. Cleared by `delete_domain`.

### 2.3 Procedural Memory — why things work the way they do

Design intent and rationale behind existing workflows and prompts. Written when
`create_workflow` produces a workflow — what it is trying to accomplish, what
constraints shaped its structure, what alternatives were considered. Consumed by
`fix_workflow` and `troubleshoot_workflow` so the repair LLM understands what it
is trying to preserve.

**Primary consumer:** `fix_workflow`, `troubleshoot_workflow`. Prevents the repair
LLM from "fixing" the workflow into something that works but discards the user's
original intent.

**Decay policy:** Procedural records follow their parent workflow. Cleared when
the workflow is deleted.

---

## 3. PGC_Memory Schema

```sql
CREATE TABLE "PGC_Memory" (
  id               SERIAL PRIMARY KEY,
  memory_type      VARCHAR(20)   NOT NULL CHECK (memory_type IN ('episodic','semantic','procedural')),
  scope            JSONB         NOT NULL DEFAULT '{}',   -- see Section 4 for taxonomy
  content          TEXT          NOT NULL,
  tags             JSONB         NOT NULL DEFAULT '[]',   -- string array for retrieval matching
  priority         INTEGER       NOT NULL DEFAULT 5,       -- 1 (highest) to 10 (lowest)
  token_estimate   INTEGER       NOT NULL DEFAULT 0,       -- pre-computed; ceil(content.length / 4)
  source_run_id    INTEGER       NULL REFERENCES "PGC_WorkflowRun"(id) ON DELETE SET NULL,
  source_workflow  VARCHAR(100)  NULL,
  source_step      VARCHAR(50)   NULL,
  expires_at       TIMESTAMPTZ   NULL,                    -- NULL = never; set for episodic records
  embedding        FLOAT[]       NULL,                    -- future: pgvector 1536-dim
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX ON "PGC_Memory" USING GIN (scope);       -- multi-dimensional scope queries
CREATE INDEX ON "PGC_Memory" USING GIN (tags);         -- tag array queries
CREATE INDEX ON "PGC_Memory" (memory_type);
CREATE INDEX ON "PGC_Memory" (expires_at) WHERE expires_at IS NOT NULL;
```

**Why `scope` is jsonb, not text:**

A text scope like `domain:Recipes|workflow:add_recipe` must be string-parsed to
query individual dimensions, has no standard index for partial key lookup, and
cannot be extended without changing the parsing convention. A jsonb scope
`{"domain":"Recipes","workflow":"add_recipe"}` supports:

```sql
-- All memories for the Recipes domain regardless of workflow
WHERE scope @> '{"domain":"Recipes"}'

-- Global memories only
WHERE scope = '{}'

-- Domain + specific topic
WHERE scope @> '{"domain":"Recipes","topic":"schema_design"}'
```

The GIN index makes all three queries index-resident. New scope dimensions
(e.g. `topic`, `run_context`) are additive — no schema change required.

---

## 4. Memory Categorization and Scope Taxonomy

### 4.1 Scope patterns

| Scope JSONB | When to use | Example content |
|---|---|---|
| `{}` | Global — applies to all calls | "User prefers concise Slack replies" |
| `{"domain":"Recipes"}` | Domain-scoped — about a specific domain | "Junction table chosen for ingredients" |
| `{"workflow":"create_workflow"}` | Workflow-scoped — about a specific workflow's design | "Preserve human_gate at step 3 — user said ingredient confirmation is critical" |
| `{"domain":"Recipes","workflow":"add_recipe"}` | Compound — specific workflow within a domain | "add_recipe uses 3-step parse+confirm+write" |
| `{"topic":"conventions"}` | Cross-cutting topic — applies regardless of domain | "User always uses plural table names" |
| `{"topic":"persona"}` | User preferences about the AI companion | "User's name is Javier. Companion is called Novia." |
| `{"domain":"Recipes","topic":"schema_design"}` | Domain + topic — design decisions for a domain | "Rejected nested jsonb for ingredients to allow ingredient-centric queries" |

### 4.2 Retrieval scope expansion

When the harness retrieves memories before a LLM call, it expands the call scope
to include all parent scopes. For a call with scope
`{"domain":"Recipes","workflow":"add_recipe"}`, the retrieval queries:

```
1. {"domain":"Recipes","workflow":"add_recipe"}  — most specific
2. {"domain":"Recipes"}                           — domain-level
3. {"topic":"conventions"}                        — cross-cutting conventions
4. {}                                             — global
```

User preferences (`{"topic":"persona"}`) are always included for `/chat` calls.
They are excluded from generation workflows (create_domain, create_workflow) where
persona context adds cost without benefit.

### 4.3 Standard tag vocabulary

Tags are a supplemental filter on top of scope. Scope answers "where does this
memory live?" Tags answer "what is it about?" A memory can match by scope but be
excluded by a tag filter.

| Tag | Meaning | Memory types |
|---|---|---|
| `schema` | Table/column design decisions | semantic |
| `design_decision` | Any explicit choice between alternatives | semantic, procedural |
| `constraint` | A system or domain constraint the LLM should respect | semantic, procedural |
| `workflow_intent` | What a workflow is designed to accomplish | procedural |
| `user_preference` | Explicit user preferences ("I always want confirmation gates") | semantic, global |
| `convention` | Naming and style conventions the user has established | semantic, global |
| `persona` | Companion name, user name, relationship style | episodic, global |
| `activity` | Recent user activity for companion awareness | episodic |
| `error_pattern` | A failure that occurred and why | procedural |
| `performance` | Query speed, workflow latency observations | episodic |

### 4.4 Memory hierarchy — which memory wins

When multiple memories match the same scope, the harness applies this priority
order (lower number = higher priority, injected first):

```
1. priority column (1–10) — set at write time; procedural memories for the active
   workflow get priority 1; global conventions get priority 3; recent episodes get 5
2. memory_type: procedural > semantic > episodic (for generation calls)
              episodic > semantic > procedural (for /chat companion calls)
3. created_at DESC — more recent memories within same priority and type
```

The `memory_type` ordering is reversed between generation and companion contexts
because a workflow repair call needs design rationale (procedural) most urgently,
while a companion `/chat` call needs recent activity (episodic) first.

### 4.5 Memory consolidation (backlog)

When multiple semantic memories about the same domain topic accumulate (e.g. ten
"schema design" memories for Recipes as the domain evolves), the right brain can
consolidate them: one nightly job queries memories older than 30 days with scope
`{"domain":X}` and `tags @> '["schema"]'`, runs a cheap sonar call to distil them
into one consolidated record, and deletes the originals. The consolidated record
gets a lower `priority` number (higher importance) because it represents durable
knowledge vs transient observations.

---

## 5. Memory Writing

### 5.1 When memories are written

| Trigger | Type | Scope | Who writes |
|---|---|---|---|
| `create_domain` completes | semantic | `{"domain":"<name>"}` | `write_memory` step at end of workflow |
| `create_workflow` completes | procedural | `{"workflow":"<name>"}` | `write_memory` step at end of workflow |
| Any domain workflow run completes | episodic | `{"domain":"<name>"}` | fire-and-forget `MEMORY_WRITE` SQS message |
| User states a preference via `/chat` | semantic | `{}` global | `/chat` agent writes via `write_memory` tool |
| `/chat` persona set ("call me Javier") | semantic | `{"topic":"persona"}` | `/chat` agent writes immediately |
| `delete_domain` runs | — | — | DELETE WHERE scope @> `{"domain":"<name>"}` |
| `delete_workflow` runs | — | — | DELETE WHERE scope @> `{"workflow":"<name>"}` |

### 5.2 The `write_memory` step type

New step type in `step-executor.mjs`:

```json
{
  "step": "99",
  "type": "write_memory",
  "description": "Persist LLM reasoning as a reusable memory record",
  "input": {
    "memory_type": "semantic",
    "scope":       {"domain": "{{input.domainName}}"},
    "content_key": "design_reasoning",
    "tags":        ["schema", "design_decision"],
    "priority":    2
  },
  "output_key": "memory_written",
  "on_success": "end",
  "on_failure": "end"
}
```

`content_key` points to a `local_state` key whose value is a plain-text string.
`scope` values support `{{template}}` substitution. `token_estimate` is computed
as `Math.ceil(content.length / 4)` — no API call needed.

**Critical constraint:** `write_memory` must always be the last step, after
`notify`. Failure logs but never fails the run (`on_failure: "end"` always).

### 5.3 Fire-and-forget episodic writes

Domain workflow completions produce episodic memories via a `MEMORY_WRITE` SQS
message enqueued by `run-workflow.mjs` — not a workflow step. This keeps
user-facing workflows free of memory infrastructure:

```js
// run-workflow.mjs — on run completion
if (run.status === 'completed' && shouldWriteEpisodicMemory(run)) {
  await enqueueWorkflow({
    type: 'MEMORY_WRITE',
    runId: run.id,
    workflowName: run.workflow_name,
    domain: run.input?.domain ?? null,
  });
}
```

`memory-writer.mjs` (new PROC endpoint) handles `MEMORY_WRITE` messages.
For simple CRUD runs, a `js_transform`-style distillation generates the summary
deterministically (zero LLM cost). For rich multi-step runs with `reasoning`
fields in `local_state`, a cheap sonar call distils to 2–3 sentences.

### 5.4 Memory content from reasoning fields

The `reasoning` field already captured by the session diagnostics design is the
raw material for semantic and procedural memories. The `write_memory` step takes
`content_key` pointing to a `reasoning` value in `local_state` populated by an
upstream `llm_call` step. Semantic/procedural memory creation costs zero
additional LLM calls — the cost is already paid by the generation call.

---

## 6. Memory Retrieval

### 6.1 Retrieval algorithm

```js
async function retrieveMemories({ scope, tags, budgetTokens, memoryTypes, callContext }) {
  // Step 1: Expand scope to all parent levels
  const scopes = expandScope(scope);
  // e.g. {"domain":"Recipes","workflow":"add_recipe"}
  // → [{"domain":"Recipes","workflow":"add_recipe"}, {"domain":"Recipes"},
  //    {"topic":"conventions"}, {}]
  // For /chat calls: also include {"topic":"persona"}

  // Step 2: Query with GIN containment across all expanded scopes
  // WHERE (scope @> $1 OR scope @> $2 OR ...)
  //   AND ($tags IS NULL OR tags @> $tags::jsonb)
  //   AND (expires_at IS NULL OR expires_at > NOW())
  //   AND memory_type = ANY($memoryTypes)
  // ORDER BY priority ASC,
  //   CASE memory_type WHEN 'procedural' THEN 0 WHEN 'semantic' THEN 1 ELSE 2 END,  -- generation context
  //   created_at DESC
  const rows = await getRows('PGC_Memory', { scopes, memoryTypes, tags });

  // Step 3: Budget-aware selection — greedy from highest priority
  const selected = [];
  let usedTokens = 0;
  for (const row of rows) {
    if (usedTokens + row.token_estimate > budgetTokens) break;
    selected.push(row);
    usedTokens += row.token_estimate;
  }
  return selected;
}
```

### 6.2 Memory injection into prompts

Retrieved memories are injected as a named block in the system prompt, between
`PGC_SystemContext` inject_always and inject_for rows:

```
[inject_always system context]

--- MEMORY ---
[User preferences and conventions — global scope memories, always first]
User preferences:
- User's name is Javier. Respond warmly but concisely.
- User always uses plural table names for domains.

[Domain design decisions — domain-scoped semantic memories]
Domain: Recipes
- Junction table PGD_RecipeIngredients: many-to-many, allows ingredient queries.

[Workflow design intent — workflow-scoped procedural memories]
Workflow: add_recipe
- Preserve human_gate at step 3 — user confirmed ingredient review is critical.
--- END MEMORY ---

[inject_for system context — matching current intent_category]
```

The block is omitted entirely when no memories are retrieved. The ordering
(preferences first, then design decisions, then procedural intent) ensures the
LLM reads the most broadly applicable context before the narrowly specific.

### 6.3 Token budget by call type

Configured per `PGC_Prompt.memory_config` (new optional jsonb column):

```json
{
  "memory_budget_tokens": 600,
  "memory_types": ["semantic", "procedural"],
  "include_persona": false
}
```

Default budgets when `memory_config` is absent:

| Call type | Budget | Types | Include persona |
|---|---|---|---|
| `create_workflow` | 800 tokens | semantic, procedural | no |
| `fix_workflow` | 600 tokens | procedural | no |
| `create_domain` | 400 tokens | semantic | no |
| `/chat` Novia | 500 tokens | episodic, global | yes |
| Intent classification | 0 | — | no |
| Generic CRUD steps | 0 | — | no |

`memory_budget_tokens: 0` completely disables memory injection for that prompt.

### 6.4 Phase 2 — pgvector semantic retrieval (backlog)

Scope + tag matching (Phase 1) is deterministic and zero-cost. Phase 2 adds
vector similarity when a memory doesn't match exact scope:

```
After scope query miss: embed user input (text-embedding-3-small, 1536 dim)
  → ORDER BY embedding <-> query_embedding LIMIT 10
  → Merge with Phase 1, deduplicate, re-rank
```

pgvector is already on the roadmap. Enabling it for `PGC_Memory` is one `ALTER
TABLE` when the extension is active.

---

## 7. Token Budget Management — End to End

### 7.1 What tokens cost

Every LLM call charges for input tokens (everything sent) and output tokens
(the response). The harness assembles input from multiple sources, each with
a token cost that must be tracked:

```
Total input tokens = base_prompt + system_always + memory_block
                   + system_inject_for + run_history + user_message

Total cost (USD) = (total_input / 1_000_000) × model_input_price
                 + (output_tokens / 1_000_000) × model_output_price
```

At Perplexity anthropic/claude-sonnet-4-6 pricing (~$3/M input, $15/M output):

| Component | Typical tokens | Cost per call |
|---|---|---|
| Base prompt (generate_workflow_steps v22) | ~1200 | $0.0036 |
| SystemContext inject_always | ~300 | $0.0009 |
| Memory block (600-token budget) | 0–600 | $0–$0.0018 |
| SystemContext inject_for | ~200 | $0.0006 |
| Run history (2000-token budget) | 0–2000 | $0–$0.006 |
| User message | ~100 | $0.0003 |
| LLM response (output) | ~1500 | $0.0225 |
| **Total (max budget used)** | **~5900** | **~$0.034** |

At 10 heavy-lift calls/day: $0.34/day → ~$10/month. Within the $8–13 envelope
when combined with the low-cost classification calls (sonar at ~$0.001 each).

### 7.2 The `memory_config` field on PGC_Prompt

```sql
ALTER TABLE "PGC_Prompt" ADD COLUMN memory_config JSONB NULL;
```

Full schema:

```json
{
  "memory_budget_tokens":  600,
  "memory_types":          ["semantic", "procedural"],
  "include_persona":       false,
  "scope_override":        null,
  "tags_filter":           ["design_decision"],
  "history_budget_tokens": 2000,
  "history_steps":         null
}
```

| Field | Default | Meaning |
|---|---|---|
| `memory_budget_tokens` | 500 | Max tokens for the memory injection block |
| `memory_types` | all types | Which memory types to retrieve |
| `include_persona` | false | Whether to include `{"topic":"persona"}` memories |
| `scope_override` | null | Use a fixed scope instead of the call-time scope |
| `tags_filter` | null | Only retrieve memories matching these tags |
| `history_budget_tokens` | 2000 | Max tokens for run history injection |
| `history_steps` | null | Specific step IDs to include from history (null = all) |

### 7.3 Budget overflow — what gets cut

When the assembled context would exceed the model's context window
(e.g. 8192 tokens for sonar, 200k for claude-sonnet), the harness cuts in
this order (least important first):

```
1. Run history — trim from oldest turns first
2. Memory block — trim lowest-priority memories first (highest priority number)
3. inject_for system context — never cut (small, always important)
4. Memory block to zero — if still over, memory is completely suppressed
5. Base prompt + inject_always — never cut (these define the task)
```

The base prompt is never sacrificed. If even removing all optional context
doesn't fit, the harness throws a `context_window_overflow` error that fails
the step with a clear message, rather than silently sending a truncated prompt
that produces hallucinated output.

### 7.4 token_estimate accuracy

`token_estimate = Math.ceil(content.length / 4)` is a ~10% rough estimate
(character count / 4 approximates GPT tokenisation). It is intentionally
conservative — the actual token count is usually slightly lower, so budgets
have natural headroom. Exact tokenisation via the tiktoken library is not used
because it adds a Lambda dependency for marginal accuracy gain at household scale.

For the budget overflow guard in Section 7.3, the harness does a final sum of all
estimated tokens before sending. If the sum exceeds 80% of the model context
window, the overflow trimming kicks in. The 80% threshold gives the response room
to breathe — most responses are 1–2k tokens, well within the remaining 20%.

---

## 8. Mode 4 — The Agentic Loop

### 8.1 How evolving-mind-ai already implements Mode 4

The four LLM interaction modes:

| Mode | Description | Current usage |
|---|---|---|
| 1 | Stateless single-shot | Every `llm_call` step today |
| 2 | Stateful chat (managed history) | `/chat`, `/explain` (session design doc) |
| 3 | Extended thinking / reasoning | Not used — Perplexity gateway limitation |
| 4 | Agentic loop — model drives tool selection and iteration | SQS WorkflowQueue IS the loop |

The SQS WorkflowQueue already implements a distributed Mode 4 loop:

| Agent harness concept | evolving-mind-ai equivalent |
|---|---|
| `while (model wants to use a tool)` | SQS messages driving the execution stack |
| One loop iteration | One `WORKFLOW_STEP execute_top` SQS message |
| Tool execution | `serv_query`, `serv_insert`, `human_gate`, etc. |
| `messages.append(tool_results)` | `local_state[step.output_key] = result` |
| Loop checkpoint (crash recovery) | `PGC_WorkflowRun.stack` + `state` persisted each step |
| Human-in-the-loop interrupt | `human_gate` step type |
| Loop terminates | `end` step type |

**What's currently missing vs a full Mode 4 harness:** The messages array is not
threaded between `llm_call` steps in the same run. Each step calls with a fresh
context. A later step cannot see the LLM's reasoning from an earlier step unless
copied explicitly via `js_transform`. This is the "cross-LLM pollination" gap.

### 8.2 History threading within a workflow run

`use_run_history: true` on an `llm_call` step opts in to seeing prior turns in
the same run:

```json
{
  "step": "3",
  "type": "llm_call",
  "input": {
    "prompt": "generate_workflow_steps",
    "use_run_history": true,
    "userInput": "{{input.userInput}}"
  }
}
```

When set, the harness:
1. Looks up the session created at run start (created when any step sets `use_run_history`)
2. Reconstructs the messages array from `PGC_SessionEntry` rows (budget-aware)
3. Calls `callLlmWithMessages` instead of `callLlm`

### 8.3 Token management for long agentic loops

Three techniques in order:

**Technique 1 — Selective history.** Declare which prior steps matter:
```json
"use_run_history": { "include_steps": ["1", "2a"] }
```

**Technique 2 — Budget-aware reconstruction.**

```js
function reconstructHistory(entries, budgetTokens) {
  const system = entries.find(e => e.role === 'system');
  const rest   = [...entries.filter(e => e.role !== 'system')].reverse();
  const selected = [];
  let used = system ? tokenEstimate(system.content) : 0;
  for (const entry of rest) {
    if (used + entry.token_estimate > budgetTokens) break;
    selected.unshift(entry);
    used += entry.token_estimate;
  }
  return [system, ...selected].filter(Boolean);
}
```

Default: 2000 tokens for prior history. Combined with memory (≤800) and base
system prompt, context overhead stays under ~3200 tokens per call.

**Technique 3 — Compression (backlog).** When reconstruction still truncates
more than 2 turns, a cheap sonar call summarises the oldest block. The summary
replaces the dropped turns in `PGC_SessionEntry` as a `is_compressed: true` row.

### 8.4 Prioritized context — what the LLM sees

For any `llm_call` step, the assembled context in order of influence:

```
1. System prompt     (PGC_Prompt.prompt_text, filled via template resolver)
2. inject_always     (PGC_SystemContext rows)
3. Memory block      (retrieved via Section 6)
4. inject_for        (PGC_SystemContext rows matching current intent_category)
5. Run history       (PGC_SessionEntry rows, budget-aware, if use_run_history)
6. User message      (the input)
```

Items 1–4 are always present (within their budgets). 5 and 6 depend on step
configuration. Base prompt instructions dominate and cannot be overridden by
memory or history content.

---

## 9. /chat as a Mode 4 Agentic Companion (Novia)

### 9.1 What changes vs the current /chat design

The current session design (`docs/session-chat-design.md`) specifies `/chat` as
Mode 2 (managed history). That is a good MVP. The evolution is Mode 4: the
companion doesn't just answer questions — it can take actions on the user's behalf
using the same tool set the workflow engine uses. The distinction:

| Current /chat (Mode 2) | Novia /chat (Mode 4) |
|---|---|
| Answers questions from context | Answers questions AND takes action |
| No tool use | Tool use: serv_query, fix_workflow, write_memory, etc. |
| Stateless between turns except session history | Stateless, but with full memory layer access |
| No persona | Persona configurable (Novia, named user) |
| One LLM call per turn | While-loop per turn until no tool use |

### 9.2 The Novia persona

Persona is a user-configurable companion identity stored in `PGC_Memory` with
scope `{"topic":"persona"}`. Example records written on first interaction:

```json
{ "memory_type": "semantic", "scope": {"topic":"persona"},
  "content": "User's name is Javier. Address the user as Javier in all responses.",
  "tags": ["persona"], "priority": 1 }

{ "memory_type": "semantic", "scope": {"topic":"persona"},
  "content": "Companion name is Novia. The user calls the assistant Novia. Sign responses accordingly.",
  "tags": ["persona"], "priority": 1 }
```

When the user says `/chat Please call me Javier and I'll call you Novia`, the
`/chat` handler detects the persona-setting intent and writes these memories
before the first reply. On all subsequent calls (chat and otherwise), persona
memories are injected when `include_persona: true` in the prompt's `memory_config`.

Persona memories are never injected into generation workflows (`create_workflow`,
`create_domain`) — the LLM designing your schema doesn't need to know your name.

### 9.3 Novia's tool set

The Mode 4 `/chat` handler defines a tool set from registered `PGC_Capability`
rows. The while loop iterates until the LLM returns a text-only response:

```
User: /chat Novia, please fix the add_recipe workflow — the ingredient
             iterator isn't looping correctly.

Novia loop iteration 1:
  Tool call: get_workflow { name: "add_recipe" }
  → Returns: PGC_Workflow.steps JSON

Novia loop iteration 2:
  Tool call: get_memories { scope: {"workflow":"add_recipe"} }
  → Returns: procedural memory: "user confirmed ingredient gate is intentional"

Novia loop iteration 3:
  Tool call: analyze_workflow { workflow: <steps> }
  → Returns: L1 static analysis — finds dead iterator routing

Novia loop iteration 4:
  Tool call: propose_fix { workflow: <steps>, issue: "iterator routing" }
  → Returns: corrected steps

Novia loop iteration 5: (no tool use)
  Text response: "I found the issue — the iterator's on_success routes to 'end'
  instead of continuing the loop. I've prepared a fix. Want me to apply it?"

  [Human gate — user confirms]

Novia writes: fix applied to PGC_Workflow
```

**Novia's available tools (PGC_Capability rows):**

| Tool key | What it does | Underlying call |
|---|---|---|
| `get_workflow` | Fetch a workflow by name | SERV getRows PGC_Workflow |
| `list_workflows` | List all workflows (optionally filtered by domain) | SERV getRows PGC_Workflow |
| `get_domain_schema` | Fetch all tables and columns for a domain | SERV getRows PGC_Schema |
| `list_domains` | List all registered domains | SERV getRows PGC_DomainHelp |
| `analyze_workflow` | Run L1 static analysis | simulation-engine.mjs |
| `propose_workflow_fix` | Generate corrected steps via fix_workflow LLM | proc/fix-workflow.mjs |
| `apply_workflow_fix` | Persist corrected steps to PGC_Workflow | SERV updateRows + L1 guard |
| `get_prompt` | Fetch a prompt by intent_category | SERV getRows PGC_Prompt |
| `update_prompt` | Update prompt text or output_schema | SERV updateRows PGC_Prompt + upsert |
| `serv_query` | Execute a parameterised SELECT against any registered table | SERV getRows |
| `serv_insert` | Insert a row | SERV insertRow |
| `serv_update` | Update rows | SERV updateRows |
| `write_memory` | Persist a memory record | SERV insertRow PGC_Memory |
| `read_memory` | Query memories by scope + tags | SERV getRows PGC_Memory |
| `add_system_context` | Add or update a PGC_SystemContext entry | SERV upsert |

Each tool call is a PROC endpoint call (HTTP, following the existing tier boundary
rules). Novia never calls AWS SDK or directly imports pg — it uses the same
`serv-client.mjs` calls that workflows use.

### 9.4 Agentic loop harness for /chat

```js
// src/proc/chat.mjs — Mode 4 loop
export async function handle(req) {
  const session   = await getOrCreateSession(req);
  const tools     = await loadChatTools();         // PGC_Capability rows with tool=true
  const memories  = await retrieveMemories({ scope: {}, include_persona: true });
  const history   = await loadSessionHistory(session.id, { budgetTokens: 4000 });

  let messages = buildMessages({ memories, history, userMessage: req.body.userInput });

  // Mode 4 while loop
  while (true) {
    const response = await callLlmWithTools(model, messages, tools, traceId);

    if (!response.tool_calls?.length) {
      // Text-only response — done
      await appendSessionEntry(session.id, 'assistant', response.text);
      await enqueueCallback('HUMAN_NOTIFICATION', response.text, req.callback);
      break;
    }

    // Execute tool calls
    const toolResults = await Promise.all(response.tool_calls.map(executeToolCall));
    messages = [
      ...messages,
      { role: 'assistant', content: null, tool_calls: response.tool_calls },
      ...toolResults.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.result })),
    ];
  }
}
```

**Tool use requires a human gate before any write tool.** `apply_workflow_fix`,
`update_prompt`, `serv_insert`, `serv_update`, and `add_system_context` must
always produce a confirmation gate before executing. The harness enforces this —
write tools are marked `requires_confirm: true` in their `PGC_Capability` row, and
the loop intercepts them before execution.

### 9.5 What Novia enables (examples)

```
/chat Novia, I want all workflow step descriptions to follow the format
      "Verb + object + purpose". Please update create_domain to match.
→ Novia reads create_domain, lists all step descriptions, proposes rewrites,
  shows you a diff, you confirm, she applies.

/chat Remember: I prefer verbose Slack notifications — always include the
      number of records affected.
→ Novia writes a global semantic memory: { scope: {}, tags: ["user_preference"],
  content: "User prefers verbose notifications — include record counts." }

/chat Novia, what did I add to Recipes last week?
→ Novia calls serv_query on PGD_Recipes filtered by created_at > last week,
  formats the results, replies.

/chat Add a "notes" column to my Recipes domain.
→ Novia calls get_domain_schema, proposes the ALTER TABLE, confirms with you,
  calls serv_update / SERV-Schema addColumn endpoint.
```

---

## 10. The LLM Harness

### 10.1 What the harness is

The LLM harness is the centralized assembly point for everything a LLM call needs.
Currently this responsibility is split:

| Responsibility | Current location |
|---|---|
| API call mechanics | `src/shared/llm-client.mjs` |
| Prompt loading | `step-executor.mjs` (`llm_call` handler) |
| SystemContext injection | `step-executor.mjs` (`executeLlmCall`) |
| Correction loop | `step-executor.mjs` + `review-output.mjs` |
| Resumption on truncation | `step-executor.mjs` |
| Session write | `step-executor.mjs` (planned, not built) |
| Memory retrieval | **Not built** |
| History threading | **Not built** |
| Token budget enforcement | **Not built** |

The harness centralizes items 2–9 into a single function.

### 10.2 Location — `src/proc/llm-harness.mjs`

Not in `src/shared/` because it requires SERV calls (memory retrieval, session
writes). Not a Lambda handler — a proc-tier module imported by `step-executor.mjs`
and `chat.mjs`.

### 10.3 Function signature

```js
export async function executeLlmStep({
  intentCategory,   // PGC_Prompt.intent_category key
  promptRow,        // Pre-loaded PGC_Prompt row
  localState,       // Current frame local_state for template resolution
  traceId,
  runId,
  workflowName,
  stepId,
  scope,            // Memory scope jsonb object — e.g. { domain: 'Recipes' }
  memoryTags,       // Optional tag filter array
  useRunHistory,    // true | { include_steps: ['1', '2a'] } | false
  diagnosticsEnabled,
  systemContextRows,  // Pre-loaded PGC_SystemContext rows
}) → Promise<{ output: object, queryId: string|null }>
```

### 10.4 Context assembly order

```
instructions = ''

// 1. Base prompt (filled)
instructions += resolveTemplate(promptRow.prompt_text, localState)

// 2. inject_always system context
instructions += formatSystemContextBlock(systemContextRows.filter(r => r.inject_always))

// 3. Memory block (budget-trimmed, scope-expanded)
const memories = await retrieveMemories(scope, memoryConfig)
if (memories.length > 0) instructions += formatMemoryBlock(memories)

// 4. inject_for system context
instructions += formatSystemContextBlock(systemContextRows.filter(r =>
  r.inject_for?.includes(intentCategory)
))

// 5. History — becomes the messages array, not instructions
const history = useRunHistory
  ? await loadRunHistory({ runId, budgetTokens: memoryConfig.history_budget_tokens })
  : []

// 6. User message
const userMessage = resolveTemplate(promptRow.user_message_template, localState)

// 7. Overflow guard
enforceContextBudget({ instructions, history, userMessage, model: promptRow.model })

// 8. Call
const messages = [{ role: 'system', content: instructions }, ...history,
                  { role: 'user', content: userMessage }]
return callLlmWithMessages(promptRow.model, messages, traceId)
```

---

## 11. LLM Model Management

### 11.1 The problem

`PGC_Prompt.model` currently stores a literal model ID string (e.g.
`anthropic/claude-sonnet-4-6`). When a new model version ships:
- Every affected prompt row must be manually updated
- No record of what was changed or why
- No way to audit which prompts are on deprecated models
- "Soft-pinned" prompts (those where a specific model matters) look identical
  to "should-auto-upgrade" prompts

### 11.2 Model aliases in PGC_SystemContext

```json
{
  "key": "llm_model_aliases",
  "content": {
    "smart":    "anthropic/claude-sonnet-4-6",
    "cheap":    "perplexity/sonar",
    "fast":     "perplexity/sonar",
    "embed":    "openai/text-embedding-3-small"
  }
}
```

`PGC_Prompt.model` stores either a literal model ID (pinned) or an alias
(`smart`, `cheap`, `fast`). The harness resolves aliases at call time:

```js
const resolvedModel = modelAliases[prompt.model] ?? prompt.model;
```

**When a new model ships:**
1. Update the alias in `PGC_SystemContext` — one row update via
   `upsert-system-context.mjs`
2. All prompts using that alias automatically upgrade on the next call
3. Pinned prompts (literal model IDs) are unaffected — deliberate

**Alias conventions:**
- `smart` — best available Claude model for structured JSON generation
- `cheap` / `fast` — best sonar model for intent classification and episodic distillation
- Pinned (literal ID) — prompt has been tuned to a specific model's behaviour;
  needs manual review before upgrading

**Auditing deprecated models:**
```bash
node dev_scripts/audit-model-ids.mjs
# Lists all PGC_Prompt rows using literal model IDs that are not in the alias map
# Output: intent_category | model | version | last_used_at
```

This script is the single intervention point before a model is retired: find all
pinned prompts, test them against the replacement model, update.

### 11.3 Model capability registry (backlog)

When the model set expands beyond two providers, a `PGC_ModelRegistry` table
replaces the simple alias jsonb:

| Column | Purpose |
|---|---|
| `model_id` | Literal model identifier |
| `alias` | Short name used in PGC_Prompt.model |
| `context_window` | Max tokens (input + output) |
| `supports_json_schema` | Whether response_format is supported |
| `supports_history` | Whether messages array is honoured |
| `supports_tool_use` | Whether tool_calls are supported |
| `input_price_per_1m` | USD per million input tokens |
| `output_price_per_1m` | USD per million output tokens |
| `status` | `active` | `testing` | `deprecated` |

When `status = deprecated`, the harness logs a warning and refuses to call the
model — requiring an alias update first. This prevents silent usage of retired
models when aliases haven't been updated yet.

---

## 12. SQS Scheduling and Timers

### 12.1 SQS native delay

SQS supports a `DelaySeconds` parameter (0–900 seconds, max 15 minutes) on
individual messages. This is used for:
- Retry backoff in the workflow engine (short delays before re-enqueueing a failed step)
- Brief deferral of fire-and-forget operations like `MEMORY_WRITE`

### 12.2 EventBridge Scheduler for longer delays

For anything beyond 15 minutes, EventBridge Scheduler is the correct tool. It
supports one-time and recurring schedules with arbitrary future times, and targets
Lambda or SQS directly.

**Use cases in evolving-mind-ai:**

| Schedule | Trigger | Action |
|---|---|---|
| Nightly 2am UTC | EventBridge → PROC `maintenance` endpoint | Delete expired PGC_Memory rows; archive old PGC_WorkflowRun rows |
| Weekly Sunday | EventBridge → PROC `consolidate_memories` endpoint | Consolidate accumulated semantic memories per domain |
| User-requested reminder | EventBridge one-time → SQS MEMORY_WRITE | "Remind me about X in 3 days" |
| Scheduled workflow | EventBridge recurring → SQS CLASSIFY_INTENT | "Run my weekly portfolio review every Monday" |

**Architecture:** EventBridge Scheduler → `evolving-mind-ai-proc` Lambda directly
(scheduled tasks invoke the Lambda, not via API Gateway). The Lambda handler
detects scheduled events via `event.source === 'aws.scheduler'` and routes to a
maintenance handler.

**Storing user-requested schedules:** A new `PGC_Schedule` table (backlog) stores
user-created scheduled tasks:

```sql
CREATE TABLE "PGC_Schedule" (
  id               SERIAL PRIMARY KEY,
  schedule_name    VARCHAR(100) NOT NULL,
  cron_expression  VARCHAR(50)  NULL,    -- null for one-time
  one_time_at      TIMESTAMPTZ  NULL,
  workflow_name    VARCHAR(100) NULL,
  intent_text      TEXT         NULL,    -- natural language → classify at fire time
  callback         JSONB        NOT NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

Creating/deleting EventBridge Scheduler rules is a system operation performed by
the `manage_schedule` workflow. The SAM `LambdaExecutionRole` needs
`scheduler:CreateSchedule`, `scheduler:DeleteSchedule`, and
`scheduler:GetSchedule` permissions.

---

## 13. Table Size Management (Backlog)

Three tables grow unboundedly without maintenance. See `docs/backlog.md` for the
corresponding backlog items. Design intent here:

### PGC_Memory
- **Episodic records**: `expires_at` is set on write (90 days default). Nightly
  job: `DELETE WHERE expires_at < NOW()`.
- **Semantic/procedural records**: Deleted by `delete_domain` and
  `delete_workflow` cascades. No time-based expiry.
- **Corpus growth ceiling**: At most one episodic memory per domain workflow run,
  plus one semantic/procedural per domain/workflow creation. Household scale
  produces at most a few hundred records per year — no archival needed.

### PGC_WorkflowRun
- Completed/failed/cancelled runs older than 90 days are candidates for archival.
- Archival strategy: move to a `PGC_WorkflowRunArchive` table (same schema) so
  run history is preserved but queries against the active table remain fast.
- The `PGC_WorkflowStats` view only needs recent data; archived rows do not affect it.
- Nightly job: `INSERT INTO "PGC_WorkflowRunArchive" SELECT ... WHERE status != 'running'
  AND completed_at < NOW() - INTERVAL '90 days'; DELETE WHERE id IN (...)`

### PGC_WorkflowRunStep
- Grows proportionally to `PGC_WorkflowRun`. One row per step executed.
- Cascades with `PGC_WorkflowRun` via `ON DELETE CASCADE` — archiving the parent
  row must also archive/delete child step rows.
- The archive job must move `PGC_WorkflowRunStep` rows first before
  `PGC_WorkflowRun` rows (FK constraint order).
- Idempotency reliance: `PGC_WorkflowRunStep` is the idempotency guard for
  in-flight runs. Only rows whose parent run is in a terminal state
  (`completed`, `failed`, `cancelled`) are eligible for archival.

---

## 14. Practical Examples

### Example 1: create_domain → create_workflow knowledge flow

```
create_domain runs for "Recipes"
  → LLM designs schema with reasoning field
  → write_memory step at end:
    { type: 'semantic', scope: {"domain":"Recipes"},
      content: 'Junction table PGD_RecipeIngredients: many-to-many...',
      tags: ['schema', 'design_decision'], priority: 2 }

create_workflow runs for Recipes domain
  → harness scope: {"domain":"Recipes","workflow":"add_recipe"}
  → retrieveMemories() expands to check domain:Recipes + global
  → Memory block injected into generate_workflow_steps prompt
  → LLM knows junction table structure — produces correct iterator
```

### Example 2: fix_workflow using procedural memory

```
fix_workflow runs on broken add_recipe workflow
  → harness scope: {"workflow":"add_recipe"}
  → procedural memory retrieved:
    "human_gate at step 3 was explicitly requested by user — preserve it"
  → Repair LLM does not remove the confirmation gate
```

### Example 3: Novia companion awareness

```
/chat Novia, how am I doing with Spanish?

Novia retrieves episodic memories scope: {"domain":"spanish_flashcards"}:
  "Session 2 days ago: 47 cards, 80% accuracy, struggled with subjunctive"
  "Session 5 days ago: 50 cards, 74% accuracy, struggled with preterite"

Novia: "You're trending upward — 74% → 80% over your last two sessions,
Javier. Subjunctive keeps showing up as your sticking point. Want me to
set up a focused practice run for -er/-ir endings?"
```

### Example 4: Novia modifying the system

```
/chat Novia, please add a 'last_cooked' date field to my Recipes table.

Novia tool calls:
  1. get_domain_schema { domain: "Recipes" } → current schema
  2. [Text] "I'll add a nullable date column called 'last_cooked' to
     PGD_Recipes. Confirm?"
  [Human gate: confirm]
  3. serv_insert / SERV-Schema addColumn { tableName: "PGD_Recipes",
     columnName: "last_cooked", type: "date", nullable: true }
  [Text] "Done. PGD_Recipes now has a 'last_cooked' column."
```

---

## 15. Implementation Sequence

Recommended build order — each item is one sprint task:

1. **`PGC_Memory` table** — DDL with jsonb scope. Register in PGC_Schema +
   PGC_TableMap. Validate SERV can write via `insertRow`.

2. **`write_memory` step type** — Case in `step-executor.mjs`. Resolves scope
   template tokens, computes token_estimate, calls SERV insertRow. Unit test.

3. **Memory retrieval + scope expansion** — `src/proc/memory-client.mjs`.
   `retrieveMemories({ scope, tags, budgetTokens, memoryTypes })`. Unit testable
   with mock SERV rows.

4. **`llm-harness.mjs`** — Extract `executeLlmCall` from `step-executor.mjs`,
   wire in memory retrieval and overflow guard. All existing unit tests pass
   (no behaviour change when memory corpus is empty).

5. **`memory_config` on PGC_Prompt** — New nullable jsonb column. Set
   `memory_budget_tokens: 0` on all classification prompts.

6. **Model aliases in PGC_SystemContext** — Add `llm_model_aliases` entry.
   Update harness to resolve aliases. Create `audit-model-ids.mjs` dev script.

7. **`write_memory` steps in `create_domain` and `create_workflow`** — Add as
   final steps in each workflow's seed JSON. Upsert. Validate in prod.

8. **Episodic fire-and-forget** — `MEMORY_WRITE` SQS type + `memory-writer.mjs`.
   `run-workflow.mjs` enqueues on qualifying run completion.

9. **History threading** — `use_run_history` on `llm_call` steps +
   session creation at run start + `loadRunHistory()` in harness.
   Implements deferred item from `docs/session-chat-design.md` Section 10.

10. **Novia Mode 4 /chat** — Tool definitions in PGC_Capability. Agentic while
    loop in `chat.mjs`. Write-tool confirmation gate. Persona memory on first
    persona-setting message.
