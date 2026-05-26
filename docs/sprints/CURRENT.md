# Sprint 3 — Memory, Novia, and the Running Quiz

**Goal:** Make the system worth using every day. Three threads run in parallel:
(1) diagnose why the flashcard quiz fails and fix its prerequisites;
(2) build the memory layer so every future LLM call is progressively smarter;
(3) ship Novia — the Mode 4 agentic companion. The quiz is the final acceptance
gate: it must run end-to-end using the new memory-aware system.

**README.md must be updated at sprint close.**

**Branch:** `sprint/03-run-generated-workflows`

---

## Scope — Execution Order

Tracks are sequenced. Each track must be complete before the next starts.
History threading (Track H) is the most likely candidate to defer to Sprint 4
if the sprint runs long.

---

### Track D — Diagnose: why the quiz broke (first)

Before touching any code, understand what actually failed. The flashcard quiz
was dead on arrival after a structurally valid generation. Diagnosis informs
which fixes belong in Track B vs the memory layer vs the workflow itself.

**Four issues to investigate and fix:**

1. **`/help` is domain-blind**: `/help` does not surface flashcard quiz usage.
   A user who created the flashcard domain cannot discover how to start a quiz
   from help. Investigate whether `PGC_DomainHelp.commands` entries include
   domain-specific workflows generated after `create_domain`. Fix.

2. **Intent mapping is fragile — singular vs. plural**: `/m add flashcard set…`
   fails; `/m add flashcards set…` succeeds. The alias matching requires an exact
   plural token. Fix: broaden alias coverage to include singular/plural variants.
   Audit other domains for the same gap.

3. **Post-creation message is hostile UX**: After `flashcard_quiz_session` was
   registered, the response leaked internal metadata:
   > "Deferred enhancements: 3 item(s) noted for future improvement."
   The "Try" suggestion was the raw `intent_keywords` string — not usable.
   Fix `create_workflow`'s final notification step to produce a short, actionable
   reply. Deferred items are internal; they must never surface to the user.

4. **`{{name}}` tokens unresolved in human_gate options**: The quiz rendered
   `{{name}}` and `Cancel` as its two buttons. Inspect the WorkflowRun to
   determine: did the `serv_query` step run? Did it return rows? Were the
   column names correct? Root cause hypothesis: the generated `serv_query`
   queried wrong column names because the LLM had no `domain_schema` at
   generation time (Track B). Document the exact failure path before fixing.

**Acceptance criteria:**
- [ ] `/help` surfaces flashcard domain commands including how to start a quiz
- [ ] `/m add flashcard set…` (singular) resolves correctly without manual alias editing
- [ ] Post-create workflow notification is concise and contains no internal metadata
- [ ] Root cause of `{{name}}` token failure documented

---

### Track B — Prerequisite: domain context in create_workflow

Without `domain_schema`, the generation LLM hallucinates column names. This is
the root cause of issue 4 above. Must be complete before the quiz is regenerated.

Two coupled fixes:

1. **Wire `domain` through the SQS payload**: `CREATE_WORKFLOW` SQS messages
   currently carry only `userInput`. The intent preprocessor in
   `classify-intent.mjs` already resolves domain — pass it through to the SQS
   payload so `create_workflow` has it as `input.domain`.

2. **Inject `domain_schema` into generation prompts**: Add a `serv_query` step
   to `create_workflow` (before `generate_workflow_steps`) that fetches
   `PGC_Schema` rows for the target domain and writes them as `domain_schema` in
   `local_state`. Update `generate_workflow_steps` and `fix_workflow_routing`
   prompts to accept and use `domain_schema`. The repair agent has been blind to
   domain table structure — this fixes that too.

**Acceptance criteria:**
- [ ] `domain` is non-null in create_workflow WorkflowRun inputs
- [ ] `domain_schema` is available in `local_state` when `generate_workflow_steps` fires
- [ ] A test create_workflow run references correct table and column names on first attempt

---

### Track C — Prerequisite: deduplicate routing rules

Independent of the quiz but small and unblocked. Do alongside Track B.

`generate_workflow_steps` and `fix_workflow_routing` maintain parallel copies
of CRITICAL ROUTING RULES. Drift between them caused two routing bugs in
Sprint 2.

