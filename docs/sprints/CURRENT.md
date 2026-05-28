# Sprint 3 — Memory and the Running Quiz

**Goal:** Make the system worth using every day. Two threads:
(1) diagnose why the flashcard quiz fails and fix its prerequisites;
(2) build the memory layer so every future LLM call is progressively smarter.
The quiz is the final acceptance gate: it must run end-to-end in a memory-aware system.
Novia (Track I) moves to Sprint 5. History threading (Track H) moves to Sprint 4.

**README.md must be updated at sprint close.**

**Branch:** `sprint/03-run-generated-workflows`

**Time-box:** If remaining scope cannot be completed in two full sessions, close the sprint early and move to Sprint 4. Do not over-extend.

---

## Session Notes

**2026-05-28 (session 5):** create_workflow retest run 386 completed — quiz_flashcards generated, L1+L2+routing+smoke all passed on attempt 2. Three flashcard decks loaded (59/39/67 cards). Framework improvements shipped this session:
- `serv_entity_insert` n-level entity hierarchy step type — topological FK threading, self-ref two-pass. `add_entity` v10 using it.
- `insertRows` bulk insert — 119 SERV calls → 3 for a 59-card deck (confirmed in run 393).
- `{{key.*.field}}` wildcard in template-resolver; `orderBy` string normalization in SERV.
- `response_url` stale button fix deployed (HTTP response body approach didn't work per Slack docs).
- `parse_entity_input` → smart model (Sonnet 4.6) + 16384 max_output_tokens; `minProperties` removed from output_schema.
- Review gate display: nested objects expanded, empty arrays skipped, all-empty object arrays collapsed to count summary.
- PII log truncation: `classify-intent` + `mind.mjs` now log inputLen + 80-char preview only.
- Pre-Sprint 5 design session added to backlog §2.0: workflow/step/skill/tool taxonomy.
- Quiz test (Track A) deferred to next session — decks loaded, workflow ready.

**2026-05-28 (session 4):** G1 validated (create_domain + create_workflow both write to PGC_Memory in prod). G3 implemented and deployed: `memory-writer.mjs` + MEMORY_WRITE SQS type + enqueue on qualifying run completion; 308 unit tests pass. `/explain-run` added to backlog tied to G3 via `source_run_id` FK. `generate_workflow_steps` v24 (Rule 7 + on_select) confirmed live in DB. Workflow testing convention added to memory (user tests from Slack, Claude does not trigger via curl). Ready for create_workflow retest this afternoon.

**2026-05-28 (session 3):** Diagnosed run 385 generate_workflow_steps failures. Fixed step 26 simulation_error_summary bug (only read static_analysis.issues, never smoke_test — always showed vague fallback). create_workflow v51 deployed. Scope assessment: Track H → Sprint 4, Track I → Sprint 5, Track A still in scope (no Novia dependency). Backlog item added for skeleton-first generation redesign. Sprint time-boxed to 2 sessions.

**2026-05-26 (session 2):** Track G coding complete and deployed (commit 66803ea).
- `scope_additions` on memory_config — fix_workflow now retrieves memories for the target workflow
- `iterator` field on human_gate options — one button per array item, no preceding js_transform needed
- `generate_workflow_steps` v24: Rule 6 updated, Rule 7 added
- `create_workflow` step 23 memory scope fixed (procedural, scoped to workflow name), DB v50
- All 5 create/fix workflow prompts have `memory_config` in DB
- Stale button fix: HTTP response body replaces chat.update
- SQS VisibilityTimeout 90→300s (distributed lost update fix)
- 293 unit tests pass

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
- [x] Post-create workflow notification is concise and contains no internal metadata (create_workflow step 37 message_template fixed, v50)
- [x] `{{name}}` token failure fixed: iterator field on human_gate options eliminates js_transform-before-gate pattern; generate_workflow_steps Rule 7 added so new workflows use iterator directly

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
- [x] `domain` is non-null in create_workflow WorkflowRun inputs
- [x] `domain_schema` is available in `local_state` when `generate_workflow_steps` fires
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

Validated end-to-end 2026-05-28: create_domain writes semantic memory to PGC_Memory in prod; create_workflow writes procedural memory. All 5 prompt bugs from session 2 confirmed resolved.

**G2. Wire memory into fix_workflow** ✅

`fix_workflow_steps` and `fix_workflow_routing` now have `memory_config` with
`scope_additions: {"workflow": "{{input.workflow_name}}"}` so the harness retrieves
procedural memories scoped to the target workflow being repaired.
`llm-harness.mjs` `scope_additions` support implemented: template-resolved additions
merged into the auto-derived scope before retrieval. Deployed in session 2026-05-26.

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

**G3. iterator field on human_gate options** ✅

Added `iterator: '<local_state_key>'` support on `choice` gate options.
`buildDialog` in `step-executor.mjs` expands it into one button per array item,
resolving `label`/`value`/`description` against `{...localState, ...item}`. L1
validation already skips unresolved-key check for options carrying `iterator`.
Eliminates the need for a preceding `js_transform` when buttons come from a
variable-length array. `generate_workflow_steps` prompt v24 updated: Rule 6
clarified (message_template only), Rule 7 added (iterator preference for buttons).
`seed_PGC_StepType.json` and `seed_PGC_SystemContext.json` (step_usage_patterns)
updated. `docs/architecture.md` updated with iterator-on-options subsection.

**Acceptance criteria:**
- [x] PGC_Memory table created and registered in PGC_Schema + PGC_TableMap
- [x] A create_domain run writes a semantic memory record to PGC_Memory in prod ✅ 2026-05-28
- [x] A create_workflow run writes a procedural memory record to PGC_Memory in prod ✅ 2026-05-28
- [ ] A second create_workflow run for the same domain has that semantic memory injected
- [x] fix_workflow receives procedural memory for the target workflow via harness injection
- [ ] A domain CRUD workflow run triggers a MEMORY_WRITE SQS message; episodic record written

---

### Track H — Memory: history threading → **deferred to Sprint 4**

Allows `llm_call` steps later in a workflow run to see prior LLM outputs from
the same run. Threading is valuable but not on the critical path to the quiz.
Full spec preserved here for Sprint 4 planning.

**Acceptance criteria (Sprint 4):**
- [ ] `use_run_history: true` on a step causes prior turns to be reconstructed
- [ ] History is budget-trimmed to `history_budget_tokens` (newest-first)
- [ ] Reasoning field from diagnostic sessions is excluded from reconstructed messages
- [ ] Unit tests for `loadRunHistory()` with mock PGC_SessionEntry rows

---

### Track I — Novia: /chat + Mode 4 agentic loop → **deferred to Sprint 5**

Full spec in `docs/memory-design.md` Section 9. Depends on Track F+G being
stable in production before the agentic loop is meaningful.

---

### Track A — Validate: regenerate and run the flashcard quiz (final gate)

With Track B (domain context) and Tracks E–G (memory) in place, regenerate
`flashcard_quiz_session` directly via `create_workflow` (Novia path deferred to
Sprint 5). The regenerated workflow now benefits from:
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
