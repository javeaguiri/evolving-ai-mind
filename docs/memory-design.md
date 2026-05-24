
# Memory Layer — Architecture and Design

Version: 1.1  
Status: Design — pre-implementation  
Last updated: 2026-05-24

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
days). Old episodes are deleted by a nightly maintenance workflow. This keeps the
table small and retrieval cheap.

### 2.2 Semantic Memory — what was learned

Insights and design decisions produced by LLM interactions during workflow
generation and domain creation. When `create_domain` designs a schema, the
reasoning behind key structural decisions is stored scoped to that domain. When
`create_workflow` later runs for the same domain, those semantic memories are
injected — the second LLM inherits the first LLM's understanding.

**Primary consumer:** Workflow and domain generation. Eliminates the need to
re-explain domain context every time the user adds a workflow to an existing
domain.

**Decay policy:** Semantic records are long-lived — they represent design
decisions that should persist until the domain is deleted. TTL defaults to null
(no expiry). Cleared by `delete_domain`.

### 2.3 Procedural Memory — why things work the way they do

Design intent and rationale behind existing workflows and prompts. Written when
`create_workflow` produces a workflow — what it is trying to accomplish, what
constraints shaped its structure, what alternatives were considered. Consumed by
`fix_workflow` and `troubleshoot_workflow` so the repair LLM understands what it
is trying to preserve, not just what the broken code looks like.

**Primary consumer:** `fix_workflow`, `troubleshoot_workflow`. Prevents the repair
LLM from "fixing" the workflow into something that works but doesn't match the
user's original intent.

**Decay policy:** Procedural records follow their parent workflow. Cleared when
the workflow is deleted.

---

## 3. PGC_Memory Schema

```sql
CREATE TABLE "PGC_Memory" (
  id               SERIAL PRIMARY KEY,
  memory_type      VARCHAR(20)   NOT NULL CHECK (memory_type IN ('episodic','semantic','procedural')),
  scope            VARCHAR(100)  NOT NULL,          -- 'global' | 'domain:Recipes' | 'workflow:create_domain'
  content          TEXT          NOT NULL,          -- The memory in plain language
  tags             JSONB         NOT NULL DEFAULT '[]',  -- string array for retrieval matching
  priority         INTEGER       NOT NULL DEFAULT 5,     -- 1 (highest) to 10 (lowest) — budget selection order
  token_estimate   INTEGER       NOT NULL DEFAULT 0,     -- pre-computed token count for budget planning
  source_run_id    INTEGER       NULL REFERENCES "PGC_WorkflowRun"(id) ON DELETE SET NULL,
  source_workflow  VARCHAR(100)  NULL,
  source_step      VARCHAR(50)   NULL,
  expires_at       TIMESTAMPTZ   NULL,              -- NULL = never. Set for episodic records.
  embedding        FLOAT[]       NULL,              -- future: pgvector 1536-dim
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX ON "PGC_Memory" (scope);
CREATE INDEX ON "PGC_Memory" (memory_type);
CREATE INDEX ON "PGC_Memory" (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX ON "PGC_Memory" USING GIN (tags);
```

**Key design decisions:**

- `scope` is a single indexed string — cheap exact-match queries. Compound
  scopes are possible: `domain:Recipes|workflow:add_entity` means "relevant to
  adding recipes specifically." The retrieval function expands scope to check
  both the compound key and each component.
- `token_estimate` is written at insert time by the harness. Uses the rough
  formula `ceil(content.length / 4)` — fast, no API call needed.
- `priority` 1–10 allows explicit ranking. Procedural memories for the current
  workflow get priority 1; global context gets 5; old episodic records get 8.
  Budget trimming always drops highest-priority-number (lowest importance) first.
- `embedding` is reserved for Phase 2 pgvector semantic search. Writing it NULL
  now means the schema change when pgvector is enabled is additive only.

---

## 4. Memory Writing

### 4.1 When memories are written