1. Create `PGC_SystemContext` key `workflow_routing_rules` with the canonical
   routing rules block.
2. Set `inject_for: ["generate_workflow_steps", "fix_workflow_routing"]`.
3. Strip the duplicated block from both prompt texts.

**Acceptance criteria:**
- [x] CRITICAL ROUTING RULES exist in exactly one place (PGC_SystemContext)
- [x] Both prompts receive the rules via inject_for
- [x] 246 unit tests still pass after prompt changes

---

### Track E — Memory: data layer

The smallest memory chunk. Just the table and one new step type. No LLM
changes, no harness changes. All existing tests must still pass.

**E1. PGC_Memory table**

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
CREATE INDEX ON "PGC_Memory" USING GIN (scope);
CREATE INDEX ON "PGC_Memory" USING GIN (tags);
CREATE INDEX ON "PGC_Memory" (memory_type);
CREATE INDEX ON "PGC_Memory" (expires_at) WHERE expires_at IS NOT NULL;
```

Register in `PGC_Schema` and `PGC_TableMap`. Validate SERV can write via
`insertRow`.

**E2. `write_memory` step type**

New case in `step-executor.mjs`. Input fields:

```json
{
  "memory_type": "semantic",
  "scope":       {"domain": "{{input.domainName}}"},
  "content_key": "design_reasoning",
  "tags":        ["schema", "design_decision"],
  "priority":    2
}
```

`content_key` points to a `local_state` key containing a plain-text string.
`scope` values support `{{template}}` substitution.
`token_estimate` is computed as `Math.ceil(content.length / 4)` — no API call.
`write_memory` must always be the last step after `notify`.
Failure logs but never fails the run (`on_failure: "end"` always).

Unit tests: write_memory resolves scope templates, computes token_estimate,
calls SERV insertRow with correct payload. Failure path does not throw.

**Acceptance criteria:**
- [x] PGC_Memory table exists in prod, registered in PGC_Schema + PGC_TableMap
- [x] `write_memory` step type passes unit tests
- [x] All 246 existing unit tests still pass

---

### Track F — Memory: retrieval and harness

The core engine change. Centralizes context assembly and wires in memory
retrieval. All existing tests must still pass (no behaviour change when the
memory corpus is empty).

**F1. `src/proc/memory-client.mjs`**

`retrieveMemories({ scope, tags, budgetTokens, memoryTypes, callContext })`

Scope expansion algorithm: a call scope `{"domain":"Recipes","workflow":"add_recipe"}`
expands to query all of:
1. `{"domain":"Recipes","workflow":"add_recipe"}` (most specific)
2. `{"domain":"Recipes"}` (domain-level)
3. `{"topic":"conventions"}` (cross-cutting conventions)
4. `{}` (global)

For `/chat` calls: also include `{"topic":"persona"}`.

Query: `WHERE (scope @> $1 OR scope @> $2 OR ...) AND (expires_at IS NULL OR expires_at > NOW())`
Order: `priority ASC, memory_type priority (procedural > semantic > episodic for generation; episodic > semantic > procedural for /chat), created_at DESC`

Budget-aware selection: greedy from highest priority until `budgetTokens` is reached.

Unit testable with mock SERV rows.

**F2. `src/proc/llm-harness.mjs`**

Extract the `executeLlmCall` logic currently scattered in `step-executor.mjs`
into a single function. See `docs/memory-design.md` Section 10 for the full
signature. Context assembly order:

```
1. Base prompt (PGC_Prompt.prompt_text, template-resolved)
2. inject_always system context
3. Memory block (retrieveMemories, budget-trimmed)
4. inject_for system context
5. Run history (if use_run_history, budget-aware)
6. User message
7. Overflow guard (throw context_window_overflow if > 80% of model window)
```

Memory block format when memories exist:

```
--- MEMORY ---
[content grouped by scope level, preferences first, design decisions second, procedural last]
--- END MEMORY ---
```

Block omitted entirely when no memories are retrieved.

**F3. `memory_config` column on PGC_Prompt**

```sql
ALTER TABLE "PGC_Prompt" ADD COLUMN memory_config JSONB NULL;
```

Default budgets when `memory_config` is absent (see `docs/memory-design.md`
Section 6.3):

| Call type | Budget | Types | Persona |
|---|---|---|---|
| `create_workflow` | 800 tokens | semantic, procedural | no |
| `fix_workflow` | 600 tokens | procedural | no |
| `create_domain` | 400 tokens | semantic | no |
| `/chat` Novia | 500 tokens | episodic, global | yes |
| Intent classification | 0 | — | no |

Set `memory_budget_tokens: 0` on all classification prompts to prevent
unintended memory injection on the hot path.

**F4. Model aliases in PGC_SystemContext**

Add `llm_model_aliases` entry:

```json
{
  "smart": "anthropic/claude-sonnet-4-6",
  "cheap": "perplexity/sonar",
  "fast":  "perplexity/sonar"
}
```

Harness resolves: `const resolvedModel = modelAliases[prompt.model] ?? prompt.model`

Create `dev_scripts/audit-model-ids.mjs`: lists all PGC_Prompt rows using
literal model IDs not in the alias map.

Migrate all "should-auto-upgrade" prompt rows to use `smart` or `cheap` alias.
Leave only deliberately-pinned prompts with literal IDs.

**Acceptance criteria:**
- [x] `memory-client.mjs` unit tests pass with mock SERV rows
- [x] `llm-harness.mjs` unit tests verify context assembly order
- [x] All 293 unit tests pass (empty memory corpus = no behaviour change)
- [x] `memory_config` column exists on PGC_Prompt in prod (added via SERV addColumn)
- [x] `llm_model_aliases` in PGC_SystemContext; harness resolves aliases at call time
- [x] `audit-model-ids.mjs` runs without error

---

### Track G — Memory: integration into existing workflows

With the foundation in place, make memory actually accumulate from real
system usage. This is the track that makes Tracks B+C+E+F pay off — after
Track G, a second `create_workflow` run for the same domain will carry the
design decisions from the first.

**G1. `save_to_memory` flag on create_domain and create_workflow llm_call steps** ✅

Implemented as a flag on the llm_call step rather than separate write_memory steps.
When set, the harness: (1) appends a reasoning instruction to the prompt, (2) strips
`reasoning` from raw LLM output before schema validation, (3) writes to PGC_Memory
(non-fatal await — Option B). PGC_Memory table created in prod. workflow-schema.json
and workflow seeds updated. Both workflows upserted (create_domain v31, create_workflow v48).

G1 still not validated end-to-end — blocked by prompt bugs discovered during validation:
- `create_domain` output_schema `maxItems: 6` → 10 (LLM generated 7 tables, failed validation) ✅ fixed
- `research_domain_schema` missing `{{single_user_constraint}}` placeholder — constraint never injected ✅ fixed
- `single_user_constraint` inject_for had phantom `create_domain_research` category → fixed to `research_domain_schema` ✅
- `create_domain` column `default` must-be-string rule missing — LLM returned `false`/`0` as native JSON types ✅ fixed
- `create_domain` max_output_tokens was DB-stale at 2000 (seed: 4000) — truncation on every run ✅ fixed via upsert
- `revise_domain_schema` same two fixes applied ✅
Next session: re-run create_domain (run 380+) to confirm schema validates and PGC_Memory row is written.

**G2. Wire memory into fix_workflow**

`fix_workflow` and `fix_workflow_routing` must read the procedural memory for
the target workflow before the repair LLM runs. Two options:
(a) Add a `serv_query` step fetching `PGC_Memory` WHERE `scope @> '{"workflow":"<name>"}'`
    and memory_type = 'procedural', writing to `local_state.procedural_memory`.
    The generation prompt then receives it via template substitution.
(b) Let the harness inject it automatically via `memory_config` on the prompt.

Option (b) is preferred — it uses the harness and requires no workflow step
change. Set `memory_config` on `fix_workflow` and `fix_workflow_routing` prompts
with `memory_types: ["procedural"]` and `scope` derived from `input.workflowName`.

**G3. Episodic fire-and-forget writes**

New SQS message type: `MEMORY_WRITE`.

`run-workflow.mjs` enqueues on qualifying run completion (domain workflow runs
that touch user data, not system meta-workflows):

```js
if (run.status === 'completed' && shouldWriteEpisodicMemory(run)) {
  await enqueueWorkflow({ type: 'MEMORY_WRITE', runId: run.id,
    workflowName: run.workflow_name, domain: run.input?.domain ?? null });
}
```

New `src/proc/memory-writer.mjs` handles `MEMORY_WRITE` messages. For simple
CRUD runs: deterministic distillation (zero LLM cost). For rich multi-step
runs with `reasoning` fields in `local_state`: cheap sonar call distils to
2–3 sentences.

**Acceptance criteria:**
- [x] PGC_Memory table created and registered in PGC_Schema + PGC_TableMap
- [ ] A create_domain run writes a semantic memory record to PGC_Memory in prod (validate next session)
- [ ] A create_workflow run writes a procedural memory record to PGC_Memory in prod (validate next session)
- [ ] A second create_workflow run for the same domain has that semantic memory injected
- [ ] fix_workflow receives procedural memory for the target workflow via harness injection
- [ ] A domain CRUD workflow run triggers a MEMORY_WRITE SQS message; episodic record written

---

### Track H — Memory: history threading (may defer to Sprint 4)

Allows `llm_call` steps later in a workflow run to see prior LLM outputs from
the same run — the "cross-LLM pollination" gap. Most valuable for multi-step
generation workflows where step 3 can build on step 1's reasoning.

`use_run_history: true` on an `llm_call` step opts in:

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

When set, the harness creates a `PGC_Session` at run start, writes each
`llm_call` turn to `PGC_SessionEntry`, and reconstructs the messages array
(budget-aware, newest-first trimming to `history_budget_tokens` default 2000)
before each subsequent `llm_call` step.

This implements the deferred item from `docs/session-chat-design.md` Section 10.

**Defer if sprint runs long.** The memory layer (Tracks E–G) delivers most
of the value without history threading. Threading is a Sprint 4 candidate.

**Acceptance criteria (if not deferred):**
- [ ] `use_run_history: true` on a step causes prior turns to be reconstructed
- [ ] History is budget-trimmed to `history_budget_tokens` (newest-first)
- [ ] Reasoning field from diagnostic sessions is excluded from reconstructed messages
- [ ] Unit tests for `loadRunHistory()` with mock PGC_SessionEntry rows

---

### Track I — Novia: /chat + Mode 4 agentic loop

The companion. Depends on Track F (harness) and Track G (memory corpus exists).

**I1. `callLlmWithTools` in llm-client.mjs**

New function for Mode 4 calls. Returns `{ text, tool_calls }`. Only called by
`chat.mjs` — not by the workflow engine (which implements its own distributed
loop via SQS).

Tool call schema follows the OpenAI/Anthropic tool_use format. The Perplexity
gateway routing must be validated for tool_call support on non-sonar models —
add this to implementation prep.

**I2. Tool definitions in PGC_Capability**

Add `PGC_Capability` rows for Novia's 15 tools (see `docs/memory-design.md`
Section 9.3). Key fields:

| Tool key | What it does |
|---|---|
| `get_workflow` | Fetch a workflow by name |
| `list_workflows` | List all workflows (optionally by domain) |
| `get_domain_schema` | Fetch tables and columns for a domain |
| `list_domains` | List all registered domains |
| `analyze_workflow` | Run L1 static analysis |
| `propose_workflow_fix` | Generate corrected steps via fix_workflow LLM |
| `apply_workflow_fix` | Persist corrected steps (requires_confirm: true) |
| `get_prompt` | Fetch a prompt by intent_category |
| `update_prompt` | Update prompt text or schema (requires_confirm: true) |
| `serv_query` | Parameterised SELECT against any registered table |
| `serv_insert` | Insert a row (requires_confirm: true) |
| `serv_update` | Update rows (requires_confirm: true) |
| `write_memory` | Persist a memory record |
| `read_memory` | Query memories by scope + tags |
| `add_system_context` | Add/update a PGC_SystemContext entry (requires_confirm: true) |

`requires_confirm: true` tools are intercepted by the agentic loop before
execution and produce a human gate confirmation message.

**I3. `src/proc/chat.mjs` — Mode 4 agentic loop**

SQS types: `CHAT_MESSAGE` (new message or thread continuation).

Core loop (see `docs/memory-design.md` Section 9.4):

```js
while (true) {
  const response = await callLlmWithTools(model, messages, tools, traceId);
  if (!response.tool_calls?.length) {
    await appendSessionEntry(session.id, 'assistant', response.text);
    await enqueueCallback('HUMAN_NOTIFICATION', response.text, req.callback);
    break;
  }
  const toolResults = await Promise.all(response.tool_calls.map(executeToolCall));
  messages = [
    ...messages,
    { role: 'assistant', content: null, tool_calls: response.tool_calls },
    ...toolResults.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.result })),
  ];
}
```

Thread continuation: Slack callback handler looks up `PGC_Session` by
`slack_thread_ts` and enqueues `CHAT_MESSAGE`.

**I4. Persona memory on first persona-setting message**

When the user says `/chat Please call me Javier and I'll call you Novia`, the
handler detects the persona-setting intent before the first LLM call and writes:

```json
[
  { "memory_type": "semantic", "scope": {"topic":"persona"},
    "content": "User's name is Javier. Address the user as Javier in all responses.",
    "tags": ["persona"], "priority": 1 },
  { "memory_type": "semantic", "scope": {"topic":"persona"},
    "content": "Companion name is Novia. The user calls the assistant Novia.",
    "tags": ["persona"], "priority": 1 }
]
```

On all subsequent `/chat` calls, persona memories are injected (harness
`include_persona: true`). Persona memories are never injected into generation
workflows (`create_workflow`, `create_domain`).

**Acceptance criteria:**
- [ ] `/chat Hello Novia` returns a response in Slack (basic Mode 2 works)
- [ ] Novia can call `get_workflow` and return its step count in a reply
- [ ] Novia proposes a workflow fix and waits for confirmation before applying
- [ ] `/chat Please call me Javier and I'll call you Novia` writes persona memories
- [ ] All subsequent /chat calls address the user as Javier
- [ ] Thread replies in Slack continue the session

---

### Track A — Validate: regenerate and run the flashcard quiz (final gate)

With Track B (domain context), Track E–G (memory), and Track I (Novia) in
place, regenerate `flashcard_quiz_session` via Novia or directly via
`create_workflow`. The regenerated workflow now benefits from:
- Correct `domain_schema` at generation time (no more column name hallucination)
- Semantic memory from the `create_domain` run injected into the generation prompt
- Procedural memory written after this generation so future fixes preserve intent