| Trigger | Type | Scope | Who writes |
|---|---|---|---|
| `create_domain` completes | semantic | `domain:<name>` | `write_memory` step at end of workflow |
| `create_workflow` completes | procedural | `workflow:<name>` | `write_memory` step at end of workflow |
| Any domain workflow run completes | episodic | `domain:<name>` | fire-and-forget `MEMORY_WRITE` SQS message |
| `delete_domain` runs | — | — | `run-workflow.mjs` deletes all rows WHERE scope LIKE `domain:<name>%` |
| `delete_workflow` runs | — | — | `run-workflow.mjs` deletes rows WHERE scope = `workflow:<name>` |

### 4.2 The `write_memory` step type

A new step type added to `step-executor.mjs`. Its contract:

```json
{
  "step": "99",
  "type": "write_memory",
  "description": "Distil LLM reasoning into a persistent memory record",
  "input": {
    "memory_type": "semantic",
    "scope":       "domain:{{input.domainName}}",
    "content_key": "design_reasoning",
    "tags":        ["schema", "domain"],
    "priority":    2
  },
  "output_key": "memory_written",
  "on_success": "end",
  "on_failure": "end"
}
```

`content_key` is a key in `local_state` whose value is a plain-text string — the
memory content. The step handler reads `local_state[content_key]`, resolves
`scope` template tokens, computes `token_estimate`, and calls SERV `insertRow`
against `PGC_Memory`.

**Critical constraint:** `write_memory` must never block the user-facing result.
Place it as the final step after `notify` in any workflow that writes memories.
Failure logs but does not fail the run (`on_failure: "end"` always).

### 4.3 Fire-and-forget episodic writes

For workflow runs that produce user-visible results (queries, CRUD operations),
writing an episodic memory should not add a step to the user-facing workflow.
Instead, `run-workflow.mjs` enqueues a `MEMORY_WRITE` SQS message when a run
completes successfully:

```js
// run-workflow.mjs — on run completion
if (run.status === 'completed' && shouldWriteEpisodicMemory(run)) {
  await enqueueWorkflow({
    type: 'MEMORY_WRITE',
    runId: run.id,
    workflowName: run.workflow_name,
    domain: run.input?.domain ?? null,
    summary: buildEpisodicSummary(run),  // js_transform-style distil from local_state
  });
}
```

`memory-writer.mjs` (new PROC endpoint) handles `MEMORY_WRITE` messages. It:
1. Optionally calls a cheap LLM (sonar) to distil `local_state` into a 2–3
   sentence episodic summary (right-brain activity)
2. Inserts the record into `PGC_Memory` with a 90-day `expires_at`

**Cost note:** Not every run warrants an LLM distillation call. A `js_transform`
rule generates a deterministic summary for simple CRUD runs (no LLM cost). The
cheap sonar call is reserved for runs with rich `local_state` (multi-step
workflows with reasoning fields).

### 4.4 Memory content from reasoning fields

The `reasoning` field captured by the session diagnostics design (see
`docs/session-chat-design.md` Section 4) is the raw material for semantic and
procedural memories. The `write_memory` step takes `content_key` pointing to a
`reasoning` value in `local_state` that was populated by an upstream `llm_call`
step. This means:

- No additional LLM call is needed to create semantic/procedural memories
- The cost of the memory is already paid by the generation call
- The memory is the reasoning, not a distillation of the output

---

## 5. Memory Retrieval

### 5.1 Retrieval algorithm

Called by the LLM harness before every LLM call. Returns a list of memory records
sorted by priority, trimmed to the token budget.