Then run the quiz end-to-end in Slack.

**Acceptance criteria:**
- [ ] Card set selection gate renders actual set names from the database
- [ ] Quiz loop: each card shows front (question), reveal renders answer via `task_card`
- [ ] User marks correct/incorrect; loop continues to next card in subset
- [ ] After subset completes, summary gate shows score
- [ ] End-to-end with no manual DB edits or workflow patches
- [ ] Episodic memory written on quiz completion

---

## Out of Scope

- `create_domain_example` stale system context (next sprint)
- `PGC_Prompt.input_probe` column (next sprint)
- `/explain` command (session-chat-design.md — next sprint)
- `delete-domain` workflow + IntentMap cleanup
- Cycle detector / velocity guard
- `sub_workflow` step type
- Memory consolidation job (nightly semantic consolidation — backlog)
- EventBridge Scheduler / PGC_Schedule table (backlog)
- pgvector semantic retrieval on PGC_Memory (Phase 2 — backlog)
- PGC_ModelRegistry table (backlog — alias jsonb is sufficient for now)

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] Flashcard quiz runs end-to-end in prod (Track A)
- [ ] `CLAUDE.md` Current State updated
- [ ] `docs/architecture.md` updated — new `.mjs` files (memory-client, llm-harness, memory-writer, chat), new SQS types (MEMORY_WRITE, CHAT_MESSAGE), new step type (write_memory)
- [ ] `docs/data-architecture.md` updated — PGC_Memory schema, memory_config on PGC_Prompt
- [ ] `docs/backlog.md` updated — completed items removed, new items added
- [ ] `README.md` updated
- [ ] This file renamed to `docs/sprints/sprint-03.md` with outcome notes