```js
async function retrieveMemories({ scope, tags, budgetTokens, memoryTypes }) {
  // Step 1: Resolve candidate scopes
  // 'domain:Recipes|workflow:add_entity' → check both compound and components
  const scopes = expandScope(scope);  // ['domain:Recipes|workflow:add_entity', 'domain:Recipes', 'global']

  // Step 2: Query with scope + tag filter
  // WHERE scope = ANY($scopes)
  //   AND ($tags IS NULL OR tags @> $tags::jsonb)
  //   AND (expires_at IS NULL OR expires_at > NOW())
  //   AND memory_type = ANY($memoryTypes)
  // ORDER BY priority ASC, created_at DESC
  const rows = await getRows('PGC_Memory', {
    filters: { scope: scopes, memory_types: memoryTypes },
    tags,
  });

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

**Scope expansion:** The scope string `domain:Recipes|workflow:add_entity` expands
to three queries: the exact compound scope, `domain:Recipes` alone, and `global`.
This ensures global memories (system-wide best practices, user preferences) are
always considered alongside domain-specific ones.

### 5.2 Memory injection into prompts

Retrieved memories are injected as a named block inside the system prompt,
immediately before the existing `PGC_SystemContext` injection slot:

```
[PGC_SystemContext blocks — inject_always rows]

--- RELEVANT CONTEXT FROM MEMORY ---
[episodic block — if any episodic memories selected]
Recent activity:
- User completed Spanish flashcard session 3 days ago (80% accuracy, struggled with subjunctive)

[semantic block — if any semantic memories selected]
Design decisions for this domain:
- Chose a junction table PGD_RecipeIngredients because recipes have a many-to-many relationship
  with ingredients. Embedding ingredients as jsonb was rejected to allow ingredient-centric queries.

[procedural block — if any procedural memories selected]
Workflow design intent:
- This workflow was designed to handle multi-step recipe creation with parent/child inserts.
  The human_gate at step 3 confirms parsed ingredients before writing to avoid data-entry errors.
--- END MEMORY ---

[PGC_SystemContext blocks — inject_for rows matching current intent]
```

Memory content is separated by type so the LLM can weight episodic context
differently from design rationale. The block is omitted entirely when no memories
are retrieved (zero cost when the corpus is empty or no matches exist).

### 5.3 Token budget by call type

Different LLM calls have different memory budgets. Configured per
`PGC_Prompt.memory_config` (new jsonb field, optional):

```json
{
  "memory_budget_tokens": 600,
  "memory_types": ["semantic", "procedural"],
  "memory_scope_override": null
}
```

Default budgets when `memory_config` is absent:

| Call type | Default budget | Memory types | Reason |
|---|---|---|---|
| `create_workflow` | 800 tokens | semantic, procedural | Needs full domain context + prior workflow rationale |
| `fix_workflow` | 600 tokens | procedural | Only needs design intent for the specific workflow |
| `create_domain` | 400 tokens | semantic, global | Prior domain patterns useful; no procedural yet |
| `/chat` | 500 tokens | episodic | Companion awareness — recent activity only |
| Intent classification (sonar) | 0 tokens | — | Never inject memory into cheap classification calls |
| CRUD workflows | 0 tokens | — | Generic steps have no LLM call to inject into |

Total memory overhead across a household day (estimated 20 LLM calls):
≈ 5 calls × 600 avg tokens = 3,000 additional tokens ≈ $0.003/day → negligible
within the $8–13/month envelope.

### 5.4 Phase 2 — pgvector semantic retrieval

The Phase 1 retrieval (scope + tag exact matching) is deterministic and zero-cost.
Phase 2 adds vector similarity for cases where the correct memory doesn't match
exact scope:

```
Phase 2 retrieval extension:
  Embed user input or step description (text-embedding-3-small, 1536 dim)
  Query PGC_Memory WHERE scope matches expanded scopes
    ORDER BY embedding <-> query_embedding LIMIT 10
  Merge with Phase 1 results, deduplicate, re-rank by combined score
```

pgvector is already on the roadmap for `PGC_Workflow.intent_embedding`. Enabling
it for `PGC_Memory` is a one-line `ALTER TABLE` when the extension is active.

---

## 6. Mode 4 — The Agentic Loop

### 6.1 How evolving-mind-ai already implements Mode 4

The four LLM interaction modes:

| Mode | Description | Current usage |
|---|---|---|
| 1 | Stateless single-shot | Every `llm_call` step today |
| 2 | Stateful chat (managed history) | `/chat`, `/explain` (session design doc) |
| 3 | Extended thinking / reasoning | Not used — Perplexity gateway limitation |
| 4 | Agentic loop (tool use + multi-iteration) | SQS WorkflowQueue IS the loop |

The SQS WorkflowQueue already implements a distributed Mode 4 loop:

| Agent harness concept | evolving-mind-ai equivalent |
|---|---|
| `while (model wants to use a tool)` | SQS messages driving the execution stack |
| One loop iteration | One `WORKFLOW_STEP execute_top` SQS message |
| Tool execution | `serv_query`, `serv_insert`, `human_gate`, etc. |
| `messages.append(tool_results)` | `local_state[step.output_key] = result` |
| Loop checkpoint (crash recovery) | `PGC_WorkflowRun.stack` + `state` persisted each step |
| Human-in-the-loop interrupt | `human_gate` step type |
| Loop continues until done | `end` step type terminates the run |

**What's currently missing vs a full Mode 4 harness:** The messages array is not
threaded between `llm_call` steps in the same run. Each `llm_call` step gets a
fresh context (prompt + system context). A later step cannot see the LLM's
reasoning from an earlier step unless the workflow explicitly copies output fields
via `js_transform`. This is the "cross-LLM pollination" gap.

### 6.2 Enabling history threading within a workflow run

History threading means: when Step N calls the LLM, it can optionally receive the
prompt and response from Steps 1..N-1 as prior turns in the messages array. This
is controlled per-step:

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

When `use_run_history: true`, the `llm_call` step handler:
1. Queries `PGC_SessionEntry` for all rows with `session_id` matching the run's
   session (a session is created at run start when `use_run_history` is set on
   any step)
2. Reconstructs the messages array: all prior `[user, assistant]` pairs
3. Calls `callLlmWithMessages` instead of `callLlm`, passing the full history

This maps precisely to the "Chat History in llm_call Steps" deferred item in
`docs/session-chat-design.md`, now with a clear implementation path.

**Session creation at run start:** When `run-workflow.mjs` loads the workflow
definition and detects any step with `use_run_history: true`, it creates a
`PGC_Session` row at run start with `session_type = 'workflow_run'` and stores
the session ID on the run's state. No session is created for workflows that
don't use history threading (zero cost for the common case).

### 6.3 Token management for long agentic loops

Long runs (many `llm_call` steps) accumulate a large messages array. The context
window fills up. Token management strategy — three techniques applied in order:

**Technique 1 — Selective history:** Not every prior step is included. The
`use_run_history` input can specify which prior steps to include:

```json
"use_run_history": { "include_steps": ["1", "2a"] }
```

When omitted (bare `true`), all prior llm_call steps in the same run are included.
This is the default for `create_workflow` which needs the full analysis context.
For `fix_workflow`, only the step that generated the original broken workflow is
needed — not the entire prior session.

**Technique 2 — Token-budget aware reconstruction:** The session reconstruction
function uses `token_estimate` on `PGC_SessionEntry` rows to cap history at a
configurable budget:

```js
function reconstructHistory(entries, budgetTokens) {
  // Always include: system message (seq=1)
  // Fill from most-recent backward until budget exhausted
  const system = entries.find(e => e.role === 'system');
  const rest   = entries.filter(e => e.role !== 'system').reverse();

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

The default budget for `use_run_history` calls is 2000 tokens for prior history.
Combined with the memory injection budget (up to 800 tokens) and the base system
prompt, total context overhead from history + memory stays under ~3000 tokens per
call — well within cost constraints.

**Technique 3 — Compression (future / backlog):** When a run exceeds N steps and
history reconstruction is still hitting the budget ceiling, a compression step
can summarise older turns into a single "Prior analysis summary:" block using a
cheap sonar call. This is triggered automatically when
`reconstructHistory` truncates more than 2 turns. The compressed summary
replaces the dropped turns in `PGC_SessionEntry` (a new `is_compressed: true`
row replaces the originals). This is a backlog item — the budget techniques above
handle household-scale runs without it.

### 6.4 Prioritizing context — what the LLM actually sees

For any given `llm_call` step, the LLM receives context in this priority order
(highest influence first):

```
1. System prompt (PGC_Prompt.prompt_text, filled with local_state values)
2. PGC_SystemContext inject_always rows
3. Memory injection block (retrieved via Section 5)
4. PGC_SystemContext inject_for rows (matching current intent_category)
5. Run history (reconstructed from PGC_SessionEntry, if use_run_history)
6. User message (the input)
```

Items 1–4 are always present (within their budgets). Items 5–6 depend on the
step configuration. The ordering ensures that base prompt instructions dominate
and cannot be overridden by memory or history content.

**Context compression summary (illustrative for create_workflow):**

```
System prompt:         ~1200 tokens  (generate_workflow_steps v22)
SystemContext always:   ~300 tokens  (step type contracts, routing rules)
Memory block:           ~600 tokens  (domain semantic memories)
SystemContext for:      ~200 tokens  (domain-specific inject_for rows)
Run history:            ~800 tokens  (analyze_and_design_workflow output)
User message:           ~100 tokens
─────────────────────────────────────
Total context:         ~3200 tokens  per call
```

At Perplexity anthropic/claude-sonnet-4-5 pricing (~$3/M input tokens), this
is ~$0.0096 per `create_workflow` call. The current cost without memory is
~$0.006. Memory adds roughly 60% per call — acceptable given that `create_workflow`
runs infrequently (not on every user interaction).

---

## 7. The LLM Harness

### 7.1 What the harness is

The LLM harness is the centralized assembly point for everything a LLM call needs.
Currently this responsibility is split:

| Responsibility | Current location |
|---|---|
| API call mechanics | `src/shared/llm-client.mjs` |
| Prompt loading | `step-executor.mjs` (`llm_call` handler) |
| SystemContext injection | `step-executor.mjs` (`executeLlmCall`) |
| Correction loop | `step-executor.mjs` + `review-output.mjs` |
| Resumption on truncation | `step-executor.mjs` |
| Session write (planned) | `step-executor.mjs` (planned, not built) |
| Memory retrieval | **Not built** |
| History threading | **Not built** |
| Token budget enforcement | **Not built** |

The harness centralizes items 2–9 into a single function so `step-executor.mjs`
orchestrates (when, why) and the harness executes (how, at what cost).

### 7.2 Harness location — `src/proc/llm-harness.mjs`

Not in `src/shared/` because it requires SERV calls (memory retrieval, session
writes). Not a Lambda handler — a pure proc-tier module imported by
`step-executor.mjs`.

```
src/proc/
├── llm-harness.mjs     ← new — centralized LLM call with full context assembly
├── step-executor.mjs   ← calls executeLlmStep(config) from llm-harness.mjs
├── ...
```

### 7.3 Harness function signature

```js
/**
 * Execute one LLM call with full context: memory, history, system context,
 * correction loop, session write, and token budget enforcement.
 *
 * @param {object} config
 * @param {string} config.intentCategory   PGC_Prompt.intent_category key
 * @param {object} config.promptRow        Pre-loaded PGC_Prompt row
 * @param {object} config.localState       Current frame local_state for template resolution
 * @param {string} config.traceId
 * @param {number} config.runId            PGC_WorkflowRun.id
 * @param {string} config.workflowName
 * @param {string} config.stepId
 * @param {string} config.scope            Memory scope string (e.g. 'domain:Recipes')
 * @param {string[]} config.memoryTags     Tags to narrow memory retrieval
 * @param {boolean} config.useRunHistory   Inject prior run session entries
 * @param {string[]} config.historySteps   Specific step IDs to include (or all if null)
 * @param {boolean} config.diagnosticsEnabled
 * @param {object[]} config.systemContextRows  Pre-loaded PGC_SystemContext rows
 * @returns {Promise<{ output: object, queryId: string|null }>}
 */
export async function executeLlmStep(config) {
  // 1. Resolve template tokens in prompt text against local_state
  // 2. Retrieve memories (scope + tags + budget)
  // 3. Assemble memory injection block
  // 4. Retrieve run session history if useRunHistory (budget-aware)
  // 5. Build final instructions string: base prompt + system context + memory block
  // 6. Build messages array: [system, ...history, user_message]
  // 7. Call callLlm / callLlmWithMessages
  // 8. On truncation: callLlmWithResumption
  // 9. On validation failure: callLlmWithCorrection (review-output.mjs)
  // 10. If diagnosticsEnabled: write PGC_Session + PGC_SessionEntry (non-blocking)
  // 11. Return { output, queryId }
}
```

`step-executor.mjs` becomes simpler — the `llm_call` handler reduces to:

```js
case 'llm_call': {
  const promptRow = await loadPrompt(step.input.prompt);
  const { output, queryId } = await executeLlmStep({
    intentCategory: step.input.prompt,
    promptRow,
    localState: frame.local_state,
    traceId,
    runId,
    workflowName,
    stepId: step.step,
    scope:  step.input.memory_scope ?? `workflow:${workflowName}`,
    memoryTags: step.input.memory_tags ?? [],
    useRunHistory: step.input.use_run_history ?? false,
    historySteps:  step.input.use_run_history?.include_steps ?? null,
    diagnosticsEnabled,
    systemContextRows,
  });
  return { result: output, nextAction: resolveNextAction(step, output) };
}
```

### 7.4 Context assembly order (harness internal)

```
instructions = ''

// 1. Base prompt (filled)
instructions += resolveTemplate(promptRow.prompt_text, localState)

// 2. inject_always system context
instructions += formatSystemContextBlock(systemContextRows.filter(r => r.inject_always))

// 3. Memory block (budget-trimmed)
const memories = await retrieveMemories({ scope, tags, budget, memoryTypes })
if (memories.length > 0) {
  instructions += formatMemoryBlock(memories)
}

// 4. inject_for system context (matching current intentCategory)
instructions += formatSystemContextBlock(systemContextRows.filter(r =>
  r.inject_for?.includes(intentCategory)
))

// 5. History (budget-trimmed) — becomes the messages array, not instructions
const history = useRunHistory
  ? await loadRunHistory({ runId, steps: historySteps, budgetTokens: 2000 })
  : []

// 6. User message
const userMessage = resolveTemplate(promptRow.user_message_template ?? '{{input.userInput}}', localState)

// Final call
const messages = [
  { role: 'system', content: instructions },
  ...history,
  { role: 'user',   content: userMessage },
]
return callLlmWithMessages(promptRow.model, messages, traceId)
```

### 7.5 Cost control knobs

All budgets are configurable via `PGC_SystemContext` entries — no code changes
needed to tune them:

| Key | Default | Controls |
|---|---|---|
| `memory_default_budget_tokens` | 500 | Tokens allocated to memory per call when prompt has no `memory_config` |
| `history_default_budget_tokens` | 2000 | Tokens allocated to run history per call |
| `episodic_ttl_days` | 90 | Days before episodic memories expire |
| `memory_write_llm_threshold` | `complex` | When to use LLM vs js_transform for episodic distillation: `never` / `complex` / `always` |

A `memory_budget_tokens: 0` in a `PGC_Prompt` row's `memory_config` completely
disables memory injection for that prompt (used for cheap classification calls).

---

## 8. Left / Right Brain Division

Memory creation is a right-brain activity. Memory consumption is a left-brain
activity. This aligns with the existing L/R brain division:

| Activity | Brain | Mechanism |
|---|---|---|
| Writing episodic memory | Right | `MEMORY_WRITE` SQS + optional sonar distillation |
| Writing semantic memory | Right | `write_memory` step fed by `reasoning` field from llm_call |
| Writing procedural memory | Right | `write_memory` step at end of create_workflow |
| Retrieving memories for injection | Left | Deterministic scope + tag query in harness |
| Budget enforcement | Left | Token counting in harness, no LLM |
| Compression of old history | Right (future) | Cheap sonar call on overflow |

The harness is entirely left-brain — deterministic, structured, no creativity.
The right brain creates memories; the left brain uses them.

---

## 9. Practical Examples

### Example 1: create_domain → create_workflow knowledge flow

```
create_domain runs for "Recipes"
  → LLM designs schema with reasoning field:
    "Chose PGD_RecipeIngredients junction table because recipes have a
     many-to-many relationship with ingredients..."
  → write_memory step at end:
    { type: 'semantic', scope: 'domain:Recipes',
      content: 'Junction table PGD_RecipeIngredients: many-to-many, allows
                ingredient-centric queries. jsonb embedding rejected.',
      tags: ['schema', 'design_decision'], priority: 2, token_estimate: 48 }

create_workflow runs later for Recipes domain
  → harness scope: 'domain:Recipes'
  → retrieveMemories() returns the semantic memory above
  → Memory block injected into generate_workflow_steps prompt
  → LLM knows junction table structure and why — produces correct iterator
    over PGD_RecipeIngredients without being told again
```

### Example 2: fix_workflow using procedural memory

```
fix_workflow runs on a broken add_recipe workflow
  → harness scope: 'workflow:add_recipe'
  → retrieveMemories(types: ['procedural']) returns:
    "This workflow was designed to parse full recipes including ingredients
     from natural language. The human_gate at step 3 confirms parsed data
     before writing because users described accurate ingredient entry as
     critical. The iterator at step 5 handles multi-child inserts for
     PGD_RecipeIngredients."
  → Repair LLM understands step 3 is intentional, not an obstacle to remove.
    Repair preserves the confirmation gate rather than "simplifying" it out.
```

### Example 3: /chat companion awareness

```
User: /chat how am I doing with my Spanish practice?

harness scope: 'global' + 'domain:spanish_flashcards'
retrieveMemories(types: ['episodic'], tags: ['spanish'], budget: 500):
  → "User completed flashcard session 2 days ago: 47 cards, 80% accuracy,
      struggled with subjunctive conjugations (er/ir ending confusion)"
  → "User completed session 5 days ago: 50 cards, 74% accuracy,
      struggled with irregular preterite forms"

LLM response: "You're trending upward — 74% → 80% over your last two sessions.
Subjunctive is clearly your current wall; you've hit the same conjugation
patterns both times. Want to do a focused session on just -er/-ir endings?"

(Without memory: "I don't have information about your Spanish practice history.")
```

---

## 10. Implementation Sequence

Recommended build order (each item is one sprint task):

1. **`PGC_Memory` table** — DDL + PGC_Schema + PGC_TableMap registration. No code
   changes. Validates SERV can write to the table via `insertRow`.

2. **`write_memory` step type** — Add case to `step-executor.mjs`. Takes
   `content_key` from `local_state`, resolves scope template, computes
   `token_estimate`, calls SERV insertRow. Unit test: verifies row is written
   with correct scope + token estimate.

3. **Memory retrieval function** — `retrieveMemories()` in a new
   `src/proc/memory-client.mjs`. Pure SERV call + budget trimming. Unit testable
   with mock SERV rows.

4. **`llm-harness.mjs`** — Extract `executeLlmCall` from `step-executor.mjs`
   into `llm-harness.mjs`. Wire in memory retrieval. All existing unit tests
   must continue passing (harness is a refactor, not a behavior change, when
   memory corpus is empty).

5. **`add memory_config to PGC_Prompt`** — New optional jsonb column.
   `memory_budget_tokens: 0` on classification prompts disables injection.
   No migration needed — column is nullable.

6. **Episodic write via fire-and-forget** — `MEMORY_WRITE` SQS message type +
   `memory-writer.mjs` PROC endpoint. Triggered by `run-workflow.mjs` on
   completion of qualifying runs. Simple js_transform distillation only (no LLM)
   for phase 1.

7. **`write_memory` steps in create_domain and create_workflow** — Add as final
   steps in each workflow's seed JSON. Update upsert. Validate in prod.

8. **History threading** — `use_run_history` field on `llm_call` steps + session
   creation at run start + `loadRunHistory()` in harness. Implements the deferred
   item from `docs/session-chat-design.md` Section 10.

Items 1–4 deliver memory injection with zero new user-visible features — the system
gets smarter without any interface change. Items 5–8 layer on progressively richer
context threading.
